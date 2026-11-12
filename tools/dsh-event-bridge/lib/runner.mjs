/**
 * 受限执行编排：暂停检查 → 熔断检查 → 单实例锁 → 带超时/取消的执行 → 重试。
 *
 * 约束：
 * - 一次只执行一个任务（全局锁），同一任务不可并发（任务锁）
 * - 最多 maxRetries 次重试（默认 2，硬上限 2）
 * - 超时、取消、失败都只影响本次任务，不抛出到调用方
 * - 不在这里拼任务文本，也不读取 GitHub；调用方负责校验后再进来
 */
import { acquireLock, releaseLock, renewLock, GLOBAL_LOCK_KEY, DEFAULT_STALE_MS } from './lock.mjs';
import { buildDshArgv, runDsh } from './dsh-cli.mjs';

export const MAX_RETRIES = 2;

/**
 * @param {{taskKey:string, taskText:string, cwd:string, lockDir:string, timeoutMs:number,
 *          maxRetries?:number, isPaused?:Function, circuit?:object, run?:Function,
 *          signal?:AbortSignal, killGraceMs?:number, env?:object, log?:Function}} params
 */
export async function runTaskWithGuards({
  taskKey,
  taskText,
  cwd,
  lockDir,
  timeoutMs,
  maxRetries = MAX_RETRIES,
  isPaused = async () => ({ paused: false }),
  circuit = null,
  run = runDsh,
  signal,
  killGraceMs,
  env,
  log = () => {}
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

  // 先拿任务锁，再拿全局锁：同一任务并发时能明确返回 locked，而不是笼统的繁忙
  // 锁的陈旧阈值必须大于单任务超时，否则长任务跑到一半就会被第二个实例接管
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

  // 执行期间持续续期，保证"仍在跑"的锁不会被判陈旧
  const heartbeat = setInterval(() => {
    renewLock(taskLock.file, taskLock.token).catch(() => {});
    renewLock(globalLock.file, globalLock.token).catch(() => {});
  }, Math.max(5000, Math.floor(lockStaleMs / 4)));

  const attempts = [];
  try {
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
  } finally {
    clearInterval(heartbeat);
    await releaseLock(taskLock.file, taskLock.token);
    await releaseLock(globalLock.file, globalLock.token);
  }
}
