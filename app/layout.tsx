import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '信奥算法地图｜课堂可视化',
  description: '面向 CSP-J、CSP-S 与 NOIP 的算法可视化课堂。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
