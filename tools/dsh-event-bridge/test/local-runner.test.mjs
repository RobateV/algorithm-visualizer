import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { checkAuthorization, assertSafeFile, assertPublicText, applyProposal, RunnerState, executeQueued, makeGitHub, resultBody, git, reconcileReviews, retryPreparation, makePrompt } from '../local-runner.mjs';
import { ListenerState } from '../local-listener.mjs';
import { parseDshEvents, runLocalDsh } from '../lib/local-dsh.mjs';
import { apply as applyGuard } from '../lib/local-dsh-guard.mjs';

const task = { taskId: 'smoke', commentId: 123, expectedSha: 'a'.repeat(40), bodyDigest: 'b'.repeat(64), branch: 'dev/local-dsh-20261114', allow: ['fixture.txt'] };
const policy = { version: 1, enabled: false, branches: [task.branch], allowedFiles: task.allow, tests: ['bridge'] };
const grant = { ...task, expiresAt: new Date(Date.now() + 3600000).toISOString() };

test('本地授权绑定任务/评论/摘要/SHA/文件/到期时间，默认拒绝', () => {
  assert.equal(checkAuthorization(task, policy), false);
  assert.equal(checkAuthorization(task, policy, grant), true);
  for (const changed of [{ bodyDigest: 'x' }, { commentId: 1 }, { expectedSha: 'c'.repeat(40) }, { allow: ['other.txt'] }, { expiresAt: 'bad' }, { expiresAt: '2000-01-01' }]) {
    assert.equal(checkAuthorization(task, policy, { ...grant, ...changed }), false);
  }
  assert.throws(() => checkAuthorization({ ...task, branch: 'main' }, policy, grant));
  assert.throws(() => checkAuthorization({ ...task, allow: ['else.txt'] }, policy, grant));
});

test('验证过程中 stop 后，push、PR、结果发布全部为零', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cancel-write-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const listener = await new ListenerState(dir).init(), runner = await new RunnerState(dir).init();
  listener.state.tasks.smoke = task; await listener.save();
  runner.state.tasks.smoke = { status: 'review_ready', branch: 'local-dsh/smoke-123', commit: 'c'.repeat(40), work: dir, modelCalls: 1 };
  await writeFile(path.join(dir, 'grant-smoke.json'), JSON.stringify(grant));
  const controller = new AbortController(); let writes = 0;
  await executeQueued({ listener, runner, policy: { ...policy, autoPush: true, autoReport: true }, signal: controller.signal,
    api: { validate: async () => { controller.abort(); }, pr: async () => { writes++; }, publish: async () => { writes++; } },
    gitImpl: async () => { writes++; return ''; } });
  assert.equal(writes, 0);
});

for (const revoked of ['pause', 'stop-file', 'policy', 'grant', 'after-push']) {
  test(`远程写入复查：${revoked} 阻止后续副作用`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'write-revoke-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const listener = await new ListenerState(dir).init(), runner = await new RunnerState(dir).init();
    listener.state.tasks.smoke = task; await listener.save();
    runner.state.tasks.smoke = { status: 'review_ready', branch: 'local-dsh/smoke-123', commit: 'c'.repeat(40), work: dir, modelCalls: 1 };
    const grantFile = path.join(dir, 'grant-smoke.json'); await writeFile(grantFile, JSON.stringify(grant));
    const current = { ...policy, autoPush: true, autoReport: true }; const controller = new AbortController(); let pushes = 0, other = 0;
    await executeQueued({ listener, runner, policy: current, signal: controller.signal, readCurrentPolicy: async () => current,
      api: { validate: async () => {
        if (revoked === 'pause') await listener.setPauseFile(true);
        if (revoked === 'stop-file') await writeFile(path.join(dir, 'STOP'), 'stop');
        if (revoked === 'policy') current.autoPush = false;
        if (revoked === 'grant') await rm(grantFile);
      }, pr: async () => { other++; }, publish: async () => { other++; } },
      gitImpl: async () => { pushes++; controller.abort(); return ''; } });
    assert.equal(pushes, revoked === 'after-push' ? 1 : 0); assert.equal(other, 0);
  });
}

test('GitHub 查询期间取消，在真正 POST 前再次检查', async () => {
  const controller = new AbortController(); let posts = 0;
  const api = await makeGitHub({ token: 'fake', fetchImpl: async (_, options) => {
    if (options.method === 'POST') posts++;
    controller.abort();
    return { ok: true, headers: { get: () => null }, json: async () => [] };
  } });
  await assert.rejects(() => api.publish(task, {}, 'body', { signal: controller.signal }));
  assert.equal(posts, 0);
});

