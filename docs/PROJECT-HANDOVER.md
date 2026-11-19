# algorithm-visualizer 项目交接文档

> **交接日期：** 2026-11-19  
> **仓库：** https://github.com/RobateV/algorithm-visualizer  
> **协作方式：** ChatGPT 独立分析与审查 + 本地 DSH 开发 + GitHub 人工中转  
> **用途：** 后续 ChatGPT 窗口的项目入口。新窗口先读本文件并核对 GitHub 最新状态，不要求用户重新整理长篇交接内容。

---

## 0. 新窗口接手说明

请先阅读本文件，然后：

1. 读取 PR #26 当前状态、最新 HEAD、完整讨论和最新审查意见。
2. 读取对应 HEAD 下的 docs/knowledge-base/INTERNALIZATION-STATUS.md。
3. 将本文件中的状态与 GitHub 实际状态核对；若 HEAD 已变化，以 GitHub 最新实际内容为准，并说明差异。
4. 当前预期任务是 **PR #26 第四轮返工后的独立复审**。若 HEAD 仍为 977ec7cebfb171ae9b4fb16f5be8511c49614be9，先给用户一份可直接转交 DSH 的返工指令，不要跳去整理 0x03。
5. 不要仅凭 DSH 的自我汇报验收；必须读取真实文件、diff 和完整 SHA。
6. 不要自行合并 PR，不要修改 main，不要恢复已放弃的自动化方案。

**PR #26：** https://github.com/RobateV/algorithm-visualizer/pull/26  
**当前内化报告：** https://github.com/RobateV/algorithm-visualizer/blob/977ec7cebfb171ae9b4fb16f5be8511c49614be9/docs/knowledge-base/INTERNALIZATION-STATUS.md

---

## 1. 项目目标

建设一套面向信息学竞赛教学的算法可视化网页：

- PPT 式原理讲解；
- 算法执行过程动画；
- 动画与代码同步展示；
- 交互式算法体验；
- 教师能够修改讲解文字和教学内容；
- 逐步整理《算法竞赛进阶指南》，形成可靠的算法知识库，为网页课程开发提供内容基础。

知识库不是简单摘要。每章需要覆盖核心概念、算法原理、关键性质、适用条件、正确性证明或关键推导、复杂度、实现细节、易错点、算法联系及教学可视化价值。

来源标记必须区分：

- [BOOK]：原书明确内容；
- [DERIVED]：推导结论；
- [MY-NOTE]：整理者补充；
- [?]：尚未确认，不能作为已证实结论。

不得把推导或猜测伪装成原书结论。

## 2. 固定协作模式

当前只使用人工中转流程：

**ChatGPT 制定任务 → 用户传递指令 → 本地 DSH 开发 → DSH 推送 GitHub → ChatGPT 独立审查 → 用户传递修改意见 → DSH 返工。**

职责：

- **ChatGPT：** 分析需求、设计方案、编写 DSH 指令、读取 GitHub 实际文件并独立审查。
- **DSH：** 本地开发、知识整理、运行本地测试、提交并推送。
- **用户：** 在双方之间传递指令并作最终决策。

特别约定：

- 审查必须绑定完整 commit SHA。
- 必须读取 GitHub 上对应 SHA 的真实文件、diff 和必要上下文。
- DSH 的测试报告只能作为线索，不能替代独立审查。
- 不得声称本地测试已由 ChatGPT 独立重跑。
- 不得将空的 GitHub Actions 状态说成 CI 通过。

## 3. 自动化方案已经停止

此前尝试的 local-runner、local-listener、local-service、browser-relay、浏览器通知扩展、自动执行/回传/返工方案均已放弃。

| 组件 | 当前状态 |
| --- | --- |
| 本地 DSH Desktop | 保留 |
| GitHub / Git CLI | 保留 |
| 本地 Git 仓库 | 保留 |
| ChatGPT GitHub 连接 | 保留 |
| local-listener | 停止 |
| local-service | 停止 |
| browser-relay | 停止 |
| 浏览器通知扩展 | 关闭 |
| DSH 自动执行 | 不启用 |
| 自动 Push / 自动回传 | 不启用 |
| 自动返工 | 不启用 |

