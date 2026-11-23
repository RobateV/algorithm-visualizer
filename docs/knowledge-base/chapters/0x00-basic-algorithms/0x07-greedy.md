# 0x07 贪心

## 1. 基本信息

| 项目 | 内容 |
| --- | --- |
| 章节编号 | `0x07` |
| 章节名称 | 贪心 |
| 所属一级章节 | `0x00` 基本算法 |
| 原书印刷页码 | p.42（下半，与 0x06 共页）– p.46（上半，与 0x08 共页） |
| 对应 PDF 页码 | p.52 – p.56 |
| 内容状态 | **草稿**（p.52–p.56 逐页对照 PDF 图像；测试见 §11，待独立复核） |
| 图像核对范围 | **p.52–p.56 五页逐一核对**（含 p.46 上半 Color a Tree 收尾） |
| 教材原文 | `textbook/original/算法竞赛进阶指南pdf李煜东高清无水印.pdf`（PDF p.52–p.56）<br>`textbook/ocr/0x07-贪心.md`（按印刷页分节） |
| 相关知识点 | 贪心策略、邻项交换、决策包容性、区间选点、高精度、树上合并 |

## 2. 本章定位

- **书中定义**：贪心是「在每次决策时采取当前意义下最优策略的算法」，
  要求「问题的整体最优性可以由局部最优性导出」`[BOOK] p.42`。
- **关键**：贪心正确性**需要证明**，书中列出五种常用证明手段 `[BOOK] p.42`。
- **与前后知识的联系**：
  - 前：`0x05 排序`——多数贪心先排序再扫描（Sunscreen、Stall、Radar、国王游戏）`[BOOK] p.43–45`；
  - 前：`0x06 倍增`——本章例题不用倍增，但「排序 + 扫描」与倍增的「划分」同属降低规模的思路 `[DERIVED]`；
  - 后：`0x08 总结与练习`——贪心作为基本算法思想之一被纳入知识框架 `[BOOK] p.46`。
- **算法前提**：排序、堆（优先队列）、区间运算 `[BOOK] p.43`。
- **学习准备建议**：能写出「交换相邻两项不劣」的式子 `[EXTENSION]`。

## 3. 核心知识点

### 3.1 五种证明手段

书中给出 `[BOOK] p.42`：

| 手段 | 核心思想 |
| --- | --- |
| 微扰（邻项交换） | 任意局面下，对局部最优策略的微小改变都会使整体结果变差；常用于「排序」类贪心 |
| 范围缩放 | 任何对局部最优策略作用范围的扩展都不会使整体结果变差 |
| 决策包容性 | 作出局部最优决策后，可达集合包含作出其他决策后的可达集合 |
| 反证法 | 假设存在更优解，推出矛盾 |
| 数学归纳法 | 证明每一步贪心后仍保持最优性 |

### 3.2 Sunscreen（POJ3614）

**题意** `[BOOK] p.42`：`C` 头牛，每头需要 `[minSPF, maxSPF]` 区间的防晒；`L` 种防晒霜，第 `i` 种强度 `SPF[i]`、数量 `cover[i]`。求最多满足几头牛。

**策略** `[BOOK] p.42–43`：按 `minSPF` **递减**排序牛；对每头牛，在能用的防晒霜中选 `SPF` **最大**的一瓶。

**证明** `[BOOK] p.43`：按 `minSPF` 递减后，当前牛能用的防晒霜对后续牛只会出现三种情况：
「都能用」「都不能用」「当前能用而后续不能用」——因此选 `SPF` 更大的一瓶，对后续影响不劣。
又每头牛对答案贡献至多 1，放弃当前牛也不会让答案更大。

> `[DERIVED]` 严格地说，这属于「决策包容性 + 交换论证」：把当前牛与后续牛所用的防晒霜交换，
> 由于当前牛 `minSPF` 最大，交换后当前牛仍可用那瓶更大的防晒霜，后续牛的选择集合不变或变大。

### 3.3 Stall Reservations（POJ3190）

**题意** `[BOOK] p.43`：`N` 头牛各占 `[l, r)`，同一时间一个畜栏只能一头牛，求最少畜栏数及方案。

**策略** `[BOOK] p.43`：按开始时间排序；维护每个畜栏最后一头牛的结束时间，
把当前牛放进「结束时间最早且 ≤ 当前开始时间」的畜栏，否则新建。用**小根堆**可做到 `O(N log N)`。

**正确性** `[DERIVED]`：

- **下界**：任一时刻同时吃草的牛数 `k` 互不相容，必须 `k` 个畜栏，故最少畜栏数 ≥ 最大重叠数；
- **可达**：按开始时间排序后，贪心在每一时刻恰好保持「重叠数」个畜栏在用，
  且总把新牛放进最早空出的畜栏 → 畜栏数恰为最大重叠数；
