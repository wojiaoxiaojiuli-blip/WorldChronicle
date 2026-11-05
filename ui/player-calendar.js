// 玩家日历：只读弹窗（故事日期、阶段、倒计时、月历、即将发生的事件、近期记录、此刻配乐）。
// 期刊也住在这个弹窗里：上方切换“日历 / 期刊”；期刊总开关关着时，只有日历。
// 入口：扩展菜单（魔杖）里的一项，以及输入框左侧的日历图标（可在设置里关掉）。“新刊”小红点挂在这两个入口上。
// 防剧透只在这里生效；注入给 AI 的内容不受影响。
import { mountPeriodicalReader } from './periodical-reader.js';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'checked') el.checked = !!v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

function toggle(label, checked, onChange) {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'checkbox_label' }, input, label);
}

function inDaysText(n) {
    if (n === null || n === undefined) return '';
    if (n === 0) return '今天';
    if (n > 0) return `${n} 天后`;
    return `${-n} 天前`;
}

function eventItem(v) {
    return h('div', { class: 'wc_pcal_event' + (v.happened ? ' happened' : '') },
        h('div', { class: 'wc_pcal_event_head' },
            h('span', { class: 'wc_pcal_event_date' }, v.dateText),
            h('b', {}, v.title),
            v.inDays !== null ? h('span', { class: 'wc_pcal_badge' }, inDaysText(v.inDays)) : null,
        ),
        v.text ? h('div', { class: 'wc_pcal_event_text' }, v.text) : null,
    );
}

