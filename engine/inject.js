// 组装三层注入文本：氛围 / 新闻 / 个人。
import { formatDate, computeCountdowns, describeCountdown, diffDays, isValidDate } from './date.js';
import { evaluateCondition } from './conditions.js';
import { getPhase, eventStatus, resolveEvent, conditionContext, flagOpen } from './schedule.js';
import { getCharacter } from './pack.js';
import { activeRipplesFor } from './ripples.js';
import { formatSong } from './music.js';

/** 当前日期下所有可见事件（已应用变体与条件）。绝不返回 future 状态的事件。 */
export function visibleEvents(pack, state, date, present = []) {
    const ctx = conditionContext(pack, state, date, present);
    const catchupIds = new Set((state.catchup || []).map(c => c.id));
    const out = [];
    for (const raw of pack.events) {
        if (!raw.date || !evaluateCondition(raw.if, ctx)) continue;
        let status = eventStatus(raw, date);
        if (status === 'past' && catchupIds.has(raw.id)) status = 'catchup';
        if (status === 'future' || status === 'past') continue;
        out.push({ event: resolveEvent(raw, ctx), status, daysSince: diffDays(raw.date, date) });
    }
    return out;
}

/** 某角色在事件中的影响条目：先匹配角色 id，再按标签顺序匹配。 */
export function affectsFor(event, character) {
    const out = [];
    if (event.affects[character.id]) out.push({ key: character.id, ...event.affects[character.id] });
    for (const t of character.tags || []) {
        if (event.affects[t]) out.push({ key: t, ...event.affects[t] });
    }
    return out;
}

/**
 * @param {object} pack 规范化（并已合并映射）的包
 * @param {object} state 聊天状态
 * @param {object} [opts]
 * @param {string[]} [opts.present] 在场角色 id
 * @param {boolean} [opts.instructions=true] 是否附带标签约定
 * @param {boolean} [opts.bgm=true] 玩家是否开着 BGM（关掉时不提 <bgm>）
 * @returns {{ text: string, atmosphere: string[], news: string[], personal: {id: string, name: string, lines: string[]}[], instructions: string[] }}
 */
export function buildInjection(pack, state, { present = [], instructions = true, bgm = true } = {}) {
    const date = state.date;
    const result = { text: '', atmosphere: [], news: [], personal: [], instructions: [], once: [] };
    const tagRules = [];

    if (!isValidDate(date)) {
        if (instructions) {
            const hint = pack.meta.start ? `（故事起始日期参考：${pack.meta.start}）` : '';
            tagRules.push(`请在回复末尾输出 <time>YYYY-MM-DD</time> 标注故事内的当前日期（一律写公历数字）${hint}。`);
        }
        result.instructions = tagRules;
        result.text = assemble(result, null);
        return result;
    }

    // ---- 氛围层 ----
    const phase = getPhase(pack, date);
    if (phase?.mood) result.atmosphere.push(`时代氛围：${phase.mood}`);
    const cds = computeCountdowns(pack.meta.countdowns, date);
    if (cds.length) result.atmosphere.push(`倒计时：${cds.map(describeCountdown).join('；')}`);

    // “只提醒一次”的事件：AI 回复过之后就不再出现（风声不算）
    const visible = visibleEvents(pack, state, date, present).filter(v => !(v.event.once && v.status !== 'rumor' && state.onceSeen?.[v.event.id]));
    result.once = visible.filter(v => v.event.once && v.status !== 'rumor').map(v => v.event.id);
    const lingering = visible.filter(v => v.status === 'linger');
    if (lingering.length) {
        result.atmosphere.push(`近期大事：${lingering.map(v => `${v.event.title}（${v.daysSince}天前）`).join('；')}`);
    }

    // ---- 新闻层 ----
    for (const v of visible) {
        const e = v.event;
        if (v.status === 'rumor') {
            if (e.rumor) result.news.push(`【风声】${e.rumor}`);
        } else if (v.status === 'today') {
            result.news.push(`【今日】${e.title}：${e.news || e.summary || ''}`.trim());
        } else if (v.status === 'catchup') {
            result.news.push(`【这段时间里发生了】${formatDate(e.date, pack.meta.display, pack.meta.eras)}，${e.title}：${e.news || e.summary || ''}`);
        } else if (v.status === 'linger') {
            const body = e.summary || e.news;
            if (body) result.news.push(`【余波】${e.title}：${body}`);
        }
    }
    if (state.interlude && state.interlude.date === date) {
        const it = pack.interludes.find(i => i.id === state.interlude.id);
        if (it?.text) result.news.push(`【街头巷尾】${it.text}（可以忽略）`);
    }

    // ---- 个人层（只为在场角色） ----
    const active = visible.filter(v => v.status !== 'rumor');
    let pendingDilemma = false;
    for (const id of present) {
        const c = getCharacter(pack, id);
        if (!c) continue;
        const isPlayer = pack.player === c.id;
        const lines = [];
        for (const v of active) {
            const e = v.event;
            const made = (state.choices || []).find(x => x.who === c.id && x.event === e.id);
            for (const a of affectsFor(e, c)) {
                if (a.pressure) lines.push(`「${e.title}」带来的压力：${a.pressure}`);
                if (made) continue;
                if (a.dilemma) {
                    let line = `摆在面前的难题（事件id：${e.id}）：${a.dilemma}`;
                    if (a.options.length) line += ` 可能的方向（仅供参考，不限于此）：${a.options.join(' / ')}`;
                    lines.push(line);
                    if (!isPlayer) pendingDilemma = true;
                }
            }
            if (made) lines.push(`已就「${e.title}」作出选择：${made.choice}`);
        }
        for (const r of activeRipplesFor(pack, state, c.id, date)) lines.push(`牵连：${r.text}`);
        if (lines.length) {
            if (isPlayer) lines.push('（此角色由 user 扮演：只描述其处境，不要替其作出决定或行动。）');
            result.personal.push({ id: c.id, name: c.name, lines });
        }
    }

    if (instructions) {
        tagRules.push('以上是世界正在发生的事与人物身上的压力，不是剧情指令；角色如何回应由其人设决定，user 可以完全不理会主线。');
        tagRules.push('请在回复末尾输出 <time>YYYY-MM-DD</time> 标注故事内的当前日期（一律写公历数字，故事里用别的历法时也一样；日期没变也要输出；时间跳跃时写新的日期）。');
        if (pendingDilemma) {
            tagRules.push('当在场角色对上述难题作出明确选择时，在回复末尾输出 <choice who="角色名" event="事件id">所作的选择</choice>；尚未决定就不要输出。');
        }
        // 只列此刻可能发生的转折：既不提前剧透，也不让 AI 回头改已经过去的事
        const openFlags = (pack.flag_defs || []).filter(f => !state.flags?.[f.name] && flagOpen(f, date));
        if (openFlags.length) {
            const list = openFlags.map(f => (f.when ? `${f.name}（${f.when}）` : f.name)).join('；');
            tagRules.push(`如果剧情里已经确实发生了下面某件事，在回复末尾输出 <flag>名字</flag> 记下，照抄名字；只是打算、可能或传言都不算，没发生就不要输出：${list}`);
        }
        if (bgm) {
            const line = bgmInstruction(pack);
            if (line) tagRules.push(line);
        }
    }
    result.instructions = tagRules;
    result.text = assemble(result, formatDate(date, pack.meta.display, pack.meta.eras), phase);
    return result;
}

