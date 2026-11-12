import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { sha256 } from '../lib/state.mjs';
import { refetchAndVerify } from '../lib/task-refetch.mjs';
import { planWorkspace, prepareWorktree, cleanupWorktree, assertInside, assertCleanProject } from '../lib/workspace.mjs';
import { planTasks, readInbox, EXECUTES_CODE } from '../executor.mjs';

const git = promisify(execFile);
const SHA = 'c7b172fea1bde714f758df1e875340a1681e7d4e';
const REPO = 'RobateV/algorithm-visualizer';

const CFG = {
  repo: REPO,
  allowedActors: ['RobateV'],
  allowedPrs: [4],
  maxAttempts: 3,
  marker: '[DSH-REVIEW-TASK]',
  maxBodyLength: 20000
};

function taskBody({ reviewId = 'work-test-001', sha = SHA, pr = '4', attempt = '1', repo = REPO } = {}) {
  return [
    '[DSH-REVIEW-TASK]',
    `repo: ${repo}`,
    `pr_number: ${pr}`,
    `expected_head_sha: ${sha}`,
    `review_id: ${reviewId}`,
    `attempt: ${attempt}`,
    '---',
    '## 问题',
    '测试用任务正文'
  ].join('\n');
}

function recordFor(body, overrides = {}) {
  return {
    status: 'accepted',
    commentId: 9101,
    prNumber: 4,
    headSha: SHA,
    reviewId: 'work-test-001',
    bodyDigest: sha256(body),
    ...overrides
  };
}

function mockClient({ body = taskBody(), deleted = false, login = 'RobateV', prState = 'open', headSha = SHA, issuePr = 4 } = {}) {
  return {
    async getComment() {
      if (deleted) return null;
      return { id: 9101, body, user: { login }, issueUrl: `https://api.github.com/repos/${REPO}/issues/${issuePr}` };
    },
    async getPull() {
      return { number: 4, state: prState, headSha };
    }
  };
}

/* ---------------------------------------------------------------- 二次校验 */

test('正常任务通过二次校验', async () => {
  const body = taskBody();
  const r = await refetchAndVerify({ client: mockClient({ body }), record: recordFor(body), cfg: CFG });
  assert.equal(r.ok, true, r.reasons.join('；'));
  assert.equal(r.task.reviewId, 'work-test-001');
});

