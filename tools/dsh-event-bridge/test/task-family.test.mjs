import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { taskFamily, checkFamilyLimits } from '../lib/task-family.mjs';
import { taskAuthority, RunnerState, reconcileReviews } from '../local-runner.mjs';
import { ListenerState } from '../local-listener.mjs';

const root = { taskId: 'root', commentId: 1, branch: 'dev/local-dsh-20261114', expectedSha: 'a'.repeat(40), bodyDigest: 'b'.repeat(64), allow: ['note.md'] };
const parent = { taskId: 'root', rootTaskId: 'root', round: 1, pushed: true, branch: 'local-dsh/root-1', commit: 'c'.repeat(40), status: 'blocked', reviewVerdict: 'rework', reviewCommentId: 10, modelCalls: 1 };
const child = { ...root, taskId: 'revision-2', commentId: 2, branch: parent.branch, expectedSha: parent.commit };

test('返工沿已退回的实际 SHA 关联根任务，不接受未审查或未知分支', () => {
  assert.deepEqual(taskFamily(root, {}), { rootTaskId: 'root', round: 1, parentTaskId: null });
  assert.equal(taskFamily(child, { root: parent }).round, 2);
  assert.throws(() => taskFamily(child, {}));
  assert.throws(() => taskFamily(child, { root: { ...parent, status: 'reported' } }));
  assert.throws(() => taskFamily(child, { root: { ...parent, reviewVerdict: 'accept' } }));
});

test('根任务配额拒绝第四轮、扩大范围及用新 ID 绕过未完成返工', () => {
  const family = taskFamily(child, { root: parent });
  assert.equal(checkFamilyLimits({ task: child, root, family, records: { root: parent }, maxRounds: 3, maxCliCalls: 3 }).calls, 1);
  assert.throws(() => checkFamilyLimits({ task: child, root, family: { ...family, round: 4 }, records: {}, maxRounds: 3, maxCliCalls: 3 }));
  assert.throws(() => checkFamilyLimits({ task: { ...child, allow: ['other.md'] }, root, family, records: {}, maxRounds: 3, maxCliCalls: 3 }));
  const unrelated = { ...root, taskId: 'unrelated' };
  assert.throws(() => checkFamilyLimits({ task: unrelated, root: unrelated, family: taskFamily(unrelated, {}), records: { root: parent }, maxRounds: 3, maxCliCalls: 3 }));
});

test('同一根授权允许返工，审查接受后才放行下一根任务', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'family-grant-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const listener = await new ListenerState(dir).init(), runner = await new RunnerState(dir).init();
  listener.state.tasks = { root, 'revision-2': child }; await listener.save();
  runner.state.tasks = { root: parent };
  const policy = { version: 1, enabled: false, branches: [root.branch], allowedFiles: root.allow };
  await writeFile(path.join(dir, 'grant-root.json'), JSON.stringify({ ...root, expiresAt: new Date(Date.now() + 3600000).toISOString(), maxRounds: 3, maxCliCalls: 3 }));
  const authority = await taskAuthority(child, policy, listener, runner);
  assert.equal(authority.allowed, true); assert.equal(authority.family.rootTaskId, 'root'); assert.equal(authority.family.round, 2);
  await rm(path.join(dir, 'grant-root.json'));
  assert.equal((await taskAuthority(child, policy, listener, runner)).allowed, false);
  runner.state.tasks['revision-2'] = { ...parent, ...authority.family, taskId: child.taskId, status: 'reported', commit: 'd'.repeat(40), modelCalls: 1 };
  await reconcileReviews({ listener, runner, comments: [{ id: 11, author: 'RobateV', createdAt: 'x', updatedAt: 'x', body: `[LOCAL-DSH-REVIEW]\ntask_id: revision-2\ncommit: ${'d'.repeat(40)}\nverdict: accept` }] });
  assert.equal(runner.taskById('revision-2').status, 'done');
  const next = { ...root, taskId: 'next' };
  assert.doesNotThrow(() => checkFamilyLimits({ task: next, root: next, family: taskFamily(next, {}), records: runner.state.tasks, maxRounds: 3, maxCliCalls: 3 }));
  assert.throws(() => taskFamily(child, runner.state.tasks), /根任务已完成/);
  const nextBase = { ...next, branch: runner.taskById('revision-2').branch, expectedSha: 'd'.repeat(40) };
  assert.equal(taskFamily(nextBase, runner.state.tasks).rootTaskId, 'next');
});
