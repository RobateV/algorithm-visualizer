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

## 分页与水位（不漏任务）

- 每轮以 `since` 拉取，并按 `Link: rel="next"` **翻完所有页**（默认上限 50 页），不是只取最新 100 条。
- 只在本轮正常处理完后推进水位：`watermark = { since, lastCommentId }`，并**回退 60 秒重叠窗口**
  吸收时钟偏差与同秒边界；重复部分由评论 id 去重兜底。
- 首次运行没有水位时，从 `bootstrapDays`（默认 7 天）前开始，避免拉整库历史。
- 水位持久化在 `state.json`，重启后从上次位置继续。

## 状态损坏与修复

`state.json` 解析失败时**不覆盖、不清空**：接收器进入 fail-closed（`isPaused()` 返回 blocked），
不接收任何事件，并提示人工修复。

```bash
node receiver.mjs --repair
```

会把损坏文件备份成 `state.corrupt.<时间戳>.json`，再从 `inbox.jsonl` / `rejected.jsonl`
重建去重集合与水位。

## 写入顺序（不丢单）

`accept()` **先以 `fsync` 追加 `inbox.jsonl`，再更新 `state.json`**。
即使随后崩溃或写状态失败，重启时也能从收件箱重建"已处理"记录，任务不会丢、也不会重复执行。

## 失败处理

| 情况 | 行为 |
| --- | --- |
| GitHub API 拉取失败 | 记录 `errors.jsonl`，下轮重试，进程不退出 |
| 读取某个 PR 失败 | 该评论**不标记已处理**，下轮重试 |
| 单条评论处理抛异常 | 记录错误、跳过该条，其余继续 |
| 收件箱写入失败 | 抛错、**不标记已处理**，下轮重试 |
| 收件箱成功但状态写失败 | 重启时从 inbox 重建，视为已处理，不重复 |
| 状态文件损坏 | **fail-closed 暂停**，需 `--repair` |
| 状态文件写盘失败（Windows 占用） | 重试 5 次后降级为直接覆盖写并记录错误 |
| 同一 `review_id` 超过 `maxAttempts` | 拒绝，避免无限重试 |
| 评论分页超过 `maxPages` 仍有下一页 | **显式报错、本轮不推进水位**（不返回不完整快照） |
| 本轮任意一条处理失败 | **不推进水位**，下轮用同一 `since` 重读，靠评论 id 去重 |
| 重启 | `attempts`/`acceptedSha` 每次从 inbox 独立重算，**不会叠加** |

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_BRIDGE_TOKEN` | 空 | 只读 PAT；`--api` 模式必填 |
| `DSH_BRIDGE_REPO` | `RobateV/algorithm-visualizer` | 仓库白名单 |
| `DSH_BRIDGE_ACTORS` | `RobateV` | 作者白名单（逗号分隔） |
| `DSH_BRIDGE_ALLOWED_PRS` | `4` | 限定接受的 PR 编号；**未设置时回退 [4]**，不要靠"空值"放行全部 |
| `DSH_BRIDGE_ALLOW_ALL_PRS` | 空 | 设为 `1` 才允许放行全部 PR（显式、需授权） |
| `DSH_BRIDGE_POLL_MS` | `15000` | 轮询间隔，不得低于 5000 |
| `DSH_BRIDGE_MAX_ATTEMPTS` | `3` | 同一 `review_id` 的最大尝试次数（1–5） |
| `DSH_BRIDGE_BOOTSTRAP_DAYS` | `7` | 首次运行回溯的天数 |
| `DSH_BRIDGE_MAX_PAGES` | `50` | 单轮最多翻页数，防止异常 Link 死循环 |
| `DSH_BRIDGE_OVERLAP_SECONDS` | `60` | 水位回退的重叠窗口（秒） |
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

---

# 本地任务监听器（`local-listener.mjs`）

面向 **GitHub Issue #21 任务收件箱** 的独立入口，与上面的 PR 接收器**规则隔离**，
不要用同一套校验逻辑互相放宽。

- 收件箱：`RobateV/algorithm-visualizer` 的 Issue **#21**
- 只读阶段：**只记录任务，不执行任何代码**

## 规则

| 条件 | 要求 |
| --- | --- |
| 仓库 | 固定 `RobateV/algorithm-visualizer` |
| 位置 | Issue #21 的顶层评论 |
| 作者 | 仅 `RobateV` |
| 连通性测试 | 首行 `[LOCAL-DSH-PING]`，只记录，不建任务 |
| 任务标记 | 首行 `[LOCAL-DSH-TASK]` |
| 必填字段 | `task_id` / `branch` / `expected_sha` / `allow` / `accept` |
| 去重 | 按 `task_id` 与 `comment_id` |
| 编辑校验 | `updated_at != created_at` 的评论拒收 |
| 分支限制 | 不得以 `main`/`master` 为目标 |
| 路径限制 | `allow` 必须是仓库内相对路径，拒绝 `..` 与绝对路径 |
| 分页 | 跟随 `Link: rel="next"` 拉全；上限 50 页，超限直接报错 |
| 入队校验 | 远程分支 HEAD 必须等于 `expected_sha` 才入队 |

## 可靠性策略

### 评论分页

- 每页 100 条，按 `Link` 头继续翻页，直到没有 `rel="next"`。
- 页数上限 `MAX_COMMENT_PAGES = 50`。达到上限仍有下一页时**抛错并终止本轮**，
  不把不完整快照当作完整结果（避免漏评论）。
- API 错误信息保留状态码与响应片段，但**不会输出 token**。

### 入队前校验分支 HEAD

1. 解析出合法任务后，读取 `repos/{repo}/branches/{branch}`（分支名整体 URL 编码）。
2. 仅当远程 HEAD SHA **完全等于** `expected_sha` 时写入 pending 队列，同时记录 `headAtEnqueue`。
3. 分支不存在（404）或 SHA 不匹配 → 拒绝并把评论标记为已见，避免反复处理。
4. 网络/API 异常 → **fail-closed**：不入队、**不标记已见**，下一轮自动重试。

### 单实例锁

- 锁文件记录 `{ pid, nonce, at }`，`nonce` 每次运行随机生成。
- **所有会写状态的入口都持锁**：常驻轮询、`--once`、以及任何调用 `pollOnce()` 的路径。
  `--status` 只读，不持锁。
- 释放锁时必须 **PID 与 nonce 同时匹配**，否则不动锁文件，避免误删他人锁。
- 持锁进程存活 → 拒绝启动。
- **不做自动陈旧锁接管**：确认持有者已退出时仍 fail-closed，并提示人工执行 `--unlock`。
  原因是纯文件操作无法证明互斥——两个进程可能同时读到同一陈旧锁并互删新锁。
- `--unlock` 只删除"持有者确认已退出"或"锁已损坏"的锁；存活或状态未知一律拒绝。

### 暂停 / 恢复

`--pause` 与 `--resume` **只增删 `PAUSED` 文件**，不写 `state.json`，
因此不会与轮询写状态发生覆盖竞争。监听器在每轮开始前读取该文件。

## 失败策略一览

| 场景 | 行为 |
| --- | --- |
| 评论分页超过 50 页 | 本轮抛错，不处理任何评论 |
| Link 指向非 `api.github.com` / 非 HTTPS / 非本仓库接口 | 拒绝并停止，不发起该请求 |
| GitHub API 5xx / 网络错误 | 本轮报错，lastError 记录，下轮重试 |
| 错误响应正文含 token | 写入日志前替换为 `[REDACTED]` |
| 分支不存在 | 拒绝该任务，标记已见 |
| HEAD 与 expected_sha 不一致 | 拒绝该任务，标记已见 |
| `allow` 含绝对路径/UNC/反斜杠/`..` | 解析阶段直接判为非法任务 |
| 锁被存活进程持有 | 拒绝启动 |
| 锁损坏 / PID 未知 / 陈旧锁 | 拒绝启动（fail-closed），提示 `--unlock` |

## 用法

```powershell
cd tools\dsh-event-bridge
$env:DSH_BRIDGE_TOKEN = (gh auth token)

