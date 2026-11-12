/**
 * 单一编排器：把「收件箱 → 二次校验 → 隔离工作区 → 执行 → 结果持久化 →（授权时）回写」串起来。
 *
 * 依赖全部注入（client / state / run / io / git），因此可以在测试里用
 * Mock GitHub + Mock DSH + Mock 回写完整跑一遍主链路，而不是分别测各模块。
 *
 * 安全约束：
 * - `execute=false` 时不创建 worktree、不执行、不写 GitHub（只给计划）
 * - 执行前必须重新校验评论，且只把**校验通过的任务正文**交给 DSH
 * - 执行前要求主工作区干净；worktree 真实存在才作为 cwd
 * - 已成功过的任务（持久结果）直接跳过，不重放
 */
import { access } from 'node:fs/promises';
import { refetchAndVerify } from './task-refetch.mjs';
import { prepareWorktree, assertCleanProject } from './workspace.mjs';
import { runTaskWithGuards } from './runner.mjs';
import { performWriteback } from './writeback.mjs';

export const TASK_CONTRACT_HEADER = [
  '你正在一个隔离的 git worktree 中执行受限任务。',
  '只允许修改与本任务直接相关的文件；不要修改默认分支，不要 force push，不要合并。',
  '不要访问仓库目录以外的文件，不要读取或提交任何密钥。',
  '完成任务后只提交普通 commit，并简述改动与测试结果。'
].join('\n');

export function outcomeKeyOf(record) {
  return `${record.prNumber}:${record.headSha}:${record.commentId}`;
}

/** 把已校验的任务数据构造成固定契约；正文只来自 GitHub 评论，不拼接命令 */
export function buildTaskContract({ task, prNumber, headSha }) {
  const detail = String(task.detail || '').trim();
  if (!detail) throw new Error('任务正文为空');
  return [
    TASK_CONTRACT_HEADER,
    '',
    `PR: #${prNumber}`,
    `目标提交: ${headSha}`,
    `任务编号: ${task.reviewId}`,
    '---- 任务正文 ----',
    detail
  ].join('\n');
}

/**
 * @param {{record:object, deps:object, options:object}} params
 * deps: { client, cfg, state, projectRoot, workRoot, lockDir, run, io, git }
 * options: { execute, timeoutMs, circuit, branch, writebackEnabled, writebackDryRun, tests, log }
 */
export async function orchestrateTask({ record, deps, options }) {
  options = options || {};
  const log = options.log || (() => {});
  const key = outcomeKeyOf(record);

  const previous = deps.state.getTaskOutcome(key);
  if (previous && previous.status === 'succeeded') {
    return { status: 'skipped', reason: 'already-succeeded', key };
  }

  const check = await refetchAndVerify({ client: deps.client, record, cfg: deps.cfg });
  if (!check.ok) {
    return { status: 'rejected', reasons: check.reasons, key };
  }

  if (!options.execute) {
    const workspace = await prepareWorktree({ projectRoot: deps.projectRoot, workRoot: deps.workRoot, record, dryRun: true });
    return { status: 'planned', workspace, task: check.task, key };
  }

  // 执行路径：先确保主工作区干净，再真正创建隔离工作区
  await assertCleanProject({ projectRoot: deps.projectRoot });
  const workspace = await prepareWorktree({ projectRoot: deps.projectRoot, workRoot: deps.workRoot, record, dryRun: false });
  const cwd = workspace.realPath || workspace.dir;
  await access(cwd);   // 目录必须真实存在，否则不把 cwd 交给 DSH

  const taskText = buildTaskContract({ task: check.task, prNumber: record.prNumber, headSha: record.headSha });

  const runResult = await runTaskWithGuards({
    taskKey: workspace.key,
    taskText,
    cwd,
    lockDir: deps.lockDir,
    timeoutMs: options.timeoutMs,
    run: deps.run,
    isPaused: () => deps.state.isPaused(),
    circuit: options.circuit,
    log
  });

  const outcome = {
    status: runResult.status,
    attempts: Array.isArray(runResult.attempts) ? runResult.attempts.length : 0,
    reviewId: record.reviewId,
    headSha: record.headSha,
    reason: runResult.reason || null
  };
  await deps.state.recordTaskOutcome(key, outcome);
  log(`· ${record.reviewId} 执行结果：${outcome.status}（尝试 ${outcome.attempts} 次）`);

  let writeback = null;
  if (options.writebackEnabled) {
    writeback = await performWriteback({
      enabled: true,
      dryRun: options.writebackDryRun !== false,
      taskId: record.reviewId,
      prNumber: record.prNumber,
      baseSha: record.headSha,
      expectedHeadSha: record.headSha,
      currentHeadSha: check.pr.headSha,
      prState: check.pr.state,
      branch: options.branch,
      newSha: options.newSha || null,
      status: outcome.status === 'succeeded' ? 'succeeded' : 'failed',
      attempts: outcome.attempts,
      tests: options.tests || '',
      errors: outcome.reason ? [outcome.reason] : [],
      io: deps.io
    });
    log(`· 回写：${writeback.ok ? (writeback.dryRun ? 'dry-run 生成报告' : '已回写') : '被拒绝（' + writeback.reasons.join('；') + '）'}`);
  }

  return { status: runResult.status, workspace, task: check.task, runResult, outcome, writeback, key };
}

/** 批量编排：串行执行，任一任务失败不影响后续（除非熔断打开） */
export async function orchestrateAll({ records, deps, options }) {
  const results = [];
  for (const record of records) {
    results.push(await orchestrateTask({ record, deps, options }));
  }
  return results;
}
