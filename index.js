// 世界编年史 —— SillyTavern 胶水层。
// 只负责：接 ST 事件、读写 per-chat 状态与扩展设置、设置注入、渲染设置面板。
// 所有业务逻辑在 engine/ 里（纯函数，可单元测试）。
import * as E from './engine/index.js';
import { openEditor } from './ui/editor.js';
import { createBgmPlayer } from './ui/bgm-player.js';
import {
    sourceOrder, createLinkSource, createGdSource, createNoticeSource, resolveSong,
    neteaseSearchUrl, SOURCE_LABELS, GD_SOURCES, GD_DISCLAIMER, GD_ATTRIBUTION,
} from './ui/music-sources.js';
import { openChronicle, installCalendarButtons, setPeriodicalDot } from './ui/player-calendar.js';

const MODULE = 'world_chronicle';
const CARD_KEY = 'world_chronicle';
const PROMPT_KEY = 'world_chronicle';
const PAPER_KEY = 'world_chronicle_periodicals'; // 期刊往期，存在聊天 metadata 里，和剧本进度分开
const BASE_URL = new URL('.', import.meta.url).href;

// ST 的 extension_prompt_types / roles（st-context 未导出枚举，按源码取值）
const POSITION = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };

const DEFAULT_SETTINGS = {
    enabled: true,
    packs: {},          // packId -> 规范化后的包
    mappings: {},       // cardKey -> { packId, characters, relations, player, always }
    presenceLastN: 4,
    position: POSITION.IN_CHAT,
    depth: 2,
    role: 0,
    instructions: true,
    hideTags: true,
    autoLoadCardPacks: true,
    bgmEnabled: true,   // BGM 总开关：关 = 不发请求、不出声、不让 AI 输出 <bgm>
    bgmVolume: 0.5,
    bgmFade: 1500,      // 毫秒
    // 玩家是否同意使用 GD音乐台（只存在本机扩展设置里，作者的包不能替玩家打开）
    gdEnabled: false,
    gdSource: 'netease',
    gdSearchCache: {},  // 'netease:歌手|歌名' → { id, source, name, artist }；播放地址会过期，不保存
    calendarShowFuture: true,
    calendarButton: true, // 在输入框左侧显示日历按钮
    // 定期刊物
    paperEnabled: false,  // 期刊总开关：默认关，玩家自己打开
    paperRemind: true,    // 出刊提醒（小红点 + 提示）
    paperOn: {},          // 刊物 id → 开/关；没写过的按刊物自己的 enabled
    paperLoreLimit: 6000, // 给 AI 的世界书最多多少字
    paperChatN: 20,       // 给 AI 看最近几条聊天
    paperLength: 2000,    // 一期最多写多长（token）
    panelTab: 'overview', // 扩展面板上次打开的是哪一组
};

let lastOnce = [];       // 这次注入里“只提醒一次”的事件
let deliveredOnce = [];  // 最近一次真正生成时发给 AI 的；AI 回复后才算提醒过，重新生成时还会再发
let jumpDecision = null; // 对“日期跳得太远”的决定 { chatId, mesId, time, ok }；ok 为 null 表示还在问
let lastPresent = [];
let lastAutoPresent = [];
let player = null;
let sources = null;     // 音源实现：{ link, gd, notice }
let bgmNow = null;      // 此刻的配乐 { key, song, reason, result, track, resolving }
let bgmGen = 0;         // 每次重新决定配乐递增；异步的音源查找返回时据此判断是否已过时
let badgeDismissed = '';
let blockedToast = null;

const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------- 设置 / 状态

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE]) all[MODULE] = structuredClone(DEFAULT_SETTINGS);
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (s[k] === undefined) s[k] = structuredClone(v);
    return s;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

function hasChat() {
    const c = ctx();
    return c.characterId !== undefined || !!c.groupId;
}

/** 当前卡（或群聊）的映射键 */
function cardKey() {
    const c = ctx();
    if (c.groupId) return `group:${c.groupId}`;
    const ch = c.characters?.[c.characterId];
    return ch ? ch.avatar : null;
}

function currentCharacter() {
    const c = ctx();
    return c.characterId !== undefined ? c.characters?.[c.characterId] : null;
}

function getMapping(create = false) {
    const key = cardKey();
    if (!key) return null;
    const s = settings();
    if (!s.mappings[key] && create) s.mappings[key] = { packId: '', characters: [], relations: [], player: '', always: [] };
    return s.mappings[key] || null;
}

/** 当前生效的包（已合并卡侧映射）；未绑定返回 null */
function activePack() {
    const m = getMapping();
    if (!m?.packId) return null;
    const raw = settings().packs[m.packId];
    if (!raw) return null;
    return E.applyMapping(E.normalizePack(raw).pack, m);
}

/** per-chat 状态，存在 chat metadata 中。每次都重新取 context，因为切换聊天时 chat_metadata 会被替换。 */
function getState() {
    if (!hasChat()) return null;
    const md = ctx().chatMetadata;
    if (!md) return null;
    if (!md[MODULE]) md[MODULE] = E.createState(getMapping()?.packId || null);
    return md[MODULE];
}

function setState(state) {
    if (!hasChat()) return;
    ctx().chatMetadata[MODULE] = state;
    ctx().saveMetadataDebounced();
}

function stripUndo(state) {
    const { undo, ...rest } = state;
    return structuredClone(rest);
}

// ---------------------------------------------------------------- 注入

function chatMessages(list) {
    return (list || ctx().chat || []).map(m => ({ name: m.name, mes: m.mes, is_system: m.is_system }));
}

function computePresent(pack, state, list) {
    const m = getMapping() || {};
    lastAutoPresent = E.detectPresent(pack, chatMessages(list), { lastN: Number(settings().presenceLastN) || 4, always: m.always || [] });
    lastPresent = E.detectPresent(pack, chatMessages(list), {
        lastN: Number(settings().presenceLastN) || 4,
        manual: state.presentManual || {},
        always: m.always || [],
    });
    return lastPresent;
}

function clearInjection() {
    ctx().setExtensionPrompt(PROMPT_KEY, '', POSITION.IN_CHAT, 0);
}

/** 重新计算并设置本轮注入。返回注入文本（未启用时为空）。 */
function updateInjection(list) {
    const s = settings();
    const pack = activePack();
    const state = pack ? getState() : null;
    if (!s.enabled || !pack || !state) {
        clearInjection();
        return '';
    }
    const present = computePresent(pack, state, list);
    const { text, once } = E.buildInjection(pack, state, { present, instructions: s.instructions, bgm: !!s.bgmEnabled });
    lastOnce = once;
    ctx().setExtensionPrompt(PROMPT_KEY, text, Number(s.position), Number(s.depth), false, Number(s.role));
    return text;
}

// manifest.json 中声明的 generate_interceptor：每次真正生成前调用（dry run 不调用）。
globalThis.worldChronicleInterceptor = async function (chat, _contextSize, _abort, type) {
    try {
        const state = activePack() ? getState() : null;
        // 重新生成 / 滑动：先回到被替换的那条消息之前的状态
        // swipe：被替换的消息仍在 chat 末尾；regenerate：末尾消息已被删除。
        const target = type === 'swipe' ? ctx().chat.length - 1 : type === 'regenerate' ? ctx().chat.length : -1;
        if (state?.undo && state.undo.mesId === target) {
            const restored = structuredClone(state.undo.state);
            restored.undo = state.undo;
            setState(restored);
        }
        updateInjection(chat);
        if (type !== 'quiet') deliveredOnce = lastOnce;
        const now = getState();
        if (now && type !== 'quiet' && now.catchup?.some(c => !c.seen)) {
            E.markCatchupSeen(now);
            setState(now);
        }
    } catch (e) {
        console.error('[世界编年史] interceptor 出错', e);
    }
};

