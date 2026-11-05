// 玩家日历：给玩家看的只读视图（当前日期、即将发生的事件、月历标记）。
// 防剧透只在这里生效（事件的 visibility + 玩家的“显示未来事件”开关）；注入给 AI 的内容不受影响，AI 永远看不到未到期事件。
import { formatDate, computeCountdowns, describeCountdown, diffDays, isValidDate, toDayNumber, parseDate } from './date.js';
import { evaluateCondition } from './conditions.js';
import { getPhase, conditionContext, resolveEvent } from './schedule.js';

/**
 * 一个事件在玩家日历里的样子；不该显示时返回 null。
 * 已发生的事件总是显示标题（新闻已经播过了）；未发生的按 visibility 与 showFuture 处理。
 */
export function playerEventView(pack, state, event, { showFuture = true, ref } = {}) {
    if (!event.date) return null;
    const today = ref ?? state?.date ?? pack.meta.start ?? null;
    const happened = !!state?.fired?.[event.id] || (isValidDate(today) && toDayNumber(event.date) <= toDayNumber(today));
    const ctx = conditionContext(pack, state || {}, today && isValidDate(today) ? today : event.date);
    if (!evaluateCondition(event.if, ctx)) return null;
    const e = resolveEvent(event, ctx);
    const base = {
        id: e.id,
        date: e.date,
        dateText: formatDate(e.date, pack.meta.display, pack.meta.eras),
        inDays: isValidDate(today) ? diffDays(today, e.date) : null,
        happened,
    };
    if (happened) return { ...base, title: e.title, text: e.summary || e.news || '' };
    if (!showFuture) return null;
    const vis = event.visibility || 'show';
    if (vis === 'hidden') return null;
    if (vis === 'title_only') return { ...base, title: e.title, text: '' };
    return { ...base, title: e.title, text: e.summary || e.news || '' };
}

/**
 * 玩家日历的全部数据。
 * @returns {{ date, dateText, phase, countdowns: string[], upcoming: object[], recent: object[], log: object[] }}
 */
export function playerCalendar(pack, state, { showFuture = true, upcomingLimit = 8, recentLimit = 5, logLimit = 8 } = {}) {
    const date = isValidDate(state?.date) ? state.date : null;
    const ref = date || (isValidDate(pack.meta.start) ? pack.meta.start : null);
    const phase = ref ? getPhase(pack, ref) : null;
    const views = pack.events
        .map(e => playerEventView(pack, state, e, { showFuture, ref }))
        .filter(Boolean);
    return {
        date,
        dateText: date ? formatDate(date, pack.meta.display, pack.meta.eras) : '',
        phase: phase ? { id: phase.id, name: phase.name || phase.id, mood: phase.mood } : null,
        countdowns: date ? computeCountdowns(pack.meta.countdowns, date).map(describeCountdown) : [],
        upcoming: views.filter(v => !v.happened).slice(0, upcomingLimit),
        recent: views.filter(v => v.happened).slice(-recentLimit).reverse(),
        log: (state?.log || []).slice(-logLimit).reverse(),
    };
}

/** 某个月里每天要标记的事件：{ 'YYYY-MM-DD': [view, …] } */
export function playerMonthEvents(pack, state, y, m, { showFuture = true } = {}) {
    const out = {};
    for (const e of pack.events) {
        const p = parseDate(e.date);
        if (!p || p.y !== y || p.m !== m) continue;
        const v = playerEventView(pack, state, e, { showFuture });
        if (v) (out[e.date] ||= []).push(v);
    }
    return out;
}
