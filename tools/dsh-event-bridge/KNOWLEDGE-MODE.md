# 知识库 Markdown 专用执行模式

本阶段只完善执行基础设施。示例策略 `enabled`、`autoPush`、`autoReport` 均为 false，`knowledge.allowUnattended` 也为 false。不发布真实教材任务，不自动修改 main 或合并 PR。现有 Windows 启动、停止、状态入口继续使用，见 [LOCAL-RUNNER.md](LOCAL-RUNNER.md)。

## 本机配置与任务

将 `local-books.example.json` 的内容保存到**仓库外**，由本机策略 `knowledge.configFile` 指定。实际路径不进入任务评论或公开配置；不要将填写后的配置复制回仓库。

- `pythonPath`：可信 Python 绝对入口，需已有 pypdf、Pillow。测试夹具另需 reportlab；运行器不自动安装任何依赖。
- `cacheDir`：已经存在的仓库外页图缓存目录。
- 每本书的 `pdfPath`、`ocrDir` 均须为仓库外绝对路径；`pdfSha256` 固定整个 PDF 的 SHA-256。
- `pdfOffset`：PDF 页码 = 印刷页码 + offset，页码从 1 开始；须人工核对具体版本。`allowedPrintRanges` 只放已核准范围，例如 `[[11, 20]]`，空数组拒绝任务。
- OCR 文件命名为 PDF 页码 `p021.txt`，UTF-8；缺页或格式不符即停止，不猜测教材内容。
- `allowOcrToModel` 默认 false。打开表示允许将**选定页 OCR**交给本机 DSH 配置的模型服务，可能离开电脑；PDF 文件及页图始终不交给模型。未授权时只在本机准备页图，然后拒绝调用 DSH。

本机策略必须同时设置 `mode: knowledge-markdown`、`tests: [knowledge-markdown]`，列出精确 allowedFiles，并在理解上述边界后设置 `knowledge.allowUnattended: true`。这只是结构化 Markdown 模式的本地授权，绝不证明系统拥有 OS 安全沙箱。

任务仍通过 Issue #21 的原协议收取，新增三项：

```text
mode: knowledge-markdown
book_id: algorithm-guide
print_pages: 11-20
```

沿用 task_id、branch、完整 expected_sha、allow、accept。allow 只接受 `docs/knowledge-base/` 下至多八个精确 `.md` 文件；不能是目录、通配符、绝对路径或其它仓库文件。书籍路径不允许由评论指定。返工只能缩小原授权的书籍、页码和文件范围。

## 执行与限额

每轮重新拉取并核验收件箱、评论作者、正文摘要、未编辑时间、task_id、分支及完整 SHA。模型调用前、每次 GitHub 写入与推送前均复核；本地策略、暂停及停止标志撤销后阻止后续写操作。GitHub 不提供“验证评论并原子推送”的事务，复核与推送之间仍有竞态窗口。

PDF 以 rb 只读打开，读取前后核对指纹；印刷页映射到 PDF 页，仅支持一页一张图且无文字层的扫描件。复杂页面、加密 PDF、缺失 OCR 拒绝执行，不能把提取单幅扫描图称为通用 PDF 渲染。页图只存于仓库外缓存，路径不进模型输入、提交或结果回传。缓存不会自动删除，由本机用户检查后清理。

硬上限：10 页、PDF 256 MiB、每张扫描图 8 MiB、每页 OCR 12 KiB、教材上下文 48 KiB、总提示词 128 KiB、8 个 Markdown 文件、每个输出 64 KiB。准备进程 30 秒、DSH 1–180 秒、整轮 5 分钟（Git/模型/远程写共享取消信号；已有 GET 最多等待其请求超时）。超限拒绝，不静默截断。

一轮只启动一次 DSH，llm/stream 拦截器最多放行一次模型请求，标题生成和自动重试关闭。第二次请求直接失败。所有 DSH 工具强制拒绝，模型只返回 JSON edits，由受信任桥接代码检查并写入。Windows Job 在进程恢复运行前归属子进程，结束、超时或取消时关闭整个进程树。继承现有任务去重、锁、暂停、恢复和发布去重机制；中途崩溃不会偷偷再次调用模型。

本模式**不执行 clone 内的测试、构建或任意仓库脚本**。固定检查包括精确路径、常规文本、密钥特征、大小、本地路径/页图嵌入/可执行 HTML、出处页码和原 OCR 长段复制检测；检查后复读实际文件、核对 Git 变更与暂存区，再提交。普通独立 clone 只隔离工作树，不隔离用户权限。

## 仍需独立审查的边界

- 进程仍以当前 Windows 用户身份运行，DSH 及其依赖是受信任本地程序；工具 guard 不是文件系统、凭据或网络权限沙箱。不能扩展到执行仓库任意代码。
- 准备了页图不等于模型已经看过页图。当前 DSH 输入只有 OCR，记录 `visualVerification: not_performed`；教材事实、公式、代码和图片对应关系必须由独立 ChatGPT/人工复核，不能自动宣布教材内容合格。
- 复制与密钥检测只是有限规则，不能数学证明语义无泄漏；输出允许的链接和 Markdown 仍须审查。不要用本模式发布大段 OCR 或教材原文。
- PDF/Python 解析器需可信，当前没有单独的内存配额；同用户恶意进程仍能篡改本机配置/缓存或窃取进程权限。
- 远程结果 `reported` 只是等待审查。只有绑定实际 commit 的独立审查才能 accept；本次基础设施测试不自行产生验收通过意见。
- GitHub 回传可由 ChatGPT 读取，但不保证自动唤醒原网页聊天。没有验证浏览器自动发送或平台事件触发能力，本阶段不开发此功能。

## 验证

`node --test` 运行桥接回归测试。设置 `DSH_TEST_PYTHON` 为已有 Python 入口可同时运行合成 PDF 的实际页图/OCR 测试；未设置时该项明确 skip，不能当作已通过。合成夹具完全原创，与任何教材无关。GitHub 实测证据、完整 commit 和安全限制记录在本次 PR 更新说明中，等待 ChatGPT 独立复审。
