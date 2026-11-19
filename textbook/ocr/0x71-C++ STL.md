# 0x71 C++ STL — 原书 OCR

> 印刷页 p.456 – p.466；对应 PDF 页 p.466 – p.476。
> 本文为扫描件 OCR 机器识别结果，仅作检索与核对辅助，**不保证文字准确**。
> 公式、代码、上下标请以 `textbook/original/` 中的 PDF 页面为准。
> 标有 `[?]` 的页面表示已知存在 OCR 缺陷，详见 `textbook/README.md`。

## 印刷页 p.456（PDF p.466）

```text
0 0
算法竞赛进阶指南
0x70 综合技巧与实践
0
算法竞赛不仅是一门动脑的学问，也是一门动手的艺术。除了算
法、数据结构和题目模型的理论分析之外，如何简洁、高效地编写程
序，并通过恰当的调试、检测保证其正确性，也是值得探究的要点。
本章的主题是 “ 综合技巧与实践 ” 。 0x71 节介绍 C++ STL ，以及在使
用 STL 时需要注意的问题，主要侧重与前面七章知识点的配合，不会
从 c + + 语言的专业视角讲解其实现细节。 0x72 节介绍典型测试数据
的随机生成，以及 “ 对拍 ” 等对程序正确性进行自我检测的方法。在
平时解题中，读者可能长时间无法 AC ，且下载不到测试数据；在一些
比赛规则下，选手无法获得实时的评分反馈；又或是想到有趣的构思，
希望自己出一道题，必然需要对标准程序进行检验
生成与自我评估不可或缺的场景。
0X71 C++ STL
这些都是数据
0
本 节 介 绍 STL 中 vector, queue, priority-queue, deque, set, multiset ， map ， bitset 八
种算法竞赛中比较常用的容器。另外，我们也会介绍 algorithm 头文件中包含的部分函
数。建议读者按顺序依次阅读本节的每部分内容，以免错过大部分 STL 容器共通的背
景知识，造成理解困难。对于更详尽的资源，请参见 C+ + Primer 等语言类书籍，或
cplusplus.como
令 #include<vector>
vecto r 可理解为变长数组，它的内部实现基于倍增思想。按照下列思路可以大致实
现一个 vector ：设叫 m 为 vecto r 的实际长度和最大长度。向 vector 加入元素前，若
= m ，则在内存中申请 2 的连续空间，并把内容转移到新的地址上（同时释放旧
的空间），再执行插入。从 ve cto r 中删除元素后，若孓 m / 4 ，则释放一半的空间。
vector 支持随机访问，即对于任意的下标 0 孓 < n ，可以像数组一样用 [ 刂取值。
但它不是链表，不支持在任意位置 0 （ 1 ）插入。为了保证效率，元素的增删一般应该在
末尾进行。
456
```

## 印刷页 p.457（PDF p.467）

```text
综合技巧与实践
声明
#include 〈 vector>
vector<int> a ；
vector<int> b [ 233 ] ；
struct rec{•••};
vector<rec> C ；
size/empty
头文件
相当于一个长度动态变化的 int 数组
相当于第一维长 23 3 ，第二维长度动态变化的 int 数组
自定义的结构体类型也可以保存在 vector 中
size 函数返回 vector 的实际长度（包含的元素个数）， empty 函数返回一个 bool 类
型，表明 vector 是否为空。二者的时间复杂度都是 0 （ 1 ）。
所有的容器都支持这两个方法，含义也都相同，之后我们就不再重复给出。
clear
clear 函 数 扌 巴 vector 冫 青 工 。
迭代器
迭代器就像 STL 容器的 “ 指针 ” ，可以用星号 “ ” 操作符解除引用。
一个保存 int 的 vector 的迭代器声明方法为：
vector<int>.• ： iterator it;
vector 的迭代器是 “ 随机访问迭代器 ” ，可以把 vector 的迭代器与一个整数相加
减，其行为和指针的移动类似。可以把 vector 的两个迭代器相减，其结果也和指针相
减类似，得到两个迭代器对应下标之间的距离。
begin/end
begin 函数返回指向 vector 中第一个元素的迭代器。例如 a 是一个非空的 vector ，
则 *a.begin() 与 a[0] 的 作 用 相 同 。
所有的容器都可以视作一个 “ 前闭后开 ” 的结构， end 函数返回 vector 的尾部，
即第个元素再往后的 “ 边界 ” 。 *å.end() 与 a[n] 都是越界访问，其中
下面两份代码都遍历了 vector<int> a ，并输出它的所有元素。
= a. size()
for (int i = ； i < a ． s ize 0 ； i++)
cout < < a [ i ] 〈 < endl;
a.begin();
for 〈 vector<int>: :iterator it
cout < < *it <<endl;
front/back
it ！ =
a ． end 0 ；
front 函 数 返 回 vector 的 第 一 个 元 素 ， 等 价 于 *a.begin() 和 a[0] 。
back 函 数 返 回 vector 的 最 后 一 个 元 素 ， 等 价 于 *--a.end() 和 a[asize()-l] 。
457
```

