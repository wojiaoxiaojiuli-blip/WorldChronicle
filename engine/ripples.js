// 抉择记录与涟漪：一条抉择沿关系边（双向）给相关角色生成“牵连”提示。
import { getCharacter, resolveCharacterId, resolveEventId } from './pack.js';
import { diffDays, isValidDate } from './date.js';

function fill(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all));
}

/**
 * 根据一条抉择生成涟漪。choice = { who, event, choice, date }（who/event 为 id）。
 * 事件 affects 中该角色（或其标签）若写了 ripple 模板，则优先使用；
 * 模板可用 {who} {target} {choice} {type} {note} {event}。
 */
export function generateRipples(pack, choice) {
    const who = getCharacter(pack, choice.who);
    if (!who) return [];
    const event = pack.events.find(e => e.id === choice.event);
    const eventTitle = event ? event.title : choice.event;
    let template = '';
    if (event) {
        const keys = [who.id, ...who.tags];
        for (const k of keys) {
            if (event.affects[k]?.ripple) { template = event.affects[k].ripple; break; }
        }
    }
    const out = [];
    for (const r of pack.relations) {
        let targetId = null;
        let edge = '';
        if (r.from === who.id) { targetId = r.to; edge = `${who.name} —${r.type}→ ${nameOf(pack, r.to)}`; }
        else if (r.to === who.id) { targetId = r.from; edge = `${nameOf(pack, r.from)} —${r.type}→ ${who.name}`; }
        if (!targetId || targetId === who.id) continue;
        const target = nameOf(pack, targetId);
        const vars = { who: who.name, target, choice: choice.choice, type: r.type, note: r.note, event: eventTitle };
        const text = template
            ? fill(template, vars)
            : `${who.name}在「${eventTitle}」中的选择是：${choice.choice}。两人的关系：${edge}${r.note ? `（${r.note}）` : ''}。这可能牵连到${target}。`;
        out.push({ to: targetId, from: who.id, event: choice.event, choice: choice.choice, type: r.type, note: r.note, text, date: choice.date });
    }
    return out;
}

function nameOf(pack, id) {
    return getCharacter(pack, id)?.name || id;
}

/**
 * 记录一条抉择（同一角色同一事件只保留最新一条），并重算该抉择的涟漪。返回新 state。
 * who / event 可以是名字/别名/标题，会被解析成 id；无法解析的角色仍记录（以原文作 id）。
 */
export function recordChoice(pack, prevState, { who, event, choice, date }) {
    const state = JSON.parse(JSON.stringify(prevState));
    const whoId = resolveCharacterId(pack, who) || String(who || '').trim();
    const eventId = resolveEventId(pack, event) || String(event || '').trim();
    const text = String(choice || '').trim();
    if (!whoId || !text) return state;
    const d = date || state.date;
    state.choices = state.choices.filter(c => !(c.who === whoId && c.event === eventId));
    state.choices.push({ who: whoId, event: eventId, choice: text, date: d });
    state.ripples = state.ripples.filter(r => !(r.from === whoId && r.event === eventId));
    state.ripples.push(...generateRipples(pack, { who: whoId, event: eventId, choice: text, date: d }));
    state.log.push({ date: d, text: `记录抉择：${nameOf(pack, whoId)} / ${eventId}：${text}` });
    return state;
}

export function removeChoice(prevState, who, event) {
    const state = JSON.parse(JSON.stringify(prevState));
    state.choices = state.choices.filter(c => !(c.who === who && c.event === event));
    state.ripples = state.ripples.filter(r => !(r.from === who && r.event === event));
    return state;
}

/** 某角色当前有效的涟漪：抉择日期之后 ripple_days 天内（0 = 永久）。 */
export function activeRipplesFor(pack, state, charId, date) {
    const days = pack.meta.ripple_days ?? 30;
    return (state.ripples || []).filter(r => {
        if (r.to !== charId) return false;
        if (!isValidDate(r.date) || !isValidDate(date)) return true;
        const d = diffDays(r.date, date);
        return d >= 0 && (days === 0 || d <= days);
    });
}
