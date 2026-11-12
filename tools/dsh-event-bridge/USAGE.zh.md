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

## 6. 授权路径概览

真实能力分两步放开，每一步都需要教师显式操作：

1. **真实 DSH 执行**：一次性授权文件 + 隔离确认，详见 §7。
2. **真实 GitHub 回写**：`performWriteback({ enabled: true, dryRun: false })`，
   且只允许普通 commit、非保护分支、`force: false`、PR HEAD 未变化、不自动合并。
   目前**未接线**。

未授权的调用一律被拒绝并记录原因。

## 7. 真实执行（M2.7，默认关闭）

> 只有教师完成隔离准备并**手工**发起时才会发生。默认没有任何自动路径能启动真实 `dsh`。

### 8.1 前置

1. 按 `docs/zh/real-run-isolation.md` 在 **Windows Sandbox 或虚拟机**里操作；
   日常账号直接跑会被拒绝（需要显式 `--isolation-confirmed` 表示你已逐项确认）。
2. 用接收器拿到任务的 `commentId / headSha / bodyDigest`（`inbox.jsonl` 里已有这些字段）。
3. 起草一份一次性授权文件 `grant.json`：

```json
{
  "version": 1,
  "nonce": "任意 8 位以上随机串",
  "repo": "RobateV/algorithm-visualizer",
  "prNumber": 4,
  "headSha": "<40 位 HEAD SHA>",
  "commentId": 123456789,
  "bodyDigest": "<inbox.jsonl 中的 bodyDigest>",
  "workRoot": "<项目根>/../.dsh-worktrees",
  "maxRuns": 1,
  "issuedAt": "2026-11-12T10:00:00Z",
  "expiresAt": "2026-11-12T12:00:00Z"
}
```

有效期不得超过 24 小时；`maxRuns` 必须是 1；**`workRoot` 必填**，必须是规范化绝对路径，
且与执行器实际使用的工作根目录完全一致（省略、空值、相对路径都会被拒绝）。

### 7.2 启动一次

```powershell
node executor.mjs --execute --real-dsh --grant .\grant.json --isolation-confirmed --state .\.local-state
```

执行器会：校验授权 → 加锁 → 准备工作区 → **先写 `reserved` 预留** → **消费授权（改名）** →
启动 `dsh`（**严格一次，失败/超时都不重试**）→ 检查副作用 → 记录结果。

首次 one-shot 的任务契约会明确禁止 `git commit` / `push` / PR 评论 / `merge` / 部署，
只允许改动 `tests/automation-smoke/` 下的文件；执行后**本地校验** `HEAD` 未变、
改动路径都在允许范围内，越界即判失败并留痕。

### 8.3 查看结果

| 文件 | 内容 |
| --- | --- |
| `<state>/results.jsonl` | 每次执行的状态、`mode`（`mock`/`real`）、尝试次数 |
| `<state>/errors.jsonl` | 异常与熔断记录 |
| `<worktree>` | 实际文件改动（本轮不 commit、不 push） |

判断成功**不要只看 DSH 自述**：检查 worktree 里实际产生了哪些文件改动。

### 8.4 停止与清理

```powershell
node executor.mjs --pause --state .\.local-state     # 立即暂停后续执行
```

清理：删除 worktree 目录（`git worktree prune`）、删除状态目录、销毁沙箱/回滚快照。

### 8.5 崩溃后

若进程被强杀，`results.jsonl` 会留下 `reserved` 记录。下次启动会自动标记为 `interrupted`
并**暂停**，必须人工检查 worktree 与日志后执行 `--resume` 才能继续——不会自动重跑。

## 8. 安全边界（不变）

- 不做无人值守常驻；不安装高权限服务。
- 不写 `main`/`master`，不 force push，不自动合并。
- DSH 只允许 `--profile headless --json <task>`；参数与环境变量均走白名单，token 不传子进程。
- 评论内容只当任务**数据**，其中要求改变权限/目录/审批策略的文本一律不生效。
- 主工作区有未提交改动时拒绝执行。
- 本机只做出站请求，不开放入站端口；GitHub 侧不使用自托管 Runner。
