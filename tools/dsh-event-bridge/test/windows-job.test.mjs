import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runLocalDsh } from '../lib/local-dsh.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

for (const detached of [false, true]) test(`Windows 取消 DSH 时，真实派生子进程也必须退出（detached=${detached}）`, { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-job-'));
  const marker = path.join(root, 'pids.json'), entry = path.join(root, 'bin.js');
  let childPid;
  t.after(async () => {
    if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(entry, `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:${detached}});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const run = runLocalDsh({ entry, cwd: root, prompt: 'fixture only', timeoutMs: 15000, signal: controller.signal });
  const failed = assert.rejects(run, /取消/);
  let pids;
  for (let i = 0; i < 100; i++) {
    try { pids = JSON.parse(await readFile(marker, 'utf8')); break; }
    catch (e) { if (e.code !== 'ENOENT') throw e; await new Promise((r) => setTimeout(r, 50)); }
  }
  assert.ok(pids, '测试进程必须实际启动'); childPid = pids.child;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(alive(childPid), true);
  controller.abort(); await failed;
  for (let i = 0; i < 40 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pids.parent), false);
  assert.equal(alive(childPid), false, '取消后不能遗留派生进程');
});

test('Windows Job 正常结束时清理 detached 后代，并保留中文 stdin/JSON 输出', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge job 中文 '));
  const marker = path.join(root, 'child.json'), entry = path.join(root, 'bin.js'); let childPid;
  t.after(async () => { if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL'); await rm(root, { recursive: true, force: true }); });
  await writeFile(entry, `const{spawn}=require('node:child_process');const fs=require('node:fs');let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>text+=s);process.stdin.on('end',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({child:child.pid}));process.stderr.write('LOCAL_DSH_GUARD_READY\\n');setTimeout(()=>{process.stdout.write(JSON.stringify({type:'final',text:JSON.stringify({edits:[],echo:text})})+'\\n',()=>process.exit(0));},500);});`);
  const result = await runLocalDsh({ entry, cwd: root, prompt: '中文任务 $() & 不作为命令', timeoutMs: 15000 });
  childPid = JSON.parse(await readFile(marker, 'utf8')).child;
  assert.equal(result.proposal.echo, '中文任务 $() & 不作为命令');
  for (let i = 0; i < 40 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(childPid), false);
});
