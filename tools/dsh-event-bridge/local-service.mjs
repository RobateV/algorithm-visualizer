#!/usr/bin/env node
import { readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ListenerState, withLock, pollIfActive, resolveToken, redactToken } from './local-listener.mjs';
import { RunnerState, runnerOnce, HERE } from './local-runner.mjs';

const present = async (p) => { try { await access(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

export async function service({ stateDir, once = false, token = '', intervalMs = 20000 }) {
  const lockState = await new ListenerState(stateDir).init();
  lockState.lockFile = path.join(stateDir, 'service.lock');
  const stopFile = path.join(stateDir, 'STOP');
  const heartbeat = path.join(stateDir, 'service.json');
  const controller = new AbortController();
  const stop = () => controller.abort();
  const guarded = await withLock(lockState, async () => {
    await rm(stopFile, { force: true });
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const watchStop = setInterval(() => {
      present(stopFile).then((v) => { if (v) stop(); }).catch(stop);
    }, 250);
    try {
      do {
        await writeFile(heartbeat, JSON.stringify({ pid: process.pid, status: 'running', at: new Date().toISOString() }));
        try {
          const listener = await new ListenerState(stateDir).init();
          const polled = await withLock(listener, () => pollIfActive({ state: listener, token, log: listener.log.bind(listener) }));
          if (!polled.locked) throw new Error(polled.reason);
          if (!controller.signal.aborted) await runnerOnce({ stateDir, token, signal: controller.signal });
        } catch (e) {
          await writeFile(heartbeat, JSON.stringify({ pid: process.pid, status: 'error', at: new Date().toISOString(), error: redactToken(e.message, token) }));
          if (once) throw e;
        }
        if (once) break;
        const until = Date.now() + intervalMs;
        while (!controller.signal.aborted && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
      } while (!controller.signal.aborted);
    } finally {
      clearInterval(watchStop);
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      await writeFile(heartbeat, JSON.stringify({ pid: process.pid, status: 'stopped', at: new Date().toISOString() }));
    }
  });
  if (!guarded.locked) throw new Error(guarded.reason);
}

async function main() {
  const args = process.argv.slice(2);
  const stateDir = path.resolve(args.includes('--state') ? args[args.indexOf('--state') + 1] : path.join(HERE, '.local-state'));
  const state = await new ListenerState(stateDir).init();
  if (args.includes('--stop')) { await writeFile(path.join(stateDir, 'STOP'), 'stop'); console.log('已请求停止；正在运行的 DSH 将取消，隔离工作区保留。'); return; }
  if (args.includes('--pause')) { await state.setPauseFile(true, 'manual'); return; }
  if (args.includes('--resume')) { await state.setPauseFile(false); return; }
  if (args.includes('--status')) {
    let health = null;
    try { health = JSON.parse(await readFile(path.join(stateDir, 'service.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const runner = await new RunnerState(stateDir).init();
    console.log(JSON.stringify({ health, paused: (await state.isPaused()).paused, execution: Object.values(runner.state.tasks).map(({ work, ...record }) => record), queue: Object.values(state.state.tasks).map((t) => ({ taskId: t.taskId, status: t.status })) }, null, 2));
    return;
  }
  const token = await resolveToken({ token: process.env.DSH_BRIDGE_TOKEN || process.env.GH_TOKEN || '' });
  await service({ stateDir, once: args.includes('--once'), token });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
