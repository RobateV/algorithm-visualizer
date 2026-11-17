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
  const events = new Map();
  const storage = new Map(), c = { ...config(), ...options.config }, messages = [...(options.messages || [])];
  const stats = { clicks: 0, writes: 0, submits: 0 };
  const editor = { textContent: options.draft || '', focus() {} };
  const nodes = options.nodes || [];
  const form = { tagName: 'FORM', attributes: [], childNodes: [], elements: options.associated || [], contains: node => node === editor || nodes.includes(node), getAttribute: () => null,
    querySelectorAll: selector => selector === '#prompt-textarea' ? [editor] : [editor, ...nodes] };
  Object.assign(editor, { tagName: 'DIV', attributes: [], childNodes: [], getAttribute: () => null, closest: () => options.noComposer ? null : form, contains: node => node === editor });
  const button = { disabled: !!options.disabled, click() { stats.clicks++; stats.submits++; if (options.confirm !== false) messages.push({ textContent: editor.textContent }); editor.textContent = ''; } };
  const ctx = vm.createContext({
    Date, setTimeout: (fn) => queueMicrotask(fn),
    chrome: { runtime: { id: 'own-extension', async sendMessage() { options.afterPermit?.(c, editor, nodes); return { allowed: options.permit !== false }; }, onMessage: { addListener(fn) { listener = fn; } } }, storage: { local: { async get() { return { relayConfig: structuredClone(c) }; } } } },
    location: { origin: 'https://chatgpt.com', pathname: options.pathname || `/c/${chatId}` },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    document: {
      addEventListener: (type, fn) => events.set(type, fn),
      querySelector: selector => selector.includes('stop-button') ? (options.busy ? {} : null) : options.unloaded ? null : selector.includes('prompt-textarea') ? editor : (options.buttonAfterTyping && !stats.writes ? null : button),
      querySelectorAll: selector => selector.includes('data-message-author-role') ? messages : [...nodes.filter(n => n.tagName === 'INPUT'), ...(options.externalFiles || [])],
      execCommand(_command, _ui, text) { stats.writes++; editor.textContent = text; options.afterInsert?.(c); }
    }
  });
  vm.runInContext(contentSource, ctx);
  return { stats, editor, config: c, emit: (type, event) => events.get(type)(event), send: (type, payload = packet, attempt = nonce, sender = 'own-extension') => new Promise(resolve => {
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

function composerNode(tagName = 'DIV', attrs = {}, extra = {}) {
  return { tagName, attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })), childNodes: [],
    getAttribute: name => attrs[name] || null, closest: () => null, ...extra };
}

for (const [type, event] of [['change', { target: { type: 'file' } }], ['drop', { dataTransfer: { types: ['Files'], files: [] } }], ['paste', { clipboardData: { items: [{ kind: 'file' }] } }]]) {
  test(`附件安全：${type} 文件活动后即使卡片和 files 已清空也拒绝提交`, async () => {
    const page = content(); page.emit(type, event);
    assert.equal((await page.send('relay-prepare')).ready, undefined);
    assert.equal((await page.send('relay-result')).delivered, false);
    assert.equal(page.stats.clicks, 0); assert.equal(page.stats.submits, 0); assert.equal(page.stats.writes, 0);
  });
}

