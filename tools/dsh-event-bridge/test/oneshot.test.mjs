import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { sha256, BridgeState } from '../lib/state.mjs';
import { validateGrant } from '../lib/grant.mjs';
import { orchestrateTask } from '../lib/orchestrator.mjs';
import { buildTaskContract, ONE_SHOT_CONTRACT_HEADER } from '../lib/orchestrator.mjs';

const git = promisify(execFile);
const REPO = 'RobateV/algorithm-visualizer';
const DETAIL = '在 tests/automation-smoke/result.txt 追加一行 smoke 标记。';
const CFG = { repo: REPO, allowedActors: ['RobateV'], allowedPrs: [4], maxAttempts: 3, marker: '[DSH-REVIEW-TASK]', maxBodyLength: 20000 };

const bodyFor = (sha) =>
  `[DSH-REVIEW-TASK]\nrepo: ${REPO}\npr_number: 4\nexpected_head_sha: ${sha}\nreview_id: work-oneshot-001\nattempt: 1\n---\n${DETAIL}`;

const recordFor = (body, sha, commentId = 9101) =>
  ({ status: 'accepted', commentId, prNumber: 4, headSha: sha, reviewId: 'work-oneshot-001', bodyDigest: sha256(body) });

function mockGitHub(body, headSha) {
  return {
    async getComment() { return { id: 9101, body, user: { login: 'RobateV' }, issueUrl: `${REPO}/issues/4` }; },
    async getPull() { return { number: 4, state: 'open', headSha }; }
  };
}

