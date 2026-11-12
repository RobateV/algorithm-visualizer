# DSH 事件接收器（dry-run 原型）

把「GitHub 上出现 `[DSH-REVIEW-TASK]` 评论」变成「本机收到一条待办任务」。

> **当前版本只记录任务，不执行任何代码。**
> 接收器里没有任何 `spawn` / `exec` / `dsh` 调用路径（`EXECUTES_CODE === false` 由测试断言）。
> 真正的自动执行要等教师验收后再单独开启。

## 它做什么

```
GitHub 评论 ──(本机出站轮询 REST API)──▶ 接收器
                                        │
                                        ├─ 校验：仓库 / 作者 / 标记 / 格式 / PR 状态 / HEAD SHA
                                        ├─ 去重：评论 id + PR+SHA 两个维度
                                        ├─ 暂停：state.paused 或 PAUSED 文件
                                        └─ 记录：inbox.jsonl / rejected.jsonl / errors.jsonl
```

没有入站端口、没有常驻 Runner、没有第三方中继。只有本机向 `api.github.com` 发起的出站请求。

## 快速演练（不联网、不需要 token）

```bash
cd tools/dsh-event-bridge
node receiver.mjs --once --fixture fixtures/sample-comments.json --state .demo-state
node receiver.mjs --once --fixture fixtures/sample-comments.json --state .demo-state   # 再跑一次
```

第一次应看到 `✓ 收到任务 work-2026-11-12-001 / PR #4 / SHA c7b172f`，
第二次同样的 5 条评论全部变成 `duplicate-comment`，`inbox.jsonl` 仍然只有 1 条记录。

## 单元测试

```bash
cd tools/dsh-event-bridge
node --test          # 17 项：解析、校验、去重、暂停、重试上限、失败隔离
```

## 接真实 GitHub（仍需教师授权后才做）

1. **创建只读令牌**：GitHub → Settings → Developer settings → Fine-grained tokens
   - 仓库访问：只勾 `RobateV/algorithm-visualizer`
   - 权限：`Issues: Read-only`（读取 PR 评论需要）+ `Pull requests: Read-only`（读取 HEAD SHA）
   - 有效期建议 90 天，到期轮换
2. **设置环境变量**（当前 PowerShell 会话）：

   ```powershell
   $env:DSH_BRIDGE_TOKEN  = '<fine-grained-pat>'
   $env:DSH_BRIDGE_REPO   = 'RobateV/algorithm-visualizer'
   $env:DSH_BRIDGE_ACTORS = 'RobateV'
   $env:DSH_BRIDGE_ALLOWED_PRS = '4'      # 可选，限定 PR
   $env:DSH_BRIDGE_POLL_MS = '15000'
   $env:DSH_BRIDGE_STATE_DIR = 'E:\算法可视化\.dsh-bridge-state'
   ```

3. **先跑一次单车**：

   ```powershell
   node receiver.mjs --once --api
   ```

4. **常驻**：把它放进 Windows 任务计划（登录时启动）或 `nssm` 之类的服务包装器；
   Ctrl-C 会正常退出。日志重定向到文件即可，不需要守护进程框架。

## 暂停与恢复

```bash
node receiver.mjs --pause     # 写 state.paused = true
node receiver.mjs --resume
```

也可以直接在状态目录放一个空文件 `PAUSED`，删掉即恢复——适合教师在课堂上临时刹车。

## 失败处理

| 情况 | 行为 |
| --- | --- |
| GitHub API 拉取失败 | 记录 `errors.jsonl`，按 `pollIntervalMs` 下轮重试，进程不退出 |
| 读取某个 PR 失败 | 该评论**不标记已处理**，下轮重试 |
| 单条评论处理抛异常 | 记录错误、跳过该条，其余评论继续 |
| 状态文件写盘失败（Windows 占用） | 重试 5 次后降级为直接覆盖写，并记录 `save-state` 错误 |
| 同一 `review_id` 超过 `maxAttempts` | 拒绝，避免无限重试 |
| 状态文件损坏 | 留档错误后从空状态重建，不阻塞启动 |

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_BRIDGE_TOKEN` | 空 | 只读 PAT；`--api` 模式必填 |
| `DSH_BRIDGE_REPO` | `RobateV/algorithm-visualizer` | 仓库白名单 |
| `DSH_BRIDGE_ACTORS` | `RobateV` | 作者白名单（逗号分隔） |
| `DSH_BRIDGE_ALLOWED_PRS` | 空（不限制） | 限定接受的 PR 编号 |
| `DSH_BRIDGE_POLL_MS` | `15000` | 轮询间隔，不得低于 5000 |
| `DSH_BRIDGE_MAX_ATTEMPTS` | `3` | 同一 `review_id` 的最大尝试次数（1–5） |
| `DSH_BRIDGE_STATE_DIR` | `.dsh-bridge-state` | 状态目录（需可写） |

## 任务格式

```
[DSH-REVIEW-TASK]
repo: RobateV/algorithm-visualizer
pr_number: 4
expected_head_sha: c7b172fea1bde714f758df1e875340a1681e7d4e
review_id: work-2026-11-12-001
attempt: 1
---
## 问题
...
## 验收标准
...
```

任一字段缺失或不合法都会被拒绝，并在 `rejected.jsonl` 记录原因。

## 安全边界

- 只接受**作者白名单**内的评论；其他人发的任务直接拒绝。
- 只接受**仓库白名单**内的评论（防止误配到别的仓库）。
- `expected_head_sha` 必须等于 PR **当前** HEAD，过期任务拒绝。
- 评论正文按纯文本解析，不做任何 HTML/脚本求值。
- 状态目录与令牌都不进版本库（见根 `.gitignore`）。
- 本版本不执行代码；即便将来接执行，也应在隔离目录内、以一次性任务运行。
