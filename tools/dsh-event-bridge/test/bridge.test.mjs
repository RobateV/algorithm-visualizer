import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseTaskBlock, validateTask, isAllowedAuthor } from '../lib/validate.mjs';
import { BridgeState } from '../lib/state.mjs';
import { runOnce, pullNumberFromComment, EXECUTES_CODE } from '../receiver.mjs';

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
