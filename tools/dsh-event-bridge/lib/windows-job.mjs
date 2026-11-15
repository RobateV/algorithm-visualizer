import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSafeEnv } from './dsh-cli.mjs';

// Compile only our fixed source with the existing Windows framework compiler.
// A fresh private temp directory avoids trusting a reusable cached executable.
export async function buildWindowsJob({ signal } = {}) {
  const compiler = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'Microsoft.NET',
    process.arch === 'x64' ? 'Framework64' : 'Framework', 'v4.0.30319', 'csc.exe');
  try { await access(compiler); } catch { throw new Error('缺少 Windows 自带 C# 编译器，未安装依赖；拒绝无 Job 执行'); }
  const dir = await mkdtemp(path.join(tmpdir(), 'local-dsh-job-'));
  const executable = path.join(dir, 'windows-job.exe');
  const cleanup = () => {
    if (path.dirname(dir) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith('local-dsh-job-')) throw new Error('Job 临时目录范围错误');
    return rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${executable}`,
      fileURLToPath(new URL('./windows-job.cs', import.meta.url))], {
      env: buildSafeEnv(process.env), windowsHide: true, timeout: 15000, maxBuffer: 65536, signal
    });
    return { executable, cleanup };
  } catch {
    await cleanup();
    throw new Error('受信任 Windows Job 启动器编译失败；未启动 DSH');
  }
}