## 印刷页 p.458（PDF p.468）

```text
，《算法竞赛进阶指南
push-back/pop-back
a.push-back(x) 把 元 素 无 插 入 到 vector a 的 尾 部 。
a.pop-back() 删 除 vecto r a 的 最 后 一 个 元 素 。
〖实例〗用 vector 代替邻接表保存有向图
const int MAX EDGES
199919 ；
vector<int> ver[MAX_EDGES], edge[MAX_EDGES];
/ / 保存从 × 到 y 权值为 z 的有向边
void add(int × ） int Y ） int z) { '
ver[x] · push_back(y) ；
edge[x] · push_back(z) ；
/ / 遍历从 × 出发的所有边
for (int i
int Y = ver[x][i], z = edge[x][i];
/ / 有 向 边 (X,Y,Z)
0 #include<queue>
头 文 件 queue 主 要 包 括 循 环 队 列 queue 和 优 先 队 列 priority-queue 两 个 容 器 。
声明
queue<int> q ；
struct rec{•••}; queue<rec> q ；
priority_queue<int> q ；
priority_queue<
循 环 队 列 queue
pair<int,int> > q ；
方法
push
POP
描述
入队（从队尾）
出队（从队头）
示例
q.push(element);
q · pop 0 ；
时间复杂度
0 （ 1 ）
0 （ 1 ）
pair<> ： C + + 内 置 的 二 元 组 ，
尖括号中分别指定二元组的第一元、第二元的类型。可以用 make-pair 函数创
建二元组，用成员变量 first 访问第一元、 second 访问第二元。在比较大小时，以第一元为第一关键字、第二
元为第二关键字。
458
```

## 印刷页 p.459（PDF p.469）

```text
综合技巧与实践
方法
front
back
描述
队头元素
队尾元素
示例
int ×
int y
q.front();
= q.back();
时间复杂度
0 （ 1 ）
0 （ 1 ）
读者可以回顾 0x21 节 “ 树与图的遍历 ” 的末尾 “ 图的广度优先遍历 " 部分，或者
0x61 节 “ 最短路 ” 的 "SPFA 算法 ” 部分，找到 queue 的运用实例。
优 先 队 列 priority-queue
priority-queue 可 理 解 为 一 个 大 根 二 叉 堆 。
方法
push
POP
t0 p
重载 ' ' < ” 运算符
描述
把元素插入堆
删除堆顶元素
示例
q.push(x);
q · pop 0 ；
查 询 堆 顶 元 素 （ 最 大 值 ） int × = q.top();
时间复杂度
0(log ）
0 g
0 （ 1 ）
priority-queue 中存储的元素类型必须定义 “ 小于号 ” ，较大的元素会被放在堆顶。
内置的 int, string 等类型本身就可以比较大小。若使用自定义的结构体类型，则需要重
载 “ < ” 运算符。
例如下面的 poi 结构体保存了二维平面上点的编号和坐标，比较大小时，先比横坐
标，再比纵坐标，并且考虑了精度误差：
struct poi { int id; double )G y; } ；
const double eps
le 一 8 ；
b001 operator <(const poi &a ） const poi (b) {
return a · x + eps < b · x 目 a · × < b ， × + eps & & a · y < b · y;
priority-queue 实 现 小 根 堆
priority-queue 实现小根二叉堆的方式一般有两种。
对于 int 等内置数值类型，可以把要插入的元素的相反数放入堆中。等从堆中取出
元素时，再把它取相反数变回原来的元素。这样就相当于把小的放在堆顶。
例如要插入 1 ，乙 3 三个数时，改为插入一 1 ，一乙一 3 。此时一 1 最大，处于堆顶，
把一 1 取出后再变回一（一 1 ），相当于取出了最小的 1 。
更为通用的解决方案是，建立自定义结构体类型，重载 “ 小于号 ” ，但是当作 “ 大
于号 ” 来编写函数，例如：
struct rec { int id; double value; } ；
459
```