test('限制任务总输入，自动模式禁止执行性文件', () => {
  assert.throws(() => makePrompt(task, [{ path: 'a.md', content: 'x'.repeat(70000) }, { path: 'b.md', content: 'x'.repeat(70000) }]), /128 KiB/);
  assert.ok(makePrompt(task, [{ path: 'a.md', content: 'small' }]).length);
  for (const p of ['test.mjs', 'package.json', 'vite.config.ts', 'page.html']) {
    const modified = { ...task, allow: [p] };
    assert.throws(() => checkAuthorization(modified, { ...policy, enabled: true, allowedFiles: [p] }), /仅允许/);
  }
});

test('文本白名单拒绝 PDF/OCR/密钥、Windows 设备与 ADS 路径', () => {
  for (const p of ['book.pdf', '.env', 'a:stream.txt', 'C:/a.txt', 'a/../b.md', 'a/nul.txt', 'a/ocr/x.txt', 'private-key.json', 'a./b.txt', 'a/b.txt ']) assert.throws(() => assertSafeFile(p), p);
  for (const p of ['public/lessons/a.html', 'fixture.txt', 'tools/dsh-event-bridge/README.md']) assert.equal(assertSafeFile(p), p);
  assert.throws(() => assertPublicText('-----BEGIN PRIVATE KEY-----'));
  assert.throws(() => assertPublicText('abc\0def'));
  assert.throws(() => assertPublicText('token-value', 'token-value'));
});

test('结构化编辑先校验全部文件，越权时没有部分写入', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-proposal-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'fixture.txt'), 'old');
  await assert.rejects(() => applyProposal(root, task, { edits: [{ path: 'fixture.txt', content: 'new' }, { path: '../secret.txt', content: 'x' }] }));
  assert.equal(await readFile(path.join(root, 'fixture.txt'), 'utf8'), 'old');
  await applyProposal(root, task, { edits: [{ path: 'fixture.txt', content: 'new' }] });
  assert.equal(await readFile(path.join(root, 'fixture.txt'), 'utf8'), 'new');
});

test('DSH guard 拒绝任意工具且只有安装后提供启动依赖', () => {
  let guard, ready = false;
  applyGuard({ tools: { guard: (fn) => { guard = fn; } }, provide: (name, value) => { assert.equal(name, 'localDshGuard'); ready = value; } });
  assert.equal(ready, true);
  assert.match(guard({ name: 'pwsh', args: { command: 'anything' } }), /disabled/);
});

test('DSH final 流解析拒绝错误事件与多个 final', () => {
  assert.deepEqual(parseDshEvents('{"type":"session","sessionId":"s"}\n{"type":"final","text":"{\\"edits\\":[]}"}').proposal, { edits: [] });
  assert.throws(() => parseDshEvents('{"type":"error"}\n{"type":"final","text":"{}"}'));
  assert.throws(() => parseDshEvents('{"type":"final","text":"{}"}\n{"type":"final","text":"{}"}'));
});

test('DSH 用 stdin 传入不可信任务，shell=false，GitHub 令牌不传入', async () => {
  let captured, child;
  const spawnImpl = (exe, args, opts) => {
    captured = { exe, args, opts }; child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(() => {
      child.stderr.write('LOCAL_DSH_GUARD_READY\n'); child.stdout.write('{"type":"final","text":"{\\"edits\\":[]}"}\n'); child.emit('close', 0);
    }); return child;
  };
  const result = await runLocalDsh({ entry: '/test/lib/bin.js', cwd: '/isolated', prompt: '$(echo secret) & whoami', spawnImpl, env: { PATH: 'x', GH_TOKEN: 'secret' } });
  assert.deepEqual(result.proposal.edits, []);
  assert.equal(captured.opts.shell, false); assert.equal(captured.opts.env.GH_TOKEN, undefined);
  assert.equal(captured.args.at(-1), '-'); assert.equal(captured.args.includes('$(echo secret) & whoami'), false);
});

test('DSH 超时、退出异常和未启用 guard 均失败', async () => {
  for (const mode of ['timeout', 'exit', 'guard']) {
    const spawnImpl = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('close', null)); };
      if (mode !== 'timeout') queueMicrotask(() => child.emit('close', mode === 'exit' ? 1 : 0));
      return child;
    };
    await assert.rejects(() => runLocalDsh({ entry: '/test/bin.js', cwd: '/x', prompt: 'x', spawnImpl, timeoutMs: 5 }));
  }
});

