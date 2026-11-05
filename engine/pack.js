// 事件包：规范化、校验、按名字查角色、合并卡侧映射。
import { isValidDate, normalizeDate, compareDates } from './date.js';
import { isStopWord, findTrack, BGM_STOP, AI_MODES, MUSIC_SOURCES } from './bgm.js';
import { audioLinkProblem } from './music.js';
import { parseSongLine, formatSong } from './music.js';
import { normalizePeriodicals } from './periodicals.js';

export const PACK_FORMAT_VERSION = 1;

export function createEmptyPack(id = 'new-pack', name = '新事件包') {
    return normalizePack({
        meta: { id, name, version: '0.1', display: '{y}年{m}月{d}日', countdowns: [] },
        bgm: { source: 'link' },
    }).pack;
}

function arr(v) {
    return Array.isArray(v) ? v : [];
}

function str(v, def = '') {
    return v === undefined || v === null ? def : String(v);
}

function num(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

function strList(v) {
    if (typeof v === 'string') v = v.split(/[,，、\n]/);
    return arr(v).map(x => String(x).trim()).filter(Boolean);
}

function normalizeAffect(a) {
    a = a && typeof a === 'object' ? a : {};
    const out = {
        pressure: str(a.pressure),
        dilemma: str(a.dilemma),
        options: strList(a.options),
    };
    if (a.ripple) out.ripple = str(a.ripple);
    return out;
}

function normalizeAffects(affects) {
    const out = {};
    if (affects && typeof affects === 'object' && !Array.isArray(affects)) {
        for (const [k, v] of Object.entries(affects)) {
            if (k.trim()) out[k.trim()] = normalizeAffect(v);
        }
    }
    return out;
}

/** 玩家日历里事件的可见度：show 全部显示 / title_only 只显示标题 / hidden 发生前不显示。只影响玩家界面，不影响注入。 */
export const VISIBILITY = ['show', 'title_only', 'hidden'];

/**
 * 曲目：以歌名（可带歌手）标识，不保存任何平台 id 或会过期的地址。
 * { id, title, artist, mood, url, loop, volume }；url 可选（作者自己托管音频时填）。
 * 兼容旧格式 { id, name, url }：name → title；只有 title 时也可以写成“歌手 - 歌名”。
 */
export function normalizeTrack(t) {
    if (typeof t === 'string') t = { title: t };
    if (!t || typeof t !== 'object') return null;
    let title = str(t.title ?? t.name ?? '').trim();
    let artist = str(t.artist).trim();
    if (title && !artist && !/[|｜]/.test(title)) {
        const p = parseSongLine(title);
        if (p?.artist) ({ title, artist } = p);
    }
    if (!title) title = str(t.id).trim();
    if (!title) return null;
    return {
        id: str(t.id).trim() || formatSong({ title, artist }),
        title,
        artist,
        mood: str(t.mood),
        url: str(t.url).trim(),
        loop: t.loop !== false,
        volume: Math.min(1, Math.max(0, num(t.volume, 1))),
    };
}

/**
 * 规范化事件包，补齐默认值。返回 { pack, errors, warnings }。
 * errors 表示包无法正常使用（如日期非法），warnings 只是提示。
 */
export function normalizePack(input) {
    const errors = [];
    const warnings = [];
    const src = input && typeof input === 'object' ? input : {};
    const m = src.meta && typeof src.meta === 'object' ? src.meta : {};

    const meta = {
        id: str(m.id).trim(),
        name: str(m.name, m.id || ''),
        version: str(m.version, '0.1'),
        format: PACK_FORMAT_VERSION,
        calendar: str(m.calendar, 'gregorian'),
        display: str(m.display, '{y}年{m}月{d}日'),
        eras: arr(m.eras).filter(e => e && e.name && isValidDate(e.from)).map(e => ({ name: str(e.name), from: normalizeDate(e.from) })),
        start: isValidDate(m.start) ? normalizeDate(m.start) : '',
        countdowns: arr(m.countdowns).filter(c => c && isValidDate(c.date)).map(c => ({ label: str(c.label), date: normalizeDate(c.date) })),
        interlude: {
            every_days: Math.max(0, num(m.interlude?.every_days, 3)),
            chance: Math.min(1, Math.max(0, num(m.interlude?.chance, 0.7))),
        },
        ripple_days: Math.max(0, num(m.ripple_days, 30)),
        max_jump_days: Math.max(0, num(m.max_jump_days, 180)),
        description: str(m.description),
        author: str(m.author),
    };
    if (!meta.id) errors.push('meta.id 不能为空');

    const characters = arr(src.characters).filter(c => c && (c.id || c.name)).map(c => ({
        id: str(c.id || c.name).trim(),
        name: str(c.name || c.id).trim(),
        aliases: strList(c.aliases),
        tags: strList(c.tags),
        note: str(c.note),
    }));
    const charIds = new Set();
    for (const c of characters) {
        if (charIds.has(c.id)) errors.push(`角色 id 重复: ${c.id}`);
        charIds.add(c.id);
    }

    const tagSet = new Set(strList(src.tags));
    for (const c of characters) c.tags.forEach(t => tagSet.add(t));
    const tags = [...tagSet];

    const relations = arr(src.relations).filter(r => r && r.from && r.to).map(r => ({
        from: str(r.from), to: str(r.to), type: str(r.type), note: str(r.note),
    }));
    for (const r of relations) {
        if (!charIds.has(r.from)) warnings.push(`关系引用了未知角色: ${r.from}`);
        if (!charIds.has(r.to)) warnings.push(`关系引用了未知角色: ${r.to}`);
    }

    // 曲目引用：停止词（stop / 停止 / 无 …）统一成 BGM_STOP
    const trackRef = v => (isStopWord(v) ? BGM_STOP : str(v).trim());
    const b = src.bgm && typeof src.bgm === 'object' ? src.bgm : {};
    const tracks = arr(b.tracks).map(normalizeTrack).filter(Boolean);
    // 旧包只有 ai_tag 开关：false → off，其余 → playlist
    let aiMode = AI_MODES.includes(b.ai_mode) ? b.ai_mode : (b.ai_tag === false ? 'off' : 'playlist');
    // 音乐来源（作者三选一）。旧包没有这个字段：按内容推断。
    const source = MUSIC_SOURCES.includes(b.source) ? b.source
        : aiMode === 'free' ? 'ai'
        : tracks.length && tracks.every(t => t.url) ? 'link' : 'gd';
    // “AI 搜歌”必然是自由点歌；另外两种来源 AI 只能从歌单里挑（或不挑）
    if (source === 'ai') aiMode = 'free';
    else if (aiMode === 'free') aiMode = 'playlist';
    const bgm = {
        source,
        ai_mode: aiMode,
        tracks,
        rules: arr(b.rules).filter(r => r && typeof r === 'object').map((r, i) => ({
            id: str(r.id, `rule${i + 1}`),
            keywords: strList(r.keywords),
            regex: str(r.regex),
            track: trackRef(r.track),
            if: r.if && typeof r.if === 'object' ? r.if : null,
        })),
    };
    const checkTrack = (id, where) => {
        if (id && !isStopWord(id) && !findTrack({ bgm }, id)) warnings.push(`${where} 引用了未知曲目: ${id}`);
    };
    const seenTracks = new Set();
    for (const t of bgm.tracks) {
        if (seenTracks.has(t.id)) warnings.push(`曲目 id 重复: ${t.id}`);
        seenTracks.add(t.id);
        if (t.url) {
            const problem = audioLinkProblem(t.url);
            if (problem) warnings.push(`「${formatSong(t)}」的链接：${problem}`);
        } else if (source === 'link') {
            warnings.push(`「${formatSong(t)}」还没有贴链接，播放不了`);
        }
    }
    for (const r of bgm.rules) {
        if (!r.track) warnings.push(`BGM 规则 ${r.id} 没有选择曲目`);
        checkTrack(r.track, `BGM 规则 ${r.id}`);
        if (!r.keywords.length && !r.regex) warnings.push(`BGM 规则 ${r.id} 没有关键词也没有正则，永远不会触发`);
        if (r.regex) {
            try { new RegExp(r.regex); } catch { warnings.push(`BGM 规则 ${r.id} 的正则无效`); }
        }
    }

    const phases = arr(src.phases).filter(p => p && p.id).map(p => ({
        id: str(p.id), name: str(p.name, p.id), from: normalizeDate(str(p.from)) || '', to: normalizeDate(str(p.to)) || '', mood: str(p.mood), bgm: trackRef(p.bgm),
    }));
    for (const p of phases) checkTrack(p.bgm, `阶段 ${p.id}`);
    for (const p of phases) {
        if (!p.from || !p.to) errors.push(`阶段 ${p.id} 的起止日期非法`);
        else if (compareDates(p.from, p.to) > 0) errors.push(`阶段 ${p.id} 的开始日期晚于结束日期`);
    }

    const events = arr(src.events).filter(e => e && e.id).map(e => ({
        id: str(e.id),
        date: normalizeDate(str(e.date)) || '',
        title: str(e.title, e.id),
        lead_days: Math.max(0, Math.floor(num(e.lead_days, 0))),
        linger_days: Math.max(0, Math.floor(num(e.linger_days, 0))),
        rumor: str(e.rumor),
        news: str(e.news),
        summary: str(e.summary),
        affects: normalizeAffects(e.affects),
        set_flags: strList(e.set_flags),
        once: e.once === true,
        bgm: trackRef(e.bgm),
        visibility: VISIBILITY.includes(e.visibility) ? e.visibility : 'show',
        if: e.if && typeof e.if === 'object' ? e.if : null,
        variants: arr(e.variants).filter(v => v && typeof v === 'object').map(v => {
            const out = { if: v.if && typeof v.if === 'object' ? v.if : null };
            for (const k of ['title', 'rumor', 'news', 'summary']) if (v[k] !== undefined && v[k] !== '') out[k] = str(v[k]);
            if (v.affects && Object.keys(v.affects).length) out.affects = normalizeAffects(v.affects);
            if (v.note) out.note = str(v.note);
            return out;
        }),
    }));
    const eventIds = new Set();
    for (const e of events) {
        if (!e.date) errors.push(`事件 ${e.id} 的日期非法`);
        if (eventIds.has(e.id)) errors.push(`事件 id 重复: ${e.id}`);
        eventIds.add(e.id);
        checkTrack(e.bgm, `事件 ${e.id}`);
        for (const k of Object.keys(e.affects)) {
            if (!charIds.has(k) && !tagSet.has(k)) warnings.push(`事件 ${e.id} 的影响对象「${k}」既不是角色 id 也不是已知身份标签`);
        }
    }
    events.sort((a, b) => (a.date && b.date ? compareDates(a.date, b.date) : 0));

    const interludes = arr(src.interludes).filter(i => i && i.id).map(i => {
        const w = arr(i.window);
        return {
            id: str(i.id),
            window: [normalizeDate(str(w[0] ?? '')) || '', normalizeDate(str(w[1] ?? '')) || ''],
            weight: Math.max(0, num(i.weight, 1)),
            cooldown_days: Math.max(0, Math.floor(num(i.cooldown_days, 0))),
            if: i.if && typeof i.if === 'object' ? i.if : null,
            text: str(i.text),
            bgm: trackRef(i.bgm),
        };
    });
    for (const i of interludes) checkTrack(i.bgm, `插曲 ${i.id}`);

    // 作者列出的旗标：AI 可以在剧情真的走到那一步时用 <flag> 记下
    const flag_defs = arr(src.flag_defs).filter(f => f && str(f.name).trim()).map(f => ({ name: str(f.name).trim(), when: str(f.when), from: normalizeDate(str(f.from ?? '')) || '', to: normalizeDate(str(f.to ?? '')) || '' }));

    // 定期刊物（可选）：旧剧本没有这个字段，规范化后是空列表，行为不变
    const per = normalizePeriodicals(src.periodicals);
    errors.push(...per.errors);
    warnings.push(...per.warnings);
    const periodicals = per.periodicals;

    return { pack: { meta, tags, characters, relations, phases, events, interludes, bgm, flag_defs, periodicals }, errors, warnings };
}

export function getCharacter(pack, id) {
    return pack.characters.find(c => c.id === id) || null;
}

/** 名字、别名或 id 精确匹配角色，返回 id 或 null。 */
export function resolveCharacterId(pack, nameOrId) {
    if (!nameOrId) return null;
    const key = String(nameOrId).trim();
    for (const c of pack.characters) {
        if (c.id === key || c.name === key || c.aliases.includes(key)) return c.id;
    }
    return null;
}

export function resolveEventId(pack, idOrTitle) {
    if (!idOrTitle) return null;
    const key = String(idOrTitle).trim();
    const e = pack.events.find(x => x.id === key) || pack.events.find(x => x.title === key);
    return e ? e.id : null;
}

/**
 * 卡侧映射合并进包（返回新对象，不修改原包）：
 * mapping = { characters: [{ id, name, aliases, tags }], relations: [...], player: 'id' }
 * 同 id 的角色合并别名与标签；新 id 作为新角色加入。
 */
export function applyMapping(pack, mapping) {
    if (!mapping) return pack;
    const out = JSON.parse(JSON.stringify(pack));
    for (const raw of arr(mapping.characters)) {
        if (!raw || !(raw.id || raw.name)) continue;
        const id = String(raw.id || raw.name);
        const existing = out.characters.find(c => c.id === id);
        const aliases = strList(raw.aliases);
        const tags = strList(raw.tags);
        if (existing) {
            existing.aliases = [...new Set([...existing.aliases, ...aliases])];
            existing.tags = [...new Set([...existing.tags, ...tags])];
            if (raw.name && raw.name !== existing.name && !existing.aliases.includes(raw.name)) existing.aliases.push(String(raw.name));
        } else {
            out.characters.push({ id, name: String(raw.name || id), aliases, tags, note: '' });
        }
        tags.forEach(t => { if (!out.tags.includes(t)) out.tags.push(t); });
    }
    for (const r of arr(mapping.relations)) {
        if (r && r.from && r.to) out.relations.push({ from: String(r.from), to: String(r.to), type: str(r.type), note: str(r.note) });
    }
    if (mapping.player) out.player = String(mapping.player);
    return out;
}
