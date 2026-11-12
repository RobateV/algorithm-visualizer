/**
 * 一次性真实执行授权（M2.7）。
 *
 * 设计目标：真实 DSH 只能被"一份绑定到具体任务、具体 SHA、只能用一次、会过期"的
 * 本地授权文件"点燃"，而不是靠 `--real` 开关无限运行。
 *
 * 授权文件示例（由教师手工创建，放在 state 目录外也可）：
 * {
 *   "version": 1,
 *   "nonce": "b7c1...",                 // 防重放，消费后文件被改名
 *   "repo": "RobateV/algorithm-visualizer",
 *   "prNumber": 4,
 *   "headSha": "c7b172fea1bd...40位",
 *   "commentId": 123456789,
 *   "bodyDigest": "<sha256 of comment body>",
 *   "workRoot": "E:\\算法可视化\\.dsh-worktrees",
 *   "maxRuns": 1,
 *   "issuedAt": "2026-11-12T10:00:00Z",
 *   "expiresAt": "2026-11-12T12:00:00Z"
 * }
 */
import { readFile, rename, access } from 'node:fs/promises';
import path from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_GRANT_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * 校验授权是否允许本次任务执行。返回原因数组（空数组表示通过）。
 * @param {object} grant
 * @param {{repo:string, prNumber:number, headSha:string, commentId:number,
 *          bodyDigest:string, workRoot:string, now?:number}} expected
 */
export function validateGrant(grant, expected) {
  const reasons = [];
  const now = expected.now || Date.now();

  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return ['授权内容不是对象'];
  if (grant.version !== 1) reasons.push(`授权版本不支持：${grant.version}`);
  if (!grant.nonce || typeof grant.nonce !== 'string' || grant.nonce.length < 8) reasons.push('缺少有效 nonce');

  if (grant.repo !== expected.repo) reasons.push(`仓库不匹配：${grant.repo}`);
  if (Number(grant.prNumber) !== Number(expected.prNumber)) reasons.push(`PR 不匹配：${grant.prNumber}`);

  if (!SHA_RE.test(String(grant.headSha || ''))) reasons.push('headSha 不是 40 位十六进制');
  else if (grant.headSha !== expected.headSha) reasons.push('headSha 与任务不一致');

  if (Number(grant.commentId) !== Number(expected.commentId)) reasons.push('commentId 与任务不一致');

  if (!grant.bodyDigest || grant.bodyDigest !== expected.bodyDigest) reasons.push('评论正文摘要不一致（可能已被编辑）');

  if (grant.workRoot && path.resolve(grant.workRoot) !== path.resolve(expected.workRoot)) {
    reasons.push('工作根目录与授权不一致');
  }

  if (Number(grant.maxRuns) !== 1) reasons.push('一次性授权要求 maxRuns = 1');

  const issued = Date.parse(grant.issuedAt || '');
  const expires = Date.parse(grant.expiresAt || '');
  if (!Number.isFinite(issued)) reasons.push('issuedAt 缺失或非法');
  if (!Number.isFinite(expires)) reasons.push('expiresAt 缺失或非法');
  if (Number.isFinite(issued) && Number.isFinite(expires)) {
    if (expires <= issued) reasons.push('expiresAt 必须晚于 issuedAt');
    if (expires - issued > MAX_GRANT_LIFETIME_MS) reasons.push('授权有效期不得超过 24 小时');
    if (expires <= now) reasons.push('授权已过期');
  }

  return reasons;
}

export async function loadGrant(file) {
  if (!file) throw new Error('缺少授权文件路径');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`授权文件不可读：${err.code === 'ENOENT' ? '文件不存在' : err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('授权文件不是合法 JSON');
  }
  return data;
}

/**
 * 原子消费：把授权文件改名。改名失败即视为未获得授权（fail-closed）。
 * 消费发生在启动真实子进程之前，宁可烧掉授权也不重复执行。
 */
export async function consumeGrant(file) {
  const consumedPath = `${file}.used.${Date.now()}`;
  await rename(file, consumedPath);   // 失败会抛错
  return consumedPath;
}

export async function grantExists(file) {
  try { await access(file); return true; } catch { return false; }
}
