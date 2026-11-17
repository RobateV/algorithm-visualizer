import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ListenerState, withLock } from './local-listener.mjs';
import { HERE, PROJECT, git } from './local-runner.mjs';

const validChat = (s) => typeof s === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s);
const safeId = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(s);

export function validateRelayConfig(config, now = Date.now()) {
  const since = Date.parse(config.activatedAt), expires = Date.parse(config.expiresAt);
  if (config.version !== 2 || !/^[a-f0-9]{64}$/.test(config.token || '') || !validChat(config.chatId) || config.port !== 17321 ||
      !Number.isFinite(since) || since > now || !Number.isFinite(expires) || expires <= now || expires - since > 86400000 ||
      !Number.isInteger(config.maxNotifications) || config.maxNotifications < 1 || config.maxNotifications > 10) throw new Error('通知配置未激活、已到期或超出授权上限');
}

export function infrastructureReviewPacket(chatId, commit) {
  if (!validChat(chatId) || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('复审目标或 SHA 不合法');
  const id = `infrastructure-review:${commit}`, marker = `[LOCAL-DSH-NOTIFY:${id}]`;
  return { id, marker, chatId, message: `${marker}\n这是一条经用户授权的浏览器桥接/基础设施复审请求，不是 DSH 刚完成教材任务的通知。请作为原 ChatGPT 独立审查者，读取 https://github.com/RobateV/algorithm-visualizer/pull/23 的实际 commit ${commit}，核对代码、测试证据与风险；将绑定该完整 SHA 的独立审查意见写入 PR #23，并在本聊天回复。不要把本消息或 Codex 报告当成审查通过。\n代码与记录：https://github.com/RobateV/algorithm-visualizer/tree/${commit}/tools/dsh-event-bridge\n只审查基础设施，不发布或执行真实教材/0x03 任务，不启用本地执行/推送/回传，不修改定时任务，不修改 main，不合并 PR。若 GitHub 工具不可用或无法确认源码，请如实说明，不声称已完成审查。` };
}

export function relayPackets(state, chatId, { since } = {}) {
  if (!validChat(chatId)) throw new Error('目标聊天未配置');
  return Object.values(state.tasks || {}).filter((r) => !r.legacy && safeId(r.taskId) && safeId(r.rootTaskId) &&
    ['reported', 'failed', 'blocked'].includes(r.status) &&
    typeof r.resultUrl === 'string' && /^https:\/\/github\.com\/RobateV\/algorithm-visualizer\/issues\/21#issuecomment-\d+$/.test(r.resultUrl) &&
    (r.commit == null || /^[0-9a-f]{40}$/.test(r.commit)) &&
    (since == null || Date.parse(r.updatedAt || r.startedAt) >= since)).map((r) => {
      const id = `${r.taskId}:${r.commit || 'failed'}`;
      const marker = `[LOCAL-DSH-NOTIFY:${id}]`;
      const verdict = r.status === 'reported' && r.commit
        ? `请独立核验实际 commit、diff、测试和适用的视觉证据。审查结论需写到 Issue #21，并绑定以下格式：\n[LOCAL-DSH-REVIEW]\ntask_id: ${r.taskId}\ncommit: ${r.commit}\nverdict: <只填 accept 或 rework>\n---\n审查依据与待修改问题。\n若返工，在原根授权有效期、文件/教材范围、剩余轮数和调用次数内，发布新 task_id 的 [LOCAL-DSH-TASK]，绑定已推送结果分支和完整 SHA；保留原任务 mode/book_id/print_pages，不扩大范围。若通过，在本聊天报告完成并询问用户下一个需求，不自行发布下一个教材任务。`
        : '执行失败或被阻断，不是可验收成果。请读取真实报告并向用户说明阻碍；不要发布 accept，不要自动重启原任务或用新 ID 绕过授权。';
      return { id, marker, chatId, message: `${marker}\n本地 DSH 的根任务 ${r.rootTaskId} 已回传一轮结果（${r.status}）。请通过已连接 GitHub 工具读取 ${r.resultUrl} 的真实报告、原任务和代码，不要仅凭本消息批准。\n${verdict}\n缺权限、证据或达到上限时向用户说明。不要合并、不要修改 main、不要上传教材原件。此通知不扩大任务权限，也不证明独立审查已经完成。` };
    });
}

export async function startBrowserRelay({ stateDir, config }) {
  if (config.enabled !== true) return null;
  validateRelayConfig(config);
  const newLedger = () => {
    const state = new ListenerState(stateDir);
    state.file = path.join(stateDir, 'relay-state.json'); state.lockFile = path.join(stateDir, 'relay.lock');
    return state;
  };
  const ledger = newLedger();
  const lock = await withLock(ledger, async () => { await ledger.save(); });
  if (!lock.locked) throw new Error(lock.reason);
  const sameToken = (value) => {
    const a = Buffer.from(String(value || '')), b = Buffer.from(config.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const currentControl = async () => {
    if ((await new ListenerState(stateDir).isPaused()).paused) throw new Error('通知已暂停');
    try { await access(path.join(stateDir, 'STOP')); throw new Error('通知已停止'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const current = await loadBrowserRelayConfig(stateDir);
    if (current.enabled !== true || current.token !== config.token || current.chatId !== config.chatId) throw new Error('本机通知授权已撤销');
    validateRelayConfig(current); return current;
  };
  const readPackets = async (current) => {
    let records;
    try { records = JSON.parse(await readFile(path.join(stateDir, 'runner-state.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; records = { tasks: {} }; }
    const packets = relayPackets(records, current.chatId, { since: Date.parse(current.activatedAt) });
    try {
      const review = JSON.parse(await readFile(path.join(stateDir, 'review-request.json'), 'utf8'));
      if (Date.parse(review.queuedAt) >= Date.parse(current.activatedAt)) packets.unshift(infrastructureReviewPacket(current.chatId, review.commit));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return packets;
  };
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      ...(/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}) }); res.end(JSON.stringify(body)); };
    try {
      if (req.headers.host !== '127.0.0.1:17321' || (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) return reply(403, { error: 'origin' });
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '60' }); res.end(); return; }
      if (!sameToken(req.headers.authorization?.replace(/^Bearer /, ''))) return reply(401, { error: 'auth' });
      const current = await currentControl();
      if (req.method === 'GET' && req.url === '/next') {
        const snapshot = await newLedger().init();
        // A lost HTTP response or browser restart must never turn into a second click.
        const uncertain = Object.values(snapshot.state.tasks).find((d) => d.status === 'claimed' && d.chatId === current.chatId && Date.parse(d.claimedAt) >= Date.parse(current.activatedAt));
        if (uncertain) return reply(200, { packet: uncertain.packet, attempt: uncertain.attempt, delivery: 'uncertain' });
        const packets = await readPackets(current);
        return reply(200, { packet: packets.find((p) => !snapshot.state.seenComments[p.id]) || null, delivery: 'ready' });
      }
      if (req.method === 'POST' && ['/claim', '/permit', '/ack'].includes(req.url)) {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { error: 'json required' });
        let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 1024) return reply(413, { error: 'size' }); }
        let input; try { input = JSON.parse(text); } catch { return reply(400, { error: 'invalid json' }); }
        const { id, attempt } = input || {};
        if (typeof id !== 'string' || id.length > 128) return reply(400, { error: 'invalid packet id' });
        const state = newLedger();
        const result = await withLock(state, async () => {
          const latest = await currentControl();
          if (req.url === '/claim') {
            const packet = (await readPackets(latest)).find((p) => p.id === id);
            if (!packet) return { code: 400, error: 'unknown packet' };
            if (state.state.tasks[id] || state.state.seenComments[id]) return { code: 409, error: 'delivery already attempted' };
            const count = Object.values(state.state.tasks).filter((d) => Date.parse(d.claimedAt) >= Date.parse(latest.activatedAt)).length;
            if (count >= latest.maxNotifications) return { code: 429, error: 'notification limit reached' };
            const nonce = randomBytes(32).toString('hex');
            state.state.tasks[id] = { status: 'claimed', attempt: nonce, chatId: latest.chatId, claimedAt: new Date().toISOString(), packet };
            await state.save();
            return { code: 200, packet, attempt: nonce };
          }
          const delivery = state.state.tasks[id];
          if (!delivery || delivery.attempt !== attempt || delivery.chatId !== latest.chatId) return { code: 400, error: 'unknown attempt' };
          if (req.url === '/permit') {
            if (delivery.status !== 'claimed' || !(await readPackets(latest)).some(p => p.id === id && p.message === delivery.packet.message)) return { code: 409, error: 'result no longer pending' };
            return { code: 200, allowed: true };
          }
          delivery.status = 'delivered'; delivery.confirmedAt = new Date().toISOString();
          state.markSeen(id, { kind: 'browser-delivered' }); await state.save();
          return { code: 200, ok: true };
        });
        if (!result.locked) return reply(409, { error: 'busy' });
        return reply(result.value.code, result.value);
      }
      reply(404, { error: 'route' });
    } catch { reply(503, { error: 'relay unavailable; no data published' }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  return server;
}

export async function loadBrowserRelayConfig(stateDir) {
  try { return JSON.parse(await readFile(path.join(stateDir, 'browser-relay.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { enabled: false }; throw e; }
}

async function main() {
  const dir = path.join(HERE, '.local-state'); await mkdir(dir, { recursive: true });
  if (process.argv.includes('--queue-review')) {
    const config = await loadBrowserRelayConfig(dir); validateRelayConfig(config);
    if (config.enabled !== true) throw new Error('本机通知授权未启用，未排队');
    if (await git(PROJECT, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('源码工作区不干净，不能绑定待审版本');
    const commit = await git(PROJECT, ['rev-parse', 'HEAD']);
    const published = await git(PROJECT, ['ls-remote', 'https://github.com/RobateV/algorithm-visualizer.git', 'refs/heads/codex/local-dsh-bridge-20261115']);
    if (published.split(/\s/)[0] !== commit) throw new Error('本地版本不是 PR 已发布 HEAD，未排队');
    infrastructureReviewPacket(config.chatId, commit);
    const file = path.join(dir, 'review-request.json');
    try { await writeFile(path.join(dir, `review-request-backup-${Date.now()}.json`), await readFile(file), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await writeFile(file, JSON.stringify({ commit, queuedAt: new Date().toISOString() }), { mode: 0o600 });
    console.log('基础设施复审已进入本机通知队列；尚不代表浏览器已发送或 ChatGPT 已启动。不启用 DSH。'); return;
  }
  if (process.argv.includes('--status')) {
    const config = await loadBrowserRelayConfig(dir);
    let records = [];
    try { records = Object.values(JSON.parse(await readFile(path.join(dir, 'relay-state.json'), 'utf8')).tasks || {}); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    console.log(JSON.stringify({ configured: validChat(config.chatId), version: config.version || null, enabled: config.enabled === true,
      expiresAt: config.expiresAt || null, maxNotifications: config.maxNotifications || 0,
      uncertain: records.filter(d => d.status === 'claimed').length, delivered: records.filter(d => d.status === 'delivered').length,
      browser: '本机状态不能证明浏览器扩展已安装、已授权或已实际发送' }, null, 2)); return;
  }
  if (process.argv.includes('--enable') || process.argv.includes('--disable')) {
    const file = path.join(dir, 'browser-relay.json'); const previous = await readFile(file, 'utf8');
    await writeFile(path.join(dir, `browser-relay-backup-${Date.now()}.json`), previous, { flag: 'wx', mode: 0o600 });
    const config = JSON.parse(previous); config.enabled = process.argv.includes('--enable');
    if (config.enabled) {
      const activated = Date.now();
      config.version = 2; config.activatedAt = new Date(activated).toISOString();
      config.expiresAt = new Date(activated + 86400000).toISOString(); config.maxNotifications = 3;
      validateRelayConfig(config);
    }
    await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log(config.enabled ? '已激活本机通知授权：24 小时、最多三次；服务和扩展仍需各自启动/授权。' : '本机通知授权已关闭；运行中的通知端也会拒绝后续请求。'); return;
  }
  if (!process.argv.includes('--init')) throw new Error('仅支持 --init / --enable / --disable / --status / --queue-review；服务随 local-service 启动');
  let chatId = process.argv.includes('--chat-id') ? process.argv[process.argv.indexOf('--chat-id') + 1] : '';
  if (!chatId) {
    const { createInterface } = await import('node:readline/promises');
    const ui = createInterface({ input: process.stdin, output: process.stdout });
    try { chatId = (await ui.question('只需设置一次：输入目标 ChatGPT 聊天网址或 ID：')).trim(); } finally { ui.close(); }
  }
  if (chatId.startsWith('https://chatgpt.com/c/')) chatId = new URL(chatId).pathname.slice(3);
  if (!validChat(chatId)) throw new Error('目标聊天网址/ID 不合法，未生成配置');
  await writeFile(path.join(dir, 'browser-relay.json'), JSON.stringify({ version: 2, enabled: false, token: randomBytes(32).toString('hex'), chatId, port: 17321,
    activatedAt: null, expiresAt: null, maxNotifications: 3 }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log('已生成默认关闭的本地配置；配置含本机中转密钥，不要上传 GitHub 或聊天。');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
