/**
 * [DSH-RESULT] 结果回写：构建报告 + 受控落盘/推送/评论。
 *
 * 安全默认：
 * - `enabled` 必须显式为 true，否则一律拒绝（默认禁止真实推送）
 * - PR 必须 open，且 `expectedHeadSha === currentHeadSha`（别人推进了就停）
 * - 永不写 main/master，永不 force push，永不自动合并
 * - commit / push / comment 全部通过注入的 io 执行，便于测试与审计
 */
export const RESULT_MARKER = '[DSH-RESULT]';
export const ALLOWED_STATUS = new Set(['succeeded', 'failed', 'timeout', 'cancelled', 'skipped', 'rejected']);
const PROTECTED_BRANCHES = new Set(['main', 'master', 'HEAD']);

export function buildResultReport({
  taskId, prNumber, baseSha, newSha, status, attempts,
  startedAt, finishedAt, tests, errors
}) {
  if (!RESULT_MARKER) throw new Error('unreachable');
  if (!ALLOWED_STATUS.has(status)) throw new Error(`未知的执行状态：${status}`);
  const errLines = Array.isArray(errors) && errors.length ? errors.map((e) => `- ${e}`).join('\n') : '无';
  return [
    RESULT_MARKER,
    `task_id: ${taskId}`,
    `pr_number: ${prNumber}`,
    `base_sha: ${baseSha}`,
    `new_sha: ${newSha || 'none'}`,
    `status: ${status}`,
    `attempts: ${attempts ?? 0}`,
    `started_at: ${startedAt || ''}`,
    `finished_at: ${finishedAt || ''}`,
    '---',
    '## 测试结果',
    tests ? String(tests).trim() : '（未运行）',
    '',
    '## 错误摘要',
    errLines,
    '',
    '_本评论由受限执行器自动生成；不会自动合并或修改默认分支。_'
  ].join('\n');
}

/** 只做判断，不产生副作用；返回拒绝原因数组 */
export function checkWritebackGuards({ enabled = false, prState, expectedHeadSha, currentHeadSha, branch } = {}) {
  const reasons = [];
  if (enabled !== true) reasons.push('write-back 未启用（默认禁止真实推送）');
  if (prState && prState !== 'open') reasons.push(`PR 状态为 ${prState}，拒绝回写`);
  if (expectedHeadSha && currentHeadSha && expectedHeadSha !== currentHeadSha) {
    reasons.push('PR HEAD 已变化，拒绝覆盖他人提交');
  }
  if (branch !== undefined && branch !== null) {
    if (PROTECTED_BRANCHES.has(String(branch)) || String(branch).startsWith('main/')) {
      reasons.push(`不允许写入受保护分支：${branch}`);
    }
  }
  return reasons;
}

/**
 * 执行回写。
 * @param {{enabled:boolean, dryRun?:boolean, taskId:string, prNumber:number, baseSha:string,
 *          expectedHeadSha:string, currentHeadSha:string, prState:string, branch:string,
 *          newSha?:string, status:string, attempts?:number, startedAt?:string, finishedAt?:string,
 *          tests?:string, errors?:string[],
 *          io?:{commit?:Function, push?:Function, comment?:Function}, message?:string}} params
 */
export async function performWriteback(params) {
  const { prNumber, status, tests, errors } = params;
  const enabled = params.enabled === true;
  const dryRun = params.dryRun !== false;   // 默认 dry-run
  const io = params.io || {};
  const message = params.message || 'chore: guarded executor result';

  const reasons = checkWritebackGuards({
    enabled,
    prState: params.prState,
    expectedHeadSha: params.expectedHeadSha,
    currentHeadSha: params.currentHeadSha,
    branch: params.branch
  });
  if (reasons.length) return { ok: false, reasons, pushed: false, commented: false };

  const body = buildResultReport({
    taskId: params.taskId,
    prNumber,
    baseSha: params.baseSha,
    newSha: params.newSha,
    status,
    attempts: params.attempts,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    tests,
    errors
  });

  if (dryRun) return { ok: true, dryRun: true, body, pushed: false, commented: false };

  const result = { ok: true, dryRun: false, body, pushed: false, commented: false, commit: null };
  if (typeof io.commit === 'function') result.commit = await io.commit(message);
  if (typeof io.push === 'function') {
    // 显式传 force:false，任何实现都不允许改写历史
    await io.push({ force: false, branch: params.branch });
    result.pushed = true;
  }
  if (typeof io.comment === 'function') {
    await io.comment(prNumber, body);
    result.commented = true;
  }
  return result;
}