- **端点语义**：区间取 `[l, r)`，`r == l'` 时两牛可共用畜栏（否则会多算一个畜栏）。

### 3.4 Radar Installation（POJ1328）

**题意** `[BOOK] p.43`：`N` 个点，用半径 `R` 的圆（圆心在 `x` 轴上）覆盖，求最少圆数。

**建模** `[BOOK] p.43`：每个点对应 `x` 轴上一段可覆盖区间 `[l_i, r_i]`，
问题转化为「用最少的点刺穿所有区间」。

**策略** `[BOOK] p.44`：按 `l_i` 升序；维护最后一台设备的坐标 `pos`（初值 `−∞`）：

- 若 `l_i > pos`：必须新建设备，`pos = r_i`；
- 否则：`pos = min(r_i, pos)`（尽量往右放）。

**证明（决策包容性）** `[BOOK] p.44`：能复用已有设备时，新建永远不会比复用更好——
复用后未来可在任意位置新建，而新建要求落在此区间内，前者的可达状态包含后者。
把 `pos` 调到 `min(r_i, pos)` 是「尽量靠右」，同样包含「靠左」的可达状态。

### 3.5 国王游戏（NOIP2012 / CH0701）

**题意** `[BOOK] p.44`：`n` 位大臣排成一列，国王在最前；每位大臣左手 `A[i]`、右手 `B[i]`。
大臣 `i` 的奖励 = 前面所有人左手数之积 ÷ 自己的右手数（向下取整）。重排使**最大奖励最小**。

**策略** `[BOOK] p.44`：按 **`A[i] × B[i]` 升序**排序。

**证明（邻项交换）** `[BOOK] p.44–45`：交换相邻的 `i` 与 `i+1`，其他大臣奖励不变；
比较两者最大值，两边同乘 `B[i]·B[i+1]` 后化为比较

```
max(B[i+1], A[i]·B[i])  vs  max(B[i], A[i+1]·B[i+1])
```

由正整数性 `B[i+1] ≤ A[i+1]·B[i+1]`、`A[i]·B[i] ≥ B[i]` 得：
`A[i]·B[i] ≤ A[i+1]·B[i+1]` 时交换前不劣，反之交换后不劣。
故按乘积升序（消除逆序对）最优。

**实现细节** `[DERIVED]`：乘积可达 `10^9 × 10^9` 量级且要连乘 `n` 次，必须**高精度**；
测试与文档示例用 `__int128` 只适用于小数据。

### 3.6 Color a Tree（POJ2054）

**题意** `[BOOK] p.45`：`n` 个节点的树，每个节点权值 `A[i]`；根 `R` 可随时染，
其他节点染色前父节点必须已染；第 `T` 次染色代价 `T × A[i]`。求最小总代价。

**错误贪心** `[BOOK] p.45`：「每次在可染点里选权值最大的」——反例：权值很小的点下面挂着很多大权值节点，
而另一个权值较大的点没有子节点。

**正确性质** `[BOOK] p.45`：除根外**权值最大的点，一定在其父节点染色后立即染色**。

**等效权值与合并** `[BOOK] p.45–46`：

- 把「连续染色」的两点合并成一个点，新点权值取**平均值**；
- 三个点 `x, y, z` 且 `x, y` 连续时，两种方案代价
  `x + 2y + 3z` 与 `z + 2x + 3y`，同加 `(z−y)` 再除 2 后化为
  `(x+y)/2 + 2z` 与 `z + 2·(x+y)/2`——正是「权值为 `(x+y)/2` 与 `z` 的两点」的两种顺序；
- 推广：每个点记录**等效权值 = 所含原始权值之和 ÷ 所含原始点数**，
  反复取等效权值最大的点与其父合并（把子序列接在父序列之后），直到只剩根；
- 最后按根节点保存的顺序依次染色，计算 `Σ T × A` 即答案 `[BOOK] p.46`。

## 4. 算法推导

### 4.1 Sunscreen 的交换论证

设当前牛 `c`（`minSPF` 最大）在贪心中用了防晒霜 `y`，某最优解用了 `x` 且 `SPF[x] < SPF[y]` `[DERIVED]`：
若 `y` 在该解中未被使用或用于更晚的牛，把 `y` 换给 `c`、`x` 留给那头牛——
由于 `c` 的 `minSPF` 最大、`y` 的 SPF 更大，交换后两瓶都仍可用，答案不减。
反复交换即得不劣于最优解的贪心解。

### 4.2 Stall 的最少畜栏 = 最大重叠

