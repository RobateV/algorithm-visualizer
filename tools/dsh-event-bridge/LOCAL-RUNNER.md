# Windows 本地协作桥接器

监听器只接收 Issue #21；执行器与旧 receiver/云端 PR 协议隔离。不修改 main，不合并 PR，不需要 OpenAI API。

```text
ChatGPT 发布任务 → GitHub #21 → listener 入队 → 本地授权复核
  → DSH headless 生成 JSON 修改 → 隔离 clone 校验/落盘/测试
  → local-dsh/* 普通提交/推送 → Draft PR（目标 dev）→ 唯一结果评论
  → 等待 ChatGPT 独立审查 → ACCEPT 完成 / REWORK 新任务
```

## 一键入口

在 `tools/dsh-event-bridge` 双击 `start-local-dsh-bridge.cmd`、`stop-local-dsh-bridge.cmd`、`status-local-dsh-bridge.cmd`。启动后台隐藏窗口；停止通过 STOP 文件取消当前 DSH，保留隔离工作区，不终止其它 Node/DSH。暂停/恢复：`local-bridge.ps1 pause` / `resume`。

首次启动自动复制 `local-policy.example.json` 到被忽略的 `.local-state/policy.json`。默认只收件，执行/推送/报告均关闭。GitHub 令牌从父进程环境或已登录的 GitHub CLI 获取，只在内存使用。没有令牌时仍可只读轮询公开收件箱。

无需新增 npm 依赖。需要 Node 22.13+、Git、已安装并登录/配置的 npm DSH CLI；回传需要现有 GitHub CLI 登录或 `DSH_BRIDGE_TOKEN`。

## 本地授权

`policy.json` 的 `allowedFiles` 是精确文件列表，不允许目录/通配符。`dshEntry` 填 npm DSH 包的绝对 `lib/bin.js` 入口；直接用 Node 调用，避免 Windows `.cmd` Shell 转义。任务的 branch、SHA、评论作者/归属/时间戳/正文摘要和 allow 都在执行前重新检查；旧版缺摘要任务 fail-closed，需要新任务 ID。

默认 `enabled: false`。一次性执行入口：`node local-runner.mjs --approve <task_id>`，生成绑定任务、评论、SHA、正文摘要、文件范围且一小时到期的本地授权；同一任务最多调用一次模型，崩溃也不重放。授权不能越过本地 allowedFiles。

如需窄范围自动执行，用户验收后可显式将 `enabled` 改为 true，并设置 `expiresAt`（未来 24 小时内）、`maxTasks`（1–10）。达到持久化累计调用数上限后停止，不能通过重启重置。自动推送与回传另外要求 `autoPush: true` 和 `autoReport: true`，二者同时开启才发布成功产物。不开启时停在 `review_ready`，保留本地提交。失败/阻塞状态仅在 autoReport 开启时回传。

## DSH 权限与适用范围

DSH 通过 stdin 接收任务与最多 20 个、每个 256 KiB 的白名单文本文件，只返回 `{"edits":[{"path":"...","content":"..."}]}`。guard 插件以 `ctx.tools.guard()` 拒绝所有模型工具调用，headless-runner 显式依赖 guard 服务；加载失败不会启动模型。桥接器不接受模型给出的 Shell、测试命令、提交、路径扩展或删除操作。CLI 子进程不继承 GitHub token，并强制 read-only；本机 DSH 版本仍需验证兼容性。

这是受控文本编辑首版，适合小范围代码任务；不支持 DSH 自主运行终端或自行浏览整个仓库。需要更多上下文时，把相关文件精确列入 allow；超出体积的任务应拆分。工作区用独立 clone，不共享用户 .git，不复制 PDF、OCR、.env、缓存或未跟踪文件。文件路径拒绝符号链接/目录联接、设备名、ADS、隐藏目录、越界、PDF、疑似密钥名和非文本扩展名。提交前复核全部实际变更、暂存路径、常规文件、HEAD、大小、二进制与常见密钥格式。

秘密扫描是防误传门禁，不能识别所有可能的凭据。不要把含凭据的文件加入 allow。DSH 自身的模型请求、会话存储、遥测仍遵循本机已安装软件的设置；本系统不读取/上传教材原件或原始 CLI 日志。

`tests: ["bridge"]` 只映射固定 `node --test`（隔离 clone 中的 tools/dsh-event-bridge），120 秒超时；评论中的命令不会执行。测试属于用户授权仓库代码，会以当前用户权限运行、环境剔除 GitHub token；不是 OS 安全沙箱，不能安全运行不可信提交。首版尚无站点 build/浏览器截图测试集合，不能据此声称 UI、动画验收通过。

## 状态、恢复与审查

listener-state.json 保存收件，runner-state.json 保存执行；runner 通过短监听器锁 ACK 状态，两个文件可能在崩溃瞬间不一致，下次以 runner 记录补 ACK。

