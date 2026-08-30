'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Check, ChevronRight, Code2, Layers3, Maximize2, Play, RotateCcw, Search, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';

type Algorithm = { title: string; category: string; stage: string; difficulty: string; description: string; tags: string[]; ready?: boolean; lesson?: string };

const categories = [
  { name: '全部知识点', icon: '✦' }, { name: '基础算法', icon: '⌁' }, { name: '数据结构', icon: '▦' }, { name: '图论', icon: '◌' },
  { name: '动态规划', icon: '⊞' }, { name: '字符串', icon: 'Aa' }, { name: '数学', icon: 'π' }, { name: '进阶专题', icon: '↗' },
];

const algorithms: Algorithm[] = [
  { title: '冒泡排序', category: '基础算法', stage: '入门', difficulty: '基础', description: '通过相邻比较与交换，直观看见「较大元素向右冒泡」。', tags: ['排序', '模拟'] },
  { title: '二分查找', category: '基础算法', stage: '入门', difficulty: '基础', description: '在有序答案中不断排除一半区间，理解边界与循环不变量。', tags: ['查找', '边界'] },
  { title: '前缀和与差分', category: '基础算法', stage: 'CSP-J', difficulty: '基础', description: '将重复区间计算转化为一次预处理与快速查询。', tags: ['数组', '区间'] },
  { title: '双指针', category: '基础算法', stage: 'CSP-J', difficulty: '基础', description: '让两个指针协作移动，降低枚举的复杂度。', tags: ['数组', '优化'] },
  { title: '单链表与双链表', category: '数据结构', stage: 'CSP-J', difficulty: '基础', description: '从指针模型到数组模拟，掌握插入、删除与遍历。', tags: ['链表', '指针'], ready: true, lesson: '/lessons/linked-list.html' },
  { title: '栈与队列', category: '数据结构', stage: 'CSP-J', difficulty: '基础', description: '用 LIFO 与 FIFO 理解递归、表达式和搜索队列。', tags: ['线性结构', 'STL'], ready: true, lesson: '/lessons/stack-queue.html' },
  { title: '前向星', category: '数据结构', stage: 'CSP-S', difficulty: '核心', description: '竞赛图论常用存图方式：数组模拟邻接表。', tags: ['图存储', '数组'], ready: true, lesson: '/lessons/forward-star.html' },
  { title: '并查集', category: '数据结构', stage: 'CSP-S', difficulty: '核心', description: '路径压缩与按秩合并，快速判断连通关系。', tags: ['集合', '图论'] },
  { title: '堆与优先队列', category: '数据结构', stage: 'CSP-S', difficulty: '核心', description: '用完全二叉树维护当前最值，为贪心与最短路服务。', tags: ['堆', '贪心'] },
  { title: 'BFS 与 DFS', category: '图论', stage: 'CSP-J', difficulty: '基础', description: '两种遍历图的基本方式：一层层扩展与一路到底回溯。', tags: ['搜索', '遍历'] },
  { title: 'Dijkstra 最短路', category: '图论', stage: 'CSP-S', difficulty: '核心', description: '每次确定一个最近点，配合堆优化求单源最短路。', tags: ['最短路', '贪心'] },
  { title: '最小生成树', category: '图论', stage: 'CSP-S', difficulty: '核心', description: '用 Kruskal 或 Prim 以最小代价连接所有点。', tags: ['Kruskal', 'Prim'] },
  { title: '0/1 背包', category: '动态规划', stage: 'CSP-J', difficulty: '核心', description: '用状态表示「容量与最优价值」，理解倒序转移。', tags: ['背包', '状态转移'] },
  { title: '最长上升子序列', category: '动态规划', stage: 'CSP-S', difficulty: '核心', description: '从 O(n²) 状态转移到二分优化，比较两种思路。', tags: ['LIS', '二分'] },
  { title: '树形 DP', category: '动态规划', stage: 'NOIP', difficulty: '进阶', description: '在树上定义子问题，让答案自底向上汇聚。', tags: ['树', 'DP'] },
  { title: 'KMP 字符串匹配', category: '字符串', stage: 'CSP-S', difficulty: '核心', description: '通过前缀函数避免主串回退，理解失配跳转。', tags: ['KMP', '前缀函数'], ready: true, lesson: '/lessons/kmp.html' },
  { title: '字符串哈希', category: '字符串', stage: 'CSP-S', difficulty: '核心', description: '把子串变为可快速比较的数值指纹。', tags: ['哈希', '字符串'] },
  { title: '快速幂', category: '数学', stage: 'CSP-J', difficulty: '基础', description: '把指数二进制分解，将乘法次数降到对数级。', tags: ['二进制', '递归'] },
  { title: '质数筛', category: '数学', stage: 'CSP-S', difficulty: '核心', description: '用合数标记批量筛出质数，比较不同筛法。', tags: ['数论', '筛法'] },
  { title: '树状数组', category: '进阶专题', stage: 'CSP-S', difficulty: '核心', description: '以二进制低位组织区间信息，支持快速修改与查询。', tags: ['数据结构', '区间'] },
];

