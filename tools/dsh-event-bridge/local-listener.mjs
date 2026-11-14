#!/usr/bin/env node
/**
 * 本地 DSH 任务监听器（只读阶段）
 *
 * 用途：监听 GitHub Issue #21 的新评论，把 ChatGPT 下发的 [LOCAL-DSH-TASK] 任务
 * 记录到本地队列，供后续受控执行。**当前版本不执行任何代码**。
 *
 * 与旧接收器（receiver.mjs）的区别：
 * - receiver 面向旧 PR 的 [DSH-REVIEW-TASK]（PR 评论、二次校验、worktree 执行）
 * - 本监听器只面向 Issue #21 的顶层评论，规则独立，不复用旧的放宽逻辑
 *
 * 规则：
 * 1. 仓库固定 RobateV/algorithm-visualizer
 * 2. 只监听 Issue #21
 * 3. 只接受 RobateV 发布的评论
 * 4. 任务必须以 [LOCAL-DSH-TASK] 开头；[LOCAL-DSH-PING] 仅用于连通性验证
 * 5. 必填 task_id / branch / expected_sha / allow / accept
 * 6. 每次轮询重新读取评论，校验 review 未被编辑
 * 7. 按 task_id + comment_id 去重
 * 8. 状态持久化，重启不重复处理
 * 9. 支持 --pause / --resume / --status
 * 10. 单进程锁，任务串行
 * 11. 无任务时只做一次 HTTP 请求，不调用任何模型
 */
import { readFile, writeFile, mkdir, rename, rm, access, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const run = promisify(execFile);

export const REPO = 'RobateV/algorithm-visualizer';
export const ISSUE_NUMBER = 21;
export const TASK_MARKER = '[LOCAL-DSH-TASK]';
export const PING_MARKER = '[LOCAL-DSH-PING]';
export const TRUSTED_AUTHOR = 'RobateV';
export const DEFAULT_INTERVAL_S = 20;
export const MAX_BRANCH_LEN = 80;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_DIR = path.join(HERE, '.local-state');

/* ------------------------------------------------------------------ 配置 */

export function loadConfig(env = process.env, argv = []) {
  const cfg = {
    repo: REPO,
    issue: ISSUE_NUMBER,
    intervalSec: DEFAULT_INTERVAL_S,
    stateDir: env.DSH_LOCAL_STATE_DIR || DEFAULT_STATE_DIR,
    token: env.DSH_BRIDGE_TOKEN || env.GH_TOKEN || '',
    once: false,
    statusOnly: false,
    pause: false,
    resume: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') cfg.once = true;
    else if (a === '--status') cfg.statusOnly = true;
    else if (a === '--pause') cfg.pause = true;
    else if (a === '--resume') cfg.resume = true;
    else if (a === '--interval') cfg.intervalSec = Number.parseInt(argv[++i] || '', 10) || DEFAULT_INTERVAL_S;
    else if (a === '--state') cfg.stateDir = argv[++i] || cfg.stateDir;
  }
  if (cfg.intervalSec < 5) cfg.intervalSec = 5;
  return cfg;
}

async function resolveToken(cfg) {
  if (cfg.token) return cfg.token;
  try {
    const { stdout } = await run('gh', ['auth', 'token'], { windowsHide: true });
    return String(stdout).trim();
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ 状态 */

export function emptyState() {
  return {
    version: 1,
    paused: false,
    pausedReason: '',
    lastPollAt: '',
    lastError: '',
    seenComments: {},
    tasks: {},
    pings: []
  };
}

export class ListenerState {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'listener-state.json');
    this.logFile = path.join(dir, 'listener.log');
    this.pauseFile = path.join(dir, 'PAUSED');
    this.lockFile = path.join(dir, 'listener.lock');
    this.state = emptyState();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = { ...emptyState(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`状态文件损坏：${err.message}`);
    }
    return this;
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    const text = JSON.stringify(this.state, null, 2);
    await writeFile(tmp, text, 'utf8');
    try {
      await rename(tmp, this.file);
    } catch {
      await writeFile(this.file, text, 'utf8');
      await rm(tmp, { force: true });
    }
  }

  async log(line) {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    await appendFile(this.logFile, text, 'utf8').catch(() => {});
    process.stdout.write(text);
  }

  async isPaused() {
    if (this.state.paused) return { paused: true, reason: this.state.pausedReason || 'state.paused' };
    try {
      await access(this.pauseFile);
      return { paused: true, reason: 'PAUSED 文件存在' };
    } catch {
      return { paused: false, reason: '' };
    }
  }

  async setPaused(paused, reason = '') {
    this.state.paused = Boolean(paused);
    this.state.pausedReason = reason;
    await this.save();
    if (paused) await writeFile(this.pauseFile, reason || 'paused', 'utf8').catch(() => {});
    else await rm(this.pauseFile, { force: true }).catch(() => {});
  }

  hasSeen(commentId) {
    return Boolean(this.state.seenComments[String(commentId)]);
  }

  markSeen(commentId, info) {
    this.state.seenComments[String(commentId)] = {
      at: new Date().toISOString(),
      ...info
    };
  }

  taskById(taskId) {
    return this.state.tasks[taskId] || null;
  }
}

/* ------------------------------------------------------------------ 锁 */

/** 判断 PID 是否存活；无法确认时返回 null（调用方必须 fail-closed） */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;    // 进程存在，但无权限探测
    if (err.code === 'ESRCH') return false;   // 进程不存在
    return null;                              // 其它情况无法确认
  }
}

