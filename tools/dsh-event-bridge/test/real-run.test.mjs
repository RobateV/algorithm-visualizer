import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { sha256, BridgeState } from '../lib/state.mjs';
import { validateGrant, loadGrant, consumeGrant, grantExists } from '../lib/grant.mjs';
import { orchestrateTask } from '../lib/orchestrator.mjs';

const git = promisify(execFile);
const SHA = 'c7b172fea1bde714f758df1e875340a1681e7d4e';
const OTHER = 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';
const REPO = 'RobateV/algorithm-visualizer';
const DETAIL = 'M2.7 冒烟测试：仅在隔离 worktree 新增一行标记。';
const CFG = { repo: REPO, allowedActors: ['RobateV'], allowedPrs: [4], maxAttempts: 3, marker: '[DSH-REVIEW-TASK]', maxBodyLength: 20000 };

const bodyFor = (sha = SHA, reviewId = 'work-real-001') =>
  `[DSH-REVIEW-TASK]\nrepo: ${REPO}\npr_number: 4\nexpected_head_sha: ${sha}\nreview_id: ${reviewId}\nattempt: 1\n---\n${DETAIL}`;

const recordFor = (body, sha = SHA, commentId = 9101) =>
  ({ status: 'accepted', commentId, prNumber: 4, headSha: sha, reviewId: 'work-real-001', bodyDigest: sha256(body) });

function mockGitHub({ body, headSha = SHA }) {
  return {
    async getComment() { return { id: 9101, body, user: { login: 'RobateV' }, issueUrl: `${REPO}/issues/4` }; },
    async getPull() { return { number: 4, state: 'open', headSha }; }
  };
}

async function makeRepo() {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-real-'));
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

function grantFor(overrides = {}) {
  const now = Date.now();
  return {
    version: 1,
    nonce: 'nonce-abcdef12',
    repo: REPO,
    prNumber: 4,
    headSha: SHA,
    commentId: 9101,
    bodyDigest: sha256(bodyFor()),
    maxRuns: 1,
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
    ...overrides
  };
}

const expectedFor = (overrides = {}) => ({
  repo: REPO, prNumber: 4, headSha: SHA, commentId: 9101,
  bodyDigest: sha256(bodyFor()), workRoot: path.join(tmpdir(), 'wt'), now: Date.now(),
  ...overrides
});

/* ================================================= 授权校验 */

test('完整授权通过校验', () => {
  assert.deepEqual(validateGrant(grantFor(), expectedFor()), []);
});

test('授权与任务不匹配一律拒绝', () => {
  const exp = expectedFor();
  assert.match(validateGrant(grantFor({ repo: 'other/repo' }), exp).join(), /仓库不匹配/);
  assert.match(validateGrant(grantFor({ prNumber: 9 }), exp).join(), /PR 不匹配/);
  assert.match(validateGrant(grantFor({ headSha: OTHER }), exp).join(), /headSha 与任务不一致/);
  assert.match(validateGrant(grantFor({ commentId: 42 }), exp).join(), /commentId 与任务不一致/);
  assert.match(validateGrant(grantFor({ bodyDigest: sha256('tampered') }), exp).join(), /正文摘要不一致/);
});

test('过期、超长有效期、maxRuns≠1 均拒绝', () => {
  const now = Date.now();
  const exp = expectedFor();
  assert.match(validateGrant(grantFor({ expiresAt: new Date(now - 1000).toISOString() }), exp).join(), /已过期/);
  assert.match(
    validateGrant(grantFor({
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 25 * 60 * 60_000).toISOString()
    }), exp).join(),
    /不得超过 24 小时/
  );
  assert.match(validateGrant(grantFor({ maxRuns: 5 }), exp).join(), /maxRuns = 1/);
  assert.match(validateGrant(grantFor({ headSha: 'abc' }), exp).join(), /40 位十六进制/);
});

test('工作根目录不匹配时拒绝', () => {
  const exp = expectedFor({ workRoot: 'C:\\allowed\\root' });
  assert.match(validateGrant(grantFor({ workRoot: 'C:\\other\\root' }), exp).join(), /工作根目录/);
});