`pending → awaiting_approval → running → testing → committing → review_ready → reporting → reported → done`；异常为 `failed/blocked`。`reported` 仅表示 GitHub 可审查，不代表通过。运行/测试/提交中断，重启标 blocked 并保留工作区，需新任务 ID；不自动猜测或重复调用模型。提交成功后推送/PR/评论失败仅重试回传，最多 5 次、指数退避；响应丢失按固定分支和结果标识找回，避免重复提交/评论。

ChatGPT 审查真实提交后可在 #21 发布：

```text
[LOCAL-DSH-REVIEW]
task_id: 已报告任务ID
commit: 已报告完整40位SHA
verdict: accept
```

`accept` 才 ACK done；`rework` 置 blocked，ChatGPT 发布新 task_id、当前 dev SHA 和相同或更窄范围再执行。每任务一次模型调用、自动策略总次数最多 10；不根据模型自己给出的“通过”结束任务。作者白名单只证明 GitHub 身份，不能证明评论确由 ChatGPT 生成；独立审查仍是流程约束。

连续返工时，新任务 branch/expected_sha 可以指向前一个已推送的 local-dsh 分支及其完整 commit；本地执行记录必须能匹配该分支和 SHA，才继承分支授权。输出仍创建新的任务分支和指向 dev 的 Draft PR，不自动覆盖旧 PR 或推进 dev。累计 CLI 次数上限约束整个迭代过程。

统计字段 `dsh_cli_calls` 表示 CLI 启动次数；CLI 内部标题生成、模型请求或重试次数及实际费用尚未暴露，不据此推算成本。实际测试确认本机 headless 默认禁用已保存凭据；专用 patch 恢复 credentials/authorization/deepseek-account 服务以复用现有 DSH 配置，密钥不经桥接器读写。

准备阶段在 CLI 从未启动、工作区也未创建时可显式 `node local-runner.mjs --retry-preparation <task_id>`；失败历史保留。只要曾启动 CLI 或留下工作区，就拒绝这种恢复，避免重复副作用。

根任务可以使用 `--approve-family <task_id>` 绑定 24 小时授权，最多三轮、三次 CLI；普通 `--approve` 仍只授权一轮。同一需求返工继承根授权和精确文件范围，需要上一轮真实提交已有 rework 审查；不能换新 ID 或改回旧 dev 基线绕过限制。结果报告附 root_task_id/round/max_rounds/授权到期时间。通过后才能启动下一根任务；下一需求可以基于最终已接受的结果分支，避免丢失前次成果。上述协议已通过自动测试，网页自动返工仍未实测。

Windows 的真实 DSH 调用通过 PowerShell 7 和 Job Object 包装。先以 suspended 创建 Node，再挂入禁止 breakaway 的 KILL_ON_JOB_CLOSE 作业，最后启动；包装器结束会回收其普通及 detached 派生进程。Job/guard 任一不能确认时不接受成功。仅管理本次调用的进程，不按名称终止其它 DSH/Node。`powershellPath` 应配置为本机已安装 PowerShell 7 的固定绝对路径（本机可使用已存在的 Codex bundled runtime），默认从 PATH 查找 pwsh.exe；缺失时 fail-closed，不自动安装软件。此机制管理生命周期，不是本机文件/网络的低权限沙箱。

普通/ detached 子进程取消、正常退出回收后代、中文及带空格路径、stdin/JSON 传输均已实测。本机真实 DSH 包装调用也已取得 exit=0 和 guard/Job 标志；受限 Codex 文件沙箱内原生接口不可用时测试会失败，完整原生接口回归应在用户授权的 Windows 运行环境验证，不静默跳过。

常驻服务重启不自动清陈旧锁。先停止全部桥接进程，备份 `.local-state`，核对 PID；普通锁可在持有者已退出时使用 `local-listener.mjs --unlock`。runner.lock/service.lock 使用同一实现，但恢复时需要人工核对相应文件，不提供在线强制删除。guard 残留必须停机人工移走，禁止运行中删除。错误状态与 CLI 输出在 `.local-state`，不要上传整个目录。

## 平台边界与回滚

ChatGPT 当前聊天不会因仓库脚本自动收到新用户消息。OpenAI 官方文档支持在具备资格和授权的账户中配置 GitHub PR 活动触发或定时任务；本项目没有修改既有 ChatGPT 自动化，也未验证本地 PR 范围的唤醒。可在网页端点一次“检查 GitHub #21 的成果”；如要无人值守审查，需要单独配置并实测 ChatGPT 任务。[官方 Scheduled tasks 文档](https://learn.chatgpt.com/docs/automations)。

本实现未注册开机任务/Windows 服务，也未宣称 Windows 重启后自动运行；提供一键重启和持久状态。没有公开预览服务、截图/录屏上传或浏览器视觉验收。报告明确写“未生成”。这些需要后续固定的站点测试与人工核实，不能以代码单测替代。

回滚：先一键停止，备份运行状态；将 enabled/autoPush/autoReport 设 false，再恢复备份代码或 revert 本次提交。任务 clone、日志、授权只在 .local-state，不删除原项目文件。已推送的任务分支/草稿 PR 可保留供审查；不要 force push 或自动合并。没有数据库迁移或生产部署。