`[DERIVED]`：把每头牛看作区间，畜栏分配是区间图的着色；区间图的色数等于最大团（最大重叠数），
贪心按左端点扫描并用最早结束的畜栏，恰好达到该色数。

### 4.3 国王游戏的交换不等式

见 §3.5。要点：只比较被交换的两人奖励的最大值，其余人不变；比较时同乘正数不变号。

### 4.4 Color a Tree 的合并正确性

**引理**：最大权重点 `p` 与父 `fa` 连续染色 `[BOOK] p.45`。
**推论**：合并后的序列与原问题最优序列一一对应 `[BOOK] p.46`：
合并只改变「表示」，不改变代价的前缀系数结构；用等效权值保证比较的是平均代价。

## 5. 代码实现

> 书中五道例题均未给出完整代码（p.42–46 只有策略与证明）。以下均为 `[DERIVED]` 参考实现。

### 5.1 Sunscreen `[DERIVED]`

```cpp
int solve(vector<pair<int,int>> cow, vector<pair<int,int>> spf) {  // spf: (SPF, cover)
    sort(cow.begin(), cow.end(), [](auto& x, auto& y) { return x.first > y.first; });
    sort(spf.begin(), spf.end());
    int ans = 0;
    for (auto& c : cow) {
        int best = -1;
        for (int i = 0; i < (int)spf.size(); i++)
            if (spf[i].second > 0 && spf[i].first >= c.first && spf[i].first <= c.second)
                if (best == -1 || spf[i].first > spf[best].first) best = i;
        if (best >= 0) { spf[best].second--; ans++; }
    }
    return ans;
}
```

### 5.2 Stall Reservations `[DERIVED]`

```cpp
int minStalls(vector<pair<int,int>> seg) {   // [l, r)
    sort(seg.begin(), seg.end());
    priority_queue<int, vector<int>, greater<int>> pq;
    int ans = 0;
    for (auto& s : seg) {
        while (!pq.empty() && pq.top() <= s.first) pq.pop();
        pq.push(s.second);
        ans = max(ans, (int)pq.size());
    }
    return ans;
}
```

### 5.3 Radar Installation `[DERIVED]`

```cpp
int minRadars(vector<pair<double,double>> seg) {   // 每个点的可覆盖区间
    sort(seg.begin(), seg.end());
    int ans = 0; double pos = -1e18;
    for (auto& s : seg) {
        if (s.first > pos) { ans++; pos = s.second; }
        else pos = min(pos, s.second);
    }
    return ans;
}
```

### 5.4 国王游戏 `[DERIVED]`（高精度提示）

```cpp
// 排序键：A[i] * B[i]（用 long long 存乘积键，实际连乘必须高精度）
sort(m.begin(), m.end(), [](const Minister& x, const Minister& y) {
    return (long long)x.a * x.b < (long long)y.a * y.b;
});
```

### 5.5 Color a Tree `[DERIVED]`

```cpp
long long colorTree(int n, int root, vector<long long> w, vector<int> par) {
    vector<long long> sum = w;
    vector<int> cnt(n + 1, 1);
    vector<vector<int>> seq(n + 1);
    for (int i = 1; i <= n; i++) seq[i] = {i};
    vector<int> parent = par;
    vector<char> dead(n + 1, 0);
    for (int it = 1; it < n; it++) {
        int best = -1;
        for (int i = 1; i <= n; i++) {
            if (dead[i] || i == root) continue;
            if (best == -1 || (__int128)sum[i] * cnt[best] > (__int128)sum[best] * cnt[i]) best = i;
        }
        int p = parent[best];
        while (dead[p]) p = parent[p];
        sum[p] += sum[best]; cnt[p] += cnt[best];
        seq[p].insert(seq[p].end(), seq[best].begin(), seq[best].end());
        dead[best] = 1; parent[best] = p;
    }
    long long ans = 0;
    for (int i = 0; i < (int)seq[root].size(); i++) ans += (long long)(i + 1) * w[seq[root][i]];
    return ans;
}
```

## 6. 典型例题与练习

| 例题 | 编号 | 页码 | 贪心策略 | 证明手段 |
| --- | --- | --- | --- | --- |
| Sunscreen | POJ3614 | p.42–43 | 牛按 minSPF 降序，选最大可用 SPF | 决策包容性 + 交换 |
| Stall Reservations | POJ3190 | p.43 | 按开始时间排序，小根堆取最早结束畜栏 | 区间图着色（下界+可达） |
| Radar Installation | POJ1328 | p.43–44 | 区间选点，按左端点排序，`pos=min(r,pos)` | 决策包容性 |
| 国王游戏 | NOIP2012 / CH0701 | p.44–45 | 按 `A×B` 升序 | 邻项交换 |
| Color a Tree | POJ2054 | p.45–46 | 等效权值最大者与父合并 | 微扰 + 归纳 |

