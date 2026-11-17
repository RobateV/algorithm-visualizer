# 浏览器通知闭环推进记录（2026-11-16）

本轮以 PR #23 的 `624427f02b3cee4e1cfd3c04f1e7c1fb58ce4b32` 为基线，继续复用现有 browser-relay 和 browser-extension。没有新增安装依赖、真实教材任务、GitHub 开发任务或 DSH 模型调用；不修改 main，不合并 PR，不修改已有网页定时任务。

## 已实现与本机验证

- 扩展 0.2.0：准备检查 → 持久化唯一 claim → 填入 → 最终 permit → 再核验草稿/目标/授权 → 点击 → 带 attempt ACK。
- 领取、发送许可和 ACK 都复查本机配置与通知时效，并受 PAUSED、STOP 约束；等待 POST 正文期间撤销授权也不会落入后续持久化。
- 本机通知授权独立于执行授权，限定 24 小时、默认最多三次；不重放激活之前的旧回传。它不能续期 DSH 或扩大文件/教材权限。
- 服务或扩展重启后，未 ACK 的 claim 只允许检查已有用户消息，不再填写或点击；并发客户端至多一个领取成功。
- 错误聊天、前缀相似 URL、多标签页、已有草稿、忙碌页面、发送中用户改写草稿、授权撤销、缺少本地许可均停止；确认不明保留现场。
- 任务通知明确要求绑定 task_id/完整 commit 的 LOCAL-DSH-REVIEW，并保留教材模式和根任务范围。失败通知不要求 accept，也不自动重跑。
- `--queue-review` 可在用户另行授权后，仅为固定 PR #23 已发布 HEAD 排队基础设施复审。不伪造 DSH 成果，不启用执行器；源码不干净或本地 HEAD 未发布则拒绝。
- 一键状态入口现在包含本机通知状态，密钥不出现在状态输出。`--disable` 备份配置并立即阻断后续请求。

完整 Windows `node --test`：**218/218，通过，0 skip**，包含原有合成 PDF 与真实 Windows 进程树测试。本轮通知相关共 19 项：11 项 VM 模拟页面/扩展测试、8 项本机 HTTP/持久化测试。模拟 DOM 不是实际 ChatGPT 页面，不能当作浏览器发送验收。

本机已为原聊天生成默认关闭的 v2 配置；`--status` 确认 enabled=false、expiresAt=null。扩展压缩包只含五个公开源码文件，不包含 browser-relay.json、聊天 ID、中转密钥、PDF/OCR 或本机运行记录。原教学工作区的 enabled、autoPush、autoReport 保持 false。

## 独立复审触发的真实结果

用户明确授权一次复审请求后，通过 codex-app-tools 的 send_message_to_thread 发送至原聊天“算法可视化网页改版”，固定审查 SHA 为上面的基线。工具返回成功，read_thread 能读到对应用户消息。

截至本次代码交付前最后核对，原聊天状态为 idle，该最新轮次只有 userMessage，没有 assistant/agent 审查回复。因此只证明请求进入聊天，**不能证明已经触发生成、调用 GitHub 或完成独立复审**。未重发第二条工具消息、未由 Codex 冒充独立审查。wait_threads 不支持该 ChatGPT 会话，不能将其 Codex 任务错误当作审查完成。

## 尚待用户一次性安装后验证

当前可用工具没有 computer-use 所要求的 node_repl，无法代替用户操作已登录浏览器安装扩展。安装和持续发送尚未获授权，也没有通过修改浏览器 profile、获取 Cookie、私有 ChatGPT API 或其它 Windows UI 脚本绕过。

用户一次性加载扩展、明确授权限定聊天的有限通知后，才可启用本机通知并排队一次基础设施复审；先核验真实页面用户消息和 ACK，再核验实际 ChatGPT 回复及绑定 SHA 的 GitHub 审查。真实多轮“审查不通过→发布返工→DSH 修改→再次审查”仍未验收，不能声称完整无人值守已完成。所有 DSH 默认开关继续关闭，真实教材与 0x03 任务继续禁止。

仍有限制：ChatGPT DOM/登录/浏览器权限可能变化；虚拟化的消息未必在 DOM 中，状态不明时可能需要人工核实。最终本地许可与浏览器点击无法成为原子事务；已发送消息无法撤回。GitHub 同一账号不能证明审查由哪一个主体生成；本机当前用户权限不是 OS 沙箱。通知时效、额度、数据范围和既有执行限制都不得通过新任务 ID 或重新加载页面绕过。

## 本轮修改文件

相对 tools/dsh-event-bridge：browser-relay.mjs、browser-extension/{background.js,content.js,manifest.json,popup.html,popup.js}、status-local-dsh-bridge.cmd、test/{browser-relay.test.mjs,browser-extension.test.mjs}、BROWSER-RELAY.md、CLOSED-LOOP.md，以及本记录。源码可逐提交 revert；本机配置修改保留备份，停止通知不影响原教材文件或 main。
