import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { KNOWLEDGE_MODE, knowledgeRequest, knowledgeScope, checkKnowledge, prepareKnowledge, knowledgePrompt, validateKnowledgeEdits } from '../lib/knowledge-mode.mjs';
import { parseComment } from '../local-listener.mjs';
import { makePrompt, makeGitHub } from '../local-runner.mjs';

const task = { taskId: 'synthetic', allow: ['docs/knowledge-base/automation-smoke.md'],
  knowledge: { mode: KNOWLEDGE_MODE, bookId: 'synthetic', firstPage: 1, lastPage: 2 } };
const policy = { mode: KNOWLEDGE_MODE, tests: [KNOWLEDGE_MODE], timeoutMs: 180000, knowledge: { allowUnattended: true } };
const material = { bookId: 'synthetic', pages: [{ printedPage: 1, pdfPage: 1, ocr: 'A'.repeat(100), imageSha256: 'a', ocrSha256: 'b' }] };
const edit = (content, file = task.allow[0]) => ({ edits: [{ path: file, content }] });

test('教材任务解析限定书籍别名、页码数量与知识库精确 Markdown', () => {
  assert.deepEqual(knowledgeRequest({ mode: KNOWLEDGE_MODE, book_id: 'synthetic', print_pages: '1-2' }), task.knowledge);
  for (const extra of [{ print_pages: '1-11' }, { print_pages: '2-1' }, { book_id: 'C:/private.pdf' }, { mode: 'anything' }]) {
    assert.throws(() => knowledgeRequest({ mode: KNOWLEDGE_MODE, book_id: 'synthetic', print_pages: '1-2', ...extra }));
  }
  for (const file of ['docs/knowledge-base/../a.md', 'README.md', 'C:/a.md', 'docs/knowledge-base/a.pdf', 'docs/knowledge-base/a.mjs']) assert.throws(() => knowledgeScope({ allow: [file] }));
  knowledgeScope(task);
  const body = `[LOCAL-DSH-TASK]\ntask_id: synthetic\nbranch: dev/local-dsh-20261114\nexpected_sha: ${'a'.repeat(40)}\nallow: ${task.allow[0]}\naccept: fixture\nmode: ${KNOWLEDGE_MODE}\nbook_id: synthetic\nprint_pages: 1-2\n---\nsynthetic only`;
  assert.deepEqual(parseComment(body).task.knowledge, task.knowledge);
  assert.equal(parseComment(body.replace('mode: knowledge-markdown\n', '')).kind, 'invalid');
});

test('教材自动模式要求本机明确配置、固定检查和原有页码范围', () => {
  for (const changed of [{ knowledge: {} }, { tests: ['bridge'] }, { timeoutMs: 180001 }, { timeoutMs: 0 }]) assert.throws(() => checkKnowledge(task, { ...policy, ...changed }));
  assert.throws(() => checkKnowledge(task, policy, { ...task, knowledge: { ...task.knowledge, lastPage: 1 } }));
  if (process.platform === 'win32') checkKnowledge(task, policy);
  else assert.throws(() => checkKnowledge(task, policy));
});

test('教材输出拒绝越权、原始 OCR 长段、本机路径、页图和越界引用', () => {
  for (const content of ['A'.repeat(100), 'C:\\private\\book.pdf', '![](page.png)', '[BOOK] 未提供出处', '[BOOK] p.2', '<script>x</script>', 'data:image/png;base64,ABC']) assert.throws(() => validateKnowledgeEdits(task, edit(content), material), content);
  assert.throws(() => validateKnowledgeEdits(task, edit('ok', 'README.md'), material));
  assert.equal(validateKnowledgeEdits(task, edit('# Synthetic\nOriginal summary. [BOOK] p.1'), material).passed, true);
  const prompt = makePrompt({ ...task, detail: 'synthetic only' }, [], material);
  assert.ok(prompt.includes('中文') === false);
  assert.equal(knowledgePrompt({ ...material, outputDir: 'C:/private' }).outputDir, undefined);
  assert.ok(!prompt.includes('C:/private'));
  assert.throws(() => makePrompt(task, [], { ...material, pages: [{ ...material.pages[0], ocr: 'x'.repeat(140000) }] }), /128 KiB/);
});

