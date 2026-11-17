# 本地协作桥接器验收记录（2026-11-15）

## 现场状态

完整阅读用户交接报告并核对真实仓库。实际仓库位于 E 盘；会话提供的旧 D 盘目录不存在。原工作区干净，未发现运行中的 local-listener；github remote 与非 GitHub 的 origin 分开。GitHub dev HEAD 仍为 `3b7a99c11480f7481c86ed07a501ae3f79609bba`，main 为 `8eba606098e2911e3606c3e9ea292170a203efe7`；旧 PR #19 仍 open/draft，未更改。

## 自动测试

- 监听器原有 40 项全部保留；新增 11 项。最初新增回归测试出现 3 个确定失败，修复后通过。
- 覆盖真实文件系统双解锁竞争、新实例获取、释放期间竞争、8 个独立 Node 进程竞争、残留 guard、读写 IO 异常、暂停持锁复查和 rename 失败保留旧状态。
- 新执行器 15 项：授权绑定、有效期/次数限制、秘密/设备路径门禁、目录联接拒绝、结构化编辑、guard、stdin/安全环境、超时/非零退出、崩溃恢复、真实 Git 隔离开发与测试提交、报告重试去重、评论复核、审查 ACK、准备阶段恢复。
- 在 `tools/dsh-event-bridge` 运行 `node --test`：**178/178 通过**；监听器 **51/51**，执行器 **15/15**，旧模块 **112/112**。
- PowerShell 脚本语法解析通过。实际 E 盘仓库：start → status（running，PID 存活）→ stop → status（stopped，PID 已退出）通过；再次启动、暂停标记、恢复、停止均通过，重启期间没有新增 DSH CLI 调用。
- 原分支与 bridge/状态已备份在本机 `_codex-bridge-backup-20261115`；安装在独立 codex 分支，工作区干净。旧任务已依据核实的结果补 ACK 为 reported，失败测试任务保持 blocked，无永久 pending。
- 测试失败的固定命令/退出码会持久化并阻断提交，原始 stdout/stderr 不自动上传。成功时只回传 TAP 的测试数量摘要，避免日志误传。

## 真实 DSH 与 GitHub 端到端

任务：[local-bridge-e2e-20261115-03](https://github.com/RobateV/algorithm-visualizer/issues/21#issuecomment-6892098347)。由本次 Codex 接手会话通过 GitHub 连接器发布，并非伪称 ChatGPT 网页自动触发。

1. 新监听器从真实 API 发现并核验评论，写入含正文摘要的队列。
2. 一次性本地授权只允许一个无害文本文件；DSH npm CLI 在隔离 clone 中运行，guard 强制禁用模型工具。
3. 真实 CLI exit=0，耗时约 11.4 秒，只启动一次。JSON 编辑经确定性代码落盘。
4. 在原 dev 基线上运行完整 bridge 测试（该基线共有 152 项），约 8.6 秒成功。
5. 创建 commit `f51be9e711c4124d2a15ac0224025871349ed5e4`，仅增加 `tools/dsh-event-bridge/fixtures/local-smoke.txt`，内容 `LOCAL_DSH_E2E_OK` 加换行。
6. 普通推送独立 local-dsh 分支，自动创建 [Draft PR #22](https://github.com/RobateV/algorithm-visualizer/pull/22)，base 为 dev，未合并。
7. 自动发布 [结果评论](https://github.com/RobateV/algorithm-visualizer/issues/21#issuecomment-6892118532)，状态 reported。之后通过 GitHub 连接器重新读取 PR 的 SHA、diff 和文件内容，均一致。

前置联调曾暴露跨账户 Git 所有权及 Windows 长路径问题，均在 DSH 启动前 fail-closed；保留 blocked/失败历史。现以单次命令范围的精确 safe.directory（仓库及 .git）和 core.longpaths 处理，不修改全局 Git 信任。headless 的默认凭据服务关闭导致 exit=1，经专用 patch 复用已有 DSH 配置后实际成功。未输出凭据或上传 CLI 会话日志。

## 边界

- 真实成功范围：任务收取、受控 CLI、隔离编辑、固定测试、提交、普通推送、Draft PR、唯一评论、持久状态。网络失败回传重试/去重、崩溃不重跑、审查 ACK 已通过自动测试。
- ChatGPT 网页端未来的自动唤醒、定时审查范围仍未接通或修改。reported 保持等待独立审查，没有由 Codex/DSH 冒充 ChatGPT 发布 ACCEPT。
- 本次仅文本基础设施任务，无 UI 改动，未生成截图/录屏，未做视觉验收；通用站点视觉产物流水线尚未实现。
- 未验证真实断电、Windows 重启、磁盘故障；未配置开机自启。guard 崩溃残留需人工停机恢复。
- 固定仓库测试使用当前用户权限，并非不可信代码 OS 沙箱；秘密扫描有识别范围限制。DSH 仅接收已校验的白名单文本。
- 默认自动执行、自动推送、自动回传均关闭；测试只使用一次性窄授权。无额外 npm 依赖、OpenAI API、生产部署或数据库变更。
