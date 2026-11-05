// 定期刊物的阅读页：挂在日历弹窗的“期刊”那一面里（入口按钮和小红点都在 player-calendar.js）。
// 只依赖传入的 host（由 index.js 提供）与引擎；出刊日、提示词、解析、渲染都在 engine/periodicals.js。

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

const busy = new Map(); // `${chatId}|${periodicalId}|${date}` → Promise：关掉弹窗也继续写，写好就存下

/**
 * 把阅读页画进 container。opts.periodicalId / opts.date 指定看哪一本、哪一期（默认第一本的当前期）。
 * 返回 { show(opts) }：换一本 / 换一期，或者只是重新画一遍。
 */
export function mountPeriodicalReader(host, container, opts = {}) {
    const E = host.engine;
    const root = h('div', { class: 'wc_paper_reader' });
    container.append(root);
    let pid = opts.periodicalId || null;
    let viewDate = opts.date || null;
    let error = '';

    function render() {
        root.innerHTML = '';
        if (!host.enabled()) {
            root.append(h('h3', {}, '定期刊物'), h('div', { class: 'wc_dim' }, '期刊现在是关着的。想看的话，去扩展面板「世界编年史」里，把“期刊”下面的“打开期刊”勾上就好。'));
            return;
        }
        const list = host.periodicals();
        if (!list.length) {
            root.append(h('h3', {}, '定期刊物'), h('div', { class: 'wc_dim' }, '现在一本刊物都没打开。去扩展面板「世界编年史」的“期刊”里，勾上想看的那一本。'));
            return;
        }
        let p = list.find(x => x.id === pid) || list[0];
        pid = p.id;

        // 刊物切换
        if (list.length > 1) {
            root.append(h('div', { class: 'wc_paper_tabs' }, list.map(x => h('div', {
                class: 'menu_button' + (x.id === pid ? ' active' : ''),
                onclick: () => { pid = x.id; viewDate = null; error = ''; render(); },
            }, x.name))));
        }

        // 故事今天是哪天
        const story = host.storyDate();
        if (!story.date) {
            const input = h('input', { type: 'text', class: 'text_pole', placeholder: '比如：1557-03-15' });
            root.append(
                h('h3', {}, `《${p.name}》`),
                h('div', {}, '我还不知道故事里现在是哪一天，所以不知道该给你看哪一期。'),
                h('div', { class: 'wc_dim' }, '请写上故事里的日子（年-月-日），比如 1557-03-15。写好点“就是这天”，我就去找那天以前最近的一期。以后 AI 在回复里写了 <time> 日期，或者你选了剧本，我就会自己跟着走。'),
                h('div', { class: 'wc_row' }, input, h('div', {
                    class: 'menu_button', onclick: () => {
                        const d = E.normalizeDate(String(input.value).trim());
                        if (!d) return host.toast('warning', '日期要写成“年-月-日”，比如 1557-03-15。');
                        host.setManualDate(d);
                        render();
                    },
                }, '就是这天')),
            );
            return;
        }
        const current = E.currentIssueDate(p, story.date);
        if (!current) {
            root.append(h('h3', {}, `《${p.name}》`), h('div', { class: 'wc_dim' }, '这本刊物还没写哪几天出刊，所以没有可看的。请作者在剧本编辑器的“期刊”里填上，比如“1、15”。'));
            return;
        }
        // 未来的期不给看
        if (!viewDate || !E.isValidDate(viewDate) || E.compareDates(viewDate, current) > 0) viewDate = current;
        const date = E.currentIssueDate(p, viewDate) || current;
        viewDate = date;
        const line = host.lineFor(p, date);
        const key = `${host.chatId()}|${pid}|${date}`;
        const saved = host.getIssue(pid, date);

        // 翻期
        const prev = E.previousIssueDate(p, date);
        const next = E.nextIssueDate(p, date, current);
        const pastDates = host.issueDates(pid).filter(d => d !== date);
        const jump = pastDates.length ? (() => {
            const sel = h('select', { class: 'text_pole wc_paper_jump', title: '已经写好的往期' },
                h('option', { value: '' }, `往期（${pastDates.length}）`),
                pastDates.map(d => h('option', { value: d }, host.lineFor(p, d) || d)));
            sel.addEventListener('change', () => { if (sel.value) { viewDate = sel.value; error = ''; render(); } });
            return sel;
        })() : null;
        root.append(h('div', { class: 'wc_paper_nav' },
            h('div', { class: 'menu_button', title: '上一期', onclick: () => { viewDate = prev; error = ''; render(); } }, '◀ 上一期'),
            h('span', { class: 'wc_paper_when' }, date === current ? '最新一期' : '往期'),
            next ? h('div', { class: 'menu_button', title: '下一期', onclick: () => { viewDate = next; error = ''; render(); } }, '下一期 ▶') : null,
            date !== current ? h('div', { class: 'menu_button', onclick: () => { viewDate = current; error = ''; render(); } }, '回到最新') : null,
            jump,
        ));

        const page = h('div', { class: 'wc_paper_page' });
        root.append(page);

        if (busy.has(key)) {
            page.append(h('div', { class: 'wc_paper_wait' },
                h('div', {}, `《${p.name}》${line ? ` ${line}` : ''} 正在排版印刷……`),
                h('div', { class: 'wc_dim' }, '是 AI 在单独写这一期，不会写进聊天里。大概要等几十秒；你可以先关掉这个窗口，写好了会自己存下来。'),
                h('div', { class: 'menu_button', onclick: () => host.stop() }, '不等了，停下'),
            ));
            return;
        }
        if (error) {
            page.append(h('div', { class: 'wc_paper_wait' },
                h('div', {}, '这一期没印出来。'),
                h('div', { class: 'wc_dim' }, error),
                h('div', { class: 'menu_button', onclick: () => write(p, date, key) }, '再试一次'),
            ));
            return;
        }
        if (!saved) {
            write(p, date, key);
            return;
        }
        const issue = E.parseIssue(saved.text);
        page.innerHTML = E.renderIssueHtml(p, issue, { line });
        if (!issue.ok) page.prepend(h('div', { class: 'wc_dim wc_paper_note' }, 'AI 这回没按刊物的版式写，我先把它写的原样给你看。不满意的话，点下面的“重写这一期”。'));
        root.append(h('div', { class: 'wc_paper_actions' },
            h('div', {
                class: 'menu_button', title: '让 AI 把这一期重新写一遍，旧的会被换掉',
                onclick: async () => {
                    if (!(await host.confirm('要把这一期重新写一遍吗？现在这份会被新写的换掉。'))) return;
                    write(p, date, key);
                },
            }, '重写这一期'),
            p.adult ? h('span', { class: 'wc_dim' }, '本刊含成人向内容') : null,
        ));
        if (date === current) host.markRead(pid, date);
    }

    async function write(p, date, key) {
        error = '';
        const job = host.generateIssue(p, date);
        busy.set(key, job);
        render();
        try {
            await job;
        } catch (e) {
            error = host.errorText(e);
        } finally {
            busy.delete(key);
        }
        if (root.isConnected && !container.hidden) render();
    }

    render();
    return {
        show(next = {}) {
            if (next.periodicalId) pid = next.periodicalId;
            if (next.date) viewDate = next.date;
            if (next.periodicalId || next.date) error = '';
            render();
        },
    };
}
