import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseComment, TASK_MARKER, PING_MARKER, loadConfig, emptyState, ListenerState,
  parseNextLink, listIssueComments, getBranchHead, pollOnce, acquireLock
} from '../local-listener.mjs';

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

/* ============================================================ 分页（A） */

function jsonResponse(body, { status = 200, link = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: (k) => (String(k).toLowerCase() === 'link' ? link : null) }
  };
}

function comment(id, body = `${PING_MARKER} x`, login = 'RobateV') {
  return {
    id,
    body,
    user: { login },
    created_at: '2026-11-14T00:00:00Z',
    updated_at: '2026-11-14T00:00:00Z',
    html_url: `https://github.com/x#${id}`
  };
}

test('解析 Link 头中的 next', () => {
  assert.equal(parseNextLink(null), null);
  assert.equal(
    parseNextLink('<https://api.github.com/repos/a/b/issues/21/comments?page=2>; rel="next", <https://api.github.com/x>; rel="last"'),
    'https://api.github.com/repos/a/b/issues/21/comments?page=2'
  );
  assert.equal(parseNextLink('<https://x>; rel="last"'), null);
});

test('分页：跟随 Link 拉取全部评论', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('page=1')) {
      return jsonResponse([comment(1), comment(2)], { link: '<https://api.github.com/p2>; rel="next"' });
    }
    return jsonResponse([comment(3)], { link: null });
  };
  const list = await listIssueComments({ repo: 'a/b', issue: 21, token: 't', fetchImpl });
  assert.deepEqual(list.map((c) => c.id), [1, 2, 3]);
  assert.equal(calls.length, 2);
});

test('分页：超过页数上限时显式报错，不返回不完整快照', async () => {
  const fetchImpl = async (url) => jsonResponse([comment(1)], { link: '<https://api.github.com/next>; rel="next"' });
  await assert.rejects(
    () => listIssueComments({ repo: 'a/b', issue: 21, token: 't', fetchImpl, maxPages: 3 }),
    /超过 3 页上限/
  );
});

test('API 失败时抛错且不泄露 token', async () => {
  const fetchImpl = async () => jsonResponse({ message: 'boom' }, { status: 500 });
  await assert.rejects(
    () => listIssueComments({ repo: 'a/b', issue: 21, token: 'secret-token-value', fetchImpl }),
    (err) => {
      assert.match(err.message, /500/);
      assert.equal(err.message.includes('secret-token-value'), false);
      return true;
    }
  );
});

/* ============================================================ 分支 HEAD（B） */

test('分支名中的斜杠被正确编码', async () => {
  let captured = '';
  const fetchImpl = async (url) => {
    captured = url;
    return jsonResponse({ commit: { sha: SHA } });
  };
  const sha = await getBranchHead({ repo: 'a/b', branch: 'dev/local-dsh-20261114', token: 't', fetchImpl });
  assert.equal(sha, SHA);
  assert.match(captured, /branches\/dev%2Flocal-dsh-20261114$/);
});

test('非法分支名被拒绝', async () => {
  await assert.rejects(() => getBranchHead({ repo: 'a/b', branch: '../etc', token: 't', fetchImpl: async () => jsonResponse({}) }), /分支名非法/);
});

async function makeState() {
  const dir = await mkdtemp(path.join(tmpdir(), 'listener-test-'));
  const state = await new ListenerState(dir).init();
  return { dir, state };
}

function pollFetch({ headSha = SHA, comments = [], branchStatus = 200 } = {}) {
  return async (url) => {
    if (url.includes('/comments')) return jsonResponse(comments, { link: null });
    if (url.includes('/branches/')) {
      if (branchStatus === 404) return jsonResponse({ message: 'Not Found' }, { status: 404 });
      if (branchStatus === 500) return jsonResponse({ message: 'boom' }, { status: 500 });
      return jsonResponse({ commit: { sha: headSha } });
    }
    throw new Error('unexpected url ' + url);
  };
}

