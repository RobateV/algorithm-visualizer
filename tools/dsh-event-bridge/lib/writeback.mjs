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

const SHA_RE = /^[0-9a-f]{40}$/;
const REQUIRED_IO = ['commit', 'push', 'comment', 'refresh'];

/** 只做判断，不产生副作用；返回拒绝原因数组（fail-closed：字段缺失也拒绝） */
export function checkWritebackGuards({ enabled = false, prState, expectedHeadSha, currentHeadSha, branch, io } = {}) {
  const reasons = [];
  if (enabled !== true) reasons.push('write-back 未启用（默认禁止真实推送）');

  if (prState !== 'open') reasons.push(`PR 状态缺失或非 open：${prState === undefined ? '(缺失)' : prState}`);

  if (!SHA_RE.test(String(expectedHeadSha || ''))) reasons.push('expectedHeadSha 缺失或不是 40 位十六进制');
  if (!SHA_RE.test(String(currentHeadSha || ''))) reasons.push('currentHeadSha 缺失或不是 40 位十六进制');
  if (SHA_RE.test(String(expectedHeadSha || '')) && SHA_RE.test(String(currentHeadSha || '')) && expectedHeadSha !== currentHeadSha) {
    reasons.push('PR HEAD 已变化，拒绝覆盖他人提交');
  }

  if (!branch || typeof branch !== 'string') {
    reasons.push('缺少目标分支');
  } else if (PROTECTED_BRANCHES.has(branch) || branch.startsWith('main/')) {
    reasons.push(`不允许写入受保护分支：${branch}`);
  }

  if (!io || typeof io !== 'object') {
    reasons.push('缺少 IO 实现（commit/push/comment/refresh）');
  } else {
    for (const name of REQUIRED_IO) {
      if (typeof io[name] !== 'function') reasons.push(`缺少 IO 实现：${name}`);
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
    branch: params.branch,
    io
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

  // push 前复查：防止校验与推送之间别人推进了 PR
  let latest;
  try {
    latest = await io.refresh();
  } catch (err) {
    return { ok: false, reasons: [`push 前复查失败：${err.message}`], pushed: false, commented: false };
  }
  if (!latest || latest.state !== 'open') {
    return { ok: false, reasons: ['push 前复查：PR 状态不是 open'], pushed: false, commented: false };
  }
  if (latest.headSha !== params.expectedHeadSha) {
    return { ok: false, reasons: ['push 前复查：PR HEAD 已变化'], pushed: false, commented: false };
  }

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
