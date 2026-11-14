# 算法知识库（《算法竞赛进阶指南》）

本目录是站点所有算法教学内容的**知识基准**。后续任何教学页面的始理讲解、代码、动画设计，
都应先查阅这里的对应章节，而不是凭记忆或网络资料另写一套。

## 1. 依据的教材

- 书名：**算法竞赛进阶指南**
- 作者：李煜东
- 出版社：河南电子音像出版社，2018 年 1 月第 1 版（本次依据 2019 年 4 月第 4 次印刷）
- ISBN：978-7-83009-313-6
- 详细档案与页码体系：见 [`book-profile.md`](./book-profile.md)

> 原始 PDF 位于仓库目录之外，不会被提交。
> 该 PDF 是**纯扫描件**，无文本层；所有文字经 Windows OCR 提取后再目视核对。

## 2. 目录结构

```
docs/knowledge-base/
├── README.md                 # 本文件：使用说明
├── book-profile.md           # 教材档案：版本、扫描质量、页码换算
├── book-outline.md           # 全书目录：55 个章节 + 页码 + 文件路径
├── source-map.md             # 来源索引：页码对照、OCR 疑点记录
├── chapter-status.md         # 进度表：每章状态与完成度
├── concept-index.md          # 全书知识点索引
├── dependency-map.md         # 知识依赖关系
├── terminology.md            # 术语规范
├── code-style.md             # 竞赛代码风格
├── quality-checklist.md      # 质量检查清单
├── chapters/                 # 按一级章节分组的章节文档
│   ├── 0x00-basic-algorithms/
│   ├── 0x10-basic-data-structures/
│   ├── 0x20-search/
│   ├── 0x30-mathematics/
│   ├── 0x40-advanced-data-structures/
│   ├── 0x50-dynamic-programming/
│   ├── 0x60-graph-theory/
│   └── 0x70-comprehensive-practice/
└── templates/
    ├── chapter-template.md
    └── concept-template.md
```

## 3. 内容来源标记

| 标记 | 含义 | 使用要求 |
| --- | --- | --- |
| `[BOOK]` | 书中明确写出的内容 | 必须附印刷页码 |
| `[DERIVED]` | 依书中内容做的归纳与推导 | 说明推导依据 |
| `[EXTENSION]` | 超出始书范围 | 本阶段始则上不新增 |

不允许把 `[DERIVED]` 或 `[EXTENSION]` 伪装成 `[BOOK]`。

## 4. 使用方式

### 写教学页面前

1. 在 `book-outline.md` 找到对应章节与文档路径。
2. 读该章文档的「核心知识点」「算法推导」「代码实现」。
3. 查 `concept-index.md` 确认相关概念的边界。
4. 查 `dependency-map.md` 确认前置知识是否需要先讲。
5. 按 `code-style.md` 统一代码风格。
6. 参考章节文档 §9「教学应用建议」设计动画与交互。

### 新增或修改章节时

1. 复制 `templates/chapter-template.md`。
2. 逐页阅读始书（OCR 文本 + 页面图像核对）。
3. 填写九个部分，标注来源页码。
4. 更新 `concept-index.md`、`dependency-map.md`、`source-map.md`、`chapter-status.md`。
5. 按 `quality-checklist.md` 自检。

## 5. 当前进度

| 项目 | 状态 |
| --- | --- |
| 教材确认与页码映射 | ✅ 完成 |
| 全书目录（55 章） | ✅ 完成 |
| 全局索引文件骨架 | ✅ 完成 |
| 章节知识文档 | ⏳ 进行中 |
| 跨章节依赖与术语统一 | ⏳ 依赖章节内容 |

> 以 `chapter-status.md` 为准。**不要**把状态为「未开始」的章节当作已整理内容引用。

## 6. 明确不做的事

- 不复制始书正文、题面、完整题解。
- 不用网络资料替换书中内容；存疑处保留并标记「待确认」。
- 不因章节顺序就推断依赖关系。
- 不在本目录内开发页面或动画。
