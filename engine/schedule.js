// 时间引擎：阶段查找、事件到期计算、时间推进（含跳跃补发）。
import { toDayNumber, isValidDate, normalizeDate, inRange, diffDays } from './date.js';
import { evaluateCondition } from './conditions.js';

export function getPhase(pack, date) {
    if (!isValidDate(date)) return null;
    return pack.phases.find(p => p.from && p.to && inRange(date, p.from, p.to)) || null;
}

/**
 * 事件相对某一天的状态：
 *   'future'  预兆期之前（完全不可见）
 *   'rumor'   预兆期内（只给风声，绝不给新闻）
 *   'today'   当天
 *   'linger'  余波期内
 *   'past'    余波期之后
 */
export function eventStatus(event, date) {
    const n = toDayNumber(date);
    const e = toDayNumber(event.date);
    if (n < e) return n >= e - (event.lead_days || 0) ? 'rumor' : 'future';
    if (n === e) return 'today';
    if (n <= e + (event.linger_days || 0)) return 'linger';
    return 'past';
}

/** 合并变体：取第一个条件成立的变体覆盖标题/风声/新闻/影响。 */
export function resolveEvent(event, ctx) {
    const v = (event.variants || []).find(x => x.if && evaluateCondition(x.if, ctx));
    if (!v) return event;
    return {
        ...event,
        title: v.title ?? event.title,
        rumor: v.rumor ?? event.rumor,
        news: v.news ?? event.news,
        summary: v.summary ?? event.summary,
        affects: v.affects ? { ...event.affects, ...v.affects } : event.affects,
        variant: v,
    };
}

export function createState(packId = null) {
    return {
        version: 1,
        packId,
        date: null,
        fired: {},          // eventId -> 触发时的故事日期
        catchup: [],        // [{ id, since, seen }] 时间跳跃中错过窗口、需要补发的事件
        choices: [],        // [{ who, event, choice, date }]
        flags: {},          // name -> true
        ripples: [],        // [{ to, from, event, choice, type, note, text, date }]
        interlude: null,    // { id, date } 当前生效的插曲
        interludeLast: {},  // interludeId -> 上次抽中的日期
        lastInterludeDraw: null,
        onceSeen: {},       // eventId -> true：标了“只提醒一次”且 AI 已经回复过的事件
        presentManual: {},  // charId -> true(强制在场) / false(强制不在场)
        log: [],            // [{ date, text }]
    };
}

/** 这个转折此刻是否可能发生。from / to 留空表示不限；还没有日期时不限。 */
export function flagOpen(def, date) {
    return !isValidDate(date) || inRange(date, def.from || null, def.to || null);
}

/**
 * 记下 AI 用 <flag> 报告的旗标。只接受 flag_defs 列出、且 dates 里某一天在时间窗内的名字，其余忽略。
 * dates 传消息前后的故事日期（同一条消息可能跨天）。
 * 纯函数：返回 { state, added }，不修改传入的 state。
 */
export function applyFlagTags(pack, prevState, names, dates = [prevState.date]) {
    const allowed = new Set((pack.flag_defs || []).filter(f => dates.some(d => flagOpen(f, d))).map(f => f.name));
    const added = [...new Set(names || [])].filter(n => allowed.has(n) && !prevState.flags?.[n]);
    if (!added.length) return { state: prevState, added };
    const state = JSON.parse(JSON.stringify(prevState));
    for (const n of added) {
        state.flags[n] = true;
        state.log.push({ date: state.date, text: `记下：${n}` });
    }
    return { state, added };
}

export function conditionContext(pack, state, date, present = []) {
    const phase = getPhase(pack, date);
    return { flags: state.flags || {}, choices: state.choices || [], phase: phase ? phase.id : null, present };
}

/** 在 (from, to] 区间内到期的事件，按日期排序。from 为空表示“从远古开始”。 */
export function eventsBetween(pack, from, to) {
    const lo = from ? toDayNumber(from) : -Infinity;
    const hi = toDayNumber(to);
    return pack.events.filter(e => {
        if (!e.date) return false;
        const n = toDayNumber(e.date);
        return n > lo && n <= hi;
    });
}

/**
 * 推进时间。纯函数：返回 { state, fired, catchup, interlude, log }，不修改传入的 state。
 * - 首次设定日期：之前的事件视为“历史”，只标记为已发生、不补发；当天及以后的正常处理。
 * - 向前推进：区间 (旧日期, 新日期] 内的所有事件触发；若新日期已越过其余波期，进入补发队列。
 * - 向后回拨：撤销新日期之后的触发记录（用于手动纠错）。
 * - 推进后按插曲规则抽取一次插曲。
 */