/** 把月历画进 container。opts.openPaper(pid, date)：点出刊日的小报图标时调用。返回 { render }。 */
function mountCalendar(host, container, opts = {}) {
    const E = host.engine;
    const root = h('div', { class: 'wc_pcal' });
    container.append(root);
    const openPaper = opts.openPaper || (() => {});
    let view = null;          // { y, m }
    let selected = null;      // 'YYYY-MM-DD'

    function render() {
        root.innerHTML = '';
        const pack = host.pack();
        const state = pack ? host.state() : null;
        if (!pack || !state) {
            root.append(h('h3', {}, '玩家日历'), h('div', { class: 'wc_dim' }, '这个聊天还没选剧本。去扩展面板的「世界编年史」里，在“使用的剧本”中选一个就好。'));
            return;
        }
        const showFuture = host.showFuture();
        const cal = E.playerCalendar(pack, state, { showFuture });
        if (!view) {
            const anchor = E.parseDate(cal.date || pack.meta.start || pack.events[0]?.date || '');
            view = anchor ? { y: anchor.y, m: anchor.m } : { y: 2000, m: 1 };
        }

        // 头部：日期 / 阶段 / 倒计时
        root.append(h('div', { class: 'wc_pcal_head' },
            h('div', { class: 'wc_dim' }, pack.meta.name),
            h('div', { class: 'wc_pcal_date' }, cal.dateText || '故事里还没有日期。等 AI 第一次写出日期，这里就会显示。'),
            cal.phase ? h('div', { class: 'wc_pcal_phase' }, `时代气氛：${cal.phase.name}`) : null,
            cal.countdowns.length ? h('div', { class: 'wc_pcal_countdowns' }, cal.countdowns.map(c => h('span', { class: 'wc_pcal_chip' }, c))) : null,
        ));

        // 配乐与开关
        const bgm = host.bgmText();
        root.append(h('div', { class: 'wc_pcal_bar' },
            h('div', { class: 'wc_pcal_bgm' }, h('i', { class: 'fa-solid fa-music' }), ' ', host.bgmEnabled() ? (bgm || '（现在没放歌）') : '背景音乐已关'),
            h('div', { class: 'wc_pcal_toggles' },
                toggle('背景音乐', host.bgmEnabled(), (v) => { host.setBgmEnabled(v); setTimeout(render, 50); }),
                toggle('显示未来事件', showFuture, (v) => { host.setShowFuture(v); render(); }),
            ),
        ));

        // 月历
        const month = E.playerMonthEvents(pack, state, view.y, view.m, { showFuture });
        const shift = (n) => {
            const idx = view.y * 12 + (view.m - 1) + n;
            view = { y: Math.floor(idx / 12), m: ((idx % 12) + 12) % 12 + 1 };
            selected = null;
            render();
        };
        const periodicals = host.periodicals?.() || [];
        const papersOn = (date) => periodicals.filter(p => E.isIssueDay(p, date));
        const grid = h('div', { class: 'wc_pcal_grid' }, WEEK.map(w => h('div', { class: 'wc_pcal_wd' }, w)));
        const first = `${String(view.y).padStart(4, '0')}-${String(view.m).padStart(2, '0')}-01`;
        if (E.isValidDate(first)) {
            for (let i = 0; i < E.weekday(first); i++) grid.append(h('div', { class: 'wc_pcal_day empty' }));
            for (let d = 1; d <= E.daysInMonth(view.y, view.m); d++) {
                const date = `${first.slice(0, -2)}${String(d).padStart(2, '0')}`;
                const evs = month[date] || [];
                const past = cal.date && E.compareDates(date, cal.date) < 0;
                // 出刊日的小报图标：今天及以前的点开就能看；以后的只显示，不能提前看
                const papers = papersOn(date);
                const later = !cal.date || E.compareDates(date, cal.date) > 0;
                const paperIcons = papers.map(p => h('span', {
                    class: 'wc_pcal_paper fa-solid fa-newspaper' + (later ? ' later' : ' open'),
                    title: later ? `《${p.name}》这天出刊，到了那天才能看` : `《${p.name}》这天出刊，点一下就能看`,
                    onclick: later ? null : (ev) => { ev.stopPropagation(); openPaper(p.id, date); },
                }));
                grid.append(h('div', {
                    class: ['wc_pcal_day', date === cal.date && 'today', past && 'past', evs.length && 'has_event', selected === date && 'selected'].filter(Boolean).join(' '),
                    title: [...evs.map(v => v.title), ...papers.map(p => `《${p.name}》出刊`)].join('\n') || null,
                    onclick: () => { selected = selected === date ? null : date; render(); },
                }, h('span', { class: 'wc_pcal_num' }, String(d)), evs.length ? h('span', { class: 'wc_pcal_dot' }, evs.length > 1 ? `●${evs.length}` : '●') : null, paperIcons));
            }
        }
        const anchor = E.parseDate(cal.date || '');
        root.append(h('div', { class: 'wc_pcal_month' },
            h('div', { class: 'wc_pcal_nav' },
                h('div', { class: 'menu_button', onclick: () => shift(-1), title: '上个月' }, '◀'),
                h('b', {}, `${view.y} 年 ${view.m} 月`),
                h('div', { class: 'menu_button', onclick: () => shift(1), title: '下个月' }, '▶'),
                anchor && (anchor.y !== view.y || anchor.m !== view.m) ? h('div', { class: 'menu_button', onclick: () => { view = { y: anchor.y, m: anchor.m }; selected = null; render(); } }, '回到今天') : null,
            ),
            grid,
            selected ? h('div', { class: 'wc_pcal_selected' },
                h('b', {}, E.formatDate(selected, pack.meta.display, pack.meta.eras)),
                (month[selected] || []).length ? (month[selected]).map(eventItem) : h('div', { class: 'wc_dim' }, '这一天没有要显示的大事。'),
                papersOn(selected).map(p => (cal.date && E.compareDates(selected, cal.date) <= 0)
                    ? h('div', { class: 'menu_button', onclick: () => openPaper(p.id, selected) }, h('i', { class: 'fa-solid fa-newspaper' }), ` 看这天的《${p.name}》`)
                    : h('div', { class: 'wc_dim' }, `《${p.name}》这天出刊。等故事走到这一天，就能看了。`)),
            ) : null,
        ));

        // 列表
        root.append(
            h('h4', {}, '即将发生'),
            !showFuture ? h('div', { class: 'wc_dim' }, '未来的事先藏起来了。想看，就勾上“显示未来事件”。')
                : cal.upcoming.length ? h('div', { class: 'wc_pcal_list' }, cal.upcoming.map(eventItem))
                    : h('div', { class: 'wc_dim' }, '暂时没有。也可能是作者把它们藏起来了，免得剧透。'),
        );
        if (cal.recent.length) root.append(h('h4', {}, '已经发生'), h('div', { class: 'wc_pcal_list' }, cal.recent.map(eventItem)));
        if (cal.log.length) {
            root.append(h('h4', {}, '世界记录'), h('div', { class: 'wc_pcal_log' }, cal.log.map(l => h('div', {}, h('span', { class: 'wc_dim' }, l.date), ' ', l.text))));
        }
    }

    render();
    return { render };
}

let dotOn = false;
let dotTitle = '';

/**
 * 打开日历弹窗。opts.tab = 'calendar' | 'paper'；看期刊时可带 opts.periodicalId / opts.date。
 * 期刊总开关关着时，只有日历那一面。
 */
