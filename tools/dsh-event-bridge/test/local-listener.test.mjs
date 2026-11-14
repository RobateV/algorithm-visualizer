import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseComment, TASK_MARKER, PING_MARKER, loadConfig, emptyState, ListenerState,
  parseNextLink, listIssueComments, getBranchHead, pollOnce,
  acquireLock, releaseLock, unlockStale, withLock, isValidRepoPath, redactToken, validateNextUrl
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
      return jsonResponse([comment(1), comment(2)], { link: '<https://api.github.com/repos/a/b/issues/21/comments?page=2>; rel="next"' });
    }
    return jsonResponse([comment(3)], { link: null });
  };
  const list = await listIssueComments({ repo: 'a/b', issue: 21, token: 't', fetchImpl });
  assert.deepEqual(list.map((c) => c.id), [1, 2, 3]);
  assert.equal(calls.length, 2);
});

test('分页：超过页数上限时显式报错，不返回不完整快照', async () => {
  const fetchImpl = async (url) => jsonResponse([comment(1)], { link: '<https://api.github.com/repos/a/b/issues/21/comments?page=2>; rel="next"' });
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

test('陈旧锁不再自动接管：fail-closed 并提示 --unlock', async () => {
  const { dir, state } = await makeState();
  await writeFile(state.lockFile, JSON.stringify({ pid: 4242, at: 'x' }), 'utf8');
  const r = await acquireLock(state, { isAlive: () => false });
  assert.equal(r.ok, false, '不得自动接管，否则存在双实例窗口');
  assert.equal(r.code, 'lock-stale');
  assert.match(r.reason, /--unlock/);
  const lock = JSON.parse(await readFile(state.lockFile, 'utf8'));
  assert.equal(lock.pid, 4242, '原锁文件不得被改动');
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

/* ============================================ 第二轮：锁所有权与并发 */

test('释放锁必须匹配 nonce，不能删除他人锁', async () => {
  const { dir, state } = await makeState();
  const lock = await acquireLock(state);
  assert.equal(lock.ok, true);
  assert.equal(await releaseLock(state, 'wrong-nonce'), false, '错误 nonce 不得删除');
  await access(state.lockFile);
  assert.equal(await releaseLock(state, lock.nonce), true);
  await assert.rejects(() => access(state.lockFile));
  await rm(dir, { recursive: true, force: true });
});

test('并发获取同一目录的锁：恰好一个成功', async () => {
  const { dir, state } = await makeState();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => acquireLock(state, { isAlive: () => true }))
  );
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, '必须只有一个实例拿到锁');
  await releaseLock(state, winners[0].nonce);
  await rm(dir, { recursive: true, force: true });
});

test('两个实例竞争同一陈旧锁：都失败且锁文件不变', async () => {
  const { dir, state } = await makeState();
  await writeFile(state.lockFile, JSON.stringify({ pid: 999999, nonce: 'old', at: 'x' }), 'utf8');
  const [a, b] = await Promise.all([
    acquireLock(state, { isAlive: () => false }),
    acquireLock(state, { isAlive: () => false })
  ]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  const lock = JSON.parse(await readFile(state.lockFile, 'utf8'));
  assert.equal(lock.nonce, 'old', '陈旧锁不得被任意一方删除');
  await rm(dir, { recursive: true, force: true });
});

test('withLock 在锁被占用时不执行回调', async () => {
  const { dir, state } = await makeState();
  const held = await acquireLock(state, { isAlive: () => true });
  assert.equal(held.ok, true);
  let called = false;
  const r = await withLock(state, async () => { called = true; });
  assert.equal(r.locked, false);
  assert.equal(called, false, '拿不到锁不得写状态');
  await releaseLock(state, held.nonce);
  await rm(dir, { recursive: true, force: true });
});

test('withLock 正常执行并释放锁', async () => {
  const { dir, state } = await makeState();
  const r = await withLock(state, async () => 42);
  assert.equal(r.locked, true);
  assert.equal(r.value, 42);
  await assert.rejects(() => access(state.lockFile), '执行完必须释放');
  await rm(dir, { recursive: true, force: true });
});

test('unlockStale 只删除已退出进程的锁', async () => {
  const { dir, state } = await makeState();
  await writeFile(state.lockFile, JSON.stringify({ pid: 4242, nonce: 'n' }), 'utf8');
  const refused = await unlockStale(state, { isAlive: () => true });
  assert.equal(refused.ok, false);
  await access(state.lockFile);

  const removed = await unlockStale(state, { isAlive: () => false });
  assert.equal(removed.ok, true);
  await assert.rejects(() => access(state.lockFile));
  await rm(dir, { recursive: true, force: true });
});

/* ============================================ 第二轮：Link 白名单 */

test('Link 指向外域时拒绝，且不发起第二次请求', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse([comment(1)], { link: '<https://evil.example.com/steal>; rel="next"' });
  };
  await assert.rejects(
    () => listIssueComments({ repo: 'a/b', issue: 21, token: 'secret-token', fetchImpl }),
    /非 api\.github\.com/
  );
  assert.equal(calls, 1, '校验失败后不得再请求');
});