## 7. 易错点与注意事项

- **Sunscreen 按 maxSPF 排序**：应按 `minSPF` 降序，且选「SPF 最大」而非「maxSPF 最大」 `[BOOK] p.42`。
- **Stall 端点重合**：区间取 `[l, r)`，`r == l'` 可共用畜栏；用 `<=` 弹出 `[DERIVED]`。
- **Radar 忘记取 `min(r, pos)`**：只写 `pos = r` 会漏掉右端点更小的区间 `[BOOK] p.44`。
- **国王游戏用 `int` 存乘积/前缀积**：必须高精度 `[DERIVED]`。
- **Color a Tree 用「当前可染最大权值」**：书中明确给出反例 `[BOOK] p.45`。
- **Color a Tree 合并后忘记更新父指针**：被合并点变「死」，其后代应沿父链找到最近的活祖先 `[DERIVED]`。
- **等效权值比较用浮点**：应用交叉相乘 `sum_a/cnt_a` vs `sum_b/cnt_b` `[DERIVED]`。

## 8. 知识关联

| 关联章节 | 关系类型 | 依据强度 | 依据 |
| --- | --- | --- | --- |
| 0x05 排序 | 相关知识 | 明确 | 四道例题都先排序再扫描 `[BOOK] p.43–45` |
| 0x17 二叉堆 | 相关知识 | 明确 | Stall Reservations 用小根堆优化到 `O(N log N)` `[BOOK] p.43` |
| 0x08 总结与练习 | 后续引用 | 明确 | 贪心作为基本算法思想在总结中归入知识框架 `[BOOK] p.46` |
| 0x01 位运算 | 无关 | — | 本章未使用 `[EXTENSION]` |

## 9. 教学应用建议

> 本节为教学设计建议，**非原书内容** `[EXTENSION]`。

- **适合动画**：Sunscreen 的「牛—防晒霜」匹配；Stall 的畜栏时间轴；Radar 的区间与点；Color a Tree 的合并过程。
- **学生最易误解**：「局部最优=整体最优」不需要证明；Color a Tree 用当前可染最大权值。
- **适合交互**：拖动区间观察选点；调整国王游戏顺序观察最大奖励变化。
- **课堂问题**：为什么 Stall 的最少畜栏等于最大重叠？为什么 Color a Tree 要合并而不是直接选最大值？
- **代码同步**：`sort` 的比较器、`priority_queue` 的 `greater`、`__int128` 交叉相乘。

## 10. 待确认事项与来源

### 已逐页核对（页面图像）

- [x] p.42（下半）0x07 开篇、五种证明手段、Sunscreen 题意与策略。
- [x] p.43 Sunscreen 证明、Stall Reservations、Radar Installation 建模。
- [x] p.44 Radar 的 `pos` 维护与决策包容性证明、国王游戏题意。
- [x] p.45 国王游戏交换不等式、Color a Tree 错误贪心与合并思想。
- [x] p.46（上半）Color a Tree 等效权值与最终恢复顺序；下半页起 0x08。

### 仍待确认

- 书中五道例题均未给出完整代码，§5 为整理者实现 `[DERIVED]`。
- 国王游戏的高精度实现细节书中未展开（具体位数与实现方式待确认）。
- Color a Tree 的 `n ≤ 1000` 下 `O(n²)` 合并是否满足原题时限，书中未讨论（`[DERIVED]` 实测小规模通过）。

## 11. 核验与测试记录

g++ 11.5.0 `-O2 -std=c++17`，测试驱动在本地临时目录（未提交）。

| 测试项 | 方法 | 结果 |
| --- | --- | --- |
| Sunscreen | 300 组随机 vs 二分图最大匹配 | ✅ 0 失配 |
| Stall Reservations | 300 组随机 vs 最大重叠扫描 | ✅ 0 失配 |
| Stall 端点 | `[0,1)` 与 `[1,2)` | ✅ 1 个畜栏 |
| Radar | 200 组随机 vs 枚举候选点子集 | ✅ 0 失配 |
| 国王游戏 | 60 组随机（`n ≤ 6`）vs 全排列 | ✅ 0 失配 |
| Color a Tree | 100 组随机（`n ≤ 6`）vs 合法染色顺序全枚举 | ✅ 0 失配 |

> 测试中曾出现两处**测试代码**错误：Sunscreen 误用 `used` 禁止同一瓶防晒霜的剩余 cover 复用；
> Color a Tree 把根标成 `dead` 导致父链爬到 0 号节点。修正测试后全部通过，算法本身无误。
