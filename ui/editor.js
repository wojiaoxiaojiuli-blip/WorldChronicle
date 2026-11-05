// 作者编辑器：日历视图 + 表单。作者不需要手写 JSON。
// 只依赖传入的 api（由 index.js 提供）与引擎，便于将来脱离 ST 单独使用。

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const PHASE_COLORS = ['#5b8def', '#e0a43a', '#d9534f', '#53a35f', '#9b6bd3', '#3bb3b3', '#c46a9b', '#8a8f3a'];

let E = null;      // 引擎
let api = null;    // 宿主接口
let root = null;   // 覆盖层元素
let draft = null;  // 正在编辑的包
let dirty = false;
let tab = 'calendar';
let view = { y: 1997, m: 7, mode: 'month' };
let selected = { type: null, id: null, date: null }; // 日历右侧面板选中项
let previewOpts = { date: '', from: '', present: [], useChat: false, seed: 1 };
let aiView = false; // 是否显示“AI 帮我写”

// ---------------------------------------------------------------- DOM 小工具

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

function field(label, input, hint) {
    return h('label', { class: 'wce_field' }, h('span', { class: 'wce_label' }, label), input, hint ? h('span', { class: 'wce_hint' }, hint) : null);
}

/** 绑定到对象属性的输入框。conv 把字符串转成存储值。 */
function bound(obj, key, { type = 'text', rows = 0, placeholder = '', conv = v => v, show = v => v ?? '', after, cls = '' } = {}) {
    const el = rows
        ? h('textarea', { class: `text_pole ${cls}`, rows, placeholder })
        : h('input', { class: `text_pole ${cls}`, type, placeholder });
    el.value = show(obj[key]);
    el.addEventListener('input', () => {
        obj[key] = conv(el.value);
        touch();
        after?.(el.value);
    });
    el.addEventListener('change', () => after?.(el.value, true));
    return el;
}

function select(options, value, onChange, cls = '') {
    const el = h('select', { class: `text_pole ${cls}` });
    for (const o of options) {
        if (o.group) {
            const g = h('optgroup', { label: o.group });
            for (const x of o.options) g.append(h('option', { value: x.value }, x.label));
            el.append(g);
        } else {
            el.append(h('option', { value: o.value }, o.label));
        }
    }
    el.value = value ?? '';
    el.addEventListener('change', () => onChange(el.value));
    return el;
}

function btn(text, onclick, cls = '') {
    return h('div', { class: `menu_button wce_btn ${cls}`, onclick }, text);
}

/** 布尔复选框，绑定到对象属性。 */
function checkbox(obj, key, label, after) {
    const el = h('input', { type: 'checkbox', checked: !!obj[key] });
    el.addEventListener('change', () => { obj[key] = el.checked; touch(); after?.(el.checked); });
    return h('label', { class: 'checkbox_label' }, el, label);
}

const openMore = new Set(); // 哪些“更多”折叠区是展开的（重绘后保持）

/** 折叠区：不常用的选项都放这里，默认收起。key 用来在重绘后记住展开状态。 */
function more(key, label, ...children) {
    const el = h('details', { class: 'wce_more', open: openMore.has(key) }, h('summary', {}, label), ...children);
    el.addEventListener('toggle', () => { if (el.open) openMore.add(key); else openMore.delete(key); });
    return el;
}

const listSplit = v => String(v).split(/[,，、]/).map(x => x.trim()).filter(Boolean);
const lineSplit = v => String(v).split('\n').map(x => x.trim()).filter(Boolean);

function touch() {
    dirty = true;
    root?.querySelector('.wce_dirty')?.classList.add('on');
    scheduleValidate();
}

let validateTimer = null;
function scheduleValidate() {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(renderValidation, 300);
}

function uid(prefix, existing) {
    let i = existing.length + 1;
    while (existing.includes(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
}

// ---------------------------------------------------------------- 入口

export function openEditor(hostApi) {
    api = hostApi;
    E = hostApi.engine;
    if (root) root.remove();
    root = h('div', { id: 'wc_editor', class: 'wce_overlay' });
    document.body.append(root);
    const lib = api.library();
    const id = hostApi.initialPackId && lib[hostApi.initialPackId] ? hostApi.initialPackId : null;
    loadDraft(id ? structuredClone(lib[id]) : E.createEmptyPack(uid('pack-', Object.keys(lib)), '新剧本'));
    render();
}

function loadDraft(pack) {
    draft = E.normalizePack(pack).pack;
    dirty = false;
    ai.result = null; // 旧结果是按别的剧本解析的
    selected = { type: null, id: null, date: null };
    const st = api.chatState?.();
    const anchor = (st?.packId === draft.meta.id && st?.date) || draft.meta.start || draft.events[0]?.date || draft.phases[0]?.from;
    const p = anchor && E.parseDate(anchor);
    if (p) view = { ...view, y: p.y, m: p.m };
    previewOpts = { date: anchor || '', from: '', present: [], useChat: false, seed: 1 };
}

async function close() {
    if (dirty && !(await api.confirm('你还有改动没保存，现在关掉，这些改动就没了。确定要关吗？'))) return;
    root.remove();
    root = null;
}

// ---------------------------------------------------------------- 外框

function render() {
    if (!root) return;
    root.innerHTML = '';
    const lib = api.library();
    const packOptions = [
        ...Object.values(lib).map(p => ({ value: p.meta.id, label: p.meta.name })),
        { value: '__new__', label: '＋ 新建剧本…' },
    ];
    if (!lib[draft.meta.id]) packOptions.unshift({ value: draft.meta.id, label: `${draft.meta.name}（未保存）` });

    const menu = h('details', { class: 'wce_menu' },
        h('summary', { class: 'menu_button wce_btn' }, '更多 ▾'),
        h('div', { class: 'wce_menu_list' },
            btn('从角色卡读取', readCard),
            btn('导出文件', exportJson),
            btn('导入文件', importJson),
            btn('删除这个剧本', removePack, 'redWarningBG'),
        ));
    const header = h('div', { class: 'wce_header' },
        h('b', { class: 'wce_title' }, '编辑日历和剧本'),
        select(packOptions, draft.meta.id, async (v) => {
            if (dirty && !(await api.confirm('你还有改动没保存。换到别的剧本，这些改动就没了。确定要换吗？'))) return render();
            if (v === '__new__') loadDraft(E.createEmptyPack(uid('pack-', Object.keys(api.library())), '新剧本'));
            else loadDraft(structuredClone(api.library()[v]));
            render();
        }, 'wce_pack_select'),
        h('span', { class: 'wce_dirty' + (dirty ? ' on' : ''), title: '圆点亮着，说明还有改动没保存' }, '●'),
        btn('保存', () => save(!api.mapping?.()?.packId), 'wce_primary'),
        btn('写入角色卡', writeCard),
        btn('AI 帮我写', openAi),
        menu,
        btn('✕ 关闭', close),
    );

    const tabs = [
        ['calendar', '日历'], ['characters', '角色与关系'], ['phases', '时代气氛'],
        ['interludes', '小插曲'], ['bgm', '音乐'], ['periodicals', '期刊'], ['settings', '设置'],
    ];
    const tabBar = h('div', { class: 'wce_tabs' }, tabs.map(([k, label]) =>
        h('div', { class: 'wce_tab' + (tab === k && !aiView ? ' active' : ''), onclick: () => { tab = k; aiView = false; render(); } }, label)));

    const body = h('div', { class: 'wce_body' });
    if (aiView) renderAiScreen(body);
    else ({ calendar: renderCalendarTab, characters: renderCharactersTab, phases: renderPhasesTab, interludes: renderInterludesTab, bgm: renderBgmTab, periodicals: renderPeriodicalsTab, settings: renderSettingsTab, preview: renderPreviewTab })[tab](body);

    root.append(h('div', { class: 'wce_window' }, header, h('div', { class: 'wce_validation' }), tabBar, body));
    renderValidation();
}

function renderValidation() {
    const box = root?.querySelector('.wce_validation');
    if (!box) return;
    const { errors, warnings } = E.normalizePack(draft);
    box.innerHTML = '';
    if (!errors.length && !warnings.length) return;
    box.append(...errors.map(e => h('div', { class: 'wce_err' }, '要改一下：', e)), ...warnings.slice(0, 5).map(w => h('div', { class: 'wce_warn' }, '小提醒：', w)));
    if (warnings.length > 5) box.append(h('div', { class: 'wce_warn' }, `……还有 ${warnings.length - 5} 条小提醒`));
}

// ---------------------------------------------------------------- 保存 / 分发

function finalPack() {
    const { pack, errors } = E.normalizePack(draft);
    if (errors.length) {
        api.toast('error', `剧本里还有一处要改，改好才能保存：${errors[0]}`);
        return null;
    }
    return pack;
}

function save(bind) {
    const pack = finalPack();
    if (!pack) return null;
    // 改了 id 时旧 id 的条目仍留在库里，作者可在下拉框里切过去删除
    api.savePack(pack, { bind });
    draft = structuredClone(pack);
    dirty = false;
    api.toast('success', `保存好了：${pack.meta.name}`);
    render();
    return pack;
}

/** 卡里已有旧版本且内容变了：版本号自动加一，玩家打开新卡时才会更新。作者不用管版本号。 */
function bumpVersionIfChanged() {
    const old = api.readFromCard();
    if (!old || old.meta?.id !== draft.meta.id) return;
    const strip = (x) => JSON.stringify({ ...E.normalizePack(x).pack, meta: { ...E.normalizePack(x).pack.meta, version: '' } });
    if (strip(old) === strip(draft)) return;
    const v = String(old.meta.version || '0.1');
    draft.meta.version = /\d+$/.test(v) ? v.replace(/\d+$/, n => String(Number(n) + 1)) : `${v}.1`;
}

async function writeCard() {
    const name = api.cardName();
    if (!name) return api.toast('warning', '要先打开一张角色卡，才能把剧本写进去。群聊里写不了。');
    if (!(await api.confirm(`把剧本「${draft.meta.name}」写进角色卡「${name}」吗？\n写进去以后，剧本就跟着这张卡走：别人导入这张卡，会自动带上这个剧本。`))) return;
    bumpVersionIfChanged();
    const pack = save(true);
    if (!pack) return;
    try {
        await api.writeToCard(pack);
        api.toast('success', `已经写进角色卡「${name}」了`);
    } catch (e) {
        api.toast('error', `没写进去：${e.message || e}`);
    }
}

async function readCard() {
    const pack = api.readFromCard();
    if (!pack) return api.toast('warning', '这张角色卡里没有带剧本。');
    if (dirty && !(await api.confirm('读进来会盖掉你还没保存的改动。确定要读吗？'))) return;
    loadDraft(structuredClone(pack));
    dirty = true;
    render();
    api.toast('info', '已经从角色卡读进来了。看看没问题，记得点“保存”。');
}

function exportJson() {
    const pack = E.normalizePack(draft).pack;
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${pack.meta.id || 'pack'}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function importJson() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
        const f = input.files?.[0];
        if (!f) return;
        try {
            const json = JSON.parse(await f.text());
            if (dirty && !(await api.confirm('导入会盖掉你还没保存的改动。确定要导入吗？'))) return;
            loadDraft(json);
            dirty = true;
            render();
            api.toast('info', '已经导入了。看看没问题，记得点“保存”。');
        } catch (e) {
            api.toast('error', `导入没成功，这个文件可能不是剧本文件（${e.message || e}）`);
        }
    });
    input.click();
}

