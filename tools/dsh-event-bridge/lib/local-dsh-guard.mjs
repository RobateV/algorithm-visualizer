// DSH 可生成修改建议；所有工具调用均拒绝，由桥接器校验并落盘。
export const name = 'local-dsh-guard';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.guard(() => 'LOCAL-DSH: tool execution disabled; return the requested JSON edits.');
  ctx.provide('localDshGuard', true);
  process.stderr.write('LOCAL_DSH_GUARD_READY\n');
}
