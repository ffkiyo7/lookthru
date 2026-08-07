import { NavLink, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * 设计稿是固定 390×844 的手机画框。真机上要撑满视口，
 * 底部 tab 用 safe-area-inset 兜住 iPhone 的 home indicator。
 */

const TABS = [
  {
    to: '/',
    label: '持仓',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
        <rect x="4" y="13" width="3.4" height="7" rx="1" />
        <rect x="10.3" y="8" width="3.4" height="12" rx="1" />
        <rect x="16.6" y="4" width="3.4" height="16" rx="1" />
      </svg>
    ),
  },
  {
    to: '/search',
    label: '搜索',
    icon: (
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="6.5" />
        <line x1="16" y1="16" x2="20" y2="20" />
      </svg>
    ),
  },
  {
    to: '/xray',
    label: '穿透',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3.2" />
      </svg>
    ),
  },
  {
    to: '/settings',
    label: '我的',
    icon: (
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      >
        <circle cx="12" cy="8" r="3.6" />
        <path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      </svg>
    ),
  },
];

export function TabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-[430px] border-t border-line-soft bg-[rgba(12,13,17,.94)] px-2 pt-2.5 pb-[max(env(safe-area-inset-bottom),10px)] backdrop-blur-xl">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === '/'}
          className={({ isActive }) =>
            `flex flex-1 flex-col items-center gap-1.5 ${
              isActive ? 'text-[#e8e9ec]' : 'text-[#62666e]'
            }`
          }
        >
          {({ isActive }) => (
            <>
              {t.icon}
              <span className={`text-[10.5px] ${isActive ? 'font-semibold' : ''}`}>{t.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

/** 带 tab bar 的页面容器 */
export function AppShell() {
  return (
    <div className="mx-auto min-h-dvh max-w-[430px] px-4 pb-[108px]">
      <Outlet />
      <TabBar />
    </div>
  );
}

/** 无 tab bar 的次级页容器（基金详情等） */
export function SubPage({ children, bottomBar }: { children: ReactNode; bottomBar?: ReactNode }) {
  return (
    <div className={`mx-auto min-h-dvh max-w-[430px] px-4 ${bottomBar ? 'pb-[110px]' : 'pb-10'}`}>
      {children}
      {bottomBar}
    </div>
  );
}