此前两个每小时自动化任务已暂停。**不要重新搭建自动化闭环，不要把时间花在自动化基础设施上。**

## 4. 仓库与分支保护

仓库：**RobateV/algorithm-visualizer**

本次交接文档所在分支：

- 分支：docs/project-handover-20261119
- 创建基点：当时 main 的 8eba606098e2911e3606c3e9ea292170a203efe7
- 文件：docs/PROJECT-HANDOVER.md

该分支是为了保存交接文档而单独创建的，**没有修改 main，也没有修改 PR #26 或 PR #23**。本交接文档当前只在该分支上，尚未合并；新窗口可直接读取本文件链接。

当前默认分支为 main。除非用户明确授权，不要把交接文档分支合并到 main。

---

## 5. GitHub 当前项目状态

### 5.1 PR #23：自动化基础设施实验

链接：https://github.com/RobateV/algorithm-visualizer/pull/23

本次核查状态：

- Open；
- Draft；
- 未合并；
- 最新 HEAD：ff956fee427397220f909fa34588bd30d5070584；
- 属于此前自动化闭环实验的历史记录。

此前附件安全审查覆盖了文件活动记录、上传状态检查、发送前再次检查等逻辑，但真实 ChatGPT composer 外层 DOM 是否完全覆盖未得到验证。由于自动化方案已经正式放弃，**PR #23 暂时保留，不继续投入，不修改、不合并**。

### 5.2 PR #26：《算法竞赛进阶指南》第一轮内化

链接：https://github.com/RobateV/algorithm-visualizer/pull/26

本次核查得到的实际状态：

| 项目 | 实际状态 |
| --- | --- |
| PR | #26 |
| 状态 | Open |
| Draft | 是 |
| 已合并 | 否 |
| 开发分支 | docs/kb-internalization-20261118 |
| Base | dev/local-dsh-20261114 |
| 最新 HEAD | 977ec7cebfb171ae9b4fb16f5be8511c49614be9 |
| GitHub 变更文件数 | 1 |
| GitHub 新增行数 | 566 |
| 新增文件 | docs/knowledge-base/INTERNALIZATION-STATUS.md |

注意：PR 描述正文仍写着该文件 404 行，这是旧描述；当前 GitHub PR 统计为新增 566 行，读取到的文件为 567 行。不要把旧 PR 描述中的 404 行当作当前版本。

**当前结论：PR #26 尚未通过第三轮独立审查，必须继续返工。保持 Draft，不合并。**

---

## 6. PR #26 三轮审查历史

### 第一轮

审查绑定 SHA：

**effbe8e3f194245eebe7377adc2716155b5c3df9**

主要问题：

1. 章节总数、一级块数和未完成数统计口径混乱；
2. 补码加法与位运算“不进位”概念混淆；
3. 64 位乘法把有符号溢出描述成可依赖的模运算，忽略标准 C++ 的 UB 和平台精度差异；
4. 64 位乘法两种方法的复杂度混淆；
5. 三分法适用条件描述不精确。

第一轮独立审查结论：不通过，要求返工。

### 第二轮

审查绑定 SHA：

**d398d1a069113139dee12485faf2ca45c559dfad**

已基本解决：

- 补码逐位进位与最高位溢出进位的区别；
- 方法一 O(log b)、方法二 O(1) 的复杂度拆分；
- 三分法单峰/单谷的前提；
- 64 位乘法输入约简、unsigned 转换时机等部分问题。

仍需修订：

- book-outline.md 的 82 条记录应解释为 9 个一级块标题 + 73 条二级章节记录；
- 61 条未整理正文的编号清单需要排除总结章与附录，避免重复计数；
- 64 位乘法估商误差和校正前提需要更严谨。

第二轮独立审查结论：仍不通过。

### 第三轮

审查绑定 SHA：

**977ec7cebfb171ae9b4fb16f5be8511c49614be9**

第三轮审查链接：

https://github.com/RobateV/algorithm-visualizer/pull/26#pullrequestreview-5952134748

