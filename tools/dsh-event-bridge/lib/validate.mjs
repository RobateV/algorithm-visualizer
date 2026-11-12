/**
 * 任务块的解析与校验。
 *
 * 期望的评论格式（Work 侧生成）：
 *
 *   [DSH-REVIEW-TASK]
 *   repo: RobateV/algorithm-visualizer
 *   pr_number: 4
 *   expected_head_sha: c7b172f...
 *   review_id: work-2026-11-12-001
 *   attempt: 1
 *   ---
 *   ## 问题
 *   ...
 *
 * 除标记外全部字段都是"必须存在且格式合法"，任何一项不满足都返回明确原因，
 * 不做"猜测式"容错——事件接收器宁可漏处理，也不要执行来路不明的任务。
 */

const SHA_RE = /^[0-9a-f]{40}$/;
const REVIEW_ID_RE = /^[A-Za-z0-9._-]{3,64}$/;

/**
 * 从评论文本中提取任务块。
 * @param {string} body
 * @param {{marker?: string, maxBodyLength?: number}} options
 */
export function parseTaskBlock(body, options = {}) {
  const marker = options.marker || '[DSH-REVIEW-TASK]';
  const maxBodyLength = options.maxBodyLength || 20000;

  if (typeof body !== 'string' || !body.trim()) return { ok: false, reason: '评论内容为空' };
  if (body.length > maxBodyLength) return { ok: false, reason: `评论超过 ${maxBodyLength} 字符上限` };
  if (!body.includes(marker)) return { ok: false, reason: '未找到任务标记' };

  const afterMarker = body.slice(body.indexOf(marker) + marker.length);
  const separatorIndex = afterMarker.indexOf('\n---');
  const header = separatorIndex >= 0 ? afterMarker.slice(0, separatorIndex) : afterMarker;
  const detail = separatorIndex >= 0 ? afterMarker.slice(separatorIndex + 4).trim() : '';

  const fields = {};
  for (const rawLine of header.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at <= 0) continue;
    fields[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }

  const prNumber = Number.parseInt(fields.pr_number, 10);
  const attempt = fields.attempt === undefined ? 1 : Number.parseInt(fields.attempt, 10);

  const task = {
    repo: fields.repo || '',
    prNumber: Number.isFinite(prNumber) ? prNumber : null,
    expectedHeadSha: (fields.expected_head_sha || '').toLowerCase(),
    reviewId: fields.review_id || '',
    attempt: Number.isFinite(attempt) ? attempt : null,
    detail
  };

  return { ok: true, task };
}

/**
 * 对解析结果做语义校验。
 * @param {ReturnType<typeof parseTaskBlock>['task']} task
 * @param {{repo:string, allowedPrs:number[], prHeadSha?:string, prState?:string, maxAttempts:number}} ctx
 */
export function validateTask(task, ctx) {
  if (task.repo !== ctx.repo) return { ok: false, reason: `仓库不匹配：${task.repo || '(空)'}` };
  if (!Number.isInteger(task.prNumber) || task.prNumber <= 0) return { ok: false, reason: 'pr_number 非法' };
  if (ctx.allowedPrs && ctx.allowedPrs.length && !ctx.allowedPrs.includes(task.prNumber)) {
    return { ok: false, reason: `PR #${task.prNumber} 不在允许列表内` };
  }
  if (!SHA_RE.test(task.expectedHeadSha)) return { ok: false, reason: 'expected_head_sha 不是 40 位十六进制' };
  if (!REVIEW_ID_RE.test(task.reviewId)) return { ok: false, reason: 'review_id 非法（需 3-64 位字母数字 . _ -）' };
  if (!Number.isInteger(task.attempt) || task.attempt < 1 || task.attempt > ctx.maxAttempts) {
    return { ok: false, reason: `attempt 必须在 1..${ctx.maxAttempts}` };
  }
  if (ctx.prState && ctx.prState !== 'open') return { ok: false, reason: `PR 状态为 ${ctx.prState}，不再接受任务` };
  if (ctx.prHeadSha && ctx.prHeadSha !== task.expectedHeadSha) {
    return { ok: false, reason: `任务针对 ${task.expectedHeadSha.slice(0, 7)}，但 PR 当前 HEAD 是 ${ctx.prHeadSha.slice(0, 7)}（已过期）` };
  }
  if (!task.detail) return { ok: false, reason: '缺少问题描述正文' };
  return { ok: true };
}

/** 评论作者是否在允许名单内 */
export function isAllowedAuthor(comment, allowedActors) {
  const login = comment && comment.user && comment.user.login;
  return Boolean(login) && allowedActors.includes(login);
}
