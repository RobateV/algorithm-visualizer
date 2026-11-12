/**
 * 任务二次校验：执行前**重新向 GitHub 读取原始评论**，不信任收件箱里的存量数据。
 *
 * 收件箱只当"待办索引"，所有安全判断都基于这次实时读取 + PR 当前状态。
 * 任何一项不满足都拒绝（fail-closed），并给出可读原因。
 */
import { parseTaskBlock } from './validate.mjs';
import { sha256 } from './state.mjs';

/**
 * @param {{client:{getComment:Function,getPull:Function}, record:object, cfg:object}} params
 * @returns {Promise<{ok:boolean, reasons:string[], comment?:object, task?:object, pr?:object}>}
 */
export async function refetchAndVerify({ client, record, cfg }) {
  const reasons = [];

  if (!record || record.commentId == null) return { ok: false, reasons: ['收件箱记录缺少评论 id'] };
  if (!record.bodyDigest) reasons.push('收件箱快照缺少正文摘要，无法确认评论未被编辑，请重新接收');

  let comment = null;
  try {
    comment = await client.getComment(record.commentId);
  } catch (err) {
    return { ok: false, reasons: [`读取评论失败：${err.message}`] };
  }
  if (!comment) return { ok: false, reasons: ['评论已被删除'] };

  if (!cfg.allowedActors.includes(comment.user.login)) {
    reasons.push(`评论作者 ${comment.user.login} 不在可信名单`);
  }

  const issuePr = Number(((comment.issueUrl || '').match(/\/issues\/(\d+)/) || [])[1] || 0);
  if (issuePr !== record.prNumber) {
    reasons.push(`评论属于 PR #${issuePr || '(未知)'}，与记录的 #${record.prNumber} 不一致`);
  }

  const parsed = parseTaskBlock(comment.body, { marker: cfg.marker, maxBodyLength: cfg.maxBodyLength });
  if (!parsed.ok) reasons.push(`任务块解析失败：${parsed.reason}`);
  const task = parsed.ok ? parsed.task : null;

  if (task) {
    if (task.repo !== cfg.repo) reasons.push(`仓库不匹配：${task.repo}`);
    if (task.prNumber !== record.prNumber) reasons.push('pr_number 与收件箱记录不一致');
    if (task.reviewId !== record.reviewId) reasons.push('review_id 与收件箱记录不一致');
    if (task.expectedHeadSha !== record.headSha) reasons.push('expected_head_sha 与收件箱记录不一致');
    if (task.attempt > cfg.maxAttempts) reasons.push(`attempt ${task.attempt} 超过上限 ${cfg.maxAttempts}`);
  }

  if (record.bodyDigest && sha256(comment.body) !== record.bodyDigest) {
    reasons.push('评论正文已被编辑（摘要与接收时不一致）');
  }

  let pr = null;
  try {
    pr = await client.getPull(record.prNumber);
  } catch (err) {
    return { ok: false, reasons: [...reasons, `读取 PR 失败：${err.message}`] };
  }
  if (pr.state !== 'open') reasons.push(`PR 状态为 ${pr.state}，不再接受任务`);
  if (record.headSha !== pr.headSha) {
    reasons.push(`PR HEAD 已变为 ${String(pr.headSha).slice(0, 7)}，任务已过期`);
  }

  return { ok: reasons.length === 0, reasons, comment, task, pr };
}
