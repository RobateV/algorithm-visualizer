#!/usr/bin/env node
/**
 * M1 回归测试 —— 用真实 Chrome（通过 CDP 驱动）验证「冒泡排序教学课件」的交互行为。
 *
 * 运行：
 *   node tests/m1-regression.mjs
 *
 * 可选环境变量：
 *   CHROME_PATH   指定浏览器可执行文件（默认自动探测 Chrome / Edge）
 *   HEADLESS=0    显示浏览器窗口（调试用，默认无头）
 *   PORT          静态服务器端口（默认 8791）
 *   CDP_PORT      调试端口（默认 9412）
 *
 * 退出码：全部通过为 0，存在失败为 1。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8791);
const CDP_PORT = Number(process.env.CDP_PORT || 9412);
const BASE = `http://127.0.0.1:${PORT}`;
const LESSON = `${BASE}/public/lessons/sorting.html`;
const HEADLESS = process.env.HEADLESS !== '0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8'
};

/* ---------------------------------------------------------------- 环境准备 */

function findChrome() {
    if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium'
    ];
    return candidates.find((p) => p && existsSync(p)) || null;
}

function startServer() {
    const server = createServer(async (req, res) => {
        try {
            const pathname = decodeURIComponent(new URL(req.url, BASE).pathname);
            const filePath = path.join(ROOT, pathname);
            if (!filePath.startsWith(ROOT)) {
                res.writeHead(403).end('forbidden');
                return;
            }
            const data = await readFile(filePath);
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
            res.end(data);
        } catch {
            res.writeHead(404).end('not found');
        }
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
        } catch {
            /* 调试端口还没起来 */
        }
        await sleep(250);
    }
    throw new Error('Chrome 调试端口未就绪，请检查 CHROME_PATH');
}

/* ------------------------------------------------------------------ CDP 封装 */

class Client {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
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
        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = () => reject(new Error('无法连接 CDP WebSocket'));
        });
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
        const res = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true
        });
        if (res.exceptionDetails) {
            const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
            throw new Error('页面脚本异常: ' + detail);
        }
        return res.result.value;
    }

    close() {
        try { this.ws.close(); } catch { /* ignore */ }
    }
}

/* --------------------------------------------------------------- 输入模拟 */

const VK = { ArrowLeft: 37, ArrowRight: 39 };

async function pressKey(cdp, key, shift = false) {
    const vk = VK[key];
    const modifiers = shift ? 8 : 0;
    const base = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    await sleep(90);
}

async function mouseClick(cdp, x, y) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
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

async function clickByText(cdp, selector, text) {
    const p = await center(
        cdp,
        `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => e.textContent.includes(${JSON.stringify(text)}))`
    );
    if (!p) throw new Error(`找不到文本为「${text}」的元素`);
    await mouseClick(cdp, p.x, p.y);
}

async function goto(cdp, url) {
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 120; i++) {
        await sleep(100);
        try {
            if ((await cdp.evaluate('document.readyState')) === 'complete') {
                await sleep(260);
                return;
            }
        } catch {
            /* 导航中上下文会短暂失效 */
        }
    }
    throw new Error('页面加载超时: ' + url);
}

/* ------------------------------------------------------------------ 断言 */

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
}

/* ------------------------------------------------------------------ 测试项 */

const stageLabel = (cdp) => cdp.evaluate(`document.getElementById('pager-label').textContent.trim()`);
const stepBadge = (cdp) => cdp.evaluate(`(document.getElementById('step-badge') || {}).textContent || ''`);
// 编号改版后，步数从 data-step 读取（1-based），不再依赖徽标文案
const stepNumber = async (cdp) => {
    const value = await cdp.evaluate(`(() => {
        const b = document.getElementById('step-badge');
        return b && b.dataset.step ? Number(b.dataset.step) : -1;
    })()`);
    return typeof value === 'number' ? value : -1;
};

async function t1CoursePaging(cdp) {
    await goto(cdp, LESSON + '?stage=intro');
    const labels = [await stageLabel(cdp)];
    for (let i = 0; i < 6; i++) {
        await pressKey(cdp, 'ArrowRight');
        await sleep(60);
        labels.push(await stageLabel(cdp));
    }
    const joined = labels.join(' > ');
    check('T1 引入环节为首页', labels[0].includes('引入'), labels[0]);
    check('T1 键盘可走完五环节', /引入[\s\S]*原理[\s\S]*纯动画[\s\S]*动画 \+ 代码[\s\S]*总结/.test(joined), joined);
}

