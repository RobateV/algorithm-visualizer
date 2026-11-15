import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSafeEnv } from './dsh-cli.mjs';
import { buildWindowsJob } from './windows-job.mjs';

export const PATCH = fileURLToPath(new URL('../local-dsh.patch.yml', import.meta.url));

export function parseDshEvents(stdout) {
  const events = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (events.some((e) => e.type === 'error')) throw new Error('DSH 返回错误事件');
  const finals = events.filter((e) => e.type === 'final');
  if (finals.length !== 1) throw new Error('DSH 缺少唯一 final 事件');
  const text = String(finals[0].text).trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  return { proposal: JSON.parse(text), sessionId: events.find((e) => e.type === 'session')?.sessionId || null };
}

// 直接运行 npm 启动器的 JS 入口，避开 Windows .cmd + Shell 引号注入。
export async function runLocalDsh({ entry, cwd, prompt, timeoutMs = 180000, signal, env = process.env, spawnImpl = spawn }) {
  if (!entry || !entry.endsWith('bin.js')) throw new Error('请配置 npm DSH 的 lib/bin.js 绝对入口');
  const childEnv = buildSafeEnv(env);
  childEnv.DSH_PERMISSION_MODE = 'read-only';
  const started = Date.now();
  const windowsJob = process.platform === 'win32' && spawnImpl === spawn;
  const native = windowsJob ? await buildWindowsJob({ signal }) : null;
  try { return await new Promise((resolve, reject) => {
    const command = windowsJob ? native.executable : process.execPath;
    const argv = windowsJob
      ? [process.execPath, entry, PATCH, String(process.pid), String(Math.max(1000, Math.min(timeoutMs, 600000)))]
      : [entry, '--profile', 'headless', '--patch', PATCH, '--json', '-'];
    const child = spawnImpl(command, argv, {
      cwd, env: childEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', reason = '', total = 0;
    const stop = (why) => { reason ||= why; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('DSH 超时'), timeoutMs);
    const abort = () => stop('DSH 已取消');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const append = (kind, chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > 2 * 1024 * 1024) { stop('DSH 输出超限'); return; }
      if (kind === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s) => append('out', s));
    child.stderr.on('data', (s) => append('err', s));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', (err) => { cleanup(); reject(new Error(`DSH 无法启动：${err.code || 'unknown'}`)); });
    child.once('close', (code) => {
      cleanup();
      if (stderr.includes('LOCAL_DSH_JOB_TIMEOUT')) return reject(new Error('DSH 超时（Windows Job 独立计时器）'));
      if (stderr.includes('LOCAL_DSH_BUDGET_EXCEEDED')) return reject(new Error('DSH 模型请求次数超限，任务停止'));
      if (windowsJob && !stderr.includes('LOCAL_DSH_JOB_READY')) return reject(new Error(reason || 'Windows 包装进程未建立 Job，拒绝继续；需核实实际启动宿主'));
      if (reason || code !== 0) return reject(new Error(reason || `DSH exit=${code}（原始输出未发布，可能含敏感内容）`));
      if (!stderr.includes('LOCAL_DSH_GUARD_READY')) return reject(new Error('DSH 权限 guard 未确认生效'));
      try { resolve({ ...parseDshEvents(stdout), code, durationMs: Date.now() - started, contained: windowsJob, toolsGuarded: true, modelRequests: Number(stderr.match(/LOCAL_DSH_MODEL_CALLS:(\d+)/)?.[1] || 0) }); }
      catch { reject(new Error('DSH 结果不符合结构化编辑协议')); }
    });
  }); } finally { await native?.cleanup(); }
}