test('SHA 匹配时任务入队', async () => {
  const { dir, state } = await makeState();
  const s = await pollOnce({
    state, token: 't',
    fetchImpl: pollFetch({ comments: [comment(100, taskBody())] }),
    log: async () => {}
  });
  assert.equal(s.tasks, 1);
  assert.equal(state.taskById('task-001').status, 'pending');
  assert.equal(state.taskById('task-001').headAtEnqueue, SHA);
  await rm(dir, { recursive: true, force: true });
});

test('SHA 不匹配时拒绝入队', async () => {
  const { dir, state } = await makeState();
  const s = await pollOnce({
    state, token: 't',
    fetchImpl: pollFetch({ headSha: 'b'.repeat(40), comments: [comment(101, taskBody())] }),
    log: async () => {}
  });
  assert.equal(s.tasks, 0);
  assert.equal(s.invalid, 1);
  assert.equal(state.taskById('task-001'), null);
  assert.equal(state.state.seenComments['101'].kind, 'sha-mismatch');
  await rm(dir, { recursive: true, force: true });
});

test('分支不存在（404）时拒绝入队', async () => {
  const { dir, state } = await makeState();
  const s = await pollOnce({
    state, token: 't',
    fetchImpl: pollFetch({ branchStatus: 404, comments: [comment(102, taskBody())] }),
    log: async () => {}
  });
  assert.equal(s.tasks, 0);
  assert.equal(state.state.seenComments['102'].kind, 'branch-missing');
  await rm(dir, { recursive: true, force: true });
});

test('读取分支 HEAD 失败时 fail-closed：不入队、不标记，下轮重试', async () => {
  const { dir, state } = await makeState();
  const s = await pollOnce({
    state, token: 't',
    fetchImpl: pollFetch({ branchStatus: 500, comments: [comment(103, taskBody())] }),
    log: async () => {}
  });
  assert.equal(s.tasks, 0);
  assert.equal(s.deferred, 1);
  assert.equal(state.taskById('task-001'), null);
  assert.equal(state.hasSeen(103), false, '不得标记为已处理，否则无法重试');
  await rm(dir, { recursive: true, force: true });
});

/* ============================================================ 锁恢复（C） */

test('存活进程持有锁时拒绝启动', async () => {
  const { dir, state } = await makeState();
  await writeFile(state.lockFile, JSON.stringify({ pid: 4242, at: 'x' }), 'utf8');
  const r = await acquireLock(state, { isAlive: () => true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /已有监听器实例/);
  await rm(dir, { recursive: true, force: true });
});

test('确认进程已退出时安全接管陈旧锁', async () => {
  const { dir, state } = await makeState();
  await writeFile(state.lockFile, JSON.stringify({ pid: 4242, at: 'x' }), 'utf8');
  const r = await acquireLock(state, { isAlive: () => false });
  assert.equal(r.ok, true);
  assert.equal(r.recovered, true);
  assert.equal(r.previousPid, 4242);
  const lock = JSON.parse(await readFile(state.lockFile, 'utf8'));
  assert.equal(lock.pid, process.pid);
  await rm(dir, { recursive: true, force: true });
});

test('锁内容损坏时 fail-closed', async () => {
  const { dir, state } = await makeState();
  await writeFile(state.lockFile, 'not-json', 'utf8');
  const r = await acquireLock(state, { isAlive: () => false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /损坏/);
  await rm(dir, { recursive: true, force: true });
});

test('无法确认进程状态时 fail-closed', async () => {
  const { dir, state } = await makeState();
  await writeFile(state.lockFile, JSON.stringify({ pid: 4242 }), 'utf8');
  const r = await acquireLock(state, { isAlive: () => null });
  assert.equal(r.ok, false);
  assert.match(r.reason, /无法确认/);
  await rm(dir, { recursive: true, force: true });
});
