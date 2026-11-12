/**
 * 持久化状态：去重、重试计数、暂停开关、收件箱、水位。
 *
 * 可靠性约定（对应审查意见 2 与 3）：
 *
 * 1. **收件箱是唯一事实来源**。accept() 先以 fsync 追加 inbox.jsonl，再更新 state.json；
 *    即使随后崩溃或写状态失败，重启时也能从 inbox 重建"已处理"集合，任务不会丢。
 * 2. **状态可重建**。init() 每次都会把 inbox.jsonl / rejected.jsonl 里的记录合并进内存，
 *    因此 state.json 只是缓存，不是唯一真相。
 * 3. **损坏即 fail-closed**。state.json 解析失败时不覆盖、不清空，进入 blocked 状态并暂停接收，
 *    必须人工执行 --repair 才能恢复（修复时会先备份损坏文件）。
 */
import { mkdir, readFile, writeFile, rename, access, unlink, open, copyFile } from 'node:fs/promises';
import path from 'node:path';

function emptyState() {
  return {
    version: 2,
    paused: false,
    pausedReason: '',
    seenComments: {},
    acceptedSha: {},
    attempts: {},
    watermark: { since: '', lastCommentId: 0 },
    updatedAt: null
  };
}

async function appendDurable(file, record) {
  const fh = await open(file, 'a');
  try {
    await fh.write(JSON.stringify(record) + '\n', null, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function readJsonLines(file) {
  let raw = '';
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // 半行（进程在写入中途被杀）直接跳过，不阻塞重建
    }
  }
  return out;
}

export class BridgeState {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.inboxFile = path.join(dir, 'inbox.jsonl');
    this.rejectedFile = path.join(dir, 'rejected.jsonl');
    this.errorFile = path.join(dir, 'errors.jsonl');
    this.pauseFile = path.join(dir, 'PAUSED');
    this.state = emptyState();
    this.blocked = null;   // { reason } — 非空表示拒绝接收，直到人工修复
  }

  async init() {
    await mkdir(this.dir, { recursive: true });

    let loaded = false;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('state.json 顶层不是对象');
      this.state = { ...emptyState(), ...parsed };
      this.state.watermark = { ...emptyState().watermark, ...parsed.watermark };
      loaded = true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        loaded = true;                       // 首次运行：空状态是合法的
      } else {
        // fail-closed：保留损坏文件，禁止继续接收
        this.blocked = { reason: `state.json 损坏：${err.message}` };
        await appendDurable(this.errorFile, {
          at: new Date().toISOString(),
          stage: 'load-state',
          error: String(err),
          action: 'blocked-until-repair'
        });
      }
    }

    if (loaded) await this.#rebuildFromLogs();
    return this;
  }

  /**
   * 用持久日志（inbox/rejected）补全去重集合，使 state.json 可被安全重建。
   * attempts / acceptedSha **每次从日志独立重算**（先清空再统计），
   * 保证重启任意次都不会把计数叠加，是幂等操作。
   */
  async #rebuildFromLogs() {
    const [inbox, rejected] = await Promise.all([readJsonLines(this.inboxFile), readJsonLines(this.rejectedFile)]);

    for (const rec of [...inbox, ...rejected]) {
      if (rec && rec.commentId != null) {
        this.state.seenComments[String(rec.commentId)] = rec.at || new Date().toISOString();
      }
    }

    const attempts = {};
    const acceptedSha = {};
    for (const rec of inbox) {
      if (!rec) continue;
      if (rec.reviewId) attempts[rec.reviewId] = (attempts[rec.reviewId] || 0) + 1;
      if (rec.headSha && rec.prNumber) {
        acceptedSha[`${rec.prNumber}:${rec.headSha}`] = rec.at || new Date().toISOString();
      }
    }
    this.state.attempts = attempts;
    this.state.acceptedSha = acceptedSha;
  }

  async #save() {
    // 损坏状态下不写 state.json，避免覆盖证据
    if (this.blocked) return;

    const next = { ...this.state, updatedAt: new Date().toISOString() };
    const json = JSON.stringify(next, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, json, 'utf8');

    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rename(tmp, this.file);
        this.state = next;
        return;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }

    await writeFile(this.file, json, 'utf8');
    await unlink(tmp).catch(() => {});
    this.state = next;
    await appendDurable(this.errorFile, {
      at: new Date().toISOString(),
      stage: 'save-state',
      error: String(lastError),
      fallback: 'direct-write'
    });
  }

  async isPaused() {
    if (this.blocked) return { paused: true, reason: this.blocked.reason, blocked: true };
    if (this.state.paused) return { paused: true, reason: this.state.pausedReason || 'state.paused=true' };
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
    await this.#save();
  }

  getWatermark() {
    return { ...this.state.watermark };
  }

  async advanceWatermark({ since, lastCommentId }) {
    const next = { ...(this.state.watermark || { since: '', lastCommentId: 0 }) };
    if (since && since > (next.since || '')) next.since = since;
    if (lastCommentId && lastCommentId > (next.lastCommentId || 0)) next.lastCommentId = lastCommentId;
    this.state.watermark = next;
    await this.#save();
  }

  hasSeenComment(commentId) {
    return Boolean(this.state.seenComments[String(commentId)]);
  }

  hasAcceptedSha(prNumber, sha) {
    return Boolean(this.state.acceptedSha[`${prNumber}:${sha}`]);
  }

  attemptsFor(reviewId) {
    return this.state.attempts[reviewId] || 0;
  }

  /**
   * 接收：**先写收件箱（fsync）再更新状态**。
   * 收件箱写失败时直接抛错，评论保持"未处理"，下轮重试。
   */
  async accept({ commentId, task, source }) {
    const now = new Date().toISOString();
    const record = {
      at: now,
      status: 'accepted',
      source,
      commentId,
      repo: task.repo,
      prNumber: task.prNumber,
      headSha: task.expectedHeadSha,
      reviewId: task.reviewId,
      attempt: task.attempt,
      detailLength: task.detail.length
    };

    await appendDurable(this.inboxFile, record);     // 1) 事实来源先落盘

    this.state.seenComments[String(commentId)] = now;
    this.state.acceptedSha[`${task.prNumber}:${task.expectedHeadSha}`] = now;
    this.state.attempts[task.reviewId] = this.attemptsFor(task.reviewId) + 1;
    await this.#save();                               // 2) 再更新缓存；失败也不丢单

    return record;
  }

  async reject({ commentId, reason, source, prNumber = null, headSha = '' }) {
    const now = new Date().toISOString();
    const record = { at: now, status: 'rejected', source, commentId, prNumber, headSha, reason };
    await appendDurable(this.rejectedFile, record);
    if (commentId != null) this.state.seenComments[String(commentId)] = now;
    await this.#save();
    return record;
  }

  async recordError(record) {
    await appendDurable(this.errorFile, { at: new Date().toISOString(), ...record });
  }

  /** 人工修复：备份损坏文件，从持久日志重建 state.json */
  async repair() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let backedUp = '';
    try {
      await access(this.file);
      backedUp = path.join(this.dir, `state.corrupt.${stamp}.json`);
      await copyFile(this.file, backedUp);
      await unlink(this.file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    this.blocked = null;
    this.state = emptyState();
    await this.#rebuildFromLogs();
    await this.#save();
    return { backedUp };
  }

  snapshot() {
    return {
      blocked: this.blocked,
      paused: this.state.paused,
      seenComments: Object.keys(this.state.seenComments).length,
      acceptedSha: Object.keys(this.state.acceptedSha).length,
      attempts: { ...this.state.attempts },
      watermark: { ...this.state.watermark }
    };
  }
}
