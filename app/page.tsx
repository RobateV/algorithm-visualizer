'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, ChevronRight, Code2, FileText, FolderOpen, Home, Play, RotateCcw, Search, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Method = { name: string; description: string; stage: string; ready?: boolean; lesson?: string; demo?: 'bubble' };
type Topic = { id: string; section: string; title: string; description: string; methods: Method[]; tags: string[] };

const navigation = [
  { name: '算法基础', ids: ['sorting', 'binary', 'prefix'] },
  { name: '搜索', ids: ['search'] },
  { name: '动态规划', ids: ['dp'] },
  { name: '字符串', ids: ['string-match'] },
  { name: '数学', ids: ['number-theory'] },
  { name: '数据结构', ids: ['linear', 'heap-dsu', 'range-query'] },
  { name: '图论', ids: ['graph-store', 'shortest-path', 'spanning-tree', 'connectivity'] },
  { name: '进阶专题', ids: ['offline'] },
];

const topics: Topic[] = [
  { id: 'sorting', section: '算法基础', title: '排序', description: '将一组数据按规则重新排列；重点比较不同排序的稳定性、复杂度与适用场景。', tags: ['比较排序', '稳定性', '复杂度'], methods: [
    { name: '冒泡排序', description: '相邻元素比较并交换，大元素逐轮移动到右侧。', stage: '入门', demo: 'bubble' },
    { name: '选择排序', description: '每轮选出最小元素并放到已排序区末端。', stage: '入门' },
    { name: '插入排序', description: '把当前元素插入前方的有序区间。', stage: '入门' },
    { name: '归并排序', description: '分治排序，并在合并时保持顺序。', stage: 'CSP-S' },
    { name: '快速排序', description: '围绕基准值划分区间并递归处理。', stage: 'CSP-S' },
    { name: '堆排序', description: '借助堆反复取出当前最值。', stage: 'CSP-S' },
  ] },
  { id: 'binary', section: '算法基础', title: '二分', description: '在单调空间中每次排除一半答案；包括有序查找与二分答案。', tags: ['边界', '单调性'], methods: [
    { name: '二分查找', description: '在有序序列中定位目标或插入位置。', stage: '入门' },
    { name: '二分答案', description: '将最优化问题转为判定问题。', stage: 'CSP-J' },
    { name: '实数二分', description: '在精度范围内逼近连续答案。', stage: 'CSP-S' },
  ] },
  { id: 'prefix', section: '算法基础', title: '前缀和与差分', description: '用预处理保存累积信息，快速完成区间查询或批量修改。', tags: ['数组', '区间'], methods: [
    { name: '一维前缀和', description: '用两次前缀和相减得到任意区间和。', stage: 'CSP-J' },
    { name: '二维前缀和', description: '常用于矩形区域统计。', stage: 'CSP-J' },
    { name: '差分', description: '将区间修改浓缩为端点修改。', stage: 'CSP-J' },
  ] },
  { id: 'search', section: '搜索', title: '搜索', description: '把状态空间组织成树或图，系统地探索所有可行状态。', tags: ['DFS', 'BFS', '剪枝'], methods: [
    { name: '深度优先搜索 DFS', description: '一路向深处探索，适合全排列、连通块与回溯。', stage: 'CSP-J' },
    { name: '广度优先搜索 BFS', description: '按层扩展状态，适合无权最短路。', stage: 'CSP-J' },
    { name: '回溯与剪枝', description: '及时放弃无效或不可能更优的分支。', stage: 'CSP-S' },
  ] },
  { id: 'dp', section: '动态规划', title: '动态规划', description: '拆分重叠子问题，定义状态与转移，逐步构造最优答案。', tags: ['状态', '转移', '最优子结构'], methods: [
    { name: '背包 DP', description: '用容量与决策数量描述最常见的选择问题。', stage: 'CSP-J' },
    { name: '线性 DP', description: '沿序列推进状态，例如 LIS 与数字三角形。', stage: 'CSP-J' },
    { name: '区间 DP', description: '按照区间长度推进，解决合并类问题。', stage: 'CSP-S' },
    { name: '树形 DP', description: '在树上自底向上合并子树答案。', stage: 'NOIP' },
    { name: '状态压缩 DP', description: '用二进制集合表达多个选择状态。', stage: 'NOIP' },
  ] },
  { id: 'string-match', section: '字符串', title: '字符串匹配', description: '研究模式串与文本串的关系，避免重复比较。', tags: ['KMP', '哈希', '自动机'], methods: [
    { name: '朴素匹配', description: '逐位置比较，建立匹配过程的直觉。', stage: '入门' },
    { name: 'KMP / 前缀函数', description: '失配时利用已有的前后缀信息跳转。', stage: 'CSP-S', ready: true, lesson: '/lessons/kmp.html' },
    { name: '字符串哈希', description: '把子串映射为可快速比较的数值指纹。', stage: 'CSP-S' },
    { name: 'Z 函数', description: '批量计算每个后缀和原串的最长公共前缀。', stage: 'NOIP' },
  ] },
  { id: 'number-theory', section: '数学', title: '数论基础', description: '处理整数、整除与模运算，是竞赛数学的核心入口。', tags: ['质数', '模运算', '组合'], methods: [
    { name: '快速幂', description: '把指数二进制分解，将乘法降至对数级。', stage: 'CSP-J' },
    { name: '最大公约数与扩展欧几里得', description: '解决整除、逆元和线性方程。', stage: 'CSP-S' },
    { name: '筛法', description: '批量处理质数与算术函数。', stage: 'CSP-S' },
    { name: '组合数与逆元', description: '在模意义下快速计算排列组合。', stage: 'CSP-S' },
  ] },
  { id: 'linear', section: '数据结构', title: '线性数据结构', description: '从线性表出发理解数据的存取顺序与操作约束。', tags: ['链表', '栈', '队列'], methods: [
    { name: '链表与数组模拟链表', description: '可视化指针关系，以及竞赛常用的数组模拟方式。', stage: 'CSP-J', ready: true, lesson: '/lessons/linked-list.html' },
    { name: '栈与队列', description: '分别遵循后进先出与先进先出的访问规则。', stage: 'CSP-J', ready: true, lesson: '/lessons/stack-queue.html' },
    { name: '单调栈与单调队列', description: '维护候选元素，快速找到局部最优。', stage: 'CSP-S' },
  ] },
  { id: 'heap-dsu', section: '数据结构', title: '堆与并查集', description: '两种极高频的集合型结构：维护最值与维护连通块。', tags: ['优先队列', '连通性'], methods: [
    { name: '二叉堆 / 优先队列', description: '支持快速取出当前最小或最大元素。', stage: 'CSP-S' },
    { name: '并查集', description: '路径压缩与按秩合并，快速判断是否属于同一集合。', stage: 'CSP-S' },
  ] },
  { id: 'range-query', section: '数据结构', title: '区间查询结构', description: '在频繁查询与修改之间取得平衡。', tags: ['树状数组', '线段树', 'ST 表'], methods: [
    { name: '树状数组', description: '以二进制低位结构维护前缀信息。', stage: 'CSP-S' },
    { name: '线段树', description: '分治维护区间，支持区间修改与查询。', stage: 'NOIP' },
    { name: 'ST 表', description: '预处理静态区间最值查询。', stage: 'CSP-S' },
  ] },
  { id: 'graph-store', section: '图论', title: '图的存储与遍历', description: '从点和边的表示开始，建立图论算法的共同底座。', tags: ['邻接表', '前向星', '遍历'], methods: [
    { name: '邻接矩阵与邻接表', description: '比较不同图存储方式的空间与遍历代价。', stage: 'CSP-J' },
    { name: '前向星', description: '竞赛中高效、稳定的数组模拟邻接表。', stage: 'CSP-S', ready: true, lesson: '/lessons/forward-star.html' },
    { name: '图上的 DFS / BFS', description: '遍历连通块、层次与可达状态。', stage: 'CSP-J' },
  ] },
  { id: 'shortest-path', section: '图论', title: '最短路问题', description: '求两个点之间代价最小的路径，并根据边权特征选择算法。', tags: ['Dijkstra', 'Floyd', 'Bellman-Ford'], methods: [
    { name: 'Dijkstra', description: '非负边权单源最短路，常配合堆优化。', stage: 'CSP-S' },
    { name: 'Bellman-Ford / SPFA', description: '允许负边并可判断负环。', stage: 'CSP-S' },
    { name: 'Floyd-Warshall', description: '枚举中转点，求全源最短路。', stage: 'CSP-S' },
  ] },
  { id: 'spanning-tree', section: '图论', title: '生成树问题', description: '用最小代价连接所有顶点，理解切分与贪心选择。', tags: ['MST', 'Kruskal', 'Prim'], methods: [
    { name: 'Kruskal', description: '按边权从小到大尝试连接，配合并查集判环。', stage: 'CSP-S' },
    { name: 'Prim', description: '从一个点向外扩张当前生成树。', stage: 'CSP-S' },
    { name: '最小生成树性质', description: '用切分性质理解贪心正确性。', stage: 'CSP-S' },
  ] },
  { id: 'connectivity', section: '图论', title: '连通性相关', description: '研究图在删除点或边后是否仍保持连接。', tags: ['SCC', '割点', '桥'], methods: [
    { name: '强连通分量', description: '在有向图中划分互相可达的点集。', stage: 'NOIP' },
    { name: '割点与桥', description: '找出影响无向图连通性的关键点与关键边。', stage: 'NOIP' },
  ] },
  { id: 'offline', section: '进阶专题', title: '离线与分治技巧', description: '调整处理顺序，或把问题拆分后再合并答案。', tags: ['离线', '分治', '莫队'], methods: [
    { name: '分治', description: '将大问题拆成独立子问题，再合并结果。', stage: 'CSP-S' },
    { name: 'CDQ 分治', description: '处理带有偏序关系的离线统计问题。', stage: 'NOIP' },
    { name: '莫队算法', description: '通过调整查询顺序降低移动代价。', stage: 'NOIP' },
  ] },
];

