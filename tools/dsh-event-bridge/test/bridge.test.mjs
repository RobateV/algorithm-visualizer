import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseTaskBlock, validateTask, isAllowedAuthor } from '../lib/validate.mjs';
import { BridgeState } from '../lib/state.mjs';
import { parseNextPage } from '../lib/github.mjs';
import { runOnce, pullNumberFromComment, EXECUTES_CODE, fetchAllComments, resolveSince, shiftBack } from '../receiver.mjs';

const SHA = 'c7b172fea1bde714f758df1e875340a1681e7d4e';
const OLD_SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = 'RobateV/algorithm-visualizer';

const BASE = {
  repo: REPO,
  allowedActors: ['RobateV'],
  allowedPrs: [4],
  maxAttempts: 3,
  marker: '[DSH-REVIEW-TASK]',
  maxBodyLength: 20000
};

function makeComment(id, login, body, pr = 4) {
  return {
    id,
    user: { login },
    issue_url: `https://api.github.com/repos/${REPO}/issues/${pr}`,
    body
  };
}

function taskBody(overrides = {}) {
  const fields = {
    repo: REPO,
    pr_number: '4',
    expected_head_sha: SHA,
    review_id: 'work-test-001',
    attempt: '1',
    ...overrides
  };
  const header = Object.entries(fields)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `[DSH-REVIEW-TASK]\n${header}\n---\n## 问题\n测试用任务`;
}

async function freshState() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-'));
  return new BridgeState(dir).init();
}

const openPr = async (n) => (n === 4 ? { number: 4, state: 'open', headSha: SHA } : Promise.reject(new Error('no such PR')));

/* ---------------------------------------------------------------- 解析 */

test('解析合法任务块', () => {
  const r = parseTaskBlock(taskBody());
  assert.equal(r.ok, true);
  assert.equal(r.task.repo, REPO);
  assert.equal(r.task.prNumber, 4);
  assert.equal(r.task.expectedHeadSha, SHA);
  assert.equal(r.task.reviewId, 'work-test-001');
  assert.equal(r.task.attempt, 1);
  assert.match(r.task.detail, /测试用任务/);
});

test('缺少标记时返回未找到', () => {
  const r = parseTaskBlock('就是一条普通评论');
  assert.equal(r.ok, false);
  assert.equal(r.reason, '未找到任务标记');
});

test('超长评论被拒绝', () => {
  const r = parseTaskBlock('[DSH-REVIEW-TASK]\n' + 'x'.repeat(30000));
  assert.equal(r.ok, false);
  assert.match(r.reason, /上限/);
});

/* ---------------------------------------------------------------- 校验 */

