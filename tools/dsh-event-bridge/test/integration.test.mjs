import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { sha256 } from '../lib/state.mjs';
import { refetchAndVerify } from '../lib/task-refetch.mjs';
import { planTasks } from '../executor.mjs';
import { runTaskWithGuards } from '../lib/runner.mjs';
import { createCircuitBreaker } from '../lib/lock.mjs';
import { buildResultReport, checkWritebackGuards, performWriteback, RESULT_MARKER } from '../lib/writeback.mjs';

const git = promisify(execFile);
const SHA = 'c7b172fea1bde714f758df1e875340a1681e7d4e';
const NEW_SHA = 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';
const REPO = 'RobateV/algorithm-visualizer';
const KEY = 'dsh-4-c7b172fea1bd-9101';

const CFG = {
  repo: REPO, allowedActors: ['RobateV'], allowedPrs: [4],
  maxAttempts: 3, marker: '[DSH-REVIEW-TASK]', maxBodyLength: 20000
};

function taskBody(overrides = {}) {
  const f = { repo: REPO, pr_number: '4', expected_head_sha: SHA, review_id: 'work-it-001', attempt: '1', ...overrides };
  return `[DSH-REVIEW-TASK]\n${Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n## 问题\n集成测试`;
}

function recordFor(body) {
  return { status: 'accepted', commentId: 9101, prNumber: 4, headSha: SHA, reviewId: 'work-it-001', bodyDigest: sha256(body) };
}

function mockGitHub({ body = taskBody(), deleted = false, login = 'RobateV', prState = 'open', headSha = SHA } = {}) {
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

const okRun = async () => ({ code: 0, timedOut: false, cancelled: false, durationMs: 5 });

/* ===================================================== 完整模拟闭环 */

test('完整闭环：接收 → 二次校验 → 隔离工作区 → mock 执行 → 结果回写', async () => {
  const { base, repo, head } = await makeRepo();
  const body = taskBody({ expected_head_sha: head });
  const record = recordFor(body);
  record.headSha = head;
  const client = mockGitHub({ body, headSha: head });

  // 1. 二次校验
  const check = await refetchAndVerify({ client, record, cfg: CFG });
  assert.equal(check.ok, true, check.reasons.join('；'));

  // 2. 隔离工作区（只计划）
  const planned = await planTasks({ records: [record], client, cfg: CFG, projectRoot: repo, workRoot: path.join(base, 'wt') });
  assert.equal(planned[0].ok, true);
  assert.equal(planned[0].workspace.dir.startsWith(base), true);

  // 3. mock 执行
  const started = new Date().toISOString();
  const outcome = await runTaskWithGuards({
    taskKey: KEY, taskText: '修复示例', cwd: repo, lockDir: path.join(base, 'locks'),
    timeoutMs: 5000, run: okRun
  });
  assert.equal(outcome.status, 'succeeded');

  // 4. 结果回写（dry-run）
  const wb = await performWriteback({
    enabled: true, dryRun: true, taskId: record.reviewId, prNumber: 4,
    baseSha: head, expectedHeadSha: head, currentHeadSha: head, prState: 'open',
    branch: 'feat/lesson-editor-m2', newSha: NEW_SHA, status: 'succeeded',
    attempts: outcome.attempts.length, startedAt: started, finishedAt: new Date().toISOString(),
    tests: '66/66 通过'
  });
  assert.equal(wb.ok, true);
  assert.equal(wb.pushed, false, 'dry-run 不得推送');
  assert.match(wb.body, /^\[DSH-RESULT\]/);
  assert.match(wb.body, /base_sha: [0-9a-f]{40}/);
  assert.match(wb.body, /new_sha: d0d0d0/);
  assert.match(wb.body, /66\/66 通过/);

  await rm(base, { recursive: true, force: true });
});

/* ===================================================== 回写守门 */

test('默认禁止回写', async () => {
  const r = await performWriteback({ enabled: false, taskId: 't', prNumber: 4, baseSha: SHA, status: 'succeeded' });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /未启用/);
});

test('PR HEAD 变化时拒绝回写', () => {
  const reasons = checkWritebackGuards({ enabled: true, prState: 'open', expectedHeadSha: SHA, currentHeadSha: NEW_SHA, branch: 'feat/x' });
  assert.match(reasons.join(), /HEAD 已变化/);
});

test('PR 关闭时拒绝回写', () => {
  const reasons = checkWritebackGuards({ enabled: true, prState: 'closed', expectedHeadSha: SHA, currentHeadSha: SHA, branch: 'feat/x' });
  assert.match(reasons.join(), /PR 状态/);
});

test('拒绝写入 main/master', () => {
  assert.match(checkWritebackGuards({ enabled: true, branch: 'main' }).join(), /受保护分支/);
  assert.match(checkWritebackGuards({ enabled: true, branch: 'master' }).join(), /受保护分支/);
  assert.deepEqual(checkWritebackGuards({ enabled: true, branch: 'feat/x' }), []);
});

