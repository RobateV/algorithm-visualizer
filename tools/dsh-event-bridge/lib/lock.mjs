/**
 * 单实例锁：用"独占创建 + 陈旧检测"实现，不依赖平台 API。
 *
 * - 每个任务一个锁文件：<lockDir>/<key>.lock
 * - 进程崩溃留下的锁在 staleMs 之后可被接管（宁可延迟，也不并发）
 * - 全局锁用固定 key `__global__`
 */
import { open, readFile, unlink, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const GLOBAL_LOCK_KEY = '__global__';

export function lockPath(dir, key) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(key)) throw new Error(`锁标识非法：${key}`);
  return path.join(dir, `${key}.lock`);
}

async function tryCreate(file, key) {
  const fh = await open(file, 'wx');
  try {
    await fh.write(JSON.stringify({ key, pid: process.pid, at: new Date().toISOString() }));
  } finally {
    await fh.close();
  }
}

/**
 * @returns {Promise<{acquired:boolean, file:string, holder?:object, stale?:boolean}>}
 */
export async function acquireLock(dir, key, { staleMs = 10 * 60 * 1000, now = Date.now(), allowSteal = true } = {}) {
  const file = lockPath(dir, key);
  await mkdir(dir, { recursive: true });
  try {
    await tryCreate(file, key);
    return { acquired: true, file };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const info = await stat(file).catch(() => null);
  if (info && now - info.mtimeMs > staleMs && allowSteal) {
    // 陈旧锁：清掉后重试一次（仍失败就当作被占用）
    await unlink(file).catch(() => {});
    return acquireLock(dir, key, { staleMs, now, allowSteal: false });
  }

  let holder = null;
  try { holder = JSON.parse(await readFile(file, 'utf8')); } catch { /* 损坏当占用 */ }
  return { acquired: false, file, holder, stale: false };
}

export async function releaseLock(file) {
  if (!file) return;
  await unlink(file).catch(() => {});
}

/** 失败熔断：连续失败达到阈值后打开，阻止继续执行 */
export function createCircuitBreaker({ threshold = 3 } = {}) {
  let consecutive = 0;
  let openedAt = null;
  return {
    recordSuccess() { consecutive = 0; openedAt = null; },
    recordFailure() {
      consecutive += 1;
      if (consecutive >= threshold) openedAt = new Date().toISOString();
      return consecutive;
    },
    isOpen() { return openedAt !== null; },
    state() { return { consecutive, opened: openedAt !== null, openedAt }; },
    reset() { consecutive = 0; openedAt = null; }
  };
}
