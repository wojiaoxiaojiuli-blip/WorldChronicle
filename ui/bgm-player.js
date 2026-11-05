// BGM 播放器：两个 <audio> 交替使用，切歌时淡入淡出。
// 浏览器会拦截“用户没碰过页面时的自动播放”，被拦截时回调 onBlocked，由宿主提示用户点一下。

const STEP_MS = 50;

export function createBgmPlayer({ onBlocked = () => {}, onChange = () => {}, onError = () => {} } = {}) {
    const decks = [new Audio(), new Audio()];
    decks.forEach(a => { a.preload = 'auto'; });
    let active = 0;
    let current = null;      // { id, name, url, loop, volume }
    let master = 0.5;
    let fadeMs = 1500;
    let pending = null;      // 被拦截、等待用户点击后播放的曲目
    let failed = false;      // 当前曲目加载/播放失败
    let gen = 0;             // 每次 play/stop 递增；异步的 play() 返回时据此判断自己是否已过时
    const timers = new Map();

    const deck = () => decks[active];
    const targetVol = (t) => Math.min(1, Math.max(0, master * (t?.volume ?? 1)));

    function fade(audio, to, ms, done) {
        clearInterval(timers.get(audio));
        const from = audio.volume;
        const steps = Math.max(1, Math.round(ms / STEP_MS));
        let i = 0;
        const timer = setInterval(() => {
            i++;
            audio.volume = Math.min(1, Math.max(0, from + (to - from) * (i / steps)));
            if (i >= steps) {
                clearInterval(timer);
                timers.delete(audio);
                done?.();
            }
        }, STEP_MS);
        timers.set(audio, timer);
    }

    function resolveUrl(url) {
        try {
            return new URL(url, location.href).href;
        } catch {
            return url;
        }
    }

    async function start(audio, track) {
        try {
            await audio.play();
            pending = null;
            return true;
        } catch (e) {
            if (e?.name === 'NotAllowedError') {
                pending = track;
                onBlocked(track);
            } else if (e?.name !== 'AbortError') { // AbortError = 播放途中被切歌/停止，不算错误
                console.warn('[世界编年史] BGM 播放失败', track.url, e);
                if (current === track) failed = true;
                onError(track, e);
                onChange(current);
            }
            return false;
        }
    }

    /** 播放曲目；与当前相同则什么都不做。 */
    async function play(track) {
        if (!track?.url) return;
        // 同一首正在播放、加载失败或等待用户点击：不重复尝试
        if (current?.id === track.id && current.url === track.url && (!deck().paused || failed || pending)) return;
        const my = ++gen;
        const old = deck();
        active = 1 - active;
        const next = deck();
        next.src = resolveUrl(track.url);
        next.loop = track.loop !== false;
        next.volume = 0;
        current = track;
        failed = false;
        onChange(current);
        if (!old.paused) fade(old, 0, fadeMs, () => { old.pause(); old.removeAttribute('src'); });
        else clearInterval(timers.get(old));
        const ok = await start(next, track);
        if (my !== gen) {
            // 等待期间又切了歌或停止了：这个音轨若仍归我们所有就静音掉，免得两首同时响
            if (ok && (next !== deck() || !current)) { clearInterval(timers.get(next)); next.pause(); }
            return;
        }
        if (ok) fade(next, targetVol(track), fadeMs);
    }

    function stop() {
        gen++;
        const a = deck();
        current = null;
        pending = null;
        failed = false;
        onChange(null);
        if (!a.paused) fade(a, 0, fadeMs, () => a.pause());
    }

    /** 用户点击后重试被拦截的播放 */
    async function resume() {
        const t = pending || current;
        if (!t) return;
        const a = deck();
        const my = ++gen;
        if (!a.src) a.src = resolveUrl(t.url);
        a.volume = 0;
        if (await start(a, t) && my === gen) fade(a, targetVol(t), fadeMs);
    }

    function setVolume(v) {
        master = Math.min(1, Math.max(0, Number(v) || 0));
        if (current && !deck().paused) {
            clearInterval(timers.get(deck()));
            deck().volume = targetVol(current);
        }
    }

    function setFade(ms) {
        fadeMs = Math.max(0, Number(ms) || 0);
    }

    return {
        play, stop, resume, setVolume, setFade,
        get current() { return current; },
        get blocked() { return !!pending; },
        get failed() { return failed; },
    };
}
