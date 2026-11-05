// 玩家自己的音源：把“歌手 - 歌名”变成可播放的地址。按玩家排好的顺序逐个尝试，第一个找到的生效。
// 不依赖 DOM / SillyTavern（fetch、设置读写都由宿主传入），可以在 Node 里测试。
// 所有设置都在玩家本机的扩展设置里，绝不写进事件包或角色卡。
import { formatSong, pickBestMatch, songKey } from '../engine/music.js';

export const GD_API = 'https://music-api.gdstudio.xyz/api.php';
export const GD_SOURCES = [
    { value: 'netease', label: '网易云' },
    { value: 'joox', label: 'JOOX' },
    { value: 'bilibili', label: '哔哩哔哩' },
];
export const GD_ATTRIBUTION = '音源：GD音乐台(music.gdstudio.xyz)';
export const GD_DISCLAIMER = [
    'GD音乐台是别人（第三方）开的公开找歌服务，和这个插件没有关系。打开之前，请先看清楚这几件事：',
    '· 只限你个人学习使用。不能再分发（把歌转发、上传给别人），也不能用于任何商业用途；',
    '· 这些音乐来自第三方平台，版权归原来的权利人所有；',
    '· 打开以后，你的 IP 地址和你要找的歌名，会发送到 music-api.gdstudio.xyz；',
    '· 放歌的时候，屏幕上会一直显示“音源：GD音乐台(music.gdstudio.xyz)”。',
];

export const SOURCE_LABELS = {
    link: '作者贴的网址',
    gd: 'GD音乐台',
    notice: '只显示歌名',
};

/**
 * 这首歌按什么顺序找：作者贴的链接 → GD音乐台 → 只显示曲名。
 * GD音乐台要同时满足：作者的包用它（来源不是“贴链接”），且玩家自己同意开启。
 */
export function sourceOrder(packSource, gdEnabled) {
    return [
        { id: 'link', enabled: true },
        { id: 'gd', enabled: !!gdEnabled && packSource !== 'link' },
        { id: 'notice', enabled: true },
    ];
}

/** 网易云音乐网页版搜索链接（“只显示”时给玩家自己去听） */
export function neteaseSearchUrl(song) {
    return `https://music.163.com/#/search/m/?s=${encodeURIComponent(formatSong(song))}&type=1`;
}

// ---------------------------------------------------------------- 限流

/**
 * 滑动窗口计数器：windowMs 内最多 max 次；留出 reserve 次余量，接近上限就不再发请求。
 * GD音乐台的限制是 5 分钟 50 次。
 */
export function createRateLimiter({ max = 50, windowMs = 5 * 60 * 1000, reserve = 5, now = () => Date.now() } = {}) {
    let stamps = [];
    const prune = () => {
        const t = now();
        stamps = stamps.filter(x => t - x < windowMs);
    };
    return {
        /** 还能发就记一次并返回 true，否则返回 false */
        take() {
            prune();
            if (stamps.length >= max - reserve) return false;
            stamps.push(now());
            return true;
        },
        get used() { prune(); return stamps.length; },
        get remaining() { prune(); return Math.max(0, max - reserve - stamps.length); },
        reset() { stamps = []; },
    };
}

// ---------------------------------------------------------------- 各音源

/** 作者的链接：这首歌在包里带了 url 就直接用。 */
export function createLinkSource() {
    return {
        id: 'link',
        async resolve(song) {
            return song.url ? { url: song.url } : null;
        },
    };
}

/**
 * GD音乐台。搜索结果（歌名 → 平台曲目 id）可以长期缓存在设置里；
 * 播放地址带时间戳会过期，只在内存里缓存约 10 分钟，从不保存。
 *
 * @param {object} o
 * @param {Function} o.fetch                 fetch 实现
 * @param {() => string} o.getSource         netease / joox / bilibili
 * @param {object} o.searchCache             可持久化的对象：key → { id, source, name, artist }
 * @param {Function} [o.onCacheChange]       搜索缓存变化时调用（宿主保存设置）
 * @param {object} [o.limiter]
 * @param {Function} [o.now]
 */
