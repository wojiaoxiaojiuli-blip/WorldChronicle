// BGM：决定“此刻该放哪首曲子”。只做选择，不碰音频（播放器在 ui/bgm-player.js）。
import { evaluateCondition } from './conditions.js';
import { conditionContext, getPhase } from './schedule.js';
import { stripTags } from './tags.js';
import { parseSongLine, formatSong, pickBestMatch } from './music.js';

/** 作者选择 AI 如何挑选音乐：off 不让 AI 选 / playlist 只能从歌单里选 / free 可以点任何真实存在的歌 */
export const AI_MODES = ['off', 'playlist', 'free'];

/** 作者选择音乐从哪来：link 贴链接 / gd 按歌单在 GD音乐台找 / ai AI 自己点歌并通过 GD音乐台找 */
export const MUSIC_SOURCES = ['link', 'gd', 'ai'];

/** 特殊曲目 id：停止播放 */
export const BGM_STOP = '__stop__';
const STOP_WORDS = [BGM_STOP, 'stop', 'none', '停止', '停', '无'];

export function isStopWord(key) {
    return STOP_WORDS.includes(String(key ?? '').trim().toLowerCase());
}

/** 曲目显示名：“歌手 - 歌名” */
export const trackLabel = formatSong;

/**
 * 按 id、歌名或“歌手 - 歌名”找曲目（容忍大小写、标点、括号里的版本说明）；
 * 停止词返回 BGM_STOP；找不到返回 null。
 */
export function findTrack(pack, key) {
    if (!key) return null;
    const k = String(key).trim();
    if (!k) return null;
    if (isStopWord(k)) return BGM_STOP;
    const tracks = pack.bgm?.tracks || [];
    const exact = tracks.find(x => x.id === k || x.title === k || formatSong(x) === k);
    if (exact) return exact.id;
    const want = parseSongLine(k);
    if (!want) return null;
    // 只写了歌名、或写的“歌手 - 歌名”被误拆时，再按整串当歌名试一次
    const hit = pickBestMatch(want, tracks, 0.6) || (want.artist ? pickBestMatch({ title: k }, tracks, 1) : null);
    return hit ? hit.id : null;
}

export function getTrack(pack, id) {
    return (pack.bgm?.tracks || []).find(x => x.id === id) || null;
}

function compileRegex(src) {
    if (!src) return null;
    try {
        return new RegExp(src, 'i');
    } catch {
        return null;
    }
}

/** 关键词规则：按列表顺序取第一条命中且条件成立的规则。 */
export function matchBgmRule(pack, text, ctx) {
    const s = String(text || '');
    if (!s) return null;
    for (const r of pack.bgm?.rules || []) {
        const track = findTrack(pack, r.track);
        if (!track) continue;
        const kw = (r.keywords || []).some(k => k && s.includes(k));
        const re = compileRegex(r.regex);
        if (!kw && !(re && re.test(s))) continue;
        if (ctx && !evaluateCondition(r.if, ctx)) continue;
        return { ...r, track };
    }
    return null;
}

/** 阶段的底色曲目（打开聊天时用）。 */
export function baselineBgm(pack, state) {
    if (!state?.date) return null;
    const id = findTrack(pack, getPhase(pack, state.date)?.bgm);
    return id && id !== BGM_STOP ? id : null;
}

/**
 * 处理完一条消息后决定 BGM。返回 { track, reason } / { query, reason } 或 null（null = 保持当前曲目不变）。
 * 优先级：AI 的 <bgm> 标签 > 关键词规则 > 刚触发的事件 > 刚抽中的插曲 > 阶段切换。
 * track 为曲目 id 或 BGM_STOP；query = { title, artist } 是 free 模式下 AI 点的歌单外歌曲，由玩家的音源去找。
 * AI 标签按包的 ai_mode 处理：off 忽略；playlist 只认歌单里的曲目；free 歌单外的歌也接受。
 *
 * @param {object} pack
 * @param {object} p
 * @param {string}   [p.text]       消息原文
 * @param {string}   [p.tag]        已解析出的 <bgm> 内容
 * @param {object}   p.state        推进后的状态
 * @param {object}   [p.prevState]  推进前的状态
 * @param {string[]} [p.fired]      本次推进触发的事件 id
 * @param {string}   [p.interlude]  本次抽中的插曲 id
 * @param {string[]} [p.present]
 */
export function chooseBgm(pack, { text = '', tag = null, state, prevState = null, fired = [], interlude = null, present = [] }) {
    const mode = pack.bgm?.ai_mode || 'playlist';
    const hasTracks = !!pack.bgm?.tracks?.length;
    if (!hasTracks && mode !== 'free') return null;

    if (tag && mode !== 'off') {
        const id = findTrack(pack, tag);
        if (id) return { track: id, reason: 'AI 标签' };
        if (mode === 'free') {
            const q = parseSongLine(tag);
            if (q) return { query: { title: q.title, artist: q.artist }, reason: 'AI 点歌' };
        }
    }
    if (!hasTracks) return null;

    const ctx = state?.date ? conditionContext(pack, state, state.date, present) : { flags: state?.flags || {}, choices: state?.choices || [], phase: null, present };
    const rule = matchBgmRule(pack, stripTags(text), ctx);
    if (rule) return { track: rule.track, reason: `关键词规则 ${rule.id}` };

    // 同一次推进触发多个事件时，取最晚的那个
    for (const id of [...fired].reverse()) {
        const e = pack.events.find(x => x.id === id);
        const track = findTrack(pack, e?.bgm);
        if (track) return { track, reason: `事件「${e.title}」` };
    }

    if (interlude) {
        const it = pack.interludes.find(x => x.id === interlude);
        const track = findTrack(pack, it?.bgm);
        if (track) return { track, reason: `插曲 ${it.id}` };
    }

    if (state?.date) {
        const now = getPhase(pack, state.date);
        const before = prevState?.date ? getPhase(pack, prevState.date) : null;
        const track = now && now.id !== before?.id ? findTrack(pack, now.bgm) : null;
        if (track) return { track, reason: `进入阶段「${now.name || now.id}」` };
    }
    return null;
}