/**
 * 获取单实例锁。
 * - 已有**存活**进程持锁 → 拒绝启动
 * - 能确认持锁进程**已退出** → 安全接管一次
 * - 锁内容损坏 / PID 无法确认 / 接管时竞争 → fail-closed
 * 不按文件年龄删除锁。
 */
export async function acquireLock(state, { isAlive = pidAlive } = {}) {
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });

  try {
    await writeFile(state.lockFile, payload, { flag: 'wx' });
    return { ok: true, recovered: false };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  let info = null;
  try {
    info = JSON.parse(await readFile(state.lockFile, 'utf8'));
  } catch {
    return { ok: false, reason: '锁文件内容损坏，需人工确认后删除（fail-closed）' };
  }

  const alive = isAlive(info && info.pid);
  if (alive === true) {
    return { ok: false, reason: `已有监听器实例在运行（pid ${info.pid}）` };
  }
  if (alive === null) {
    return { ok: false, reason: `无法确认锁持有进程状态（pid ${info && info.pid}），保持 fail-closed 并需人工处理` };
  }

  // 确认进程已退出：安全接管
  await rm(state.lockFile, { force: true });
  try {
    await writeFile(state.lockFile, payload, { flag: 'wx' });
    return { ok: true, recovered: true, previousPid: info.pid };
  } catch {
    return { ok: false, reason: '锁接管过程中发生竞争，需人工确认（fail-closed）' };
  }
}

export async function releaseLock(state) {
  await rm(state.lockFile, { force: true }).catch(() => {});
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 解析评论正文。
 * 返回 { kind: 'ping' | 'task' | 'ignore', reason?, task? }
 */
export function parseComment(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const firstLine = (text.split('\n')[0] || '').trim();
  if (firstLine.startsWith(PING_MARKER)) return { kind: 'ping' };
  if (!firstLine.startsWith(TASK_MARKER)) {
    return { kind: 'ignore', reason: '缺少 [LOCAL-DSH-TASK] 标记' };
  }

  const head = text.slice(firstLine.length).split(/\n---\n/)[0];
  const fields = {};
  for (const line of head.split('\n')) {
    const m = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (m) {
      const value = m[2].trim();
      if (value) fields[m[1].toLowerCase()] = value;
    }
  }

  const problems = [];
  const taskId = fields.task_id || '';
  const branch = fields.branch || '';
  const expectedSha = (fields.expected_sha || '').toLowerCase();
  const allow = (fields.allow || '').split(',').map((s) => s.trim()).filter(Boolean);
  const accept = fields.accept || '';

  if (!/^[A-Za-z0-9._-]{1,64}$/.test(taskId)) problems.push('task_id 缺失或格式非法');
  if (!branch) problems.push('缺少 branch');
  else if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.length > MAX_BRANCH_LEN ||
           branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) problems.push('branch 含非法字符');
  else if (['main', 'master'].includes(branch) || branch.startsWith('main/')) problems.push('不允许以 main 为目标分支');
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) problems.push('expected_sha 必须为 40 位十六进制');
  if (allow.length === 0) problems.push('缺少 allow 修改范围');
  if (allow.some((p) => p.startsWith('/') || p.includes('..'))) problems.push('allow 路径必须是仓库内相对路径');
  if (!accept) problems.push('缺少 accept 验收标准');

  if (problems.length) return { kind: 'invalid', reason: problems.join('；') };

  const detail = text.split(/\n---\n/).slice(1).join('\n---\n').trim();
  return {
    kind: 'task',
    task: {
      taskId,
      branch,
      expectedSha,
      allow,
      accept,
      detail,
      digest: null
    }
  };
}

/* ------------------------------------------------------------------ GitHub */