// ---------------------------------------------------------------- 标签处理

/** 处理一条消息里的 <time> / <choice> / <bgm>。同一条消息再次处理（滑动、编辑、重新生成）时，先恢复到它之前的状态。 */
function processMessage(mesId) {
    const pack = activePack();
    let state = pack ? getState() : null;
    const msg = ctx().chat?.[mesId];
    if (!pack || !state || !msg || msg.is_system) return;

    if (state.undo && state.undo.mesId === mesId) {
        const undo = state.undo;
        state = structuredClone(undo.state);
        state.undo = undo;
    } else if (state.undo && mesId < state.undo.mesId) {
        return; // 更早的消息被编辑：不回溯（见 README 已知限制）
    } else {
        state.undo = { mesId, state: stripUndo(state) };
    }

    const { time, choices, bgm, flags } = E.parseTags(msg.mes || '');
    const undo = state.undo;
    if (!msg.is_user) state = E.markOnceSeen(state, deliveredOnce);
    const prevState = state;
    const present = computePresent(pack, state);
    const decision = jumpDecision?.chatId === ctx().getCurrentChatId() && jumpDecision.mesId === mesId && jumpDecision.time === time ? jumpDecision : null;
    const jump = time && !decision ? E.checkDateJump(pack, state, time) : null;
    const useTime = time && !jump && (!decision || decision.ok === true);
    let adv = null;
    // 先记旗标再推进时间：同一条消息里改写的历史，要影响这次到期的事件
    const flagged = E.applyFlagTags(pack, state, flags, [state.date, time]);
    state = flagged.state;
    if (flagged.added.length) toastr.info(`历史变了：${flagged.added.join('、')}。如果记错了，可以在面板“更多”→“世界记录”里删掉。`, '世界编年史');
    if (useTime) {
        adv = E.advanceTime(pack, state, time, { present });
        state = adv.state;
    }
    for (const c of choices) {
        state = E.recordChoice(pack, state, { ...c, date: state.date });
    }
    applyBgmChoice(pack, state, E.chooseBgm(pack, { text: msg.mes || '', tag: bgm, state, prevState, fired: adv?.fired, interlude: adv?.interlude, present }));
    state.undo = undo;
    setState(state);
    updateInjection();
    syncBgm();
    refreshPanel();
    if (jump) askDateJump(mesId, time, jump, state.date);
}

/** AI 写的日期跳得太远，先问玩家。选“采用”就把这条消息再处理一遍。 */
async function askDateJump(mesId, time, jump, current) {
    const c = ctx();
    const chatId = c.getCurrentChatId();
    jumpDecision = { chatId, mesId, time, ok: null };
    const pack = activePack();
    const fmt = d => E.formatDate(d, pack.meta.display, pack.meta.eras);
    const detail = jump.back
        ? `这是往回退了 ${jump.days} 天，这几天里发生过的事都会当作没发生。`
        : `这是一下子往后跳了 ${jump.days} 天${jump.events ? `，中间 ${jump.events} 件事都会算作已经发生` : ''}。`;
    const ok = !!(await c.callGenericPopup(`AI 把故事里的日子写成了 ${fmt(time)}，可现在是 ${fmt(current)}。${detail}是 AI 写错了，还是故事里真的过了这么久？`, c.POPUP_TYPE.CONFIRM, '', { okButton: '采用这个日期', cancelButton: '保持现在的日期' }));
    if (ctx().getCurrentChatId() !== chatId) return;
    jumpDecision.ok = ok;
    if (ok) processMessage(mesId);
    else toastr.info('好的，日期没变。如果 AI 下次还写错，可以在面板的“故事日期”里自己改。', '世界编年史');
}

// ---------------------------------------------------------------- BGM

/**
 * 把 chooseBgm 的结果写进状态（null = 不变）。
 * state.bgm：曲目 id；{ title, artist }（free 模式下 AI 点的歌单外歌曲）；null = 已停止；undefined = 尚未决定（用阶段底色）。
 */
function applyBgmChoice(pack, state, pick) {
    if (!pick) return;
    state.bgm = pick.query ? { title: pick.query.title, artist: pick.query.artist || '' } : pick.track === E.BGM_STOP ? null : pick.track;
    state.bgmReason = pick.reason;
}

function trackSong(track) {
    return track ? { title: track.title, artist: track.artist, url: track.url, loop: track.loop, volume: track.volume } : null;
}

/** 本聊天此刻应当播放的歌 { song, reason }；不该播放（含 BGM 总开关关闭）返回 null。 */
function desiredBgm() {
    const s = settings();
    const pack = activePack();
    const st = pack ? getState() : null;
    if (!s.bgmEnabled || !pack || !st) return null;
    if (st.bgm === undefined) {
        const id = E.baselineBgm(pack, st);
        return id ? { song: trackSong(E.getTrack(pack, id)), reason: '这段时代气氛的配乐' } : null;
    }
    if (st.bgm && typeof st.bgm === 'object') return st.bgm.title ? { song: { ...st.bgm }, reason: st.bgmReason || '' } : null;
    const song = st.bgm ? trackSong(E.getTrack(pack, st.bgm)) : null;
    return song?.title ? { song, reason: st.bgmReason || '' } : null;
}

const songLabel = (song) => E.formatSong(song) || '（未命名）';
const songKey = (song) => `${E.songKey(song)}|${song.url || ''}`;

function stopBgm() {
    bgmGen++;
    bgmNow = null;
    if (player?.current) player.stop();
    renderBgmBadge();
    refreshBgmStatus();
}

/** 用玩家的音源找到这首歌并播放；找不到就只显示曲名。 */
async function playSong(song, reason, key = songKey(song), packSource = activePack()?.bgm.source) {
    const my = ++bgmGen;
    bgmNow = { key, song, reason, result: null, track: null, resolving: true, packSource };
    refreshBgmStatus();
    const result = await resolveSong(sourceOrder(packSource, settings().gdEnabled), sources, song,
        (id, e) => console.warn(`[世界编年史] 音源「${SOURCE_LABELS[id]}」查找失败`, e));
    if (my !== bgmGen) return;
    bgmNow.resolving = false;
    bgmNow.result = result;
    if (result?.url) {
        bgmNow.track = { id: key, url: result.url, title: song.title, artist: song.artist, loop: song.loop !== false, volume: song.volume ?? 1 };
        player.play(bgmNow.track);
    } else if (player.current) {
        player.stop();
    }
    renderBgmBadge();
    refreshBgmStatus();
}

/** 让播放器与本聊天的状态一致。 */
function syncBgm() {
    if (!player) return;
    const want = desiredBgm();
    if (!want) return stopBgm();
    const key = songKey(want.song);
    if (bgmNow?.key === key) {
        if (bgmNow.track) player.play(bgmNow.track); // 同一首：播放器自己会判断是否需要重来
        return;
    }
    playSong(want.song, want.reason, key);
}

function onBgmBlocked(track) {
    if (blockedToast) return;
    blockedToast = toastr.info(`浏览器不让网页自己出声。点一下这里（或者页面上任何地方），就会开始放「${songLabel(track)}」。`, '世界编年史 · BGM', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: true,
        onclick: () => player.resume(),
        onHidden: () => { blockedToast = null; },
    });
    // 用户在页面上的任何一次点击/按键都算“交互”，借机恢复播放
    const retry = () => {
        document.removeEventListener('pointerdown', retry, true);
        document.removeEventListener('keydown', retry, true);
        if (player.blocked) player.resume();
        if (blockedToast) toastr.clear(blockedToast);
    };
    document.addEventListener('pointerdown', retry, true);
    document.addEventListener('keydown', retry, true);
}

