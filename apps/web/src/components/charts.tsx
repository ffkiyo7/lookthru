import { useMemo } from 'react';

/**
 * 净值走势。
 *
 * ⚠️ 只画官方净值，盘中估算绝不混入历史曲线 —— 两个「真相」必须分离，
 * 否则历史会被估算值污染（见方案 3.2）。
 */
export function NavChart({
  data,
  className = '',
}: {
  /** 官方单位净值序列，按时间升序 */
  data: number[];
  className?: string;
}) {
  const { line, area, rising } = useMemo(() => {
    const W = 350;
    const H = 130;
    const P = 8;
    if (data.length < 2) return { line: '', area: '', rising: true };

    const min = Math.min(...data);
    const max = Math.max(...data);
    const rng = max - min || 1;

    const pts = data.map((val, i) => {
      const x = P + ((W - 2 * P) * i) / (data.length - 1);
      const y = P + (H - 2 * P) * (1 - (val - min) / rng);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const l = pts.join(' ');
    return {
      line: l,
      area: `${P},${H - P} ${l} ${W - P},${H - P}`,
      rising: data[data.length - 1]! >= data[0]!,
    };
  }, [data]);

  // 区间涨跌决定曲线颜色，跟随全局涨跌配色
  const stroke = rising ? 'var(--color-up)' : 'var(--color-down)';
  const gid = rising ? 'navfill-up' : 'navfill-down';

  return (
    <svg
      viewBox="0 0 350 130"
      width="100%"
      height="130"
      preserveAspectRatio="none"
      className={`block overflow-visible ${className}`}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={area} fill={`url(#${gid})`} stroke="none" />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface DonutSegment {
  name: string;
  pct: number;
  color: string;
}

/** 行业集中度环形图 */
export function Donut({ segments, size = 130 }: { segments: DonutSegment[]; size?: number }) {
  const R = 48;
  const C = 2 * Math.PI * R;

  const arcs = useMemo(() => {
    let cum = 0;
    return segments.map((s) => {
      const len = (s.pct / 100) * C;
      const arc = {
        color: s.color,
        dash: `${len.toFixed(2)} ${(C - len).toFixed(2)}`,
        offset: (-cum).toFixed(2),
      };
      cum += len;
      return arc;
    });
  }, [segments, C]);

  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className="-rotate-90">
      {arcs.map((a, i) => (
        <circle
          key={i}
          cx="60"
          cy="60"
          r={R}
          fill="none"
          stroke={a.color}
          strokeWidth="15"
          strokeDasharray={a.dash}
          strokeDashoffset={a.offset}
        />
      ))}
    </svg>
  );
}

/** 生成演示用净值序列。接真实数据后删除。 */
export function genSeries(n: number, start: number, vol: number, drift: number, seed: number) {
  let s = seed;
  let v = start;
  const out: number[] = [];
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = 0; i < n; i++) {
    v = v * (1 + drift + (rnd() - 0.5) * vol);
    out.push(v);
  }
  return out;
}
