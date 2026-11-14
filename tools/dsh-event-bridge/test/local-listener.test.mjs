import test from 'node:test';
import assert from 'node:assert/strict';

import { parseComment, TASK_MARKER, PING_MARKER, loadConfig, emptyState, ListenerState } from '../local-listener.mjs';

const SHA = 'a'.repeat(40);

function taskBody(overrides = {}) {
  const f = {
    task_id: 'task-001',
    branch: 'dev/local-dsh-20261114',
    expected_sha: SHA,
    allow: 'public/lessons/binary-search.html',
    accept: '页面无控制台报错',
    ...overrides
  };
  const head = Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `${TASK_MARKER}\n${head}\n---\n详细说明：只改指定文件。`;
}

test('识别连通性测试标记', () => {
  const r = parseComment(`${PING_MARKER}\n仅测试`);
  assert.equal(r.kind, 'ping');
});

test('普通评论被忽略', () => {
  const r = parseComment('随便聊聊');
  assert.equal(r.kind, 'ignore');
});

test('合法任务解析成功', () => {
  const r = parseComment(taskBody());
  assert.equal(r.kind, 'task');
  assert.equal(r.task.taskId, 'task-001');
  assert.equal(r.task.branch, 'dev/local-dsh-20261114');
  assert.equal(r.task.expectedSha, SHA);
  assert.deepEqual(r.task.allow, ['public/lessons/binary-search.html']);
  assert.equal(r.task.accept, '页面无控制台报错');
  assert.match(r.task.detail, /只改指定文件/);
});

test('拒绝非 40 位 SHA', () => {
  const r = parseComment(taskBody({ expected_sha: 'abc123' }));
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /expected_sha/);
});

test('拒绝以 main 为目标分支', () => {
  const r = parseComment(taskBody({ branch: 'main' }));
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /main/);
});

test('拒绝缺少修改范围', () => {
  const r = parseComment(taskBody({ allow: '' }));
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /allow/);
});

test('拒绝越界路径', () => {
  const r = parseComment(taskBody({ allow: '../etc/passwd' }));
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /allow/);
});

test('拒绝缺少验收标准', () => {
  const r = parseComment(taskBody({ accept: '' }));
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /accept/);
});

test('拒绝非法 task_id', () => {
  const r = parseComment(taskBody({ task_id: 'bad id with spaces' }));
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /task_id/);
});

test('配置默认值：20 秒间隔、Issue 21', () => {
  const cfg = loadConfig({}, []);
  assert.equal(cfg.intervalSec, 20);
  assert.equal(cfg.issue, 21);
  assert.equal(cfg.repo, 'RobateV/algorithm-visualizer');
});

test('配置支持暂停/恢复/单次参数', () => {
  assert.equal(loadConfig({}, ['--once']).once, true);
  assert.equal(loadConfig({}, ['--pause']).pause, true);
  assert.equal(loadConfig({}, ['--resume']).resume, true);
  assert.equal(loadConfig({}, ['--interval', '5']).intervalSec, 5);
});

test('状态默认结构', () => {
  const s = emptyState();
  assert.equal(s.paused, false);
  assert.deepEqual(s.tasks, {});
  assert.deepEqual(s.seenComments, {});
});