async function t2BubbleCourseKeys(cdp) {
    await goto(cdp, LESSON + '?stage=anim');
    const before = await stepNumber(cdp);
    await pressKey(cdp, 'ArrowRight', true);
    const afterShift = await stepNumber(cdp);
    check('T2 Shift+→ 在纯动画切执行步', afterShift === before + 1, `${before} → ${afterShift}`);

    const pageBefore = await stageLabel(cdp);
    await pressKey(cdp, 'ArrowLeft');
    const pageAfter = await stageLabel(cdp);
    check('T2 ← 在冒泡课件翻教学页', pageAfter !== pageBefore, `${pageBefore} → ${pageAfter}`);
}

async function t3ClassicKeyboard(cdp) {
    const algos = [
        ['selection', '选择排序'],
        ['insertion', '插入排序'],
        ['merge', '归并排序'],
        ['quick', '快速排序'],
        ['counting', '计数排序'],
        ['radix', '基数排序']
    ];
    for (const [key, name] of algos) {
        await goto(cdp, `${LESSON}?algo=${key}`);
        const s0 = await stepNumber(cdp);
        await pressKey(cdp, 'ArrowRight');
        const s1 = await stepNumber(cdp);
        await pressKey(cdp, 'ArrowRight');
        const s2 = await stepNumber(cdp);
        await pressKey(cdp, 'ArrowLeft');
        const s3 = await stepNumber(cdp);
        check(
            `T3 ${name} 方向键单步可用`,
            s0 === 1 && s1 === 2 && s2 === 3 && s3 === 2,
            `1→${s1}→${s2}→后退${s3}`
        );
    }

    // 首帧按 ← 不应越界，也不应抛错
    await goto(cdp, LESSON + '?algo=merge');
    await pressKey(cdp, 'ArrowLeft');
    check('T3 经典模式边界不越界', (await stepNumber(cdp)) === 1, await stepBadge(cdp));
}

async function t4AutoplayStops(cdp) {
    await goto(cdp, LESSON + '?stage=anim');
    await clickSelector(cdp, '#play-btn');
    const playingLabel = await cdp.evaluate(`document.getElementById('play-btn').textContent.trim()`);
    await sleep(900);
    const moved = await stepNumber(cdp);

    // 直接切到「原理」环节
    const chip = await center(cdp, `document.querySelectorAll('.stage-chip')[1]`);
    await mouseClick(cdp, chip.x, chip.y);
    await sleep(250);

    // 回到纯动画，观察是否已经停播
    const chip2 = await center(cdp, `document.querySelectorAll('.stage-chip')[2]`);
    await mouseClick(cdp, chip2.x, chip2.y);
    const stoppedLabel = await cdp.evaluate(`document.getElementById('play-btn').textContent.trim()`);
    const atReturn = await stepNumber(cdp);
    await sleep(900);
    const later = await stepNumber(cdp);

    check('T4 播放会推进执行步', moved > 1, `1 → ${moved}（播放按钮：${playingLabel}）`);
    check('T4 切换环节后自动停播', stoppedLabel.includes('播放') && !stoppedLabel.includes('暂停'), stoppedLabel);
    check('T4 停播后执行步不再变化', atReturn === later, `${atReturn} → ${later}`);
}

async function t5Fullscreen(cdp) {
    await goto(cdp, LESSON + '?stage=code');
    await clickSelector(cdp, '#fullscreen-btn');
    await sleep(700);
    const entered = await cdp.evaluate('!!document.fullscreenElement');
    const labelIn = await cdp.evaluate(`document.getElementById('fullscreen-btn').textContent.trim()`);
    check('T5 独立页面可进入全屏', entered, labelIn);

    await clickSelector(cdp, '#fullscreen-btn');
    await sleep(700);
    const exited = await cdp.evaluate('!!document.fullscreenElement');
    const labelOut = await cdp.evaluate(`document.getElementById('fullscreen-btn').textContent.trim()`);
    check('T5 可退出全屏', !exited, labelOut);
}