test('授权只能消费一次', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-grant-'));
  const file = path.join(dir, 'grant.json');
  await writeFile(file, JSON.stringify(grantFor()), 'utf8');
  assert.equal(await grantExists(file), true);
  const loaded = await loadGrant(file);
  assert.equal(loaded.nonce, 'nonce-abcdef12');

  const used = await consumeGrant(file);
  assert.equal(await grantExists(file), false, '原文件应被移走');
  assert.equal(await grantExists(used), true, '消费后留下证据文件');
  await assert.rejects(() => consumeGrant(file), '第二次消费必须失败');
  await rm(dir, { recursive: true, force: true });
});

/* ================================================= 真实执行门禁 */

async function runReal({ grant, grantPath, isolationConfirmed = true }) {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor(head);
  const stateDir = path.join(base, 'state');
  const state = await new BridgeState(stateDir).init();
  const calls = [];
  const result = await orchestrateTask({
    record: recordFor(body, head),
    deps: {
      client: mockGitHub({ body, headSha: head + '' }), cfg: CFG, state,
      projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
      run: async ({ argv, cwd }) => { calls.push({ argv, cwd }); return { code: 0, timedOut: false, cancelled: false, durationMs: 1 }; }
    },
    options: { execute: true, mode: 'real', grant, grantPath, isolationConfirmed, timeoutMs: 5000 }
  });
  return { result, calls, state, base, repo, head };
}

test('真实执行未确认隔离时拒绝', async () => {
  const { base } = await makeRepo();
  const path1 = path.join(base, 'grant.json');
  await writeFile(path1, JSON.stringify(grantFor()), 'utf8');
  const { result, calls } = await runReal({ grant: grantFor(), grantPath: path1, isolationConfirmed: false });
  assert.equal(result.status, 'rejected');
  assert.match(result.reasons.join(), /隔离清单/);
  assert.equal(calls.length, 0);
  await rm(base, { recursive: true, force: true });
});

test('真实执行缺少授权文件时拒绝', async () => {
  const { result, calls } = await runReal({ grant: null, grantPath: '', isolationConfirmed: true });
  assert.equal(result.status, 'rejected');
  assert.match(result.reasons.join(), /一次性授权文件/);
  assert.equal(calls.length, 0);
});

test('真实执行：授权 SHA 与任务不符时拒绝', async () => {
  const { base, head } = await makeRepo();
  const body = bodyFor(head);
  const bad = grantFor({ headSha: OTHER, bodyDigest: sha256(body), commentId: 9101 });
  const p = path.join(base, 'grant.json');
  await writeFile(p, JSON.stringify(bad), 'utf8');
  const { result, calls } = await runReal({ grant: bad, grantPath: p, headSha: head });
  assert.equal(result.status, 'rejected');
  assert.match(result.reasons.join(), /授权无效/);
  assert.equal(calls.length, 0);
  await rm(base, { recursive: true, force: true });
});

