import { readFile, realpath, lstat, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSafeEnv } from './dsh-cli.mjs';

export const KNOWLEDGE_MODE = 'knowledge-markdown';
export function knowledgeRequest(fields) {
  if (!fields.mode) return null;
  if (fields.mode !== KNOWLEDGE_MODE || !/^[a-z0-9-]{1,40}$/.test(fields.book_id || '')) throw new Error('教材模式或 book_id 不合法');
  const match = String(fields.print_pages || '').match(/^([1-9]\d{0,3})-([1-9]\d{0,3})$/);
  if (!match || Number(match[2]) < Number(match[1]) || Number(match[2]) - Number(match[1]) >= 10) throw new Error('print_pages 必须为至多十页的印刷页范围');
  return { mode: KNOWLEDGE_MODE, bookId: fields.book_id, firstPage: Number(match[1]), lastPage: Number(match[2]) };
}

export function knowledgeScope(task) {
  if (!task.allow?.length || task.allow.length > 8 || task.allow.some((p) =>
    !/^docs\/knowledge-base\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.md$/.test(p))) throw new Error('教材任务只能授权知识库内至多八个精确 Markdown 文件');
}

export function checkKnowledge(task, policy, root = task) {
  const request = task.knowledge;
  if (!request && policy.mode !== KNOWLEDGE_MODE) return;
  if (!request || request.mode !== KNOWLEDGE_MODE || policy.mode !== KNOWLEDGE_MODE) throw new Error('任务与本地知识库模式不匹配');
  knowledgeScope(task); knowledgeScope(root);
  if (root.knowledge?.bookId !== request.bookId || request.firstPage < root.knowledge.firstPage || request.lastPage > root.knowledge.lastPage) throw new Error('返工扩大了教材或页码范围');
  if (policy.tests?.length !== 1 || policy.tests[0] !== KNOWLEDGE_MODE) throw new Error('教材模式禁止运行仓库测试脚本，只允许受信任 Markdown 检查');
  if (policy.knowledge?.allowUnattended !== true || process.platform !== 'win32') throw new Error('本机知识库执行条件尚未确认，拒绝无人值守');
  if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1000 || policy.timeoutMs > 180000) throw new Error('教材单次执行超时必须为 1–180 秒');
}

async function outside(project, file, label) {
  if (!path.isAbsolute(file || '')) throw new Error(`${label} 必须由本机配置提供绝对路径`);
  const result = await realpath(file);
  const relative = path.relative(await realpath(project), result);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error(`${label} 不能位于仓库内`);
  return result;
}

function runPages(python, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', fileURLToPath(new URL('./textbook-pages.py', import.meta.url))], {
      env: buildSafeEnv(process.env), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], signal
    });
    let output = '', stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill('SIGKILL'); }, 30000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => { output += s; if (Buffer.byteLength(output) > 160 * 1024) { stopped = true; child.kill('SIGKILL'); } });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
    child.once('error', () => { clearTimeout(timer); reject(new Error('本地教材提取进程不可用')); });
    child.once('close', (code) => { clearTimeout(timer); if (code || stopped) return reject(new Error('教材页图/OCR 准备失败或超限；未发送教材')); try { resolve(JSON.parse(output)); } catch { reject(new Error('教材提取结果格式错误')); } });
  });
}

export async function prepareKnowledge({ task, policy, projectRoot, signal }) {
  checkKnowledge(task, policy);
  const configFile = await outside(projectRoot, policy.knowledge.configFile, '教材配置');
  if ((await lstat(configFile)).size > 16384) throw new Error('教材配置过大');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const book = config.books?.[task.knowledge.bookId];
  if (config.version !== 1 || !book || !/^[a-f0-9]{64}$/.test(book.pdfSha256 || '')) throw new Error('教材未配置或缺少固定 PDF 指纹');
  if (!Number.isInteger(book.pdfOffset) || !Array.isArray(book.allowedPrintRanges) ||
    !book.allowedPrintRanges.some(([first, last]) => task.knowledge.firstPage >= first && task.knowledge.lastPage <= last)) throw new Error('页码超出本机教材授权');
  const pdfPath = await outside(projectRoot, book.pdfPath, '教材 PDF');
  const ocrDir = await outside(projectRoot, book.ocrDir, 'OCR 目录');
  const cacheDir = await outside(projectRoot, config.cacheDir, '教材缓存');
  if (!path.isAbsolute(config.pythonPath || '')) throw new Error('缺少受信任本地 Python 入口');
  const pages = Array.from({ length: task.knowledge.lastPage - task.knowledge.firstPage + 1 }, (_, i) => ({
    printedPage: task.knowledge.firstPage + i, pdfPage: task.knowledge.firstPage + i + book.pdfOffset
  }));
  signal?.throwIfAborted();
  const outputDir = await mkdtemp(path.join(cacheDir, 'local-dsh-pages-'));
  const material = await runPages(config.pythonPath, { pdfPath, ocrDir, pdfSha256: book.pdfSha256, pages, outputDir }, signal);
  if (Buffer.byteLength(JSON.stringify(material)) > 48 * 1024) throw new Error('教材上下文总量超限，拒绝截断或继续');
  // Separate consent: the PDF and page rasters never enter DSH or the Git clone.
  if (book.allowOcrToModel !== true) throw new Error('教材已在本机准备；未授权向配置模型传递选定 OCR，拒绝启动 DSH');
  return { ...material, bookId: task.knowledge.bookId, outputDir };
}

export function knowledgePrompt(material) {
  return { bookId: material.bookId, visualVerification: 'not_performed', pages: material.pages.map(({ printedPage, pdfPage, ocr, imageSha256, ocrSha256 }) => ({ printedPage, pdfPage, ocr, imageSha256, ocrSha256 })) };
}

export function validateKnowledgeEdits(task, proposal, material) {
  knowledgeScope(task);
  const pages = material?.pages || [];
  for (const edit of proposal.edits || []) {
    if (!task.allow.includes(edit.path) || typeof edit.content !== 'string' || !edit.content.trim() || Buffer.byteLength(edit.content) > 64 * 1024) throw new Error('Markdown 输出越权、为空或超限');
    if (/[A-Za-z]:[\\/]|\\\\[^\s]+|data:[^\s]*base64|!\[[^\]]*\]\(|<\/?(?:script|iframe|object|embed)\b|file:\/\//i.test(edit.content)) throw new Error('Markdown 包含本地路径、嵌入资料或可执行 HTML');
    if (/\[BOOK\]/.test(edit.content) && !/p\.\s*\d+/.test(edit.content)) throw new Error('BOOK 结论缺少印刷页码');
    for (const match of edit.content.matchAll(/\bp\.\s*(\d+)/g)) {
      if (!pages.some((p) => p.printedPage === Number(match[1]))) throw new Error('引用了本轮未授权的印刷页');
    }
    const normalized = edit.content.replace(/\s/g, '');
    for (const page of pages) {
      const source = page.ocr.replace(/\s/g, '');
      for (let i = 0; i + 80 <= source.length; i += 20) if (normalized.includes(source.slice(i, i + 80))) throw new Error('拒绝直接转储原始 OCR 长段内容');
    }
  }
  return { command: 'trusted knowledge-markdown checks (no repository code execution)', passed: true, files: proposal.edits?.length || 0, visualVerification: 'not_performed' };
}
