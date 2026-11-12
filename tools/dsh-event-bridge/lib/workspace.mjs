/**
 * 工作区隔离：为每个任务准备独立 git worktree，避免污染主工作区。
 *
 * 安全约束：
 * - 任务标识只允许 [0-9a-f-]，杜绝路径穿越
 * - 目标目录必须落在允许的工作区根目录内（解析真实路径后再判一次，防符号链接逃逸）
 * - 默认 dryRun=true：只计算计划，不创建任何目录
 */
import { realpath, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runGit = promisify(execFile);

export function taskKey(record) {
  const key = `${record.prNumber}-${String(record.headSha).slice(0, 12)}-${record.commentId}`;
  if (!/^[0-9a-fA-F-]{6,80}$/.test(key)) throw new Error('任务标识含非法字符，拒绝生成工作区');
  return key;
}

/** 目标路径必须位于 root 内（按字符串解析，随后还会用 realpath 复核一次） */
export function assertInside(root, candidate) {
  const realRoot = path.resolve(root);
  const target = path.resolve(candidate);
  if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
    throw new Error(`工作区路径越界：${target} 不在 ${realRoot} 内`);
  }
  return target;
}

export function planWorkspace({ workRoot, record }) {
  const key = taskKey(record);
  const root = path.resolve(workRoot);
  const dir = assertInside(root, path.join(root, key));
  return { key, dir, branch: `dsh/${key}`, baseSha: record.headSha };
}

/**
 * 准备隔离工作区。
 * @param {{projectRoot:string, workRoot:string, record:object, dryRun?:boolean, git?:Function}} params
 */
export async function prepareWorktree({ projectRoot, workRoot, record, dryRun = true, git = runGit }) {
  const plan = planWorkspace({ workRoot, record });

  // 确认 projectRoot 真的是一个 git 仓库
  await git('git', ['-C', projectRoot, 'rev-parse', '--git-dir']);

  if (dryRun) return { ...plan, created: false };

  await mkdir(path.resolve(workRoot), { recursive: true });

  // 已有同名目录：只有在"确属本仓库登记的 worktree 且 HEAD 与任务一致"时才复用，
  // 其余情况一律 fail-closed，绝不在锁外递归删除别人的工作区。
  let existed = false;
  try { await access(plan.dir); existed = true; } catch { /* 不存在 */ }

  if (existed) {
    const listed = (await git('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'])).stdout;
    const registered = String(listed)
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => path.resolve(line.slice('worktree '.length).trim()));
    if (!registered.includes(path.resolve(plan.dir))) {
      throw new Error('目标目录已存在且不是本仓库登记的 worktree，拒绝清理');
    }
    const head = (await git('git', ['-C', plan.dir, 'rev-parse', 'HEAD'])).stdout.trim();
    if (head !== plan.baseSha) {
      throw new Error('同名工作区属于其它提交，拒绝复用');
    }
    const real = await realpath(plan.dir);
    return { ...plan, created: false, reused: true, realPath: real };
  }

  await git('git', ['-C', projectRoot, 'worktree', 'add', '--detach', plan.dir, plan.baseSha]);

  // 创建后按真实路径再校验一次，防止符号链接把目录指到别处
  const real = await realpath(plan.dir);
  const realRoot = await realpath(path.resolve(workRoot));
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    await cleanupWorktree({ projectRoot, dir: plan.dir, git });
    throw new Error(`工作区真实路径逃逸：${real}`);
  }

  return { ...plan, created: true, realPath: real };
}

export async function cleanupWorktree({ projectRoot, dir, git = runGit }) {
  await git('git', ['-C', projectRoot, 'worktree', 'remove', '--force', dir]).catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await git('git', ['-C', projectRoot, 'worktree', 'prune']).catch(() => {});
}

/** 主工作区必须干净：有未提交改动时不执行，避免覆盖教师的工作 */
export async function assertCleanProject({ projectRoot, git = runGit }) {
  const { stdout } = await git('git', ['-C', projectRoot, 'status', '--porcelain']);
  if (String(stdout).trim()) throw new Error('主工作区存在未提交改动，拒绝执行');
}

/**
 * 一次性真实试运行的副作用校验（不依赖 DSH 自述）：
 * - HEAD 必须仍是任务基线（等于发生了 commit）
 * - 改动路径必须落在允许清单内
 * @returns {Promise<string[]>} 问题列表，空数组表示合规
 */
export async function verifyOneShotSideEffects({ worktree, baseSha, allowedPaths = [], git = runGit }) {
  const problems = [];

  const head = (await git('git', ['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim();
  if (head !== baseSha) problems.push('HEAD 发生变化（一次性试运行禁止 commit）');

  const status = (await git('git', ['-C', worktree, 'status', '--porcelain'])).stdout.trim();
  const changed = status
    ? status.split('\n').map((line) => line.slice(3).trim()).filter(Boolean)
    : [];
  const allowed = (allowedPaths || []).map((p) => String(p).replace(/\/+$/, ''));
  const violations = changed.filter((p) => !allowed.some((a) => p === a || p.startsWith(a + '/')));
  if (violations.length) problems.push('改动了未授权路径：' + violations.join(', '));

  return problems;
}
