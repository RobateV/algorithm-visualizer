// 返工必须沿本机已报告并被退回的实际提交，不能通过新 task_id 重置授权。
export function taskFamily(task, records) {
  const parents = Object.values(records).filter((r) => r.pushed && r.branch === task.branch && r.commit === task.expectedSha);
  if (parents.length > 1) throw new Error('返工提交对应多个本地任务，拒绝猜测');
  if (!parents.length) {
    if (task.branch !== 'dev/local-dsh-20261114') throw new Error('返工分支缺少本地执行记录');
    return { rootTaskId: task.taskId, round: 1, parentTaskId: null };
  }
  const parent = parents[0];
  if (parent.status === 'done' && parent.reviewVerdict === 'accept') return { rootTaskId: task.taskId, round: 1, parentTaskId: null };
  if (parent.status !== 'blocked' || parent.reviewVerdict !== 'rework' || !parent.reviewCommentId) throw new Error('上一轮尚无绑定提交的返工审查');
  if (Object.values(records).some((r) => (r.rootTaskId || r.taskId) === (parent.rootTaskId || parent.taskId) && r.status === 'done' && r.reviewVerdict === 'accept')) throw new Error('根任务已完成，请基于最终通过的提交定义新任务');
  return { rootTaskId: parent.rootTaskId || parent.taskId, round: (parent.round || 1) + 1, parentTaskId: parent.taskId };
}

export function checkFamilyLimits({ task, root, family, records, maxRounds = 1, maxCliCalls = 1 }) {
  if (!root || !Array.isArray(root.allow) || task.allow.some((p) => !root.allow.includes(p))) throw new Error('返工扩大了根任务文件范围');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 3 || family.round > maxRounds) throw new Error('根任务返工轮数上限已达到');
  if (!Number.isInteger(maxCliCalls) || maxCliCalls < 1 || maxCliCalls > 3) throw new Error('根任务 CLI 次数上限必须为 1–3');
  const calls = Object.values(records).filter((r) => (r.rootTaskId || r.taskId) === family.rootTaskId).reduce((n, r) => n + (r.modelCalls || 0), 0);
  if (calls > maxCliCalls) throw new Error('根任务 CLI 调用次数超限');
  const completed = new Set(Object.values(records).filter((r) => r.status === 'done' && r.reviewVerdict === 'accept').map((r) => r.rootTaskId || r.taskId));
  const other = Object.values(records).find((r) => r.rootTaskId && r.rootTaskId !== family.rootTaskId && !completed.has(r.rootTaskId) && !r.legacy &&
    (['running', 'testing', 'committing', 'review_ready', 'reporting', 'reported'].includes(r.status) || (r.status === 'blocked' && r.reviewVerdict === 'rework')));
  if (other) throw new Error('上一根任务尚未验收完成，拒绝并行启动下一需求');
  return { calls, maxCliCalls };
}
