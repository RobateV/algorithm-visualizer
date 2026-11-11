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
public/favicon.svg  站点图标
```

## 内容来源与许可

理论讲解文字依据 [OI Wiki](https://oi-wiki.org/) 整理而来，遵循 **CC BY-SA 4.0**。仓库不再内置 OI Wiki 本地镜像，署名与再发布要求详见 [OI-WIKI-NOTICE.md](OI-WIKI-NOTICE.md)。

仓库目前未包含 `LICENSE` 文件。若希望他人可自由复用代码，建议补充一份开源许可证（例如 MIT）；注意理论讲解等 OI Wiki 衍生文字仍受 CC BY-SA 4.0 约束，不能随代码一并改为更宽松的许可。