test('真实执行成功：消费授权、记录 mode=real、且只跑一次', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor(head);
  const good = grantFor({ headSha: head, bodyDigest: sha256(body) });
  const grantPath = path.join(base, 'grant.json');
  await writeFile(grantPath, JSON.stringify(good), 'utf8');

  const stateDir = path.join(base, 'state');
  const state = await new BridgeState(stateDir).init();
  const calls = [];
  const result = await orchestrateTask({
    record: recordFor(body, head),
    deps: {
      client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
      projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
      run: async ({ argv, cwd }) => { calls.push({ argv, cwd }); return { code: 0, timedOut: false, cancelled: false, durationMs: 1 }; }
    },
    options: { execute: true, mode: 'real', grant: good, grantPath, isolationConfirmed: true, timeoutMs: 5000 }
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal(await grantExists(grantPath), false, '授权应被消费');
  const outcome = state.getTaskOutcome(`${4}:${head}:9101`);
  assert.equal(outcome.mode, 'real', '真实执行结果必须标记 real');

  // 再次执行同一任务：已成功且同模式 → 跳过，不再跑
  const again = await orchestrateTask({
    record: recordFor(body, head),
    deps: {
      client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
      projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
      run: async () => { calls.push({}); return { code: 0 }; }
    },
    options: { execute: true, mode: 'real', grant: good, grantPath: '', isolationConfirmed: true, timeoutMs: 5000 }
  });
  assert.equal(again.status, 'skipped');
  assert.equal(calls.length, 1, '不重复执行');
  await rm(base, { recursive: true, force: true });
});

test('Mock 的成功不会让真实任务被跳过', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor(head);
  const stateDir = path.join(base, 'state');
  const state = await new BridgeState(stateDir).init();

  const deps = {
    client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
    projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
    run: async () => ({ code: 0, timedOut: false, cancelled: false, durationMs: 1 })
  };

  const mockRun = await orchestrateTask({ record: recordFor(body, head), deps, options: { execute: true, mode: 'mock', timeoutMs: 5000 } });
  assert.equal(mockRun.status, 'succeeded');
  assert.equal(state.getTaskOutcome(`${4}:${head}:9101`).mode, 'mock');

  const good = grantFor({ headSha: head, bodyDigest: sha256(body) });
  const grantPath = path.join(base, 'grant.json');
  await writeFile(grantPath, JSON.stringify(good), 'utf8');
  const realRun = await orchestrateTask({
    record: recordFor(body, head), deps,
    options: { execute: true, mode: 'real', grant: good, grantPath, isolationConfirmed: true, timeoutMs: 5000 }
  });
  assert.equal(realRun.status, 'succeeded', '真实任务不应被 Mock 成功跳过');
  await rm(base, { recursive: true, force: true });
});

/* ================================================= 崩溃 / 中断恢复 */

test('执行前预留：进程中断后标记 interrupted 并暂停，不自动重跑', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor(head);
  const stateDir = path.join(base, 'state');

  // 模拟"上次进程在真实执行中崩溃"：只剩 reserved 记录
  const crashed = await new BridgeState(stateDir).init();
  await crashed.recordTaskOutcome(`${4}:${head}:9101`, { status: 'reserved', mode: 'real', attempts: 1, reviewId: 'work-real-001', headSha: head });

  const state = await new BridgeState(stateDir).init();
  let runs = 0;
  const result = await orchestrateTask({
    record: recordFor(body, head),
    deps: {
      client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
      projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
      run: async () => { runs += 1; return { code: 0 }; }
    },
    options: { execute: true, mode: 'real', grant: grantFor({ headSha: head, bodyDigest: sha256(body) }), grantPath: path.join(base, 'missing.json'), isolationConfirmed: true, timeoutMs: 5000 }
  });

  assert.equal(result.status, 'interrupted');
  assert.equal(runs, 0, '中断记录不允许自动重跑');
  assert.equal(state.getTaskOutcome(`${4}:${head}:9101`).status, 'interrupted');
  assert.equal((await state.isPaused()).paused, true, '应自动暂停等待人工确认');
  await rm(base, { recursive: true, force: true });
});

test('真实执行抛错时保留 reserved，重启后判定 interrupted', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor(head);
  const good = grantFor({ headSha: head, bodyDigest: sha256(body) });
  const grantPath = path.join(base, 'grant.json');
  await writeFile(grantPath, JSON.stringify(good), 'utf8');
  const stateDir = path.join(base, 'state');
  const state = await new BridgeState(stateDir).init();

  await assert.rejects(() => orchestrateTask({
    record: recordFor(body, head),
    deps: {
      client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
      projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
      run: async () => { throw new Error('模拟进程被杀'); }
    },
    options: { execute: true, mode: 'real', grant: good, grantPath, isolationConfirmed: true, timeoutMs: 5000 }
  }), /模拟进程被杀/);

  const reopened = await new BridgeState(stateDir).init();
  assert.equal(reopened.getTaskOutcome(`${4}:${head}:9101`).status, 'reserved', '必须留下 reserved 证据');
  await rm(base, { recursive: true, force: true });
});
