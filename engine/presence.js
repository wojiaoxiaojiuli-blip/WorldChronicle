// 在场判定：最近 N 条消息（含发言人名字）中出现角色名或别名；手动勾选可强制在场/不在场。

/**
 * @param {object} pack
 * @param {{name?: string, mes?: string, is_system?: boolean}[]} messages 按时间顺序
 * @param {object} [opts]
 * @param {number} [opts.lastN=4]
 * @param {Object<string, boolean>} [opts.manual] charId -> true/false
 * @param {string[]} [opts.always] 始终在场的角色 id（如当前卡本身对应的角色）
 * @returns {string[]} 在场角色 id
 */
export function detectPresent(pack, messages, { lastN = 4, manual = {}, always = [] } = {}) {
    const recent = (messages || []).filter(m => m && !m.is_system).slice(-Math.max(0, lastN));
    const haystack = recent.map(m => `${m.name || ''}\n${stripTags(m.mes || '')}`).join('\n');
    const present = new Set();
    for (const c of pack.characters) {
        const names = [c.name, ...(c.aliases || [])].filter(n => n && n.length > 0);
        if (names.some(n => haystack.includes(n))) present.add(c.id);
    }
    for (const id of always) if (id) present.add(id);
    for (const [id, v] of Object.entries(manual || {})) {
        if (v === true) present.add(id);
        if (v === false) present.delete(id);
    }
    return pack.characters.map(c => c.id).filter(id => present.has(id));
}

function stripTags(text) {
    return String(text).replace(/<(time|choice)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}
