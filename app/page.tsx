'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Code2, Home as HomeIcon, Menu, Play, RotateCcw, Search, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Algorithm = { name: string; brief: string; ready?: boolean; lesson?: string; demo?: 'bubble' };
type Topic = { name: string; overview: string; algorithms: Algorithm[] };
type Category = { name: string; topics: Topic[] };

const categories: Category[] = [
  { name: '算法基础', topics: [
    { name: '排序', overview: '将一组数据按规则重新排列。先理解稳定性、时间复杂度，再比较不同排序的工作过程。', algorithms: [
      { name: '冒泡排序', brief: '相邻元素比较并交换，大元素逐轮移动到右侧。', demo: 'bubble' }, { name: '选择排序', brief: '每轮从未排序区选出最小元素。' }, { name: '插入排序', brief: '将当前元素插入前方有序区间。' }, { name: '归并排序', brief: '分治排序，在合并时保持顺序。' }, { name: '快速排序', brief: '围绕基准值划分区间。' }, { name: '堆排序', brief: '反复从堆中取出最值。' },
    ] },
    { name: '二分', overview: '在单调空间中每次排除一半答案，重点是区间边界与循环不变量。', algorithms: [{ name: '二分查找', brief: '在有序序列中查找目标或插入位置。' }, { name: '二分答案', brief: '将最优化问题转为可行性判定。' }, { name: '实数二分', brief: '在精度范围内逼近连续答案。' }] },
    { name: '前缀和与差分', overview: '将重复区间计算转为一次预处理。', algorithms: [{ name: '一维前缀和', brief: '两次前缀和相减得到区间和。' }, { name: '二维前缀和', brief: '快速统计矩形区域。' }, { name: '差分', brief: '把区间修改压缩为端点修改。' }] },
    { name: '贪心', overview: '每一步选择当前看来最优的方案，并用性质证明其正确性。', algorithms: [{ name: '区间贪心', brief: '按端点排序解决区间选择问题。' }, { name: '构造贪心', brief: '从局部规则构造全局答案。' }] },
  ] },
  { name: '搜索', topics: [
    { name: '深度优先搜索', overview: '沿一条分支不断深入，适合枚举、连通块和回溯。', algorithms: [{ name: 'DFS', brief: '递归或栈实现的深度遍历。' }, { name: '回溯法', brief: '撤销选择后继续尝试其他分支。' }, { name: '剪枝', brief: '提前排除不可能的状态。' }] },
    { name: '广度优先搜索', overview: '按层扩展状态，常用于无权图最短路。', algorithms: [{ name: 'BFS', brief: '用队列维护当前层。' }, { name: '双向 BFS', brief: '从起点和终点同时搜索。' }, { name: '状态压缩 BFS', brief: '用位运算表示多个状态。' }] },
  ] },
  { name: '动态规划', topics: [
    { name: '背包 DP', overview: '状态通常由容量与已选物品组成。', algorithms: [{ name: '0/1 背包', brief: '每件物品只能选择一次。' }, { name: '完全背包', brief: '每件物品可重复选择。' }, { name: '多重背包', brief: '物品数量受限。' }] },
    { name: '线性 DP', overview: '沿序列方向推进状态，建立前后位置的关系。', algorithms: [{ name: '最长上升子序列', brief: '求满足递增关系的最长子序列。' }, { name: '最长公共子序列', brief: '比较两个序列的相似结构。' }] },
    { name: '树形 DP', overview: '在树上从子节点向父节点汇总答案。', algorithms: [{ name: '树的最大独立集', brief: '选与不选当前节点的状态转移。' }, { name: '树上背包', brief: '在子树中分配容量。' }] },
  ] },
  { name: '字符串', topics: [
    { name: '字符串匹配', overview: '研究模式串与文本串的关系，避免重复比较。', algorithms: [{ name: '朴素匹配', brief: '逐位置比较字符串。' }, { name: 'KMP / 前缀函数', brief: '失配时利用前后缀信息跳转。', ready: true, lesson: '/lessons/kmp.html' }, { name: 'Z 函数', brief: '批量求最长公共前缀。' }] },
    { name: '字符串哈希', overview: '把子串映射成可快速比较的数值指纹。', algorithms: [{ name: '多项式哈希', brief: '用前缀哈希常数时间比较子串。' }, { name: '双哈希', brief: '降低碰撞概率。' }] },
  ] },
  { name: '数学', topics: [
    { name: '数论基础', overview: '处理整数、整除与模运算。', algorithms: [{ name: '快速幂', brief: '二进制分解指数。' }, { name: '最大公约数', brief: '欧几里得算法求 GCD。' }, { name: '质数筛', brief: '批量筛出质数。' }, { name: '模逆元', brief: '处理模意义下的除法。' }] },
    { name: '组合数学', overview: '计数、排列、组合与容斥。', algorithms: [{ name: '排列组合', brief: '基础计数公式。' }, { name: '容斥原理', brief: '通过交集修正重复计数。' }] },
  ] },
  { name: '数据结构', topics: [
    { name: '线性表', overview: '理解数据的线性存储、访问顺序和操作约束。', algorithms: [{ name: '链表与数组模拟链表', brief: '可视化指针与数组模拟。', ready: true, lesson: '/lessons/linked-list.html' }, { name: '栈与队列', brief: '后进先出与先进先出。', ready: true, lesson: '/lessons/stack-queue.html' }, { name: '单调栈与单调队列', brief: '维护候选元素的局部最优。' }] },
    { name: '堆与并查集', overview: '维护最值或集合连通性。', algorithms: [{ name: '二叉堆', brief: '高效维护当前最小或最大元素。' }, { name: '并查集', brief: '快速判断元素是否属于同一集合。' }] },
    { name: '区间数据结构', overview: '在频繁查询和修改之间取得平衡。', algorithms: [{ name: '树状数组', brief: '维护前缀信息。' }, { name: '线段树', brief: '分治维护区间。' }, { name: 'ST 表', brief: '静态区间最值查询。' }] },
  ] },
  { name: '图论', topics: [
    { name: '图的存储', overview: '从点和边的表示开始，为图论算法建立共同底座。', algorithms: [{ name: '邻接矩阵与邻接表', brief: '比较图存储的空间与遍历代价。' }, { name: '前向星', brief: '竞赛常用的数组模拟邻接表。', ready: true, lesson: '/lessons/forward-star.html' }, { name: '图上的 DFS / BFS', brief: '遍历可达点和连通块。' }] },
    { name: '最短路问题', overview: '求两个点之间总代价最小的路径，并根据边权选择算法。', algorithms: [{ name: 'Dijkstra', brief: '非负边权的单源最短路。' }, { name: 'Bellman-Ford / SPFA', brief: '允许负边，可判断负环。' }, { name: 'Floyd-Warshall', brief: '全源最短路。' }] },
    { name: '生成树问题', overview: '用最小代价连接所有顶点。', algorithms: [{ name: 'Kruskal', brief: '按边权从小到大选边。' }, { name: 'Prim', brief: '从一个点向外扩张生成树。' }, { name: '最小生成树性质', brief: '用切分性质理解正确性。' }] },
    { name: '连通性相关', overview: '研究删除点或边后图是否保持连接。', algorithms: [{ name: '强连通分量', brief: '有向图中互相可达的点集。' }, { name: '割点与桥', brief: '影响无向图连通性的关键点和边。' }] },
  ] },
  { name: '进阶专题', topics: [{ name: '离线与分治', overview: '调整处理顺序或拆分问题后再合并答案。', algorithms: [{ name: '分治', brief: '将大问题拆为独立子问题。' }, { name: 'CDQ 分治', brief: '处理偏序统计问题。' }, { name: '莫队', brief: '通过排序查询降低移动代价。' }] }] },
];