export const MAX_COMMENT_PAGES = 50;

/** 从 Link 头中取出 rel="next" 的地址 */
export function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"next"/i);
    if (m) return m[1];
  }
  return null;
}

async function githubGet(url, { token, fetchImpl }) {
  const res = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'dsh-local-listener'
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/**
 * 拉取 Issue 的全部评论。
 * 跟随 Link: rel="next"；超过 maxPages 仍有下一页时**显式报错**，
 * 绝不把不完整快照当作完整结果返回。
 */
export async function listIssueComments({ repo, issue, token, fetchImpl = fetch, maxPages = MAX_COMMENT_PAGES }) {
  const out = [];
  const seen = new Set();
  let url = `https://api.github.com/repos/${repo}/issues/${issue}/comments?per_page=100&page=1`;
  let pages = 0;

  while (url) {
    if (pages >= maxPages) {
      throw new Error(`评论分页超过 ${maxPages} 页上限，本轮快照不完整，已停止处理（水位不推进）`);
    }
    const res = await githubGet(url, { token, fetchImpl });
    const list = await res.json();
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({
        id: c.id,
        body: c.body || '',
        author: c.user && c.user.login,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        url: c.html_url
      });
    }
    pages += 1;
    const link = res.headers && typeof res.headers.get === 'function' ? res.headers.get('link') : null;
    url = parseNextLink(link);
  }

  return out;
}

/**
 * 读取固定仓库中某分支的当前 HEAD SHA。
 * 分支名整体 URL 编码，不接受其它仓库或任意 URL。
 */
export async function getBranchHead({ repo, branch, token, fetchImpl = fetch }) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]{1,80}$/.test(branch) ||
      branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new Error('分支名非法');
  }
  const url = `https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`;
  const res = await githubGet(url, { token, fetchImpl });
  const data = await res.json();
  const sha = data && data.commit && data.commit.sha;
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) {
    throw new Error('分支 HEAD 返回格式异常');
  }
  return sha;
}

/* ------------------------------------------------------------------ 轮询 */

export async function pollOnce({ state, token, repo = REPO, issue = ISSUE_NUMBER, log, now = () => new Date(), fetchImpl = fetch }) {
  const comments = await listIssueComments({ repo, issue, token, fetchImpl });
  const summary = { scanned: comments.length, pings: 0, tasks: 0, invalid: 0, duplicates: 0, ignored: 0, deferred: 0 };

  for (const c of comments) {
    if (c.author !== TRUSTED_AUTHOR) { summary.ignored++; continue; }

    const parsed = parseComment(c.body);

    if (parsed.kind === 'ping') {
      if (state.hasSeen(c.id)) { summary.duplicates++; continue; }
      state.markSeen(c.id, { kind: 'ping' });
      state.state.pings.push({ commentId: c.id, at: now().toISOString(), author: c.author });
      summary.pings++;
      await log(`✓ 识别连通性测试 ${PING_MARKER}｜评论 ${c.id}｜作者 ${c.author}`);
      continue;
    }

    if (parsed.kind === 'ignore') { summary.ignored++; continue; }

    if (parsed.kind === 'invalid') {
      if (state.hasSeen(c.id)) { summary.duplicates++; continue; }
      state.markSeen(c.id, { kind: 'invalid', reason: parsed.reason });
      summary.invalid++;
      await log(`✗ 拒绝评论 ${c.id}：${parsed.reason}`);
      continue;
    }

    const task = parsed.task;
    const existing = state.taskById(task.taskId);
    if (existing) {
      summary.duplicates++;
      await log(`· 任务 ${task.taskId} 已存在（评论 ${existing.commentId}），跳过评论 ${c.id}`);
      continue;
    }
    if (state.hasSeen(c.id)) { summary.duplicates++; continue; }

    // 编辑校验：评论被编辑则不接收
    if (c.updatedAt && c.createdAt && c.updatedAt !== c.createdAt) {
      state.markSeen(c.id, { kind: 'edited' });
      summary.invalid++;
      await log(`✗ 拒绝评论 ${c.id}：评论已被编辑（created ${c.createdAt} / updated ${c.updatedAt}）`);
      continue;
    }

    // 入队前校验目标分支的远程 HEAD
    let remoteHead = '';
    try {
      remoteHead = await getBranchHead({ repo, branch: task.branch, token, fetchImpl });
    } catch (err) {
      if (err.status === 404) {
        state.markSeen(c.id, { kind: 'branch-missing', branch: task.branch });
        summary.invalid++;
        await log(`✗ 拒绝评论 ${c.id}：分支 ${task.branch} 不存在`);
        continue;
      }
      // 网络/API 异常：不入队、不标记已见，下一轮重试
      summary.deferred++;
      await log(`… 暂缓评论 ${c.id}：读取分支 HEAD 失败（${err.message}），本轮不入队，下轮重试`);
      continue;
    }

    if (remoteHead !== task.expectedSha) {
      state.markSeen(c.id, { kind: 'sha-mismatch', expected: task.expectedSha, actual: remoteHead });
      summary.invalid++;
      await log(`✗ 拒绝评论 ${c.id}：远程 HEAD ${remoteHead.slice(0, 7)} ≠ expected ${task.expectedSha.slice(0, 7)}`);
      continue;
    }

    state.state.tasks[task.taskId] = {
      taskId: task.taskId,
      commentId: c.id,
      branch: task.branch,
      expectedSha: task.expectedSha,
      headAtEnqueue: remoteHead,
      allow: task.allow,
      accept: task.accept,
      detail: task.detail,
      status: 'pending',
      receivedAt: now().toISOString(),
      executedAt: null
    };
    state.markSeen(c.id, { kind: 'task', taskId: task.taskId });
    summary.tasks++;
    await log(`✓ 接收任务 ${task.taskId}｜评论 ${c.id}｜分支 ${task.branch}｜SHA ${task.expectedSha.slice(0, 7)}（只记录，未执行）`);
  }

  state.state.lastPollAt = now().toISOString();
  state.state.lastError = '';
  await state.save();
  return summary;
}

