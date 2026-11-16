# 信奥算法地图 · 算法可视化课堂

面向信息学奥赛（信奥）教学的算法可视化站点。左侧按「算法基础 / 搜索 / 动态规划 / 字符串 / 数学 / 数据结构 / 图论 / 进阶专题」组织知识地图，右侧给出理论讲解、复杂度对比，以及与当前知识点对应的可交互课堂教具。

## 功能

- **知识地图**：分类 → 知识点 → 算法 三级导航，支持站内搜索。
- **理论讲解**：每个知识点包含导语与若干核心概念卡片；排序章节额外提供复杂度与稳定性对比表。
- **互动教具**：`public/lessons/` 下是独立的单页 HTML 教具，以 iframe 嵌入首页对应算法，可全屏打开，并通过 `postMessage` 与首页同步全屏状态。
- **OI Wiki 原文跳转**：每个知识点直接链接 OI Wiki 官方对应章节，不依赖本地镜像。

## 已实现的教具

| 教具 | 对应知识点 | 文件 |
| --- | --- | --- |
| 七种排序对比 | 排序 | `public/lessons/sorting.html` |
| 二分查找 / 二分答案 / 实数二分 | 二分 | `public/lessons/binary-search.html` |
| 一维前缀和 / 二维前缀和 / 差分 | 前缀和与差分 | `public/lessons/prefix-sum-difference.html` |
| 区间选择 / 构造贪心 | 贪心 | `public/lessons/greedy.html` |
| KMP / 前缀函数 | 字符串匹配 | `public/lessons/kmp.html` |
| 链表与数组模拟链表 | 线性表 | `public/lessons/linked-list.html` |
| 栈与队列 | 线性表 | `public/lessons/stack-queue.html` |
| 前向星 | 图的存储 | `public/lessons/forward-star.html` |
| 综合演练台 | 算法基础 | `public/lessons/algorithm-lab.html` |

## 技术栈

- React 19 + TypeScript
- [vinext](https://github.com/cloudflare/vinext) 构建（Vite + Cloudflare Workers 的 Next 兼容层），产物可运行在 Cloudflare Workers
- Tailwind CSS 4，组件风格参考 shadcn/ui
- 代码检查与格式化：oxlint、oxfmt

## 本地运行

需要 Node.js >= 22.13.0。

```bash
npm install
npm run dev
```

开发服务器启动后，打开终端提示的本地地址即可。

其他命令：

```bash
npm run build    # 生产构建，产物在 dist/
npm run start    # 用 wrangler 本地预览构建产物
npm run lint     # oxlint 检查
npm run format   # oxfmt 格式化
```

## 目录结构

```
app/                首页：知识地图、理论面板、教具容器
components/ui/      shadcn 风格基础组件
hooks/ lib/         自定义 hook 与工具函数
public/lessons/     独立的可交互教具页面（纯 HTML / JS，无构建依赖）
docs/m1/            M1 课件的实际页面截图
tests/              浏览器自动化回归测试（CDP 驱动真实 Chrome）
public/favicon.svg  站点图标
```

## 教师编辑模式（M2）

冒泡排序课件内置可视化编辑器，**不需要改源代码**：点击右上角「✏️ 编辑课件」进入编辑模式，所有可编辑文字会显示蓝色虚线框，点一下就能改。

- **可直接修改**：课程标题/标签、各环节小标题、页面标题、导语、课堂问题、观察提示、按钮文字、原理讲解的标题与正文、图示说明、总结要点、练习题题干/选项/解析。
- **基础排版**：选中文字后可设置字号（小/中/大/特大）、字重（常规/加粗）和文字颜色；样式只通过白名单 CSS 类渲染，不写入任意 CSS 字符串。
- **保存**：修改即时写入内存课程数据，并自动保存到浏览器 `localStorage`（带版本号与数据校验）；界面右下角显示「已保存 / 未保存 / 保存失败」。
- **导出 / 导入**：可导出为 JSON 文件备份或分享，导入时会校验格式、版本、课程 ID、字段白名单与长度上限；导入内容一律按纯文本渲染，不会执行 HTML 或脚本。
- **恢复默认**：二次确认后清除本地修改，回到内置课件。
- **只读部分**：算法执行状态说明（如「检测到逆序，执行 swap…」）、C++ 代码高亮、步进编号属于运行时数据，不提供编辑，也不会被文案修改影响。

### 当前限制

- **仅保存在当前浏览器**：数据存在本机 `localStorage`，换电脑、换浏览器或清理站点数据都会丢失；其他学生**不会**自动看到修改。需要多人共用时，请用「导出 JSON」发给对方手动导入。
- **没有教师身份验证**：编辑模式只是本地界面开关，不等于账号权限体系，不能替代 Moodle 的教师角色校验。
- 编辑模式只覆盖冒泡排序课件；其余六种算法为「经典演示」，不提供文案编辑。
- 文字中的成对反引号（如 `` `arr[j]` ``）在编辑时会原样显示，保存后仍渲染为行内代码样式。

### 后续（M3 方向）

把本地 JSON 补丁接入后端存储与教师身份（Moodle 登录 + 课件版本），实现「教师改一次、全班生效」的共享课件；再在此基础上做自由拖动排版与多页素材管理。当前版本刻意只做本地保存，避免给出「已同步」的错误预期。

## 内容来源与许可

理论讲解文字依据 [OI Wiki](https://oi-wiki.org/) 整理而来，遵循 **CC BY-SA 4.0**。仓库不再内置 OI Wiki 本地镜像，署名与再发布要求详见 [OI-WIKI-NOTICE.md](OI-WIKI-NOTICE.md)。

仓库目前未包含 `LICENSE` 文件。若希望他人可自由复用代码，建议补充一份开源许可证（例如 MIT）；注意理论讲解等 OI Wiki 衍生文字仍受 CC BY-SA 4.0 约束，不能随代码一并改为更宽松的许可。