async function t6Whiteboard(cdp) {
    await goto(cdp, LESSON + '?stage=anim');

    const pixelCount = () => cdp.evaluate(`(() => {
        const c = document.getElementById('draw-canvas');
        const g = c.getContext('2d');
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
    })()`);

    await clickSelector(cdp, '#toggle-draw-btn');
    const modeOn = await cdp.evaluate(`document.getElementById('draw-canvas').className`);
    check('T6 白板可开启', modeOn.includes('drawing-mode'), modeOn);

    // 画笔：画一条水平线
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 320, y: 300, button: 'left', clickCount: 1 });
    for (let x = 340; x <= 620; x += 20) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 300, button: 'left' });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 620, y: 300, button: 'left', clickCount: 1 });
    await sleep(200);
    const afterDraw = await pixelCount();
    check('T6 画笔可绘制', afterDraw > 500, `像素 ${afterDraw}`);

    // 橡皮：擦同一条线
    await clickByText(cdp, '#draw-tools-panel .tool-btn', '橡皮');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 320, y: 300, button: 'left', clickCount: 1 });
    for (let x = 340; x <= 620; x += 20) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 300, button: 'left' });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 620, y: 300, button: 'left', clickCount: 1 });
    await sleep(200);
    const afterErase = await pixelCount();
    check('T6 橡皮可擦除', afterErase < afterDraw, `${afterDraw} → ${afterErase}`);

    // 重新画一小段，然后撤销
    await clickSelector(cdp, '#draw-tools-panel .color-dot');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 420, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 780, y: 460, button: 'left' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 780, y: 460, button: 'left', clickCount: 1 });
    await sleep(200);
    const beforeUndo = await pixelCount();
    await clickByText(cdp, '#draw-tools-panel .tool-btn', '撤销');
    await sleep(300);
    const afterUndo = await pixelCount();
    check('T6 撤销可回退一笔', afterUndo < beforeUndo, `${beforeUndo} → ${afterUndo}`);

    await clickByText(cdp, '#draw-tools-panel .tool-btn', '清屏');
    await sleep(250);
    const afterClear = await pixelCount();
    check('T6 清屏可清空画布', afterClear === 0, `像素 ${afterClear}`);

    // 白板开启状态下翻页（导航层必须高于画布）
    const pageBefore = await stageLabel(cdp);
    await clickSelector(cdp, '#pager-next');
    const pageAfter = await stageLabel(cdp);
    check('T6 白板开启时仍可点击翻页', pageAfter !== pageBefore, `${pageBefore} → ${pageAfter}`);

    // 关闭白板
    await clickSelector(cdp, '#toggle-draw-btn');
    const modeOff = await cdp.evaluate(`document.getElementById('draw-canvas').className`);
    check('T6 白板可关闭', !modeOff.includes('drawing-mode'), modeOff || '(空)');
}

async function t7Iframe(cdp) {
    await goto(cdp, `${BASE}/tests/iframe-harness.html`);
    await cdp.evaluate(`document.getElementById('lesson').contentDocument.readyState`);
    await sleep(900);

    const frameLoaded = await cdp.evaluate(
        `!!document.getElementById('lesson').contentDocument.getElementById('fullscreen-btn')`
    );
    check('T7 iframe 内课件已加载', frameLoaded);

    const box = await cdp.evaluate(`(() => {
        const f = document.getElementById('lesson');
        const r = f.getBoundingClientRect();
        const b = f.contentDocument.getElementById('fullscreen-btn').getBoundingClientRect();
        return { x: r.left + b.left + b.width / 2, y: r.top + b.top + b.height / 2 };
    })()`);
    await mouseClick(cdp, box.x, box.y);
    await sleep(900);

    const topFullscreen = await cdp.evaluate('!!document.fullscreenElement');
    const msgsAfterEnter = await cdp.evaluate('window.__msgs.slice()');
    check('T7 iframe 内可进入全屏（allow=fullscreen）', topFullscreen, JSON.stringify(msgsAfterEnter));
    check('T7 全屏进入向父页面发送消息', msgsAfterEnter.includes('enter'), JSON.stringify(msgsAfterEnter));

    await cdp.evaluate('document.exitFullscreen && document.exitFullscreen()');
    await sleep(900);
    const msgsAfterExit = await cdp.evaluate('window.__msgs.slice()');
    check('T7 退出全屏向父页面发送消息', msgsAfterExit.includes('exit'), JSON.stringify(msgsAfterExit));
}

