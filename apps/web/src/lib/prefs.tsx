import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * 全局偏好。两项是跨页面的：
 *  · 涨跌配色 —— 翻转 <html data-updown>，全站 text-up/text-down 自动跟随，组件无需感知
 *  · 金额隐私 —— 所有 <Money> 一起打码，适合截图分享
 */

export type UpDownScheme = 'red-up' | 'green-up';
export type RefreshFreq = '1m' | '5m' | 'manual';

export interface Prefs {
  updown: UpDownScheme;
  privacy: boolean;
  freq: RefreshFreq;
}

const DEFAULTS: Prefs = { updown: 'red-up', privacy: false, freq: '1m' };
const STORAGE_KEY = 'qd2.prefs';

interface PrefsContextValue extends Prefs {
  set: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
}

const PrefsContext = createContext<PrefsContextValue | null>(null);

function load(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      updown: parsed.updown === 'green-up' ? 'green-up' : DEFAULTS.updown,
      privacy: typeof parsed.privacy === 'boolean' ? parsed.privacy : DEFAULTS.privacy,
      freq:
        parsed.freq === '5m' || parsed.freq === 'manual' || parsed.freq === '1m'
          ? parsed.freq
          : DEFAULTS.freq,
    };
  } catch {
    return DEFAULTS;
  }
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(load);

  // 只有非默认值才写 data 属性，默认(红涨绿跌)走 :root 基线
  useEffect(() => {
    const el = document.documentElement;
    if (prefs.updown === 'green-up') el.dataset.updown = 'green-up';
    else delete el.dataset.updown;
  }, [prefs.updown]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // 隐私模式浏览器下 localStorage 可能不可写，不影响使用
    }
  }, [prefs]);

  const set = useCallback<PrefsContextValue['set']>((key, value) => {
    setPrefs((p) => ({ ...p, [key]: value }));
  }, []);

  const value = useMemo<PrefsContextValue>(() => ({ ...prefs, set }), [prefs, set]);

  return <PrefsContext value={value}>{children}</PrefsContext>;
}

export function usePrefs(): PrefsContextValue {
  const ctx = use(PrefsContext);
  if (!ctx) throw new Error('usePrefs 必须在 <PrefsProvider> 内使用');
  return ctx;
}

/** 交易时段内的轮询间隔（毫秒）。manual 返回 false，交给 TanStack Query 关闭轮询。 */
export function refreshInterval(freq: RefreshFreq): number | false {
  if (freq === '1m') return 60_000;
  if (freq === '5m') return 300_000;
  return false;
}
