import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { acquireLock, releaseLock, createCircuitBreaker, GLOBAL_LOCK_KEY } from '../lib/lock.mjs';
import { buildDshArgv, assertAllowedArgv, buildSafeEnv, runDsh } from '../lib/dsh-cli.mjs';
import { runTaskWithGuards } from '../lib/runner.mjs';

const KEY = 'dsh-4-c7b172fea1bd-9101';
const tmp = () => mkdtemp(path.join(tmpdir(), 'dsh-run-'));

/* ------------------------------------------------------------ Mock DSH */

function fakeChild({ code = 0, delayMs = 5, hang = false }) {
  const child = new EventEmitter();
  let closed = false;
  const close = (c) => { if (closed) return; closed = true; child.emit('close', c); };
  child.kill = () => { close(143); return true; };
  if (hang) return child;
  setTimeout(() => close(code), delayMs);
  return child;
}

/** 按脚本依次返回不同行为的 mock 执行器 */
function mockRun(script) {
  let i = 0;
  const calls = [];
  const fn = async ({ argv, cwd, timeoutMs }) => {
    calls.push({ argv, cwd, timeoutMs });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step.hang) {
      // 模拟超时：等 timeout 后由 runDsh 杀掉；这里直接返回超时结果
      return { code: 143, timedOut: true, cancelled: false, durationMs: timeoutMs };
    }
    if (step.cancel) return { code: 143, timedOut: false, cancelled: true, durationMs: 1 };
    return { code: step.code, timedOut: false, cancelled: false, durationMs: step.delayMs || 1 };
  };
  fn.calls = calls;
  return fn;
}

/* ------------------------------------------------------------ CLI 安全 */

test('只允许 dsh --profile headless --json <task> 一种形态', () => {
  assert.deepEqual(buildDshArgv('修一下'), ['--profile', 'headless', '--json', '修一下']);
  assert.throws(() => buildDshArgv('   '), /任务文本为空/);
  assert.throws(() => buildDshArgv('x'.repeat(20001)), /上限/);
});

test('拒绝危险参数与非 headless profile', () => {
  assert.equal(assertAllowedArgv(['--profile', 'headless', '--json', 'task']), true);
  assert.throws(() => assertAllowedArgv(['--profile', 'headless', '--dangerously-skip-permissions', 'task']), /不允许的 DSH 参数/);
  assert.throws(() => assertAllowedArgv(['--profile', 'web', 'task']), /只允许 --profile headless/);
  assert.throws(() => assertAllowedArgv(['task', 'extra']), /只允许一个任务文本参数/);
  assert.throws(() => assertAllowedArgv(['--yolo', 'task']), /不允许的 DSH 参数/);
});

