#!/usr/bin/env node
/**
 * DSH 受限执行器（第一段：二次校验 + 工作区隔离）
 *
 * 本版本**不执行任何代码**：只从收件箱读取任务，重新校验后给出工作区计划。
 * 默认 `--plan`：不创建 worktree、不调用 dsh、不写 GitHub。
 *
 * 用法：
 *   node executor.mjs --plan                 # 只打印计划（默认）
 *   node executor.mjs --plan --prepare-workspace   # 真正创建隔离 worktree（仍不执行任务）
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, validateConfig } from './lib/config.mjs';
import { createGitHubClient } from './lib/github.mjs';
import { refetchAndVerify } from './lib/task-refetch.mjs';
import { prepareWorktree } from './lib/workspace.mjs';
import { BridgeState } from './lib/state.mjs';
import { createCircuitBreaker } from './lib/lock.mjs';
import { runTaskWithGuards } from './lib/runner.mjs';

/** 本版本恒为 false：执行器没有任何启动 dsh 的默认路径 */
export const EXECUTES_CODE = false;
export const MAX_RETRIES = 2;

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
      // 半行丢弃
    }
  }
  return out;
}

/**
 * 对一批收件箱记录做二次校验与工作区计划。
 * @param {{records:object[], client:object, cfg:object, projectRoot:string, workRoot:string,
 *          prepare?:boolean, log?:Function}} params
 */
export async function planTasks({ records, client, cfg, projectRoot, workRoot, prepare = false, log = () => {} }) {
  const results = [];
  for (const record of records) {
    const check = await refetchAndVerify({ client, record, cfg });
    if (!check.ok) {
      log(`✗ 拒绝任务 ${record.reviewId}（评论 ${record.commentId}）：${check.reasons.join('；')}`);
      results.push({ ok: false, record, reasons: check.reasons });
      continue;
    }

    let workspace;
    try {
      workspace = await prepareWorktree({ projectRoot, workRoot, record, dryRun: !prepare });
    } catch (err) {
      log(`✗ 工作区准备失败 ${record.reviewId}：${err.message}`);
      results.push({ ok: false, record, reasons: [err.message] });
      continue;
    }

    log(`✓ 校验通过 ${record.reviewId} / PR #${record.prNumber} / SHA ${String(record.headSha).slice(0, 7)}` +
        `｜工作区 ${workspace.created ? '已创建' : '计划'}：${workspace.dir}`);
    results.push({ ok: true, record, task: check.task, pr: check.pr, workspace });
  }
  return results;
}

function parseArgs(argv) {
  const out = { state: '', prepare: false, limit: 0, api: false, pause: false, resume: false, execute: false, mock: false, allowRealDsh: false, timeoutMs: 15 * 60 * 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') out.state = argv[++i] || '';
    else if (a === '--limit') out.limit = Number.parseInt(argv[++i] || '0', 10) || 0;
    else if (a === '--prepare-workspace') out.prepare = true;
    else if (a === '--api') out.api = true;
    else if (a === '--pause') out.pause = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--execute') out.execute = true;
    else if (a === '--mock-dsh') out.mock = true;
    else if (a === '--allow-real-dsh') out.allowRealDsh = true;
    else if (a === '--timeout-ms') out.timeoutMs = Number.parseInt(argv[++i] || '0', 10) || out.timeoutMs;
  }
  return out;
}

const log = (msg) => process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    log('✗ 配置错误：' + err.message);
    process.exitCode = 2;
    return;
  }
  if (args.state) cfg.stateDir = args.state;

  const errors = validateConfig(cfg, { requireToken: args.api });
  if (errors.length) {
    for (const e of errors) log('✗ 配置错误：' + e);
    process.exitCode = 2;
    return;
  }

  log('──────────────────────────────────────────────');
  log('DSH 受限执行器 · 第一段（二次校验 + 工作区隔离）');
  log('本版本不执行代码：不调用 dsh、不写 GitHub、默认不创建 worktree。');
  log('──────────────────────────────────────────────');

  const state = await new BridgeState(cfg.stateDir).init();
  if (args.pause) { await state.setPaused(true, 'manual'); log('⏸ 执行器已暂停'); return; }
  if (args.resume) { await state.setPaused(false, ''); log('▶ 执行器已恢复'); return; }

  if (args.execute && !args.mock && !args.allowRealDsh) {
    log('✗ --execute 需要显式指定 --mock-dsh 或 --allow-real-dsh（默认 dry-run，不会执行）');
    process.exitCode = 2;
    return;
  }

  const records = (await readInbox(cfg.stateDir)).slice(0, args.limit || undefined);
  if (!records.length) {
    log('收件箱里没有待处理任务；先用接收器接收一条 [DSH-REVIEW-TASK] 评论。');
    return;
  }

  const client = createGitHubClient({ token: cfg.token, repo: cfg.repo, timeoutMs: cfg.requestTimeoutMs });
  const projectRoot = process.cwd();
  const workRoot = path.resolve(projectRoot, '..', '.dsh-worktrees');

  const results = await planTasks({
    records,
    client,
    cfg,
    projectRoot,
    workRoot,
    prepare: args.prepare,
    log
  });

  const ok = results.filter((r) => r.ok).length;
  log(`本轮结束：${results.length} 条任务，校验通过 ${ok} 条`);

  if (!args.execute) {
    log('（dry-run：未执行任何代码。要验证执行流程请加 --execute --mock-dsh）');
    return;
  }

  const circuit = createCircuitBreaker({ threshold: 3 });
  const mockRun = async ({ timeoutMs }) => ({ code: 0, timedOut: false, cancelled: false, durationMs: timeoutMs > 0 ? 1 : 1 });

  for (const item of results.filter((r) => r.ok)) {
    const outcome = await runTaskWithGuards({
      taskKey: item.workspace.key,
      taskText: `[mock] ${item.record.reviewId}`,
      cwd: item.workspace.dir,
      lockDir: path.join(cfg.stateDir, 'locks'),
      timeoutMs: args.timeoutMs,
      run: args.mock ? mockRun : undefined,
      isPaused: () => state.isPaused(),
      circuit,
      log
    });
    log(`  → ${item.record.reviewId}: ${outcome.status}` + (outcome.reason ? `（${outcome.reason}）` : ''));
  }
  log('执行段结束：本版本仅用于验证编排，未修改任何仓库内容。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log('✗ 执行器异常：' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}