test('Link 使用 HTTP 时拒绝', async () => {
  const fetchImpl = async () => jsonResponse([], { link: '<http://api.github.com/repos/a/b/issues/21/comments?page=2>; rel="next"' });
  await assert.rejects(() => listIssueComments({ repo: 'a/b', issue: 21, token: 't', fetchImpl }), /HTTPS/);
});

test('Link 路径不属于当前评论接口时拒绝', async () => {
  const fetchImpl = async () => jsonResponse([], { link: '<https://api.github.com/repos/other/repo/issues/21/comments?page=2>; rel="next"' });
  await assert.rejects(() => listIssueComments({ repo: 'a/b', issue: 21, token: 't', fetchImpl }), /路径不属于/);
});

test('validateNextUrl 合法形态通过', () => {
  const v = validateNextUrl('https://api.github.com/repos/a/b/issues/21/comments?page=3', { repo: 'a/b', issue: 21 });
  assert.equal(v.ok, true);
});

/* ============================================ 第二轮：token 脱敏 */

test('错误响应体中的 token 会被脱敏', async () => {
  const token = 'fake-token-for-redaction-test';
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => `bad credentials for ${token}`,
    headers: { get: () => null }
  });
  await assert.rejects(
    () => listIssueComments({ repo: 'a/b', issue: 21, token, fetchImpl }),
    (err) => {
      assert.equal(err.message.includes(token), false, '错误信息不得包含 token');
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    }
  );
});

test('redactToken 处理空值', () => {
  assert.equal(redactToken('abc', 'x'), 'abc');
  assert.equal(redactToken('token-abc', 'abc'), 'token-[REDACTED]');
});

/* ============================================ 第二轮：路径校验 */

test('仓库相对路径校验拒绝 Windows 与穿越形式', () => {
  const good = ['public/lessons/binary-search.html', 'docs/knowledge-base/README.md', 'a.md'];
  for (const p of good) assert.equal(isValidRepoPath(p), true, `应接受 ${p}`);

  const bad = [
    '', '  ', '/abs/path', 'C:\\temp\\x', 'C:/temp/x', '\\\\server\\share\\x',
    '..\\..\\etc', 'a/../b', 'a//b', './a', 'a/./b', '../a', 'a\\b', 'a/b/'
  ];
  for (const p of bad) assert.equal(isValidRepoPath(p), false, `应拒绝 ${JSON.stringify(p)}`);
});

test('parseComment 拒绝 Windows 绝对路径的 allow', () => {
  const r = parseComment(taskBody({ allow: 'C:\\Windows\\System32\\x' }));
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /非法的仓库相对路径/);
});