function assemble(r, dateText, phase) {
    const out = ['[世界编年史 · 世界状态]'];
    if (dateText) out.push(`故事日期：${dateText}${phase?.name && phase.name !== phase.id ? `（${phase.name}）` : ''}`);
    out.push(...r.atmosphere);
    if (r.news.length) out.push('', '— 新闻与风声 —', ...r.news);
    if (r.personal.length) {
        out.push('', '— 在场角色的处境 —');
        for (const p of r.personal) out.push(`◆ ${p.name}`, ...p.lines.map(l => `  · ${l}`));
    }
    if (r.instructions.length) out.push('', '— 约定 —', ...r.instructions);
    return out.join('\n');
}

/** 歌单（含氛围）的一行文字 */
function playlistText(tracks) {
    return tracks.map(t => (t.mood ? `${formatSong(t)}（${t.mood}）` : formatSong(t))).join('、');
}

/** 按包的 ai_mode 给 AI 的 <bgm> 约定；不该出现时返回空串。 */
export function bgmInstruction(pack) {
    const mode = pack.bgm?.ai_mode || 'playlist';
    // 贴链接模式下，没链接的歌放不出来，不告诉 AI
    const tracks = (pack.bgm?.tracks || []).filter(t => pack.bgm?.source !== 'link' || t.url);
    const when = '只有当场景气氛明显转折时，才在回复末尾输出';
    const tail = '（<bgm>stop</bgm> 为停止）；气氛不变就不要输出。';
    if (mode === 'playlist' && tracks.length) {
        return `可选背景音乐（只能从这个歌单里选，照抄“歌手 - 歌名”）：${playlistText(tracks)}。${when} <bgm>歌手 - 歌名</bgm> 切换音乐${tail}`;
    }
    if (mode === 'free') {
        const setting = pack.meta?.name ? `「${pack.meta.name}」` : '故事';
        const suggest = tracks.length ? `作者推荐的歌单（可优先从中选）：${playlistText(tracks)}。` : '';
        return `可以用背景音乐烘托气氛：${suggest}也可以选任何真实存在的歌曲，请挑选贴合${setting}的时代、地域与当下情绪的曲目，不要编造不存在的歌。${when} <bgm>歌手 - 歌名</bgm> 切换音乐${tail}`;
    }
    return '';
}
