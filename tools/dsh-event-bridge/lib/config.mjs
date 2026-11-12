/**
 * 接收器配置：全部来自环境变量，默认值面向本仓库的最小安全配置。
 * 任何一项不合规都在启动时直接失败，避免"带病上线"。
 */

export const DEFAULT_MARKER = '[DSH-REVIEW-TASK]';

const DEFAULTS = {
  repo: 'RobateV/algorithm-visualizer',
  allowedActors: ['RobateV'],
  allowedPrs: [],           // 空数组 = 不限制 PR 编号
  pollIntervalMs: 15000,
  maxAttempts: 3,
  stateDir: '.dsh-bridge-state',
  maxBodyLength: 20000,
  requestTimeoutMs: 15000
};

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{repo:string, allowedActors:string[], allowedPrs:number[], pollIntervalMs:number,
 *            maxAttempts:number, stateDir:string, maxBodyLength:number, requestTimeoutMs:number,
 *            token:string, marker:string}}
 */
export function loadConfig(env = process.env) {
  const cfg = {
    repo: env.DSH_BRIDGE_REPO || DEFAULTS.repo,
    allowedActors: parseList(env.DSH_BRIDGE_ACTORS).length ? parseList(env.DSH_BRIDGE_ACTORS) : DEFAULTS.allowedActors,
    allowedPrs: parseList(env.DSH_BRIDGE_ALLOWED_PRS).map((n) => Number.parseInt(n, 10)).filter(Number.isFinite),
    pollIntervalMs: parsePositiveInt(env.DSH_BRIDGE_POLL_MS, DEFAULTS.pollIntervalMs),
    maxAttempts: parsePositiveInt(env.DSH_BRIDGE_MAX_ATTEMPTS, DEFAULTS.maxAttempts),
    stateDir: env.DSH_BRIDGE_STATE_DIR || DEFAULTS.stateDir,
    maxBodyLength: DEFAULTS.maxBodyLength,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
    token: env.DSH_BRIDGE_TOKEN || '',
    marker: env.DSH_BRIDGE_MARKER || DEFAULT_MARKER
  };
  return cfg;
}

/** 启动前的硬性校验，返回错误信息数组（空数组表示通过） */
export function validateConfig(cfg, { requireToken = false } = {}) {
  const errors = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) errors.push('repo 必须形如 owner/name');
  if (!Array.isArray(cfg.allowedActors) || cfg.allowedActors.length === 0) errors.push('allowedActors 不能为空');
  if (cfg.pollIntervalMs < 5000) errors.push('pollIntervalMs 不得低于 5000（避免触发 API 限流）');
  if (cfg.maxAttempts < 1 || cfg.maxAttempts > 5) errors.push('maxAttempts 必须在 1..5 之间');
  if (requireToken && !cfg.token) errors.push('缺少 DSH_BRIDGE_TOKEN（只读 issues 权限的 fine-grained PAT）');
  return errors;
}