async function t8Numbering(cdp) {
    const read = () => cdp.evaluate(`(() => {
        const badge = document.getElementById('step-badge');
        const id = document.getElementById('step-id');
        const page = document.getElementById('page-code');
        const copyStep = document.getElementById('copy-step');
        const copyLink = document.getElementById('copy-link');
        return {
            badge: badge ? badge.textContent : null,
            step: badge ? Number(badge.dataset.step) : null,
            total: badge ? Number(badge.dataset.total) : null,
            identity: id ? id.textContent : null,
            page: page ? page.textContent : null,
            copy: copyStep ? copyStep.dataset.copy : null,
            link: copyLink ? copyLink.dataset.copy : null
        };
    })()`);

    await goto(cdp, LESSON + '?stage=anim&event=7');
    const anim = await read();
    check('T8 环节页码独立于执行步显示', anim.page === 'P03 · 纯动画', anim.page);
    check('T8 执行步编号可引用', anim.badge === 'BUB-S007', anim.badge);
    check('T8 状态卡显示完整编号', anim.identity === '第 007 / 062 步 · BUB-S007', anim.identity);
    check('T8 复制内容包含算法/页码/编号/指针', /^冒泡排序｜P03 纯动画｜BUB-S007｜.*｜i=\d+,j=\d+$/.test(anim.copy || ''), anim.copy);
    check('T8 复制链接使用 1-based event', /[?&]event=7(&|$)/.test(anim.link || ''), anim.link);

    await goto(cdp, LESSON + '?stage=code&event=7');
    const code = await read();
    check('T8 同一执行步在联动页编号一致', code.identity === anim.identity, code.identity);
    check('T8 联动页页码不同', code.page === 'P04 · 动画 + 代码', code.page);

    // ?step= 保持 0-based，?event= 为 1-based，两者必须指向同一步
    await goto(cdp, LESSON + '?stage=anim&step=6');
    const viaStep = await read();
    check('T8 旧 ?step= 语义未变且与新参数等价',
        viaStep.step === 7 && viaStep.identity === anim.identity,
        `?step=6 → ${viaStep.identity}`);

    await goto(cdp, LESSON + '?stage=anim&event=9999');
    const clamped = await read();
    check('T8 event 越界钳制到末步', clamped.step === clamped.total, `${clamped.step}/${clamped.total}`);

    await goto(cdp, LESSON + '?algo=selection&event=3');
    const classic = await read();
    check('T8 经典演示使用算法前缀编号', classic.badge === 'SEL-S003', classic.badge);
    check('T8 经典演示页码显示为经典演示', classic.page === '经典演示', classic.page);

    // 前进/回退后编号必须与执行位置同步
    await goto(cdp, LESSON + '?stage=anim&event=1');
    await pressKey(cdp, 'ArrowRight', true);
    await pressKey(cdp, 'ArrowRight', true);
    const afterNext = await read();
    await pressKey(cdp, 'ArrowLeft', true);
    const afterPrev = await read();
    check('T8 前进/回退后编号同步',
        afterNext.step === 3 && afterNext.badge === 'BUB-S003' && afterPrev.step === 2 && afterPrev.badge === 'BUB-S002',
        `${afterNext.badge} → ${afterPrev.badge}`);
}

