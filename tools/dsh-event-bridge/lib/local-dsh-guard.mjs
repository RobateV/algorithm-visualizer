// DSH 可生成修改建议；所有工具调用均拒绝，由桥接器校验并落盘。
export const name = 'local-dsh-guard';
export const inject = ['tools', 'llm'];
export function apply(ctx) {
  let calls = 0;
  ctx.on('llm/stream', (_options, next) => {
    if (calls >= 1) {
      process.stderr.write('LOCAL_DSH_BUDGET_EXCEEDED\n');
      throw new Error('LOCAL-DSH: one provider request per run; retries and auxiliary calls are forbidden');
    }
    calls++;
    process.stderr.write(`LOCAL_DSH_MODEL_CALLS:${calls}\n`);
    return next();
  });
  ctx.tools.guard(() => 'LOCAL-DSH: tool execution disabled; return the requested JSON edits.');
  ctx.provide('localDshGuard', true);
  process.stderr.write('LOCAL_DSH_GUARD_READY\n');
}
