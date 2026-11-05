// 条件求值。
// 支持：{ flag: 'x' }、{ choice: { who, event, is? } }、{ phase: 'id' }、{ present: 'id' }、
//      { all: [...] }、{ any: [...] }、{ not: cond }。null/undefined/{} 视为恒真。
// ctx = { flags: {name: true}, choices: [{ who, event, choice }], phase: 'id'|null, present: ['id'] }

export function evaluateCondition(cond, ctx = {}) {
    if (cond === null || cond === undefined) return true;
    if (typeof cond !== 'object') return Boolean(cond);
    if (Array.isArray(cond)) return cond.every(c => evaluateCondition(c, ctx));

    const results = [];
    if ('flag' in cond) {
        const flags = ctx.flags || {};
        results.push(Boolean(flags[cond.flag]));
    }
    if ('choice' in cond) {
        const q = cond.choice || {};
        const list = Array.isArray(ctx.choices) ? ctx.choices : [];
        results.push(list.some(c =>
            (!q.who || c.who === q.who)
            && (!q.event || c.event === q.event)
            && (!q.is || String(c.choice || '').includes(String(q.is)))));
    }
    if ('phase' in cond) {
        results.push(ctx.phase === cond.phase);
    }
    if ('present' in cond) {
        results.push(Array.isArray(ctx.present) && ctx.present.includes(cond.present));
    }
    if ('all' in cond) {
        results.push((Array.isArray(cond.all) ? cond.all : []).every(c => evaluateCondition(c, ctx)));
    }
    if ('any' in cond) {
        results.push((Array.isArray(cond.any) ? cond.any : []).some(c => evaluateCondition(c, ctx)));
    }
    if ('not' in cond) {
        results.push(!evaluateCondition(cond.not, ctx));
    }
    // 同一对象里写了多个键时按“全部满足”处理；空对象恒真。
    return results.every(Boolean);
}

/** 把条件转成一句中文，用于编辑器显示。 */
export function describeCondition(cond) {
    if (!cond || typeof cond !== 'object' || !Object.keys(cond).length) return '无条件';
    const parts = [];
    if ('flag' in cond) parts.push(`旗标「${cond.flag}」已设置`);
    if ('choice' in cond) {
        const q = cond.choice || {};
        parts.push(`${q.who || '任何人'}在${q.event || '任意事件'}中${q.is ? `选择了含「${q.is}」的选项` : '已作出选择'}`);
    }
    if ('phase' in cond) parts.push(`处于阶段「${cond.phase}」`);
    if ('present' in cond) parts.push(`${cond.present}在场`);
    if ('all' in cond) parts.push(`全部满足(${(cond.all || []).map(describeCondition).join('；')})`);
    if ('any' in cond) parts.push(`任一满足(${(cond.any || []).map(describeCondition).join('；')})`);
    if ('not' in cond) parts.push(`并非(${describeCondition(cond.not)})`);
    return parts.join(' 且 ');
}
