/**
 * 单一编排器：收件箱 → 二次校验 → 隔离工作区 → 执行 → 结果持久化 →（授权时）回写。
 *
 * 真实执行（mode='real'）额外约束：
 * - 必须一次性授权 + 隔离确认，且**严格只启动一次**（失败/超时都不重试）
 * - 启动前顺序：durable `reserved` 预留 → 消费授权；消费失败保留预留并暂停
 * - 执行后本地校验副作用：HEAD 不得变化、改动只能在允许路径内
 */
import { access } from 'node:fs/promises';
import { refetchAndVerify } from './task-refetch.mjs';
import { prepareWorktree, assertCleanProject, verifyOneShotSideEffects, taskKey as workspaceKeyOf } from './workspace.mjs';
import { withTaskLocks, performAttempts, MAX_RETRIES } from './runner.mjs';
import { buildDshArgv } from './dsh-cli.mjs';
import { performWriteback } from './writeback.mjs';
import { validateGrant, consumeGrant } from './grant.mjs';
import { sha256 } from './state.mjs';

/** 同一任务允许的总尝试次数（跨重启累计） */
export const TOTAL_ATTEMPTS = 1 + MAX_RETRIES;

export const TASK_CONTRACT_HEADER = [
  '你正在一个隔离的 git worktree 中执行受限任务。',
  '只允许修改与本任务直接相关的文件；不要修改默认分支，不要 force push，不要合并。',
  '不要访问仓库目录以外的文件，不要读取或提交任何密钥。',
  '完成任务后只提交普通 commit，并简述改动与测试结果。'
].join('\n');

/** 一次性真实试运行的契约：只允许本地 smoke 文件改动，明令禁止一切对外副作用 */
export const ONE_SHOT_CONTRACT_HEADER = [
  '你正在一个隔离的 git worktree 中执行【一次性本地冒烟测试】。',
  '严格禁止：git commit、git push、创建或评论 Pull Request、merge、部署、安装依赖以外的网络操作。',
  '禁止修改测试目录以外的任何文件，禁止执行删除操作。',
  '只做最小文本改动，然后停止；不要提交、不要推送、不要发起任何 GitHub 操作。'
].join('\n');

export const DEFAULT_ALLOWED_PATHS = ['tests/automation-smoke/'];

export function outcomeKeyOf(record) {
  return `${record.prNumber}:${record.headSha}:${record.commentId}`;
}

export function buildTaskContract({ task, prNumber, headSha, oneShot = false, allowedPaths = DEFAULT_ALLOWED_PATHS }) {
  const detail = String(task.detail || '').trim();
  if (!detail) throw new Error('任务正文为空');
  const header = oneShot
    ? [ONE_SHOT_CONTRACT_HEADER, `允许改动的路径：${allowedPaths.join('、')}`].join('\n')
    : TASK_CONTRACT_HEADER;
  return [
    header,
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
  const mode = options.mode === 'real' ? 'real' : 'mock';
  const key = outcomeKeyOf(record);

  const previous = deps.state.getTaskOutcome(key, mode);
  const previousMode = (previous && previous.mode) || mode;

  // Mock 成功不能让真实任务被跳过；只有同模式成功才算完成
  if (previous && previous.status === 'succeeded' && previousMode === mode) {
    return { status: 'skipped', reason: 'already-succeeded', key, mode };
  }

  // 上次真实执行留下了 reserved/running 却没有结果：视为中断，必须人工确认
  if (previous && (previous.status === 'reserved' || previous.status === 'running')) {
    await deps.state.recordTaskOutcome(key, {
      status: 'interrupted', mode: previousMode, attempts: previous.attempts, reason: '进程中断，未完成'
    });
    await deps.state.setPaused(true, `任务 ${record.reviewId} 上次运行被中断，需人工确认后再执行`);
    log(`⏸ 检测到中断记录（${record.reviewId}），已标记 interrupted 并暂停`);
    return { status: 'interrupted', reason: 'needs-manual-confirm', key, mode };
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
    return { status: 'rejected', reasons: check.reasons, key, mode };
  }

  // 真实执行的三重前置：隔离已确认 + 一次性授权 + 授权与本次任务逐项匹配
  if (mode === 'real') {
    if (options.isolationConfirmed !== true) {
      return { status: 'rejected', reasons: ['未确认 Windows 执行隔离清单（需 --isolation-confirmed）'], key, mode };
    }
    if (!options.grant) {
      return { status: 'rejected', reasons: ['真实执行需要一次性授权文件（--grant <file>）'], key, mode };
    }
    const grantProblems = validateGrant(options.grant, {
      repo: deps.cfg.repo,
      prNumber: record.prNumber,
      headSha: record.headSha,
      commentId: record.commentId,
      bodyDigest: sha256(check.comment.body),
      workRoot: deps.workRoot
    });
    if (grantProblems.length) {
      return { status: 'rejected', reasons: grantProblems.map((r) => `授权无效：${r}`), key, mode };
    }
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

      if (mode === 'real') {
        // 顺序：先 durable 预留，再消费授权。消费失败时保留 reserved 并暂停，
        // 宁可误暂停也不允许静默再次运行（预留记录会让下次启动转人工确认）。
        await deps.state.recordTaskOutcome(key, {
          status: 'reserved',
          mode: 'real',
          attempts: usedBefore + 1,
          reviewId: record.reviewId,
          headSha: record.headSha
        });
        try {
          await consumeGrant(options.grantPath);
        } catch (err) {
          await deps.state.setPaused(true, `授权消费失败（${err.message}），需人工核查`);
          return { grantConsumeFailed: true, reason: err.message };
        }
        log('🔐 已写入执行前预留并消费一次性授权');
      }

      const allowedPaths = options.allowedPaths || DEFAULT_ALLOWED_PATHS;
      const taskText = buildTaskContract({
        task: check.task,
        prNumber: record.prNumber,
        headSha: record.headSha,
        oneShot: mode === 'real',
        allowedPaths
      });
      const remaining = TOTAL_ATTEMPTS - usedBefore;
      // 真实模式严格单次：失败/超时都不重启 DSH
      const maxRetries = mode === 'real' ? 0 : Math.min(MAX_RETRIES, Math.max(0, remaining - 1));
      const result = await performAttempts({
        argv: buildDshArgv(taskText),
        cwd,
        timeoutMs: options.timeoutMs,
        run: deps.run,
        maxRetries,
        circuit: options.circuit,
        log
      });
      // 一次性真实试运行：不信任 DSH 自述，执行后自己检查 HEAD 与改动路径
      if (mode === 'real') {
        const problems = await verifyOneShotSideEffects({
          worktree: cwd,
          baseSha: record.headSha,
          allowedPaths,
          git: deps.git
        });
        if (problems.length) {
          log('⛔ 一次性试运行越界：' + problems.join('；'));
          return {
            workspace,
            violations: problems,
            result: { ...result, status: 'failed', reason: '越界：' + problems.join('；') }
          };
        }
      }
      return { workspace, result };
    }
  );

  if (locked.grantConsumeFailed) {
    return { status: 'rejected', reasons: [`授权消费失败：${locked.reason}`], key, mode, attempts: usedBefore };
  }

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
    mode,
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