test('运行中崩溃恢复为 blocked，不再调用模型', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'runner-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const listener = await new ListenerState(dir).init(), runner = await new RunnerState(dir).init();
  listener.state.tasks.smoke = task; await listener.save();
  runner.state.tasks.smoke = { status: 'running', modelCalls: 1 };
  await executeQueued({ listener, runner, policy, api: {}, runModel: () => assert.fail('不能重跑') });
  assert.equal(runner.state.tasks.smoke.status, 'blocked');
  assert.equal(listener.state.tasks.smoke.status, 'blocked');
});

test('评论回传响应丢失后按标识找回，避免重复 POST', async () => {
  let posts = 0, posted = false;
  const tag = `<!-- local-dsh-result:${task.taskId}:${task.expectedSha} -->`;
  const fetchImpl = async (url, opts) => {
    if (opts.method === 'POST') { posts++; posted = true; throw new Error('response lost'); }
    return { ok: true, headers: { get: () => null }, json: async () => posted ? [{ id: 5, body: tag, user: { login: 'RobateV' }, html_url: 'https://github.com/result' }] : [] };
  };
  const api = await makeGitHub({ token: 'test', fetchImpl });
  await assert.rejects(() => api.publish(task, {}, 'body'));
  assert.equal(await api.publish(task, {}, 'body'), 'https://github.com/result');
  assert.equal(posts, 1);
});

test('实际执行前拒绝评论编辑、错误 Issue 和过期 SHA', async () => {
  const body = '[LOCAL-DSH-TASK]\ntask_id: smoke\nbranch: dev/local-dsh-20261114\nexpected_sha: ' + task.expectedSha + '\nallow: fixture.txt\naccept: pass\n---\nhello';
  const { createHash } = await import('node:crypto');
  const bound = { ...task, bodyDigest: createHash('sha256').update(body).digest('hex') };
  for (const bad of ['edit', 'issue', 'sha']) {
    const api = await makeGitHub({ token: 'x', fetchImpl: async (url) => ({ ok: true, json: async () => {
      if (url.endsWith('/issues/21')) return { state: 'open' };
      if (url.includes('/branches/')) return { commit: { sha: 'c'.repeat(40) } };
      return { body, user: { login: 'RobateV' }, issue_url: `https://api.github.com/repos/RobateV/algorithm-visualizer/issues/${bad === 'issue' ? 17 : 21}`, created_at: 'x', updated_at: bad === 'edit' ? 'y' : 'x' };
    } }) });
    await assert.rejects(() => api.validate(bound));
  }
});