test('仓库不匹配被拒绝', () => {
  const { task } = parseTaskBlock(taskBody({ repo: 'someone/else' }));
  const r = validateTask(task, { repo: REPO, allowedPrs: [4], maxAttempts: 3, prHeadSha: SHA, prState: 'open' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /仓库不匹配/);
});

test('SHA 过期被拒绝', () => {
  const { task } = parseTaskBlock(taskBody({ expected_head_sha: OLD_SHA }));
  const r = validateTask(task, { repo: REPO, allowedPrs: [4], maxAttempts: 3, prHeadSha: SHA, prState: 'open' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /已过期/);
});

test('attempt 越界被拒绝', () => {
  const { task } = parseTaskBlock(taskBody({ attempt: '9' }));
  const r = validateTask(task, { repo: REPO, allowedPrs: [4], maxAttempts: 3, prHeadSha: SHA, prState: 'open' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /attempt/);
});

test('PR 已关闭时拒绝', () => {
  const { task } = parseTaskBlock(taskBody());
  const r = validateTask(task, { repo: REPO, allowedPrs: [4], maxAttempts: 3, prHeadSha: SHA, prState: 'closed' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /closed/);
});

test('非白名单作者被识别', () => {
  assert.equal(isAllowedAuthor(makeComment(1, 'RobateV', ''), ['RobateV']), true);
  assert.equal(isAllowedAuthor(makeComment(2, 'hacker', ''), ['RobateV']), false);
});

test('从 issue_url 解析 PR 编号', () => {
  assert.equal(pullNumberFromComment({ issue_url: `https://api.github.com/repos/${REPO}/issues/4` }), 4);
  assert.equal(pullNumberFromComment({ issue_url: 'https://api.github.com/repos/x/y/issues/12' }), 12);
});

/* ---------------------------------------------------------------- 接收流程 */

test('第一轮：可信任务被接收，其余被拒或忽略', async () => {
  const state = await freshState();
  const comments = [
    makeComment(9101, 'RobateV', taskBody()),
    makeComment(9102, 'random-contributor', taskBody({ review_id: 'work-test-002' })),
    makeComment(9103, 'RobateV', taskBody({ expected_head_sha: OLD_SHA, review_id: 'work-test-003' })),
    makeComment(9104, 'RobateV', '普通评论，没有任务标记'),
    makeComment(9105, 'RobateV', taskBody({ review_id: null }))
  ];
  const out = await runOnce({ comments, state, cfg: BASE, resolvePr: openPr });
  const statuses = out.results.map((r) => r.status);
  assert.deepEqual(statuses, ['accepted', 'rejected', 'rejected', 'ignored', 'rejected']);
  assert.equal(state.hasSeenComment(9101), true);
  assert.equal(state.hasAcceptedSha(4, SHA), true);
  assert.equal(EXECUTES_CODE, false);
});

test('第二轮：同一条评论不会重复接收（去重）', async () => {
  const state = await freshState();
  const comments = [makeComment(9101, 'RobateV', taskBody())];
  await runOnce({ comments, state, cfg: BASE, resolvePr: openPr });
  const second = await runOnce({ comments, state, cfg: BASE, resolvePr: openPr });
  assert.equal(second.results[0].status, 'duplicate-comment');

  const inbox = (await readFile(path.join(state.dir, 'inbox.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(inbox.length, 1, '收件箱只应有一条记录');
});

test('同一 PR 同一 SHA 的第二条任务被拒（SHA 去重）', async () => {
  const state = await freshState();
  await runOnce({ comments: [makeComment(9101, 'RobateV', taskBody())], state, cfg: BASE, resolvePr: openPr });
  const second = await runOnce({
    comments: [makeComment(9201, 'RobateV', taskBody({ review_id: 'work-test-009' }))],
    state,
    cfg: BASE,
    resolvePr: openPr
  });
  assert.equal(second.results[0].status, 'rejected');
  assert.equal(second.results[0].reason, 'duplicate-sha');
});

test('暂停后不接收任何任务', async () => {
  const state = await freshState();
  await state.setPaused(true, 'test');
  const out = await runOnce({ comments: [makeComment(9101, 'RobateV', taskBody())], state, cfg: BASE, resolvePr: openPr });
  assert.equal(out.skipped, true);
  assert.equal(state.hasSeenComment(9101), false);
});

test('PAUSED 文件同样生效', async () => {
  const { writeFile } = await import('node:fs/promises');
  const state = await freshState();
  await writeFile(path.join(state.dir, 'PAUSED'), 'stop', 'utf8');
  const pause = await state.isPaused();
  assert.equal(pause.paused, true);
  assert.match(pause.reason, /PAUSED/);
});

test('同一 review_id 达到最大尝试次数后被拒', async () => {
  const state = await freshState();
  // 手工把同一 review_id 的尝试次数顶到上限
  for (let i = 0; i < 3; i++) {
    const c = makeComment(9300 + i, 'RobateV', taskBody({ expected_head_sha: (i.toString(16).padStart(2, '0')).repeat(20) }));
    await runOnce({ comments: [c], state, cfg: BASE, resolvePr: async () => ({ state: 'open', headSha: (i.toString(16).padStart(2, '0')).repeat(20) }) });
  }
  const next = makeComment(9400, 'RobateV', taskBody({ expected_head_sha: 'ff'.repeat(20) }));
  const out = await runOnce({ comments: [next], state, cfg: BASE, resolvePr: async () => ({ state: 'open', headSha: 'ff'.repeat(20) }) });
  assert.equal(out.results[0].status, 'rejected');
  assert.equal(out.results[0].reason, 'attempts-exhausted');
});

test('读取 PR 失败时记录错误且不标记已处理（可重试）', async () => {
  const state = await freshState();
  const failing = async () => { throw new Error('network down'); };
  const out = await runOnce({ comments: [makeComment(9101, 'RobateV', taskBody())], state, cfg: BASE, resolvePr: failing });
  assert.equal(out.results[0].status, 'error');
  assert.equal(state.hasSeenComment(9101), false);
  const errors = (await readFile(path.join(state.dir, 'errors.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /resolve-pr/);
});

test('PR 编号与评论所在 PR 不一致时被拒', async () => {
  const state = await freshState();
  const comment = makeComment(9101, 'RobateV', taskBody({ pr_number: '5' }), 7);
  const out = await runOnce({ comments: [comment], state, cfg: BASE, resolvePr: openPr });
  assert.equal(out.results[0].status, 'rejected');
  assert.equal(out.results[0].reason, 'pr-mismatch');
});

/* ============================================================ 分页与水位 */

test('解析 Link 头中的 next 页码', () => {
  const link = '<https://api.github.com/repositories/1/issues/comments?page=2>; rel="next", <https://api.github.com/repositories/1/issues/comments?page=9>; rel="last"';
  assert.equal(parseNextPage(link), 2);
  assert.equal(parseNextPage('<https://api.github.com/x?page=2>; rel="last"'), null);
  assert.equal(parseNextPage(''), null);
});

test('101 条评论会翻页取全，不漏任务', async () => {
  const calls = [];
  const fake = {
    async listIssueComments({ page }) {
      calls.push(page);
      if (page === 1) return { comments: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), nextPage: 2 };
      if (page === 2) return { comments: [{ id: 101 }], nextPage: null };
      return { comments: [], nextPage: null };
    }
  };
  const all = await fetchAllComments(fake, { since: '2026-01-01T00:00:00Z' });
  assert.equal(all.length, 101);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(all[100].id, 101);
});

test('分页有上限，避免异常 Link 导致无限循环', async () => {
  const calls = [];
  const fake = {
    async listIssueComments({ page }) {
      calls.push(page);
      return { comments: [{ id: page }], nextPage: page + 1 };
    }
  };
  await fetchAllComments(fake, { since: '2026-01-01T00:00:00Z', maxPages: 3 });
  assert.deepEqual(calls, [1, 2, 3]);
});

test('首次运行从 bootstrap 窗口开始，之后以水位为准', () => {
  const now = Date.parse('2026-11-12T00:00:00.000Z');
  const first = resolveSince({ since: '', lastCommentId: 0 }, 7, now);
  assert.equal(first, '2026-11-05T00:00:00.000Z');

  const saved = '2026-11-11T23:00:00.000Z';
  assert.equal(resolveSince({ since: saved, lastCommentId: 5 }, 7, now), saved);
});

test('水位回退重叠窗口，吸收时钟偏差与同秒边界', () => {
  assert.equal(shiftBack('2026-11-12T00:00:00.000Z', 60), '2026-11-11T23:59:00.000Z');
  assert.equal(shiftBack('not-a-date', 60), 'not-a-date');
});

test('水位持久化：重启后从上次位置继续', async () => {
  const state = await freshState();
  await state.advanceWatermark({ since: '2026-11-11T22:00:00.000Z', lastCommentId: 9101 });

  const reopened = await new BridgeState(state.dir).init();
  const wm = reopened.getWatermark();
  assert.equal(wm.since, '2026-11-11T22:00:00.000Z');
  assert.equal(wm.lastCommentId, 9101);
});

test('水位只前进不后退', async () => {
  const state = await freshState();
  await state.advanceWatermark({ since: '2026-11-11T23:00:00.000Z', lastCommentId: 100 });
  await state.advanceWatermark({ since: '2026-11-11T22:00:00.000Z', lastCommentId: 50 });
  const wm = state.getWatermark();
  assert.equal(wm.since, '2026-11-11T23:00:00.000Z');
  assert.equal(wm.lastCommentId, 100);
});

/* ============================================================ 写入顺序与恢复 */

test('收件箱已落盘但状态丢失时，重启不会重复接单', async () => {
  const state = await freshState();
  await runOnce({ comments: [makeComment(9101, 'RobateV', taskBody())], state, cfg: BASE, resolvePr: openPr });
  assert.equal(state.hasSeenComment(9101), true);

  // 模拟"收件箱写成功、state.json 丢失/未写成功"
  const { unlink } = await import('node:fs/promises');
  await unlink(path.join(state.dir, 'state.json'));

  const reopened = await new BridgeState(state.dir).init();
  assert.equal(reopened.hasSeenComment(9101), true, '应从 inbox 重建出已处理记录');
  assert.equal(reopened.hasAcceptedSha(4, SHA), true);

  const out = await runOnce({ comments: [makeComment(9101, 'RobateV', taskBody())], state: reopened, cfg: BASE, resolvePr: openPr });
  assert.equal(out.results[0].status, 'duplicate-comment');
});

test('收件箱写入失败时不得标记为已处理（可重试）', async () => {
  const state = await freshState();
  const { mkdir } = await import('node:fs/promises');
  // 用同名目录让 appendFile 必然失败
  await mkdir(path.join(state.dir, 'inbox.jsonl'));

  const out = await runOnce({ comments: [makeComment(9101, 'RobateV', taskBody())], state, cfg: BASE, resolvePr: openPr });
  assert.equal(out.results[0].status, 'error');
  assert.equal(state.hasSeenComment(9101), false, '写盘失败不能标记已处理');
});

/* ============================================================ 损坏与修复 */

test('状态文件损坏时 fail-closed 暂停，不静默清空', async () => {
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-'));
  await writeFile(path.join(dir, 'state.json'), '{ 这不是合法 JSON', 'utf8');

  const state = await new BridgeState(dir).init();
  assert.ok(state.blocked, '应进入 blocked 状态');
  const pause = await state.isPaused();
  assert.equal(pause.paused, true);
  assert.equal(pause.blocked, true);

  const out = await runOnce({ comments: [makeComment(9101, 'RobateV', taskBody())], state, cfg: BASE, resolvePr: openPr });
  assert.equal(out.skipped, true);

  // 损坏文件必须原样保留，等待人工处理
  const raw = await readFile(path.join(dir, 'state.json'), 'utf8');
  assert.match(raw, /这不是合法 JSON/);
});

test('--repair 备份损坏文件并从持久日志重建', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-'));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), 'broken', 'utf8');
  await writeFile(
    path.join(dir, 'inbox.jsonl'),
    JSON.stringify({ at: '2026-11-11T00:00:00.000Z', status: 'accepted', commentId: 9101, prNumber: 4, headSha: SHA, reviewId: 'work-test-001' }) + '\n',
    'utf8'
  );

  const state = await new BridgeState(dir).init();
  assert.ok(state.blocked);

  const res = await state.repair();
  assert.ok(res.backedUp, '应返回备份路径');
  const backup = await readFile(res.backedUp, 'utf8');
  assert.equal(backup, 'broken');
  assert.equal(state.blocked, null);
  assert.equal(state.hasSeenComment(9101), true, '应从 inbox 重建已处理记录');
  assert.equal(state.hasAcceptedSha(4, SHA), true);
});