test('重新拉取评论后不能篡改本地教材页码', async () => {
  const body = `[LOCAL-DSH-TASK]\ntask_id: synthetic\nbranch: dev/local-dsh-20261114\nexpected_sha: ${'a'.repeat(40)}\nallow: ${task.allow[0]}\naccept: fixture\nmode: ${KNOWLEDGE_MODE}\nbook_id: synthetic\nprint_pages: 1-2\n---\nfixture`;
  const queued = { ...parseComment(body).task, commentId: 1, bodyDigest: createHash('sha256').update(body).digest('hex') };
  const api = await makeGitHub({ token: '', fetchImpl: async (url) => ({ ok: true, headers: { get: () => null }, json: async () =>
    url.includes('comments/') ? { issue_url: 'https://api.github.com/repos/RobateV/algorithm-visualizer/issues/21', user: { login: 'RobateV' }, created_at: 'now', updated_at: 'now', body } :
      url.includes('git/ref') ? { object: { sha: queued.expectedSha } } : { state: 'open' } }) });
  await assert.rejects(() => api.validate({ ...queued, knowledge: { ...queued.knowledge, lastPage: 3 } }), /队列任务/);
});

test('实际只读 PDF 页图与本地 OCR：指纹、映射、UTF-8、缺页及独立配置', { skip: !process.env.DSH_TEST_PYTHON || process.platform !== 'win32' }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kb-fixture-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repository'); await mkdir(repo);
  const python = process.env.DSH_TEST_PYTHON;
  const { stdout } = await promisify(execFile)(python, ['-I', fileURLToPath(new URL('./fixtures/synthetic-book.py', import.meta.url)), dir]);
  const pdfSha256 = JSON.parse(stdout).pdfSha256;
  const config = { version: 1, pythonPath: python, cacheDir: path.join(dir, 'cache'), books: { synthetic: {
    pdfPath: path.join(dir, 'synthetic.pdf'), pdfSha256, ocrDir: path.join(dir, 'ocr'), pdfOffset: 0, allowedPrintRanges: [[1, 2]], allowOcrToModel: true } } };
  const configFile = path.join(dir, 'books.json'); await writeFile(configFile, JSON.stringify(config));
  const local = { ...policy, knowledge: { ...policy.knowledge, configFile } };
  const prepared = await prepareKnowledge({ task, policy: local, projectRoot: repo });
  assert.deepEqual(prepared.pages.map((p) => p.pdfPage), [1, 2]);
  assert.ok(prepared.pages[0].ocr.includes('中文编码测试'));
  assert.equal(prepared.pdfSha256, pdfSha256);
  assert.equal(createHash('sha256').update(await readFile(config.books.synthetic.pdfPath)).digest('hex'), pdfSha256);
  assert.equal((await readdir(prepared.outputDir)).length, 2);
  assert.equal(prepared.visualVerification, 'not_performed');
  config.books.synthetic.allowOcrToModel = false; await writeFile(configFile, JSON.stringify(config));
  await assert.rejects(() => prepareKnowledge({ task, policy: local, projectRoot: repo }), /未授权/);
  config.books.synthetic.allowOcrToModel = true; config.books.synthetic.pdfSha256 = '0'.repeat(64); await writeFile(configFile, JSON.stringify(config));
  await assert.rejects(() => prepareKnowledge({ task, policy: local, projectRoot: repo }), /准备失败/);
  config.books.synthetic.pdfSha256 = pdfSha256; await writeFile(configFile, JSON.stringify(config));
  await rm(path.join(dir, 'ocr', 'p002.txt'));
  await assert.rejects(() => prepareKnowledge({ task, policy: local, projectRoot: repo }), /准备失败/);
  const inside = path.join(repo, 'books.json'); await writeFile(inside, JSON.stringify(config));
  await assert.rejects(() => prepareKnowledge({ task, policy: { ...local, knowledge: { ...local.knowledge, configFile: inside } }, projectRoot: repo }), /不能位于仓库内/);
});
