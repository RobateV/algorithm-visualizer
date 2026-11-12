import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { sha256, BridgeState } from '../lib/state.mjs';
import { createCircuitBreaker } from '../lib/lock.mjs';
import { runCli } from '../executor.mjs';
import { orchestrateTask } from '../lib/orchestrator.mjs';

const git = promisify(execFile);
const SHA = 'c7b172fea1bde714f758df1e875340a1681e7d4e';
const REPO = 'RobateV/algorithm-visualizer';
const DETAIL = '把标题改成「冒泡排序 · 课堂精讲」。';
const CFG = { repo: REPO, allowedActors: ['RobateV'], allowedPrs: [4], maxAttempts: 3, marker: '[DSH-REVIEW-TASK]', maxBodyLength: 20000 };

const bodyFor = (sha = SHA) =>
  `[DSH-REVIEW-TASK]\nrepo: ${REPO}\npr_number: 4\nexpected_head_sha: ${sha}\nreview_id: work-gate-001\nattempt: 1\n---\n${DETAIL}`;

const recordFor = (body, sha, commentId = 9101) =>
  ({ status: 'accepted', commentId, prNumber: 4, headSha: sha, reviewId: 'work-gate-001', bodyDigest: sha256(body) });

function mockGitHub({ body, headSha }) {
  return {
    async getComment() { return { id: 9101, body, user: { login: 'RobateV' }, issueUrl: `${REPO}/issues/4` }; },
    async getPull() { return { number: 4, state: 'open', headSha }; }
  };
}

async function makeRepo() {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-gate-'));
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

/* ------------------------------------------------ 主链路暂停 / 熔断门禁 */

test('CLI execute：已暂停时不创建工作区、不执行、不记录成功', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor(head);
  const record = recordFor(body, head);
  const stateDir = path.join(base, 'state');
  await writeInbox(stateDir, record);

  const state = await new BridgeState(stateDir).init();
  await state.setPaused(true, '教师暂停');

  let runs = 0;
  const code = await runCli(['--execute', '--mock-dsh', '--state', stateDir], {
    client: mockGitHub({ body, headSha: head }),
    state,
    projectRoot: repo,
    workRoot: path.join(base, 'wt'),
    run: async () => { runs += 1; return { code: 0, timedOut: false, cancelled: false, durationMs: 1 }; }
  });

  assert.equal(code, 0);
  assert.equal(runs, 0, '暂停时 Mock 不应被调用');
  await assert.rejects(() => access(path.join(base, 'wt')), '不得创建工作区');
  assert.equal(state.getTaskOutcome(`4:${head}:9101`), null, '不得记录任务结果');
  await rm(base, { recursive: true, force: true });
});

test('另一个进程暂停后，当前进程的状态对象也能看到', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-gate-'));
  const running = await new BridgeState(dir).init();
  assert.equal((await running.isPaused()).paused, false);

  // 模拟另一个进程执行 `executor.mjs --pause`
  const other = await new BridgeState(dir).init();
  await other.setPaused(true, '来自另一个进程');

  const seen = await running.isPaused();
  assert.equal(seen.paused, true, '应通过 PAUSED 文件跨进程可见');

  await other.setPaused(false, '');
  assert.equal((await running.isPaused()).paused, false, '恢复后应解除');
  await rm(dir, { recursive: true, force: true });
});

test('熔断打开时统一编排器不执行', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor(head);
  const stateDir = path.join(base, 'state');
  const state = await new BridgeState(stateDir).init();
  const circuit = createCircuitBreaker({ threshold: 1 });
  circuit.recordFailure();

  let runs = 0;
  const r = await orchestrateTask({
    record: recordFor(body, head),
    deps: {
      client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
      projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
      run: async () => { runs += 1; return { code: 0 }; }
    },
    options: { execute: true, circuit }
  });

  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'circuit-open');
  assert.equal(runs, 0);
  await rm(base, { recursive: true, force: true });
});

test('批量任务：第一项之后暂停会阻断第二项', async () => {
  const { base, repo, head } = await makeRepo();
  const body = bodyFor(head);
  const stateDir = path.join(base, 'state');
  const state = await new BridgeState(stateDir).init();
  let runs = 0;

  const deps = {
    client: mockGitHub({ body, headSha: head }), cfg: CFG, state,
    projectRoot: repo, workRoot: path.join(base, 'wt'), lockDir: path.join(stateDir, 'locks'),
    run: async () => { runs += 1; return { code: 0, timedOut: false, cancelled: false, durationMs: 1 }; }
  };

  const first = await orchestrateTask({ record: recordFor(body, head, 9101), deps, options: { execute: true } });
  assert.equal(first.status, 'succeeded');
  assert.equal(runs, 1);

  await state.setPaused(true, '课间暂停');

  const second = await orchestrateTask({ record: recordFor(body, head, 9102), deps, options: { execute: true } });
  assert.equal(second.status, 'skipped');
  assert.equal(runs, 1, '暂停后不应再执行下一项');
  await rm(base, { recursive: true, force: true });
});