const bubbleSteps = [
  { values: [5, 1, 4, 2, 8], active: [0, 1], sorted: [], line: 3, text: '比较 5 和 1：5 更大，交换它们。' },
  { values: [1, 5, 4, 2, 8], active: [1, 2], sorted: [], line: 3, text: '继续比较 5 和 4：5 仍向右移动。' },
  { values: [1, 4, 5, 2, 8], active: [2, 3], sorted: [], line: 4, text: '交换完成，当前最大值逐渐靠近右端。' },
  { values: [1, 4, 2, 5, 8], active: [3, 4], sorted: [4], line: 6, text: '第一轮结束：8 已位于最终位置。' },
  { values: [1, 2, 4, 5, 8], active: [], sorted: [0, 1, 2, 3, 4], line: 8, text: '排序完成。每一轮都会确定一个最大元素。' },
];
const code = ['for (int i = 0; i < n - 1; i++) {', '  for (int j = 0; j < n - 1 - i; j++) {', '    if (a[j] > a[j + 1])', '      swap(a[j], a[j + 1]);', '  }', '  // 右侧一个元素已经有序', '}', '// 全部完成'];

export default function AlgorithmMap() {
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [topicIndex, setTopicIndex] = useState(0);
  const [algorithmIndex, setAlgorithmIndex] = useState(0);
  const [search, setSearch] = useState('');
  const [step, setStep] = useState(0);
  const category = categories[categoryIndex];
  const topic = category.topics[topicIndex];
  const algorithm = topic.algorithms[algorithmIndex];
  const searchResults = useMemo(() => categories.flatMap((group) => group.topics.map((item) => ({ group, item }))).filter(({ group, item }) => `${group.name}${item.name}${item.algorithms.map((a) => a.name).join('')}`.toLowerCase().includes(search.trim().toLowerCase())), [search]);
  const selectCategory = (index: number) => { setCategoryIndex(index); setTopicIndex(0); setAlgorithmIndex(0); setStep(0); };
  const selectTopic = (index: number) => { setTopicIndex(index); setAlgorithmIndex(0); setStep(0); };
  const selectAlgorithm = (index: number) => { setAlgorithmIndex(index); setStep(0); };
  return <main className="min-h-screen bg-white text-slate-800">
    <header className="border-b border-slate-200 bg-white"><div className="mx-auto flex h-14 max-w-[1550px] items-center gap-4 px-5"><button onClick={() => selectCategory(0)} className="flex items-center gap-3 font-semibold text-slate-900"><span className="grid size-8 place-items-center rounded-md bg-slate-900 text-white"><Sparkles size={15} /></span><span className="text-lg">信奥算法地图</span></button><span className="hidden text-xs text-slate-400 md:block">算法可视化课堂</span><div className="ml-auto hidden items-center gap-3 md:flex"><Menu size={20} className="text-slate-600" /><label className="relative w-52"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 rounded-none border-0 bg-slate-100 pl-9 shadow-none" placeholder="搜索" /></label></div></div>
      <nav className="border-t border-slate-100"><div className="mx-auto flex max-w-[1550px] overflow-x-auto px-5">{categories.map((item, index) => <button key={item.name} onClick={() => selectCategory(index)} className={`shrink-0 border-b-2 px-4 py-3 text-sm transition ${categoryIndex === index ? 'border-sky-600 font-bold text-sky-700' : 'border-transparent text-slate-600 hover:text-sky-700'}`}>{item.name}</button>)}</div></nav>
    </header>
    <div className="mx-auto grid max-w-[1550px] grid-cols-1 lg:grid-cols-[228px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-white lg:min-h-[calc(100vh-101px)] lg:border-b-0 lg:border-r"><div className="px-5 py-6 lg:sticky lg:top-0"><div className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-700"><HomeIcon size={15} className="text-sky-600" />{category.name}</div><div className="flex gap-1 overflow-x-auto lg:block lg:space-y-1">{category.topics.map((item, index) => <button key={item.name} onClick={() => selectTopic(index)} className={`shrink-0 rounded-md px-3 py-2 text-left text-sm transition lg:block lg:w-full ${topicIndex === index ? 'bg-sky-50 font-bold text-sky-700' : 'text-slate-600 hover:bg-slate-50'}`}>{item.name}</button>)}</div><div className="mt-8 hidden rounded-lg border-l-2 border-sky-500 bg-sky-50 p-3 text-xs leading-5 text-sky-800 lg:block"><b>课堂使用</b><br />先从左侧选择知识点，再在右侧切换具体算法。</div></div></aside>
      <section className="min-w-0 px-5 py-7 lg:px-10"><div className="border-b border-slate-200 pb-5"><p className="text-xs text-slate-400">首页 / {category.name} / {topic.name}</p><div className="mt-3 flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-3xl font-normal tracking-tight text-slate-800">{topic.name}</h1><p className="mt-3 max-w-3xl leading-7 text-slate-600">{topic.overview}</p></div><Badge variant="outline" className="border-slate-200 text-slate-500">{topic.algorithms.length} 个算法</Badge></div></div>
        <div className="mt-5 flex flex-wrap gap-2 border-b border-slate-200 pb-5">{topic.algorithms.map((item, index) => <button key={item.name} onClick={() => selectAlgorithm(index)} className={`rounded-md border px-3 py-2 text-sm transition ${algorithmIndex === index ? 'border-sky-600 bg-sky-600 font-bold text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-sky-300'}`}>{item.name}{item.ready && <span className="ml-1.5 text-[10px] opacity-80">●</span>}</button>)}</div>
        <div className="mt-6 flex items-center gap-2"><Code2 size={18} className="text-sky-600" /><h2 className="text-xl font-bold text-slate-800">{algorithm.name} 可视化</h2></div><p className="mt-2 text-sm text-slate-500">{algorithm.brief}</p>
        <div className="mt-5">{algorithm.ready && algorithm.lesson ? <div className="overflow-hidden border border-slate-200 bg-white"><div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-sm"><span className="font-bold">课堂互动教具</span><a href={algorithm.lesson} target="_blank" rel="noreferrer" className="text-sky-600 hover:underline">全屏打开</a></div><iframe title={`${algorithm.name} 互动演示`} className="h-[720px] w-full" src={algorithm.lesson} /></div> : algorithm.demo === 'bubble' ? <BubblePlayer step={step} setStep={setStep} /> : <Placeholder topic={topic.name} algorithm={algorithm.name} />}</div>
        {search && <div className="mt-10 border-t border-slate-200 pt-5"><h2 className="font-bold">搜索结果</h2><div className="mt-3 grid gap-2 sm:grid-cols-2">{searchResults.map(({ group, item }) => <button key={`${group.name}-${item.name}`} onClick={() => { const ci = categories.indexOf(group); selectCategory(ci); setTopicIndex(group.topics.indexOf(item)); }} className="border border-slate-200 p-3 text-left hover:border-sky-300"><p className="text-xs text-sky-600">{group.name}</p><p className="mt-1 font-bold">{item.name}</p><p className="mt-1 text-xs text-slate-500">{item.algorithms.map((a) => a.name).join(' · ')}</p></button>)}</div></div>}
      </section>
    </div>
  </main>;
}

function BubblePlayer({ step, setStep }: { step: number; setStep: (value: number | ((old: number) => number)) => void }) {
  const current = bubbleSteps[step];
  return <div className="grid border border-slate-200 bg-white xl:grid-cols-[.78fr_1.22fr]"><div className="border-b border-slate-200 p-5 xl:border-b-0 xl:border-r"><div className="mb-3 flex items-center justify-between"><b>代码执行</b><span className="text-xs text-amber-700">第 {step + 1} 步</span></div><pre className="overflow-auto bg-slate-950 p-4 text-sm leading-7 text-slate-300">{code.map((line, index) => <code key={line} className={`block px-2 ${index + 1 === current.line ? 'bg-amber-400/20 text-amber-100' : ''}`}><span className="mr-4 text-slate-600">{String(index + 1).padStart(2, '0')}</span>{line}</code>)}</pre><p className="mt-4 border-l-2 border-sky-500 bg-sky-50 p-3 text-sm leading-6 text-slate-600">{current.text}</p></div><div className="p-5"><div className="mb-4 flex items-center justify-between"><b>数据动画</b><span className="text-xs text-slate-400">a[5]</span></div><div className="grid min-h-64 place-items-center bg-slate-50 p-5"><div className="flex flex-wrap justify-center gap-3">{current.values.map((value, index) => <div key={`${value}-${index}`}><div className={`grid size-14 place-items-center border-2 text-xl font-bold transition-all duration-500 ${current.sorted.includes(index) ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : current.active.includes(index) ? 'scale-110 border-amber-400 bg-amber-50 text-amber-700 shadow-md' : 'border-sky-300 bg-white text-sky-700'}`}>{value}</div><span className="mt-2 block text-center text-xs text-slate-400">{index}</span></div>)}</div></div><div className="mt-5 flex gap-2"><Button variant="outline" onClick={() => setStep((old) => Math.max(0, old - 1))} disabled={step === 0}><ArrowLeft />上一步</Button><Button className="bg-sky-600 hover:bg-sky-700" onClick={() => setStep((old) => Math.min(bubbleSteps.length - 1, old + 1))} disabled={step === bubbleSteps.length - 1}><Play />下一步</Button><Button variant="ghost" onClick={() => setStep(0)}><RotateCcw />重置</Button></div></div></div>;
}

function Placeholder({ topic, algorithm }: { topic: string; algorithm: string }) {
  return <div className="grid min-h-[430px] place-items-center border border-dashed border-slate-300 bg-slate-50 p-8 text-center"><div><span className="mx-auto grid size-12 place-items-center rounded-md bg-white text-slate-400 shadow-sm"><Code2 size={20} /></span><h3 className="mt-4 font-bold text-slate-700">{topic} · {algorithm}</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">该算法已进入分类目录。后续会在这里补充与当前模板一致的步骤动画、代码同步、复杂度和易错点。</p></div></div>;
}