const bubbleSteps = [
  { active: [0, 1], sorted: [], line: 3, text: '比较相邻的 5 和 1：5 更大，需要交换。', values: [5, 1, 4, 2, 8] },
  { active: [1, 2], sorted: [], line: 3, text: '继续比较 5 和 4：5 仍然向右移动。', values: [1, 5, 4, 2, 8] },
  { active: [2, 3], sorted: [], line: 4, text: '交换后，当前最大的未排序元素逐渐靠近右端。', values: [1, 4, 5, 2, 8] },
  { active: [3, 4], sorted: [4], line: 6, text: '第一轮完成：8 已经在最终位置，不必再移动。', values: [1, 4, 2, 5, 8] },
  { active: [], sorted: [0, 1, 2, 3, 4], line: 8, text: '排序完成：每一轮都会将一个最大元素送到右侧。', values: [1, 2, 4, 5, 8] },
];
const codeLines = ['for (int i = 0; i < n - 1; i++) {', '  for (int j = 0; j < n - 1 - i; j++) {', '    if (a[j] > a[j + 1])', '      swap(a[j], a[j + 1]);', '  }', '  // 右侧的一个元素已经有序', '}', '// 全部完成'];

export default function Home() {
  const [category, setCategory] = useState('全部知识点');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Algorithm>(algorithms[0]);
  const [step, setStep] = useState(0);
  const visible = useMemo(() => algorithms.filter((item) => (category === '全部知识点' || item.category === category) && `${item.title}${item.description}${item.tags.join('')}`.toLowerCase().includes(query.trim().toLowerCase())), [category, query]);
  const current = bubbleSteps[step];
  const choose = (item: Algorithm) => { setSelected(item); setStep(0); };
  return <main className="min-h-screen bg-[#f7fbff] text-slate-900">
    <nav className="sticky top-0 z-30 border-b border-sky-100 bg-white/90 px-4 py-3 backdrop-blur lg:px-8"><div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4">
      <button className="flex items-center gap-3 text-left" onClick={() => { setCategory('全部知识点'); choose(algorithms[0]); }}><span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-lg text-white shadow-lg shadow-sky-200"><Sparkles size={19} /></span><span><b className="block text-base tracking-tight">信奥算法地图</b><small className="text-xs text-slate-500">课堂可视化 · 第一阶段</small></span></button>
      <div className="hidden items-center gap-6 text-sm font-medium text-slate-600 md:flex"><a href="#catalog">知识地图</a><a href="#player">互动演示</a><a href="#roadmap">学习路径</a></div><Button variant="outline" className="border-sky-200 text-sky-700"><BookOpen />教师演示模式</Button>
    </div></nav>
    <section className="hero-grid border-b border-sky-100 px-4 pb-12 pt-12 lg:px-8"><div className="mx-auto grid max-w-[1500px] items-center gap-10 lg:grid-cols-[1.1fr_.9fr]">
      <div><Badge className="mb-5 bg-sky-100 text-sky-700 hover:bg-sky-100">面向 CSP-J / CSP-S / NOIP 的算法课堂</Badge><h1 className="max-w-3xl text-4xl font-black tracking-[-.04em] text-slate-900 md:text-6xl">把抽象算法，<br /><span className="text-sky-600">讲成看得见的过程。</span></h1><p className="mt-5 max-w-xl text-lg leading-8 text-slate-600">从第一次循环到 NOIP 核心专题。每个知识点都有动画、代码同步和可直接用于课堂的分步讲解。</p><div className="mt-7 flex flex-wrap gap-3"><Button className="h-11 bg-sky-600 px-5 hover:bg-sky-700" onClick={() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth' })}><Layers3 />浏览知识地图</Button><Button className="h-11 border-sky-200 bg-white px-5 text-sky-700" variant="outline" onClick={() => document.getElementById('player')?.scrollIntoView({ behavior: 'smooth' })}><Play />开始演示</Button></div></div>
      <div className="relative mx-auto w-full max-w-[540px] rounded-[28px] border border-sky-100 bg-white p-5 shadow-[0_24px_80px_rgba(14,116,144,.15)]"><div className="mb-5 flex items-center justify-between"><span className="font-bold">今日课堂 · 算法之旅</span><Badge variant="secondary" className="bg-emerald-100 text-emerald-700">4 个已就绪教具</Badge></div><div className="space-y-3">{['基础算法：用循环解决问题', '数据结构：让数据井然有序', '图论：从点与边开始探索'].map((item, index) => <div key={item} className="flex items-center gap-3 rounded-2xl border border-slate-100 p-3"><span className={`grid size-9 place-items-center rounded-xl font-bold ${index === 0 ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{index + 1}</span><span className="flex-1 text-sm font-semibold">{item}</span>{index === 0 ? <Check size={17} className="text-emerald-500" /> : <ChevronRight size={17} className="text-slate-300" />}</div>)}</div><div className="mt-5"><Progress value={33} className="text-xs text-slate-500"><span>你的学习路线</span><span className="ml-auto">1 / 3 已开启</span></Progress></div></div>
    </div></section>
    <section id="catalog" className="mx-auto max-w-[1500px] px-4 py-14 lg:px-8"><div className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end"><div><p className="section-kicker">知识地图</p><h2 className="text-3xl font-black tracking-tight">按知识点选课</h2><p className="mt-2 text-slate-500">第一期收录 20 个高频算法入口，已完成的课堂教具可立即演示。</p></div><label className="relative w-full md:w-72"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-400" /><Input value={query} onChange={(e) => setQuery(e.target.value)} className="border-sky-100 bg-white pl-9" placeholder="搜索算法、标签…" /></label></div>
      <div className="mb-8 flex gap-2 overflow-x-auto pb-2">{categories.map((item) => <button key={item.name} onClick={() => setCategory(item.name)} className={`shrink-0 rounded-xl border px-3 py-2 text-sm font-semibold transition ${category === item.name ? 'border-sky-600 bg-sky-600 text-white shadow-md shadow-sky-100' : 'border-sky-100 bg-white text-slate-600 hover:border-sky-300'}`}><span className="mr-2 opacity-80">{item.icon}</span>{item.name}</button>)}</div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{visible.map((item) => <button key={item.title} onClick={() => choose(item)} className={`group min-h-48 rounded-2xl border p-5 text-left transition hover:-translate-y-1 hover:shadow-xl hover:shadow-sky-100 ${selected.title === item.title ? 'border-sky-400 bg-sky-50/70 shadow-lg shadow-sky-100' : 'border-sky-100 bg-white'}`}><div className="mb-5 flex items-start justify-between gap-3"><span className="grid size-10 place-items-center rounded-xl bg-sky-100 text-sky-600"><Code2 size={19} /></span>{item.ready ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">可演示</Badge> : <Badge variant="secondary" className="bg-slate-100 text-slate-500">准备中</Badge>}</div><h3 className="font-bold">{item.title}</h3><p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-500">{item.description}</p><div className="mt-4 flex items-center gap-2"><span className="text-xs font-semibold text-sky-600">{item.stage}</span><span className="text-xs text-slate-400">· {item.difficulty}</span><ChevronRight className="ml-auto size-4 text-slate-300 group-hover:text-sky-500" /></div></button>)}</div>
      {visible.length === 0 && <div className="rounded-2xl border border-dashed border-sky-200 bg-white p-12 text-center text-slate-500">没有找到相关算法，换一个关键词试试。</div>}
    </section>
    <section id="player" className="border-y border-sky-100 bg-[#edf8ff] px-4 py-14 lg:px-8"><div className="mx-auto max-w-[1500px]"><div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="section-kicker">算法播放器</p><h2 className="text-3xl font-black tracking-tight">{selected.title}</h2><p className="mt-2 max-w-2xl text-slate-600">{selected.description}</p></div><div className="flex gap-2"><Badge variant="outline" className="border-sky-200 bg-white text-sky-700">{selected.category}</Badge><Badge variant="outline" className="border-sky-200 bg-white text-sky-700">{selected.stage}</Badge></div></div>
      {selected.ready && selected.lesson ? <div className="overflow-hidden rounded-3xl border border-sky-200 bg-white shadow-xl shadow-sky-100"><div className="flex items-center justify-between border-b border-sky-100 px-5 py-3"><span className="text-sm font-bold text-slate-700">已迁移的完整课堂教具</span><a className="flex items-center gap-1 text-sm font-semibold text-sky-600 hover:text-sky-800" href={selected.lesson} target="_blank" rel="noreferrer"><Maximize2 size={15} />全屏打开</a></div><iframe title={`${selected.title}互动演示`} className="h-[720px] w-full bg-white" src={selected.lesson} /></div> : <div className="grid overflow-hidden rounded-3xl border border-sky-200 bg-white shadow-xl shadow-sky-100 lg:grid-cols-[.9fr_1.1fr]"><div className="border-b border-sky-100 p-6 lg:border-b-0 lg:border-r"><div className="mb-4 flex items-center justify-between"><span className="font-bold">C++ 代码同步</span><Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">第 {step + 1} 步</Badge></div><pre className="overflow-auto rounded-2xl bg-slate-950 p-4 text-sm leading-7 text-slate-300">{codeLines.map((line, index) => <code key={line} className={`block rounded px-2 ${index + 1 === current.line ? 'bg-amber-400/20 text-amber-200' : ''}`}><span className="mr-4 select-none text-slate-600">{String(index + 1).padStart(2, '0')}</span>{line}</code>)}</pre><div className="mt-5 rounded-2xl bg-sky-50 p-4 text-sm leading-6 text-slate-600"><b className="text-sky-700">讲解：</b>{current.text}</div></div><div className="p-6"><div className="mb-5 flex items-center justify-between"><span className="font-bold">数据动画</span><span className="text-xs text-slate-400">数组 a[5]</span></div><div className="grid min-h-56 place-items-center rounded-2xl bg-gradient-to-br from-sky-50 to-indigo-50 p-4"><div className="flex flex-wrap justify-center gap-3">{current.values.map((value, index) => <div key={`${value}-${index}`}><div className={`grid size-14 place-items-center rounded-xl border-2 text-xl font-black transition-all duration-500 ${current.sorted.includes(index) ? 'border-emerald-400 bg-emerald-100 text-emerald-700' : current.active.includes(index) ? 'scale-110 border-amber-400 bg-amber-100 text-amber-700 shadow-lg shadow-amber-100' : 'border-sky-300 bg-white text-sky-700'}`}>{value}</div><span className="mt-2 block text-center text-xs font-mono text-slate-400">{index}</span></div>)}</div></div><div className="mt-5 flex flex-wrap items-center gap-2"><Button variant="outline" onClick={() => setStep((value) => Math.max(value - 1, 0))} disabled={step === 0}><ArrowLeft />上一步</Button><Button className="bg-sky-600 hover:bg-sky-700" onClick={() => setStep((value) => Math.min(value + 1, bubbleSteps.length - 1))} disabled={step === bubbleSteps.length - 1}><Play />下一步</Button><Button variant="ghost" onClick={() => setStep(0)}><RotateCcw />重置</Button><span className="ml-auto text-xs text-slate-400">时间 O(n²) · 空间 O(1)</span></div></div></div>}
    </div></section>
    <section id="roadmap" className="mx-auto max-w-[1500px] px-4 py-14 lg:px-8"><p className="section-kicker">学习路径</p><h2 className="text-3xl font-black tracking-tight">先打基础，再挑战 NOIP</h2><div className="mt-8 grid gap-4 md:grid-cols-3">{[{ stage: '01 · 入门', text: '循环、数组、排序、二分、递归', accent: 'sky' }, { stage: '02 · CSP-J / CSP-S', text: '基础数据结构、搜索、图论、背包与字符串', accent: 'violet' }, { stage: '03 · NOIP 核心', text: '树形 DP、网络流、进阶数据结构与综合技巧', accent: 'amber' }].map((item) => <article key={item.stage} className="rounded-2xl border border-sky-100 bg-white p-6"><span className="text-sm font-bold text-sky-600">{item.stage}</span><p className="mt-3 text-lg font-bold">{item.text}</p><p className="mt-3 text-sm leading-6 text-slate-500">每个阶段都以可视化、模板、易错点和练习相连。</p></article>)}</div></section>
    <footer className="border-t border-sky-100 bg-white px-4 py-8 text-center text-sm text-slate-500">信奥算法地图 · 第一阶段原型 · 为课堂讲解而设计</footer>
  </main>;
}