async function removePack() {
    const lib = api.library();
    if (!lib[draft.meta.id]) return api.toast('info', '这个剧本还没保存过，不用删。');
    if (!(await api.confirm(`要删掉剧本「${draft.meta.name}」吗？删了以后，这里就找不回来了。导出过的文件、写进角色卡的那份都还在。`))) return;
    api.deletePack(draft.meta.id);
    const next = Object.values(api.library())[0];
    loadDraft(next ? structuredClone(next) : E.createEmptyPack('new-pack', '新剧本'));
    render();
}

// ---------------------------------------------------------------- 条件编辑器

const COND_TYPES = [
    { value: '', label: '不设条件' },
    { value: 'flag', label: '已经留下某张小纸条' },
    { value: 'choice', label: '某人做过某个选择' },
    { value: 'phase', label: '正处在某段时代气氛里' },
    { value: 'present', label: '某人就在场' },
    { value: 'all', label: '下面几条都满足' },
    { value: 'any', label: '下面几条满足一条就行' },
    { value: 'not', label: '下面这条不满足' },
];

function condType(c) {
    if (!c || typeof c !== 'object') return '';
    return ['flag', 'choice', 'phase', 'present', 'all', 'any', 'not'].find(k => k in c) || '';
}

function knownFlags() {
    const s = new Set();
    for (const e of draft.events) (e.set_flags || []).forEach(f => s.add(f));
    for (const f of draft.flag_defs || []) if (f.name) s.add(f.name);
    return [...s];
}

/** 递归条件编辑器。set(newCond) 回写父级。 */
function condEditor(cond, set, { allowPresent = true } = {}) {
    const type = condType(cond);
    const box = h('div', { class: 'wce_cond' });
    const rerender = (c) => { set(c); touch(); box.replaceWith(condEditor(c, set, { allowPresent })); };
    const types = COND_TYPES.filter(t => allowPresent || t.value !== 'present');
    box.append(select(types, type, (t) => {
        const fresh = {
            '': null,
            flag: { flag: knownFlags()[0] || '' },
            choice: { choice: { who: '', event: '', is: '' } },
            phase: { phase: draft.phases[0]?.id || '' },
            present: { present: draft.characters[0]?.id || '' },
            all: { all: [] },
            any: { any: [] },
            not: { not: null },
        }[t];
        rerender(fresh);
    }, 'wce_cond_type'));

    const chars = [{ value: '', label: '（任何人）' }, ...draft.characters.map(c => ({ value: c.id, label: c.name }))];
    const evs = [{ value: '', label: '（任何一件事）' }, ...draft.events.map(e => ({ value: e.id, label: `${e.date} ${e.title}` }))];

    if (type === 'flag') {
        const dl = `wce_flags_${Math.random().toString(36).slice(2)}`;
        const input = bound(cond, 'flag', { placeholder: '纸条上写的字，如：股市崩了', after: () => set(cond) });
        input.setAttribute('list', dl);
        box.append(input, h('datalist', { id: dl }, knownFlags().map(f => h('option', { value: f }))));
    } else if (type === 'choice') {
        const q = cond.choice;
        box.append(
            select(chars, q.who, v => { q.who = v; set(cond); touch(); }),
            select(evs, q.event, v => { q.event = v; set(cond); touch(); }),
            bound(q, 'is', { placeholder: '选了什么，如：撑住。空着＝选什么都算', after: () => set(cond) }),
        );
    } else if (type === 'phase') {
        box.append(select(draft.phases.map(p => ({ value: p.id, label: p.name || p.id })), cond.phase, v => { cond.phase = v; set(cond); touch(); }));
    } else if (type === 'present') {
        box.append(select(draft.characters.map(c => ({ value: c.id, label: c.name })), cond.present, v => { cond.present = v; set(cond); touch(); }));
    } else if (type === 'all' || type === 'any') {
        const list = cond[type];
        const kids = h('div', { class: 'wce_cond_children' });
        list.forEach((child, i) => {
            kids.append(h('div', { class: 'wce_cond_child' },
                condEditor(child, (c) => { list[i] = c; set(cond); touch(); }, { allowPresent }),
                btn('✕', () => { list.splice(i, 1); rerender(cond); touch(); }, 'wce_small'),
            ));
        });
        kids.append(btn('＋ 再加一条', () => { list.push({ flag: '' }); rerender(cond); touch(); }, 'wce_small'));
        box.append(kids);
    } else if (type === 'not') {
        box.append(h('div', { class: 'wce_cond_children' }, condEditor(cond.not, (c) => { cond.not = c; set(cond); touch(); }, { allowPresent })));
    }
    return box;
}

// ---------------------------------------------------------------- 日历

function phaseIndex(id) {
    return draft.phases.findIndex(p => p.id === id);
}

function phaseColor(id) {
    const i = phaseIndex(id);
    return i < 0 ? 'transparent' : PHASE_COLORS[i % PHASE_COLORS.length];
}

function dateStr(y, m, d) {
    return E.normalizeDate(`${y}-${m}-${d}`);
}

