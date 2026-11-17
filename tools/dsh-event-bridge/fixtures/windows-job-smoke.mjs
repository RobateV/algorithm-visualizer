// No model or GitHub calls. Run with ordinary Node to check the actual launch host.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runLocalDsh } from '../lib/local-dsh.mjs';

const dir = await mkdtemp(path.join(tmpdir(), 'local-dsh-probe-'));
try {
  const entry = path.join(dir, 'bin.js');
  await writeFile(entry, `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{process.stderr.write('LOCAL_DSH_GUARD_READY\\n');process.stdout.write(JSON.stringify({type:'final',text:JSON.stringify({edits:[],echo:input})})+'\\n');});`);
  const result = await runLocalDsh({ entry, cwd: dir, prompt: '中文本地启动验证', timeoutMs: 5000 });
  if (!result.contained || result.proposal.echo !== '中文本地启动验证') throw new Error('Job 或中文输入验证失败');
  console.log(JSON.stringify({ passed: true, contained: result.contained, modelRequests: result.modelRequests, durationMs: result.durationMs }));
} finally {
  if (path.dirname(dir) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith('local-dsh-probe-')) throw new Error('临时目录范围错误');
  await rm(dir, { recursive: true, force: true });
}
