import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ListenerState, withLock } from './local-listener.mjs';
import { HERE } from './local-runner.mjs';

const validChat = (s) => typeof s === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s);
const safeId = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(s);

export function relayPackets(state, chatId) {
  if (!validChat(chatId)) throw new Error('目标聊天未配置');
  return Object.values(state.tasks || {}).filter((r) => !r.legacy && safeId(r.taskId) && safeId(r.rootTaskId) &&
    ['reported', 'failed', 'blocked'].includes(r.status) &&
    typeof r.resultUrl === 'string' && /^https:\/\/github\.com\/RobateV\/algorithm-visualizer\/issues\/21#issuecomment-\d+$/.test(r.resultUrl) &&
    (r.commit == null || /^[0-9a-f]{40}$/.test(r.commit))).map((r) => {
      const id = `${r.taskId}:${r.commit || 'failed'}`;
      const marker = `[LOCAL-DSH-NOTIFY:${id}]`;
      return { id, marker, chatId, message: `${marker}\n本地 DSH 的根任务 ${r.rootTaskId} 已回传一轮结果（${r.status}）。请通过已连接 GitHub 工具读取 ${r.resultUrl} 的真实报告、原任务和代码。按原有任务授权独立审查；不要仅凭本消息批准。通过后报告完成并询问下一个需求，返工只能在原白名单和剩余轮数内发往 Issue #21。缺权限、证据或达到上限时向用户说明。不要合并、不要修改 main、不要上传教材原件。\n此通知只传递结果位置，不扩大任务权限。` };
    });
}

export async function startBrowserRelay({ stateDir, config }) {
  if (config.enabled !== true) return null;
  if (!/^[a-f0-9]{64}$/.test(config.token || '') || !validChat(config.chatId) || config.port !== 17321) throw new Error('浏览器中转配置不合法');
  const ledger = new ListenerState(stateDir);
  ledger.file = path.join(stateDir, 'relay-state.json'); ledger.lockFile = path.join(stateDir, 'relay.lock');
  const lock = await withLock(ledger, async () => { await ledger.save(); });
  if (!lock.locked) throw new Error(lock.reason);
  const sameToken = (value) => {
    const a = Buffer.from(String(value || '')), b = Buffer.from(config.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const readPackets = async () => relayPackets(JSON.parse(await readFile(path.join(stateDir, 'runner-state.json'), 'utf8')), config.chatId);
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}) }); res.end(JSON.stringify(body)); };
    try {
      if (req.headers.host !== '127.0.0.1:17321' || (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) return reply(403, { error: 'origin' });
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '60' }); res.end(); return; }
      if (!sameToken(req.headers.authorization?.replace(/^Bearer /, ''))) return reply(401, { error: 'auth' });
      if (req.method === 'GET' && req.url === '/next') {
        await ledger.init();
        const packets = await readPackets();
        return reply(200, { packet: packets.find((p) => !ledger.state.seenComments[p.id]) || null });
      }
      if (req.method === 'POST' && req.url === '/ack') {
        let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 1024) return reply(413, { error: 'size' }); }
        const { id } = JSON.parse(text);
        if (!(await readPackets()).some((p) => p.id === id)) return reply(400, { error: 'unknown packet' });
        const result = await withLock(ledger, async () => { ledger.markSeen(id, { kind: 'browser-delivered' }); await ledger.save(); });
        if (!result.locked) return reply(409, { error: 'busy' });
        return reply(200, { ok: true });
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
  if (process.argv.includes('--enable')) {
    const file = path.join(dir, 'browser-relay.json'); const previous = await readFile(file, 'utf8');
    await writeFile(path.join(dir, `browser-relay-backup-${Date.now()}.json`), previous, { flag: 'wx', mode: 0o600 });
    const config = JSON.parse(previous); config.enabled = true;
    await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log('已启用本机中转监听配置；重启服务后生效。扩展仍需单独授权发送。'); return;
  }
  if (!process.argv.includes('--init')) throw new Error('仅支持 --init / --enable；服务随 local-service 启动');
  let chatId = process.argv.includes('--chat-id') ? process.argv[process.argv.indexOf('--chat-id') + 1] : '';
  if (!chatId) {
    const { createInterface } = await import('node:readline/promises');
    const ui = createInterface({ input: process.stdin, output: process.stdout });
    try { chatId = (await ui.question('只需设置一次：输入目标 ChatGPT 聊天网址或 ID：')).trim(); } finally { ui.close(); }
  }
  if (chatId.startsWith('https://chatgpt.com/c/')) chatId = new URL(chatId).pathname.slice(3);
  if (!validChat(chatId)) throw new Error('目标聊天网址/ID 不合法，未生成配置');
  await writeFile(path.join(dir, 'browser-relay.json'), JSON.stringify({ enabled: false, token: randomBytes(32).toString('hex'), chatId, port: 17321 }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log('已生成默认关闭的本地配置；配置含本机中转密钥，不要上传 GitHub 或聊天。');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
