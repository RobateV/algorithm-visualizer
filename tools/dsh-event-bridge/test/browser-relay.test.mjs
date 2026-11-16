import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { relayPackets, startBrowserRelay, validateRelayConfig, infrastructureReviewPacket } from '../browser-relay.mjs';
const CHAT_ID = '00000000-0000-0000-0000-000000000001';

const record = { taskId: 'task-1', rootTaskId: 'root-1', status: 'reported', commit: 'a'.repeat(40), resultUrl: 'https://github.com/RobateV/algorithm-visualizer/issues/21#issuecomment-123',
  startedAt: new Date(Date.now() - 5000).toISOString(), authorizationExpiresAt: new Date(Date.now() + 3600000).toISOString() };
const activeConfig = () => ({ version: 2, enabled: true, token: 'b'.repeat(64), chatId: CHAT_ID, port: 17321,
  activatedAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), maxNotifications: 3 });
const close = async (server) => { if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'browser-relay-')), config = { ...activeConfig(), ...overrides };
  const runnerFile = path.join(stateDir, 'runner-state.json'), configFile = path.join(stateDir, 'browser-relay.json');
  await writeFile(runnerFile, JSON.stringify({ tasks: { one: record } })); await writeFile(configFile, JSON.stringify(config));
  let server = await startBrowserRelay({ stateDir, config });
  t.after(async () => { await close(server); if (path.dirname(stateDir) !== path.resolve(tmpdir())) throw new Error('test directory escape'); await rm(stateDir, { recursive: true, force: true, maxRetries: 5 }); });
  const headers = { authorization: `Bearer ${config.token}`, origin: 'chrome-extension://' + 'a'.repeat(32), 'content-type': 'application/json' };
  const request = (route, body) => fetch('http://127.0.0.1:17321/' + route, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  return { stateDir, config, runnerFile, configFile, headers, request, restart: async () => { await close(server); server = await startBrowserRelay({ stateDir, config }); } };
}
test('只为已回传根任务生成消息，不传本地路径、原始错误或教材内容', () => {
  const [packet] = relayPackets({ tasks: { one: { ...record, work: 'C:/private', error: 'SECRET', detail: 'RAW_PDF' } } }, CHAT_ID);
  assert.equal(packet.chatId, CHAT_ID); assert.ok(packet.message.includes(record.resultUrl));
  assert.ok(packet.message.includes(`[LOCAL-DSH-REVIEW]\ntask_id: ${record.taskId}\ncommit: ${record.commit}`));
  assert.ok(packet.message.includes('mode/book_id/print_pages'));
  for (const value of ['C:/private', 'SECRET', 'RAW_PDF']) assert.equal(packet.message.includes(value), false);
  for (const override of [{ legacy: true }, { rootTaskId: null }, { commit: 'short' }, { status: 'running' }, { resultUrl: 'https://githubXcom/RobateV/algorithm-visualizer/issues/21#issuecomment-123' }]) {
    assert.equal(relayPackets({ tasks: { one: { ...record, ...override } } }, CHAT_ID).length, 0);
  }
  const [failed] = relayPackets({ tasks: { one: { ...record, status: 'failed', commit: null } } }, CHAT_ID);
  assert.ok(failed.message.includes('不要发布 accept')); assert.ok(!failed.message.includes('[LOCAL-DSH-REVIEW]'));
});

test('本机中转先持久化 claim；重启只核对，不再次发送；ACK 绑定一次性凭证', async (t) => {
  const { request, headers, restart } = await fixture(t);
  const url = 'http://127.0.0.1:17321/';
  assert.equal((await fetch(url + 'next')).status, 401);
  const forbidden = await fetch(url + 'next', { headers: { ...headers, origin: 'https://evil.example' } });
  assert.equal(forbidden.status, 403); assert.equal(forbidden.headers.get('access-control-allow-origin'), null);
  const { packet } = await (await request('next')).json(); assert.ok(packet);
  assert.equal((await request('ack', { id: packet.id })).status, 400);
  assert.equal((await request('claim', { id: 'unknown' })).status, 400);
  const claim = await (await request('claim', { id: packet.id })).json(); assert.match(claim.attempt, /^[a-f0-9]{64}$/);
  assert.equal((await request('claim', { id: packet.id })).status, 409);
  await restart();
  const retry = await (await request('next')).json(); assert.equal(retry.delivery, 'uncertain'); assert.equal(retry.attempt, claim.attempt);
  assert.equal((await request('ack', { id: packet.id, attempt: 'wrong' })).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await request('ack', { id: packet.id, attempt: claim.attempt })).status, 200);
  assert.equal((await (await request('next')).json()).packet, null);
});