/** 找到的地址播放失败：丢掉缓存的地址，退回“只显示曲名” */
function onBgmError(track) {
    if (!bgmNow || bgmNow.track !== track) return;
    const { song, result } = bgmNow;
    if (result?.sourceId === 'gd') sources.gd.forget(song);
    bgmNow.result = { sourceId: 'notice', notice: true, searchUrl: neteaseSearchUrl(song), failedFrom: result?.sourceId };
    const why = result?.sourceId === 'link' ? '网址可能失效了，或者它不是音乐文件' : `来自${SOURCE_LABELS[result?.sourceId] || '别的地方'}`;
    toastr.warning(`「${songLabel(song)}」放不出来（${why}）`, '世界编年史 · BGM');
    renderBgmBadge();
    refreshBgmStatus();
}

function initBgm() {
    const s = settings();
    // 旧版设置迁移：之前同意过 GD音乐台的不用再同意一次；玩家曲库已取消
    if (s.musicSources?.some(x => x.id === 'gd' && x.enabled)) s.gdEnabled = true;
    delete s.musicSources;
    delete s.musicLibrary;
    sources = {
        link: createLinkSource(),
        gd: createGdSource({
            fetch: (...a) => fetch(...a),
            getSource: () => settings().gdSource,
            searchCache: s.gdSearchCache,
            onCacheChange: (cache) => {
                const keys = Object.keys(cache);
                for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete cache[k];
                saveSettings();
            },
        }),
        notice: createNoticeSource(),
    };
    player = createBgmPlayer({
        onBlocked: onBgmBlocked,
        onChange: () => { renderBgmBadge(); refreshBgmStatus(); },
        onError: onBgmError,
    });
    player.setVolume(s.bgmVolume);
    player.setFade(s.bgmFade);
}

/** 一句话描述此刻的配乐（面板与玩家日历共用）；没有配乐返回空串。 */
function bgmStatusText() {
    if (!bgmNow) return '';
    const { song, reason, result, resolving } = bgmNow;
    let text = `${songLabel(song)}${reason ? `（${reason}）` : ''}`;
    if (resolving) text += ' —— 正在找歌…';
    else if (result?.url) {
        text += ` —— ${SOURCE_LABELS[result.sourceId]}`;
        if (player?.blocked) text += '，点一下页面就会响';
    } else if (result?.notice) text += result.failedFrom ? ' —— 没放出来，只能显示歌名' : ' —— 没找到能放的地方，只能显示歌名';
    else text += ' —— 没找到能放的地方';
    return text;
}

function refreshBgmStatus() {
    if (!$('#wc_panel').length) return;
    $p('#wc_bgm_now').text(bgmStatusText() || '（现在没放歌）');
}

/** 右上角的小提示：只显示曲名时给出网易云搜索链接；用 GD音乐台播放时始终显示来源。 */
function renderBgmBadge() {
    let el = document.getElementById('wc_bgm_badge');
    const r = bgmNow?.result;
    const gdPlaying = r?.sourceId === 'gd' && player?.current === bgmNow?.track && !!bgmNow?.track;
    const notice = r?.notice && badgeDismissed !== bgmNow.key;
    if (!settings().bgmEnabled || (!gdPlaying && !notice)) {
        el?.remove();
        return;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = 'wc_bgm_badge';
        document.body.append(el);
    }
    el.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'wc_badge_text';
    if (gdPlaying) {
        label.textContent = `♪ ${songLabel(bgmNow.song)}`;
        const attr = document.createElement('a');
        attr.href = 'https://music.gdstudio.xyz';
        attr.target = '_blank';
        attr.rel = 'noopener noreferrer';
        attr.className = 'wc_badge_attr';
        attr.textContent = GD_ATTRIBUTION;
        el.append(label, attr);
        return;
    }
    label.textContent = `♪ 现在的配乐：${songLabel(bgmNow.song)}`;
    const link = document.createElement('a');
    link.href = r.searchUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '去网易云听';
    const close = document.createElement('span');
    close.className = 'wc_badge_close fa-solid fa-xmark';
    close.title = '这首不用再提示了';
    close.addEventListener('click', () => { badgeDismissed = bgmNow?.key || ''; renderBgmBadge(); });
    if (bgmNow.packSource !== 'link' && !settings().gdEnabled) {
        const enable = document.createElement('a');
        enable.href = '#';
        enable.textContent = '用 GD音乐台播放';
        enable.addEventListener('click', (e) => { e.preventDefault(); setGdEnabled(true); });
        el.append(label, enable, link, close);
        return;
    }
    el.append(label, link, close);
}

async function confirmGd() {
    const c = ctx();
    const box = document.createElement('div');
    box.className = 'wc_gd_disclaimer';
    const h = document.createElement('h3');
    h.textContent = '开启 GD音乐台？';
    box.append(h);
    for (const line of GD_DISCLAIMER) {
        const p = document.createElement('p');
        p.textContent = line;
        box.append(p);
    }
    return !!(await c.callGenericPopup(box, c.POPUP_TYPE.CONFIRM, '', { okButton: '我已了解，开启', cancelButton: '取消' }));
}

/** 开启 GD音乐台必须由玩家本人确认声明。 */
async function setGdEnabled(on) {
    if (on && !(await confirmGd())) {
        refreshPanel();
        return false;
    }
    settings().gdEnabled = !!on;
    saveSettings();
    refreshPanel();
    bgmNow = null;
    syncBgm();
    return true;
}

function bindMusic() {
    const s = settings();
    $p('#wc_gd_enabled').on('change', function () { setGdEnabled(this.checked); });
    $p('#wc_gd_source').on('change', function () {
        s.gdSource = this.value;
        saveSettings();
        bgmNow = null;
        syncBgm();
    });
}

function stripForDisplay(text) {
    return settings().hideTags ? E.stripTags(text) : text;
}

let formatterHooked = false;
function installTagHiding() {
    const mf = ctx().messageFormatter;
    if (mf?.addHook) {
        try {
            mf.addHook((mes) => stripForDisplay(mes), { stage: mf.stage.BEFORE_REGEX, order: mf.order.EARLY });
            formatterHooked = true;
        } catch (e) {
            console.warn('[世界编年史] 注册 messageFormatter 钩子失败，改用渲染后处理', e);
        }
    }
}