const bubbleSteps = [
  { active: [0, 1], sorted: [], line: 3, text: '比较相邻的 5 和 1：5 更大，需要交换。', values: [5, 1, 4, 2, 8] },
  { active: [1, 2], sorted: [], line: 3, text: '继续比较 5 和 4：5 仍然向右移动。', values: [1, 5, 4, 2, 8] },
  { active: [2, 3], sorted: [], line: 4, text: '交换后，当前最大的未排序元素逐渐靠近右端。', values: [1, 4, 5, 2, 8] },
  { active: [3, 4], sorted: [4], line: 6, text: '第一轮完成：8 已在最终位置，不必再移动。', values: [1, 4, 2, 5, 8] },
  { active: [], sorted: [0, 1, 2, 3, 4], line: 8, text: '排序完成：每一轮都会将一个最大元素送到右侧。', values: [1, 2, 4, 5, 8] },
];
const codeLines = ['for (int i = 0; i < n - 1; i++) {', '  for (int j = 0; j < n - 1 - i; j++) {', '    if (a[j] > a[j + 1])', '      swap(a[j], a[j + 1]);', '  }', '  // 右侧一个元素已经有序', '}', '// 全部完成'];

export default function HomePage() {
  const [selectedId, setSelectedId] = useState('sorting');
  const [activeMethod, setActiveMethod] = useState('冒泡排序');
  const [query, setQuery] = useState('');
  const [step, setStep] = useState(0);
  const selected = topics.find((topic) => topic.id === selectedId) ?? topics[0];
  const method = selected.methods.find((item) => item.name === activeMethod) ?? selected.methods[0];
  const results = useMemo(() => topics.filter((topic) => `${topic.title}${topic.description}${topic.tags.join('')}${topic.methods.map((item) => item.name).join('')}`.toLowerCase().includes(query.trim().toLowerCase())), [query]);
  const chooseTopic = (topic: Topic) => { setSelectedId(topic.id); setActiveMethod(topic.methods[0].name); setStep(0); document.getElementById('topic')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const chooseMethod = (item: Method) => { setActiveMethod(item.name); setStep(0); };
  const current = bubbleSteps[step];
  return <main className="min-h-screen bg-[#f8fafc] text-slate-800">
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:px-7"><div className="mx-auto flex h-16 max-w-[1540px] items-center gap-4"><button onClick={() => chooseTopic(topics[0])} className="flex shrink-0 items-center gap-2 font-black tracking-tight text-slate-900"><span className="grid size-8 place-items-center rounded-lg bg-sky-600 text-white"><Sparkles size={16} /></span><span>信奥算法地图</span></button><span className="hidden border-l border-slate-200 pl-4 text-sm text-slate-500 md:block">课堂可视化</span><div className="ml-auto flex items-center gap-2"><a className="hidden text-sm font-medium text-slate-600 sm:block" href="#knowledge">知识体系</a><Button variant="outline" className="border-slate-200 bg-white text-slate-700"><BookOpen />课堂模式</Button></div></div></header>
    <div className="mx-auto grid max-w-[1540px] grid-cols-1 lg:grid-cols-[250px_minmax(0,1fr)_210px]">
      <aside className="hidden border-r border-slate-200 bg-white lg:block"><div className="sticky top-16 h-[calc(100vh-64px)] overflow-y-auto px-4 py-6"><a href="#knowledge" className="mb-5 flex items-center gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm font-bold text-sky-700"><Home size={15} />知识体系总览</a><p className="mb-3 px-3 text-[11px] font-bold tracking-[.12em] text-slate-400">算法目录</p>{navigation.map((group) => <div key={group.name} className="mb-4"><p className="px-3 py-1.5 text-sm font-bold text-slate-700">{group.name}</p>{group.ids.map((id) => { const item = topics.find((topic) => topic.id === id); return item ? <button key={id} onClick={() => chooseTopic(item)} className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm transition ${selectedId === id ? 'bg-sky-50 font-bold text-sky-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}>{item.title}</button> : null; })}</div>)}</div></aside>
      <article className="min-w-0 px-4 py-9 md:px-8 lg:px-12">
        <section id="knowledge"><nav className="mb-6 flex items-center gap-1 text-xs text-slate-400"><span>首页</span><ChevronRight size={12} /><span>算法目录</span><ChevronRight size={12} /><span>{selected.section}</span></nav><div className="rounded-2xl border border-slate-200 bg-white p-6 md:p-8"><Badge className="mb-4 bg-sky-100 text-sky-700 hover:bg-sky-100">OI 知识体系 · {selected.section}</Badge><h1 className="text-3xl font-black tracking-tight text-slate-900 md:text-4xl">{selected.title}</h1><p className="mt-4 max-w-3xl leading-8 text-slate-600">{selected.description}</p><div className="mt-5 flex flex-wrap gap-2">{selected.tags.map((tag) => <Badge key={tag} variant="outline" className="border-slate-200 text-slate-500">{tag}</Badge>)}</div></div></section>
        <section className="mt-9"><div className="mb-4 flex items-end justify-between gap-3"><div><p className="wiki-label">本知识点包含</p><h2 className="text-xl font-black text-slate-900">算法与方法</h2></div><span className="text-sm text-slate-400">{selected.methods.length} 个小节</span></div><div className="grid gap-3 sm:grid-cols-2">{selected.methods.map((item, index) => <button key={item.name} onClick={() => chooseMethod(item)} className={`group rounded-xl border p-4 text-left transition ${method.name === item.name ? 'border-sky-400 bg-sky-50 shadow-sm' : 'border-slate-200 bg-white hover:border-sky-200 hover:bg-slate-50'}`}><div className="flex items-center gap-3"><span className={`grid size-8 place-items-center rounded-lg text-sm font-black ${method.name === item.name ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="font-bold text-slate-800">{item.name}</h3>{item.ready && <span className="text-[11px] font-bold text-emerald-600">已可视化</span>}</div><p className="mt-1 text-sm leading-5 text-slate-500">{item.description}</p></div><ChevronRight size={16} className="shrink-0 text-slate-300 group-hover:text-sky-500" /></div></button>)}</div></section>
        <section id="topic" className="mt-10 scroll-mt-20"><div className="mb-4"><p className="wiki-label">互动演示</p><h2 className="text-2xl font-black text-slate-900">{selected.title} · {method.name}</h2></div>{method.ready && method.lesson ? <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-3"><span className="text-sm font-bold">课堂互动教具</span><a className="text-sm font-semibold text-sky-600 hover:text-sky-800" href={method.lesson} target="_blank" rel="noreferrer">全屏打开</a></div><iframe title={`${selected.title} ${method.name} 演示`} className="h-[720px] w-full bg-white" src={method.lesson} /></div> : method.demo === 'bubble' ? <BubbleDemo step={step} current={current} setStep={setStep} /> : <section className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center"><span className="mx-auto grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-400"><Code2 size={20} /></span><h3 className="mt-4 font-bold text-slate-800">{method.name}可视化正在制作</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">它已纳入完整知识体系。第一期先完成目录、讲解框架和高频教具，后续将在这个小节中补充动画、代码同步和练习。</p></section>}</section>
        <section className="mt-14 border-t border-slate-200 pt-9"><p className="wiki-label">全部知识点</p><div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-2xl font-black text-slate-900">按知识体系浏览</h2><p className="mt-1 text-sm text-slate-500">先选知识点，再进入其中的算法与方法。</p></div><label className="relative w-full sm:w-64"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-400" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="border-slate-200 bg-white pl-9" placeholder="搜索知识点或算法" /></label></div><div className="grid gap-3 sm:grid-cols-2">{results.map((topic) => <button key={topic.id} onClick={() => chooseTopic(topic)} className={`rounded-xl border p-4 text-left transition ${selectedId === topic.id ? 'border-sky-400 bg-sky-50' : 'border-slate-200 bg-white hover:border-sky-200'}`}><p className="text-xs font-bold text-sky-600">{topic.section}</p><h3 className="mt-1 font-bold">{topic.title}</h3><p className="mt-2 line-clamp-2 text-sm text-slate-500">{topic.methods.map((item) => item.name).join(' · ')}</p></button>)}</div></section>
      </article>
      <aside className="hidden lg:block"><div className="sticky top-16 px-5 py-8"><p className="mb-3 border-l-2 border-sky-500 pl-3 text-sm font-black text-slate-700">本页目录</p><div className="space-y-2 border-l border-slate-200 pl-3 text-sm text-slate-500"><a className="block hover:text-sky-600" href="#knowledge">{selected.title}简介</a><a className="block hover:text-sky-600" href="#topic">算法与方法</a><a className="block hover:text-sky-600" href="#topic">互动演示</a><a className="block hover:text-sky-600" href="#knowledge">前置知识</a></div><div className="mt-8 rounded-xl bg-sky-50 p-4 text-xs leading-5 text-sky-800"><b>课堂提示</b><br />先用“算法与方法”总览不同思路，再选一个方法进入动画演示。</div></div></aside>
    </div>
  </main>;
}

function BubbleDemo({ step, current, setStep }: { step: number; current: typeof bubbleSteps[number]; setStep: (value: number | ((old: number) => number)) => void }) {
  return <div className="grid overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[.85fr_1.15fr]"><div className="border-b border-slate-200 p-5 lg:border-b-0 lg:border-r"><div className="mb-4 flex items-center justify-between"><span className="font-bold">C++ 代码同步</span><Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">第 {step + 1} 步</Badge></div><pre className="overflow-auto rounded-xl bg-slate-950 p-4 text-sm leading-7 text-slate-300">{codeLines.map((line, index) => <code key={line} className={`block rounded px-2 ${index + 1 === current.line ? 'bg-amber-400/20 text-amber-100' : ''}`}><span className="mr-4 select-none text-slate-600">{String(index + 1).padStart(2, '0')}</span>{line}</code>)}</pre><p className="mt-4 rounded-xl bg-sky-50 p-4 text-sm leading-6 text-slate-600"><b className="text-sky-700">讲解：</b>{current.text}</p></div><div className="p-5"><div className="mb-4 flex items-center justify-between"><span className="font-bold">数据动画</span><span className="text-xs text-slate-400">数组 a[5]</span></div><div className="grid min-h-56 place-items-center rounded-xl bg-gradient-to-br from-sky-50 to-indigo-50 p-4"><div className="flex flex-wrap justify-center gap-3">{current.values.map((value, index) => <div key={`${value}-${index}`}><div className={`grid size-14 place-items-center rounded-xl border-2 text-xl font-black transition-all duration-500 ${current.sorted.includes(index) ? 'border-emerald-400 bg-emerald-100 text-emerald-700' : current.active.includes(index) ? 'scale-110 border-amber-400 bg-amber-100 text-amber-700 shadow-lg shadow-amber-100' : 'border-sky-300 bg-white text-sky-700'}`}>{value}</div><span className="mt-2 block text-center text-xs font-mono text-slate-400">{index}</span></div>)}</div></div><div className="mt-5 flex flex-wrap items-center gap-2"><Button variant="outline" onClick={() => setStep((value) => Math.max(value - 1, 0))} disabled={step === 0}><ArrowLeft />上一步</Button><Button className="bg-sky-600 hover:bg-sky-700" onClick={() => setStep((value) => Math.min(value + 1, bubbleSteps.length - 1))} disabled={step === bubbleSteps.length - 1}><Play />下一步</Button><Button variant="ghost" onClick={() => setStep(0)}><RotateCcw />重置</Button></div></div></div>;
}