export function advanceTime(pack, prevState, newDate, { rng = Math.random, present = [] } = {}) {
    const state = JSON.parse(JSON.stringify(prevState || createState(pack.meta.id)));
    newDate = normalizeDate(newDate);
    if (!newDate) throw new Error('非法日期');
    const oldDate = state.date;
    const result = { state, fired: [], catchup: [], interlude: null, log: [] };

    if (oldDate === newDate) return result;

    // 已被一次生成看到过的补发项，在下一次推进时清除。
    state.catchup = (state.catchup || []).filter(c => !c.seen);

    if (!oldDate) {
        for (const e of eventsBetween(pack, null, newDate)) {
            if (toDayNumber(e.date) >= toDayNumber(newDate)) continue;
            state.fired[e.id] = e.date;
            // 开局前的历史事件不补发新闻，但它们设置的旗标仍然生效。
            if (evaluateCondition(e.if, conditionContext(pack, state, e.date, present))) {
                for (const f of e.set_flags || []) state.flags[f] = true;
            }
        }
        // 开局当天的事件正常触发。
        for (const e of pack.events.filter(x => x.date === newDate)) fire(e);
    } else if (toDayNumber(newDate) > toDayNumber(oldDate)) {
        for (const e of eventsBetween(pack, oldDate, newDate)) fire(e);
    } else {
        for (const [id, d] of Object.entries(state.fired)) {
            if (toDayNumber(d) > toDayNumber(newDate)) {
                delete state.fired[id];
                if (state.onceSeen) delete state.onceSeen[id];
            }
        }
        state.catchup = state.catchup.filter(c => state.fired[c.id]);
        result.log.push(`时间回拨至 ${newDate}`);
    }

    state.date = newDate;
    if (state.interlude && state.interlude.date !== newDate) state.interlude = null;

    if (!oldDate || toDayNumber(newDate) > toDayNumber(oldDate)) {
        const drawn = maybeDrawInterlude(pack, state, newDate, rng, present);
        if (drawn) {
            state.interlude = { id: drawn.id, date: newDate };
            state.interludeLast[drawn.id] = newDate;
            result.interlude = drawn.id;
        }
    }

    for (const text of result.log) state.log.push({ date: newDate, text });
    if (state.log.length > 200) state.log = state.log.slice(-200);
    return result;

    function fire(e) {
        if (state.fired[e.id]) return;
        const ctx = conditionContext(pack, state, e.date, present);
        state.fired[e.id] = e.date;
        if (!evaluateCondition(e.if, ctx)) {
            result.log.push(`事件「${e.title}」条件不满足，跳过`);
            return;
        }
        result.fired.push(e.id);
        for (const f of e.set_flags || []) state.flags[f] = true;
        result.log.push(`事件发生：${e.title}（${e.date}）`);
        // 新日期已过余波期 → 补发一次，保证不漏。
        if (eventStatus(e, newDate) === 'past') {
            state.catchup.push({ id: e.id, since: oldDate, seen: false });
            result.catchup.push(e.id);
        }
    }
}

/**
 * 日期变动大到像是写错了吗？是的话返回 { back, days, events }，否则返回 null。
 * 第一次设定日期不算。往前跳超过 max_jump_days 天（0 = 不限）或一次越过 8 件以上事件、往回跳超过 7 天都算。
 */
export function checkDateJump(pack, state, newDate) {
    const to = normalizeDate(newDate);
    if (!to || !isValidDate(state.date)) return null;
    const days = diffDays(state.date, to);
    if (days < 0) return days < -7 ? { back: true, days: -days, events: 0 } : null;
    const events = eventsBetween(pack, state.date, to).length;
    const limit = pack.meta.max_jump_days ?? 180;
    return (limit > 0 && days > limit) || events >= 8 ? { back: false, days, events } : null;
}

/** AI 已经就这些“只提醒一次”的事件回复过了。纯函数。 */
export function markOnceSeen(prevState, ids) {
    if (!ids?.length) return prevState;
    const state = JSON.parse(JSON.stringify(prevState));
    state.onceSeen = state.onceSeen || {};
    for (const id of ids) state.onceSeen[id] = true;
    return state;
}

/** 本次生成已看到补发内容：下次推进时将其清除。 */
export function markCatchupSeen(state) {
    for (const c of state.catchup || []) c.seen = true;
    return state;
}

// ---------- 插曲 ----------

export function eligibleInterludes(pack, state, date, present = []) {
    const ctx = conditionContext(pack, state, date, present);
    return pack.interludes.filter(i => {
        if (!i.text || i.weight <= 0) return false;
        if (!inRange(date, i.window[0] || null, i.window[1] || null)) return false;
        const last = state.interludeLast?.[i.id];
        if (last && diffDays(last, date) < Math.max(1, i.cooldown_days)) return false;
        return evaluateCondition(i.if, ctx);
    });
}

/** 按权重抽一个；无候选返回 null。 */
export function weightedPick(items, rng = Math.random) {
    const total = items.reduce((s, i) => s + i.weight, 0);
    if (total <= 0) return null;
    let r = rng() * total;
    for (const i of items) {
        r -= i.weight;
        if (r < 0) return i;
    }
    return items[items.length - 1];
}

/**
 * 推进后是否抽插曲：距上次抽取满 every_days 天（0 = 每次推进都抽），再按 chance 概率抽。
 * 修改 state.lastInterludeDraw。
 */
export function maybeDrawInterlude(pack, state, date, rng = Math.random, present = []) {
    const cfg = pack.meta.interlude || { every_days: 3, chance: 0.7 };
    if (state.lastInterludeDraw && cfg.every_days > 0 && diffDays(state.lastInterludeDraw, date) < cfg.every_days) return null;
    const pool = eligibleInterludes(pack, state, date, present);
    if (!pool.length) return null;
    state.lastInterludeDraw = date;
    if (rng() >= cfg.chance) return null;
    return weightedPick(pool, rng);
}