## 印刷页 p.460（PDF p.470）

```text
算法竞赛进阶指南
b001 operator <(const rec &a 丿
return a.value > b.value;
const rec (b) {
这 样 priority-queue 会 认 为 “ 大 ” 的 更 “ 小 ”
堆时， value 较小的 rec 元素会被放在堆顶。
“ 小 ” 的更 “ 大 ” ，从而实现大根
请读者回顾 0x61 节 “ 最短路 ” 中的 “ 堆优化的 Dijkstra 算法 ” 部分，参考程序使
用 priority-queue 实现了一个小根二叉堆，用于在计算单源最短路径的过程中保存二元
组： “ 与起点距离的相反数、节点编号 ”
懒惰删除法
读者可能己经发现， 0x17 节讲解的 “ 二叉堆 ” 支持删除操作，但 STL 的 “ 优先队
列 ” 却不支持删除堆中任意元素，这给我们带来了很多不便。
懒惰删除法（又称延迟删除法）就是一种应对策略。当遇到删除操作时，仅在优先
队列之外做一些特殊的记录（例如记录元素的最新值），用于辨别那些堆中尚未清除的
“ 过时 ” 元素。当从堆顶取出最值时，再检查 “ 最值元素 ” 是不是 “ 过时 ” 的，若是，
则重新取出下一个最值。换言之，元素的 “ 删除 ” 被延迟到堆顶进行。
我们仍然以 0x61 节 “ 最短路 ” 中 “ 堆优化的 D ij kstra 算法 ” 的参考程序为例：
当一个节点的距离值 d 囝被更新时，暂时不从优先队列中删除 Y 对应的元素，
而是直接把新的二元组（一 d 型陟 ] ，刃插入优先队列。
当从堆顶取出二元组 (val, 无）准备扩展时，再检查 dist[xl 是否等于 valo 如果
不相等，那么说明 (val, 无）这个元素是被删除过的， @厩，才是最新插入的。此
时直接继续循环，取出下一个堆顶。
当然，因为在无负权的图上，每个节点第一次被取出时，就己经得到了它的最短路，
所以每个节点只需要扩展一次。因此，我们没有执行上述检查，而是用一个 bool 数组
进行了 “ 是否扩展过 " 的标记，其本质还是懒惰删除法的应用。
令 #include<deque>
双端队列 deque 是一个支持在两端高效插入或删除元素的连续线性存储空间。它
就像是 vector 和 queue 的结合。与 vector 相比， deque 在头部增删元素仅需要 0 （ 1 ）
的时间；与 queue 相比， deque 像数组一样支持随机访问。
方法
begin/end
描述
随机访问
deque 的头 / 尾迭代器
示例
与 vector 类 似
与 vector 迭代器类似
460
时间复杂度
叭 1 ）
0 （ 1 ）
```

## 印刷页 p.461（PDF p.471）

