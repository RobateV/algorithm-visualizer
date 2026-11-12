/**
 * 工作区隔离：为每个任务准备独立 git worktree，避免污染主工作区。
 *
 * 安全约束：
 * - 任务标识只允许 [0-9a-f-]，杜绝路径穿越
 * - 目标目录必须落在允许的工作区根目录内（解析真实路径后再判一次，防符号链接逃逸）
 * - 默认 dryRun=true：只计算计划，不创建任何目录
 */
import { realpath, mkdir, rm } from 'node:fs/promises';
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

  // 重试同一任务时目录可能已存在：先删目录，再 prune 掉陈旧登记，最后 add
  await rm(plan.dir, { recursive: true, force: true }).catch(() => {});
  await git('git', ['-C', projectRoot, 'worktree', 'prune']).catch(() => {});

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
