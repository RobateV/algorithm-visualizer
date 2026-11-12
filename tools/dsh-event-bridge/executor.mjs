#!/usr/bin/env node
/**
 * DSH 受限执行器 CLI（M2.7）
 *
 * 主链路：收件箱 → 二次校验 → 隔离工作区 → 执行 → 结果持久化 →（授权时）回写
 *
 * 能力边界（准确描述）：
 * - **默认**没有任何执行代码的路径：只做 plan
 * - Mock：`--execute --mock-dsh`，不启动真实 dsh
 * - 真实：`--execute --real-dsh --grant <file> --isolation-confirmed`，
 *   一次性授权、严格单次、失败不重试；未授权时不存在真实执行路径
 * - 回写默认关闭；`--writeback-dry-run` 只生成 [DSH-RESULT] 文本，不推送
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, validateConfig } from './lib/config.mjs';
import { createGitHubClient } from './lib/github.mjs';
import { BridgeState } from './lib/state.mjs';
import { createCircuitBreaker } from './lib/lock.mjs';
import { orchestrateAll, orchestrateTask } from './lib/orchestrator.mjs';
import { loadGrant } from './lib/grant.mjs';
import { runDsh } from './lib/dsh-cli.mjs';

/** 兼容旧调用：只做计划，不产生副作用 */
export async function planTasks({ records, client, cfg, projectRoot, workRoot, log = () => {}, state }) {
  const stubState = state || {
    getTaskOutcome: () => null,
    recordTaskOutcome: async () => {},
    isPaused: async () => ({ paused: false })
  };
  const out = [];
  for (const record of records) {
    const r = await orchestrateTask({
      record,
      deps: { client, cfg, state: stubState, projectRoot, workRoot, run: async () => ({ code: 0 }) },
      options: { execute: false, log }
    });
    if (r.status === 'rejected') out.push({ ok: false, record, reasons: r.reasons });
    else out.push({ ok: true, record, task: r.task, workspace: r.workspace });
  }
  return out;
}

/** 默认配置下不会执行代码；真实执行需一次性授权 + 隔离确认，且严格单次 */
export const EXECUTES_CODE = false;

export async function readInbox(stateDir) {
  let raw = '';
  try {
    raw = await readFile(path.join(stateDir, 'inbox.jsonl'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const rec = JSON.parse(text);
      if (rec && rec.status === 'accepted') out.push(rec);
    } catch {
      /* 半行丢弃 */
    }
  }
  return out;
}

function parseArgs(argv) {
  const out = {
    state: '', limit: 0, api: false, pause: false, resume: false,
    execute: false, mock: false, real: false, grant: '', isolationConfirmed: false,
    branch: '', timeoutMs: 15 * 60 * 1000, writebackDryRun: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') out.state = argv[++i] || '';
    else if (a === '--limit') out.limit = Number.parseInt(argv[++i] || '0', 10) || 0;
    else if (a === '--api') out.api = true;
    else if (a === '--pause') out.pause = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--execute') out.execute = true;
    else if (a === '--mock-dsh') out.mock = true;
    else if (a === '--real-dsh') out.real = true;
    else if (a === '--grant') out.grant = argv[++i] || '';
    else if (a === '--isolation-confirmed') out.isolationConfirmed = true;
    else if (a === '--branch') out.branch = argv[++i] || '';
    else if (a === '--writeback-dry-run') out.writebackDryRun = true;
    else if (a === '--timeout-ms') out.timeoutMs = Number.parseInt(argv[++i] || '0', 10) || out.timeoutMs;
  }
  return out;
}

const log = (msg) => process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);

export async function runCli(argv, deps = {}) {
  const args = parseArgs(argv);
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    log('✗ 配置错误：' + err.message);
    return 2;
  }
  if (args.state) cfg.stateDir = args.state;

  const errors = validateConfig(cfg, { requireToken: args.api });
  if (errors.length) {
    for (const e of errors) log('✗ 配置错误：' + e);
    return 2;
  }

  const state = deps.state || await new BridgeState(cfg.stateDir).init();
  if (args.pause) { await state.setPaused(true, 'manual'); log('⏸ 执行器已暂停'); return 0; }
  if (args.resume) { await state.setPaused(false, ''); log('▶ 执行器已恢复'); return 0; }

  if (args.execute && !args.mock && !args.real) {
    log('✗ --execute 必须显式指定 --mock-dsh（默认）或 --real-dsh --grant <file>');
    return 2;
  }
  if (args.execute && args.mock && args.real) {
    log('✗ --mock-dsh 与 --real-dsh 不能同时使用');
    return 2;
  }
  if (args.real && !args.grant) {
    log('✗ --real-dsh 需要一次性授权文件：--grant <path>');
    return 2;
  }

  let grant = null;
  if (args.real) {
    try {
      grant = await loadGrant(args.grant);
    } catch (err) {
      log('✗ 授权文件错误：' + err.message);
      return 2;
    }
  }
  const mode = args.real ? 'real' : 'mock';

  log('──────────────────────────────────────────────');
  log('DSH 受限执行器 · 主链路（二次校验 → 隔离工作区 → 执行 → 结果）');
  log(args.execute
    ? `模式：execute / ${mode}${mode === 'real' ? '（一次性授权）' : '（Mock，不启动真实 dsh）'}`
    : '模式：plan（不创建 worktree、不执行）');
  log('──────────────────────────────────────────────');

  const records = (await readInbox(cfg.stateDir)).slice(0, args.limit || undefined);
  if (!records.length) {
    log('收件箱里没有待处理任务。');
    return 0;
  }

  const client = deps.client || createGitHubClient({ token: cfg.token, repo: cfg.repo, timeoutMs: cfg.requestTimeoutMs });
  const projectRoot = deps.projectRoot || process.cwd();
  const depsBundle = {
    client,
    cfg,
    state,
    projectRoot,
    workRoot: deps.workRoot || path.resolve(projectRoot, '..', '.dsh-worktrees'),
    lockDir: deps.lockDir || path.join(cfg.stateDir, 'locks'),
    run: deps.run || (mode === 'real'
      ? runDsh
      : async ({ timeoutMs }) => ({ code: 0, timedOut: false, cancelled: false, durationMs: Math.min(timeoutMs, 1) })),
    io: deps.io || null
  };

  const results = await orchestrateAll({
    records,
    deps: depsBundle,
    options: {
      execute: args.execute,
      mode,
      grant,
      grantPath: args.grant,
      isolationConfirmed: args.isolationConfirmed,
      timeoutMs: args.timeoutMs,
      branch: args.branch,
      writebackEnabled: args.execute && args.writebackDryRun && Boolean(args.branch),
      writebackDryRun: true,
      circuit: deps.circuit || createCircuitBreaker({ threshold: 3 }),
      log
    }
  });

  for (const r of results) {
    const tag = r.status === 'planned' ? '计划' : r.status;
    log(`  → ${r.key || ''} ${tag}` + (r.reasons ? `：${r.reasons.join('；')}` : '') +
        (r.workspace ? `｜工作区 ${r.workspace.created ? '已创建' : '计划'}：${r.workspace.dir}` : ''));
  }

  const summary = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  log(`本轮结束：${results.length} 条任务 ${JSON.stringify(summary)}`);
  if (!args.execute) log('（plan 模式：未创建 worktree、未执行任何代码）');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    log('✗ 执行器异常：' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}
