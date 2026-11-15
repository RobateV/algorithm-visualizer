# 知识库执行模式验证记录（2026-11-15）

状态：基础设施实现与受限端到端测试已完成，**尚不具备开启无人值守的条件**，等待 ChatGPT 独立复审。未发布 0x03 或任何真实教材任务；没有读取真实教材 PDF。本记录不取代独立验收。

## 基线与修改范围

- 以 PR #23 最新 HEAD `f96e9a06d3fab8a07909475dc64890a3b77b6537` 为开发基线；保留现有监听器、任务家族、恢复、发布及 Windows 启停机制。
- 真实 GitHub dev 分支在实测时为 `f21e063c4cd8afdd1ed17078e32dd735a1649a6e`，无害测试输入完整绑定此 SHA；没有改 dev 或 main，没有合并 PR。
- 新增教材模式校验、本机仓库外教材配置、只读单图扫描页提取、本地 OCR、固定 Markdown 检查；教材模式不执行仓库测试/构建代码。
- DSH guard 除禁用所有工具外，还在 llm/stream 上限制每轮一次实际模型请求；关闭辅助标题生成和自动重试。Windows Job 未就绪时明确拒绝继续。
- 保留网站及浏览器功能为后续阶段，没有在本轮开发或验证它们。

## 回归测试

实际 Windows 运行 `node --test --test-reporter=tap`，同时设置 `DSH_TEST_PYTHON` 为本机已有 Python：**199/199 通过，0 skip**。没有新增安装依赖。

新增教材测试覆盖协议解析、页码/书籍范围、精确 Markdown 白名单、输出大小/路径/图像嵌入/原 OCR 长段转储、队列页码篡改、真实合成 PDF 页图和 OCR、中文编码、原 PDF 指纹不变、错误指纹、缺页、拒绝仓库内配置及未授权发送 OCR。既有暂停、停止、授权撤销、去重、IO 异常、报告重试和崩溃不重放测试全部保留。

Windows 原有三项真实进程测试全部通过：普通及 detached 后代取消回收，以及正常结束后的后代清理与中文 stdin/JSON。它们运行于 Node 测试子进程；不能证明下述普通启动宿主问题已修复。

## 真实 GitHub → DSH → GitHub

测试使用现场生成的两页原创合成扫描 PDF、相应原创 OCR，完全不含教材。PDF、页图、OCR 和填写后的本机配置均留在仓库外。只有一个 Markdown 文件获准修改。

### 第一个任务失败并安全停下

[kb-mode-smoke-20261115-01](https://github.com/RobateV/algorithm-visualizer/issues/21#issuecomment-6895674111) 成功入队、核验任务与页码并准备本机材料。但当前普通命令宿主启动 PowerShell 包装进程时在 Job 标记之前退出；CLI 尝试一次，没有提交或推送。原任务未自动重跑。另一次只执行失败回传恢复，确认额外模型调用为 0，并发布[失败结果](https://github.com/RobateV/algorithm-visualizer/issues/21#issuecomment-6896048746)。

### 第二个独立任务成功

[kb-mode-smoke-20261115-02](https://github.com/RobateV/algorithm-visualizer/issues/21#issuecomment-6895994517) 使用新 task_id，在已验证能正常启动 Job 的 `node --test` 独立测试宿主中执行现有 runnerOnce，不替换真实 DSH、Git 或 GitHub API。

1. 真实监听器收取，重新核验 RobateV 评论、未编辑时间、正文摘要、任务、完整 SHA 和文件白名单。
2. 两页合成扫描页及 OCR 在仓库外准备；前后源 PDF SHA-256 一致。未向模型发送 PDF 文件或页图。
3. 一次真实 DSH CLI，记录一次实际模型请求，19,757 ms，guard 和 Windows Job 均就绪；全部工具禁用。
4. 固定受信任 Markdown 检查通过，没有执行 clone 内的测试代码；实际只变更 `docs/knowledge-base/automation-smoke.md`。
5. 提交 `b4065bd44007bc9a462623cbe965cf13fe1814ef`，推送 `local-dsh/kb-mode-smoke-20261115-02-6895994517`；自动创建 [Draft PR #24](https://github.com/RobateV/algorithm-visualizer/pull/24)，base 为 dev，未合并。
6. 自动发布[实际结果](https://github.com/RobateV/algorithm-visualizer/issues/21#issuecomment-6896028523)，状态 `reported`，等待独立审查。整轮约 48.7 秒。
7. 通过 GitHub 连接器独立读取 PR metadata 和绑定 commit 的实际文件，确认只有一份五行 Markdown，无 PDF/OCR/页图/密钥/本机路径。此步骤证明 ChatGPT 工具能够读取实际成果，**不是伪称原网页聊天已自动被唤醒或已经完成审查**。
8. 再次 runnerOnce 后状态仍 reported、CLI 调用数仍为 1，GitHub 结果评论恰好一条，源合成 PDF 指纹不变。测试 enabled、autoPush、autoReport、allowUnattended 全部恢复 false。

## 尚未解决的启动与安全问题

- **启动阻塞仍存在**：相同假 DSH 夹具在 Node 独立测试子进程内两种 PowerShell 路径都成功；在当前普通 Node 命令宿主以及 Start-Process 隐藏后台方式中会超时。临时本机阶段记录表明 PowerShell 脚本首行尚未执行；绝对路径、脱离父进程、去掉 stdin 管道均未解决。原始诊断只保存在本机。还没有查明根因，不能把这项归为已修复或声称一键无人值守稳定可用。当前默认关闭，实际 Job/guard 未确认时拒绝执行。
- 独立 clone 不隔离 Windows 用户权限。当前方案只让受信任 DSH 返回结构化文本、禁用工具并避免执行仓库代码；不具有任意代码安全沙箱能力。
- PDF 提取只支持一页一张图、无文字层的扫描件；页图准备不代表模型视觉核对。OCR、公式、代码和教材忠实性仍需独立审查，本次也没有做真实教材准确性验收。
- 明确允许 OCR 发给 DSH 配置模型时，选定 OCR 可能离开电脑；默认拒绝。复制检测/密钥规则有识别边界；同用户恶意进程、本地依赖受损、解析器内存配额均未隔离。
- GitHub 校验和推送之间没有跨 API 原子事务；断电、系统重启、驱动或磁盘故障未实测。恢复保留现场，不能自动猜测或再次调用模型。
- 没有验证 ChatGPT 原网页聊天自动触发、自动视觉审查或浏览器自动发送；本轮不扩展这部分。`reported` 不等于 accept，未发布任何冒充独立审查的 ACCEPT。

## 关闭与回滚

没有生产部署、数据库迁移或远程删除。可先停止 bridge，再撤销本地测试 grant、保持四个开关 false。代码变更集中在 tools/dsh-event-bridge，可逐提交 revert；本次未修改原 E 盘工作区。测试分支与草稿 PR 保留供审查，不 force push、不自动合并或删除。
