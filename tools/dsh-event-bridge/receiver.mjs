#!/usr/bin/env node
/**
 * DSH 事件接收器 —— 最小可用 dry-run 原型
 *
 * 设计目标：把"GitHub 上出现 [DSH-REVIEW-TASK] 评论"变成"本机收到一条待办任务"，
 * 并且在这一版里【只记录、不执行】：
 *   - 不调用 dsh，不 spawn 任何子进程
 *   - 不写仓库文件、不改 PR、不 push
 *
 * 用法：
 *   node receiver.mjs --once --fixture fixtures/sample-comments.json   # 离线演练
 *   node receiver.mjs --once --api                                     # 拉一次 GitHub
 *   node receiver.mjs --api                                            # 常驻轮询
 *   node receiver.mjs --pause / --resume                               # 暂停/恢复
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, validateConfig } from './lib/config.mjs';
import { parseTaskBlock, validateTask, isAllowedAuthor } from './lib/validate.mjs';
import { BridgeState } from './lib/state.mjs';
import { createGitHubClient } from './lib/github.mjs';

/** 本版本恒为 false：接收器没有任何执行代码的路径 */
export const EXECUTES_CODE = false;

export function pullNumberFromComment(comment) {
  const url = comment && (comment.issue_url || comment.html_url || '');
  const m = String(url).match(/\/issues\/(\d+)/);
  if (m) return Number.parseInt(m[1], 10);
  const m2 = String(url).match(/\/pull\/(\d+)/);
  return m2 ? Number.parseInt(m2[1], 10) : null;
}

/**
 * 处理一批评论（纯函数式，便于离线测试）。
 * @param {{comments:any[], state:BridgeState, cfg:any, resolvePr:(n:number)=>Promise<any>, source?:string, log?:Function}} params
 */
