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

/** 本版本恒为 false：执行器没有任何启动 dsh 的路径 */
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
  const out = { state: '', prepare: false, limit: 0, api: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') out.state = argv[++i] || '';
    else if (a === '--limit') out.limit = Number.parseInt(argv[++i] || '0', 10) || 0;
    else if (a === '--prepare-workspace') out.prepare = true;
    else if (a === '--api') out.api = true;
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
  log(`本轮结束：${results.length} 条任务，校验通过 ${ok} 条（未执行任何代码）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log('✗ 执行器异常：' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}
