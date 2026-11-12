/**
 * 受限执行编排：锁边界 + 带超时/取消/重试的单任务执行。
 *
 * 关键约束（复审 P0-A）：
 * - 锁必须覆盖"准备工作区 + 执行"整个过程，否则并发任务可能在拿锁前删掉别人的 worktree
 * - `withTaskLocks` 负责加锁/续期/释放，`performAttempts` 只做执行，二者可组合
 */
import { acquireLock, releaseLock, renewLock, GLOBAL_LOCK_KEY, DEFAULT_STALE_MS } from './lock.mjs';
import { buildDshArgv, runDsh } from './dsh-cli.mjs';

export const MAX_RETRIES = 2;

/**
 * 在任务锁 + 全局锁保护下执行 fn；拿不到锁直接返回终态，不调用 fn。
 * @param {{lockDir:string, taskKey:string, timeoutMs:number}} params
 * @param {Function} fn
 */
export async function withTaskLocks({ lockDir, taskKey, timeoutMs }, fn) {
  const lockStaleMs = Math.max(DEFAULT_STALE_MS, timeoutMs * 2);

  const taskLock = await acquireLock(lockDir, taskKey, { staleMs: lockStaleMs });
  if (!taskLock.acquired) {
    return { status: 'locked', reason: '同一任务正在执行', attempts: [] };
  }

  const globalLock = await acquireLock(lockDir, GLOBAL_LOCK_KEY, { staleMs: lockStaleMs });
  if (!globalLock.acquired) {
    await releaseLock(taskLock.file, taskLock.token);
    return { status: 'skipped', reason: 'global-lock-busy', attempts: [] };
  }

  const heartbeat = setInterval(() => {
    renewLock(taskLock.file, taskLock.token).catch(() => {});
    renewLock(globalLock.file, globalLock.token).catch(() => {});
  }, Math.max(5000, Math.floor(lockStaleMs / 4)));

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(taskLock.file, taskLock.token);
    await releaseLock(globalLock.file, globalLock.token);
  }
}

/** 只做执行与重试，不做加锁；由 withTaskLocks 包裹 */
export async function performAttempts({
  argv, cwd, timeoutMs, run = runDsh, maxRetries = MAX_RETRIES,
  signal, killGraceMs, env, circuit = null, log = () => {}
}) {
  const attempts = [];
  for (let i = 0; i <= maxRetries; i++) {
    const res = await run({ argv, cwd, timeoutMs, signal, killGraceMs, env });
    attempts.push(res);

    if (res.cancelled) return { status: 'cancelled', attempts };
    if (res.code === 0) {
      if (circuit) circuit.recordSuccess();
      return { status: 'succeeded', attempts };
    }
    if (res.timedOut) log(`⏱ 第 ${i + 1} 次执行超时（${timeoutMs}ms）`);
    else log(`✗ 第 ${i + 1} 次执行失败（exit=${res.code}）`);
  }

  if (circuit) circuit.recordFailure();
  return { status: 'failed', reason: '重试次数用尽', attempts };
}

/**
 * 兼容入口：自行加锁并执行（保留给已有调用方与测试）。
 */
export async function runTaskWithGuards({
  taskKey, taskText, cwd, lockDir, timeoutMs, maxRetries = MAX_RETRIES,
  isPaused = async () => ({ paused: false }), circuit = null, run = runDsh,
  signal, killGraceMs, env, log = () => {}
}) {
  if (maxRetries > MAX_RETRIES) throw new Error(`maxRetries 不允许超过 ${MAX_RETRIES}`);

  const pauseState = await isPaused();
  if (pauseState && pauseState.paused) {
    return { status: 'skipped', reason: `paused${pauseState.reason ? '：' + pauseState.reason : ''}`, attempts: [] };
  }
  if (circuit && circuit.isOpen()) {
    return { status: 'skipped', reason: 'circuit-open', attempts: [] };
  }

  let argv;
  try {
    argv = buildDshArgv(taskText);
  } catch (err) {
    return { status: 'rejected', reason: err.message, attempts: [] };
  }

  return withTaskLocks({ lockDir, taskKey, timeoutMs }, () =>
    performAttempts({ argv, cwd, timeoutMs, run, maxRetries, signal, killGraceMs, env, circuit, log })
  );
}