```text
000
0000 @
方法
front/back
push-back
push-front—
pop-front
pop-back
clear
综合技巧与实践
描述
队头 / 队尾元素
从队尾入队
从队头入队
从队头出队
从队尾出队
清空队列
示例
与 queue 类 似
q · push_back(x);
q · push_front(y);
q ． pop_front();
q · pop_back();
q.clear();
时间复杂度
0 （ 1 ）
0 （ 1 ）
0 （ 1 ）
0 （ 1 ）
0 （ 1 ）
0 ）
令 #include<set>
头文件 set 主要包括 set 和 multiset 两个容器，分别是 “ 有序集合 ” 和 “ 有序多重
集 " ，即前者的元素不能重复，而后者可以包含若干个相等的元素。 set 和 multiset 的
内部实现是一棵红黑树（平衡树的一种），它们支持的函数基本相同。
声明
set<int> S ；
struct rec{•••}; set<rec> S ；
multiset<double> s ；
与优先队列一样， set 和 multiset 存储的元素必须定义 “ 小于号 ” 运算符。
size/empty/clear
与 vector 类似，分别为元素个数、是否为空、清空。前两者的时间复杂度为 0 （ 1 ）。
迭代器
set 和 multiset 的迭代器称为 “ 双向访问迭代器 ” ，不支持 “ 随机访问 " ，支持星
号门解除引用，仅支持 “ + + ” 和 “ 一 ” 两个与算术相关的操作。
设 it 是 一 个 迭 代 器 ， 例 如 set<int>: :iterator it ；
若把 it++ ，则 it 将会指向 “ 下一个 ” 元素。这里的 “ 下一个 " 是指在元素从小到
大排序的结果中，排在 it 下一名的元素。同理，若把 it-- ，则 it 将会指向排在 “ 上一
个 ” 的元素。
请注意，执行 “ + + ” 和 “ 一 ” 操作的时间复杂度都是 0 （ log 。执行操作前后，务
必仔细检查，避免迭代器指向的位置超出首、尾迭代器之间的范围。
begin/end
返回集合的首、尾迭代器，时间复杂度为 0 （ 1 ）。
sbegin() 是指向集合中最小元素的迭代器。
s.end() 是指向集合中最大元素的下一个位置的迭代器。换一
461
二之 · ，
亡 亻 象 vector
```

## 印刷页 p.462（PDF p.472）

```text
算法竞赛进阶指南
0 到
的 0 的 0 以
样，是一个 “ 前闭后开 ” 的形式。因此 --s.end() 是指向集合中最大元素的迭代器。
insert
s.insert(x) 把一个元素无插入到集合 s 中，时间复杂度为 0 g 。
在 set 中，若元素己存在，则不会重复插入该元素，对集合的状态无影响。
下面的代码把个整数插入有序多重集 multiset ，并从小到大输出，时间复杂度
为 0 logn) ，相当于进行了一次排序。假设个整数目前存储在数组可 1 、中。
multiset<int> S ；
for (int i
1 ； i < = n ； i++) s.insert(a[i]);
for (multiset<int>: :iterator it
s · begin 0 ；
cout < < *it < < endl;
find
it ！
= s · end 0 ；
s.find(x) 在集合中查找等于无的元素，并返回指向该元素的迭代器。若不存在，
则返回 s.end() 。时间复杂度为 0 （ log ）。
lower-bound/upper-bound
这两个函数的用法与 find 类似，但查找的条件略有不同，时间复杂度 000g 。
s.lower-bound(x) 查找之无的元素中最小的一个，并返回指向该元素的迭代器。
s.upper-bound(x) 查找 > 无的元素中最小的一个，并返回指向该元素的迭代器。
erase
设是一个迭代器， s.erase(it) 从 s 中删除迭代器指向的元素，时间复杂度
为 0 （ log 。
设是一个元素， s.erase(x) 从 s 中删除所有等于 x 的元素，时间复杂度．为
0 + log ，其中为被删除的元素个数。
如果想从 multiset 中删掉至多 1 个等于的元素，可以执行：
讦 （ ()t = s.find(x)) ！ = s · end 0 ） s.erase(it);
count
s.count(x) 返回集合 s 中等于无的元素个数，时间复杂度@为 0 + log ，其中
为元素无的个数。
． multiset 的 erase 操 作 的 时 间 复 杂 度 由 "www.cplusplus.com/reference/set/multiset/erase ” 给 出 。 本
书配套光盘提供了该网页的快照。
multiset 的 count 操 作 的 时 间 复 杂 度 由 "www.cplusplus.com/reference/set/multiset/count ” 给 出 。 本
书配套光盘提供了该网页的快照。
462
```

