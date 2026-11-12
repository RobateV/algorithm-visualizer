/**
 * 单实例锁：独占创建 + 所有权 token + 心跳续期。
 *
 * 为什么需要 token：
 * - 任务可能运行超过 staleMs（例如默认 15 分钟超时），若仅凭 mtime 判陈旧，
 *   第二个实例会误删仍在运行的锁，造成同一任务并发
 * - releaseLock 只允许持有者释放，避免 A 删掉 B 的锁
 *
 * 续期：runner 在执行期间定期 renewLock，mtime 保持新鲜；只有真正崩溃
 * （停止续期）的锁才会在 staleMs 之后被接管。
 */
import { open, readFile, unlink, stat, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const GLOBAL_LOCK_KEY = '__global__';
/** 必须显著大于单任务超时，否则长任务会被误判为陈旧 */
export const DEFAULT_STALE_MS = 30 * 60 * 1000;

export function lockPath(dir, key) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(key)) throw new Error(`锁标识非法：${key}`);
  return path.join(dir, `${key}.lock`);
}

export function newLockToken() {
  return randomBytes(12).toString('hex');
}

async function readLockFile(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function createLock(file, key, token, now) {
  const fh = await open(file, 'wx');
  try {
    await fh.write(JSON.stringify({ key, token, pid: process.pid, at: new Date(now).toISOString() }), null, 'utf8');
  } finally {
    await fh.close();
  }
}

/**
 * @returns {Promise<{acquired:boolean, file:string, token?:string, holder?:object, stolen?:boolean}>}
 */
export async function acquireLock(dir, key, { staleMs = DEFAULT_STALE_MS, now = Date.now(), token = newLockToken() } = {}) {
  const file = lockPath(dir, key);
  await mkdir(dir, { recursive: true });

  try {
    await createLock(file, key, token, now);
    return { acquired: true, file, token };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const info = await stat(file).catch(() => null);
  if (info && now - info.mtimeMs > staleMs) {
    // 陈旧锁：仅在没有心跳的情况下接管；接管失败（竞态）仍按占用处理
    await unlink(file).catch(() => {});
    try {
      await createLock(file, key, token, now);
      return { acquired: true, file, token, stolen: true };
    } catch {
      /* 被别的实例抢先，按占用返回 */
    }
  }

  return { acquired: false, file, holder: await readLockFile(file) };
}

/** 续期：只有持有者能让锁保持新鲜 */
export async function renewLock(file, token, now = Date.now()) {
  const holder = await readLockFile(file);
  if (!holder || holder.token !== token) return false;
  await writeFile(file, JSON.stringify({ ...holder, at: new Date(now).toISOString() }), 'utf8');
  return true;
}

/** 释放：token 不匹配时不动别人的锁 */
export async function releaseLock(file, token) {
  if (!file) return false;
  if (token) {
    const holder = await readLockFile(file);
    if (!holder || holder.token !== token) return false;
  }
  await unlink(file).catch(() => {});
  return true;
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