async function makeRepo() {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-oneshot-'));
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

function grantFor(head, workRoot, overrides = {}) {
  const now = Date.now();
  const body = bodyFor(head);
  return {
    version: 1, nonce: 'nonce-oneshot-1', repo: REPO, prNumber: 4, headSha: head,
    commentId: 9101, bodyDigest: sha256(body), workRoot, maxRuns: 1,
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
    ...overrides
  };
}

async function setup() {
  const ctx = await makeRepo();
  const body = bodyFor(ctx.head);
  ctx.body = body;
  ctx.stateDir = path.join(ctx.base, 'state');
  ctx.state = await new BridgeState(ctx.stateDir).init();
  ctx.workRoot = path.join(ctx.base, 'wt');
  ctx.lockDir = path.join(ctx.stateDir, 'locks');
  ctx.grantPath = path.join(ctx.base, 'grant.json');
  ctx.grant = grantFor(ctx.head, ctx.workRoot);
  await writeFile(ctx.grantPath, JSON.stringify(ctx.grant), 'utf8');
  return ctx;
}

const baseOptions = (ctx, extra = {}) => ({
  execute: true, mode: 'real', grant: ctx.grant, grantPath: ctx.grantPath,
  isolationConfirmed: true, timeoutMs: 5000, ...extra
});

const depsFor = (ctx, run) => ({
  client: mockGitHub(ctx.body, ctx.head), cfg: CFG, state: ctx.state,
  projectRoot: ctx.repo, workRoot: ctx.workRoot, lockDir: ctx.lockDir, run
});

/* ============================================ P0-1 严格单次 */

test('真实执行失败时只启动一次，不重试，授权已消费', async () => {
  const ctx = await setup();
  let calls = 0;
  const result = await orchestrateTask({
    record: recordFor(ctx.body, ctx.head),
    deps: depsFor(ctx, async () => { calls += 1; return { code: 1, timedOut: false, cancelled: false, durationMs: 1 }; }),
    options: baseOptions(ctx)
  });

  assert.equal(result.status, 'failed');
  assert.equal(calls, 1, '真实模式失败后不得重新启动 DSH');
  await assert.rejects(() => access(ctx.grantPath), '授权应已被消费');
  await rm(ctx.base, { recursive: true, force: true });
});

test('真实执行超时也只启动一次', async () => {
  const ctx = await setup();
  let calls = 0;
  const result = await orchestrateTask({
    record: recordFor(ctx.body, ctx.head),
    deps: depsFor(ctx, async () => { calls += 1; return { code: 143, timedOut: true, cancelled: false, durationMs: 1 }; }),
    options: baseOptions(ctx)
  });

  assert.equal(result.status, 'failed');
  assert.equal(calls, 1, '超时后不得重试');
  await rm(ctx.base, { recursive: true, force: true });
});

test('真实执行失败后重启也不会再跑（授权已用尽）', async () => {
  const ctx = await setup();
  const run = async () => ({ code: 1, timedOut: false, cancelled: false, durationMs: 1 });
  await orchestrateTask({ record: recordFor(ctx.body, ctx.head), deps: depsFor(ctx, run), options: baseOptions(ctx) });

  const reopened = await new BridgeState(ctx.stateDir).init();
  let secondCalls = 0;
  const second = await orchestrateTask({
    record: recordFor(ctx.body, ctx.head),
    deps: { ...depsFor(ctx, async () => { secondCalls += 1; return { code: 0 }; }), state: reopened },
    options: baseOptions(ctx)
  });
  assert.notEqual(second.status, 'succeeded');
  assert.equal(secondCalls, 0, '没有授权不得再次启动真实执行');
  await rm(ctx.base, { recursive: true, force: true });
});

/* ============================================ P0-2 workRoot 必填 */

test('授权 workRoot 缺失/空/相对路径/不一致一律拒绝', () => {
  const head = 'a'.repeat(40);
  const body = bodyFor(head);
  const expected = { repo: REPO, prNumber: 4, headSha: head, commentId: 9101, bodyDigest: sha256(body), workRoot: path.join(tmpdir(), 'wt') };

  assert.match(validateGrant({ ...grantFor(head, path.join(tmpdir(), 'wt')), workRoot: undefined }, expected).join(), /workRoot 缺失/);
  assert.match(validateGrant({ ...grantFor(head, path.join(tmpdir(), 'wt')), workRoot: '' }, expected).join(), /workRoot 缺失/);
  assert.match(validateGrant({ ...grantFor(head, path.join(tmpdir(), 'wt')), workRoot: 'relative/dir' }, expected).join(), /workRoot 缺失/);
  assert.match(validateGrant(grantFor(head, path.join(tmpdir(), 'other')), expected).join(), /工作根目录与授权不一致/);
  assert.deepEqual(validateGrant(grantFor(head, expected.workRoot), expected), []);
});

/* ============================================ P0-3 一次性契约与副作用 */

test('一次性契约明确禁止 commit/push/评论/合并，并限定路径', () => {
  const text = buildTaskContract({ task: { detail: DETAIL, reviewId: 'r1' }, prNumber: 4, headSha: 'a'.repeat(40), oneShot: true });
  assert.match(text, /一次性本地冒烟测试/);
  assert.match(text, /禁止：git commit、git push/);
  assert.match(text, /创建或评论 Pull Request/);
  assert.match(text, /允许改动的路径：tests\/automation-smoke\//);
  assert.equal(text.includes('完成任务后只提交普通 commit'), false, '一次性契约不得要求 commit');
  assert.equal(ONE_SHOT_CONTRACT_HEADER.includes('commit'), true);
});

test('真实执行改动了未授权路径时判定越界', async () => {
  const ctx = await setup();
  const result = await orchestrateTask({
    record: recordFor(ctx.body, ctx.head),
    deps: depsFor(ctx, async ({ cwd }) => {
      await writeFile(path.join(cwd, 'forbidden.txt'), 'oops', 'utf8');
      return { code: 0, timedOut: false, cancelled: false, durationMs: 1 };
    }),
    options: baseOptions(ctx)
  });

  assert.equal(result.status, 'failed');
  assert.match(result.outcome.reason || '', /越界/);
  assert.match(result.outcome.reason || '', /未授权路径/);
  await rm(ctx.base, { recursive: true, force: true });
});

test('真实执行发生 commit（HEAD 变化）时判定越界', async () => {
  const ctx = await setup();
  const result = await orchestrateTask({
    record: recordFor(ctx.body, ctx.head),
    deps: depsFor(ctx, async ({ cwd }) => {
      await git('git', ['-C', cwd, 'commit', '-q', '--allow-empty', '-m', 'should-not-happen']);
      return { code: 0, timedOut: false, cancelled: false, durationMs: 1 };
    }),
    options: baseOptions(ctx)
  });

  assert.equal(result.status, 'failed');
  assert.match(result.outcome.reason || '', /HEAD 发生变化/);
  await rm(ctx.base, { recursive: true, force: true });
});

/* ============================================ P1 预留优先 + 消费失败 */

test('授权消费失败时保留 reserved 并暂停，不执行', async () => {
  const ctx = await setup();
  await rm(ctx.grantPath);   // 授权文件不存在 → consume 必然失败

  let calls = 0;
  const result = await orchestrateTask({
    record: recordFor(ctx.body, ctx.head),
    deps: depsFor(ctx, async () => { calls += 1; return { code: 0 }; }),
    options: baseOptions(ctx)
  });

  assert.equal(result.status, 'rejected');
  assert.match(result.reasons.join(), /授权消费失败/);
  assert.equal(calls, 0, '消费失败不得启动子进程');

  const outcome = ctx.state.getTaskOutcome(`4:${ctx.head}:9101`, 'real');
  assert.equal(outcome.status, 'reserved', '必须留下 reserved 证据');
  assert.equal((await ctx.state.isPaused()).paused, true, '应自动暂停等待人工核查');
  await rm(ctx.base, { recursive: true, force: true });
});

/* ============================================ P1 Mock 不消耗真实配额 */

test('Mock 的尝试次数不会消耗真实 one-shot 配额', async () => {
  const ctx = await setup();
  const failRun = async () => ({ code: 1, timedOut: false, cancelled: false, durationMs: 1 });

  // Mock 一轮用尽 3 次（1 初试 + 2 重试）
  await orchestrateTask({
    record: recordFor(ctx.body, ctx.head),
    deps: depsFor(ctx, failRun),
    options: { execute: true, mode: 'mock', timeoutMs: 5000 }
  });
  const mockOutcome = ctx.state.getTaskOutcome(`4:${ctx.head}:9101`, 'mock');
  assert.equal(mockOutcome.attempts, 3, 'Mock 累计 3 次');
  await ctx.state.setPaused(false, '');   // Mock 用尽后会自动暂停，这里解除以便验证真实配额

  // 真实仍可执行一次
  let realCalls = 0;
  const real = await orchestrateTask({
    record: recordFor(ctx.body, ctx.head),
    deps: depsFor(ctx, async () => { realCalls += 1; return { code: 0, timedOut: false, cancelled: false, durationMs: 1 }; }),
    options: baseOptions(ctx)
  });
  assert.equal(real.status, 'succeeded');
  assert.equal(realCalls, 1);
  assert.equal(ctx.state.getTaskOutcome(`4:${ctx.head}:9101`, 'real').attempts, 1, '真实配额从 0 开始');
  await rm(ctx.base, { recursive: true, force: true });
});