export function openChronicle(host, opts = {}) {
    const paperOn = !!host.paperEnabled?.();
    let tab = opts.tab === 'paper' && paperOn ? 'paper' : 'calendar';
    // 没指定看哪一面、也还没选剧本时，日历是空的：先给看期刊
    if (!opts.tab && paperOn && !host.pack()) tab = 'paper';

    const shell = h('div', { class: 'wc_book' });
    const calBox = h('div', { class: 'wc_book_page', role: 'tabpanel' });
    const paperBox = h('div', { class: 'wc_book_page', role: 'tabpanel' });
    let calendar = null;
    let reader = null;
    const buttons = {};

    function show(next, readerOpts = {}) {
        tab = next;
        for (const [k, b] of Object.entries(buttons)) {
            b.classList.toggle('active', k === tab);
            b.setAttribute('aria-selected', k === tab ? 'true' : 'false');
        }
        calBox.hidden = tab !== 'calendar';
        paperBox.hidden = tab !== 'paper';
        if (tab === 'paper') {
            // 第一次翻到期刊这一面才去画，免得没看就把“新刊”算作看过
            if (!reader) reader = mountPeriodicalReader(host.paper, paperBox, readerOpts);
            else reader.show(readerOpts);
        } else if (calendar) {
            calendar.render();
        }
    }

    if (paperOn) {
        const tabButton = (key, icon, label) => {
            const b = h('div', {
                class: 'wc_book_tab' + (key === 'paper' ? ' wc_book_tab_paper' : '') + (key === 'paper' && dotOn ? ' wc_has_new' : ''),
                role: 'tab', tabindex: '0',
                title: key === 'paper' ? (dotOn ? `新刊到了：${dotTitle}` : '看故事世界里的报纸、小报') : '看看故事里今天是哪天，接下来会发生什么',
                onclick: () => show(key),
                onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(key); } },
            }, h('i', { class: `fa-solid ${icon}` }), h('span', {}, label));
            buttons[key] = b;
            return b;
        };
        shell.append(h('div', { class: 'wc_book_switch', role: 'tablist', 'aria-label': '日历还是期刊' },
            tabButton('calendar', 'fa-calendar-days', '日历'),
            tabButton('paper', 'fa-newspaper', '期刊')));
    }
    shell.append(calBox, paperBox);
    calendar = mountCalendar(host, calBox, {
        openPaper: (pid, date) => (paperOn ? show('paper', { periodicalId: pid, date }) : null),
    });
    show(tab, { periodicalId: opts.periodicalId, date: opts.date });
    return host.popup(shell);
}

/** 兼容旧名字：只打开日历那一面。 */
export function openPlayerCalendar(host) {
    return openChronicle(host, { tab: 'calendar' });
}

function entryTitle(host) {
    if (dotOn) return `新刊到了：${dotTitle}`;
    return host?.paperEnabled?.() ? '世界编年史 · 日历和期刊' : '世界编年史 · 玩家日历';
}

function applyDot(el, host) {
    if (!el) return;
    el.classList.toggle('wc_has_new', dotOn);
    el.setAttribute('title', entryTitle(host));
}

let lastHost = null;
let menuRetry = null;

/** 把入口放进扩展菜单（魔杖）和输入框左侧，各一个。可重复调用：期刊开关变了，就跟着换文字。 */
export function installCalendarButtons(host) {
    lastHost = host;
    const label = host.paperEnabled?.() ? '日历和期刊' : '玩家日历';

    // 旧版本留下的期刊入口（如果还在）一并收走，免得重复
    document.getElementById('wc_paper_button')?.remove();
    document.getElementById('wc_paper_menu')?.remove();

    const menu = document.getElementById('extensionsMenu');
    let item = document.getElementById('wc_calendar_menu');
    if (menu && !item) {
        item = h('div', { id: 'wc_calendar_menu', class: 'list-group-item flex-container flexGap5 interactable', tabindex: '0' },
            h('div', { class: 'fa-solid fa-calendar-days extensionsMenuExtensionButton' }),
            h('span', { class: 'wc_calendar_menu_label' }, label));
        item.addEventListener('click', () => openChronicle(lastHost || host));
        item.addEventListener('keydown', (e) => { if (e.key === 'Enter') openChronicle(lastHost || host); });
        menu.append(item);
    } else if (!menu && !menuRetry) {
        // 扩展菜单可能还没建好：稍后再试几次
        let tries = 0;
        menuRetry = setInterval(() => {
            if (document.getElementById('extensionsMenu') || ++tries > 30) {
                clearInterval(menuRetry);
                menuRetry = null;
                if (document.getElementById('extensionsMenu')) installCalendarButtons(lastHost || host);
            }
        }, 1000);
    }
    if (item) {
        const span = item.querySelector('.wc_calendar_menu_label');
        if (span) span.textContent = label;
        applyDot(item, host);
    }

    const existing = document.getElementById('wc_calendar_button');
    const form = document.getElementById('leftSendForm');
    if (!host.buttonEnabled()) {
        existing?.remove();
    } else if (form && !existing) {
        const b = h('div', { id: 'wc_calendar_button', class: 'fa-solid fa-calendar-days interactable', tabindex: '0' });
        b.addEventListener('click', () => openChronicle(lastHost || host));
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter') openChronicle(lastHost || host); });
        form.append(b);
        applyDot(b, host);
    } else {
        applyDot(existing, host);
    }
}

/** “新刊”小红点：挂在日历图标、魔杖菜单那一项，以及弹窗里的“期刊”按钮上。有就亮，没有就灭。 */
export function setPeriodicalDot(on, title = '') {
    dotOn = !!on;
    dotTitle = title;
    applyDot(document.getElementById('wc_calendar_button'), lastHost);
    applyDot(document.getElementById('wc_calendar_menu'), lastHost);
    for (const el of document.querySelectorAll('.wc_book_tab_paper')) {
        el.classList.toggle('wc_has_new', dotOn);
        el.setAttribute('title', dotOn ? `新刊到了：${title}` : '看故事世界里的报纸、小报');
    }
}