for (const [name, options] of [
  ['PDF 附件', { nodes: [composerNode('DIV', { title: 'draft.pdf' })] }],
  ['图片附件', { nodes: [composerNode('IMG', { src: 'blob:local-only' })] }],
  ['文件上传中', { nodes: [composerNode('DIV', { role: 'progressbar' })] }],
  ['已上传文件卡片', { nodes: [composerNode('DIV', { 'data-testid': 'file-card' })] }],
  ['已选择未完成上传', { nodes: [composerNode('INPUT', {}, { type: 'file', files: [{ name: 'private.pdf' }], value: 'C:/fakepath/private.pdf' })] }],
  ['未知附件状态', { nodes: [composerNode('DIV', { 'data-attachment-state': 'unknown' })] }],
  ['未知自定义上传控件', { nodes: [composerNode('CUSTOM-UPLOADER')] }],
  ['未知 shadow 控件', { nodes: [composerNode('DIV', {}, { shadowRoot: {} })] }],
  ['其他文件类型预览', { nodes: [composerNode('BUTTON', { 'aria-label': 'notes.docx' })] }],
  ['无法读取文件选择状态', { nodes: [composerNode('INPUT', {}, { type: 'file', files: null, value: '' })] }],
  ['无法识别 composer', { noComposer: true }],
  ['form 外关联文件控件', { associated: [composerNode('INPUT', {}, { type: 'file', files: [{}], value: '' })] }],
  ['composer 外已选文件', { externalFiles: [composerNode('INPUT', {}, { type: 'file', files: [{}], value: '' })] }],
  ['无标识附件卡片', { nodes: [composerNode('DIV', {}, { childNodes: [{ nodeType: 3, textContent: 'private-document.pdf' }] })] }]
]) test(`附件安全：${name} 拒绝准备和提交且不更改附件`, async () => {
  const before = JSON.stringify(options), page = content(options);
  assert.equal((await page.send('relay-prepare')).ready, undefined);
  assert.equal((await page.send('relay-result')).delivered, false);
  assert.equal(page.stats.clicks, 0); assert.equal(page.stats.submits, 0); assert.equal(page.stats.writes, 0);
  assert.equal(JSON.stringify(options), before);
});

test('附件安全：空 composer 与空闲文件选择控件允许；普通文字拒绝', async () => {
  const page = content({ nodes: [composerNode('INPUT', {}, { type: 'file', files: [], value: '' })] });
  assert.equal((await page.send('relay-prepare')).ready, true);
  assert.equal((await page.send('relay-result')).delivered, true); assert.equal(page.stats.submits, 1);
  const draft = content({ draft: '用户文字' });
  assert.equal((await draft.send('relay-result')).delivered, false);
  assert.equal(draft.stats.clicks, 0); assert.equal(draft.stats.submits, 0); assert.equal(draft.editor.textContent, '用户文字');
});

for (const phase of ['insert', 'permit']) test(`附件安全：${phase} 之后出现附件拒绝点击`, async () => {
  const nodes = [], add = () => nodes.push(composerNode('IMG'));
  const page = content({ nodes, ...(phase === 'insert' ? { afterInsert: add } : { afterPermit: add }) });
  assert.equal((await page.send('relay-result')).delivered, false);
  assert.equal(page.stats.clicks, 0); assert.equal(page.stats.submits, 0); assert.equal(nodes.length, 1);
});

test('已有草稿、正在回复、页面未就绪、错误聊天或到期时不修改页面', async () => {
  for (const options of [{ draft: 'my draft' }, { busy: true }, { unloaded: true }, { pathname: '/c/another' }, { config: { enabled: false } }, { config: { expiresAt: '2000-01-01' } }]) {
    const page = content(options);
    assert.equal((await page.send('relay-prepare')).ready, undefined);
    assert.equal((await page.send('relay-result')).delivered, false);
    assert.equal(page.stats.writes, 0); assert.equal(page.stats.clicks, 0);
    if (options.draft) assert.equal(page.editor.textContent, options.draft);
  }
});

test('空输入框只显示语音按钮时可以准备，填入后才核验发送按钮', async () => {
  const page = content({ buttonAfterTyping: true });
  assert.equal((await page.send('relay-prepare')).ready, true);
  assert.equal((await page.send('relay-result')).delivered, true);
  assert.equal(page.stats.clicks, 1);
  const disabled = content({ disabled: true });
  assert.equal((await disabled.send('relay-result')).delivered, false);
  assert.equal(disabled.stats.clicks, 0);
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
