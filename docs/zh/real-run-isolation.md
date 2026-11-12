# Windows 真实执行隔离评估（M2.7）

> **结论：`git worktree` 不是安全沙箱。**
> `dsh --profile headless` 以**当前 Windows 用户**身份运行，能读写该用户能访问的一切文件
> （SSH 私钥、浏览器档案、`%APPDATA%`、其他仓库）。
> 执行器的环境变量白名单只阻止"把 token 传进子进程"，**不能阻止子进程自己去读磁盘上的 token**。

因此，第一次真实试运行（Issue #9 的 B 阶段）必须在一个**真正隔离的环境**里进行，
不能直接在承载个人数据的日常 Windows 账号下跑。

## 可选方案对比

| 方案 | 隔离强度 | 前置条件 | 代价 | 结论 |
| --- | --- | --- | --- | --- |
| A. Windows Sandbox | 强（一次性容器，无持久化） | Windows 10/11 专业版/企业版/教育版 + 硬件虚拟化 | 需要在沙箱内准备 Node、Git、DSH 与仓库副本 | **推荐**（首次试运行） |
| B. 独立低权限本地账号 | 中（同一内核，依赖 ACL） | 创建标准用户、收紧个人目录 ACL | 配置繁琐，仍需人肉确认 ACL 无泄漏 | 次选 |
| C. 虚拟机（Hyper-V / VirtualBox） | 强（可快照回滚） | 安装虚拟机与其内工具链 | 最重，但最可控 | 推荐（长期） |
| D. 日常账号直接跑 | **无** | 无 | 可直接读到个人凭据 | **禁止** |

## 最小隔离检查清单（B 阶段执行前逐项确认）

在**将要运行执行器的那个账号/环境**里执行：

```powershell
# 1. 身份：应为一次性/低权限账号，不是日常账号
whoami

# 2. 确认环境里没有任何 GitHub 凭据
Get-ChildItem Env: | Where-Object { $_.Name -match 'TOKEN|SECRET|GITHUB|GITLAB|OPENAI|AWS' }

# 3. 确认 SSH 私钥不可达（应无输出或无权限）
Get-ChildItem "$HOME\.ssh" -ErrorAction SilentlyContinue

# 4. 确认浏览器档案不可达
Test-Path "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Login Data"

# 5. 工作目录内只有测试仓库
Get-ChildItem (Get-Location) -Force
```

期望结果：第 2–4 项**均为空或不可读**；第 5 项只有测试仓库与执行器状态目录。

任一项不满足 → **停止真实试运行**，先把环境换到 A 或 C。

## 环境准备（以 Windows Sandbox 为例）

1. 启用功能：`启用或关闭 Windows 功能 → Windows 沙盒`（需要重启与硬件虚拟化）。
2. 启动沙盒（空白环境，**不映射**任何个人目录；不要勾选"映射文件夹"）。
3. 在沙盒内安装 Git、Node 22+、DSH CLI，并 `git clone` 测试仓库。
4. 把 `tools/dsh-event-bridge/` 拷入沙盒相同路径。
5. 记住：沙盒关闭即销毁，试运行结果需要**手动导出**（把 `results.jsonl` 与 worktree 差异复制出来）。

## 执行器侧的技术约束（已实现）

- 真实执行默认关闭；必须同时满足：`--execute --real-dsh --grant <file> --isolation-confirmed`。
- `--isolation-confirmed` 是**教师的环境确认标记**，不是技术保证——执行器无法自证隔离。
- 子进程环境只保留 `PATH/HOME/TEMP/SystemRoot` 等白名单，不传任何 token。
- 只允许 `dsh --profile headless --json <task>` 一种形态，拒绝任何额外 flag。
- 一次性授权绑定 repo / PR / 40 位 HEAD SHA / comment id / 正文摘要 / 工作根目录 / 过期时间，
  用掉即改名，不能复用。
- 执行前先 durable 写入 `reserved`，崩溃后重启只标记 `interrupted` 并暂停，**不自动重跑**。
- 首次试运行**不 commit、不 push、不留 PR 评论**；结果只落在本地 worktree 与报告文件里。
