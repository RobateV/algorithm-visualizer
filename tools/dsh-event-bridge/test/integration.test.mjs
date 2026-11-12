import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { sha256, BridgeState } from '../lib/state.mjs';
import { runCli } from '../executor.mjs';
import { orchestrateTask, buildTaskContract } from '../lib/orchestrator.mjs';
import { buildResultReport, checkWritebackGuards, performWriteback, RESULT_MARKER } from '../lib/writeback.mjs';
import { acquireLock, releaseLock } from '../lib/lock.mjs';

const git = promisify(execFile);
const SHA = 'c7b172fea1bde714f758df1e875340a1681e7d4e';
const OTHER = 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';
const REPO = 'RobateV/algorithm-visualizer';
const DETAIL = '把标题改成「冒泡排序 · 课堂精讲」，并补充一条测试。';

const CFG = { repo: REPO, allowedActors: ['RobateV'], allowedPrs: [4], maxAttempts: 3, marker: '[DSH-REVIEW-TASK]', maxBodyLength: 20000 };

function bodyFor({ sha = SHA, reviewId = 'work-it-001', detail = DETAIL } = {}) {
  return `[DSH-REVIEW-TASK]\nrepo: ${REPO}\npr_number: 4\nexpected_head_sha: ${sha}\nreview_id: ${reviewId}\nattempt: 1\n---\n${detail}`;
}
const recordFor = (body, sha = SHA) => ({ status: 'accepted', commentId: 9101, prNumber: 4, headSha: sha, reviewId: 'work-it-001', bodyDigest: sha256(body) });

function mockGitHub({ body = bodyFor(), deleted = false, login = 'RobateV', prState = 'open', headSha = SHA } = {}) {
  return {
    async getComment() {
      if (deleted) return null;
      return { id: 9101, body, user: { login }, issueUrl: `${REPO}/issues/4` };
    },
    async getPull() { return { number: 4, state: prState, headSha }; }
  };
}

async function makeRepo() {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-it-'));
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await git('git', ['init', '-q', repo]);
  await git('git', ['-C', repo, 'config', 'user.email', 't@local']);
  await git('git', ['-C', repo, 'config', 'user.name', 't']);
  await writeFile(path.join(repo, 'a.txt'), 'x', 'utf8');
  await git('git', ['-C', repo, 'add', '.']);
  await git('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const head = (await git('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  return { base, repo, head };
}

async function writeInbox(dir, record) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'inbox.jsonl'), JSON.stringify(record) + '\n', 'utf8');
}

/* ============================================ P0-1：真实入口使用校验后的任务 */

test('CLI execute：DSH 收到的是校验后的任务正文，cwd 是真实 worktree', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor({ sha: head });
  const record = recordFor(body, head);
  const stateDir = path.join(base, 'state');
  await writeInbox(stateDir, record);

  const seen = [];
  const run = async ({ argv, cwd }) => {
    seen.push({ argv, cwd });
    return { code: 0, timedOut: false, cancelled: false, durationMs: 1 };
  };

  const code = await runCli(['--execute', '--mock-dsh', '--state', stateDir], {
    client: mockGitHub({ body, headSha: head }),
    state: await new BridgeState(stateDir).init(),
    projectRoot: repo,
    workRoot: path.join(base, 'wt'),
    run
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1, '应执行一次');

  const taskText = seen[0].argv[3];
  assert.match(taskText, /任务正文/, '必须是固定契约 + 真实任务正文');
  assert.match(taskText, new RegExp(DETAIL.slice(0, 12)), '正文来自 GitHub 评论');
  assert.equal(taskText.includes('[mock]'), false, '不得使用占位文字');
  assert.equal(seen[0].cwd.startsWith(path.join(base, 'wt')), true, 'cwd 必须是隔离工作区');
  await access(seen[0].cwd);
  await rm(base, { recursive: true, force: true });
});

test('plan 模式不创建 worktree、不执行', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor({ sha: head });
  const record = recordFor(body, head);
  const stateDir = path.join(base, 'state');
  await writeInbox(stateDir, record);

  let calls = 0;
  const code = await runCli(['--state', stateDir], {
    client: mockGitHub({ body, headSha: head }),
    state: await new BridgeState(stateDir).init(),
    projectRoot: repo,
    workRoot: path.join(base, 'wt'),
    run: async () => { calls += 1; return { code: 0 }; }
  });
  assert.equal(code, 0);
  assert.equal(calls, 0);
  await assert.rejects(() => access(path.join(base, 'wt')), 'plan 模式不应创建目录');
  await rm(base, { recursive: true, force: true });
});