DSH 第三轮返工报告：

https://github.com/RobateV/algorithm-visualizer/pull/26#issuecomment-6971354323

**第三轮已通过的内容：**

- 目录计数已正确区分：82 条目录记录 = 9 个一级块标题 + 73 个二级章节；
- chapter-status.md 的 73 条章节编号与 book-outline.md 的 73 条二级章节逐项一致；
- 65 个正文章节 = 73 − 7 个总结章 − 1 个附录；
- 已整理 3 章后，未整理正文 62 章；将 0x03 单列后其余 61 章；
- 61 + 1（0x03）+ 7（总结章）+ 1（附录）= 70 条未开始；
- 补码逐位进位与最高位溢出进位已区分；
- 两种 64 位乘法方法的复杂度已区分；
- 三分法条件已按单峰/单谷及两侧单调性重新描述。

**第三轮仍未通过，剩余三个问题：**

#### 问题 A：x87 80-bit long double 的误差证明不完整

当前报告直接写出：

\(p \cdot 2^{-63} < 1/8\)

但没有写出完整的浮点模型和舍入过程。

第三轮审查要求明确这些前提：

- 输入约简后 \(0 \le a,b < p \le 10^{18} < 2^{60}\)；
- a、b、p 均小于 2^60，因此能被 64 位 significand 精确表示；
- 使用 x87 80-bit 扩展精度 long double；
- 采用 round-to-nearest；
- 乘法、除法分别进行一次 80-bit 舍入；
- 中间结果没有被降精度存储或编译选项改写。

建议按如下思路写出推导：

设 \(u = 2^{-64}\)，乘法和除法分别产生相对舍入误差 \(\delta_1\)、\(\delta_2\)，且 \(|\delta_1|, |\delta_2| \le u\)。

浮点估商可表示为：

\(\mathrm{fl}(\mathrm{fl}(a \cdot b)/p) = (a \cdot b/p)(1+\delta_1)(1+\delta_2)\)

因此相对误差不超过：

\(2u + u^2 < 2^{-63}\)

又因为 \(a \cdot b/p < p < 2^{60}\)，绝对误差小于：

\(p \cdot 2^{-63} < 1/8\)

这才可以支撑估商截断后与真实整数商最多相差 1，以及后续单步校正的结论。

如果目标编译器、浮点舍入模式或中间精度不满足上述前提，必须明确说明该推导不适用，不能宣称为无条件保证。

#### 问题 B：IEEE double 的误差上界写得不严谨

当前表格写：

\( \approx 2^{60} \cdot 2^{-52} = 256 \)

但没有完整计入：

- a、b、p 从整数转 double 的舍入；
- 浮点乘法的舍入；
- 浮点除法的舍入。

因此 256 不能继续称为完整的“绝对误差上界”。

处理方式：

- 如果能够给出覆盖全部舍入步骤的保守推导，就明确写出模型、每步误差和最终界；
- 如果不能严格证明，就将其改成“粗略量级估计”或“实验观察”，并从“上界”列中移除；
- 可以保留 double 不能保证单步校正的结论，但不能把实验最大误差当作理论上界。

第三轮审查评论中给出的保守数量级参考为：

\(4 \cdot 2^{-53} \cdot 2^{60} \approx 512\)

但不要不加推导就直接把 512 当作已证明的严格上界。

#### 问题 C：原有 0x01 章节中的 long long 旧说法

实际读取了原有文件：

**docs/knowledge-base/chapters/0x00-basic-algorithms/0x01-bit-manipulation.md**

其中：

- §3.5「64 位整数乘法」仍写使用 long long 保存乘积差；
- §4.2「64 位乘法为什么能用溢出」仍写“所以用 long long 保存即可”。

这与标准 C++ 的有符号整数溢出规则冲突。标准 C++ 中 signed overflow 是未定义行为，不能当作自动模 2^64。

现代 C++ 的安全实现必须：

- 使用 unsigned long long；
- 在乘法之前将操作数转换为 unsigned；
- 不能先执行 signed 乘法，再把结果强转为 unsigned。

