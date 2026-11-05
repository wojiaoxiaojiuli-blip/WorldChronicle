// 歌名工具：解析“歌手 - 歌名”、比对两首歌是否同一首。纯函数，曲目选择与玩家音源共用。

// 歌手与歌名之间的分隔：两侧有空格的半角连字符，或全角/长破折号（两侧空格可有可无）。
// “Jay-Z”“Bye-Bye”这类词内连字符不会被拆开。
const SEP_RE = /\s+[-–]\s+|\s*(?:[－—―]+|——)\s*/;

/**
 * 解析一行歌曲文本。支持：
 *   歌手 - 歌名
 *   歌名
 *   歌手 - 歌名 | 氛围      （“|”或“｜”后面是氛围描述，可选）
 * 返回 { title, artist, mood }；空行返回 null。
 */
export function parseSongLine(line) {
    let s = String(line ?? '').trim();
    if (!s) return null;
    let mood = '';
    const bar = s.search(/[|｜]/);
    if (bar >= 0) {
        mood = s.slice(bar + 1).trim();
        s = s.slice(0, bar).trim();
    }
    s = s.replace(/^[《「『"“]+|[》」』"”]+$/g, '').trim();
    let artist = '';
    let title = s;
    const m = SEP_RE.exec(s);
    if (m && m.index > 0) {
        artist = s.slice(0, m.index).trim();
        title = s.slice(m.index + m[0].length).trim();
    }
    title = title.replace(/^[《「『]+|[》」』]+$/g, '').trim();
    if (!title) return null;
    return { title, artist, mood };
}

const URL_RE = /^(https?:\/\/|assets\/|\/)\S+$/i;

/**
 * 解析作者粘贴的一行，比 parseSongLine 多认一个链接：
 *   歌手 - 歌名 | 链接 | 氛围
 *   歌名 | 氛围
 *   链接                  （只贴链接：用文件名当歌名）
 * 返回 { title, artist, mood, url }；空行返回 null。
 */
export function parseSongEntry(line) {
    const parts = String(line ?? '').split(/[|｜]/).map(x => x.trim());
    const urlAt = parts.findIndex(p => URL_RE.test(p));
    const url = urlAt >= 0 ? parts.splice(urlAt, 1)[0] : '';
    if (!parts.join('') && url) {
        const file = decodeURIComponentSafe(url.split(/[?#]/)[0].split('/').pop() || '');
        const song = parseSongLine(file.replace(/\.[a-z0-9]{2,5}$/i, '')) || { title: file || '未命名', artist: '', mood: '' };
        return { ...song, url };
    }
    const song = parseSongLine(parts.join(' | '));
    return song ? { ...song, url } : null;
}

function decodeURIComponentSafe(s) {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

// 这些网站给的是播放页面，不是音频文件，贴进来放不出声音
const WEBPAGE_HOSTS = /(^|\.)(music\.163\.com|163cn\.tv|y\.qq\.com|kugou\.com|kuwo\.cn|bilibili\.com|b23\.tv|youtube\.com|youtu\.be|spotify\.com|pan\.baidu\.com)$/i;

/** 检查作者贴的音频链接；看起来有问题时返回一句提示，否则返回空串。 */
export function audioLinkProblem(url) {
    const s = String(url ?? '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return '';
    let host = '';
    try {
        host = new URL(s).hostname;
    } catch {
        return '这个网址好像写得不对';
    }
    return WEBPAGE_HOSTS.test(host) ? '这是网页的网址，不是音频文件，放不出声音。要贴在浏览器里一打开就直接响的网址（常常以 .mp3 结尾）' : '';
}

/** 显示用：“歌手 - 歌名”或“歌名” */
export function formatSong(song) {
    if (!song) return '';
    const t = String(song.title || '').trim();
    const a = String(song.artist || '').trim();
    return a ? `${a} - ${t}` : t;
}

/** 比较用：去掉括号里的版本说明（Live / 粤语版 …）、标点、空白，统一大小写与全半角。 */
export function normalizeSongText(s) {
    return String(s ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[（(【\[][^)）】\]]*[)）】\]]/g, '')
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function looselyContains(a, b) {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= 2 && short.length * 2 >= long.length && long.includes(short);
}

function splitArtists(a) {
    const list = Array.isArray(a) ? a : String(a ?? '').split(/[、,，/&;；]|\s+feat\.?\s+|\s+ft\.?\s+/i);
    return list.map(normalizeSongText).filter(Boolean);
}

/**
 * want 与 cand 是否同一首歌，返回 0~1 的分数（0 = 不是）。
 * 歌名必须一致（规范化后相等记 1；一个包含另一个、且短的至少占长的一半时记 0.6）；双方都写了歌手而对不上时大幅降分（只写歌名的一方不限歌手）。
 * cand.artist 可以是字符串或数组（GD 音乐台返回数组）。
 */
export function scoreSongMatch(want, cand) {
    const wt = normalizeSongText(want?.title);
    const ct = normalizeSongText(cand?.title ?? cand?.name);
    if (!wt || !ct) return 0;
    let score;
    if (wt === ct) score = 1;
    else if (looselyContains(wt, ct)) score = 0.6;
    else return 0;
    const wa = splitArtists(want.artist);
    const ca = splitArtists(cand.artist);
    if (wa.length && ca.length) {
        const hit = wa.some(a => ca.some(c => c === a || looselyContains(a, c)));
        score = hit ? score : score * 0.3;
    }
    return score;
}

/** 从候选列表中挑最像的一首；最高分低于 min 时返回 null。同分取靠前的。 */
export function pickBestMatch(want, candidates, min = 0.5) {
    let best = null;
    let bestScore = 0;
    for (const c of candidates || []) {
        const s = scoreSongMatch(want, c);
        if (s > bestScore) {
            best = c;
            bestScore = s;
        }
    }
    return bestScore >= min ? best : null;
}

/** 同一首歌的稳定键（用于缓存 / 判断是否已在播放） */
export function songKey(song) {
    return `${normalizeSongText(song?.artist)}|${normalizeSongText(song?.title)}`;
}
