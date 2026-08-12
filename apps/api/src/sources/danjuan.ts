import { fetchJson, UpstreamError } from './http';

const DANJUAN_FUND_URL = 'https://danjuanfunds.com/djapi/fund';

interface RawBenchmarkIndex {
  symbol?: unknown;
  symbol_name?: unknown;
}

interface RawFundResponse {
  result_code?: unknown;
  data?: {
    performance_bench_mark?: unknown;
    benchmark_index?: unknown;
  } | null;
}

export interface FundBenchmark {
  secid: string;
  name: string;
  /** 业绩基准中该指数的显式权重；ETF 联接基金不能使用仅含直接股票的 stockPosition。 */
  weight: number | null;
}

export function danjuanFundUrl(code: string): string {
  return `${DANJUAN_FUND_URL}/${code}`;
}

function symbolToSecid(symbol: string): string | null {
  const match = /^(SH|SZ)(\d{6})$/.exec(symbol.toUpperCase());
  if (!match) return null;
  return `${match[1] === 'SH' ? '1' : '0'}.${match[2]}`;
}

function normalizedIndexName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/指数收益率|全收益指数|指数|收益率/g, '')
    .replace(/[\s（）()·—_\-]/g, '')
    .toUpperCase();
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indexWeight(description: string, indexName: string): number | null {
  const baseName = indexName.replace(/指数$/, '');
  const match = new RegExp(
    `${escapedRegex(baseName)}(?:全收益)?(?:指数)?(?:收益率)?[×*Xx](\\d+(?:\\.\\d+)?)%`,
  ).exec(description.normalize('NFKC').replace(/\s/g, ''));
  if (!match) return null;
  const weight = Number(match[1]);
  return Number.isFinite(weight) && weight >= 0 && weight <= 100 ? weight : null;
}

/**
 * benchmark_index 是一份通用候选表，不是本基金的跟踪指数列表。
 * 只能选择在 performance_bench_mark 正文里唯一出现的境内指数；拿第一项会把
 * 大量基金静默错配为沪深 300，进而把错误估值标成 HIGH。
 */
export function parseFundBenchmark(raw: RawFundResponse): FundBenchmark | null {
  if (raw.result_code !== 0 || raw.data === null || typeof raw.data !== 'object') {
    throw new UpstreamError('蛋卷基金档案返回失败状态', null, 'danjuan:fund');
  }
  const description = raw.data.performance_bench_mark;
  const candidates = raw.data.benchmark_index;
  if (description === null) return null;
  if (typeof description !== 'string' || !Array.isArray(candidates)) {
    throw new UpstreamError('蛋卷基金档案缺少业绩基准字段', null, 'danjuan:fund');
  }

  const normalizedDescription = normalizedIndexName(description);
  const matches = new Map<string, FundBenchmark>();
  for (const candidate of candidates as RawBenchmarkIndex[]) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      typeof candidate.symbol !== 'string' ||
      typeof candidate.symbol_name !== 'string'
    ) {
      throw new UpstreamError('蛋卷业绩基准候选项格式变化', null, 'danjuan:fund');
    }
    const secid = symbolToSecid(candidate.symbol);
    const name = normalizedIndexName(candidate.symbol_name);
    if (secid && name.length >= 4 && normalizedDescription.includes(name)) {
      matches.set(secid, {
        secid,
        name: candidate.symbol_name,
        weight: indexWeight(description, candidate.symbol_name),
      });
    }
  }
  return matches.size === 1 ? [...matches.values()][0]! : null;
}

export async function fetchFundBenchmark(code: string): Promise<FundBenchmark | null> {
  const raw = await fetchJson<RawFundResponse>(danjuanFundUrl(code), {
    source: 'danjuan:fund',
    timeoutMs: 15_000,
  });
  return parseFundBenchmark(raw);
}