PR #26 原定范围是只新增 INTERNALIZATION-STATUS.md，不修改既有章节。因此这是一个**审查意见与原任务范围之间的待明确事项**：

1. 不要让 DSH 擅自扩大 PR 范围；
2. 先在 INTERNALIZATION-STATUS.md 中明确指出原有章节 §3.5 / §4.2 的旧说法属于原书/旧实现描述，不是现代标准 C++ 的可执行建议，并交叉引用报告中的 unsigned 安全实现；
3. 如果要直接修改原有 0x01 章节，先由 ChatGPT 向用户说明这会把 PR 从 1 个文件扩展为 2 个文件，取得用户明确同意后再做；
4. 不得让旧说法继续与新增报告中的现代 C++ 结论互相矛盾。

---

## 7. 当前应该执行的下一步

**当前任务：PR #26 第四轮返工。**

在用户将以下指令传给 DSH 后，DSH 才开始操作。

### 给 DSH 的任务指令

~~~text
继续 PR #26《算法竞赛进阶指南》第一轮内化报告的第四轮修订。

仓库：RobateV/algorithm-visualizer
PR：#26
开发分支：docs/kb-internalization-20261118
当前基准 HEAD：
977ec7cebfb171ae9b4fb16f5be8511c49614be9

开始前必须先 fetch 并确认本地分支 HEAD 与上述 SHA 一致。如果远程 HEAD 已变化，立即停止并报告，不要覆盖他人提交。

本轮目标：只处理第三轮独立审查剩余的三个问题：
1. x87 80-bit long double 估商误差推导缺少明确的浮点模型和舍入步骤；
2. double 的“绝对误差上界约 256”不成立为当前已证明上界；
3. 原有 0x01 章节 §3.5 / §4.2 仍把 long long 溢出写成可依赖的模 2^64 行为，和现代标准 C++ 说明冲突。

具体要求：
- 80-bit 推导必须明确输入约简、整数精确表示、round-to-nearest、x87 80-bit 64-bit significand、乘法和除法各一次舍入、中间精度不被降级等前提。
- 给出 δ1、δ2 的相对误差推导，解释为什么绝对误差小于 1/8，以及为什么估商截断后最多偏 1，才能使用单步校正。
- double 的 256 不得继续冒充严格上界。要么补完整保守证明，要么降格为粗略估计/实验观察，明确不构成上界。
- 说明原有 0x01 §3.5 / §4.2 的 long long 写法属于旧表述，不是现代标准 C++ 的安全实现；交叉引用 unsigned 安全实现。
- 对是否直接修改原有 0x01 章节文件，先不要擅自扩大范围。当前 PR 原定仅修改 INTERNALIZATION-STATUS.md；如确实认为必须改章节文件，先向用户/ChatGPT 报告并等待明确授权。

本轮边界：
- 不读教材 PDF、扫描页或 OCR。
- 不调用其他模型处理教材内容。
- 不修改 main。
- 不合并 PR #26。
- 不修改 PR #23。
- 不恢复任何自动化任务或服务。
- 除非获得明确授权，不修改其他章节 Markdown、索引文件、业务代码或项目网页。

完成后：
1. 运行 git diff --check；
2. 检查 Markdown 表格列数；
3. 复核所有数学公式、浮点误差条件、unsigned 运算和校正逻辑；
4. 确认本轮实际改动文件及 diff；
5. 提交并推送到原 PR 分支；
6. 给出新的完整 commit SHA；
7. 在 PR #26 发布简洁交付报告，说明每个审查问题如何处理、测试命令与结果、未处理事项；
8. 保持 PR Draft，不合并。

不要把本地测试描述成 ChatGPT 独立验证，也不要宣称 GitHub CI 通过。
完成后等待 ChatGPT 绑定新 SHA 独立复审。
~~~

---

## 8. ChatGPT 第四轮独立审查要求

DSH 提交新 SHA 后，ChatGPT 应：

