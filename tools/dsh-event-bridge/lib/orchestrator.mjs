/**
 * 单一编排器：收件箱 → 二次校验 → 隔离工作区 → 执行 → 结果持久化 →（授权时）回写。
 *
 * 复审修复要点：
 * - **工作区准备在任务锁内**（P0-A）：与执行共用 withTaskLocks，锁外绝不触碰目录
 * - **总尝试次数跨重启累计**（P0-B）：同一任务 key 最多 3 次（1 初试 + 2 重试），
 *   每次尝试的结果都持久化；超过上限自动暂停并要求人工处理
 */
import { access } from 'node:fs/promises';
import { refetchAndVerify } from './task-refetch.mjs';
import { prepareWorktree, assertCleanProject, taskKey as workspaceKeyOf } from './workspace.mjs';
import { withTaskLocks, performAttempts, MAX_RETRIES } from './runner.mjs';
import { buildDshArgv } from './dsh-cli.mjs';
import { performWriteback } from './writeback.mjs';

/** 同一任务允许的总尝试次数（跨重启累计） */
export const TOTAL_ATTEMPTS = 1 + MAX_RETRIES;

export const TASK_CONTRACT_HEADER = [
  '你正在一个隔离的 git worktree 中执行受限任务。',
  '只允许修改与本任务直接相关的文件；不要修改默认分支，不要 force push，不要合并。',
  '不要访问仓库目录以外的文件，不要读取或提交任何密钥。',
  '完成任务后只提交普通 commit，并简述改动与测试结果。'
].join('\n');

export function outcomeKeyOf(record) {
  return `${record.prNumber}:${record.headSha}:${record.commentId}`;
}

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
 * deps: { client, cfg, state, projectRoot, workRoot, lockDir, run, io }
 */
export async function orchestrateTask({ record, deps, options }) {
  options = options || {};
  const log = options.log || (() => {});
  const key = outcomeKeyOf(record);

  const previous = deps.state.getTaskOutcome(key);
  if (previous && previous.status === 'succeeded') {
    return { status: 'skipped', reason: 'already-succeeded', key };
  }

  const usedBefore = previous && Number.isFinite(previous.attempts) ? previous.attempts : 0;
  if (usedBefore >= TOTAL_ATTEMPTS) {
    await deps.state.setPaused(true, `任务 ${record.reviewId} 已达总尝试上限 ${TOTAL_ATTEMPTS}`);
    log(`⏸ 任务 ${record.reviewId} 已用尽 ${TOTAL_ATTEMPTS} 次尝试，自动暂停并等待人工处理`);
    return { status: 'exhausted', reason: 'attempts-exhausted', key, attempts: usedBefore };
  }

  // 全局门禁：暂停 / blocked / 熔断在拿锁与准备目录之前就拦住
  const pauseState = typeof deps.state.isPaused === 'function'
    ? await deps.state.isPaused()
    : { paused: false };
  if (pauseState.paused) {
    log(`⏸ 已暂停（${pauseState.reason || '未知原因'}），跳过任务 ${record.reviewId}`);
    return { status: 'skipped', reason: `paused${pauseState.reason ? '：' + pauseState.reason : ''}`, key };
  }
  if (options.circuit && options.circuit.isOpen()) {
    log('⛔ 熔断已打开，跳过任务 ' + record.reviewId);
    return { status: 'skipped', reason: 'circuit-open', key };
  }

  const check = await refetchAndVerify({ client: deps.client, record, cfg: deps.cfg });
  if (!check.ok) {
    return { status: 'rejected', reasons: check.reasons, key };
  }

  if (!options.execute) {
    const workspace = await prepareWorktree({ projectRoot: deps.projectRoot, workRoot: deps.workRoot, record, dryRun: true });
    return { status: 'planned', workspace, task: check.task, key };
  }

  // 锁覆盖"清理/准备工作区 + 执行"，并发任务在锁外不会碰到同一目录
  const locked = await withTaskLocks(
    { lockDir: deps.lockDir, taskKey: workspaceKeyOf(record), timeoutMs: options.timeoutMs },
    async () => {
      // 等锁期间可能被外部 --pause：进入锁后立刻复查，避免已暂停还去建目录
      const insidePause = typeof deps.state.isPaused === 'function'
        ? await deps.state.isPaused()
        : { paused: false };
      if (insidePause.paused) return { skippedInsideLock: true, reason: insidePause.reason };

      await assertCleanProject({ projectRoot: deps.projectRoot });
      const workspace = await prepareWorktree({ projectRoot: deps.projectRoot, workRoot: deps.workRoot, record, dryRun: false });
      const cwd = workspace.realPath || workspace.dir;
      await access(cwd);

      const taskText = buildTaskContract({ task: check.task, prNumber: record.prNumber, headSha: record.headSha });
      const remaining = TOTAL_ATTEMPTS - usedBefore;
      const maxRetries = Math.min(MAX_RETRIES, Math.max(0, remaining - 1));
      const result = await performAttempts({
        argv: buildDshArgv(taskText),
        cwd,
        timeoutMs: options.timeoutMs,
        run: deps.run,
        maxRetries,
        circuit: options.circuit,
        log
      });
      return { workspace, result };
    }
  );

  if (locked.status === 'locked' || locked.status === 'skipped') {
    return { status: locked.status, reason: locked.reason, key, attempts: usedBefore };
  }
  if (locked.skippedInsideLock) {
    log(`⏸ 进入锁后发现已暂停，跳过任务 ${record.reviewId}`);
    return { status: 'skipped', reason: 'paused', key, attempts: usedBefore };
  }

  const { workspace, result } = locked;
  const totalAttempts = usedBefore + (Array.isArray(result.attempts) ? result.attempts.length : 0);

  const outcome = {
    status: result.status,
    attempts: totalAttempts,
    reviewId: record.reviewId,
    headSha: record.headSha,
    reason: result.reason || null
  };
  await deps.state.recordTaskOutcome(key, outcome);
  log(`· ${record.reviewId} 执行结果：${result.status}（累计尝试 ${totalAttempts}/${TOTAL_ATTEMPTS}）`);

  if (result.status !== 'succeeded' && totalAttempts >= TOTAL_ATTEMPTS) {
    await deps.state.setPaused(true, `任务 ${record.reviewId} 已达总尝试上限 ${TOTAL_ATTEMPTS}`);
    log(`⏸ 任务 ${record.reviewId} 用尽重试，自动暂停并等待人工处理`);
  }

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
      status: result.status === 'succeeded' ? 'succeeded' : 'failed',
      attempts: totalAttempts,
      tests: options.tests || '',
      errors: result.reason ? [result.reason] : [],
      io: deps.io
    });
    log(`· 回写：${writeback.ok ? (writeback.dryRun ? 'dry-run 报告' : '已回写') : '被拒绝（' + writeback.reasons.join('；') + '）'}`);
  }

  return { status: result.status, workspace, task: check.task, runResult: result, outcome, writeback, key };
}

export async function orchestrateAll({ records, deps, options }) {
  const results = [];
  for (const record of records) {
    results.push(await orchestrateTask({ record, deps, options }));
  }
  return results;
}