/* ------------------------------------------------------------------ CLI */

async function main() {
  const cfg = loadConfig(process.env, process.argv.slice(2));
  const state = await new ListenerState(cfg.stateDir).init();

  if (cfg.pause) { await state.setPaused(true, 'manual'); console.log('⏸ 监听器已暂停'); return; }
  if (cfg.resume) { await state.setPaused(false, ''); console.log('▶ 监听器已恢复'); return; }

  if (cfg.statusOnly) {
    const paused = await state.isPaused();
    const tasks = Object.values(state.state.tasks);
    console.log(JSON.stringify({
      paused: paused.paused,
      pausedReason: paused.reason,
      lastPollAt: state.state.lastPollAt,
      commentsSeen: Object.keys(state.state.seenComments).length,
      pings: state.state.pings.length,
      tasks: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      taskList: tasks.map((t) => ({ id: t.taskId, status: t.status, commentId: t.commentId }))
    }, null, 2));
    return;
  }

  const token = await resolveToken(cfg);
  if (!token) {
    console.error('✗ 缺少 GitHub token：请设置 DSH_BRIDGE_TOKEN，或确保 gh 已登录');
    process.exitCode = 2;
    return;
  }

  if (cfg.once) {
    const paused = await state.isPaused();
    if (paused.paused) {
      await state.log(`单次轮询跳过：监听器处于暂停状态（${paused.reason}）`);
      return;
    }
    await state.log(`单次轮询：${cfg.repo} Issue #${cfg.issue}`);
    try {
      const s = await pollOnce({ state, token, repo: cfg.repo, issue: cfg.issue, log: state.log.bind(state) });
      await state.log(`本轮结束 ${JSON.stringify(s)}`);
    } catch (err) {
      state.state.lastError = String(err.message);
      await state.save();
      await state.log(`✗ 轮询失败：${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const lock = await acquireLock(state);
  if (!lock.ok) {
    console.error('✗ ' + lock.reason);
    process.exitCode = 3;
    return;
  }
  if (lock.recovered) {
    await state.log(`检测到已退出进程（pid ${lock.previousPid}）留下的陈旧锁，已安全接管`);
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await releaseLock(state);
    await state.log('监听器已停止');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await state.log(`监听启动：${cfg.repo} Issue #${cfg.issue}，间隔 ${cfg.intervalSec}s（只读模式，不执行任务）`);

  while (!stopped) {
    const paused = await state.isPaused();
    if (paused.paused) {
      await new Promise((r) => setTimeout(r, cfg.intervalSec * 1000));
      continue;
    }
    try {
      const s = await pollOnce({ state, token, repo: cfg.repo, issue: cfg.issue, log: state.log.bind(state) });
      if (s.pings || s.tasks || s.invalid) {
        await state.log(`本轮 ${JSON.stringify(s)}`);
      }
    } catch (err) {
      state.state.lastError = String(err.message);
      await state.save();
      await state.log(`✗ 轮询失败：${err.message}`);
    }
    await new Promise((r) => setTimeout(r, cfg.intervalSec * 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error('✗ 监听器异常：' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}
