import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// DOM fixtures test our adapter contract; they do not validate the live ChatGPT page.
const contentSource = await readFile(new URL('../browser-extension/content.js', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
const chatId = '00000000-0000-0000-0000-000000000001';
const packet = { id: `smoke:${'a'.repeat(40)}`, marker: `[LOCAL-DSH-NOTIFY:smoke:${'a'.repeat(40)}]`, chatId };
packet.message = `${packet.marker}\nRead the authorized GitHub report only.`;
const config = () => ({ version: 2, enabled: true, chatId, token: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() });
const nonce = 'c'.repeat(64);

function content(options = {}) {
  let listener;
  const storage = new Map(), c = { ...config(), ...options.config }, messages = [...(options.messages || [])];
  const stats = { clicks: 0, writes: 0 };
  const editor = { textContent: options.draft || '', focus() {} };
  const button = { disabled: !!options.disabled, click() { stats.clicks++; if (options.confirm !== false) messages.push({ textContent: editor.textContent }); editor.textContent = ''; } };
  const ctx = vm.createContext({
    Date, setTimeout: (fn) => queueMicrotask(fn),
    chrome: { runtime: { id: 'own-extension', async sendMessage() { options.afterPermit?.(c, editor); return { allowed: options.permit !== false }; }, onMessage: { addListener(fn) { listener = fn; } } }, storage: { local: { async get() { return { relayConfig: structuredClone(c) }; } } } },
    location: { origin: 'https://chatgpt.com', pathname: options.pathname || `/c/${chatId}` },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    document: {
      querySelector: selector => selector.includes('stop-button') ? (options.busy ? {} : null) : options.unloaded ? null : selector.includes('prompt-textarea') ? editor : button,
      querySelectorAll: () => messages,
      execCommand(_command, _ui, text) { stats.writes++; editor.textContent = text; options.afterInsert?.(c); }
    }
  });
  vm.runInContext(contentSource, ctx);
  return { stats, editor, config: c, send: (type, payload = packet, attempt = nonce, sender = 'own-extension') => new Promise(resolve => {
    const pending = listener({ type, packet: payload, attempt }, { id: sender }, resolve);
    if (!pending) resolve({ ignored: true });
  }) };
}

test('页面先准备不填写；有效凭证只发送一次；已出现的标记仅确认', async () => {
  const page = content();
  assert.equal((await page.send('relay-prepare')).ready, true); assert.equal(page.stats.writes, 0);
  assert.equal((await page.send('relay-result')).delivered, true);
  assert.equal((await page.send('relay-result')).delivered, true);
  assert.equal(page.stats.writes, 1); assert.equal(page.stats.clicks, 1);
});

test('已有草稿、正在回复、页面未就绪、错误聊天或到期时不修改页面', async () => {
  for (const options of [{ draft: 'my draft' }, { busy: true }, { unloaded: true }, { disabled: true }, { pathname: '/c/another' }, { config: { enabled: false } }, { config: { expiresAt: '2000-01-01' } }]) {
    const page = content(options);
    assert.equal((await page.send('relay-prepare')).ready, undefined);
    assert.equal((await page.send('relay-result')).delivered, false);
    assert.equal(page.stats.writes, 0); assert.equal(page.stats.clicks, 0);
    if (options.draft) assert.equal(page.editor.textContent, options.draft);
  }
});

test('拒绝错误扩展来源、标记/id 不一致和缺少发送凭证', async () => {
  const page = content();
  assert.equal((await page.send('relay-result', packet, nonce, 'another-extension')).ignored, true);
  assert.equal((await page.send('relay-result', { ...packet, id: 'wrong' })).delivered, false);
  assert.equal((await page.send('relay-result', packet, '')).delivered, false);
  assert.equal(page.stats.writes, 0);
});

test('点击后未确认时不重发；新页面恢复也只能检查，不能点击', async () => {
  const page = content({ confirm: false });
  assert.equal((await page.send('relay-result')).delivered, false);
  assert.equal((await page.send('relay-result')).delivered, false);
  assert.equal(page.stats.clicks, 1);
  const restarted = content();
  assert.equal((await restarted.send('relay-inspect')).delivered, false);
  assert.equal(restarted.stats.writes, 0); assert.equal(restarted.stats.clicks, 0);
  const received = content({ draft: 'keep draft', messages: [{ textContent: packet.message }] });
  assert.equal((await received.send('relay-inspect')).delivered, true);
  assert.equal(received.editor.textContent, 'keep draft');
});

test('填入通知后关闭授权，点击发送前停止并保留草稿', async () => {
  const page = content({ afterInsert: c => { c.enabled = false; } });
  assert.equal((await page.send('relay-result')).delivered, false);
  assert.equal(page.stats.clicks, 0); assert.equal(page.editor.textContent, packet.message);
});

test('服务停止或暂停后拒绝最终发送许可，页面不会点击发送', async () => {
  const page = content({ permit: false });
  assert.equal((await page.send('relay-result')).delivered, false);
  assert.equal(page.stats.clicks, 0); assert.equal(page.editor.textContent, packet.message);
});

test('等待本地许可时用户修改草稿或撤销授权，不会发送新草稿', async () => {
  for (const afterPermit of [(_c, editor) => { editor.textContent = 'private user draft'; }, c => { c.enabled = false; }]) {
    const page = content({ afterPermit }); assert.equal((await page.send('relay-result')).delivered, false);
    assert.equal(page.stats.clicks, 0);
  }
});

function background({ delivery = 'ready', prepared = { ready: true }, delivered = true, tabs, failAck = false } = {}) {
  const store = { relayConfig: config() }, routes = [], sent = [];
  let listener;
  const ctx = vm.createContext({ Date, URL, AbortSignal,
    fetch: async (url, options) => {
      const route = new URL(url).pathname.slice(1); routes.push({ route, body: options.body ? JSON.parse(options.body) : undefined });
      if (route === 'ack' && failAck) throw new Error('lost response');
      return { ok: true, json: async () => route === 'next' ? { packet, delivery, attempt: nonce } : route === 'claim' ? { packet, attempt: nonce } : route === 'permit' ? { allowed: true } : { ok: true } };
    },
    chrome: {
      runtime: { id: 'own-extension', onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      storage: { local: { async get() { return structuredClone(store); }, async set(value) { Object.assign(store, value); } } },
      tabs: { async query() { return tabs || [{ id: 1, url: `https://chatgpt.com/c/${chatId}` }]; }, async sendMessage(_id, message) { sent.push(message); return message.type === 'relay-prepare' ? prepared : { delivered, reason: 'unknown' }; } }
    }
  });
  vm.runInContext(backgroundSource, ctx);
  return { routes, sent, store, check: () => vm.runInContext('check()', ctx), permit: sender => new Promise(resolve => {
    if (!listener({ type: 'permit-send', id: packet.id, attempt: nonce }, sender, resolve)) resolve({ allowed: false });
  }) };
}

test('后台按准备→持久化 claim→发送→带凭证 ACK 的顺序工作', async () => {
  const relay = background(); await relay.check();
  assert.deepEqual(relay.routes.map(r => r.route), ['next', 'claim', 'ack']);
  assert.deepEqual(relay.sent.map(m => m.type), ['relay-prepare', 'relay-result']);
  assert.equal(relay.routes[2].body.attempt, nonce);
});

test('后台恢复不 claim、不发送，只检查已有消息后 ACK', async () => {
  for (const delivered of [false, true]) {
    const relay = background({ delivery: 'uncertain', delivered }); await relay.check();
    assert.deepEqual(relay.sent.map(m => m.type), ['relay-inspect']);
    assert.deepEqual(relay.routes.map(r => r.route), delivered ? ['next', 'ack'] : ['next']);
  }
});

test('后台在草稿、多标签页及前缀相似的错误聊天下不领取发送凭证', async () => {
  for (const options of [{ prepared: { reason: 'draft' } }, { tabs: [{ id: 1, url: `https://chatgpt.com/c/${chatId}` }, { id: 2, url: `https://chatgpt.com/c/${chatId}` }] }, { tabs: [{ id: 1, url: `https://chatgpt.com/c/${chatId}-other` }] }]) {
    const relay = background(options); await relay.check();
    assert.deepEqual(relay.routes.map(r => r.route), ['next']);
  }
});

test('最终发送许可只接受自己扩展的目标聊天顶层页面', async () => {
  const sender = { id: 'own-extension', frameId: 0, tab: { url: `https://chatgpt.com/c/${chatId}` } };
  for (const change of [{ id: 'other' }, { frameId: 1 }, { tab: { url: 'https://evil.example' } }, { tab: undefined }]) {
    const relay = background(); assert.equal((await relay.permit({ ...sender, ...change })).allowed, false); assert.equal(relay.routes.length, 0);
  }
  const relay = background(); assert.equal((await relay.permit(sender)).allowed, true); assert.equal(relay.routes[0].route, 'permit');
});