test('真实回写只做普通 push，且强制关闭 force', async () => {
  const calls = [];
  const io = {
    commit: async (msg) => { calls.push(['commit', msg]); return 'abc123'; },
    push: async (opts) => { calls.push(['push', opts]); },
    comment: async (pr, body) => { calls.push(['comment', pr, body.slice(0, 12)]); }
  };
  const r = await performWriteback({
    enabled: true, dryRun: false, taskId: 't', prNumber: 4, baseSha: SHA,
    expectedHeadSha: SHA, currentHeadSha: SHA, prState: 'open', branch: 'feat/x',
    newSha: NEW_SHA, status: 'succeeded', attempts: 1, io
  });
  assert.equal(r.ok, true);
  assert.equal(r.pushed, true);
  assert.equal(r.commented, true);
  const push = calls.find((c) => c[0] === 'push');
  assert.equal(push[1].force, false, '必须显式 force:false');
  assert.ok(calls.some((c) => c[0] === 'comment'));
});

test('报告含失败状态与错误摘要', () => {
  const body = buildResultReport({
    taskId: 't', prNumber: 4, baseSha: SHA, newSha: null, status: 'failed',
    attempts: 3, startedAt: 'a', finishedAt: 'b', tests: '未运行', errors: ['exit=1', '超时']
  });
  assert.match(body, /status: failed/);
  assert.match(body, /- exit=1/);
  assert.match(body, /- 超时/);
  assert.throws(() => buildResultReport({ taskId: 't', prNumber: 4, baseSha: SHA, status: 'unknown' }), /未知的执行状态/);
});

/* ===================================================== 拒绝路径 */

test('评论被编辑后不进入执行', async () => {
  const { base, repo, head } = await makeRepo();
  const body = taskBody({ expected_head_sha: head });
  const record = recordFor(body);
  record.headSha = head;
  const client = mockGitHub({ body: body + '\n被篡改', headSha: head });
  const out = await planTasks({ records: [record], client, cfg: CFG, projectRoot: repo, workRoot: path.join(base, 'wt') });
  assert.equal(out[0].ok, false);
  assert.match(out[0].reasons.join(), /已被编辑/);
  await rm(base, { recursive: true, force: true });
});

test('评论被删除后不进入执行', async () => {
  const { base, repo, head } = await makeRepo();
  const body = taskBody({ expected_head_sha: head });
  const record = recordFor(body);
  record.headSha = head;
  const out = await planTasks({ records: [record], client: mockGitHub({ deleted: true }), cfg: CFG, projectRoot: repo, workRoot: path.join(base, 'wt') });
  assert.equal(out[0].ok, false);
  assert.match(out[0].reasons.join(), /已被删除/);
  await rm(base, { recursive: true, force: true });
});

test('SHA 过期后不进入执行', async () => {
  const { base, repo, head } = await makeRepo();
  const body = taskBody({ expected_head_sha: SHA });
  const record = recordFor(body);
  record.headSha = SHA;
  const out = await planTasks({ records: [record], client: mockGitHub({ body, headSha: head }), cfg: CFG, projectRoot: repo, workRoot: path.join(base, 'wt') });
  assert.equal(out[0].ok, false);
  assert.match(out[0].reasons.join(), /HEAD 已变/);
  await rm(base, { recursive: true, force: true });
});

/* ===================================================== 运行时异常 */

test('执行失败时熔断并生成失败报告', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-it-'));
  const circuit = createCircuitBreaker({ threshold: 1 });
  const fail = async () => ({ code: 1, timedOut: false, cancelled: false, durationMs: 1 });
  const res = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: base, lockDir: base, timeoutMs: 1000, run: fail, circuit });
  assert.equal(res.status, 'failed');
  assert.equal(circuit.isOpen(), true);
  assert.match(buildResultReport({ taskId: 't', prNumber: 4, baseSha: SHA, status: 'failed', attempts: 3 }), /status: failed/);
  await rm(base, { recursive: true, force: true });
});

test('中断后锁自动释放，重启可继续（恢复语义）', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-it-'));
  const first = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: base, lockDir: base, timeoutMs: 1000, run: okRun });
  assert.equal(first.status, 'succeeded');
  const second = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: base, lockDir: base, timeoutMs: 1000, run: okRun });
  assert.equal(second.status, 'succeeded', '锁已释放，可再次执行');
  await rm(base, { recursive: true, force: true });
});

test('并发同一任务只执行一次', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-it-'));
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async () => { await gate; return { code: 0, timedOut: false, cancelled: false, durationMs: 1 }; };
  const a = runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: base, lockDir: base, timeoutMs: 5000, run: slow });
  await new Promise((r) => setTimeout(r, 30));
  const b = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: base, lockDir: base, timeoutMs: 5000, run: slow });
  release();
  assert.equal((await a).status, 'succeeded');
  assert.equal(b.status, 'locked');
  await rm(base, { recursive: true, force: true });
});

test('主分支不会出现在回写分支里', () => {
  const body = buildResultReport({ taskId: 't', prNumber: 4, baseSha: SHA, status: 'skipped' });
  assert.equal(body.includes(RESULT_MARKER), true);
  assert.equal(checkWritebackGuards({ enabled: true, branch: 'main' }).length > 0, true);
});
