# DSH 受限执行器 · 中文使用手册（M2.6）

> **当前状态：默认 dry-run。**
> 本仓库这一版**不会**自动修改代码、不会推送到 GitHub、不会调用真实 DSH 执行开发任务。
> 只有教师在两次明确授权后，才会打开真实执行（见文末）。

## 1. 它做什么

把接收器（`receiver.mjs`）从 GitHub 收到的 `[DSH-REVIEW-TASK]` 待办，变成一次**受控的本地执行**：

```
inbox.jsonl → 重新读 GitHub 评论校验 → 独立 git worktree → 执行（可 mock）→ [DSH-RESULT] 报告
```

执行前一定会重新读取原始评论并校验，**不会**凭收件箱里的旧数据直接开跑。

## 2. 快速开始

```powershell
cd tools\dsh-event-bridge

# 只做校验与工作区计划（默认，安全）
node executor.mjs --api

# 暂停 / 恢复（写 state.paused）
node executor.mjs --pause
node executor.mjs --resume

# 用 mock 执行器跑通编排（不调用真实 dsh）
node executor.mjs --api --execute --mock-dsh

# 也允许真正创建隔离 worktree（仍不执行任务）
node executor.mjs --api --prepare-workspace
```

### 需要 `--execute` 时

必须显式给出下列之一，否则直接拒绝：

| 参数 | 含义 |
| --- | --- |
| `--mock-dsh` | 用内置 mock 执行器，**不启动真实 dsh** |

> **真实 DSH 尚未接线**：`--execute` 现在只接受 `--mock-dsh`；代码里没有启动 `dsh` 的路径。
> 接入真实执行需要教师明确授权后单独实现（见第 6 节）。

## 3. 查看状态与产物

| 位置 | 内容 |
| --- | --- |
| `<state>/state.json` | 去重、水位、暂停标志、attempts |
| `<state>/inbox.jsonl` | 已接收任务（含 `bodyDigest`） |
| `<state>/rejected.jsonl` | 被拒绝的评论及原因 |
| `<state>/errors.jsonl` | 拉取/落盘/处理异常 |
| `<state>/locks/` | 任务锁与全局锁（执行结束自动清理） |
| `<项目根>/../.dsh-worktrees/` | 隔离工作区 |

## 4. 失败处理

| 现象 | 处置 |
| --- | --- |
| 任务被锁（`locked`） | 同任务正在执行，等待或检查残留 `.lock` |
| 全局锁忙（`global-lock-busy`） | 已有其它任务在跑，串行等待 |
| 连续失败触发熔断 | 排查后 `node executor.mjs --resume` |
| 执行超时 | 默认 15 分钟，可用 `--timeout-ms` 调整；超时会先 SIGTERM 再 SIGKILL |
| 状态文件损坏 | 接收器侧 `--repair` 重建，执行器拒绝继续 |
| PR HEAD 已变 | 任务过期，需重新接收 |
| 提示"已达总尝试上限" | 同一任务最多 1 次初试 + 2 次重试，超限自动暂停等待人工处理 |

### 可靠性边界（重要）

`results.jsonl` 只在**一次执行全部返回后**写入。若 Node 进程或电脑在单次尝试**中途被强杀**，
这次尝试不会被记录，重启后可能多跑一次——也就是说：

- ✅ 正常失败后的重启：累计尝试严格计数，超过 3 次即暂停（有测试覆盖）
- ⚠️ 异常崩溃（kill / 断电）：这次尝试**不计数**，可能重跑一次

因此当前版本**不能**宣称"异常中断后也严格最多三次"。接入真实 `dsh` 前必须先实现
「执行前持久预留尝试次数 + 启动时把未完成尝试标记为 interrupted 并转人工确认」。

## 5. 结果报告 `[DSH-RESULT]`

字段：`task_id / pr_number / base_sha / new_sha / status / attempts / started_at / finished_at`，
正文附测试结果与错误摘要。默认只在 dry-run 里生成文本，**不发布到 PR**。

## 6. 如何授权真实执行（需教师两次确认）

1. **第一次**：确认工作区隔离与测试通过后，再新增真实 `dsh` 调用（当前未接线）。
2. **第二次**：确认试运行结果后，允许打开回写：
   ```js
   performWriteback({ enabled: true, dryRun: false, ... })
   ```
   并且只允许：普通 commit、非保护分支、`force: false`、PR HEAD 未变化、不自动合并。

在此之前，任何 `enabled: false` 或未授权的调用都会被拒绝并记录原因。

## 7. 安全边界

- 不做无人值守常驻；不安装高权限服务。
- 不写 `main`/`master`，不 force push，不自动合并。
- DSH 只允许 `--profile headless --json <task>`；参数与环境变量均走白名单，token 不传子进程。
- 评论内容只当任务**数据**，其中要求改变权限/目录/审批策略的文本一律不生效。
- 主工作区有未提交改动时拒绝执行。
- 本机只做出站请求，不开放入站端口；GitHub 侧不使用自托管 Runner。