/** 旧版 ST 没有 messageFormatter：渲染后重新格式化去掉标签的文本。 */
function rerenderMessage(mesId) {
    if (formatterHooked || !settings().hideTags) return;
    const c = ctx();
    const msg = c.chat?.[mesId];
    if (!msg || !E.ANY_TAG_RE.test(msg.mes || '')) return;
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_text`);
    if (!el) return;
    el.innerHTML = c.messageFormatting(E.stripTags(msg.mes), msg.name, msg.is_system, msg.is_user, mesId);
}

function rerenderAll() {
    if (formatterHooked) return;
    (ctx().chat || []).forEach((_, i) => rerenderMessage(i));
}

// ---------------------------------------------------------------- 角色卡内嵌包

async function loadPackFromCard() {
    const s = settings();
    if (!s.autoLoadCardPacks) return;
    const c = ctx();
    const candidates = [];
    if (c.characterId !== undefined) {
        await c.unshallowCharacter?.(c.characterId);
        candidates.push(c.characters[c.characterId]);
    } else if (c.groupId) {
        await c.unshallowGroupMembers?.(c.groupId);
        const group = c.groups?.find(g => g.id === c.groupId);
        for (const avatar of group?.members || []) candidates.push(c.characters.find(ch => ch.avatar === avatar));
    }
    for (const ch of candidates) {
        const embedded = ch?.data?.extensions?.[CARD_KEY]?.pack;
        if (!embedded) continue;
        const { pack, errors } = E.normalizePack(embedded);
        if (errors.length) {
            toastr.warning(`角色卡「${ch.name}」里带的剧本有地方写错了，没能用上：${errors[0]}`, '世界编年史');
            continue;
        }
        const existing = s.packs[pack.meta.id];
        if (!existing) {
            s.packs[pack.meta.id] = pack;
            toastr.success(`角色卡「${ch.name}」里带着剧本「${pack.meta.name}」，已经帮你装好了。`, '世界编年史');
        } else if (existing.meta.version !== pack.meta.version) {
            s.packs[pack.meta.id] = pack;
            toastr.info(`角色卡「${ch.name}」里的剧本出了新版本（${existing.meta.version} → ${pack.meta.version}），已经换成新的了。`, '世界编年史');
        }
        const m = getMapping(true);
        if (m && !m.packId) m.packId = pack.meta.id;
        saveSettings();
        break;
    }
}

/** 编辑器调用：把包写入当前角色卡的 extensions 字段 */
async function writePackToCard(pack) {
    const c = ctx();
    if (c.characterId === undefined) throw new Error('要先打开一张角色卡，才能把剧本写进去。群聊里写不了。');
    await c.writeExtensionField(c.characterId, CARD_KEY, { pack: structuredClone(pack), savedAt: new Date().toISOString() });
    return c.characters[c.characterId].name;
}

/**
 * “AI 帮我写”的素材：当前角色卡的名字、描述、开场白和世界书（卡内嵌的 + 绑定的世界书）。
 * 只读卡的内容，不碰任何连接设置或密钥。群聊返回 null。
 */
async function readCardMaterial() {
    const c = ctx();
    if (c.characterId === undefined) return null;
    await c.unshallowCharacter?.(c.characterId);
    const ch = c.characters?.[c.characterId];
    if (!ch) return null;
    const d = ch.data || {};
    const lorebook = await readCardLorebook(ch);
    return E.formatCardMaterial({
        name: ch.name,
        description: ch.description ?? d.description,
        personality: ch.personality ?? d.personality,
        scenario: ch.scenario ?? d.scenario,
        greetings: [ch.first_mes ?? d.first_mes, ...(d.alternate_greetings || [])].filter(Boolean),
        lorebook,
    });
}

/** 卡里生效的世界书条目：卡内嵌的 + 卡绑定的世界书（跳过停用的）。返回 [{ name, keys, content }]。 */
async function readCardLorebook(ch) {
    const c = ctx();
    const d = ch?.data || {};
    const lorebook = [];
    const seen = new Set();
    const add = (name, keys, content) => {
        const text = String(content ?? '').trim();
        if (!text || seen.has(text)) return;
        seen.add(text);
        lorebook.push({ name: String(name ?? ''), keys: Array.isArray(keys) ? keys.map(String) : [], content: text });
    };
    for (const e of d.character_book?.entries || []) {
        if (e?.enabled === false) continue;
        add(e.comment || e.name, e.keys, e.content);
    }
    const worldName = d.extensions?.world;
    if (worldName && typeof c.loadWorldInfo === 'function') {
        try {
            const book = await c.loadWorldInfo(worldName);
            for (const e of Object.values(book?.entries || {})) {
                if (e?.disable) continue;
                add(e.comment, e.key, e.content);
            }
        } catch (e) {
            console.warn('[World Chronicle] 读取世界书失败', e);
        }
    }
    return lorebook;
}

/**
 * 用酒馆当前连接的 AI 生成（“AI 帮我写”）。走 ST 自己的 generateRaw，
 * 由 ST 用用户已配置的连接发请求；插件不读取、不经手任何 API 密钥。
 */
async function generateForAuthor({ prompt, responseLength }) {
    const c = ctx();
    if (typeof c.generateRaw !== 'function') throw new Error('你这个版本的酒馆，不让插件直接叫 AI 来写（缺少 generateRaw）');
    return c.generateRaw({
        prompt,
        systemPrompt: '你是严谨的剧本助手，只按要求输出 JSON。',
        responseLength,
    });
}

function readPackFromCard() {
    const ch = currentCharacter();
    return ch?.data?.extensions?.[CARD_KEY]?.pack || null;
}

// ---------------------------------------------------------------- 包库

function savePackToLibrary(pack, { bind = false } = {}) {
    const s = settings();
    s.packs[pack.meta.id] = structuredClone(pack);
    if (bind) {
        const m = getMapping(true);
        if (m) m.packId = pack.meta.id;
    }
    saveSettings();
    updateInjection();
    syncBgm();
    refreshPanel();
}

async function importPackFile(file) {
    const text = await file.text();
    const { pack, errors, warnings } = E.normalizePack(JSON.parse(text));
    if (errors.length) throw new Error(errors.join('；'));
    if (warnings.length) toastr.warning(warnings.slice(0, 3).join('<br>'), '导入时的小提醒');
    savePackToLibrary(pack, { bind: !getMapping()?.packId });
    return pack;
}

async function loadDemoPack() {
    const res = await fetch(new URL('packs/thermidor/thermidor.json', BASE_URL));
    const { pack } = E.normalizePack(await res.json());
    savePackToLibrary(pack, { bind: !getMapping()?.packId });
    toastr.success(`示例剧本「${pack.meta.name}」加进来了。没自动用上的话，在“使用的剧本”里选它。`, '世界编年史');
}

// ---------------------------------------------------------------- 设置面板

const $p = (sel) => $(`#wc_panel ${sel}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function refreshPanel() {
    if (!$('#wc_panel').length) return;
    const s = settings();
    renderPaperList();
    $p('#wc_enabled').prop('checked', !!s.enabled);
    $p('#wc_instructions').prop('checked', !!s.instructions);
    $p('#wc_hide_tags').prop('checked', !!s.hideTags);
    $p('#wc_autoload').prop('checked', !!s.autoLoadCardPacks);
    $p('#wc_position').val(String(s.position));
    $p('#wc_depth').val(s.depth);
    $p('#wc_role').val(String(s.role));
    $p('#wc_lastn').val(s.presenceLastN);
    $p('#wc_bgm_enabled').prop('checked', !!s.bgmEnabled);
    $p('#wc_bgm_volume').val(s.bgmVolume);
    $p('#wc_bgm_volume_text').text(`${Math.round(Number(s.bgmVolume) * 100)}%`);
    $p('#wc_bgm_fade').val(s.bgmFade);
    $p('#wc_cal_button_on').prop('checked', !!s.calendarButton);
    $p('.wc_bgm_body').toggleClass('wc_off', !s.bgmEnabled);
    $p('#wc_gd_enabled').prop('checked', !!s.gdEnabled);
    $p('#wc_gd_source').html(GD_SOURCES.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')).val(s.gdSource);
    $p('#wc_gd_platform').toggle(!!s.gdEnabled);
    refreshBgmStatus();

    const m = getMapping();
    const sel = $p('#wc_pack_select').empty().append('<option value="">（不使用）</option>');
    for (const p of Object.values(s.packs)) sel.append(`<option value="${esc(p.meta.id)}">${esc(p.meta.name)}</option>`);
    sel.val(m?.packId || '');
    sel.prop('disabled', !cardKey());
    $p('#wc_card_name').text(cardKey() ? (ctx().groupId ? '当前群聊' : (currentCharacter()?.name || '')) : '（还没打开角色卡）');

    const pack = activePack();
    const state = pack ? getState() : null;
    $p('.wc_needs_pack').toggle(!!pack && !!state);
    $p('.wc_no_pack').toggle(!pack || !state);
    if (!pack || !state) {
        $p('#wc_preview').val('');
        return;
    }

    // 日期 & 倒计时
    const fmt = state.date ? E.formatDate(state.date, pack.meta.display, pack.meta.eras) : '（还没开始，AI 第一次写出日期后会自动显示）';
    $p('#wc_date_text').text(fmt);
    $p('#wc_date_input').val(state.date || pack.meta.start || '');
    const phase = state.date ? E.getPhase(pack, state.date) : null;
    $p('#wc_phase_text').text(phase ? `时代气氛：${phase.name || phase.id}` : '');
    const cds = state.date ? E.computeCountdowns(pack.meta.countdowns, state.date) : [];
    $p('#wc_countdowns').html(cds.map(c => `<div>${esc(E.describeCountdown(c))}</div>`).join(''));

    // 映射：user 扮演的角色、始终在场
    const player = $p('#wc_player').empty().append('<option value="">（不扮演剧本里的人）</option>');
    for (const c of pack.characters) player.append(`<option value="${esc(c.id)}">${esc(c.name)}</option>`);
    player.val(m?.player || '');

    // 在场角色
    computePresent(pack, state);
    const rows = pack.characters.map(c => {
        const manual = state.presentManual?.[c.id];
        const v = manual === true ? 'on' : manual === false ? 'off' : 'auto';
        const auto = lastAutoPresent.includes(c.id);
        const always = (m?.always || []).includes(c.id);
        return `<tr data-id="${esc(c.id)}">
            <td>${esc(c.name)}<div class="wc_dim">${esc(c.tags.join('、'))}</div></td>
            <td>${lastPresent.includes(c.id) ? '<b class="wc_on">在场</b>' : '<span class="wc_dim">不在场</span>'}${auto && v === 'auto' ? '' : ''}</td>
            <td><select class="wc_presence text_pole">
                <option value="auto"${v === 'auto' ? ' selected' : ''}>自动${auto ? '（聊天里提到了）' : ''}</option>
                <option value="on"${v === 'on' ? ' selected' : ''}>算TA在场</option>
                <option value="off"${v === 'off' ? ' selected' : ''}>算TA不在场</option>
            </select></td>
            <td><label class="checkbox_label" title="勾上后，这张卡的所有聊天里，TA都一直算在场"><input type="checkbox" class="wc_always"${always ? ' checked' : ''}>常驻</label></td>
        </tr>`;
    });
    $p('#wc_presence_table tbody').html(rows.join(''));

    // 卡侧附加标签/别名
    const extra = (m?.characters || []);
    $p('#wc_map_table tbody').html(extra.map((c, i) => `<tr data-i="${i}">
        <td><input class="text_pole wc_map_id" value="${esc(c.id)}" placeholder="剧本里的人，或新名字" list="wc_char_ids"></td>
        <td><input class="text_pole wc_map_aliases" value="${esc((c.aliases || []).join('，'))}" placeholder="别的叫法"></td>
        <td><input class="text_pole wc_map_tags" value="${esc((c.tags || []).join('，'))}" placeholder="身份"></td>
        <td><button class="menu_button wc_map_del" title="删除">✕</button></td></tr>`).join(''));
    $p('#wc_char_ids').html(pack.characters.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''));

    // 世界记录
    const nameOf = id => E.getCharacter(pack, id)?.name || id;
    const titleOf = id => pack.events.find(e => e.id === id)?.title || id;
    $p('#wc_choices tbody').html((state.choices || []).map(c => `<tr data-who="${esc(c.who)}" data-event="${esc(c.event)}">
        <td>${esc(nameOf(c.who))}</td><td>${esc(titleOf(c.event))}</td><td>${esc(c.choice)}</td><td class="wc_dim">${esc(c.date || '')}</td>
        <td><button class="menu_button wc_choice_del" title="删除">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="wc_dim">还没有</td></tr>');
    $p('#wc_choice_who').html(pack.characters.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''));
    $p('#wc_choice_event').html(pack.events.map(e => `<option value="${esc(e.id)}">${esc(e.date)} ${esc(e.title)}</option>`).join(''));

    $p('#wc_flags').html(Object.keys(state.flags || {}).map(f => `<span class="wc_chip">${esc(f)} <a href="#" class="wc_flag_del" data-flag="${esc(f)}">✕</a></span>`).join('') || '<span class="wc_dim">还没有小纸条</span>');
    $p('#wc_ripples').html((state.ripples || []).map(r => `<div class="wc_ripple"><b>→ ${esc(nameOf(r.to))}</b>：${esc(r.text)} <span class="wc_dim">${esc(r.date || '')}</span></div>`).join('') || '<span class="wc_dim">还没有</span>');
    $p('#wc_log').html((state.log || []).slice(-15).reverse().map(l => `<div><span class="wc_dim">${esc(l.date)}</span> ${esc(l.text)}</div>`).join(''));

    $p('#wc_preview').val(updateInjection());
}

const PANEL_TABS = ['overview', 'people', 'music', 'paper', 'record', 'pack', 'advanced'];

/** 面板分组页签：点哪组就显示哪组，并记住，下次打开还在这一组。 */
function showPanelTab(tab, remember = true) {
    if (!PANEL_TABS.includes(tab)) tab = 'overview';
    $p('.wc_tab').each(function () {
        const on = this.dataset.tab === tab;
        this.classList.toggle('active', on);
        this.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $p('.wc_pane').each(function () { this.classList.toggle('active', this.dataset.pane === tab); });
    if (!remember) return;
    try {
        settings().panelTab = tab;
        saveSettings();
    } catch (e) {
        console.warn('[世界编年史] 没能记住面板分组', e);
    }
}

function bindPanelTabs() {
    let tab = 'overview';
    try {
        tab = settings().panelTab || 'overview';
    } catch (e) {
        console.warn('[世界编年史] 没能读出上次的面板分组', e);
    }
    showPanelTab(tab, false);
    $p('.wc_tabs').on('click', '.wc_tab', function () { showPanelTab(this.dataset.tab); });
    $p('.wc_tabs').on('keydown', '.wc_tab', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            showPanelTab(this.dataset.tab);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            const tabs = $p('.wc_tab').toArray();
            const i = tabs.indexOf(this) + (e.key === 'ArrowRight' ? 1 : -1);
            const next = tabs[(i + tabs.length) % tabs.length];
            next.focus();
            showPanelTab(next.dataset.tab);
        }
    });
}

function bindPanel() {
    const s = settings();
    bindPanelTabs();
    const onSetting = (sel, key, conv = v => v) => $p(sel).on('change input', function () {
        s[key] = conv(this.type === 'checkbox' ? this.checked : this.value);
        saveSettings();
        if (key === 'hideTags') toastr.info('重新打开这个聊天后，就全部生效了。', '世界编年史');
        updateInjection();
        refreshPanel();
    });
    onSetting('#wc_enabled', 'enabled');
    onSetting('#wc_instructions', 'instructions');
    onSetting('#wc_hide_tags', 'hideTags');
    onSetting('#wc_autoload', 'autoLoadCardPacks');
    onSetting('#wc_position', 'position', Number);
    onSetting('#wc_depth', 'depth', v => Math.max(0, Number(v) || 0));
    onSetting('#wc_role', 'role', Number);
    onSetting('#wc_lastn', 'presenceLastN', v => Math.max(1, Number(v) || 4));

    $p('#wc_bgm_enabled').on('change', function () {
        setBgmEnabled(this.checked);
    });
    $p('#wc_cal_button_on').on('change', function () {
        s.calendarButton = this.checked;
        saveSettings();
        installCalendarButtons(calendarHost());
    });
    $p('#wc_open_calendar').on('click', () => openChronicle(calendarHost(), { tab: 'calendar' }));
    $p('#wc_bgm_volume').on('input change', function () {
        s.bgmVolume = Math.min(1, Math.max(0, Number(this.value) || 0));
        player?.setVolume(s.bgmVolume);
        $p('#wc_bgm_volume_text').text(`${Math.round(s.bgmVolume * 100)}%`);
        saveSettings();
    });
    $p('#wc_bgm_fade').on('change', function () {
        s.bgmFade = Math.max(0, Math.floor(Number(this.value) || 0));
        player?.setFade(s.bgmFade);
        saveSettings();
    });
    $p('#wc_bgm_stop').on('click', () => {
        const st = activePack() ? getState() : null;
        if (st) {
            st.bgm = null;
            st.bgmReason = '你按了停止';
            setState(st);
        }
        stopBgm();
    });
    $p('#wc_bgm_play').on('click', () => {
        if (!player) return;
        if (player.blocked) return player.resume();
        if (!settings().bgmEnabled) return toastr.info('先勾上面板里的“背景音乐”，才能放歌。', '世界编年史');
        const pack = activePack();
        const st = pack ? getState() : null;
        bgmNow = null; // 重新查找音源（例如刚改过曲库）
        if (pack && st && !st.bgm) {
            // 手动停止过：回到阶段底色
            const id = E.baselineBgm(pack, st);
            if (!id) return toastr.info('现在没有要放的歌：这段时代气氛没有配歌。', '世界编年史');
            st.bgm = id;
            st.bgmReason = '这段时代气氛的配乐';
            setState(st);
        }
        syncBgm();
    });

    $p('#wc_pack_select').on('change', function () {
        const m = getMapping(true);
        if (!m) return;
        m.packId = this.value;
        saveSettings();
        const st = getState();
        if (st && st.packId && st.packId !== this.value && st.date) toastr.info('这个聊天已经有进度了。如果换的是另一个时代的剧本，最好去面板「记录」那一格，点“清空这个聊天的记录”，从头开始。', '世界编年史');
        if (st) { st.packId = this.value; setState(st); }
        syncBgm();
        refreshPanel();
    });

    $p('#wc_open_editor').on('click', () => openEditorWithCurrent());
    $p('#wc_load_demo').on('click', () => loadDemoPack().catch(e => toastr.error(String(e.message || e))));
    $p('#wc_import_btn').on('click', () => $p('#wc_import_file').trigger('click'));
    $p('#wc_import_file').on('change', async function () {
        const f = this.files?.[0];
        this.value = '';
        if (!f) return;
        try {
            const p = await importPackFile(f);
            toastr.success(`导入好了：「${p.meta.name}」。没自动用上的话，在“使用的剧本”里选它。`, '世界编年史');
        } catch (e) {
            toastr.error(`导入没成功，这个文件可能不是剧本文件（${e.message || e}）`, '世界编年史');
        }
    });

    $p('#wc_set_date').on('click', () => {
        const pack = activePack();
        const st = getState();
        const d = E.normalizeDate($p('#wc_date_input').val());
        if (!pack || !st || !d) return toastr.warning('日期要写成“年-月-日”，比如 1997-07-02');
        const r = E.advanceTime(pack, st, d, { present: lastPresent });
        r.state.undo = undefined; // 手动改日期后不再允许回滚到上一条消息
        applyBgmChoice(pack, r.state, E.chooseBgm(pack, { state: r.state, prevState: st, fired: r.fired, interlude: r.interlude, present: lastPresent }));
        setState(r.state);
        if (r.fired.length) toastr.info(`这些事发生了：${r.fired.map(id => pack.events.find(e => e.id === id)?.title).join('、')}`, '世界编年史');
        syncBgm();
        refreshPanel();
    });

    $p('#wc_player').on('change', function () {
        const m = getMapping(true);
        if (!m) return;
        m.player = this.value;
        saveSettings();
        refreshPanel();
    });

    $p('#wc_presence_table').on('change', '.wc_presence', function () {
        const st = getState();
        if (!st) return;
        const id = $(this).closest('tr').data('id');
        st.presentManual = st.presentManual || {};
        if (this.value === 'auto') delete st.presentManual[id];
        else st.presentManual[id] = this.value === 'on';
        setState(st);
        refreshPanel();
    });
    $p('#wc_presence_table').on('change', '.wc_always', function () {
        const m = getMapping(true);
        if (!m) return;
        const id = String($(this).closest('tr').data('id'));
        m.always = (m.always || []).filter(x => x !== id);
        if (this.checked) m.always.push(id);
        saveSettings();
        refreshPanel();
    });

    $p('#wc_map_add').on('click', () => {
        const m = getMapping(true);
        if (!m) return;
        m.characters = m.characters || [];
        m.characters.push({ id: '', aliases: [], tags: [] });
        saveSettings();
        refreshPanel();
    });
    $p('#wc_map_table').on('change', 'input', function () {
        const m = getMapping(true);
        const i = Number($(this).closest('tr').data('i'));
        const row = m.characters[i];
        const tr = $(this).closest('tr');
        const split = v => String(v).split(/[,，、]/).map(x => x.trim()).filter(Boolean);
        row.id = String(tr.find('.wc_map_id').val()).trim();
        row.name = row.id;
        row.aliases = split(tr.find('.wc_map_aliases').val());
        row.tags = split(tr.find('.wc_map_tags').val());
        saveSettings();
        updateInjection();
    });
    $p('#wc_map_table').on('click', '.wc_map_del', function () {
        const m = getMapping(true);
        m.characters.splice(Number($(this).closest('tr').data('i')), 1);
        saveSettings();
        refreshPanel();
    });

    $p('#wc_choice_add').on('click', () => {
        const pack = activePack();
        const st = getState();
        const choice = String($p('#wc_choice_text').val()).trim();
        if (!pack || !st || !choice) return;
        const next = E.recordChoice(pack, st, { who: $p('#wc_choice_who').val(), event: $p('#wc_choice_event').val(), choice, date: st.date });
        next.undo = st.undo;
        setState(next);
        $p('#wc_choice_text').val('');
        refreshPanel();
    });
    $p('#wc_choices').on('click', '.wc_choice_del', function () {
        const st = getState();
        const tr = $(this).closest('tr');
        const next = E.removeChoice(st, String(tr.data('who')), String(tr.data('event')));
        next.undo = st.undo;
        setState(next);
        refreshPanel();
    });
    $p('#wc_flag_add').on('click', () => {
        const st = getState();
        const f = String($p('#wc_flag_text').val()).trim();
        if (!st || !f) return;
        st.flags[f] = true;
        setState(st);
        $p('#wc_flag_text').val('');
        refreshPanel();
    });
    $p('#wc_flags').on('click', '.wc_flag_del', function (e) {
        e.preventDefault();
        const st = getState();
        delete st.flags[$(this).data('flag')];
        setState(st);
        refreshPanel();
    });
    $p('#wc_refresh').on('click', () => refreshPanel());
    $p('#wc_reset_chat').on('click', async () => {
        const c = ctx();
        const ok = await c.callGenericPopup('要清空这个聊天的记录吗？日期、大家做过的选择、小纸条和牵连都会清掉，从头开始。聊天消息本身不会删。', c.POPUP_TYPE.CONFIRM);
        if (!ok) return;
        setState(E.createState(getMapping()?.packId || null));
        syncBgm();
        refreshPanel();
    });
}

// ---------------------------------------------------------------- 定期刊物
// 出刊日、提示词、解析、渲染都在 engine/periodicals.js；这里只接 ST：读卡、调 AI、存 chat_metadata、提醒。

const paperJobs = new Map(); // `${chatId}|${pid}|${date}` → Promise，同一期不重复调用
const paperToasted = new Set(); // 本次打开酒馆后已经提醒过的新刊

function paperChatId() {
    const c = ctx();
    return hasChat() ? String(c.getCurrentChatId?.() ?? c.chatId ?? '') : '';
}

/** 往期存档（per-chat）。切换聊天时 chat_metadata 会被替换，所以每次都重新取。 */
function getPaperStore() {
    if (!hasChat()) return E.createIssueStore();
    const md = ctx().chatMetadata;
    if (!md) return E.createIssueStore();
    return E.normalizeIssueStore(md[PAPER_KEY]);
}

function setPaperStore(store) {
    if (!hasChat() || !ctx().chatMetadata) return;
    ctx().chatMetadata[PAPER_KEY] = store;
    ctx().saveMetadataDebounced();
}

/** 刊物开关：玩家勾过的按玩家的；没勾过的按刊物自己的 enabled */
function paperIsOn(p) {
    const v = settings().paperOn?.[p.id];
    return v === undefined ? p.enabled !== false : !!v;
}

/** 附赠刊物 + 当前剧本里的刊物（全部，不管开关） */
function allPeriodicals() {
    return E.availablePeriodicals(activePack());
}

/** 打开着的刊物；总开关关着时为空 */
function activePeriodicals() {
    if (!settings().paperEnabled) return [];
    return allPeriodicals().filter(paperIsOn);
}

/** 故事今天是哪天：剧本日期 → 最近消息的 <time> → 玩家手动选的 */
function paperStoryDate() {
    const pack = activePack();
    return E.resolveStoryDate({
        packDate: pack ? getState()?.date : null,
        messages: hasChat() ? ctx().chat : [],
        manualDate: getPaperStore().manualDate,
    });
}

function paperLine(p, date) {
    const pack = activePack();
    return E.issueLine(p, date, pack ? { display: pack.meta.display, eras: pack.meta.eras } : {});
}

/** 单独调用一次 AI 写这一期，写好存进 chat_metadata。不进聊天，也不触发世界书/作者注释注入。 */
async function generateIssue(p, date) {
    const chatId = paperChatId();
    const key = `${chatId}|${p.id}|${date}`;
    if (paperJobs.has(key)) return paperJobs.get(key);
    const job = (async () => {
        const c = ctx();
        if (typeof c.generateRaw !== 'function') throw new Error('你这个版本的酒馆，不让插件直接叫 AI 来写（缺少 generateRaw）。更新一下酒馆再试。');
        const s = settings();
        const ch = currentCharacter();
        if (ch && c.characterId !== undefined) await c.unshallowCharacter?.(c.characterId);
        const lore = ch ? await readCardLorebook(currentCharacter()) : [];
        const pack = activePack();
        const { system, prompt } = E.buildIssuePrompt({
            periodical: p,
            issueDate: date,
            line: paperLine(p, date),
            lore,
            loreLimit: Math.max(0, Number(s.paperLoreLimit) || 0),
            messages: c.chat || [],
            chatLimit: Math.max(0, Number(s.paperChatN) || 0),
            pack,
            state: pack ? getState() : null,
        });
        // 签名按 ST 源码核实：generateRaw({ prompt, systemPrompt, responseLength, ... })，返回字符串
        const text = await c.generateRaw({ prompt, systemPrompt: system, responseLength: Math.max(200, Number(s.paperLength) || 2000) });
        if (paperChatId() !== chatId) throw new Error('写的时候换了聊天，这一期就先不存了。回到原来的聊天再打开一次就好。');
        if (!String(text || '').trim()) throw new Error('AI 什么都没写回来。可以再试一次，或者换个模型。');
        setPaperStore(E.putIssue(getPaperStore(), p.id, date, text, { createdAt: Date.now() }));
        refreshPaperDot();
        return text;
    })();
    paperJobs.set(key, job);
    try {
        return await job;
    } finally {
        paperJobs.delete(key);
    }
}

function paperErrorText(e) {
    const msg = String(e?.message || e || '');
    if (/abort|cancel/i.test(msg)) return '已经停下了。想看的话，点“再试一次”。';
    return msg || '不知道哪里出了错。看看酒馆的 AI 连接是不是通的，再试一次。';
}

function paperHost() {
    return {
        engine: E,
        enabled: () => !!settings().paperEnabled,
        periodicals: () => activePeriodicals(),
        storyDate: () => paperStoryDate(),
        setManualDate: (d) => {
            const st = getPaperStore();
            st.manualDate = d;
            setPaperStore(st);
            refreshPaperDot();
        },
        chatId: () => paperChatId(),
        lineFor: paperLine,
        getIssue: (pid, date) => E.getIssue(getPaperStore(), pid, date),
        issueDates: (pid) => E.listIssueDates(getPaperStore(), pid),
        generateIssue,
        markRead: (pid, date) => {
            const st = getPaperStore();
            if (!E.hasUnread(st, pid, date)) return;
            setPaperStore(E.markRead(st, pid, date));
            refreshPaperDot();
        },
        // ST 的 generateRaw 监听 GENERATION_STOPPED 来中止请求；stopGeneration 会发出这个事件
        stop: () => ctx().stopGeneration?.(),
        errorText: paperErrorText,
        toast: (type, msg) => toastr[type](msg, '世界编年史'),
        confirm: async (msg) => {
            const c = ctx();
            return !!(await c.callGenericPopup(msg, c.POPUP_TYPE.CONFIRM));
        },
    };
}

/** 打开日历弹窗，并直接翻到“期刊”那一面（期刊和日历共用一个弹窗）。 */
function openPaper(periodicalId = null, date = null) {
    return openChronicle(calendarHost(), { tab: 'paper', periodicalId, date });
}

/**
 * “新刊”小红点与出刊提醒。toast = true 时，对还没提醒过的新一期冒一句提示（聊天往前走时才冒，切换聊天时只亮红点）。
 */
function refreshPaperDot({ toast = false } = {}) {
    const s = settings();
    installCalendarButtons(calendarHost());
    if (!s.paperEnabled || !s.paperRemind || !hasChat()) return setPeriodicalDot(false);
    const story = paperStoryDate();
    if (!story.date) return setPeriodicalDot(false);
    const store = getPaperStore();
    const fresh = [];
    for (const p of activePeriodicals()) {
        const cur = E.currentIssueDate(p, story.date);
        if (cur && E.hasUnread(store, p.id, cur)) fresh.push({ p, cur });
    }
    setPeriodicalDot(fresh.length > 0, fresh.map(x => `《${x.p.name}》`).join('、'));
    if (!toast) {
        for (const x of fresh) paperToasted.add(`${paperChatId()}|${x.p.id}|${x.cur}`);
        return;
    }
    for (const x of fresh) {
        const key = `${paperChatId()}|${x.p.id}|${x.cur}`;
        if (paperToasted.has(key)) continue;
        paperToasted.add(key);
        toastr.info(`《${x.p.name}》${paperLine(x.p, x.cur)} 出来了。点输入框旁边的日历图标，再点“期刊”就能看。`, '新刊到了', { onclick: () => openPaper(x.p.id, x.cur) });
    }
}

function renderPaperList() {
    const s = settings();
    const list = allPeriodicals();
    $p('#wc_paper_list').html(list.map(p => `<label class="checkbox_label"><input type="checkbox" class="wc_paper_on" data-id="${esc(p.id)}"${paperIsOn(p) ? ' checked' : ''}> 《${esc(p.name)}》<span class="wc_dim">每月 ${esc(p.schedule.days.join('、'))} 日出刊${p.adult ? ' · 含成人向内容' : ''}</span></label>`).join('') || '<span class="wc_dim">还没有刊物</span>');
    $p('#wc_paper_enabled').prop('checked', !!s.paperEnabled);
    $p('#wc_paper_remind').prop('checked', !!s.paperRemind);
    $p('#wc_paper_lore').val(s.paperLoreLimit);
    $p('#wc_paper_chat').val(s.paperChatN);
    $p('#wc_paper_length').val(s.paperLength);
    $p('.wc_paper_body').toggleClass('wc_off', !s.paperEnabled);
}

function bindPaperPanel() {
    const s = settings();
    $p('#wc_paper_enabled').on('change', function () {
        s.paperEnabled = this.checked;
        saveSettings();
        renderPaperList();
        refreshPaperDot();
    });
    $p('#wc_paper_remind').on('change', function () {
        s.paperRemind = this.checked;
        saveSettings();
        refreshPaperDot();
    });
    $p('#wc_paper_list').on('change', '.wc_paper_on', function () {
        (s.paperOn ||= {})[$(this).data('id')] = this.checked;
        saveSettings();
        refreshPaperDot();
    });
    const num = (sel, key, min, max) => $p(sel).on('change', function () {
        s[key] = Math.min(max, Math.max(min, Math.floor(Number(this.value) || 0)));
        $(this).val(s[key]);
        saveSettings();
    });
    num('#wc_paper_lore', 'paperLoreLimit', 0, 100000);
    num('#wc_paper_chat', 'paperChatN', 0, 200);
    num('#wc_paper_length', 'paperLength', 200, 16000);
    $p('#wc_paper_open').on('click', () => openPaper());
}

/** BGM 总开关：关闭时立刻停止播放、不再请求任何音源，并从注入里去掉 <bgm> 约定 */
function setBgmEnabled(on) {
    settings().bgmEnabled = !!on;
    saveSettings();
    updateInjection();
    syncBgm();
    renderBgmBadge();
    refreshPanel();
}

/** 玩家日历需要的宿主接口 */
function calendarHost() {
    return {
        engine: E,
        pack: () => activePack(),
        state: () => getState(),
        bgmText: () => bgmStatusText(),
        bgmEnabled: () => !!settings().bgmEnabled,
        setBgmEnabled,
        showFuture: () => settings().calendarShowFuture !== false,
        setShowFuture: (v) => { settings().calendarShowFuture = !!v; saveSettings(); },
        buttonEnabled: () => settings().calendarButton !== false,
        periodicals: () => activePeriodicals(),
        paperEnabled: () => !!settings().paperEnabled,
        paper: paperHost(),
        popup: (el) => {
            const c = ctx();
            return c.callGenericPopup(el, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '关闭' });
        },
    };
}

function openEditorWithCurrent() {
    const s = settings();
    const m = getMapping();
    openEditor({
        engine: E,
        library: () => settings().packs,
        initialPackId: m?.packId || Object.keys(s.packs)[0] || null,
        savePack: (pack, opts) => savePackToLibrary(pack, opts),
        deletePack: (id) => {
            delete settings().packs[id];
            saveSettings();
            refreshPanel();
        },
        writeToCard: writePackToCard,
        readFromCard: readPackFromCard,
        cardName: () => (ctx().characterId !== undefined ? currentCharacter()?.name : null),
        cardMaterial: readCardMaterial,
        ai: {
            generate: generateForAuthor,
            // ST 的 generateRaw 监听 GENERATION_STOPPED 来中止请求；stopGeneration 会发出这个事件
            stop: () => ctx().stopGeneration?.(),
        },
        chatState: () => getState(),
        chatPresent: () => lastPresent,
        // 编辑器里的试听：用玩家自己的音源去找这首歌（BGM 总开关关闭时不发任何请求）
        bgm: {
            test: (track, packSource) => {
                if (!settings().bgmEnabled) return toastr.info('面板里的“背景音乐”没勾上，所以没出声。', '世界编年史');
                if (!track?.title) return toastr.warning('先写上歌名，才能试听。', '世界编年史');
                const song = trackSong(track);
                playSong(song, '试听', `__test__:${songKey(song)}`, packSource).then(() => {
                    if (bgmNow?.reason !== '试听' || bgmNow.result?.url) return;
                    toastr.info(packSource === 'link' ? `「${songLabel(song)}」还没贴网址，贴上就能试听了。` : `没找到「${songLabel(song)}」。如果还没打开 GD音乐台，可以在面板的“音乐”里勾上“允许用 GD音乐台在线找歌”。`, '世界编年史');
                });
            },
            stop: () => stopBgm(),
        },
        mapping: () => getMapping(),
        toast: (type, msg) => toastr[type](msg, '世界编年史'),
        confirm: async (msg) => {
            const c = ctx();
            return !!(await c.callGenericPopup(msg, c.POPUP_TYPE.CONFIRM));
        },
    });
}

// ---------------------------------------------------------------- 启动

async function onChatChanged() {
    deliveredOnce = [];
    lastOnce = [];
    jumpDecision = null;
    try {
        await loadPackFromCard();
    } catch (e) {
        console.error('[世界编年史] 读取角色卡内嵌包失败', e);
    }
    updateInjection();
    syncBgm();
    refreshPanel();
    refreshPaperDot();
    setTimeout(rerenderAll, 0);
}

jQuery(async () => {
    settings();
    const html = await (await fetch(new URL('settings.html', BASE_URL))).text();
    $('#extensions_settings2').append(html);
    $('#wc_panel .wc_brand_logo').attr('src', new URL('assets/logo-icon.png', BASE_URL).href);
    initBgm();
    bindPanel();
    bindMusic();
    installCalendarButtons(calendarHost());
    installTagHiding();
    bindPaperPanel();
    refreshPaperDot();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, (id) => { processMessage(Number(id)); refreshPaperDot({ toast: true }); });
    eventSource.on(eventTypes.MESSAGE_SENT, (id) => processMessage(Number(id)));
    eventSource.on(eventTypes.MESSAGE_EDITED, (id) => {
        const st = getState();
        if (st?.undo && st.undo.mesId === Number(id)) processMessage(Number(id));
    });
    eventSource.on(eventTypes.MESSAGE_SWIPED, (id) => {
        const st = getState();
        if (st?.undo && st.undo.mesId === Number(id)) processMessage(Number(id));
        rerenderMessage(Number(id));
    });
    // dry run（提示词预览/计 token）也走这里，保证预览与实际注入一致；不标记补发为已读。
    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, () => updateInjection());
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (id) => rerenderMessage(Number(id)));
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, (id) => rerenderMessage(Number(id)));
    eventSource.on(eventTypes.MESSAGE_UPDATED, (id) => rerenderMessage(Number(id)));

    refreshPanel();
});
