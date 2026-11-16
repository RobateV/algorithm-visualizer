#!/usr/bin/env node
/**
 * M2 教师可视化编辑器回归测试
 * 运行：node tests/m2-regression.mjs
 * 可选环境变量：CHROME_PATH / HEADLESS=0 / PORT / CDP_PORT
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8792);
const CDP_PORT = Number(process.env.CDP_PORT || 9413);
const BASE = `http://127.0.0.1:${PORT}`;
const LESSON = `${BASE}/public/lessons/sorting.html`;
const HEADLESS = process.env.HEADLESS !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

function findChrome() {
    if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome'
    ].find((p) => p && existsSync(p)) || null;
}

function startServer() {
    const server = createServer(async (req, res) => {
        try {
            const pathname = decodeURIComponent(new URL(req.url, BASE).pathname);
            const filePath = path.join(ROOT, pathname);
            if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
            const data = await readFile(filePath);
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
            res.end(data);
        } catch { res.writeHead(404).end('not found'); }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, '127.0.0.1', () => resolve(server));
    });
}

async function findPageTarget() {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
            if (res.ok) {
                const list = await res.json();
                const page = list.find((t) => t.type === 'page');
                if (page) return page;
            }
        } catch { /* not ready */ }
        await sleep(250);
    }
    throw new Error('Chrome 调试端口未就绪');
}

class Client {
    constructor(ws) {
        this.ws = ws; this.nextId = 1; this.pending = new Map(); this.errors = [];
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.method === 'Runtime.exceptionThrown' && msg.params?.exceptionDetails) {
                const d = msg.params.exceptionDetails;
                this.errors.push((d.exception && d.exception.description) || d.text || 'exception');
            }
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                else resolve(msg.result);
            }
        };
    }
    static async open(url) {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')); });
        return new Client(ws);
    }
    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (res.exceptionDetails) throw new Error('页面异常: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
        return res.result.value;
    }
    close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function mouseClick(cdp, x, y) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(140);
}

async function center(cdp, expression) {
    return cdp.evaluate(`(() => {
        const el = ${expression};
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
}

async function clickSelector(cdp, selector) {
    const p = await center(cdp, `document.querySelector(${JSON.stringify(selector)})`);
    if (!p) throw new Error('找不到元素: ' + selector);
    await mouseClick(cdp, p.x, p.y);
}

async function pressKey(cdp, key) {
    const map = { ArrowLeft: 37, ArrowRight: 39, ' ': 32 };
    const base = { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: map[key], nativeVirtualKeyCode: map[key] };
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    await sleep(120);
}

async function typeText(cdp, text) {
    await cdp.send('Input.insertText', { text });
    await sleep(150);
}

async function selectAllIn(cdp, selector) {
    await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.focus();
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return true;
    })()`);
}

async function goto(cdp, url) {
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 120; i++) {
        await sleep(100);
        try {
            if ((await cdp.evaluate('document.readyState')) === 'complete') { await sleep(300); return; }
        } catch { /* navigating */ }
    }
    throw new Error('页面加载超时: ' + url);
}

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
}

const field = (cdp, path) => cdp.evaluate(`window.__m2.getFields()[${JSON.stringify(path)}]`);
const setEdit = (cdp, on) => cdp.evaluate(`window.__m2.setEditMode(${on})`);

/* ------------------------------------------------------------------ 测试项 */

async function t1DefaultPlayMode(cdp) {
    await goto(cdp, LESSON + '?stage=intro');
    const state = await cdp.evaluate(`(() => ({
        barHidden: document.getElementById('editor-bar').hidden,
        editing: document.body.classList.contains('is-editing'),
        toggleText: document.getElementById('edit-toggle').textContent.trim(),
        toggleHidden: document.getElementById('edit-toggle').hidden,
        editableCount: document.querySelectorAll('.etext').length
    }))()`);
    check('默认进入放映模式', state.barHidden === true && state.editing === false, JSON.stringify(state));
    check('放映模式仍显示编辑入口', state.toggleHidden === false && state.toggleText.includes('编辑'), state.toggleText);

    await clickSelector(cdp, '.slide-title');
    const stillPlaying = await cdp.evaluate(`(() => ({ ce: document.querySelector('.slide-title').getAttribute('contenteditable'), editing: document.body.classList.contains('is-editing') }))()`);
    check('放映模式点击文字不会进入编辑', stillPlaying.ce === null && stillPlaying.editing === false, JSON.stringify(stillPlaying));
}

