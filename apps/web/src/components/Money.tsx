import { usePrefs } from '../lib/prefs';
import { dirClass, direction, formatMoney, formatPct } from '../lib/format';

/** 金额。隐私模式下统一打码 —— 一处生效，全站一致，方便截图分享。 */
export function Money({
  value,
  sign = false,
  className = '',
  colored = false,
}: {
  value: number;
  sign?: boolean;
  className?: string;
  /** 按涨跌着色（收益类金额用） */
  colored?: boolean;
}) {
  const { privacy } = usePrefs();
  const color = colored ? dirClass[direction(value)] : '';
  return (
    <span className={`${color} ${className}`}>
      {privacy ? '¥****' : formatMoney(value, { sign })}
    </span>
  );
}

/** 涨跌幅文本，自动着色。null 显示占位破折号。 */
export function Change({
  value,
  className = '',
  digits = 2,
}: {
  value: number | null | undefined;
  className?: string;
  digits?: number;
}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span className={`text-ink-faintest ${className}`}>——</span>;
  }
  return (
    <span className={`${dirClass[direction(value)]} ${className}`}>
      {formatPct(value, { digits })}
    </span>
  );
}