test('环境变量白名单不会传出 token', () => {
  const env = buildSafeEnv({ PATH: '/bin', HOME: '/h', DSH_BRIDGE_TOKEN: 'secret', GITHUB_TOKEN: 'secret2', NODE_OPTIONS: '--x' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/h');
  assert.equal(env.DSH_BRIDGE_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test('runDsh 在超时后杀进程并标记 timedOut', async () => {
  const res = await runDsh({
    argv: ['--profile', 'headless', '--json', 'task'],
    cwd: tmpdir(),
    timeoutMs: 30,
    spawnImpl: () => fakeChild({ hang: true })
  });
  assert.equal(res.timedOut, true);
  assert.notEqual(res.code, 0);
});

test('runDsh 正常返回退出码', async () => {
  const res = await runDsh({
    argv: ['--profile', 'headless', '--json', 'task'],
    cwd: tmpdir(),
    timeoutMs: 1000,
    spawnImpl: () => fakeChild({ code: 0, delayMs: 5 })
  });
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
});

/* ------------------------------------------------------------ 锁 */

test('同一任务第二次加锁失败，释放后成功', async () => {
  const dir = await tmp();
  const first = await acquireLock(dir, KEY);
  assert.equal(first.acquired, true);
  const second = await acquireLock(dir, KEY);
  assert.equal(second.acquired, false);
  await releaseLock(first.file);
  const third = await acquireLock(dir, KEY);
  assert.equal(third.acquired, true);
  await releaseLock(third.file);
  await rm(dir, { recursive: true, force: true });
});

test('陈旧锁可被接管', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, `${KEY}.lock`);
  await writeFile(lockFile, JSON.stringify({ pid: 1 }), 'utf8');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(lockFile, old, old);

  const got = await acquireLock(dir, KEY, { staleMs: 1000 });
  assert.equal(got.acquired, true);
  await releaseLock(got.file);
  await rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ 编排 */

test('首次即成功', async () => {
  const dir = await tmp();
  const run = mockRun([{ code: 0 }]);
  const res = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: dir, lockDir: dir, timeoutMs: 1000, run });
  assert.equal(res.status, 'succeeded');
  assert.equal(run.calls[0].argv[1], 'headless');
  await rm(dir, { recursive: true, force: true });
});

test('失败后重试一次成功', async () => {
  const dir = await tmp();
  const run = mockRun([{ code: 2 }, { code: 0 }]);
  const res = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: dir, lockDir: dir, timeoutMs: 1000, run });
  assert.equal(res.status, 'succeeded');
  assert.equal(res.attempts.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test('重试次数用尽后失败并计入熔断', async () => {
  const dir = await tmp();
  const circuit = createCircuitBreaker({ threshold: 1 });
  const run = mockRun([{ code: 1 }]);
  const res = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: dir, lockDir: dir, timeoutMs: 1000, run, circuit });
  assert.equal(res.status, 'failed');
  assert.equal(res.attempts.length, 3, '1 次 + 2 次重试');
  assert.equal(circuit.isOpen(), true);
  await rm(dir, { recursive: true, force: true });
});

test('熔断打开后不再执行', async () => {
  const dir = await tmp();
  const circuit = createCircuitBreaker({ threshold: 1 });
  circuit.recordFailure();
  const run = mockRun([{ code: 0 }]);
  const res = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: dir, lockDir: dir, timeoutMs: 1000, run, circuit });
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'circuit-open');
  assert.equal(run.calls.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('全局暂停时不执行', async () => {
  const dir = await tmp();
  const run = mockRun([{ code: 0 }]);
  const res = await runTaskWithGuards({
    taskKey: KEY, taskText: 't', cwd: dir, lockDir: dir, timeoutMs: 1000, run,
    isPaused: async () => ({ paused: true, reason: 'PAUSED 文件存在' })
  });
  assert.equal(res.status, 'skipped');
  assert.match(res.reason, /paused/);
  assert.equal(run.calls.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('超时会被重试，最终标记失败', async () => {
  const dir = await tmp();
  const run = mockRun([{ hang: true }]);
  const res = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: dir, lockDir: dir, timeoutMs: 20, run });
  assert.equal(res.status, 'failed');
  assert.equal(res.attempts.every((a) => a.timedOut), true);
  await rm(dir, { recursive: true, force: true });
});

test('取消信号立即终止并返回 cancelled', async () => {
  const dir = await tmp();
  const run = mockRun([{ cancel: true }]);
  const ac = new AbortController();
  ac.abort();
  const res = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: dir, lockDir: dir, timeoutMs: 1000, run, signal: ac.signal });
  assert.equal(res.status, 'cancelled');
  await rm(dir, { recursive: true, force: true });
});

test('并发执行同一任务时第二个被锁拒绝', async () => {
  const dir = await tmp();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowRun = async () => { await gate; return { code: 0, timedOut: false, cancelled: false, durationMs: 1 }; };

  const first = runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: dir, lockDir: dir, timeoutMs: 5000, run: slowRun });
  await new Promise((r) => setTimeout(r, 30));
  const second = await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: dir, lockDir: dir, timeoutMs: 5000, run: slowRun });
  release();
  const firstResult = await first;

  assert.equal(firstResult.status, 'succeeded');
  assert.equal(second.status, 'locked');
  await rm(dir, { recursive: true, force: true });
});

test('执行结束后锁文件被清理', async () => {
  const dir = await tmp();
  const run = mockRun([{ code: 0 }]);
  await runTaskWithGuards({ taskKey: KEY, taskText: 't', cwd: dir, lockDir: dir, timeoutMs: 1000, run });
  await assert.rejects(() => access(path.join(dir, `${KEY}.lock`)));
  await assert.rejects(() => access(path.join(dir, `${GLOBAL_LOCK_KEY}.lock`)));
  await rm(dir, { recursive: true, force: true });
});