## 印刷页 p.463（PDF p.473）

```text
0 0
000 的
0 到
生 0 0 0
0
综合技巧与实践
令 #include<map>
map 容器是一个键值对 key-value 的映射。其内部实现是一棵以 key 为关键码的
红黑树。 map 的 key 和 value 可以是任意类型，其中 key 必须定义 “ 小于号 ” 运算符，
声明方法为：
map<key_type, value_type> name;
例如：
map<long long, b001 > vis;
map<string, int> hash;
map< pair<int, int>, vector<int> > test;
在很多时候， map 容器被当作 Hash 表使用，建立从复杂信息 key （如字符串）到
简单信息 value （如一定范围内的整数）的映射。
因为 map 基于平衡树实现，所以它的大部分操作的时间复杂度都在 0 （ log 级
别，略慢于使用 Hash 函数实现的传统 Hash 表。从 C + + 11 开始， STL 中新增了
unordered-map 等基于 Hash 的容器，但部分算法竞赛并不支持 c + + 11 标准，这里就
不再介绍这些新容器。
size/empty/clear/begin/end
与 set 类似，分别为元素个数、是否为空、清空、首迭代器、尾迭代器。
迭代器
map 的迭代器与 set 一样，也是 “ 双向访问迭代器 ” 。对 map 的迭代器解除引用
后 ， 将 得 到 一 个 二 元 组 pair<key-type, value-type> 。
insert/erase
与 set 类 似 ， 分 别 为 插 入 、 删 除 。 insert 的 参 数 是 pair<key-type, value-type> ， erase
的参数可以是 pair 或者迭代器。
map<int,int> h ；
h.insert(make_pair(1,2)), h.insert(make_pair 〈 2，3））；
h · begin 0 ；
map<int,int>: :iterator it
pair<int,int> P
h.erase(it), h.erase(make_pair(2,3));
< < p.second < < endl;
cout < < p.first < <
find
h.find(x) 在变量名为 h 的 map 中查找 key 为无的二元组，并返回指向该二元组
463
```

## 印刷页 p.464（PDF p.474）

```text
算法竞赛进阶指南
的迭代器。若不存在，返回 h.end() 。时间复杂度为 000g 。
[ ] 操作符
h[key] 返 回 key 映 射 到 的 value 的 引 用 ， 时 间 复 杂 度 为 O(log ） 。
到的
目操作符是 map 最吸引人的地方。我们可以很方便地通过 h [key] 来得到 key 对应
的 value ，还可以对 h [ key ] 进行赋值操作，改变 key 对应的 value 。
需要特别注意的是，若查找的 key 不存在，则执行 h[key] 后， h 会自动新建一个二
元组 (key,zero) ，并返回 zero 的引用。这里 zero 表示一个广义 “ 零值 ” ，如整数 0 、
空字符串等。如果查找之后不对 h[key] 进行赋值，那么时间一长， h 会包含很多无用的
“ 零值二元组 ” ，白白地占用了空间，降低了程序运行效率。强烈建议读者在用目操
作符查询之前，先用 find 方法检查 key 的存在性。
〖实例〗用 map 统计字符串出现的次数
给定个字符串，襯个问题，每个问题询问一个字符串出现的次数。
孓 20000 ， 20000 ，每个字符串的长度都不超过 20 。
map<string, int> h ；
char str[25];
for (int i
1 ；
scanf( "%s ”
for (int i
1 ；
str); h[str]++;
scanf( "%s ”
str);
= h · end 0 ） puts( “ 9 ” ） ；
if (h.find(str)
else printf 〈 “ %d \n' ”
h[str]);
令 #include<bitset>
bitset 可看作一个多位二进制数，每 8 位占用 1 个字节，相当于采用了状态压缩的
二进制数组，并支持基本的位运算。在估算程序运行的时间时，我们一般以 32 位整数
的运算次数为基准，因此位 bitset 执行一次位运算的复杂度可视为 32 ，效率较
声明
bitset<1000Ø> S ；
表示一个 10000 位二进制数， < > 中填写位数。下面把位数记为 no
464
```

