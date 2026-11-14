# 知识点卡片模板

> 用于 `concept-index.md` 中的条目，或章节内的重点概念。

```yaml
id: 0x04/binary-search/invariant
name: 循环不变量
chapter: 0x04
chapter_name: 二分
source_pages: [BOOK p.25-26]
aliases: []
definition: |
  一句话定义。
properties:
  - 性质 1
  - 性质 2
formula: |
  $$
  ...
  $$
related:
  - concept: 0x04/binary-search/lower-bound
    relation: 依赖
prerequisites:
  - 0x01/bit-manipulation/lowbit   # 若确有关联才写
teaching:
  ppt: 是否适合 PPT 讲解
  animation: 是否适合动画
  interaction: 是否适合交互
status: draft | reviewed
provenance: BOOK | DERIVED | EXTENSION
```

## 使用约定

- `source_pages` 必须写印刷页码，PDF 页码由 `source-map.md` 的规则换算。
- `provenance` 为 `DERIVED` 或 `EXTENSION` 时，必须在正文中说明推导依据。
- 同一概念只建一个 id，避免同义词重复登记；别名写进 `aliases`。