async function t9PointerMotion(cdp) {
    // event=4 是 j=1 的交换步，下一步 j 走到 2，指针必须跨位移动
    await goto(cdp, LESSON + '?stage=anim&event=4');
    await sleep(400);

    // 采样指针位置，同时触发一步
    const sampling = cdp.evaluate(`(async () => {
        const out = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 900) {
            const el = document.querySelector('.pvar[data-var="j"]');
            if (el) {
                const r = el.getBoundingClientRect();
                out.push({ t: Math.round(performance.now() - t0), x: Math.round(r.left + r.width / 2) });
            }
            await new Promise(res => requestAnimationFrame(res));
        }
        return out;
    })()`);
    await sleep(80);
    await pressKey(cdp, 'ArrowRight', true);
    const samples = await sampling;

    const xs = samples.map((s) => s.x);
    const unique = Array.from(new Set(xs));
    const start = xs[0];
    const end = xs[xs.length - 1];
    const span = Math.abs(end - start);
    let maxJump = 0;
    for (let i = 1; i < xs.length; i++) maxJump = Math.max(maxJump, Math.abs(xs[i] - xs[i - 1]));
    const hasMid = unique.some((x) => x > Math.min(start, end) + 2 && x < Math.max(start, end) - 2);

    check('T9 指针目标位置确实变化', span > 20, `${start} → ${end}（${span}px）`);
    check('T9 指针平滑移动而非瞬移',
        hasMid && maxJump < span * 0.75,
        `中间帧 ${unique.length} 个，最大单帧位移 ${maxJump}px / 总位移 ${span}px`);

    // 指针必须指向数组索引，而不是跟随元素身份
    const align = await cdp.evaluate(`(() => {
        const el = document.querySelector('.pvar[data-var="j"]');
        const idx = Number(el.dataset.index);
        const wrapper = document.querySelectorAll('.bar-wrapper')[idx - 1];
        if (!wrapper) return { ok: false, idx: idx };
        const pr = el.getBoundingClientRect();
        const wr = wrapper.getBoundingClientRect();
        return {
            ok: Math.abs((pr.left + pr.width / 2) - (wr.left + wr.width / 2)) < 3,
            idx: idx,
            delta: Math.round((pr.left + pr.width / 2) - (wr.left + wr.width / 2))
        };
    })()`);
    check('T9 指针与目标索引柱位对齐', align.ok, `index=${align.idx}，偏差 ${align.delta}px`);

    // 快速连续步进：不允许出现残影或额外指针
    for (let i = 0; i < 6; i++) await pressKey(cdp, 'ArrowRight', true);
    await sleep(500);
    const count = await cdp.evaluate(`document.querySelectorAll('.pvar').length`);
    const names = await cdp.evaluate(`Array.from(document.querySelectorAll('.pvar')).map(e => e.dataset.var).join(',')`);
    check('T9 连续步进后无残影', count === 2, `指针数 ${count}（${names}）`);

    // 切到原理页应清空指针层
    const chip = await center(cdp, `document.querySelectorAll('.stage-chip')[1]`);
    await mouseClick(cdp, chip.x, chip.y);
    await sleep(300);
    const remaining = await cdp.evaluate(`document.querySelectorAll('.pvar').length`);
    check('T9 离开动画环节指针不残留', remaining === 0, `剩余 ${remaining}`);
}

/* ------------------------------------------------------------------ 原理页布局 */

async function measurePrinciple(cdp) {
    return cdp.evaluate(`(() => {
        const fig = document.querySelector('.figure-card');
        const nums = document.querySelector('.figure-nums');
        const stack = document.querySelector('.concept-stack');
        const card = document.querySelector('.slide-card');
        if (!fig || !nums || !stack) return null;
        const f = fig.getBoundingClientRect();
        const n = nums.getBoundingClientRect();
        const s = stack.getBoundingClientRect();
        return {
            figTop: f.top,
            figHeight: f.height,
            numCenterY: n.top + n.height / 2,
            stackTop: s.top,
            stackBottom: s.bottom,
            revealed: document.querySelectorAll('.concept-item.is-revealed').length,
            slots: document.querySelectorAll('.concept-item').length,
            headings: Array.from(document.querySelectorAll('.concept-item.is-revealed h3')).map(e => e.textContent),
            page: (document.getElementById('page-code') || {}).textContent,
            subLabel: (document.getElementById('pager-sub') || {}).textContent,
            overflow: card ? card.scrollHeight - card.clientHeight : 0
        };
    })()`);
}

/** 依次走 1/3 → 2/3 → 3/3 → 2/3 → 1/3，返回五次测量结果 */
async function walkPrinciple(cdp) {
    await goto(cdp, LESSON + '?stage=principle');
    await sleep(320);
    const seq = [await measurePrinciple(cdp)];
    for (let i = 0; i < 2; i++) {
        await clickSelector(cdp, '#pager-next');
        await sleep(280);
        seq.push(await measurePrinciple(cdp));
    }
    for (let i = 0; i < 2; i++) {
        await clickSelector(cdp, '#pager-prev');
        await sleep(280);
        seq.push(await measurePrinciple(cdp));
    }
    return seq;
}

function spreadOf(seq, key) {
    const values = seq.map((r) => r[key]);
    return Math.max(...values) - Math.min(...values);
}

