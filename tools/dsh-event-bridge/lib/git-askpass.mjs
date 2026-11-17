// 仅由固定 github.com remote 的 Git 推送进程使用，不传给 DSH 或测试。
const prompt = process.argv.slice(2).join(' ');
if (!prompt.includes('github.com') || !process.env.DSH_GIT_PUSH_TOKEN) process.exitCode = 1;
else process.stdout.write(/username/i.test(prompt) ? 'x-access-token\n' : process.env.DSH_GIT_PUSH_TOKEN + '\n');