async function t2EditAndSync(cdp) {
    await setEdit(cdp, true);
    await sleep(200);
    check('可切换到编辑模式', (await cdp.evaluate(`document.getElementById('editor-bar').hidden`)) === false);

    await clickSelector(cdp, '.slide-title');
    const started = await cdp.evaluate(`(() => {
        const el = document.querySelector('.slide-title');
        return { ce: el.getAttribute('contenteditable'), cls: el.classList.contains('is-editing'), path: el.dataset.edit };
    })()`);
    check('点击标题进入编辑', started.ce === 'plaintext-only' && started.cls, JSON.stringify(started));

    await selectAllIn(cdp, '.slide-title');
    await typeText(cdp, '冒泡排序·教师版');
    check('输入即时写入课程数据', (await field(cdp, 'slides.intro.title')) === '冒泡排序·教师版', await field(cdp, 'slides.intro.title'));

    await clickSelector(cdp, '.pager-info');
    await sleep(450);
    const after = await cdp.evaluate(`(() => ({
        ce: document.querySelector('.slide-title').getAttribute('contenteditable'),
        status: document.getElementById('save-status').dataset.state,
        text: document.querySelector('.slide-title').textContent
    }))()`);
    check('提交后退出编辑态并重新渲染', after.ce === null && after.text === '冒泡排序·教师版', JSON.stringify(after));
    check('保存状态显示已保存', after.status === 'saved', after.status);
}

async function t3KeyboardIsolation(cdp) {
    await clickSelector(cdp, '.slide-title');
    const before = await cdp.evaluate(`document.getElementById('pager-label').textContent`);
    const playBefore = await cdp.evaluate(`(document.getElementById('play-btn') || {}).textContent || ''`);
    await pressKey(cdp, 'ArrowRight');
    await pressKey(cdp, 'ArrowLeft');
    await pressKey(cdp, ' ');
    const after = await cdp.evaluate(`document.getElementById('pager-label').textContent`);
    const playAfter = await cdp.evaluate(`(document.getElementById('play-btn') || {}).textContent || ''`);
    check('编辑时方向键不翻页', before === after, `${before} -> ${after}`);
    check('编辑时空格不触发播放', playBefore === playAfter, `${playBefore} | ${playAfter}`);
    await cdp.evaluate(`document.querySelector('.slide-title').blur && document.querySelector('.slide-title').blur()`);
}

async function t4MultipleFields(cdp) {
    await goto(cdp, LESSON + '?stage=intro');
    await setEdit(cdp, true);
    await sleep(200);

    await clickSelector(cdp, '.q-text');
    await selectAllIn(cdp, '.q-text');
    await typeText(cdp, '课堂问题已改写');
    await clickSelector(cdp, '.pager-info');
    await sleep(300);
    check('可编辑课堂问题', (await field(cdp, 'slides.intro.question')) === '课堂问题已改写');

    // 观察提示
    await clickSelector(cdp, '.intro-points li:nth-child(1) .etext');
    await selectAllIn(cdp, '.intro-points li:nth-child(1) .etext');
    await typeText(cdp, '观察提示一已改写');
    await clickSelector(cdp, '.pager-info');
    await sleep(300);
    check('可编辑观察提示', (await field(cdp, 'slides.intro.hints.h-max.text')) === '观察提示一已改写');

    // 进入原理页，编辑讲解正文
    await cdp.evaluate(`window.__m2.setEditMode(false)`);
    await clickSelector(cdp, '#pager-next');
    await sleep(350);
    await setEdit(cdp, true);
    await sleep(250);

    const bodySelector = '.concept-item .etext[data-edit$=".body"]';
    await clickSelector(cdp, bodySelector);
    await sleep(250);
    await selectAllIn(cdp, bodySelector);
    await typeText(cdp, '讲解正文已改写');
    await clickSelector(cdp, '.pager-info');
    await sleep(350);
    check('可编辑原理讲解正文',
        (await field(cdp, 'slides.principle.steps.p-compare.body')) === '讲解正文已改写',
        await field(cdp, 'slides.principle.steps.p-compare.body'));
}