export async function runOnce({ comments, state, cfg, resolvePr, source = 'fixture', log = () => {} }) {
  const results = [];

  const pause = await state.isPaused();
  if (pause.paused) {
    log(`⏸ 已暂停（${pause.reason}），本轮不接收任何任务`);
    return { skipped: true, reason: pause.reason, results };
  }

  for (const comment of comments || []) {
    const commentId = comment && comment.id;
    try {
    if (commentId == null) continue;

    if (state.hasSeenComment(commentId)) {
      results.push({ status: 'duplicate-comment', commentId });
      continue;
    }

    if (!isAllowedAuthor(comment, cfg.allowedActors)) {
      const login = comment.user && comment.user.login;
      await state.reject({ commentId, source, reason: `作者 ${login || '(未知)'} 不在允许列表` });
      log(`✗ 拒绝评论 ${commentId}：作者 ${login} 不可信`);
      results.push({ status: 'rejected', commentId, reason: 'untrusted-author' });
      continue;
    }

    const parsed = parseTaskBlock(comment.body, { marker: cfg.marker, maxBodyLength: cfg.maxBodyLength });
    if (!parsed.ok) {
      if (parsed.reason === '未找到任务标记') {
        results.push({ status: 'ignored', commentId, reason: 'no-marker' });
        continue;
      }
      await state.reject({ commentId, source, reason: parsed.reason });
      log(`✗ 拒绝评论 ${commentId}：${parsed.reason}`);
      results.push({ status: 'rejected', commentId, reason: parsed.reason });
      continue;
    }

    const task = parsed.task;
    const issuePr = pullNumberFromComment(comment);
    if (issuePr != null && issuePr !== task.prNumber) {
      await state.reject({ commentId, source, reason: `评论所在 PR #${issuePr} 与 pr_number=${task.prNumber} 不一致` });
      log(`✗ 拒绝评论 ${commentId}：PR 编号不一致`);
      results.push({ status: 'rejected', commentId, reason: 'pr-mismatch' });
      continue;
    }

    let pr;
    try {
      pr = await resolvePr(task.prNumber);
    } catch (err) {
      await state.recordError({ stage: 'resolve-pr', commentId, prNumber: task.prNumber, error: String(err) });
      log(`⚠ 读取 PR #${task.prNumber} 失败，本轮跳过（下轮重试）：${err.message}`);
      results.push({ status: 'error', commentId, reason: 'resolve-pr-failed' });
      continue;
    }

    const check = validateTask(task, {
      repo: cfg.repo,
      allowedPrs: cfg.allowedPrs,
      prHeadSha: pr.headSha,
      prState: pr.state,
      maxAttempts: cfg.maxAttempts
    });
    if (!check.ok) {
      await state.reject({ commentId, source, prNumber: task.prNumber, headSha: task.expectedHeadSha, reason: check.reason });
      log(`✗ 拒绝任务 ${task.reviewId}：${check.reason}`);
      results.push({ status: 'rejected', commentId, reason: check.reason });
      continue;
    }

    if (state.hasAcceptedSha(task.prNumber, task.expectedHeadSha)) {
      const reason = `PR #${task.prNumber} 的 ${task.expectedHeadSha.slice(0, 7)} 已排过任务`;
      await state.reject({ commentId, source, prNumber: task.prNumber, headSha: task.expectedHeadSha, reason });
      log(`✗ 拒绝任务 ${task.reviewId}：${reason}`);
      results.push({ status: 'rejected', commentId, reason: 'duplicate-sha' });
      continue;
    }

    if (state.attemptsFor(task.reviewId) >= cfg.maxAttempts) {
      const reason = `review_id ${task.reviewId} 已达最大尝试次数 ${cfg.maxAttempts}`;
      await state.reject({ commentId, source, prNumber: task.prNumber, headSha: task.expectedHeadSha, reason });
      log(`✗ 拒绝任务 ${task.reviewId}：${reason}`);
      results.push({ status: 'rejected', commentId, reason: 'attempts-exhausted' });
      continue;
    }

    const record = await state.accept({ commentId, task, source });
    log(`✓ 收到任务 ${task.reviewId} / PR #${task.prNumber} / SHA ${task.expectedHeadSha.slice(0, 7)} / attempt ${task.attempt}（仅记录，未执行）`);
    results.push({ status: 'accepted', commentId, task: record });
    } catch (err) {
      // 单条评论处理失败不应该拖垮整轮：记错误、跳过、下轮重试
      await state.recordError({ stage: 'process-comment', commentId, error: String(err) }).catch(() => {});
      log(`⚠ 处理评论 ${commentId} 失败，已跳过：${err.message}`);
      results.push({ status: 'error', commentId, reason: String(err.message || err) });
    }
  }

  return { skipped: false, results };
}

async function loadFixture(dir) {
  const raw = await readFile(dir, 'utf8');
  const data = JSON.parse(raw);
  if (Array.isArray(data)) return { comments: data, pulls: {} };
  return { comments: data.comments || [], pulls: data.pulls || {} };
}

function parseArgs(argv) {
  const out = { once: false, api: false, fixture: '', state: '', pause: false, resume: false, repair: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--api') out.api = true;
    else if (a === '--pause') out.pause = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--repair') out.repair = true;
    else if (a === '--fixture') out.fixture = argv[++i] || '';
    else if (a === '--state') out.state = argv[++i] || '';
  }
  return out;
}

/** 把 ISO 时间往前挪若干秒，用于水位重叠窗口 */
export function shiftBack(iso, seconds) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t - seconds * 1000).toISOString();
}

/** 依据水位决定本轮 since；首次运行从 bootstrapDays 天前开始，避免拉整库历史 */
export function resolveSince(watermark, bootstrapDays, now = Date.now()) {
  if (watermark && watermark.since) return watermark.since;
  return new Date(now - bootstrapDays * 24 * 60 * 60 * 1000).toISOString();
}

/** 按 Link 分页把所有页拉全，最多 maxPages 页 */
export async function fetchAllComments(client, { since, perPage = 100, maxPages = 50 }) {
  const all = [];
  let next = 1;
  let pages = 0;
  while (next && pages < maxPages) {
    const res = await client.listIssueComments({ since, page: next, perPage });
    all.push(...res.comments);
    next = res.nextPage;
    pages += 1;
  }
  return all;
}