async function t10PrincipleLayout(cdp) {
    const tol = 3;
    const seq = await walkPrinciple(cdp);

    const stable = (key) => spreadOf(seq, key) <= tol;
    check('T10 图示区顶部稳定', stable('figTop'), `Δ=${spreadOf(seq, 'figTop').toFixed(1)}px`);
    check('T10 图示区高度稳定', stable('figHeight'), `Δ=${spreadOf(seq, 'figHeight').toFixed(1)}px`);
    check('T10 数字中心 Y 稳定', stable('numCenterY'), `Δ=${spreadOf(seq, 'numCenterY').toFixed(1)}px`);
    check('T10 说明区上下边界稳定',
        stable('stackTop') && stable('stackBottom'),
        `top Δ=${spreadOf(seq, 'stackTop').toFixed(1)}px，bottom Δ=${spreadOf(seq, 'stackBottom').toFixed(1)}px`);

    check('T10 三条讲解依次揭晓并可回退',
        JSON.stringify(seq.map((r) => r.revealed)) === JSON.stringify([1, 2, 3, 2, 1]),
        JSON.stringify(seq.map((r) => r.revealed)));

    check('T10 讲解文字正确',
        JSON.stringify(seq[2].headings) === JSON.stringify(['相邻比较', '必要时交换', '一趟落位']),
        seq[2].headings.join(' / '));

    check('T10 三个槽位常驻不增删',
        seq.every((r) => r.slots === 3),
        seq.map((r) => r.slots).join(','));

    check('T10 页码与讲解进度正确',
        seq[0].page === 'P02 · 原理' && seq[0].subLabel === '讲解 1 / 3' && seq[4].subLabel === '讲解 1 / 3',
        `${seq[0].page}｜${seq[0].subLabel}`);

    check('T10 原理页无纵向溢出',
        seq.every((r) => r.overflow <= 2),
        `最大溢出 ${Math.max(...seq.map((r) => r.overflow))}px`);

    // 720px 高的 iframe 场景：同样不允许跳动
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 720, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    const compact = await walkPrinciple(cdp);
    check('T10 720px iframe 下图示与说明同样稳定',
        spreadOf(compact, 'figTop') <= tol && spreadOf(compact, 'numCenterY') <= tol && spreadOf(compact, 'stackTop') <= tol,
        `figTop Δ=${spreadOf(compact, 'figTop').toFixed(1)}，num Δ=${spreadOf(compact, 'numCenterY').toFixed(1)}，stack Δ=${spreadOf(compact, 'stackTop').toFixed(1)}`);
    check('T10 720px iframe 下不裁切',
        compact.every((r) => r.overflow <= 2),
        `最大溢出 ${Math.max(...compact.map((r) => r.overflow))}px`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
}

/* -------------------------------------------------------------------- 主流程 */
async function main() {
    const chrome = findChrome();
    if (!chrome) {
        console.error('未找到 Chrome/Edge，请设置 CHROME_PATH 环境变量后重试。');
        process.exit(2);
    }

    const server = await startServer();
    const profile = path.join(process.env.TEMP || '/tmp', 'm1-regression-' + Date.now());
    const args = [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--window-size=1366,768',
        'about:blank'
    ];
    if (HEADLESS) args.unshift('--headless=new');

    const proc = spawn(chrome, args, { stdio: 'ignore' });

    let cdp;
    try {
        const target = await findPageTarget();
        cdp = await Client.open(target.webSocketDebuggerUrl);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');

        const suites = [
            { title: '课件翻页', run: t1CoursePaging },
            { title: '冒泡键盘分工', run: t2BubbleCourseKeys },
            { title: '经典模式方向键', run: t3ClassicKeyboard },
            { title: '自动播放停止', run: t4AutoplayStops },
            { title: '全屏', run: t5Fullscreen },
            { title: '白板', run: t6Whiteboard },
            { title: 'iframe 与 postMessage', run: t7Iframe },
            { title: '步骤编号体系', run: t8Numbering },
            { title: '指针平滑运动', run: t9PointerMotion },
            { title: '原理页布局稳定', run: t10PrincipleLayout }
        ];

        for (const suite of suites) {
            try {
                await suite.run(cdp);
            } catch (err) {
                check(suite.title + ' · 执行异常', false, err.message);
            }
        }
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
    console.error('回归测试启动失败: ' + err.message);
    process.exit(2);
});