test('真实 Git 隔离开发→测试→提交→推送/报告重试；模型只调用一次', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-pipeline-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), stateDir = path.join(root, 'state');
  await mkdir(path.join(source, 'tools/dsh-event-bridge'), { recursive: true });
  await writeFile(path.join(source, 'fixture.txt'), 'old\n');
  await writeFile(path.join(source, 'tools/dsh-event-bridge/check.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('content',()=>assert.equal(readFileSync('../../fixture.txt','utf8'),'new\\n'));\n");
  await git(source, ['init']); await git(source, ['add', '.']);
  await git(source, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  await git(source, ['remote', 'add', 'github', 'https://github.com/RobateV/algorithm-visualizer.git']);
  const bound = { ...task, expectedSha: await git(source, ['rev-parse', 'HEAD']), detail: 'edit fixture', accept: 'test passes' };
  const listener = await new ListenerState(stateDir).init(), runner = await new RunnerState(stateDir).init();
  listener.state.tasks.smoke = bound; await listener.save();
  await writeFile(path.join(stateDir, 'grant-smoke.json'), JSON.stringify({ ...grant, expectedSha: bound.expectedSha }));
  let modelCalls = 0, posts = 0, pushes = 0;
  const api = { validate: async () => {}, pr: async () => 'https://github.com/pr', publish: async () => { posts++; if (posts === 1) throw new Error('offline'); return 'https://github.com/result'; } };
  const gitImpl = async (cwd, args) => { if (args[0] === 'push') { pushes++; assert.match(args[2], /:refs\/heads\/local-dsh\//); return ''; } return git(cwd, args); };
  const opts = { listener, runner, policy: { ...policy, autoPush: true, autoReport: true }, api, projectRoot: source, gitImpl,
    runModel: async () => { modelCalls++; return { proposal: { edits: [{ path: 'fixture.txt', content: 'new\n' }] }, sessionId: 's' }; } };
  await executeQueued(opts);
  assert.equal(runner.state.tasks.smoke.status, 'reporting');
  runner.state.tasks.smoke.retryAt = '';
  await executeQueued(opts);
  assert.equal(runner.state.tasks.smoke.status, 'reported');
  assert.equal(runner.state.tasks.smoke.tests[0].passed, true);
  assert.equal(modelCalls, 1); assert.equal(pushes, 1); assert.equal(posts, 2);
  assert.equal(await readFile(path.join(source, 'fixture.txt'), 'utf8'), 'old\n');
  assert.equal(await git(source, ['status', '--porcelain']), '');
  const record = runner.state.tasks.smoke;
  await reconcileReviews({ listener, runner, comments: [{ author: 'RobateV', createdAt: 'x', updatedAt: 'x', id: 6,
    body: `[LOCAL-DSH-REVIEW]\ntask_id: smoke\ncommit: ${record.commit}\nverdict: accept` }] });
  assert.equal(record.status, 'done'); assert.equal(listener.taskById('smoke').status, 'done');
  await executeQueued(opts); assert.equal(modelCalls, 1);
  const failing = { ...bound, taskId: 'smoke-fail', commentId: 124 };
  listener.state.tasks[failing.taskId] = failing; await listener.save();
  await writeFile(path.join(stateDir, 'grant-smoke-fail.json'), JSON.stringify({ ...grant, ...failing }));
  await executeQueued({ ...opts, runModel: async () => ({ proposal: { edits: [{ path: 'fixture.txt', content: 'wrong\n' }] } }) });
  assert.equal(runner.taskById('smoke-fail').status, 'failed');
  assert.equal(runner.taskById('smoke-fail').tests[0].passed, false);
  assert.equal(runner.taskById('smoke-fail').commit, undefined);
});

test('历史/篡改/错误提交的审查不能把任务标记 done', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-bind-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const listener = await new ListenerState(dir).init(), runner = await new RunnerState(dir).init();
  listener.state.tasks.smoke = task; await listener.save();
  runner.state.tasks.smoke = { status: 'reported', commit: task.expectedSha };
  await reconcileReviews({ listener, runner, comments: [{ author: 'RobateV', createdAt: 'x', updatedAt: 'y', body: `[LOCAL-DSH-REVIEW]\ntask_id: smoke\ncommit: ${task.expectedSha}\nverdict: accept` }, { author: 'someone', createdAt: 'x', updatedAt: 'x', body: `[LOCAL-DSH-REVIEW]\ntask_id: smoke\ncommit: ${task.expectedSha}\nverdict: accept` }] });
  assert.equal(runner.state.tasks.smoke.status, 'reported');
});

test('准备失败仅在 CLI 从未启动且工作区不存在时可显式恢复', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prepare-retry-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const runner = await new RunnerState(dir).init();
  runner.state.tasks.smoke = { status: 'blocked', modelCalls: 0, error: 'clone failed', work: path.join(dir, 'absent') }; await runner.save();
  assert.equal((await retryPreparation(dir, 'smoke')).locked, true);
  await runner.init(); assert.equal(runner.taskById('smoke').status, 'pending'); assert.equal(runner.taskById('smoke').preparationFailures.length, 1);
  runner.taskById('smoke').status = 'blocked'; runner.taskById('smoke').modelCalls = 1; await runner.save();
  await assert.rejects(() => retryPreparation(dir, 'smoke'));
  runner.taskById('smoke').modelCalls = 0; await mkdir(runner.taskById('smoke').work); await runner.save();
  await assert.rejects(() => retryPreparation(dir, 'smoke'));
});

test('自动授权必须有期限和累计调用上限；不允许主分支和旧云端分支', () => {
  assert.throws(() => checkAuthorization(task, { ...policy, enabled: true }));
  assert.equal(checkAuthorization(task, { ...policy, enabled: true, maxTasks: 2, expiresAt: new Date(Date.now() + 3600000).toISOString() }), true);
  for (const branch of ['main', 'master', 'lesson/dsh-binary-issue-17', 'codex/other']) {
    assert.throws(() => checkAuthorization({ ...task, branch }, { ...policy, branches: [branch] }, grant));
  }
});

test('目录联接中的编辑被拒绝，不会写到工作区外', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'junction-check-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const work = path.join(dir, 'work'), outside = path.join(dir, 'outside'); await mkdir(work); await mkdir(outside);
  await symlink(outside, path.join(work, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => applyProposal(work, { ...task, allow: ['link/file.txt'] }, { edits: [{ path: 'link/file.txt', content: 'x' }] }));
});