function renderCalendarTab(body) {
    const toolbar = h('div', { class: 'wce_toolbar' },
        btn('◀', () => shiftMonth(view.mode === 'year' ? -12 : -1)),
        (() => {
            const y = h('input', { type: 'number', class: 'text_pole wce_year', value: view.y });
            y.addEventListener('change', () => { view.y = Number(y.value) || view.y; render(); });
            return y;
        })(),
        h('span', {}, '年'),
        view.mode === 'month' ? select(Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}月` })), String(view.m), v => { view.m = Number(v); render(); }) : null,
        btn('▶', () => shiftMonth(view.mode === 'year' ? 12 : 1)),
        btn(view.mode === 'month' ? '年视图' : '月视图', () => { view.mode = view.mode === 'month' ? 'year' : 'month'; render(); }),
        (() => {
            const st = api.chatState?.();
            return st?.date ? btn(`跳到聊天里的日子 ${st.date}`, () => { const p = E.parseDate(st.date); view.y = p.y; view.m = p.m; render(); }) : null;
        })(),
        h('span', { class: 'wce_hint' }, '点日历上的某一天，就能写下那天发生的事。'),
    );
    if (!draft.events.length) body.append(startGuide());
    const legend = draft.phases.length ? h('div', { class: 'wce_legend' },
        draft.phases.map(p => h('span', { class: 'wce_legend_item' }, h('i', { style: { background: phaseColor(p.id) } }), p.name || p.id)),
    ) : null;
    const cal = view.mode === 'month' ? renderMonth(view.y, view.m) : renderYear(view.y);
    const side = h('div', { class: 'wce_side' });
    renderSide(side);
    body.append(toolbar, legend, h('div', { class: 'wce_cal_layout' }, h('div', { class: 'wce_cal_main' }, cal), side));
}

/** 空剧本的三步引导 */
function startGuide() {
    return h('div', { class: 'wce_guide' },
        h('div', { class: 'wce_guide_ai' },
            h('div', {}, h('b', {}, '手上已经有角色卡或设定？'), ' 可以让 AI 先帮你打个草稿，你再慢慢改。'),
            btn('AI 帮我写', openAi, 'wce_primary'),
        ),
        h('b', {}, '也可以自己动手，只要三步：'),
        h('div', { class: 'wce_row' },
            field('① 给剧本起个名字', bound(draft.meta, 'name', { placeholder: '如：香港·九七前后' })),
            field('② 故事从哪天开始', bound(draft.meta, 'start', { type: 'date', after: (v, done) => { if (done && E.isValidDate(v)) { jumpTo(v); render(); } } })),
        ),
        h('div', {}, '③ 在下面的日历上点一天，写下那天发生了什么，再写上这件事会影响谁。写完点右上角的“保存”。'),
        h('div', { class: 'wce_hint' }, '故事走到那一天，AI 就会知道这件事，相关的角色会按自己的性格去反应。别的格子都可以先空着，不填也能玩。'),
    );
}

function shiftMonth(n) {
    let idx = view.y * 12 + (view.m - 1) + n;
    view.y = Math.floor(idx / 12);
    view.m = (idx % 12 + 12) % 12 + 1;
    render();
}

function dayInfo(date) {
    const n = E.toDayNumber(date);
    const events = draft.events.filter(e => e.date === date);
    let lead = false;
    let linger = false;
    for (const e of draft.events) {
        if (!e.date) continue;
        const en = E.toDayNumber(e.date);
        if (n < en && n >= en - (Number(e.lead_days) || 0)) lead = true;
        if (n > en && n <= en + (Number(e.linger_days) || 0)) linger = true;
    }
    const phase = draft.phases.find(p => p.from && p.to && E.isValidDate(p.from) && E.isValidDate(p.to) && E.inRange(date, p.from, p.to));
    const interludes = draft.interludes.filter(i => (i.window[0] || i.window[1]) && safeRange(date, i.window[0], i.window[1]));
    return { events, lead, linger, phase, interludes };
}

function safeRange(date, from, to) {
    try {
        return E.inRange(date, E.isValidDate(from) ? from : null, E.isValidDate(to) ? to : null);
    } catch {
        return false;
    }
}

function renderMonth(y, m) {
    const grid = h('div', { class: 'wce_month' });
    WEEK.forEach(w => grid.append(h('div', { class: 'wce_wd' }, w)));
    const first = dateStr(y, m, 1);
    if (!first) return grid;
    const offset = E.weekday(first);
    for (let i = 0; i < offset; i++) grid.append(h('div', { class: 'wce_day empty' }));
    const st = api.chatState?.();
    for (let d = 1; d <= E.daysInMonth(y, m); d++) {
        const date = dateStr(y, m, d);
        const info = dayInfo(date);
        const cell = h('div', {
            class: ['wce_day', info.lead && 'lead', info.linger && 'linger', selected.date === date && 'selected', st?.date === date && 'today', draft.meta.start === date && 'start'].filter(Boolean).join(' '),
            title: [info.phase && `时代气氛：${info.phase.name || info.phase.id}`, info.interludes.length && `可能冒出的小插曲：${info.interludes.map(i => i.text.slice(0, 12) || i.id).join('、')}`, draft.meta.start === date && '故事从这天开始', st?.date === date && '聊天里现在是这一天'].filter(Boolean).join('\n'),
            onclick: (ev) => {
                if (ev.target.closest('.wce_chip')) return;
                selected = { type: 'day', id: null, date };
                render();
            },
        },
        h('div', { class: 'wce_phase_strip', style: { background: info.phase ? phaseColor(info.phase.id) : 'transparent' } }),
        h('div', { class: 'wce_daynum' }, String(d), info.interludes.length ? h('b', { class: 'wce_dot' }, ' •'.repeat(Math.min(3, info.interludes.length))) : null),
        info.events.map(e => h('div', {
            class: 'wce_chip' + (selected.type === 'event' && selected.id === e.id ? ' active' : ''),
            title: e.title,
            onclick: () => { selected = { type: 'event', id: e.id, date }; render(); },
        }, e.title || e.id)),
        );
        grid.append(cell);
    }
    return grid;
}

function renderYear(y) {
    const wrap = h('div', { class: 'wce_year_grid' });
    for (let m = 1; m <= 12; m++) {
        const mini = h('div', { class: 'wce_mini', onclick: () => { view.m = m; view.mode = 'month'; render(); } }, h('div', { class: 'wce_mini_title' }, `${m}月`));
        const g = h('div', { class: 'wce_mini_grid' });
        const first = dateStr(y, m, 1);
        if (first) {
            for (let i = 0; i < E.weekday(first); i++) g.append(h('span'));
            for (let d = 1; d <= E.daysInMonth(y, m); d++) {
                const date = dateStr(y, m, d);
                const info = dayInfo(date);
                g.append(h('span', {
                    class: ['wce_mini_day', info.events.length && 'has_event', info.lead && 'lead', info.linger && 'linger'].filter(Boolean).join(' '),
                    style: { borderBottomColor: info.phase ? phaseColor(info.phase.id) : 'transparent' },
                    title: info.events.map(e => e.title).join('、'),
                }, String(d)));
            }
        }
        mini.append(g);
        wrap.append(mini);
    }
    return wrap;
}

function renderSide(side) {
    if (selected.type === 'event') {
        const e = draft.events.find(x => x.id === selected.id);
        if (e) return side.append(eventForm(e));
    }
    if (selected.type === 'day' && selected.date) {
        const info = dayInfo(selected.date);
        side.append(h('div', {},
            h('h3', {}, E.formatDate(selected.date, draft.meta.display, draft.meta.eras)),
            info.phase ? h('div', { class: 'wce_hint' }, `时代气氛：${info.phase.name || info.phase.id}`) : null,
            info.events.length ? h('div', {}, h('b', {}, '这天发生的事：'), info.events.map(e => h('div', { class: 'wce_link', onclick: () => { selected = { type: 'event', id: e.id, date: e.date }; render(); } }, e.title))) : null,
            info.interludes.length ? h('div', {}, h('b', {}, '可能出现的小插曲：'), info.interludes.map(i => h('div', { class: 'wce_hint' }, i.text.slice(0, 40)))) : null,
            h('div', { class: 'wce_row' }, btn('＋ 在这天添加事件', () => addEvent(selected.date), 'wce_primary')),
            more('day', '这一天还能做什么',
                h('div', { class: 'wce_row' },
                    btn('让故事从这天开始', () => { draft.meta.start = selected.date; touch(); render(); }),
                    btn('从这天起新建时代气氛', () => addPhase(selected.date)),
                    btn('从这天起新建小插曲', () => addInterlude(selected.date)),
                    btn('看这天 AI 会收到什么', () => { previewOpts.date = selected.date; tab = 'preview'; render(); }),
                ),
            ),
        ));
        return;
    }
    side.append(h('div', {}, h('div', { class: 'wce_hint' }, '点日历上的一天，就能在那天写一件事。想改已经写好的事，点日历上它的标题就行。'),
        h('h4', {}, `全部事件（${draft.events.length}）`),
        draft.events.map(e => h('div', { class: 'wce_link', onclick: () => { selected = { type: 'event', id: e.id, date: e.date }; jumpTo(e.date); render(); } }, `${e.date || '还没填日期'}  ${e.title}`))));
}

function jumpTo(date) {
    const p = E.parseDate(date);
    if (p) { view.y = p.y; view.m = p.m; view.mode = 'month'; }
}

function addEvent(date) {
    const base = `ev-${date.replace(/-/g, '')}`;
    const ids = draft.events.map(e => e.id);
    let id = base;
    for (let i = 2; ids.includes(id); i++) id = `${base}-${i}`;
    draft.events.push({ id, date, title: '', lead_days: 0, linger_days: 3, rumor: '', news: '', summary: '', affects: {}, set_flags: [], if: null, variants: [] });
    selected = { type: 'event', id, date };
    touch();
    render();
}

/** 影响对象的显示名：角色名，或身份标签本身 */
function targetLabel(key) {
    return draft.characters.find(c => c.id === key)?.name || key;
}

/** 输入角色名或身份：已有的直接用，没有的当作新身份标签。返回 key。 */
function resolveTarget(text) {
    const t = String(text).trim();
    if (!t) return '';
    const c = draft.characters.find(x => x.id === t || x.name === t || x.aliases.includes(t));
    if (c) return c.id;
    if (!draft.tags.includes(t)) draft.tags.push(t);
    return t;
}

function eventForm(e) {
    const refresh = () => { const side = root.querySelector('.wce_side'); side.innerHTML = ''; renderSide(side); };
    const recal = () => { const main = root.querySelector('.wce_cal_main'); if (main) { main.innerHTML = ''; main.append(view.mode === 'month' ? renderMonth(view.y, view.m) : renderYear(view.y)); } };
    const intConv = v => Math.max(0, Math.floor(Number(v) || 0));

    const form = h('div', { class: 'wce_form' },
        h('h3', {}, '事件'),
        field('标题', bound(e, 'title', { placeholder: '给这件事起个短名字，如：股市大跌', after: (_, c) => c && recal() })),
        field('日期', bound(e, 'date', { type: 'date', conv: v => v, after: (v, c) => { if (c && E.isValidDate(v)) { selected.date = v; jumpTo(v); render(); } } })),
        field('发生了什么', bound(e, 'news', { rows: 3, placeholder: '像写新闻一样说说这天的事。如：股市一早就大跌，银行门口排起了长队。' }), '故事走到这一天，AI 就会读到这段话。'),
    );

    // 影响谁
    const affBox = h('div', { class: 'wce_affects' }, h('h4', {}, '影响谁'), h('div', { class: 'wce_hint' }, '写上会被这件事卷进去的人。这个人在场时，AI 才会写TA的处境。'));
    Object.keys(e.affects).forEach((key) => {
        const a = e.affects[key];
        affBox.append(h('div', { class: 'wce_card' },
            h('div', { class: 'wce_row' }, h('b', {}, targetLabel(key)), btn('删除', () => { delete e.affects[key]; touch(); refresh(); }, 'wce_small')),
            field('对TA的影响', bound(a, 'pressure', { rows: 2, placeholder: '这件事让TA遇到了什么麻烦？如：手里的股票一天亏掉一半' })),
            field('TA要做的选择（不填也行）', bound(a, 'dilemma', { rows: 2, placeholder: '如：斩仓止损，还是咬牙撑住？' })),
            more(`aff-${e.id}-${key}`, '更多',
                field('可以怎么选（一行写一个，只给 AI 参考）', bound(a, 'options', { rows: 3, placeholder: '如：\n卖掉止损\n借钱撑住', conv: lineSplit, show: v => (v || []).join('\n') })),
                field('TA选完以后，身边的人会怎样？（不填会自动写一句）', bound(a, 'ripple', { placeholder: '{who}决定{choice}，{target}受到牵连' }), '花括号里的字会自动换掉：{who} 做选择的人，{target} 被牵连的人，{choice} TA选了什么，{type} 两人的关系，{note} 关系的补充说明，{event} 这件事的标题。'),
            ),
        ));
    });
    const listId = 'wce_target_list';
    const targetInput = h('input', { class: 'text_pole', list: listId, placeholder: '写一个人名，或一种身份，如：金融从业者' });
    const addTarget = () => {
        const key = resolveTarget(targetInput.value);
        if (!key) return;
        if (e.affects[key]) return api.toast('warning', '这个已经在名单里了');
        e.affects[key] = { pressure: '', dilemma: '', options: [] };
        touch();
        refresh();
    };
    targetInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); addTarget(); } });
    affBox.append(h('div', { class: 'wce_row' }, targetInput, btn('＋ 添加', addTarget)),
        h('datalist', { id: listId }, draft.characters.map(c => h('option', { value: c.name })), draft.tags.map(t => h('option', { value: t }))));
    form.append(affBox);

    // 变体
    const varBox = h('div', { class: 'wce_variants' }, h('h4', {}, '如果历史被改变（满足条件时，这件事换一种写法）'));
    (e.variants || []).forEach((v, i) => {
        varBox.append(h('div', { class: 'wce_card' },
            h('div', { class: 'wce_row' }, h('b', {}, `写法 ${i + 1}`), btn('删除', () => { e.variants.splice(i, 1); touch(); refresh(); }, 'wce_small')),
            h('div', { class: 'wce_field' }, h('span', { class: 'wce_label' }, '什么时候换'), condEditor(v.if, c => { v.if = c; touch(); })),
            field('换标题', bound(v, 'title', { placeholder: '空着就不换', conv: x => x || undefined })),
            field('换风声', bound(v, 'rumor', { rows: 2, placeholder: '空着就不换', conv: x => x || undefined })),
            field('换“发生了什么”', bound(v, 'news', { rows: 2, placeholder: '空着就不换', conv: x => x || undefined })),
            field('换事后的议论', bound(v, 'summary', { rows: 2, placeholder: '空着就不换', conv: x => x || undefined })),
        ));
    });
    varBox.append(btn('＋ 添加一种写法', () => { e.variants = e.variants || []; e.variants.push({ if: { flag: '' } }); touch(); refresh(); }));

    form.append(more('event-more', '更多选项（都可以不填）',
        h('div', { class: 'wce_row' },
            field('提前几天开始有人悄悄议论？', bound(e, 'lead_days', { type: 'number', conv: intConv, after: (_, c) => c && recal() }), '比如填 3，这件事发生前 3 天，街上就会开始有传言。不想要就填 0。'),
            field('过后几天大家还在说这件事？', bound(e, 'linger_days', { type: 'number', conv: intConv, after: (_, c) => c && recal() }), '比如填 3，事情过去后的 3 天里，大家还在议论它。填 0 就是过了当天就不提了。'),
        ),
        checkbox(e, 'once', '只告诉 AI 一次（比如“拿到成就”这种说一遍就够的事）'),
        field('风声（事前的传言）', bound(e, 'rumor', { rows: 2, placeholder: '只写传言和苗头，别把结果说出来。如：听说有大户在偷偷换美元' })),
        field('事后大家怎么说（空着就用“发生了什么”那段）', bound(e, 'summary', { rows: 2 })),
        field('背景音乐', trackSelect(e), '这件事发生时，换成这首歌。歌要先在“音乐”页加进来。'),
        field('玩家的日历上怎么显示？', select([
            { value: 'show', label: '显示标题和内容' },
            { value: 'title_only', label: '只显示标题' },
            { value: 'hidden', label: '发生前先藏起来' },
        ], e.visibility || 'show', v => { e.visibility = v; touch(); }), '怕剧透就藏起来。别担心，没发生的事 AI 本来就看不到。'),
        h('div', { class: 'wce_field' }, h('span', { class: 'wce_label' }, '要满足什么才发生？（不设条件，到日子就发生）'), condEditor(e.if, c => { e.if = c; touch(); })),
        field('发生后留一张小纸条', bound(e, 'set_flags', { conv: listSplit, show: v => (v || []).join('，'), placeholder: '如：股市崩了。好几张就用逗号隔开' }), '小纸条会提醒故事：“这件事已经发生了，而且改变了后面的事。”别的事可以看有没有这张纸条，再决定发不发生。不用就空着。'),
        varBox,
        field('事件编号', bound(e, 'id', { conv: v => v.trim(), after: () => { selected.id = e.id; } }), '插件靠它认出这件事，一般不用改。改了的话，已经玩过的聊天里记下的选择会对不上。'),
    ), h('div', { class: 'wce_row' },
        btn('复制一份', () => {
            const copy = structuredClone(e);
            copy.id = `${e.id}-copy`;
            while (draft.events.some(x => x.id === copy.id)) copy.id += '-1';
            draft.events.push(copy);
            selected = { type: 'event', id: copy.id, date: copy.date };
            touch();
            render();
        }),
        btn('看这天 AI 会收到什么', () => { previewOpts.date = e.date; tab = 'preview'; render(); }),
        btn('删除', async () => {
            if (!(await api.confirm(`要删掉「${e.title || e.date}」这件事吗？`))) return;
            draft.events = draft.events.filter(x => x !== e);
            selected = { type: 'day', id: null, date: e.date };
            touch();
            render();
        }, 'redWarningBG'),
    ));
    return form;
}

// ---------------------------------------------------------------- 角色与关系

function renderCharactersTab(body) {
    // 身份标签
    const tagInput = h('input', { class: 'text_pole', placeholder: '写一种身份，如：金融从业者' });
    const addTag = () => {
        const t = tagInput.value.trim();
        if (t && !draft.tags.includes(t)) { draft.tags.push(t); touch(); render(); }
    };
    tagInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') addTag(); });
    body.append(h('h3', {}, '身份标签'), h('div', { class: 'wce_hint' }, '身份就是给人分个类，比如“学生”“金融从业者”。事件写“影响金融从业者”，所有带这个身份的人都会被影响。'),
        h('div', { class: 'wce_tags' }, draft.tags.map(t => h('span', { class: 'wce_tag' }, t, h('a', {
            href: '#', onclick: (ev) => {
                ev.preventDefault();
                draft.tags = draft.tags.filter(x => x !== t);
                draft.characters.forEach(c => { c.tags = c.tags.filter(x => x !== t); });
                touch();
                render();
            },
        }, ' ✕')))),
        h('div', { class: 'wce_row' }, tagInput, btn('添加身份', addTag)));

    // 角色
    body.append(h('h3', {}, `角色（${draft.characters.length}）`));
    const list = h('div', { class: 'wce_char_list' });
    draft.characters.forEach((c, i) => {
        list.append(h('div', { class: 'wce_card' },
            h('div', { class: 'wce_row' },
                field('名字', bound(c, 'name', { after: (_, done) => done && redrawGraph() })),
                field('编号', bound(c, 'id', { conv: v => v.trim(), after: (_, done) => done && render() }), '插件靠它认人，一般不用改'),
                field('别的叫法（用逗号隔开）', bound(c, 'aliases', { placeholder: '如：小王，王经理', conv: listSplit, show: v => (v || []).join('，') }), '聊天里出现这些名字，也算TA在场'),
            ),
            h('div', { class: 'wce_tags' }, h('span', { class: 'wce_label' }, '身份（点一下选上）：'), draft.tags.map(t => h('span', {
                class: 'wce_tag toggle' + (c.tags.includes(t) ? ' on' : ''),
                onclick: (ev) => {
                    c.tags = c.tags.includes(t) ? c.tags.filter(x => x !== t) : [...c.tags, t];
                    ev.currentTarget.classList.toggle('on');
                    touch();
                },
            }, t))),
            field('备注', bound(c, 'note', { placeholder: '写给自己看的，聊天时不会告诉 AI' })),
            btn('删除角色', async () => {
                if (!(await api.confirm(`要删掉「${c.name}」吗？TA和别人的关系也会一起删掉。`))) return;
                draft.characters.splice(i, 1);
                draft.relations = draft.relations.filter(r => r.from !== c.id && r.to !== c.id);
                touch();
                render();
            }, 'wce_small redWarningBG'),
        ));
    });
    body.append(list, btn('＋ 添加角色', () => {
        const id = uid('char', draft.characters.map(c => c.id));
        draft.characters.push({ id, name: '新角色', aliases: [], tags: [], note: '' });
        touch();
        render();
    }));

    // 关系
    const charOpts = draft.characters.map(c => ({ value: c.id, label: c.name }));
    body.append(h('h3', {}, `关系（${draft.relations.length}）`), h('div', { class: 'wce_hint' }, '从左往右读，比如“老陈 —客户→ 小王”。一个人做了选择，和TA连着关系的人也会受牵连（两头都算）。'));
    const rel = h('div', { class: 'wce_rel_list' });
    draft.relations.forEach((r, i) => {
        rel.append(h('div', { class: 'wce_row wce_rel' },
            select(charOpts, r.from, v => { r.from = v; touch(); redrawGraph(); }),
            h('span', {}, '—'),
            bound(r, 'type', { placeholder: '关系，如“客户”', after: (_, d) => d && redrawGraph(), cls: 'wce_short' }),
            h('span', {}, '→'),
            select(charOpts, r.to, v => { r.to = v; touch(); redrawGraph(); }),
            bound(r, 'note', { placeholder: '补一句，如：欠他一大笔钱（AI 会看到）' }),
            btn('✕', () => { draft.relations.splice(i, 1); touch(); render(); }, 'wce_small'),
        ));
    });
    body.append(rel, btn('＋ 添加关系', () => {
        if (draft.characters.length < 2) return api.toast('warning', '要先有两个角色，才能连上关系。');
        draft.relations.push({ from: draft.characters[0].id, to: draft.characters[1].id, type: '认识', note: '' });
        touch();
        render();
    }));

    body.append(h('h3', {}, '关系网'), h('div', { class: 'wce_graph' }, graphSvg()));
}

function redrawGraph() {
    const g = root?.querySelector('.wce_graph');
    if (g) { g.innerHTML = ''; g.append(graphSvg()); }
}

function graphSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 640;
    const H = 420;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'wce_svg');
    const mk = (tag, attrs, text) => {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        if (text !== undefined) el.textContent = text;
        svg.append(el);
        return el;
    };
    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML = '<marker id="wce_arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>';
    svg.append(defs);
    const n = draft.characters.length;
    const pos = {};
    draft.characters.forEach((c, i) => {
        const a = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2;
        pos[c.id] = { x: W / 2 + Math.cos(a) * (W / 2 - 90), y: H / 2 + Math.sin(a) * (H / 2 - 50) };
    });
    for (const r of draft.relations) {
        const a = pos[r.from];
        const b = pos[r.to];
        if (!a || !b || a === b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const pad = 28;
        mk('line', { x1: a.x + dx / len * pad, y1: a.y + dy / len * pad, x2: b.x - dx / len * pad, y2: b.y - dy / len * pad, class: 'wce_edge', 'marker-end': 'url(#wce_arrow)' });
        mk('text', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 4, class: 'wce_edge_label', 'text-anchor': 'middle' }, r.type);
    }
    for (const c of draft.characters) {
        const p = pos[c.id];
        mk('circle', { cx: p.x, cy: p.y, r: 26, class: 'wce_node' });
        mk('text', { x: p.x, y: p.y + 4, class: 'wce_node_label', 'text-anchor': 'middle' }, c.name.length > 5 ? c.name.slice(0, 5) + '…' : c.name);
    }
    if (!n) mk('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'wce_edge_label' }, '还没有角色');
    return svg;
}

// ---------------------------------------------------------------- 阶段

function addPhase(from) {
    const id = uid('phase', draft.phases.map(p => p.id));
    draft.phases.push({ id, name: '新时期', from, to: E.addDays(from, 90), mood: '' });
    draft.phases.sort((a, b) => (E.isValidDate(a.from) && E.isValidDate(b.from) ? E.compareDates(a.from, b.from) : 0));
    touch();
    tab = 'phases';
    render();
}

function renderPhasesTab(body) {
    body.append(h('h3', {}, '时代气氛'), h('div', { class: 'wce_hint' }, '时代气氛就像那段日子的天气：有时人心惶惶，有时热热闹闹。把故事分成几段，写下每段大家的心情，这段时间里 AI 都会带着这种气氛写。不填也行。'), timeline());
    draft.phases.forEach((p, i) => {
        body.append(h('div', { class: 'wce_card', style: { borderLeft: `6px solid ${phaseColor(p.id)}` } },
            h('div', { class: 'wce_row' },
                field('名称', bound(p, 'name', { after: (_, d) => d && redrawTimeline() })),
                field('开始', bound(p, 'from', { type: 'date', after: (_, d) => d && redrawTimeline() })),
                field('结束', bound(p, 'to', { type: 'date', after: (_, d) => d && redrawTimeline() })),
            ),
            field('这段时期的气氛', bound(p, 'mood', { rows: 3, placeholder: '如：大家都在观望，心里发慌；移民中介生意特别好' })),
            field('背景音乐', trackSelect(p), '到了这段时期，就换成这首歌。'),
            btn('删除', () => { draft.phases.splice(i, 1); touch(); render(); }, 'wce_small redWarningBG'),
        ));
    });
    body.append(btn('＋ 添加一段时期', () => {
        const last = draft.phases[draft.phases.length - 1];
        addPhase(last && E.isValidDate(last.to) ? E.addDays(last.to, 1) : (draft.meta.start || '2000-01-01'));
    }));
}

function redrawTimeline() {
    const t = root?.querySelector('.wce_timeline');
    if (t) t.replaceWith(timeline());
}

function timeline() {
    const valid = draft.phases.filter(p => E.isValidDate(p.from) && E.isValidDate(p.to) && E.compareDates(p.from, p.to) <= 0);
    const box = h('div', { class: 'wce_timeline' });
    if (!valid.length) return box;
    const lo = Math.min(...valid.map(p => E.toDayNumber(p.from)));
    const hi = Math.max(...valid.map(p => E.toDayNumber(p.to)));
    const span = Math.max(1, hi - lo);
    for (const p of valid) {
        const left = ((E.toDayNumber(p.from) - lo) / span) * 100;
        const width = Math.max(1, ((E.toDayNumber(p.to) - E.toDayNumber(p.from)) / span) * 100);
        box.append(h('div', { class: 'wce_tl_seg', style: { left: `${left}%`, width: `${width}%`, background: phaseColor(p.id) }, title: `${p.name}：${p.from} ~ ${p.to}` }, p.name || p.id));
    }
    for (const e of draft.events.filter(x => E.isValidDate(x.date))) {
        const n = E.toDayNumber(e.date);
        if (n < lo || n > hi) continue;
        box.append(h('div', { class: 'wce_tl_event', style: { left: `${((n - lo) / span) * 100}%` }, title: `${e.date} ${e.title}` }));
    }
    return box;
}

// ---------------------------------------------------------------- 插曲

function addInterlude(from) {
    const id = uid('interlude', draft.interludes.map(i => i.id));
    draft.interludes.push({ id, window: [from, E.addDays(from, 30)], weight: 1, cooldown_days: 5, if: null, text: '' });
    touch();
    tab = 'interludes';
    render();
}

function renderInterludesTab(body) {
    const cfg = draft.meta.interlude;
    body.append(h('h3', {}, '小插曲'), h('div', { class: 'wce_hint' }, '小插曲是街头巷尾的小事，比如一句闲话、一个街景。日子往前走时，偶尔会随机冒出一条，让世界更像真的。不填也行。'));
    draft.interludes.forEach((it, i) => {
        body.append(h('div', { class: 'wce_card' },
            field('内容', bound(it, 'text', { rows: 2, placeholder: '如：警署门口工人在拆旧警徽' })),
            h('div', { class: 'wce_row' },
                field('从哪天起可能出现', bound(it.window, 0, { type: 'date' })),
                field('到哪天为止', bound(it.window, 1, { type: 'date' })),
            ),
            more(`itl-${i}`, '更多',
                h('div', { class: 'wce_row' },
                    field('有多常见（数字越大越常见）', bound(it, 'weight', { type: 'number', conv: v => Math.max(0, Number(v) || 0) }), '比如一条填 2、一条填 1，前一条冒出来的机会大约是后一条的两倍。'),
                    field('出现一次后，隔几天才会再出现？', bound(it, 'cooldown_days', { type: 'number', conv: v => Math.max(0, Math.floor(Number(v) || 0)) })),
                ),
                h('div', { class: 'wce_field' }, h('span', { class: 'wce_label' }, '要满足什么才出现？（不设条件也行）'), condEditor(it.if, c => { it.if = c; touch(); })),
                field('背景音乐', trackSelect(it), '这条冒出来时，换成这首歌。'),
            ),
            btn('删除', () => { draft.interludes.splice(i, 1); touch(); render(); }, 'wce_small redWarningBG'),
        ));
    });
    body.append(btn('＋ 添加一条', () => addInterlude(draft.meta.start || draft.phases[0]?.from || '2000-01-01')),
        more('itl-freq', '多久出现一次',
            h('div', { class: 'wce_row' },
                field('至少隔几天才冒一次？', bound(cfg, 'every_days', { type: 'number', conv: v => Math.max(0, Number(v) || 0) }), '填 0 就是日子每往前走一次，都有机会冒一条。'),
                field('每次冒出来的机会有多大？', bound(cfg, 'chance', { type: 'number', conv: v => Math.min(1, Math.max(0, Number(v) || 0)) }), '填 0 到 1：1 是每次都冒，0.3 大约是十次里冒三次。'),
            ),
        ));
}

// ---------------------------------------------------------------- 期刊

const PAPER_SAMPLE = {
    ok: true,
    headline: '（这里是头条：一句话，像标题那样抓人）',
    columns: [
        { name: '栏目名', text: '这里是栏目正文。真正的内容由 AI 在出刊那天单独写，不会写进聊天里。' },
    ],
};

function addPeriodical(base = null) {
    const id = uid('paper', draft.periodicals.map(p => p.id));
    const p = base
        ? { ...structuredClone(base), id: draft.periodicals.some(x => x.id === base.id) ? id : base.id }
        : { id, name: '新刊物', title: '', subtitle: '', footer: '', schedule: { days: [1, 15] }, profile: '', columns: [], specials: [], theme: 'plain', enabled: true, adult: false };
    draft.periodicals.push(E.normalizePeriodical(p).periodical);
    touch();
    render();
}

function renderPeriodicalsTab(body) {
    body.append(h('h3', {}, '期刊'), h('div', { class: 'wce_hint' },
        '期刊是故事世界里的报纸、小报。到了出刊的日子，AI 会另外写一期给玩家看，不会混进聊天里。'
        + '比如填一本《城南晚报》，每月 1 日、15 日出刊，玩家在日历上点那一天，就能读到那天的报纸。不填也行；插件本身还附赠一本《玉郎闲话》。'));
    draft.periodicals.forEach((p, i) => {
        const preview = h('div', { class: 'wce_paper_preview' });
        const redraw = () => { preview.innerHTML = E.renderIssueHtml(p, PAPER_SAMPLE, { line: '某月朔日刊' }); };
        redraw();
        body.append(h('div', { class: 'wce_card' },
            h('div', { class: 'wce_row' },
                field('刊物名字', bound(p, 'name', { placeholder: '如：城南晚报', after: redraw }), '玩家看到的名字。卡的世界书里如果有一条注释写着这个名字，就会拿那一条当这本刊物的设定。'),
                field('哪几天出刊', bound(p.schedule, 'days', { placeholder: '如：1, 15', conv: v => E.parseDays(v), show: v => (v || []).join(', ') }), '写每个月的几号，用逗号隔开。1 就是初一，15 就是十五。'),
                checkbox(p, 'enabled', '玩家默认能看到这本'),
            ),
            field('刊物设定', bound(p, 'profile', { rows: 5, placeholder: '如：城南晚报是码头工人办的小报，说话直，爱骂洋行老板。每期有头条、码头新闻、米价、寻人启事。' }), '告诉 AI 这是本什么刊物：谁办的、给谁看、说话什么口气、哪些能写哪些不能写。写得越清楚，AI 写得越像。'),
            h('div', { class: 'wce_field' }, h('span', { class: 'wce_label' }, '栏目（不写也行，AI 会自己安排）'),
                listEditor(p.columns, () => ({ name: '', note: '' }), (c) => [
                    field('栏目名', bound(c, 'name', { placeholder: '如：码头新闻' })),
                    field('写什么', bound(c, 'note', { placeholder: '如：这几天进出港的船和货' })),
                ])),
            more(`paper-${i}`, '刊头、样式和特辑',
                h('div', { class: 'wce_row' },
                    field('刊头大字', bound(p, 'title', { placeholder: '不填就用刊物名字', after: redraw })),
                    field('副题', bound(p, 'subtitle', { placeholder: '如：码头人自己的报', after: redraw })),
                    field('右下角小字', bound(p, 'footer', { placeholder: '如：每份两个铜板', after: redraw })),
                ),
                h('div', { class: 'wce_row' },
                    field('纸张样式', select([{ value: 'plain', label: '素白小报' }, { value: 'pink-gold', label: '粉红洒金笺' }], p.theme, v => { p.theme = v; touch(); redraw(); })),
                    checkbox(p, 'adult', '含成人向内容（阅读时会标出来）'),
                ),
                h('div', { class: 'wce_field' }, h('span', { class: 'wce_label' }, '年度特辑（某个月的那一期特别写）'),
                    listEditor(p.specials, () => ({ month: 1, days: [], name: '', note: '' }), (sp) => [
                        field('几月', bound(sp, 'month', { type: 'number', conv: v => Math.min(12, Math.max(0, Math.floor(Number(v) || 0))) })),
                        field('哪几号（不写就是那个月每一期）', bound(sp, 'days', { conv: v => E.parseDays(v), show: v => (v || []).join(', ') })),
                        field('特辑名', bound(sp, 'name', { placeholder: '如：年终大盘点' })),
                        field('写什么', bound(sp, 'note', { placeholder: '如：回顾这一年码头上的大事' })),
                    ])),
                field('刊物编号', bound(p, 'id', { conv: v => v.trim() }), '插件靠它认出刊物，一般不用改。和附赠刊物同编号（yulang）时，会替换掉附赠的那本。'),
            ),
            h('div', { class: 'wce_hint' }, '刊头大概长这样（正文是示意）：'),
            preview,
            btn('删除这本刊物', async () => {
                if (!(await api.confirm(`要删掉《${p.name}》吗？`))) return;
                draft.periodicals.splice(i, 1);
                touch();
                render();
            }, 'wce_small redWarningBG'),
        ));
    });
    body.append(h('div', { class: 'wce_row' },
        btn('＋ 添加一本刊物', () => addPeriodical()),
        btn('照着附赠的《玉郎闲话》改一本', () => addPeriodical(E.DEFAULT_PERIODICAL)),
    ));
}

// ---------------------------------------------------------------- BGM

const BGM_STOP = '__stop__';

/** 曲目下拉框，绑定 obj[key]。空 = 不切换。 */
function trackSelect(obj, key = 'bgm', { none = '（不换歌）' } = {}) {
    const opts = [
        { value: '', label: none },
        ...draft.bgm.tracks.map(t => ({ value: t.id, label: E.formatSong(t) })),
        { value: BGM_STOP, label: '■ 停止播放' },
    ];
    const cur = obj[key] || '';
    if (cur && !opts.some(o => o.value === cur)) opts.splice(1, 0, { value: cur, label: `${cur}（歌单里找不到这首）` });
    return select(opts, cur, v => { obj[key] = v; touch(); });
}

const MUSIC_SOURCE_INFO = {
    link: { label: '贴链接', desc: '把音乐文件放到网上（图床、网盘都行），再把它的网址贴进来。玩家什么都不用设置就能听，最适合分享。' },
    gd: { label: 'GD音乐台', desc: '只写歌名，插件会去 GD音乐台按歌名找歌。玩家要自己点一次同意，才会打开。' },
    ai: { label: 'AI 搜歌', desc: '不用准备歌单，AI 看气氛自己点歌，再去 GD音乐台找。玩家也要自己点一次同意。' },
};

/** 批量粘贴：每行一首，可以是“歌手 - 歌名 | 链接 | 氛围”，也可以只有歌名或只有链接。返回加入的首数。 */
function addSongLines(text) {
    const b = draft.bgm;
    let added = 0;
    for (const line of String(text).split('\n')) {
        const song = E.parseSongEntry(line);
        if (!song) continue;
        const id = E.formatSong(song);
        const same = b.tracks.find(t => t.id === id || E.findTrack(draft, id) === t.id);
        if (same) {
            if (song.url && !same.url) same.url = song.url;
            continue;
        }
        b.tracks.push({ id, title: song.title, artist: song.artist, mood: song.mood, url: song.url, loop: true, volume: 1 });
        added++;
    }
    return added;
}

function renderBgmTab(body) {
    const b = draft.bgm;
    const source = b.source || 'link';
    body.append(h('h3', {}, '音乐从哪来'),
        h('div', { class: 'wce_choices' }, E.MUSIC_SOURCES.map(k => h('label', { class: 'wce_choice' + (source === k ? ' active' : '') },
            h('input', { type: 'radio', name: 'wce_music_source', checked: source === k, onchange: () => {
                b.source = k;
                b.ai_mode = k === 'ai' ? 'free' : 'playlist';
                touch();
                render();
            } }),
            h('b', {}, MUSIC_SOURCE_INFO[k].label),
            h('div', { class: 'wce_hint' }, MUSIC_SOURCE_INFO[k].desc),
        ))));
    if (source !== 'ai') {
        const auto = { on: b.ai_mode !== 'off' };
        body.append(checkbox(auto, 'on', '让 AI 按气氛从歌单里选歌', (v) => { b.ai_mode = v ? 'playlist' : 'off'; }));
    }

    const placeholder = source === 'link'
        ? '一行一首，写成“歌手 - 歌名 | 网址”，比如：\nBeyond - 海阔天空 | https://图床地址/a.mp3\n只贴网址也行：https://图床地址/当年情.mp3'
        : '一行一首，写成“歌手 - 歌名”，后面可以加“| 气氛”，比如：\nBeyond - 海阔天空\n张国荣 - 当年情 | 怀旧、慵懒';
    const paste = h('textarea', { class: 'text_pole', rows: 4, placeholder });
    body.append(
        h('h3', {}, source === 'ai' ? `推荐几首歌（不填也行，现在 ${b.tracks.length} 首）` : `歌单（${b.tracks.length} 首）`),
        paste,
        btn('＋ 加入歌单', () => { const n = addSongLines(paste.value); touch(); render(); api.toast('success', `加进去了 ${n} 首`); }),
    );
    if (source === 'link') body.append(h('div', { class: 'wce_hint' }, '把音乐的网址贴在这里。怎么知道贴对了？把网址放进浏览器打开，如果音乐直接响起来，就对啦。网易云、B 站的页面网址放不出声音哦。贴好后可以点 ▶ 试听。'));

    const table = h('div', { class: 'wce_tracks' });
    b.tracks.forEach((t, i) => {
        const name = h('input', { class: 'text_pole', value: E.formatSong(t), placeholder: '歌手 - 歌名' });
        name.addEventListener('input', () => {
            const song = E.parseSongLine(name.value);
            if (!song) return;
            t.title = song.title;
            t.artist = song.artist;
            touch();
        });
        const linkHint = h('span', { class: 'wce_hint' });
        const checkLink = () => { linkHint.textContent = E.audioLinkProblem(t.url); };
        checkLink();
        table.append(h('div', { class: 'wce_card wce_track' },
            h('div', { class: 'wce_row' },
                field('歌名', name),
                source === 'link' ? field('网址', bound(t, 'url', { placeholder: 'https://….mp3', after: checkLink }), linkHint) : null,
                h('div', { class: 'wce_row wce_track_btns' },
                    btn('▶', () => api.bgm?.test(structuredClone(t), source), 'wce_small'),
                    btn('■', () => api.bgm?.stop(), 'wce_small'),
                    btn('✕', () => { b.tracks.splice(i, 1); touch(); render(); }, 'wce_small redWarningBG'),
                ),
            ),
            more(`track-${i}`, '更多',
                field('适合什么气氛？（给 AI 看，不填也行）', bound(t, 'mood', { placeholder: '如：紧张、追逐' })),
                h('div', { class: 'wce_row' },
                    field('音量（0 到 1，1 最响）', bound(t, 'volume', { type: 'number', conv: v => Math.min(1, Math.max(0, Number(v) || 0)) })),
                    checkbox(t, 'loop', '循环播放'),
                ),
                source !== 'link' ? field('网址（不填也行；填了就先用它）', bound(t, 'url', { placeholder: 'https://….mp3', after: checkLink }), linkHint) : null,
            ),
        ));
    });
    body.append(table);

    // 关键词切歌
    const rules = b.rules.map((r, i) => {
        const reState = h('span', { class: 'wce_hint' });
        const checkRe = () => {
            let bad = false;
            if (r.regex) { try { new RegExp(r.regex); } catch { bad = true; } }
            reState.textContent = bad ? '⚠ 这条写法不对，会被跳过' : '';
        };
        checkRe();
        return h('div', { class: 'wce_card' },
            h('div', { class: 'wce_row' },
                field('聊天里出现这些词（用逗号隔开）', bound(r, 'keywords', { conv: listSplit, show: v => (v || []).join('，'), placeholder: '如：枪声，追车' })),
                field('就换成', trackSelect(r, 'track', { none: '（请选择）' })),
                btn('删除', () => { b.rules.splice(i, 1); touch(); render(); }, 'wce_small redWarningBG'),
            ),
            more(`rule-${i}`, '更多',
                field('高级写法：正则（看不懂就空着）', bound(r, 'regex', { placeholder: '如：(开枪|中弹)', after: checkRe }), reState),
                h('div', { class: 'wce_field' }, h('span', { class: 'wce_label' }, '还要满足什么？（不设也行）'), condEditor(r.if, c => { r.if = c; touch(); })),
            ),
        );
    });
    body.append(more('rules', `关键词切歌（不用也行，${b.rules.length} 条）`,
        h('div', { class: 'wce_hint' }, '聊天里一出现你写的词，就自动换歌。比如写“枪声”，配一首紧张的歌。好几条都对上时，用排在最上面的那条。'),
        rules,
        btn('＋ 添加一条', () => {
            b.rules.push({ id: uid('rule', b.rules.map(r => r.id)), keywords: [], regex: '', track: b.tracks[0]?.id || '', if: null });
            touch();
            render();
        }),
    ));
}

// ---------------------------------------------------------------- 包设置

function renderSettingsTab(body) {
    const m = draft.meta;
    const sample = h('span', { class: 'wce_hint' });
    const updSample = () => { sample.textContent = `示例：${E.formatDate(m.start || '1997-07-01', m.display, m.eras)}`; };
    updSample();
    body.append(
        h('div', { class: 'wce_row' },
            field('剧本名字', bound(m, 'name')),
            field('作者', bound(m, 'author')),
            field('故事开始日期', bound(m, 'start', { type: 'date', after: (v, done) => { if (done && E.isValidDate(v)) { jumpTo(v); updSample(); } } })),
        ),
        field('简介', bound(m, 'description', { rows: 2, placeholder: '一两句话介绍这个剧本，让别人一看就知道讲什么' })),
        h('h4', {}, '倒计时（不用也行）'),
        listEditor(m.countdowns, () => ({ label: '距离某事', date: m.start || '2000-01-01' }), (c) => [
            field('名称', bound(c, 'label'), '比如写“距离开学”，就会显示成“距离开学还有 N 天”'),
            field('目标日期', bound(c, 'date', { type: 'date' })),
        ]),
        btn('看某一天 AI 会收到什么', () => { tab = 'preview'; render(); }),
        more('settings-more', '高级',
            h('div', { class: 'wce_row' },
                field('日期显示格式', bound(m, 'display', { after: updSample }), '日期要显示成什么样。花括号里的字会换成真的日期：{y}年{m}月{d}日 → 1997年7月1日；{mm}{dd} 是补零的月日（07、01）；{w} 是星期几；{cy}{cm}{cd} 是汉字写的年月日；{era}{ey} 是年号和第几年（{cey} 是汉字写的第几年）；{cry}年{rm}{crd}日 是法国共和历。改完看看旁边的示例对不对。'),
                sample,
            ),
            h('h4', {}, '年号'),
            h('div', { class: 'wce_hint' }, '用不到年号就不用管。比如加一个“昭和”，元年从 1926-12-25 开始，日期格式里写 {era}{ey}年，就会显示成“昭和2年”这样。'),
            listEditor(m.eras, () => ({ name: '新年号', from: m.start || '2000-01-01' }), (era) => [
                field('年号', bound(era, 'name', { after: updSample })),
                field('元年从哪天开始', bound(era, 'from', { type: 'date', after: updSample })),
            ]),
            field('AI 一次把日子往后跳多少天以上，要先问玩家？', bound(m, 'max_jump_days', { type: 'number', conv: v => Math.max(0, Number(v) || 0) }), '怕 AI 写错日期，一下子让好多事一起发生。填 0 就不问。另外，一次跳过 8 件以上的事、或往回退超过 7 天，也会先问。'),
            h('h4', {}, '会改变历史的转折'),
            h('div', { class: 'wce_hint' }, '有些事可能发生，也可能不发生，比如“某人活了下来”。写在这里，剧情真的走到那一步时，AI 会替你留一张小纸条。有了这张纸条，事件的条件和“如果历史被改变”就会跟着变。填了最早和最晚，AI 只在这段日子里才会看到这一条，不会提前剧透。'),
            listEditor(draft.flag_defs, () => ({ name: '', when: '' }), (f) => [
                field('名字', bound(f, 'name', { conv: v => v.trim(), placeholder: '如：老陈活了下来' })),
                field('什么时候算', bound(f, 'when', { placeholder: '如：他挺过了那场大病' })),
                field('最早', bound(f, 'from', { type: 'date' })),
                field('最晚', bound(f, 'to', { type: 'date' })),
            ]),
            field('一个人的选择，会牵连身边的人几天？', bound(m, 'ripple_days', { type: 'number', conv: v => Math.max(0, Number(v) || 0) }), '过了这些天，AI 就不再提这份牵连。填 0 就一直记着。'),
            h('div', { class: 'wce_row' },
                field('剧本编号', bound(m, 'id', { conv: v => v.trim() }), '插件靠它认出剧本，一般不用改'),
                field('版本', bound(m, 'version'), '不用管它。写进角色卡时，只要内容改过，就会自动加一'),
            ),
        ),
    );
}

function listEditor(list, make, fields) {
    const box = h('div', { class: 'wce_list' });
    const draw = () => {
        box.innerHTML = '';
        list.forEach((item, i) => box.append(h('div', { class: 'wce_row' }, fields(item), btn('✕', () => { list.splice(i, 1); touch(); draw(); }, 'wce_small'))));
        box.append(btn('＋ 添加', () => { list.push(make()); touch(); draw(); }, 'wce_small'));
    };
    draw();
    return box;
}

// ---------------------------------------------------------------- 预览

function seededRng(seed) {
    let x = seed >>> 0 || 1;
    return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function renderPreviewTab(body) {
    const { pack, errors } = E.normalizePack(draft);
    const mapping = api.mapping?.();
    const merged = mapping?.packId === pack.meta.id ? E.applyMapping(pack, mapping) : pack;
    if (!previewOpts.date) previewOpts.date = pack.meta.start || pack.events[0]?.date || '';
    const out = h('pre', { class: 'wce_preview' });
    const detail = h('div', { class: 'wce_preview_detail' });

    const run = () => {
        out.textContent = '';
        detail.innerHTML = '';
        if (errors.length) { out.textContent = `剧本里还有要改的地方：\n${errors.join('\n')}`; return; }
        if (!E.isValidDate(previewOpts.date)) { out.textContent = '先在上面选一个日期'; return; }
        let state = E.createState(pack.meta.id);
        const st = api.chatState?.();
        if (previewOpts.useChat && st) {
            state.choices = structuredClone(st.choices || []);
            state.flags = structuredClone(st.flags || {});
            state.ripples = structuredClone(st.ripples || []);
        }
        const rng = seededRng(previewOpts.seed);
        try {
            if (E.isValidDate(previewOpts.from) && E.compareDates(previewOpts.from, previewOpts.date) < 0) {
                state = E.advanceTime(merged, state, previewOpts.from, { rng, present: previewOpts.present }).state;
            }
            const r = E.advanceTime(merged, state, previewOpts.date, { rng, present: previewOpts.present });
            state = r.state;
            const inj = E.buildInjection(merged, state, { present: previewOpts.present, instructions: true });
            out.textContent = inj.text;
            const vis = E.visibleEvents(merged, state, previewOpts.date, previewOpts.present);
            const label = { rumor: '事前（只听到风声）', today: '就是今天', linger: '事后（大家还在议论）', catchup: '日子跳过去了，补说一次' };
            detail.append(h('div', {}, h('h4', {}, '这一天 AI 知道的事'),
                vis.length ? vis.map(v => h('div', {}, `${v.event.date} ${v.event.title} — ${label[v.status]}${v.event.variant ? '（用的是“历史被改变”的写法）' : ''}`)) : h('div', { class: 'wce_hint' }, '没有')));
            const pool = E.eligibleInterludes(merged, { ...state, interludeLast: {} }, previewOpts.date, previewOpts.present);
            const total = pool.reduce((s, i) => s + i.weight, 0);
            detail.append(h('div', {}, h('h4', {}, '这天可能冒出的小插曲（先不管“隔几天”）'),
                pool.length ? pool.map(i => h('div', {}, `${Math.round((i.weight / total) * 100)}% — ${i.text}`)) : h('div', { class: 'wce_hint' }, '没有'),
                h('div', { class: 'wce_hint' }, state.interlude ? `这次试抽到了：${pool.find(i => i.id === state.interlude.id)?.text || state.interlude.id}` : '这次试抽，没抽到小插曲')));
            if (r.log.length) detail.append(h('div', {}, h('h4', {}, '日子往前走时发生了什么'), r.log.map(l => h('div', { class: 'wce_hint' }, l))));
        } catch (e) {
            out.textContent = `预览出了点问题：${e.message || e}`;
        }
    };

    const dateInput = h('input', { type: 'date', class: 'text_pole', value: previewOpts.date });
    dateInput.addEventListener('change', () => { previewOpts.date = dateInput.value; run(); });
    const fromInput = h('input', { type: 'date', class: 'text_pole', value: previewOpts.from });
    fromInput.addEventListener('change', () => { previewOpts.from = fromInput.value; run(); });
    const useChat = h('input', { type: 'checkbox', checked: previewOpts.useChat });
    useChat.addEventListener('change', () => { previewOpts.useChat = useChat.checked; run(); });

    const presentBox = h('div', { class: 'wce_tags' }, h('span', { class: 'wce_label' }, '在场的人（点一下选上）：'), merged.characters.map(c => h('span', {
        class: 'wce_tag toggle' + (previewOpts.present.includes(c.id) ? ' on' : ''),
        onclick: (ev) => {
            previewOpts.present = previewOpts.present.includes(c.id) ? previewOpts.present.filter(x => x !== c.id) : [...previewOpts.present, c.id];
            ev.currentTarget.classList.toggle('on');
            run();
        },
    }, c.name)));

    body.append(
        h('h3', {}, 'AI 会收到什么'),
        h('div', { class: 'wce_hint' }, '选一个日期，再点选在场的人，就能看到这时候 AI 会读到哪些话。这里用的是你还没保存的内容，随便试，不会改动剧本。'),
        h('div', { class: 'wce_row' },
            field('日期', dateInput),
            field('假装从哪天跳过来？（不填也行）', fromInput, '试试日子一下跳很远时，中间错过的事会不会补说。'),
            h('label', { class: 'checkbox_label' }, useChat, '带上当前聊天的进度（做过的选择、小纸条、牵连）'),
            btn('再抽一次小插曲', () => { previewOpts.seed++; run(); }),
            btn('用聊天里现在在场的人', () => { previewOpts.present = [...(api.chatPresent?.() || [])]; render(); }),
        ),
        presentBox,
        h('div', { class: 'wce_preview_layout' }, out, detail),
    );
    run();
}

// ---------------------------------------------------------------- AI 帮我写
// AI 的回复一律当作不可信的数据：只经 parseAuthoringReply 解析，所有显示都走 h() 的文本节点，
// 结果先放在 ai.result 里给作者看，作者点了“加入”或“替换”才进草稿，点“保存”才存下。

const AI_SCOPE_INFO = {
    all: { label: '全部', desc: '角色与关系、时代气氛、事件、小插曲' },
    events: { label: '只写事件', desc: '会参考你已经写好的角色' },
    interludes: { label: '只写小插曲', desc: '街头巷尾的小事' },
    characters: { label: '只写角色与关系', desc: '谁是谁，谁和谁什么关系' },
};
const AI_BIG_TOKENS = 20000;
const ai = { material: '', wishes: '', scope: 'all', how: 'st', reply: '', result: null, busy: false, error: '', run: 0, maxTokens: 8000 };

function openAi() {
    aiView = true;
    render();
}

function aiPrompt() {
    return E.buildAuthoringPrompt({ material: ai.material, wishes: ai.wishes, scope: ai.scope, draft });
}

/** 文本框：内容存到 ai 对象里（不算作对剧本的修改） */
function aiText(key, rows, placeholder, after) {
    const el = h('textarea', { class: 'text_pole wce_ai_text', rows, placeholder });
    el.value = ai[key];
    el.addEventListener('input', () => { ai[key] = el.value; after?.(); });
    return el;
}

function renderAiScreen(body) {
    const size = h('div', { class: 'wce_hint' });
    const updSize = () => {
        const n = E.estimateTokens(ai.material);
        size.textContent = ai.material ? `素材大约 ${ai.material.length} 字，按 AI 的算法（tokens）大约是 ${n}。` : '';
        size.className = n > AI_BIG_TOKENS ? 'wce_warn' : 'wce_hint';
        if (n > AI_BIG_TOKENS) size.textContent += ' 素材有点长了：AI 可能读不完，也会多花额度。可以先删掉和时间、事件无关的部分。';
    };
    updSize();
    const material = aiText('material', 10, '把设定、角色卡、世界书、年表……贴在这里。AI 只会用这里写到的东西。', updSize);

    const readCard = async () => {
        let text = null;
        try { text = await api.cardMaterial?.(); } catch (e) { return api.toast('error', `没读出来：${e.message || e}`); }
        if (!text) return api.toast('warning', '要先打开一张角色卡。群聊里读不了。');
        if (ai.material.trim() && !(await api.confirm('素材框里已经有字了。要换成这张角色卡的内容吗？'))) return;
        ai.material = text;
        material.value = text;
        updSize();
    };

    body.append(
        h('div', { class: 'wce_row' }, btn('← 回到编辑', () => { aiView = false; render(); }), h('h3', {}, 'AI 帮我写')),
        h('div', { class: 'wce_hint' }, '把你手上的设定交给 AI，让它先打个草稿。AI 写好后会先给你看，你说要才会加进剧本；加进来以后还能随便改，点“保存”才会真的存下。'),
        h('h4', {}, '① 素材'),
        material,
        h('div', { class: 'wce_row' }, btn('读取当前角色卡', readCard), size),
        field('想要什么（不填也行）', aiText('wishes', 2, '如：从 1997 年 6 月写到 1998 年底；想要金融风暴、移民潮；写得克制、写实')),
        h('h4', {}, '② 写哪部分'),
        h('div', { class: 'wce_choices' }, E.AI_SCOPES.map(k => h('label', { class: 'wce_choice' + (ai.scope === k ? ' active' : '') },
            h('input', { type: 'radio', name: 'wce_ai_scope', checked: ai.scope === k, onchange: () => { ai.scope = k; render(); } }),
            h('b', {}, AI_SCOPE_INFO[k].label),
            h('div', { class: 'wce_hint' }, AI_SCOPE_INFO[k].desc),
        ))),
        draft.characters.length || draft.events.length
            ? h('div', { class: 'wce_hint' }, `会把剧本里已经有的 ${draft.characters.length} 个角色、${draft.events.length} 个事件告诉 AI，让它接着往下写，不会重复。`)
            : '',
        h('h4', {}, '③ 怎么生成'),
        h('div', { class: 'wce_choices' },
            [['st', '用酒馆当前连接的 AI', '用你平时聊天的那个 AI 直接生成。'], ['other', '用别的 AI', '复制提示词，粘贴到任意聊天 AI（网页版也行），再把回复贴回来。']].map(([k, label, desc]) =>
                h('label', { class: 'wce_choice' + (ai.how === k ? ' active' : '') },
                    h('input', { type: 'radio', name: 'wce_ai_how', checked: ai.how === k, onchange: () => { ai.how = k; render(); } }),
                    h('b', {}, label),
                    h('div', { class: 'wce_hint' }, desc),
                ))),
        ai.how === 'st' ? aiStBox() : aiOtherBox(),
        h('h4', {}, '④ 看结果再决定'),
        aiResultBox(),
    );
}

function aiStBox() {
    const box = h('div', { class: 'wce_card' },
        h('div', { class: 'wce_warn' }, '素材和提示词会发给你在酒馆里连着的 AI 服务（就是平时聊天用的那个），和平常聊天一样会花额度。插件不会读取、也不会保存你的 API 密钥。'),
    );
    if (ai.busy) {
        box.append(h('div', { class: 'wce_row' }, h('span', {}, '正在生成，可能要一两分钟…'), btn('取消', cancelAi, 'redWarningBG')));
    } else {
        box.append(h('div', { class: 'wce_row' }, btn('开始生成', generateWithSt, 'wce_primary')),
            more('ai-st-more', '更多',
                field('AI 最多写多长（tokens）', (() => {
                    const el = h('input', { class: 'text_pole', type: 'number', value: ai.maxTokens });
                    el.addEventListener('input', () => { ai.maxTokens = Math.max(500, Math.floor(Number(el.value) || 8000)); });
                    return el;
                })(), '一般不用动。AI 写到一半断了，就调大一点；AI 服务报错说太长了，就调小一点。'),
            ));
    }
    if (ai.error) box.append(h('div', { class: 'wce_err' }, ai.error));
    return box;
}

async function generateWithSt() {
    if (!api.ai?.generate) return api.toast('error', '你这个版本的酒馆，不让插件直接叫 AI 来写。可以改选“用别的 AI”。');
    if (!ai.material.trim() && !ai.wishes.trim()) return api.toast('warning', '先贴一点素材，或者写下你想要什么，AI 才知道写什么。');
    const run = ++ai.run;
    ai.busy = true;
    ai.error = '';
    ai.result = null;
    render();
    try {
        const reply = await api.ai.generate({ prompt: aiPrompt(), responseLength: ai.maxTokens });
        if (run !== ai.run) return; // 已取消
        ai.reply = reply || '';
        aiParse();
    } catch (e) {
        if (run !== ai.run) return;
        ai.error = `没写成：${aiErrorText(e)}。看看酒馆里的 AI 是不是还连着，或者改选“用别的 AI”。`;
    } finally {
        if (run === ai.run) {
            ai.busy = false;
            if (aiView) render();
        }
    }
}

function cancelAi() {
    ai.run++;
    ai.busy = false;
    ai.error = '已经取消了。';
    try { api.ai?.stop?.(); } catch { /* 取消失败也不影响：结果会被丢弃 */ }
    render();
}

function aiErrorText(e) {
    const msg = e?.message || e?.error?.message || (typeof e?.error === 'string' ? e.error : '') || (typeof e === 'string' ? e : '');
    return String(msg || '说不清哪里出了问题').slice(0, 300);
}

function aiOtherBox() {
    const promptBox = h('textarea', { class: 'text_pole', rows: 6, readonly: true });
    const copy = async () => {
        const text = aiPrompt();
        promptBox.value = text;
        try {
            await navigator.clipboard.writeText(text);
            api.toast('success', '提示词复制好了，去粘贴给任何一个聊天 AI 吧。');
        } catch {
            openMore.add('ai-prompt');
            details.open = true;
            promptBox.select();
            api.toast('warning', '浏览器不让自动复制。请在下面的框里全选，自己复制一下。');
        }
    };
    const details = more('ai-prompt', '看提示词', promptBox);
    details.addEventListener('toggle', () => { if (details.open) promptBox.value = aiPrompt(); });
    if (details.open) promptBox.value = aiPrompt();
    return h('div', { class: 'wce_card' },
        h('div', { class: 'wce_row' }, btn('复制提示词', copy, 'wce_primary'), h('span', { class: 'wce_hint' }, '这样插件不联网，素材只会去你自己粘贴到的地方。')),
        details,
        field('把 AI 的回复整段粘贴到这里', aiText('reply', 6, '直接粘贴就行，AI 在前后说的客套话不用删。')),
        h('div', { class: 'wce_row' }, btn('读取回复', () => { aiParse(); render(); })),
    );
}

function aiParse() {
    ai.result = E.parseAuthoringReply(ai.reply, { scope: ai.scope, material: ai.material, draft });
    ai.result.scope = ai.scope;
}

function aiResultBox() {
    const r = ai.result;
    if (!r) return h('div', { class: 'wce_hint' }, 'AI 写好的东西会出现在这里。你点“加入当前剧本”之前，剧本一点都不会变。');
    const box = h('div', { class: 'wce_card wce_ai_result' });
    box.append(...r.errors.map(e => h('div', { class: 'wce_err' }, '有问题：', e)));
    if (!r.pack) {
        box.append(btn('放弃', discardAi));
        return box;
    }
    const s = E.summarizeResult(r.pack);
    const c = s.counts;
    box.append(h('div', {}, h('b', {}, 'AI 写了：'),
        [['events', '事件'], ['interludes', '小插曲'], ['characters', '角色'], ['relations', '关系'], ['phases', '时代气氛']]
            .filter(([k]) => c[k]).map(([k, label]) => `${label} ${c[k]}`).join(' · ') || '（什么都没写出来）'));
    if (s.timeline.length) {
        box.append(h('div', { class: 'wce_ai_list' }, s.timeline.map(e => h('div', {}, h('code', {}, e.date || '没写日期'), ' ', e.title))));
    }
    if (r.pack.characters.length) box.append(h('div', { class: 'wce_hint' }, '角色：', r.pack.characters.map(x => x.name).join('、')));
    if (r.pack.phases.length) box.append(h('div', { class: 'wce_hint' }, '时代气氛：', r.pack.phases.map(p => `${p.name}（${p.from} ~ ${p.to}）`).join('、')));
    if (r.pack.interludes.length) box.append(h('div', { class: 'wce_hint' }, '小插曲：', r.pack.interludes.slice(0, 5).map(i => i.text.slice(0, 20)).join(' / '), r.pack.interludes.length > 5 ? ' …' : ''));
    const ws = r.warnings;
    box.append(...ws.slice(0, 8).map(w => h('div', { class: 'wce_warn' }, '小提醒：', w)));
    if (ws.length > 8) box.append(h('div', { class: 'wce_warn' }, `……还有 ${ws.length - 8} 条小提醒`));
    const what = { all: '当前剧本', events: '当前的事件', interludes: '当前的小插曲', characters: '当前的角色与关系' }[r.scope];
    box.append(
        h('div', { class: 'wce_hint' }, '加进去以后会回到日历，你可以一条一条看、一条一条改。满意了再点“保存”。'),
        h('div', { class: 'wce_row' },
            btn('加入当前剧本', () => applyAi('merge'), 'wce_primary'),
            btn(`替换${what}`, () => applyAi('replace')),
            btn('放弃', discardAi),
        ),
    );
    return box;
}

async function applyAi(mode) {
    const r = ai.result;
    if (!r?.pack) return;
    let out;
    if (mode === 'replace') {
        const what = { all: '整个剧本', events: '所有事件', interludes: '所有小插曲', characters: '所有角色与关系' }[r.scope];
        if (!(await api.confirm(`用 AI 写的换掉${what}吗？编辑器里原来的这部分会被换掉。别担心：你之前保存过的那份还在，只要不点“保存”就不会变。`))) return;
        out = E.replacePack(draft, r.pack, r.scope);
    } else {
        out = E.mergePacks(draft, r.pack);
    }
    const before = new Set(draft.events.map(e => e.id));
    draft = out.pack;
    const first = draft.events.find(e => !before.has(e.id) && e.date);
    ai.result = null;
    aiView = false;
    tab = 'calendar';
    selected = { type: null, id: null, date: null };
    if (first) jumpTo(first.date);
    else if (draft.meta.start) jumpTo(draft.meta.start);
    touch();
    render();
    out.notes.slice(0, 3).forEach(n => api.toast('info', n));
    api.toast('success', mode === 'replace' ? '换好了。检查一下，没问题再点“保存”。' : '加好了。检查一下，没问题再点“保存”。');
}

function discardAi() {
    ai.result = null;
    ai.error = '';
    render();
}