test('主工作区有未提交改动时拒绝执行', async () => {
  const { base, repo, head } = await makeRepo();
  await writeFile(path.join(repo, 'dirty.txt'), 'x', 'utf8');
  const body = bodyFor({ sha: head });
  const stateDir = path.join(base, 'state');
  await writeInbox(stateDir, recordFor(body, head));

  await assert.rejects(() => orchestrateTask({
    record: recordFor(body, head),
    deps: { client: mockGitHub({ body, headSha: head }), cfg: CFG, state: { getTaskOutcome: () => null, recordTaskOutcome: async () => {}, setPaused: async () => {} }, projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(base, 'locks'), run: async () => ({ code: 0 }) },
    options: { execute: true }
  }), /未提交改动/);
  await rm(base, { recursive: true, force: true });
});

/* ============================================ P0-2：单一编排 + 不重放 */

test('成功任务持久化后不重放', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor({ sha: head });
  const stateDir = path.join(base, 'state');
  const state = await new BridgeState(stateDir).init();
  let runs = 0;

  const deps = {
    client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
    projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
    run: async () => { runs += 1; return { code: 0, timedOut: false, cancelled: false, durationMs: 1 }; }
  };
  const first = await orchestrateTask({ record: recordFor(body, head), deps, options: { execute: true } });
  assert.equal(first.status, 'succeeded');

  const reopened = await new BridgeState(stateDir).init();
  const second = await orchestrateTask({
    record: recordFor(body, head),
    deps: { ...deps, state: reopened },
    options: { execute: true }
  });
  assert.equal(second.status, 'skipped');
  assert.equal(second.reason, 'already-succeeded');
  assert.equal(runs, 1, '不应重复执行已成功的任务');
  await rm(base, { recursive: true, force: true });
});

test('失败任务会被记录，重启后可重试', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor({ sha: head });
  const stateDir = path.join(base, 'state');
  const state = await new BridgeState(stateDir).init();
  const deps = {
    client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
    projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
    run: async () => ({ code: 1, timedOut: false, cancelled: false, durationMs: 1 })
  };
  const first = await orchestrateTask({ record: recordFor(body, head), deps, options: { execute: true } });
  assert.equal(first.status, 'failed');

  const reopened = await new BridgeState(stateDir).init();
  assert.equal(reopened.getTaskOutcome(first.key).status, 'failed');
  const second = await orchestrateTask({ record: recordFor(body, head), deps: { ...deps, state: reopened }, options: { execute: true } });
  assert.notEqual(second.status, 'skipped', '失败任务允许重试');
  await rm(base, { recursive: true, force: true });
});

/* ============================================ 拒绝路径 */

const rejectCases = [
  { name: '评论被编辑', opts: { body: bodyFor() + '\n改动' }, pattern: /已被编辑/ },
  { name: '评论被删除', opts: { deleted: true }, pattern: /已被删除/ },
  { name: '作者冒充', opts: { login: 'attacker' }, pattern: /不在可信名单/ },
  { name: 'PR 已关闭', opts: { prState: 'closed' }, pattern: /closed/ }
];

for (const item of rejectCases) {
  test(item.name + '时不进入执行', async () => {
    const { base, repo, head } = await makeRepo();
    const body = bodyFor({ sha: head });
    let runs = 0;
    const r = await orchestrateTask({
      record: recordFor(body, head),
      deps: {
        client: mockGitHub({ headSha: head, body, ...item.opts }), cfg: CFG,
        state: { getTaskOutcome: () => null, recordTaskOutcome: async () => {} },
        projectRoot: repo, workRoot: path.join(base, 'wt'),
        run: async () => { runs += 1; return { code: 0 }; }
      },
      options: { execute: true }
    });
    assert.equal(r.status, 'rejected');
    assert.match(r.reasons.join(), item.pattern);
    assert.equal(runs, 0);
    await rm(base, { recursive: true, force: true });
  });
}

/* ============================================ P0-3：回写 fail-closed */

