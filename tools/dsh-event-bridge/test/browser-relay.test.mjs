import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { relayPackets, startBrowserRelay } from '../browser-relay.mjs';
const CHAT_ID = '00000000-0000-0000-0000-000000000001';

const record = { taskId: 'task-1', rootTaskId: 'root-1', status: 'reported', commit: 'a'.repeat(40), resultUrl: 'https://github.com/RobateV/algorithm-visualizer/issues/21#issuecomment-123' };
test('只为已回传根任务生成消息，不传本地路径、原始错误或教材内容', () => {
  const [packet] = relayPackets({ tasks: { one: { ...record, work: 'C:/private', error: 'SECRET', detail: 'RAW_PDF' } } }, CHAT_ID);
  assert.equal(packet.chatId, CHAT_ID); assert.ok(packet.message.includes(record.resultUrl));
  for (const value of ['C:/private', 'SECRET', 'RAW_PDF']) assert.equal(packet.message.includes(value), false);
  for (const override of [{ legacy: true }, { rootTaskId: null }, { commit: 'short' }, { status: 'running' }, { resultUrl: 'https://githubXcom/RobateV/algorithm-visualizer/issues/21#issuecomment-123' }]) {
    assert.equal(relayPackets({ tasks: { one: { ...record, ...override } } }, CHAT_ID).length, 0);
  }
});

test('本机中转拒绝无密钥、网页来源及未知 ACK，并持久化确认去重', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'browser-relay-'));
  await writeFile(path.join(stateDir, 'runner-state.json'), JSON.stringify({ tasks: { one: record } }));
  const config = { enabled: true, token: 'b'.repeat(64), chatId: CHAT_ID, port: 17321 };
  const server = await startBrowserRelay({ stateDir, config });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(stateDir, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:17321/';
  assert.equal((await fetch(url + 'next')).status, 401);
  const headers = { authorization: `Bearer ${config.token}`, origin: 'chrome-extension://' + 'a'.repeat(32), 'content-type': 'application/json' };
  assert.equal((await fetch(url + 'next', { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  const { packet } = await (await fetch(url + 'next', { headers })).json(); assert.ok(packet);
  assert.equal((await fetch(url + 'ack', { method: 'POST', headers, body: JSON.stringify({ id: 'unknown' }) })).status, 400);
  assert.equal((await fetch(url + 'ack', { method: 'POST', headers, body: JSON.stringify({ id: packet.id }) })).status, 200);
  assert.equal((await (await fetch(url + 'next', { headers })).json()).packet, null);
});