1. 先确认 PR #26 最新 HEAD 是否就是 DSH 提供的完整 SHA；
2. 读取该 SHA 的 INTERNALIZATION-STATUS.md 完整内容和相对上一 SHA 的 diff；
3. 对照第三轮审查的三个遗留问题逐项验收；
4. 必要时独立推导浮点误差界，不能只看 DSH 的证明文字；
5. 检查原有 0x01 章节与新增状态报告是否仍有相互矛盾的描述；
6. 检查是否超出本轮授权文件范围；
7. 给出明确结论：通过 / 不通过，以及精确的剩余问题。

如果仍有问题，给 DSH 一份范围明确、可执行的返工指令。若通过，先报告审查通过，再由用户决定 PR 后续处理；不要自行合并。

本次对 SHA 977ec7... 的 GitHub 核查显示：
- PR #26 仍为 Open / Draft；
- GitHub Actions workflow runs 为空；
- combined status 为空。
因此没有 GitHub CI 通过的证据。

---

## 9. 知识库现状与后续路线

当前知识库中已有章节文档：

- 0x01 位运算；
- 0x02 递推与递归；
- 0x04 二分。

0x03 前缀和与差分**没有章节文档**，chapter-status.md 记录为未开始。不要根据记忆或猜测补写。

当前报告发现的底层索引问题：

- book-outline.md：82 条包含 "| 0x" 的记录 = 9 个一级块标题 + 73 条二级章节记录；
- chapter-status.md：73 条章节记录；
- 两者的 73 条二级章节编号逐项一致；
- 两个文件末尾汇总仍写 55 / 52，与实际记录数不符；
- concept-index.md 末尾把 0x01–0x03 都标为未开始，与 0x01、0x02 已有文档矛盾。

这些问题已在 PR #26 报告中记录，但没有修改底层索引。建议单独立项修复，不要混入本轮第四次返工。

PR #26 通过后，再规划下一轮：
1. 先明确是否单独修复索引统计与概念索引状态；
2. 再处理 0x03 前缀和与差分；
3. 后续补齐 0x05 排序、0x06 倍增、0x07 贪心；
4. 按知识依赖逐步推进 0x10、0x20 等章节。

**教材材料限制仍然有效：**
- 不上传原始教材 PDF；
- 不上传扫描页；
- 不发送完整 OCR；
- 不擅自将 OCR 内容交给其他模型；
- 教材 OCR 的读取、发送或处理必须由用户单独明确授权；
- 目前第一轮只允许基于已经整理好的 Markdown 开展工作。

---

## 10. 重要链接

| 内容 | 链接 |
| --- | --- |
| GitHub 仓库 | https://github.com/RobateV/algorithm-visualizer |
| PR #23 自动化实验 | https://github.com/RobateV/algorithm-visualizer/pull/23 |
| PR #26 第一轮内化 | https://github.com/RobateV/algorithm-visualizer/pull/26 |
| PR #26 第三轮审查 | https://github.com/RobateV/algorithm-visualizer/pull/26#pullrequestreview-5952134748 |
| PR #26 第三轮返工报告 | https://github.com/RobateV/algorithm-visualizer/pull/26#issuecomment-6971354323 |
| 当前内化状态文档 | https://github.com/RobateV/algorithm-visualizer/blob/977ec7cebfb171ae9b4fb16f5be8511c49614be9/docs/knowledge-base/INTERNALIZATION-STATUS.md |
| 原有 0x01 章节 | https://github.com/RobateV/algorithm-visualizer/blob/dev/local-dsh-20261114/docs/knowledge-base/chapters/0x00-basic-algorithms/0x01-bit-manipulation.md |
| 章节进度表 | https://github.com/RobateV/algorithm-visualizer/blob/dev/local-dsh-20261114/docs/knowledge-base/chapter-status.md |
| 概念索引 | https://github.com/RobateV/algorithm-visualizer/blob/dev/local-dsh-20261114/docs/knowledge-base/concept-index.md |

---

**交接结论：当前唯一优先任务是完成 PR #26 第四轮返工并接受独立复审。PR #23 保持历史实验状态；自动化方案不再恢复；main 不修改；PR #26 不合并；教材 PDF/OCR 不处理。**
