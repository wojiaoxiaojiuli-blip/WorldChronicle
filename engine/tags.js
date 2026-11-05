// 解析与隐藏 AI 回复中的 <time> / <choice> / <bgm> 标签。
import { normalizeDate } from './date.js';

const TIME_RE = /<time\b[^>]*>([\s\S]*?)<\/time>/gi;
const CHOICE_RE = /<choice\b([^>]*)>([\s\S]*?)<\/choice>/gi;
const BGM_RE = /<bgm\b[^>]*>([\s\S]*?)<\/bgm>/gi;
const FLAG_RE = /<flag\b[^>]*>([\s\S]*?)<\/flag>/gi;
// 兼容被转义成 &lt;time&gt; 的情形（ST 打开“编码标签”时）。
const ESC_TIME_RE = /&lt;time\b[\s\S]*?&gt;[\s\S]*?&lt;\/time&gt;/gi;
const ESC_CHOICE_RE = /&lt;choice\b[\s\S]*?&gt;[\s\S]*?&lt;\/choice&gt;/gi;
const ESC_BGM_RE = /&lt;bgm\b[\s\S]*?&gt;[\s\S]*?&lt;\/bgm&gt;/gi;
const ESC_FLAG_RE = /&lt;flag\b[\s\S]*?&gt;[\s\S]*?&lt;\/flag&gt;/gi;

/** 消息里是否带有本扩展的标签（用于决定是否需要重新渲染）。 */
export const ANY_TAG_RE = /<(time|choice|bgm|flag)\b/i;

function parseAttrs(s) {
    const attrs = {};
    const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim();
    return attrs;
}

/** 从文字中提取 YYYY-MM-DD（容许 1997-7-2、1997/7/2、1997年7月2日）。 */
export function extractDate(text) {
    const s = String(text || '');
    const m = /(-?\d{1,6})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(s);
    if (!m) return null;
    return normalizeDate(`${m[1]}-${m[2]}-${m[3]}`);
}

/**
 * 解析消息。返回 { time: 'YYYY-MM-DD'|null, choices: [{ who, event, choice }], bgm: string|null, flags: string[] }。
 * 多个 <time> / <bgm> 时取最后一个。
 */
export function parseTags(text) {
    const s = String(text || '');
    let time = null;
    for (const m of s.matchAll(TIME_RE)) {
        const d = extractDate(m[1]);
        if (d) time = d;
    }
    const choices = [];
    for (const m of s.matchAll(CHOICE_RE)) {
        const a = parseAttrs(m[1]);
        const choice = m[2].trim();
        const who = a.who || a.name || '';
        if (who && choice) choices.push({ who, event: a.event || '', choice });
    }
    let bgm = null;
    for (const m of s.matchAll(BGM_RE)) {
        if (m[1].trim()) bgm = m[1].trim();
    }
    const flags = [];
    for (const m of s.matchAll(FLAG_RE)) {
        if (m[1].trim()) flags.push(m[1].trim());
    }
    return { time, choices, bgm, flags };
}

/** 去掉标签（用于显示）。 */
export function stripTags(text) {
    return String(text ?? '')
        .replace(TIME_RE, '')
        .replace(CHOICE_RE, '')
        .replace(BGM_RE, '')
        .replace(FLAG_RE, '')
        .replace(ESC_TIME_RE, '')
        .replace(ESC_CHOICE_RE, '')
        .replace(ESC_BGM_RE, '')
        .replace(ESC_FLAG_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}