const GOOD_IO = {
  commit: async () => 'sha',
  push: async () => {},
  comment: async () => {},
  refresh: async () => ({ state: 'open', headSha: SHA })
};
const goodWb = { enabled: true, prState: 'open', expectedHeadSha: SHA, currentHeadSha: SHA, branch: 'feat/x', io: GOOD_IO };

test('回写守门：字段齐全才通过', () => {
  assert.deepEqual(checkWritebackGuards(goodWb), []);
});

test('回写守门：缺字段一律拒绝', () => {
  assert.match(checkWritebackGuards({ ...goodWb, prState: undefined }).join(), /PR 状态缺失/);
  assert.match(checkWritebackGuards({ ...goodWb, currentHeadSha: undefined }).join(), /currentHeadSha 缺失/);
  assert.match(checkWritebackGuards({ ...goodWb, branch: '' }).join(), /缺少目标分支/);
  assert.match(checkWritebackGuards({ ...goodWb, io: {} }).join(), /缺少 IO 实现/);
  assert.match(checkWritebackGuards({ ...goodWb, enabled: false }).join(), /未启用/);
  assert.match(checkWritebackGuards({ ...goodWb, branch: 'main' }).join(), /受保护分支/);
});

test('回写 dry-run 不调用 IO', async () => {
  const calls = [];
  const io = { commit: async () => calls.push('c'), push: async () => calls.push('p'), comment: async () => calls.push('m'), refresh: async () => calls.push('r') };
  const r = await performWriteback({ ...goodWb, io, dryRun: true, taskId: 't', prNumber: 4, baseSha: SHA, status: 'succeeded' });
  assert.equal(r.ok, true);
  assert.equal(r.pushed, false);
  assert.match(r.body, /^\[DSH-RESULT\]/);
  assert.equal(calls.length, 0);
});

test('回写 push 前复查 HEAD，变化则拒绝', async () => {
  const calls = [];
  const io = { ...GOOD_IO, refresh: async () => ({ state: 'open', headSha: OTHER }), commit: async () => calls.push('c') };
  const r = await performWriteback({ ...goodWb, io, dryRun: false, taskId: 't', prNumber: 4, baseSha: SHA, status: 'succeeded' });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /HEAD 已变化/);
  assert.equal(calls.length, 0, '复查失败不得提交');
});

test('回写成功路径只做普通 push', async () => {
  const calls = [];
  const io = {
    commit: async () => { calls.push('commit'); return 'abc'; },
    push: async (o) => { calls.push(['push', o]); },
    comment: async () => { calls.push('comment'); },
    refresh: async () => ({ state: 'open', headSha: SHA })
  };
  const r = await performWriteback({ ...goodWb, io, dryRun: false, taskId: 't', prNumber: 4, baseSha: SHA, status: 'succeeded' });
  assert.equal(r.ok, true);
  assert.equal(r.pushed, true);
  assert.equal(calls.find((c) => Array.isArray(c))[1].force, false);
});

test('报告含失败状态与错误摘要', () => {
  const body = buildResultReport({ taskId: 't', prNumber: 4, baseSha: SHA, status: 'failed', attempts: 3, tests: '未运行', errors: ['exit=1'] });
  assert.match(body, /status: failed/);
  assert.match(body, /- exit=1/);
  assert.equal(body.includes(RESULT_MARKER), true);
});

/* ============================================ P0-4：锁所有权 */

test('运行中超过 staleMs 的锁不会被第二个执行器接管', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-lock-'));
  const first = await acquireLock(dir, 'k1', { staleMs: 1000 });
  // 模拟运行 5 秒后（远超 staleMs）但仍在续期
  const { renewLock } = await import('../lib/lock.mjs');
  await renewLock(first.file, first.token);
  const second = await acquireLock(dir, 'k1', { staleMs: 1000 });
  assert.equal(second.acquired, false, '仍在续期的锁不可被接管');

  // 非持有者释放无效
  assert.equal(await releaseLock(first.file, 'wrong-token'), false);
  await access(first.file);
  assert.equal(await releaseLock(first.file, first.token), true);
  await rm(dir, { recursive: true, force: true });
});

/* ============================================ P0-A：并发不互相破坏 */