async function t5Persistence(cdp) {
    await goto(cdp, LESSON + '?stage=intro');
    check('刷新后标题修改仍在', (await cdp.evaluate(`document.querySelector('.slide-title').textContent`)) === '冒泡排序·教师版');
    check('刷新后问题修改仍在', (await cdp.evaluate(`document.querySelector('.q-text').textContent`)) === '课堂问题已改写');

    await cdp.evaluate(`(() => { const s = document.getElementById('algo-select'); s.value = 'merge'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(400);
    await cdp.evaluate(`(() => { const s = document.getElementById('algo-select'); s.value = 'bubble'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(400);
    check('切换算法再切回后修改仍在', (await cdp.evaluate(`document.querySelector('.slide-title').textContent`)) === '冒泡排序·教师版');
}

async function t6Styles(cdp) {
    await setEdit(cdp, true);
    await sleep(200);
    await clickSelector(cdp, '.slide-title');
    await sleep(200);
    await clickSelector(cdp, '[data-size="l"]');
    await clickSelector(cdp, '[data-weight="700"]');
    await clickSelector(cdp, '[data-color="blue"]');
    await sleep(300);

    const cls = await cdp.evaluate(`document.querySelector('.slide-title').className`);
    check('字号/字重/颜色即时生效', /fs-l/.test(cls) && /fw-bold/.test(cls) && /fc-blue/.test(cls), cls);

    const styles = await cdp.evaluate(`window.__m2.getStyles()`);
    check('样式写入持久化数据', styles['slides.intro.title'] && styles['slides.intro.title'].size === 'l', JSON.stringify(styles['slides.intro.title']));

    await clickSelector(cdp, '.pager-info');
    await sleep(300);
    await goto(cdp, LESSON + '?stage=intro');
    const reloaded = await cdp.evaluate(`document.querySelector('.slide-title').className`);
    check('刷新后样式仍在', /fs-l/.test(reloaded) && /fc-blue/.test(reloaded), reloaded);
}

async function t7ExportResetImport(cdp) {
    const exported = await cdp.evaluate(`window.__m2.exportJSON()`);
    let parsed = null;
    try { parsed = JSON.parse(exported); } catch { /* ignore */ }
    check('导出为可解析 JSON', !!parsed && parsed.format === 'dsh-lesson-course' && parsed.courseId === 'bubble-m1', parsed ? parsed.format : 'invalid');
    check('导出包含修改后的字段', !!parsed && parsed.fields['slides.intro.title'] === '冒泡排序·教师版', parsed && parsed.fields['slides.intro.title']);

    await cdp.evaluate(`window.__m2.resetCourse()`);
    await sleep(300);
    check('恢复默认后标题还原', (await cdp.evaluate(`document.querySelector('.slide-title').textContent`)) === '冒泡排序');
    check('恢复默认后样式清空', !/fs-l/.test(await cdp.evaluate(`document.querySelector('.slide-title').className`)));

    const result = await cdp.evaluate(`window.__m2.importJSON(${JSON.stringify(exported)})`);
    await sleep(400);
    check('导入后文案恢复', (await cdp.evaluate(`document.querySelector('.slide-title').textContent`)) === '冒泡排序·教师版', JSON.stringify(result));
    check('导入后样式恢复', /fs-l/.test(await cdp.evaluate(`document.querySelector('.slide-title').className`)));
}

async function t8InvalidImport(cdp) {
    const before = await cdp.evaluate(`JSON.stringify(window.__m2.getFields())`);
    const cases = [
        ['非法 JSON', '{ this is not json'],
        ['结构不符', JSON.stringify({ format: 'other', version: 1, courseId: 'bubble-m1', fields: {} })],
        ['版本不匹配', JSON.stringify({ format: 'dsh-lesson-course', version: 99, courseId: 'bubble-m1', fields: {} })],
        ['课件 ID 不匹配', JSON.stringify({ format: 'dsh-lesson-course', version: 1, courseId: 'other-course', fields: {} })],
        ['字段类型错误', JSON.stringify({ format: 'dsh-lesson-course', version: 1, courseId: 'bubble-m1', fields: { 'slides.intro.title': 123 } })],
        ['字段超长', JSON.stringify({ format: 'dsh-lesson-course', version: 1, courseId: 'bubble-m1', fields: { 'slides.intro.title': 'x'.repeat(500) } })]
    ];
    for (const [label, payload] of cases) {
        const error = await cdp.evaluate(`(() => { try { window.__m2.importJSON(${JSON.stringify(payload)}); return null; } catch (e) { return e.message; } })()`);
        check('拒绝' + label, !!error, error || '(未报错)');
    }
    const after = await cdp.evaluate(`JSON.stringify(window.__m2.getFields())`);
    check('非法导入不改变现有数据', before === after);
}

async function t9HtmlSafety(cdp) {
    const payload = JSON.stringify({
        format: 'dsh-lesson-course', version: 1, courseId: 'bubble-m1',
        fields: { 'slides.intro.title': '<img src=x onerror="window.__xss=1">安全' }
    });
    await cdp.evaluate(`window.__xss = 0; window.__m2.importJSON(${JSON.stringify(payload)})`);
    await sleep(400);
    const state = await cdp.evaluate(`(() => ({
        xss: window.__xss || 0,
        text: document.querySelector('.slide-title').textContent,
        imgs: document.querySelectorAll('.slide-title img').length
    }))()`);
    check('HTML 文本按纯文本显示', state.text.includes('<img') && state.imgs === 0, JSON.stringify(state));
    check('HTML 文本未被执行', state.xss === 0, 'window.__xss=' + state.xss);

    const oversize = 'x'.repeat(600 * 1024);
    const error = await cdp.evaluate(`(() => { try { window.__m2.importJSON(${JSON.stringify(oversize)}); return null; } catch (e) { return e.message; } })()`);
    check('拒绝超大文件', !!error, error || '(未报错)');
}

async function t10WhiteboardAndMode(cdp) {
    // 编辑模式下白板应被禁用
    await cdp.evaluate(`window.__m2.setEditMode(true)`);
    await sleep(200);
    const drawState = await cdp.evaluate(`(() => {
        const btn = document.getElementById('toggle-draw-btn');
        btn.click();
        return { disabled: btn.disabled, mode: document.getElementById('draw-canvas').className, editing: document.body.classList.contains('is-editing') };
    })()`);
    check('编辑模式下白板不可开启', drawState.disabled === true && !String(drawState.mode).includes('drawing-mode'), JSON.stringify(drawState));

    // 退出编辑后可正常开启
    await cdp.evaluate(`window.__m2.setEditMode(false)`);
    await sleep(200);
    const normal = await cdp.evaluate(`(() => {
        const btn = document.getElementById('draw-toggle') || document.getElementById('toggle-draw-btn');
        btn.click();
        return { mode: document.getElementById('draw-canvas').className };
    })()`);
    check('退出编辑后白板可开启', String(normal.mode).includes('drawing-mode'), normal.mode);
    await cdp.evaluate(`(document.getElementById('toggle-draw-btn').click())`);

    // 模式切换保持当前页
    await goto(cdp, LESSON + '?stage=principle');
    await clickSelector(cdp, '#pager-next');
    await sleep(250);
    const before = await cdp.evaluate(`document.getElementById('pager-label').textContent + '|' + document.getElementById('pager-sub').textContent`);
    await setEdit(cdp, true);
    await sleep(200);
    await setEdit(cdp, false);
    await sleep(200);
    const after = await cdp.evaluate(`document.getElementById('pager-label').textContent + '|' + document.getElementById('pager-sub').textContent`);
    check('编辑/放映切换保持当前页', before === after, `${before} -> ${after}`);
}

async function t11ReadonlyRuntimeText(cdp) {
    await goto(cdp, LESSON + '?stage=anim&event=4');
    const state = await cdp.evaluate(`(() => {
        const d = document.getElementById('step-desc');
        return { hasEdit: d ? d.dataset.edit || null : 'missing', text: d ? d.textContent : '' };
    })()`);
    check('运行状态说明保持只读', state.hasEdit === null && state.text.length > 0, JSON.stringify(state));

    await setEdit(cdp, true);
    await sleep(200);
    const editableInAnim = await cdp.evaluate(`document.querySelectorAll('#step-desc[data-edit]').length`);
    check('编辑模式也不提供运行状态编辑', editableInAnim === 0);

    const editableFields = await cdp.evaluate(`Array.from(document.querySelectorAll('.etext')).map(e => e.dataset.edit)`);
    // 纯动画页可编辑项：品牌标题/标签（meta）+ 本页 kicker/title/lead，不含执行状态
    check('纯动画页仅提供课件文案编辑',
        editableFields.length === 5 && editableFields.every(p => !p.startsWith('slides.anim.steps') && !p.includes('desc')),
        editableFields.join(', '));
}

async function waitReady(cdp) {
    for (let i = 0; i < 120; i++) {
        await sleep(100);
        try {
            if ((await cdp.evaluate('document.readyState')) === 'complete') { await sleep(250); return; }
        } catch { /* 导航中上下文会短暂失效 */ }
    }
    throw new Error('页面重新加载超时');
}

async function t12CaretAndSwitching(cdp) {
    await goto(cdp, LESSON + '?stage=intro');
    await cdp.evaluate(`window.__m2.resetCourse()`);
    await sleep(250);
    await setEdit(cdp, true);
    await sleep(300);

    const rect = await cdp.evaluate(`(() => {
        const r = document.querySelector('.slide-title').getBoundingClientRect();
        return { left: r.left, right: r.right, y: r.top + r.height / 2 };
    })()`);

    // 首次点击：应进入编辑，且光标落在点击位置（左边缘），不是末尾
    await mouseClick(cdp, rect.left + 4, rect.y);
    await sleep(220);
    const first = await cdp.evaluate(`(() => {
        const el = document.querySelector('.slide-title');
        return { ce: el.getAttribute('contenteditable'), offset: getSelection().anchorOffset, len: el.textContent.length };
    })()`);
    check('首次点击进入编辑', first.ce === 'plaintext-only', JSON.stringify(first));
    check('首次点击光标落在点击处而非末尾', first.offset === 0, `offset=${first.offset}/${first.len}`);

    // 光标处插入一个字符，验证确实按定位输入
    await cdp.send('Input.insertText', { text: '新' });
    await sleep(150);
    const typed = await cdp.evaluate(`document.querySelector('.slide-title').textContent`);
    check('可在光标定位处输入', typed.startsWith('新'), typed);

    // 再次点击同一字段：内容不得被重置
    await mouseClick(cdp, rect.left + 4, rect.y);
    await sleep(220);
    const again = await cdp.evaluate(`(() => ({
        text: document.querySelector('.slide-title').textContent,
        offset: getSelection().anchorOffset,
        ce: document.querySelector('.slide-title').getAttribute('contenteditable')
    }))()`);
    check('同字段再次点击不重置内容', again.text === typed && again.ce === 'plaintext-only', `${typed} -> ${again.text}`);
    check('同字段再次点击光标不回跳末尾', again.offset < again.text.length, `offset=${again.offset}/${again.text.length}`);

    // A → B 单击切换（不得需要点两次）
    await clickSelector(cdp, '.q-text');
    await sleep(280);
    const switched = await cdp.evaluate(`(() => ({
        active: window.__m2.getState().activeField,
        a: document.querySelector('.slide-title').getAttribute('contenteditable'),
        b: document.querySelector('.q-text').getAttribute('contenteditable')
    }))()`);
    check('A→B 单击即可切换编辑',
        switched.active === 'slides.intro.question' && switched.b === 'plaintext-only' && switched.a === null,
        JSON.stringify(switched));

    // 切换后字段内容保留
    check('切走字段内容未丢失', (await field(cdp, 'slides.intro.title')) === typed, await field(cdp, 'slides.intro.title'));
}

async function t13SaveOnUnload(cdp) {
    await goto(cdp, LESSON + '?stage=intro');
    await cdp.evaluate(`window.__m2.resetCourse()`);
    await sleep(250);
    await setEdit(cdp, true);
    await sleep(300);

    await clickSelector(cdp, '.slide-title');
    await selectAllIn(cdp, '.slide-title');
    // 输入后不等待 320ms 防抖，立刻刷新
    await cdp.send('Input.insertText', { text: '立即刷新也要保留' });
    await cdp.send('Page.reload');
    await waitReady(cdp);
    check('输入后立即刷新不丢最新内容',
        (await cdp.evaluate(`document.querySelector('.slide-title').textContent`)) === '立即刷新也要保留',
        await cdp.evaluate(`document.querySelector('.slide-title').textContent`));

    // 输入后立刻导航离开，再回来
    await cdp.evaluate(`window.__m2.setEditMode(true)`);
    await sleep(300);
    await clickSelector(cdp, '.slide-title');
    await selectAllIn(cdp, '.slide-title');
    await cdp.send('Input.insertText', { text: '导航前也要保留' });
    await cdp.send('Page.navigate', { url: LESSON + '?stage=summary' });
    await waitReady(cdp);
    await cdp.send('Page.navigate', { url: LESSON + '?stage=intro' });
    await waitReady(cdp);
    check('输入后立即离开页面也不丢内容',
        (await cdp.evaluate(`document.querySelector('.slide-title').textContent`)) === '导航前也要保留',
        await cdp.evaluate(`document.querySelector('.slide-title').textContent`));
}

/* -------------------------------------------------------------------- 主流程 */

async function main() {
    const chrome = findChrome();
    if (!chrome) { console.error('未找到 Chrome/Edge，请设置 CHROME_PATH'); process.exit(2); }

    const server = await startServer();
    const profile = path.join(process.env.TEMP || '/tmp', 'm2-regression-' + Date.now());
    const args = [
        `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--window-size=1366,768', 'about:blank'
    ];
    if (HEADLESS) args.unshift('--headless=new');

    const proc = spawn(chrome, args, { stdio: 'ignore' });
    let cdp;
    try {
        const target = await findPageTarget();
        cdp = await Client.open(target.webSocketDebuggerUrl);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

        const suites = [
            { title: '默认放映模式', run: t1DefaultPlayMode },
            { title: '编辑并即时同步', run: t2EditAndSync },
            { title: '输入焦点键盘隔离', run: t3KeyboardIsolation },
            { title: '多字段编辑', run: t4MultipleFields },
            { title: '持久化', run: t5Persistence },
            { title: '文字样式', run: t6Styles },
            { title: '导出/恢复/导入', run: t7ExportResetImport },
            { title: '非法导入', run: t8InvalidImport },
            { title: 'HTML 与超大文件', run: t9HtmlSafety },
            { title: '白板与模式切换', run: t10WhiteboardAndMode },
            { title: '只读运行文本', run: t11ReadonlyRuntimeText },
            { title: '光标与字段切换', run: t12CaretAndSwitching },
            { title: '离开页面前落盘', run: t13SaveOnUnload }
        ];
        for (const suite of suites) {
            try { await suite.run(cdp); }
            catch (err) { check(suite.title + ' · 执行异常', false, err.message); }
        }
        if (cdp.errors.length) check('页面无未捕获异常', false, cdp.errors.join(' | '));
        else check('页面无未捕获异常', true);
    } finally {
        if (cdp) cdp.close();
        try { proc.kill(); } catch { /* ignore */ }
        server.close();
    }

    const width = Math.max(...results.map((r) => [...r.name].length)) + 2;
    for (const r of results) {
        const pad = width - [...r.name].length;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${' '.repeat(Math.max(pad, 1))}${r.detail}`);
    }
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项。`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('M2 回归测试启动失败: ' + err.message);
    process.exit(2);
});