## 印刷页 p.465（PDF p.475）

```text
的 0
的 000 孬一
位运算操作符
～ s ：返回对 bitset s 按位取反的结果。
= 0 。
综合技巧与实践
& ， | ， ^ ：返回对两个位数相同的 bitset 执行按位与、或、异或运算的结果。
> > ， < < ：返回把一个 bitset 右移、左移若干位的结果。
= ，！ = ：比较两个 bitset 代表的二进制数是否相等。
[ ] 操作符
s 表示 s 的第 k 位，既可以取值，也可以赋值。
在 10000 位二进制数中，最低位为 s [ 0 ] ，最高位为 s [ 9999 ] 。
count
s.count()@ 返 回 有 多 少 位 为 1 。
any/none
若 s 所 有 位 都 为 0 ， 则 s.any() 返 回 false ， s.none() 返 回 true 。
若 s 至 少 一 位 为 1 ， 则 s.any() 返 回 true ， s.none() 返 回 falseo
set/reset/flip
s.set() 把 s 所 有 位 变 为 1 。
s.set(), 切 把 s 的 第 位 改 为 。 即 s[k] =
sxeset() 把 s 所 有 位 变 为 0 。
s.reset(k) 把 s 的 第 左 位 改 为 0 ， 即 s[k]
s.flip() 把 s 的 所 有 位 取 反 ， 即 s=
s.flip(k) 把 s 的 第 位 取 反 ， 即 s ^ ： 1 。
今 #includeqlgorithm>
下面介绍的几个函数都作用在序列上，接受两个迭代器（或指针） l,r ，对下标处
于前闭后开区间卩， r) 中的元素执行一系列操作。
reverse 翻 转
翻 转 一 个 vector:
reverse(a.begin(), a · end 0 ） ；
翻转一个数组，元素存放在下标 1 、
reverse(a+l, a+n+l);
． bitset 的 count 操作的复杂度未在 C++ Reference 中标注。一般来说，其复杂度为关于 bitset 位数的线
性复杂度，但实际效率可能稍快一些。
46 巪
```

## 印刷页 p.466（PDF p.476）

```text
算法竞赛进阶指南
unique 去 重
0 的 0 的
返回去重之后的尾迭代器（或指针），仍然为前闭后开，即这个尾迭代器是去重之
后末尾元素的下一个位置。该函数常用于离散化，利用迭代器（或指针）的减法，可计
算出去重后的元素个数襯。
把一个 vector 去重：
int m = unique(a.begin(), a · end 0 ）
把一个数组去重，元素存放在下标 1 、虍
unique(a+l, a+n+l)
int m
random-shuffle 随 机 打 乱
用 法 与 reverse 相 同 。
next-permutation 下 一 个 排 列
· begin();
把两个迭代器（或指针）指定的部分看作一个排列，求出这些元素构成的全排列中，
字典序排在下一个的排列，并直接在序列上更新。另外，若不存在排名更靠后的排列，
则 返 回 false ， 否 则 返 回 tru e 。 同 理 ， 也 有 prev-permutation 函 数 。
下面的程序按字典序输出 1 、的！种全排列：
for (int i
do {
for (int i
cout < < a [ n ] < < endl;
} 囚 h 主 le 〈 next_permutation(a+l, a+n+l));
sort 快速排序
对两个迭代器（或指针）指定的部分进行快速排序。可以在第三个参数传入定义大
小比较的函数，或者重载 “ 小于号 ” 运算符。
把一个 int 数组（元素存放在下标 1 、的从大到小排序，传入比较函数：
int a[MAX_SIZE];
b001 cmp(int a ， int b) { return a > b ·
sort(a+l, a+n+l, cmp);
把自定义的结构体 vector 排序，重载 “ 小于号 ” 运算符：
struct rec{ int id, × ， Y ； } ；
vector<rec> a ；
b001 operator <(const rec &a, const rec (b) {
466
```
