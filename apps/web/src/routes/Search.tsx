import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Change } from '../components/Money';
import { formatNav } from '../lib/format';
import { HOT_KEYWORDS, MOCK_WATCHLIST } from '../lib/mock';
import { searchFunds, shortType, type SearchHit } from '../lib/api';

export function Search() {
  const [input, setInput] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => searchFunds(debounced),
    enabled: debounced.length > 0,
    staleTime: 60_000,
  });

  const isPinyin = /^[a-z]+$/i.test(debounced);

  return (
    <div className="flex min-h-dvh flex-col">
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
              <svg width="9" height="9" viewBox="0 0 24 24" stroke="#c3c7ce" strokeWidth="3" strokeLinecap="round">
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
                <ResultRow key={hit.code} hit={hit} keyword={debounced} last={i === data.length - 1} />
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

function EmptyState({ onPick }: { onPick: (kw: string) => void }) {
  return (
    <>
      <div className="mt-6 mb-1.5 px-0.5 text-[13px] font-semibold">我的自选</div>
      <div>
        {MOCK_WATCHLIST.map((f, i) => (
          <Link
            key={f.code}
            to={`/fund/${f.code}`}
            className={`flex items-center px-0.5 py-[13px] ${
              i < MOCK_WATCHLIST.length - 1 ? 'border-b border-line-soft' : ''
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{f.name}</div>
              <div className="mt-[3px] text-[11px] text-ink-dimmer">
                {f.code} · {f.type}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[15px] font-semibold">{formatNav(f.nav)}</div>
              <Change value={f.chgPct} className="mt-0.5 block text-xs" />
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-[26px] mb-3.5 px-0.5 text-[13px] font-semibold">热门基金</div>
      <div className="flex flex-wrap gap-2.5">
        {HOT_KEYWORDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onPick(k)}
            className="rounded-[20px] border border-line-soft bg-raised px-[15px] py-2 text-[13px] text-ink-body"
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
      <button
        type="button"
        className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] border border-accent/40 bg-accent/12 text-accent-soft"
        aria-label="加入自选"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}

/** 匹配片段高亮。拼音输入时上游按拼音命中，中文串里找不到，此时不高亮。 */
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