test('发送窗口、次数和任务授权防止启用后重放旧结果', () => {
  const c = activeConfig(); validateRelayConfig(c);
  for (const patch of [{ version: 1 }, { maxNotifications: 0 }, { maxNotifications: 11 }, { expiresAt: new Date(Date.now() - 1).toISOString() }, { expiresAt: new Date(Date.parse(c.activatedAt) + 86400001).toISOString() }]) assert.throws(() => validateRelayConfig({ ...c, ...patch }));
  const options = { since: Date.parse(c.activatedAt) };
  assert.equal(relayPackets({ tasks: { one: record } }, CHAT_ID, options).length, 1);
  for (const patch of [{ startedAt: '2000-01-01' }, { updatedAt: '2000-01-01' }, { startedAt: undefined }]) assert.equal(relayPackets({ tasks: { one: { ...record, ...patch } } }, CHAT_ID, options).length, 0);
  // Review notification has its own lease; it does not renew an expired execution grant.
  assert.equal(relayPackets({ tasks: { one: { ...record, authorizationExpiresAt: '2000-01-01' } } }, CHAT_ID, options).length, 1);
});

test('两个客户端同时 claim，至多一个获准；不允许突破通知额度', async (t) => {
  const { request, runnerFile } = await fixture(t, { maxNotifications: 1 });
  const { packet } = await (await request('next')).json();
  const results = await Promise.all([request('claim', { id: packet.id }), request('claim', { id: packet.id })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const claim = await results.find(r => r.status === 200).json();
  await request('ack', { id: packet.id, attempt: claim.attempt });
  await writeFile(runnerFile, JSON.stringify({ tasks: { two: { ...record, taskId: 'task-2' } } }));
  const next = await (await request('next')).json(); assert.ok(next.packet);
  assert.equal((await request('claim', { id: next.packet.id })).status, 429);
});

test('运行中关闭本机授权或到期，后续 claim 和 ACK 均停止', async (t) => {
  const { request, configFile, config, stateDir } = await fixture(t);
  const { packet } = await (await request('next')).json();
  const claim = await (await request('claim', { id: packet.id })).json();
  await writeFile(configFile, JSON.stringify({ ...config, enabled: false }));
  assert.equal((await request('ack', { id: packet.id, attempt: claim.attempt })).status, 503);
  const ledger = JSON.parse(await readFile(path.join(stateDir, 'relay-state.json'), 'utf8')); assert.equal(ledger.tasks[packet.id].status, 'claimed');
  await writeFile(configFile, JSON.stringify({ ...config, expiresAt: new Date(Date.now() - 1).toISOString() }));
  assert.equal((await request('next')).status, 503);
});

test('POST 正文等待期间撤销授权，在持锁写入之前再次检查', async (t) => {
  const { request, configFile, config, headers, stateDir } = await fixture(t);
  const { packet } = await (await request('next')).json();
  let post;
  const response = new Promise((resolve, reject) => {
    post = http.request('http://127.0.0.1:17321/claim', { method: 'POST', headers }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    post.once('error', reject); post.write('{"id":');
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  await writeFile(configFile, JSON.stringify({ ...config, enabled: false }));
  post.end(JSON.stringify(packet.id) + '}');
  assert.equal(await response, 503);
  const state = JSON.parse(await readFile(path.join(stateDir, 'relay-state.json'), 'utf8'));
  assert.equal(Object.keys(state.tasks).length, 0);
});

test('点击许可受 PAUSED 和 STOP 约束，已确认后不能再次获准发送', async (t) => {
  const { request, stateDir } = await fixture(t);
  const { packet } = await (await request('next')).json();
  const { attempt } = await (await request('claim', { id: packet.id })).json();
  const input = { id: packet.id, attempt };
  assert.equal((await request('permit', input)).status, 200);
  for (const name of ['PAUSED', 'STOP']) {
    const flag = path.join(stateDir, name); await writeFile(flag, 'test');
    assert.equal((await request('permit', input)).status, 503); await rm(flag);
  }
  assert.equal((await request('ack', input)).status, 200);
  assert.equal((await request('permit', input)).status, 409);
});

test('经本机排队的基础设施复审不伪造 DSH 任务，也不需要开启执行器', async (t) => {
  const { request, stateDir, runnerFile } = await fixture(t);
  await rm(runnerFile);
  const commit = 'e'.repeat(40);
  await writeFile(path.join(stateDir, 'review-request.json'), JSON.stringify({ commit, queuedAt: new Date().toISOString() }));
  const { packet } = await (await request('next')).json();
  assert.equal(packet.id, infrastructureReviewPacket(CHAT_ID, commit).id);
  assert.ok(packet.message.includes('不是 DSH 刚完成教材任务'));
  assert.ok(packet.message.includes(commit)); assert.ok(packet.message.includes('不启用本地执行/推送/回传'));
  const { attempt } = await (await request('claim', { id: packet.id })).json();
  assert.equal((await request('permit', { id: packet.id, attempt })).status, 200);
  assert.equal((await request('ack', { id: packet.id, attempt })).status, 200);
  assert.equal((await (await request('next')).json()).packet, null);
});
