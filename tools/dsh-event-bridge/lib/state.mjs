/**
 * 持久化状态：去重、重试计数、暂停开关、收件箱。
 *
 * - 去重两个维度：评论 id（同一条评论只处理一次）与 PR+HEAD SHA（同一提交只排一次任务）
 * - 暂停：state.paused 或状态目录下的 PAUSED 文件任一存在即停止接收
 * - 状态文件先写临时文件再 rename；Windows 上 rename 可能因文件占用报 EPERM，
 *   重试若干次后降级为直接覆盖写，避免单次写盘失败打断整轮接收
 */
import { mkdir, readFile, writeFile, rename, appendFile, access, unlink } from 'node:fs/promises';
import path from 'node:path';

/** 每个实例都要拿到全新的嵌套对象，否则去重状态会在实例之间串味 */
function emptyState() {
  return {
    version: 1,
    paused: false,
    pausedReason: '',
    seenComments: {},
    acceptedSha: {},
    attempts: {},
    updatedAt: null
  };
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
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = { ...emptyState(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 坏状态文件不应让接收器直接崩溃：留档后从空状态重建
        await this.#appendRaw(this.errorFile, { at: new Date().toISOString(), stage: 'load-state', error: String(err) });
        this.state = emptyState();
      }
    }
    return this;
  }

  async #save() {
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

    // 兜底：直接覆盖写。宁可牺牲"原子性"，也不要丢掉去重记录。
    await writeFile(this.file, json, 'utf8');
    await unlink(tmp).catch(() => {});
    this.state = next;
    await this.#appendRaw(this.errorFile, {
      at: new Date().toISOString(),
      stage: 'save-state',
      error: String(lastError),
      fallback: 'direct-write'
    });
  }

  async #appendRaw(file, record) {
    await appendFile(file, JSON.stringify(record) + '\n', 'utf8');
  }

  async isPaused() {
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

  hasSeenComment(commentId) {
    return Boolean(this.state.seenComments[String(commentId)]);
  }

  hasAcceptedSha(prNumber, sha) {
    return Boolean(this.state.acceptedSha[`${prNumber}:${sha}`]);
  }

  attemptsFor(reviewId) {
    return this.state.attempts[reviewId] || 0;
  }

  /** 接收：同时登记评论 id 与 PR+SHA，并写入收件箱 */
  async accept({ commentId, task, source }) {
    const now = new Date().toISOString();
    this.state.seenComments[String(commentId)] = now;
    this.state.acceptedSha[`${task.prNumber}:${task.expectedHeadSha}`] = now;
    this.state.attempts[task.reviewId] = this.attemptsFor(task.reviewId) + 1;
    await this.#save();
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
    await this.#appendRaw(this.inboxFile, record);
    return record;
  }

  /** 拒绝：只登记评论 id，避免每轮重复报同一条错误 */
  async reject({ commentId, reason, source, prNumber = null, headSha = '' }) {
    if (commentId != null) this.state.seenComments[String(commentId)] = new Date().toISOString();
    await this.#save();
    const record = { at: new Date().toISOString(), status: 'rejected', source, commentId, prNumber, headSha, reason };
    await this.#appendRaw(this.rejectedFile, record);
    return record;
  }

  async recordError(record) {
    await this.#appendRaw(this.errorFile, { at: new Date().toISOString(), ...record });
  }

  snapshot() {
    return {
      paused: this.state.paused,
      seenComments: Object.keys(this.state.seenComments).length,
      acceptedSha: Object.keys(this.state.acceptedSha).length,
      attempts: { ...this.state.attempts }
    };
  }
}