node local-listener.mjs --once              # 单次轮询（同样持锁）
node local-listener.mjs --interval 20       # 常驻轮询（默认 20 秒）
node local-listener.mjs --status            # 查看状态（只读，不持锁）
node local-listener.mjs --pause             # 暂停（只写 PAUSED 文件）
node local-listener.mjs --resume            # 恢复
node local-listener.mjs --unlock            # 人工清理已退出进程留下的锁
```

## 任务格式

```
[LOCAL-DSH-TASK]
task_id: 20261114-01
branch: dev/local-dsh-20261114
expected_sha: <40 位十六进制>
allow: public/lessons/binary-search.html, docs/knowledge-base/
accept: 页面无控制台报错；知识库页码可核对
---
任务详情（自然语言）
```

## 状态与日志

| 文件 | 内容 |
| --- | --- |
| `.local-state/listener-state.json` | 已见评论、任务、暂停标志、最近轮询时间 |
| `.local-state/listener.log` | 追加式日志（评论 ID、接收结果） |
| `.local-state/listener.lock` | 单实例锁 |
| `.local-state/PAUSED` | 暂停标记 |

> 整个 `.local-state/` 已在 `.gitignore` 中忽略，不会提交。

## 安全边界

- 默认只读：不调用 DSH、不修改文件、不 push。
- 单实例锁：同时只能跑一个监听器，任务串行。
- 无任务时只发一次 GitHub 请求，不调用任何模型。
- 令牌只从环境变量或 `gh auth token` 读取，不落盘、不打印。
- 监听器不开放入站端口，也不注册 GitHub self-hosted runner。

