import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Change } from '../components/Money';
import { formatNav } from '../lib/format';
import { FUND_TYPE_FILTERS, type FundTypeFilter } from '@lookthru/shared';
import { searchFunds, shortType, type SearchHit } from '../lib/api';

/** 与空态热门关键词同一套 chip，选中态复用本页已有的 accent 描边/底。 */
const CHIP =
  'rounded-[20px] border border-line-soft bg-raised px-[15px] py-2 text-[13px] text-ink-body';
const CHIP_ACTIVE =
  'rounded-[20px] border border-accent/50 bg-accent/12 px-[15px] py-2 text-[13px] text-accent-soft';

const HOT_KEYWORDS = [
  '白酒',
  '医药',
  '新能源',
  '半导体',
  '沪深300',
  '中概互联',
  '黄金',
  '红利低波',
  '纳指ETF',
  '军工',
];

export function Search() {
  const [input, setInput] = useState('');
  const [debounced, setDebounced] = useState('');
  const [typeFilter, setTypeFilter] = useState<FundTypeFilter>('all');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['search', debounced, typeFilter],
    queryFn: () => searchFunds(debounced, typeFilter),
    enabled: debounced.length > 0,
    staleTime: 60_000,
  });

  const isPinyin = /^[a-z]+$/i.test(debounced);

  return (
    // 不要在这里再写 min-h-dvh —— AppShell 已经是整屏高，嵌套会多出一屏可滚区域，
    // 表现为「怎么拉都还能再拉一点」
    <div className="flex flex-col">
      <div className="flex shrink-0 items-center gap-3 pt-4 pb-3">
        <div
          className={`flex flex-1 items-center gap-2.5 rounded-xl border bg-raised px-3.5 py-[11px] transition-colors ${
            input ? 'border-accent/50' : 'border-line-soft'
          }`}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke={input ? 'var(--color-accent)' : '#63676f'}
            strokeWidth="1.8"
            strokeLinecap="round"
            className="shrink-0"
          >
            <circle cx="11" cy="11" r="6.5" />
            <line x1="16" y1="16" x2="20" y2="20" />
          </svg>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="基金名称 / 代码 / 拼音首字母"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faintest"
          />
          {input && (
            <button
              type="button"
              onClick={() => setInput('')}
              className="flex size-[17px] shrink-0 items-center justify-center rounded-full bg-[#3a3d45]"
              aria-label="清空"
            >
              <svg
                width="9"
                height="9"
                viewBox="0 0 24 24"
                stroke="#c3c7ce"
                strokeWidth="3"
                strokeLinecap="round"
              >
                <line x1="5" y1="5" x2="19" y2="19" />
                <line x1="19" y1="5" x2="5" y2="19" />
              </svg>
            </button>
          )}
        </div>
        {input && (
          <button type="button" onClick={() => setInput('')} className="text-sm text-ink-muted">
            取消
          </button>
        )}
      </div>

      {debounced === '' ? (
        <EmptyState onPick={setInput} />
      ) : (
        <div className="flex-1">
          <TypeFilters value={typeFilter} onChange={setTypeFilter} />
          {isPinyin && (
            <div className="flex items-center gap-1.5 px-0.5 pt-0.5 pb-2">
              <span className="text-[11.5px] text-ink-faint">拼音首字母匹配</span>
              <span className="rounded-md bg-accent/12 px-[7px] py-0.5 text-[10px] font-semibold text-accent-soft">
                {debounced} → 模糊匹配
              </span>
            </div>
          )}

          {isFetching && !data && <Hint>搜索中…</Hint>}
          {isError && <Hint>搜索失败，请稍后重试</Hint>}
          {data && data.length === 0 && <Hint>没有找到相关基金</Hint>}

          {data && data.length > 0 && (
            <>
              <div className="px-0.5 pt-0.5 pb-1.5 text-[11.5px] text-ink-faint">
                找到 {data.length} 只相关基金
              </div>
              {data.map((hit, i) => (
                <ResultRow
                  key={hit.code}
                  hit={hit}
                  keyword={debounced}
                  last={i === data.length - 1}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div className="px-0.5 py-6 text-center text-[13px] text-ink-faint">{children}</div>;
}

function TypeFilters({
  value,
  onChange,
}: {
  value: FundTypeFilter;
  onChange: (next: FundTypeFilter) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2.5 px-0.5 pt-0.5 pb-2">
      {FUND_TYPE_FILTERS.map((filter) => {
        const active = filter.value === value;
        return (
          <button
            key={filter.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(filter.value)}
            className={active ? CHIP_ACTIVE : CHIP}
          >
            {filter.label}
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (kw: string) => void }) {
  return (
    <>
      <div className="mt-6 mb-3.5 px-0.5 text-[13px] font-semibold">热门搜索</div>
      <div className="flex flex-wrap gap-2.5">
        {HOT_KEYWORDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onPick(k)}
            className={CHIP}
          >
            {k}
          </button>
        ))}
      </div>
    </>
  );
}

function ResultRow({ hit, keyword, last }: { hit: SearchHit; keyword: string; last: boolean }) {
  return (
    <div
      className={`flex items-center gap-3 px-0.5 py-3 ${last ? '' : 'border-b border-line-soft'}`}
    >
      <Link to={`/fund/${hit.code}`} className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          <Highlight text={hit.name} keyword={keyword} />
        </div>
        <div className="mt-[3px] text-[11px] text-ink-dimmer">
          {hit.code}
          {hit.type && ` · ${shortType(hit.type)}`}
        </div>
      </Link>
      {hit.nav !== null && (
        <div className="shrink-0 text-right">
          {/* 货币基金的 DWJZ 是万份收益，不是净值 —— 标签必须区分，否则是误导 */}
          <div className="text-[10.5px] text-ink-muted">
            {hit.isMoneyFund ? '万份收益' : '净值'}
          </div>
          <div className="mt-0.5 text-sm font-semibold">
            {hit.isMoneyFund ? hit.nav.toFixed(4) : formatNav(hit.nav)}
          </div>
        </div>
      )}
      <Link
        to={`/fund/${hit.code}`}
        className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] border border-accent/40 bg-accent/12 text-accent-soft"
        aria-label="查看并记录持仓"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </Link>
    </div>
  );
}

/** 匹配片段高亮。拼音输入时按拼音命中，中文名称里找不到对应片段，此时不高亮。 */
function Highlight({ text, keyword }: { text: string; keyword: string }) {
  const idx = keyword ? text.indexOf(keyword) : -1;
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-bold text-accent-soft">{text.slice(idx, idx + keyword.length)}</span>
      {text.slice(idx + keyword.length)}
    </>
  );
}
