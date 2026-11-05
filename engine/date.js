// 日期工具：内部统一使用 'YYYY-MM-DD' 字符串，计算时转换为“日序号”（自 1970-01-01 起的天数）。
// 采用 Howard Hinnant 的公历算法，支持任意年份（含公元前，年份写作 -0200 之类），不依赖 Date 的时区行为。

const DATE_RE = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})$/;

export function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y, m) {
    return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** 解析 'YYYY-MM-DD'（宽松：允许 1997-7-2），非法返回 null。 */
export function parseDate(str) {
    if (typeof str !== 'string') return null;
    const m = DATE_RE.exec(str.trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12) return null;
    if (d < 1 || d > daysInMonth(y, mo)) return null;
    return { y, m: mo, d };
}

export function isValidDate(str) {
    return parseDate(str) !== null;
}

function pad(n, len = 2) {
    const s = String(Math.abs(n)).padStart(len, '0');
    return n < 0 ? '-' + s : s;
}

/** 规范化为 'YYYY-MM-DD'；非法返回 null。 */
export function normalizeDate(str) {
    const p = parseDate(str);
    return p ? `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}` : null;
}

export function toDayNumber(str) {
    const p = parseDate(str);
    if (!p) throw new Error(`非法日期: ${str}`);
    let { y } = p;
    const { m, d } = p;
    y -= m <= 2 ? 1 : 0;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

export function fromDayNumber(z) {
    z += 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp + (mp < 10 ? 3 : -9);
    const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function addDays(str, n) {
    return fromDayNumber(toDayNumber(str) + n);
}

/** b - a，单位：天 */
export function diffDays(a, b) {
    return toDayNumber(b) - toDayNumber(a);
}

export function compareDates(a, b) {
    return toDayNumber(a) - toDayNumber(b);
}

/** 闭区间判断 from <= date <= to；from/to 可为空表示不限。 */
export function inRange(date, from, to) {
    const n = toDayNumber(date);
    if (from && n < toDayNumber(from)) return false;
    if (to && n > toDayNumber(to)) return false;
    return true;
}

/** 星期：0=周日 */
export function weekday(str) {
    const n = toDayNumber(str);
    return ((n % 7) + 7 + 4) % 7; // 1970-01-01 是周四
}

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];
const DIGITS_CN = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 汉字数字：年份逐位（一九九七），月日按读法（十二、二十一）。 */
export function digitsToChinese(n) {
    return String(n).split('').map(c => DIGITS_CN[Number(c)] ?? c).join('');
}

export function numberToChinese(n) {
    if (n <= 0 || n >= 100) return digitsToChinese(n);
    if (n < 10) return DIGITS_CN[n];
    const t = Math.floor(n / 10);
    const o = n % 10;
    return (t === 1 ? '' : DIGITS_CN[t]) + '十' + (o ? DIGITS_CN[o] : '');
}

// ---------- 法国共和历 ----------
// 共和历元年始于 1792-09-22；每年 12 个月×30 天，年末 5 天（闰年 6 天）补充日（无套裤汉日）。
// 每年的元旦按巴黎秋分定，没有简单公式，所以直接列出实际使用过的 I–XIV 年（1805-12-31 废止）的元旦。
// 第三、七、十一年为闰年（366 天），由相邻两个元旦之差自然得出。
const REPUBLICAN_NEW_YEAR = [
    '1792-09-22', '1793-09-22', '1794-09-22', '1795-09-23', '1796-09-22', '1797-09-22', '1798-09-22',
    '1799-09-23', '1800-09-23', '1801-09-23', '1802-09-23', '1803-09-24', '1804-09-23', '1805-09-23',
];
const REPUBLICAN_END = '1805-12-31';
export const REPUBLICAN_MONTHS = ['葡月', '雾月', '霜月', '雪月', '雨月', '风月', '芽月', '花月', '牧月', '获月', '热月', '果月'];
export const REPUBLICAN_MONTHS_FR = ['Vendémiaire', 'Brumaire', 'Frimaire', 'Nivôse', 'Pluviôse', 'Ventôse', 'Germinal', 'Floréal', 'Prairial', 'Messidor', 'Thermidor', 'Fructidor'];
const SANSCULOTTIDES = '无套裤汉日';

/**
 * 公历 → 共和历：{ y, m, d }，m 为 1–12，补充日 m = 13（d 为 1–6）。
 * 只覆盖共和历实际使用的时段（1792-09-22 至 1805-12-31），范围外返回 null。
 */
export function toRepublican(str) {
    if (!isValidDate(str)) return null;
    const n = toDayNumber(str);
    if (n < toDayNumber(REPUBLICAN_NEW_YEAR[0]) || n > toDayNumber(REPUBLICAN_END)) return null;
    let y = REPUBLICAN_NEW_YEAR.length;
    while (toDayNumber(REPUBLICAN_NEW_YEAR[y - 1]) > n) y--;
    const doy = n - toDayNumber(REPUBLICAN_NEW_YEAR[y - 1]);
    return { y, m: Math.floor(doy / 30) + 1, d: (doy % 30) + 1 };
}

/** 共和历 → 公历 'YYYY-MM-DD'；不存在的日子（如非闰年的第 6 个补充日）返回 null。 */
export function fromRepublican(y, m, d) {
    if (!(y >= 1 && y <= REPUBLICAN_NEW_YEAR.length) || !(m >= 1 && m <= 13) || !(d >= 1 && d <= 30)) return null;
    const date = addDays(REPUBLICAN_NEW_YEAR[y - 1], (m - 1) * 30 + d - 1);
    const r = toRepublican(date);
    return r && r.y === y && r.m === m && r.d === d ? date : null;
}

/** 罗马数字（共和历年份习惯写法，如 an II） */
function roman(n) {
    const t = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let s = '';
    for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
    return s;
}

/**
 * 按格式显示日期。
 * 支持的占位符：
 *   {y} 年  {m} 月  {d} 日  {mm}/{dd} 补零  {w} 星期（汉字）
 *   {cy} 年（汉字逐位）  {cm} {cd} 月日（汉字）
 *   {era} 年号名  {ey} 年号年数  {cey} 年号年数（汉字，元年写“元”）
 *   共和历：{ry} 年（2）{cry} 年（汉字，二）{rry} 年（罗马数字，II）{rm} 月名（热月；补充日为“无套裤汉日”）
 *           {rmf} 法文月名（Thermidor）{rd} 日（7）{crd} 日（汉字，七）；1792-09-22 至 1805-12-31 之外为空
 * 年号由 eras 提供：[{ name: '民国', from: '1912-01-01' }]，取 from <= date 的最后一个。
 */
export function formatDate(str, format = '{y}年{m}月{d}日', eras = []) {
    const p = parseDate(str);
    if (!p) return String(str ?? '');
    let era = null;
    if (Array.isArray(eras) && eras.length) {
        const n = toDayNumber(str);
        const sorted = eras.filter(e => isValidDate(e.from)).sort((a, b) => compareDates(a.from, b.from));
        for (const e of sorted) {
            if (toDayNumber(e.from) <= n) era = e;
        }
    }
    const ey = era ? p.y - parseDate(era.from).y + 1 : p.y;
    const r = toRepublican(str);
    const map = {
        y: String(p.y),
        m: String(p.m),
        d: String(p.d),
        mm: pad(p.m),
        dd: pad(p.d),
        w: WEEKDAY_CN[weekday(str)],
        cy: digitsToChinese(p.y),
        cm: numberToChinese(p.m),
        cd: numberToChinese(p.d),
        era: era ? era.name : '',
        ey: String(ey),
        cey: ey === 1 ? '元' : numberToChinese(ey),
        ry: r ? String(r.y) : '',
        cry: r ? numberToChinese(r.y) : '',
        rry: r ? roman(r.y) : '',
        rm: r ? (r.m === 13 ? SANSCULOTTIDES : REPUBLICAN_MONTHS[r.m - 1]) : '',
        rmf: r ? (r.m === 13 ? 'Sans-culottides' : REPUBLICAN_MONTHS_FR[r.m - 1]) : '',
        rd: r ? String(r.d) : '',
        crd: r ? numberToChinese(r.d) : '',
    };
    return String(format || '{y}-{mm}-{dd}').replace(/\{(\w+)\}/g, (all, key) => (key in map ? map[key] : all));
}

/**
 * 倒计时：返回 [{ label, date, days }]，days = 目标日 - 今天。
 * 默认只返回尚未到达（days >= 0）的目标。
 */
export function computeCountdowns(countdowns, today, { includePast = false } = {}) {
    if (!Array.isArray(countdowns) || !isValidDate(today)) return [];
    return countdowns
        .filter(c => c && isValidDate(c.date))
        .map(c => ({ label: c.label || c.date, date: normalizeDate(c.date), days: diffDays(today, c.date) }))
        .filter(c => includePast || c.days >= 0);
}

export function describeCountdown(c) {
    if (c.days > 0) return `${c.label}还有 ${c.days} 天`;
    if (c.days === 0) return `${c.label}：就是今天`;
    return `${c.label}已过去 ${-c.days} 天`;
}
