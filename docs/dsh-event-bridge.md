# GitHub → DSH 事件接收机制：可行性与安全评估

> 结论先行：本仓库是 **public**，且这台 Windows 主机承载个人数据。
> 因此**不建议**给它挂自托管 Runner；推荐用**本机出站轮询**（方案 C）作为第一版，
> 需要"秒级推送"时再升级到 **Hosted Actions + 签名中继**（方案 B）。
> 本轮只交付 dry-run 原型，不启用任何无人值守执行。

## 1. 本机能力核查

```text
$ dsh --version
0.2.1-rc.5

$ dsh --profile headless --help
Usage: dsh --profile headless [options] [task...]
Answer one task and exit; the answer goes to stdout and diagnostics to stderr.
  --json             write newline-delimited run events to stdout
  --session-id <id>  adopt the persisted Session with this id
```

**结论：支持 Headless CLI。** 具备 `dsh --profile headless "<task>"` 的一次性调用能力，
并且有 `--json` 结构化输出，足以作为将来"接收器 → 执行器"的调用接口。
本轮**没有**接入执行，只用它做可行性确认。

## 2. 三种事件推送方式对比

| | A. 私有仓库 + 自托管 Runner | B. 公有仓库 + Hosted Actions + 中继 | **C. 本机出站轮询（推荐）** |
| --- | --- | --- | --- |
| 触发链路 | GitHub → 本机 Runner 进程 | GitHub → Actions → 中继 → 本机长轮询 | 本机 → `api.github.com` 轮询 |
| 需要公网入口 | 否 | 否（中继在云上） | 否 |
| Windows 主机暴露面 | **高**：Runner 会执行工作流任意代码 | 低：主机只做出站请求 | **最低**：主机只做出站请求 |
| 前置改造 | 仓库必须转 private | 需要部署一个中继函数 + 密钥 | 无 |
| 延迟 | 秒级 | 秒~数秒 | 轮询间隔（默认 15s） |
| 成本 | 免费额度 + 运维成本 | Actions 分钟数 + 中继托管费 | ≈ 0（公开仓库 API 充足；带 token 5000 次/小时） |
| 维护复杂度 | 高（补丁、隔离、凭证轮换） | 中（多一个服务与密钥） | **低**（单进程、无依赖） |
| 离线可用 | 否 | 否 | 是（可用本地 fixture 演练） |
| 主要风险 | 工作流可读主机文件、窃取凭证；官方明确不建议在个人主机上这样用 | 中继被伪造需要签名校验；密钥泄露面变大 | 轮询延迟；token 需要最小权限 |

**官方依据**：GitHub 在 [Self-hosted runner security](https://docs.github.com/en/actions/reference/security/secure-use)
中明确提示不要把自托管 Runner 用于公共仓库——恶意 PR 可能通过工作流在 Runner 上执行任意代码。

## 3. 为什么推荐 C

1. **零入站**：不需要端口映射、内网穿透、frp/ngrok，也不需要把 Windows 暴露到公网。
2. **零额外服务**：没有中继函数、没有队列、没有第二个密钥。
3. **权限最小**：只需一个 fine-grained PAT（`Issues: Read-only` + `Pull requests: Read-only`）。
4. **可离线验收**：`--fixture` 模式完全本地跑，先证明去重/鉴权/暂停逻辑，再接网络。
5. **升级路径清晰**：接收器的校验层与"任务来源"解耦，日后要接方案 B 的中继，只需替换
   `lib/github.mjs` 这一层，校验/去重/暂停逻辑原样复用。

代价是**延迟**：默认 15 秒一次轮询。对"AI 审查完 → 本地开工"的节奏完全够用；
如果确实需要秒级，再上方案 B。

## 4. 原型范围（本 PR）

- `tools/dsh-event-bridge/`：接收器、校验、去重、暂停、状态持久化、17 项单元测试。
- **只记录**：`EXECUTES_CODE === false`，代码里没有 `spawn`/`exec`/`dsh` 调用路径。
- 任务落盘到 `inbox.jsonl`；拒绝与错误分别落 `rejected.jsonl` / `errors.jsonl`。
- `.github/workflows/dsh-event-relay.yml`：方案 B 的最小骨架，**仅手动触发**，
  默认不监听任何事件，避免在验收前产生自动行为。

## 5. 去重 / 权限 / 暂停 / 失败 设计

| 维度 | 设计 |
| --- | --- |
| 权限 | 作者白名单（默认仅 `RobateV`）+ 仓库白名单 + PR 白名单（可选） |
| 时效 | `expected_head_sha` 必须等于 PR 当前 HEAD，过期任务拒绝 |
| 格式 | `repo`/`pr_number`/`expected_head_sha`/`review_id`/`attempt` 逐项校验，非法即拒 |
| 去重 | ①评论 id 只处理一次 ②同一 PR 同一 SHA 只排一次任务 ③同一 `review_id` 计入 attempts |
| 暂停 | `state.paused` 或状态目录 `PAUSED` 文件；暂停时不消费任何事件 |
| 失败 | API 失败按间隔重试；读 PR 失败不标记已处理；单条异常隔离；写盘失败降级覆盖写 |
| 上限 | `maxAttempts` 默认 3，超出后拒绝，避免无限重试消耗额度 |

## 6. 可靠性加固（第二轮审查后）

| 问题 | 修法 |
| --- | --- |
| 只取最新 100 条，离线期间可能漏任务 | 按 `Link` 分页拉全 + 持久化 `since` 水位（回退 60s 重叠窗口）+ 首次从 bootstrap 窗口开始 |
| 状态先写、收件箱后写，中间崩溃会永久丢单 | `accept()` 改为**先 fsync 写 inbox.jsonl，再更新 state.json**；启动时从 inbox/rejected 重建去重集合 |
| 状态文件损坏后静默清空，可能重复领取 | **fail-closed**：保留损坏文件、暂停接收，必须 `--repair` 才恢复（备份后从日志重建） |
| 手动 workflow 输入插入 shell，且方案 C 不需要它 | **删除**该 workflow；`Closes #5` 改为 `Refs #5`，Issue #5 保持 OPEN |

## 7. 启用步骤（需教师授权）

1. 生成只读 fine-grained PAT（仅本仓库，Issues/Pull requests Read-only）。
2. 在本机设置 `DSH_BRIDGE_TOKEN` 等环境变量（不要写进仓库）。
3. `node receiver.mjs --once --api` 单车验证能读到评论。
4. 常驻（任务计划/服务包装器），日志落文件。
5. 让 Work 侧把输出格式改为 `[DSH-REVIEW-TASK]`（含 `expected_head_sha`）。
6. **验收通过后**，才考虑把 `inbox.jsonl` 里的任务交给 `dsh --profile headless` 执行；
   执行器需要单独的 dry-run → 隔离目录 → 人工确认三段式，不在本 PR 范围内。

## 8. 风险与未做事项

- 未实现自动执行、未接 Actions 触发、未改仓库可见性、未合并任何 PR。
- 轮询会持续消耗少量 API 配额（15s 一次 ≈ 240 次/小时，远低于 5000 上限）。
- PAT 泄露风险：令牌只读且仅限本仓库，泄漏影响面可控；仍建议 90 天轮换。
- 该机制不是教师身份体系：任何能改本机 `state.json` 的人都能伪造"已处理"记录。
