/**
 * DSH Headless 的安全调用接口。
 *
 * 原则：
 * - **只允许一种调用形态**：`dsh --profile headless --json <task>`
 * - 参数白名单：除 `--profile headless` / `--json` 外的任何 flag 一律拒绝
 * - 环境变量白名单：绝不把 GitHub token、BRIDGE token 等传给子进程
 * - `shell: false`，任务文本作为独立 argv 传入，不做字符串拼接
 * - 超时后先 SIGTERM，宽限期后再 SIGKILL；支持 AbortSignal 取消
 */
import { spawn } from 'node:child_process';

export const DSH_PROFILE = 'headless';
export const SAFE_FLAGS = new Set(['--profile', '--json']);
export const ENV_ALLOWLIST = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'LANG', 'LC_ALL'
];
export const TASK_MAX_LENGTH = 20000;

/** 生成唯一允许的 argv 形态 */
export function buildDshArgv(taskText) {
  if (typeof taskText !== 'string' || !taskText.trim()) throw new Error('任务文本为空');
  if (taskText.length > TASK_MAX_LENGTH) throw new Error(`任务文本超过 ${TASK_MAX_LENGTH} 字符上限`);
  return ['--profile', DSH_PROFILE, '--json', taskText];
}

/** 校验 argv 只含允许的参数（拒绝 --dangerously-* 之类） */
export function assertAllowedArgv(argv) {
  if (!Array.isArray(argv)) throw new Error('argv 必须是数组');
  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string') throw new Error('argv 只允许字符串');
    if (arg.startsWith('-')) {
      if (!SAFE_FLAGS.has(arg)) throw new Error(`不允许的 DSH 参数：${arg}`);
      if (arg === '--profile') {
        const value = argv[++i];
        if (value !== DSH_PROFILE) throw new Error(`只允许 --profile ${DSH_PROFILE}`);
      }
      continue;
    }
    positional += 1;
  }
  if (positional !== 1) throw new Error('只允许一个任务文本参数');
  return true;
}

/** 只保留白名单环境变量，token 类变量一律不传 */
export function buildSafeEnv(baseEnv = {}) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    if (baseEnv[key] !== undefined) out[key] = baseEnv[key];
  }
  return out;
}

/**
 * 运行一次 DSH。返回 { code, timedOut, cancelled, durationMs }。
 * @param {{argv:string[], cwd:string, timeoutMs:number, killGraceMs?:number,
 *          env?:object, spawnImpl?:Function, signal?:AbortSignal}} params
 */
export function runDsh({
  argv,
  cwd,
  timeoutMs,
  killGraceMs = 2000,
  env = process.env,
  spawnImpl = spawn,
  signal
}) {
  assertAllowedArgv(argv);
  if (!cwd) throw new Error('缺少工作目录');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs 必须为正数');

  const startedAt = Date.now();
  const child = spawnImpl('dsh', argv, {
    cwd,
    env: buildSafeEnv(env),
    shell: false,
    stdio: 'ignore',
    windowsHide: true
  });

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer = null;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, timedOut, cancelled, durationMs: Date.now() - startedAt });
    };

    const terminate = () => {
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      }, killGraceMs);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
  });
}