const stamp = () => new Date().toISOString();
const log = (msg) => process.stdout.write(`[${stamp()}] ${msg}\n`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (args.state) cfg.stateDir = args.state;

  const errors = validateConfig(cfg, { requireToken: args.api });
  if (errors.length) {
    for (const e of errors) log('✗ 配置错误：' + e);
    process.exitCode = 2;
    return;
  }

  const state = await new BridgeState(cfg.stateDir).init();

  if (args.repair) {
    const res = await state.repair();
    log(res.backedUp
      ? `✓ 已从持久日志重建状态；损坏文件已备份为 ${res.backedUp}`
      : '✓ 状态已从持久日志重建');
    return;
  }

  if (state.blocked) {
    log('✗ 状态文件损坏，已 fail-closed 暂停接收：' + state.blocked.reason);
    log('  修复方式：node receiver.mjs --repair（先备份损坏文件，再从 inbox/rejected 重建）');
    process.exitCode = 3;
    return;
  }

  if (args.pause) { await state.setPaused(true, 'manual'); log('⏸ 已暂停'); return; }
  if (args.resume) { await state.setPaused(false, ''); log('▶ 已恢复'); return; }

  log('──────────────────────────────────────────────');
  log('DSH 事件接收器 · dry-run 模式');
  log('本进程只记录任务，不调用 dsh、不修改任何代码或 PR。');
  log(`仓库白名单：${cfg.repo}｜作者白名单：${cfg.allowedActors.join(', ')}｜状态目录：${cfg.stateDir}`);
  log('──────────────────────────────────────────────');

  if (args.fixture) {
    const fixture = await loadFixture(path.resolve(args.fixture));
    const resolvePr = async (n) => {
      const pr = fixture.pulls[String(n)];
      if (!pr) throw new Error(`fixture 中没有 PR #${n}`);
      return pr;
    };
    const outcome = await runOnce({ comments: fixture.comments, state, cfg, resolvePr, source: 'fixture', log });
    log(`本轮结束：${outcome.results.length} 条评论，状态 ` + JSON.stringify(outcome.results.map((r) => r.status)));
    return;
  }

  const client = createGitHubClient({ token: cfg.token, repo: cfg.repo, timeoutMs: cfg.requestTimeoutMs });
  const resolvePr = (n) => client.getPull(n);

  const tick = async () => {
    try {
      const watermark = state.getWatermark();
      const since = resolveSince(watermark, cfg.bootstrapDays);
      const comments = await fetchAllComments(client, { since, maxPages: cfg.maxPages });
      if (!comments.length) { log('· 无新评论'); return; }

      const outcome = await runOnce({ comments, state, cfg, resolvePr, source: 'api', log });
      if (outcome.skipped) return;

      // 只有本轮正常处理完才推进水位；用重叠窗口吸收时钟偏差与同秒边界，重复部分由 id 去重兜底
      let maxStamp = '';
      let maxId = 0;
      for (const c of comments) {
        const stamp = c.updated_at || c.created_at || '';
        if (stamp && stamp > maxStamp) maxStamp = stamp;
        const id = Number(c.id) || 0;
        if (id > maxId) maxId = id;
      }
      if (maxStamp) {
        await state.advanceWatermark({ since: shiftBack(maxStamp, cfg.overlapSeconds), lastCommentId: maxId });
      }
      log(`本轮结束：${comments.length} 条评论（水位推进至 ${maxStamp || '未变'}）`);
    } catch (err) {
      await state.recordError({ stage: 'poll', error: String(err) });
      log(`⚠ 拉取失败，${Math.round(cfg.pollIntervalMs / 1000)}s 后重试：${err.message}`);
    }
  };

  await tick();
  if (args.once) return;

  // 常驻轮询：单线程串行，避免重入导致重复处理
  let running = true;
  process.on('SIGINT', () => { running = false; log('收到 SIGINT，退出'); });
  process.on('SIGTERM', () => { running = false; });
  while (running) {
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
    if (!running) break;
    await tick();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log('✗ 接收器异常退出：' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}
