/**
 * 搜索页类型筛选。chip 文案给 UI，value 进 /api/funds/search?type=。
 * 匹配规则见 fundMatchesTypeFilter：代码/拼音命中不受类型筛选影响。
 *
 * 这个文件不能 import zod：搜索页只需要 chip 常量和类型，走 barrel 会把整份
 * schema 打进 gzip。
 */
export const FUND_TYPE_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'stock', label: '股票' },
  { value: 'hybrid', label: '混合' },
  { value: 'bond', label: '债券' },
  { value: 'index', label: '指数' },
  { value: 'money', label: '货币' },
  { value: 'qdii', label: 'QDII' },
] as const;
export type FundTypeFilter = (typeof FUND_TYPE_FILTERS)[number]['value'];

export function isFundTypeFilter(value: string): value is FundTypeFilter {
  return FUND_TYPE_FILTERS.some((item) => item.value === value);
}

/** 缺省或空字符串视为「全部」；无法识别的值返回 null，让接口 400 而不是静默当成全部。 */
export function parseFundTypeFilter(value: string | undefined | null): FundTypeFilter | null {
  if (value == null || value === '') return 'all';
  return isFundTypeFilter(value) ? value : null;
}

/**
 * 名称命中才走类型筛选。股票/指数拆开是因为全量列表里大量「股票指数」，
 * 若用「含股票」会把指数基金吞进股票档，筛选就失去意义。
 */
export function fundMatchesTypeFilter(type: string, filter: FundTypeFilter): boolean {
  if (filter === 'all') return true;
  switch (filter) {
    case 'stock':
      return /股票/.test(type) && !/指数|ETF/i.test(type);
    case 'hybrid':
      return /混合/.test(type);
    case 'bond':
      return /债券/.test(type) && !/指数/.test(type);
    case 'index':
      return /指数|ETF/i.test(type);
    case 'money':
      return /货币|理财/.test(type);
    case 'qdii':
      return /QDII/i.test(type);
  }
}