test('并发同一任务：第二个拿不到锁，且不会删除第一个的工作区', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor({ sha: head });
  const record = recordFor(body, head);
  const stateDir = path.join(base, 'state');
  const state = await new BridgeState(stateDir).init();
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });

  const deps = {
    client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
    projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
    run: async () => { runs += 1; await gate; return { code: 0, timedOut: false, cancelled: false, durationMs: 1 }; }
  };

  const first = orchestrateTask({ record, deps, options: { execute: true, timeoutMs: 60000 } });
  await new Promise((r) => setTimeout(r, 400));
  const second = await orchestrateTask({ record, deps, options: { execute: true, timeoutMs: 60000 } });
  assert.equal(second.status, 'locked', '第二个必须被任务锁挡住');

  release();
  const firstResult = await first;
  assert.equal(firstResult.status, 'succeeded');
  assert.equal(runs, 1, '同一任务只执行一次');
  await access(firstResult.workspace.realPath || firstResult.workspace.dir);
  await rm(base, { recursive: true, force: true });
});

/* ============================================ P0-B：总尝试次数跨重启累计 */

test('失败任务跨多次重启也不会突破总尝试上限', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor({ sha: head });
  const record = recordFor(body, head);
  const stateDir = path.join(base, 'state');
  const opts = { execute: true, timeoutMs: 2000 };
  const failRun = async () => ({ code: 1, timedOut: false, cancelled: false, durationMs: 1 });
  let totalRuns = 0;

  // 模拟 4 次"重启"：每次都重新 init 状态
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const state = await new BridgeState(stateDir).init();
    const r = await orchestrateTask({
      record,
      deps: {
        client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
        projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
        run: async () => { totalRuns += 1; return failRun(); }
      },
      options: opts
    });
    statuses.push(r.status);
    if (r.status === 'failed') assert.ok(totalRuns <= 3, '总尝试次数不得超过 3');
  }

  assert.equal(totalRuns, 3, '总共只允许 1 次初试 + 2 次重试');
  assert.equal(statuses[0], 'failed');
  assert.equal(statuses[3], 'exhausted', '达到上限后应停止并等待人工处理');

  const finalState = await new BridgeState(stateDir).init();
  assert.equal(finalState.getTaskOutcome(`${record.prNumber}:${record.headSha}:${record.commentId}`).attempts, 3);
  const paused = await finalState.isPaused();
  assert.equal(paused.paused, true, '超过上限应自动暂停');
  await rm(base, { recursive: true, force: true });
});

/* ============================================ P1：dry-run 报告不需要 IO */

test('dry-run 报告不需要 IO 也能生成', async () => {
  const r = await performWriteback({
    enabled: true, dryRun: true, taskId: 't', prNumber: 4, baseSha: SHA,
    expectedHeadSha: SHA, currentHeadSha: SHA, prState: 'open', branch: 'feat/x',
    status: 'succeeded', tests: 'ok'
  });
  assert.equal(r.ok, true);
  assert.match(r.body, /^\[DSH-RESULT\]/);
});

/* ============================================ P1：锁的陈旧判定基于真实 mtime */

test('未过期但无续期的锁不会被接管；真正陈旧的锁可以接管', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-stale-'));
  const lock = await acquireLock(dir, 'k2', { staleMs: 1000 });
  const now = Date.now();

  // 让 mtime 看起来是 200ms 前：仍新鲜，不可接管
  const fresh = new Date(now - 200);
  await utimes(lock.file, fresh, fresh);
  const blocked = await acquireLock(dir, 'k2', { staleMs: 1000 });
  assert.equal(blocked.acquired, false, '未超过 staleMs 的锁不可被接管');

  // 让 mtime 看起来是 5 秒前：已陈旧，可接管
  const stale = new Date(now - 5000);
  await utimes(lock.file, stale, stale);
  const taken = await acquireLock(dir, 'k2', { staleMs: 1000 });
  assert.equal(taken.acquired, true);
  assert.equal(taken.stolen, true);
  await rm(dir, { recursive: true, force: true });
});


test('任务契约包含固定边界与真实正文', () => {
  const text = buildTaskContract({ task: { detail: DETAIL, reviewId: 'r1' }, prNumber: 4, headSha: SHA });
  assert.match(text, /隔离的 git worktree/);
  assert.match(text, /不要 force push/);
  assert.match(text, /PR: #4/);
  assert.match(text, new RegExp(DETAIL.slice(0, 12)));
  assert.throws(() => buildTaskContract({ task: { detail: '   ' }, prNumber: 4, headSha: SHA }), /正文为空/);
});