export function createGdSource({ fetch, getSource = () => 'netease', searchCache = {}, onCacheChange = () => {}, limiter = createRateLimiter(), now = () => Date.now(), urlTtlMs = 10 * 60 * 1000, errorCooldownMs = 60 * 1000, api = GD_API }) {
    const urlCache = new Map(); // `${source}:${id}` → { url, at }
    let pausedUntil = 0;

    async function call(params) {
        if (now() < pausedUntil) throw new Error('GD音乐台暂停使用（刚才出错）');
        if (!limiter.take()) throw new Error('GD音乐台请求过于频繁，暂时不再请求');
        const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        try {
            const res = await fetch(`${api}?${qs}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            pausedUntil = now() + errorCooldownMs;
            throw e;
        }
    }

    async function search(song, source) {
        const key = `${source}:${songKey(song)}`;
        if (searchCache[key]) return searchCache[key];
        const hits = await call({ types: 'search', source, name: formatSong(song).replace(/ - /, ' '), count: 5 });
        const best = pickBestMatch(song, Array.isArray(hits) ? hits : [], 0.5);
        if (!best) return null;
        const entry = {
            id: String(best.id),
            source: best.source || source,
            name: String(best.name || ''),
            artist: Array.isArray(best.artist) ? best.artist.join(' / ') : String(best.artist || ''),
        };
        searchCache[key] = entry;
        onCacheChange(searchCache);
        return entry;
    }

    return {
        id: 'gd',
        attribution: GD_ATTRIBUTION,
        async resolve(song) {
            const source = getSource() || 'netease';
            const hit = await search(song, source);
            if (!hit) return null;
            const ck = `${hit.source}:${hit.id}`;
            const cached = urlCache.get(ck);
            if (cached && now() - cached.at < urlTtlMs) return { url: cached.url, attribution: GD_ATTRIBUTION, matched: hit };
            const r = await call({ types: 'url', source: hit.source, id: hit.id, br: 320 });
            if (!r?.url) return null;
            urlCache.set(ck, { url: r.url, at: now() });
            return { url: r.url, attribution: GD_ATTRIBUTION, matched: hit };
        },
        /** 播放失败时丢掉这首的地址缓存，下次重新取 */
        forget(song) {
            const hit = searchCache[`${getSource() || 'netease'}:${songKey(song)}`];
            if (hit) urlCache.delete(`${hit.source}:${hit.id}`);
        },
        get limiter() { return limiter; },
    };
}

/** 只显示：什么都不播，告诉玩家此刻的配乐是哪首，并给出网易云搜索链接。 */
export function createNoticeSource() {
    return {
        id: 'notice',
        async resolve(song) {
            return { notice: true, searchUrl: neteaseSearchUrl(song) };
        },
    };
}

// ---------------------------------------------------------------- 解析链

/**
 * 按顺序尝试已启用的音源，返回第一个结果 { sourceId, url?, notice?, attribution?, searchUrl? }；都没有返回 null。
 * 某个音源出错（网络、限流）就跳过它，继续下一个。
 *
 * @param {{ id: string, enabled: boolean }[]} order  玩家排好的顺序
 * @param {Record<string, { resolve(song): Promise<object|null> }>} sources
 * @param {object} song  { title, artist, url? }
 * @param {(id: string, err: any) => void} [onError]
 */
export async function resolveSong(order, sources, song, onError = () => {}) {
    if (!song?.title) return null;
    for (const { id, enabled } of order || []) {
        if (!enabled || !sources[id]) continue;
        try {
            const r = await sources[id].resolve(song);
            if (r && (r.url || r.notice)) return { sourceId: id, ...r };
        } catch (e) {
            onError(id, e);
        }
    }
    return null;
}