test('评论被删除时拒绝', async () => {
  const body = taskBody();
  const r = await refetchAndVerify({ client: mockClient({ deleted: true }), record: recordFor(body), cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /已被删除/);
});

test('评论正文被编辑时拒绝（摘要不一致）', async () => {
  const original = taskBody();
  const edited = taskBody() + '\n额外追加的内容';
  const r = await refetchAndVerify({ client: mockClient({ body: edited }), record: recordFor(original), cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /已被编辑/);
});

test('收件箱缺少正文摘要时拒绝（不能绕过校验）', async () => {
  const body = taskBody();
  const rec = recordFor(body, { bodyDigest: '' });
  const r = await refetchAndVerify({ client: mockClient({ body }), record: rec, cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /缺少正文摘要/);
});

test('作者不在可信名单时拒绝', async () => {
  const body = taskBody();
  const r = await refetchAndVerify({ client: mockClient({ body, login: 'attacker' }), record: recordFor(body), cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /不在可信名单/);
});

test('PR 已关闭时拒绝', async () => {
  const body = taskBody();
  const r = await refetchAndVerify({ client: mockClient({ body, prState: 'closed' }), record: recordFor(body), cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /closed/);
});

test('PR HEAD 变化时拒绝', async () => {
  const body = taskBody();
  const r = await refetchAndVerify({ client: mockClient({ body, headSha: 'f'.repeat(40) }), record: recordFor(body), cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /HEAD 已变/);
});

test('review_id 与收件箱记录不一致时拒绝', async () => {
  const body = taskBody({ reviewId: 'other-review' });
  const r = await refetchAndVerify({ client: mockClient({ body }), record: recordFor(body, { reviewId: 'work-test-001' }), cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /review_id 与收件箱记录不一致/);
});

test('评论所在 PR 与记录不一致时拒绝', async () => {
  const body = taskBody();
  const r = await refetchAndVerify({ client: mockClient({ body, issuePr: 9 }), record: recordFor(body), cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /与记录的 #4 不一致/);
});

/* ---------------------------------------------------------------- 工作区隔离 */

test('任务标识含路径穿越字符时拒绝', () => {
  assert.throws(() => planWorkspace({ workRoot: tmpdir(), record: { prNumber: 4, headSha: SHA, commentId: '../../etc' } }), /非法字符/);
});

test('目标路径越界时拒绝', () => {
  assert.throws(() => assertInside('/allowed/root', '/allowed/root-evil/x'), /越界/);
  assert.throws(() => assertInside('/allowed/root', '/other/x'), /越界/);
  assert.equal(assertInside('/allowed/root', '/allowed/root/sub'), path.resolve('/allowed/root/sub'));
});

test('dry-run 不创建目录', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-ws-'));
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await git('git', ['init', '-q', repo]);
  const body = taskBody();
  const plan = await prepareWorktree({
    projectRoot: repo,
    workRoot: path.join(base, 'wt'),
    record: recordFor(body),
    dryRun: true
  });
  assert.equal(plan.created, false);
  await assert.rejects(() => access(plan.dir));
  await rm(base, { recursive: true, force: true });
});

test('真实 worktree 创建后可清理，且主仓库不受影响', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-ws-'));
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await git('git', ['init', '-q', repo]);
  await git('git', ['-C', repo, 'config', 'user.email', 'test@local']);
  await git('git', ['-C', repo, 'config', 'user.name', 'test']);
  await writeFile(path.join(repo, 'a.txt'), 'hello', 'utf8');
  await git('git', ['-C', repo, 'add', '.']);
  await git('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const head = (await git('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();

  const body = taskBody({ sha: head });
  const record = recordFor(body, { headSha: head, commentId: 9101 });

  const plan = await prepareWorktree({ projectRoot: repo, workRoot: path.join(base, 'wt'), record, dryRun: false });
  assert.equal(plan.created, true);
  await access(plan.dir);

  const list = (await git('git', ['-C', repo, 'worktree', 'list', '--porcelain'])).stdout;
  assert.match(list, /worktree /);

  await cleanupWorktree({ projectRoot: repo, dir: plan.dir });
  await assert.rejects(() => access(plan.dir));
  const after = (await git('git', ['-C', repo, 'status', '--porcelain'])).stdout.trim();
  assert.equal(after, '', '主仓库应保持干净');
  await rm(base, { recursive: true, force: true });
});

test('主工作区有未提交改动时拒绝执行', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-ws-'));
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await git('git', ['init', '-q', repo]);
  await writeFile(path.join(repo, 'dirty.txt'), 'x', 'utf8');
  await assert.rejects(() => assertCleanProject({ projectRoot: repo }), /未提交改动/);
  await rm(base, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- 计划输出 */

test('planTasks 汇总通过与拒绝，且不执行代码', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-ws-'));
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await git('git', ['init', '-q', repo]);

  const okBody = taskBody();
  const records = [
    recordFor(okBody),
    recordFor(okBody, { commentId: 9102, reviewId: 'bad-digest', bodyDigest: sha256('different') })
  ];
  const client = mockClient({ body: okBody });
  const out = await planTasks({
    records,
    client,
    cfg: CFG,
    projectRoot: repo,
    workRoot: path.join(base, 'wt')
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.equal(EXECUTES_CODE, false);
  await rm(base, { recursive: true, force: true });
});

test('readInbox 只返回 accepted 记录', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-inbox-'));
  await writeFile(path.join(dir, 'inbox.jsonl'), [
    JSON.stringify({ status: 'accepted', commentId: 1 }),
    JSON.stringify({ status: 'rejected', commentId: 2 }),
    'half-line',
    JSON.stringify({ status: 'accepted', commentId: 3 })
  ].join('\n'), 'utf8');
  const records = await readInbox(dir);
  assert.deepEqual(records.map((r) => r.commentId), [1, 3]);
  await rm(dir, { recursive: true, force: true });
});
