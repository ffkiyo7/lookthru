/**
 * 东方财富 / 天天基金 数据源。
 *
 * 所有端点均为免费、无 token 的裸 HTTP —— 这正是本项目不需要 AKShare
 * 作为在线依赖、从而能跑在 Cloudflare Workers 上的前提（见 plan Context）。
 *
 * ⚠️ 已下线：fundgz.1234567.com.cn 官方盘中估值（实测全部 404），
 * FundMNFInfo 的 GSZ/GSZZL 字段恒为 null。估值一律自建，见 valuation/engine.ts。
 */

import type { FundBrief, NavPoint, Quote, TopHolding } from '@lookthru/shared';
import { extractJsVar, fetchJson, fetchJsonp, fetchText, UpstreamError } from './http';

const REFERER_FUND = 'https://fund.eastmoney.com/';
const REFERER_F10 = 'https://fundf10.eastmoney.com/';

// ─────────────────────────────────────────────────────────────
// 日期：东财时间戳是「北京时间当日零点」，必须按 UTC+8 转换，
// 否则会整体偏移一天。
// ─────────────────────────────────────────────────────────────

export function msToDate(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

/** stockCodes 形如 "6005191" = 6 位代码 + 东财市场位(1=沪 0=深)，末位即 secid 前缀 */
export function stockCodeToSecid(raw: string): string | null {
  if (raw.length < 7) return null;
  const code = raw.slice(0, 6);
  const market = raw.slice(6);
  if (market !== '0' && market !== '1') return null;
  return `${market}.${code}`;
}

// ─────────────────────────────────────────────────────────────
// 1. 全量基金列表（3.1MB）—— 由 GitHub Actions 每日跑，不在 Worker 在线路径
// ─────────────────────────────────────────────────────────────

export const FUND_LIST_URL = 'https://fund.eastmoney.com/js/fundcode_search.js';

export async function fetchFundList(): Promise<FundBrief[]> {
  const { text } = await fetchText(FUND_LIST_URL, {
    source: 'em:fundlist',
    referer: REFERER_FUND,
    timeoutMs: 30_000,
  });
  // 文件带 BOM
  const rows = extractJsVar(text.replace(/^\uFEFF/, ''), 'r');
  if (!Array.isArray(rows)) throw new UpstreamError('基金列表解析失败', null, 'em:fundlist');

  const out: FundBrief[] = [];
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [code, pinyinShort, name, type, pinyinFull] = row as string[];
    if (!code || !name) continue;
    out.push({
      code,
      name,
      type: type ?? '',
      pinyinShort: pinyinShort ?? '',
      pinyinFull: pinyinFull ?? '',
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 2. 单基金全量档案 pingzhongdata（~750KB，一次拿到几乎所有东西）
// ─────────────────────────────────────────────────────────────

export interface PingzhongData {
  code: string;
  name: string;
  /** 申购费率原价 % */
  sourceRate: number | null;
  /** 申购费率折后 % */
  currentRate: number | null;
  isMoneyFund: boolean;
  /** 前十大重仓股 secid（仅代码，权重需另取 fetchHoldings） */
  topStockSecids: string[];
  navHistory: NavPoint[];
  /** 累计净值 [date, accNav] */
  accNavHistory: [string, number][];
  /** 每日股票仓位估算 % —— 估值引擎的关键输入 */
  stockPositionHistory: [string, number][];
  latestStockPosition: number | null;
  assetAllocation: { reportDate: string; stock: number | null; bond: number | null; cash: number | null }[];
  managers: { id: string; name: string; workTime: string | null; fundSize: string | null }[];
  /** 规模变化（亿元） */
  scaleHistory: { date: string; scale: number }[];
}

export function pingzhongUrl(code: string): string {
  return `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
}

export async function fetchPingzhongData(code: string): Promise<PingzhongData> {
  const { text } = await fetchText(pingzhongUrl(code), {
    source: 'em:pingzhong',
    referer: REFERER_FUND,
    timeoutMs: 20_000,
  });
  return parsePingzhongData(text, code);
}

export function parsePingzhongData(src: string, fallbackCode: string): PingzhongData {
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? n : null;
  };

  const navRaw = extractJsVar(src, 'Data_netWorthTrend');
  const navHistory: NavPoint[] = Array.isArray(navRaw)
    ? (navRaw as { x: number; y: number; equityReturn: number }[])
        .filter((p) => p && typeof p.x === 'number' && typeof p.y === 'number')
        .map((p) => ({
          date: msToDate(p.x),
          unitNav: p.y,
          accNav: null,
          chgPct: Number.isFinite(p.equityReturn) ? p.equityReturn : null,
        }))
    : [];

  const accRaw = extractJsVar(src, 'Data_ACWorthTrend');
  const accNavHistory: [string, number][] = Array.isArray(accRaw)
    ? (accRaw as [number, number][])
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map((p) => [msToDate(p[0]), p[1]] as [string, number])
    : [];

  // 把累计净值回填进 navHistory
  const accMap = new Map(accNavHistory);
  for (const p of navHistory) p.accNav = accMap.get(p.date) ?? null;

  const posRaw = extractJsVar(src, 'Data_fundSharesPositions');
  const stockPositionHistory: [string, number][] = Array.isArray(posRaw)
    ? (posRaw as [number, number][])
        .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[1]))
        .map((p) => [msToDate(p[0]), p[1]] as [string, number])
    : [];

  const allocRaw = extractJsVar(src, 'Data_assetAllocation') as
    | { series?: { name: string; data: (number | null)[] }[]; categories?: string[] }
    | undefined;
  const assetAllocation: PingzhongData['assetAllocation'] = [];
  if (allocRaw?.categories && allocRaw.series) {
    const pick = (n: string) => allocRaw.series!.find((s) => s.name === n)?.data ?? [];
    const stock = pick('股票占净比');
    const bond = pick('债券占净比');
    const cash = pick('现金占净比');
    allocRaw.categories.forEach((date, i) => {
      assetAllocation.push({
        reportDate: date,
        stock: num(stock[i]),
        bond: num(bond[i]),
        cash: num(cash[i]),
      });
    });
  }

  // stockCodes 可能是数组，zqCodes 实测可能是裸字符串 —— 两种都要兜住
  const scRaw = extractJsVar(src, 'stockCodes');
  const stockCodesArr: string[] = Array.isArray(scRaw)
    ? (scRaw as unknown[]).filter((x): x is string => typeof x === 'string')
    : typeof scRaw === 'string'
      ? [scRaw]
      : [];
  const topStockSecids = stockCodesArr
    .map(stockCodeToSecid)
    .filter((s): s is string => s !== null);

  const mgrRaw = extractJsVar(src, 'Data_currentFundManager');
  const managers = Array.isArray(mgrRaw)
    ? (mgrRaw as Record<string, unknown>[]).map((m) => ({
        id: String(m.id ?? ''),
        name: String(m.name ?? ''),
        workTime: typeof m.workTime === 'string' ? m.workTime : null,
        fundSize: typeof m.fundSize === 'string' ? m.fundSize : null,
      }))
    : [];

  const scaleRaw = extractJsVar(src, 'Data_fluctuationScale') as
    | { categories?: string[]; series?: { y: number }[] }
    | undefined;
  const scaleHistory =
    scaleRaw?.categories && scaleRaw.series
      ? scaleRaw.categories.map((date, i) => ({
          date,
          scale: scaleRaw.series![i]?.y ?? 0,
        }))
      : [];

  const lastPos = stockPositionHistory.at(-1);

  return {
    code: (extractJsVar(src, 'fS_code') as string) ?? fallbackCode,
    name: (extractJsVar(src, 'fS_name') as string) ?? '',
    sourceRate: num(extractJsVar(src, 'fund_sourceRate')),
    currentRate: num(extractJsVar(src, 'fund_Rate')),
    isMoneyFund: extractJsVar(src, 'ishb') === true,
    topStockSecids,
    navHistory,
    accNavHistory,
    stockPositionHistory,
    latestStockPosition: lastPos ? lastPos[1] : (assetAllocation.at(-1)?.stock ?? null),
    assetAllocation,
    managers,
    scaleHistory,
  };
}

// ─────────────────────────────────────────────────────────────
// 3. 前十大重仓股 + 权重（估值引擎的 w_i）
//    移动端 JSON，比 F10 的 HTML 好解析得多，还白送行业分类
// ─────────────────────────────────────────────────────────────

export interface HoldingsResult {
  /** 报告期，如 2026-06-30。估值精度分级依赖它算陈旧天数 */
  reportDate: string | null;
  holdings: TopHolding[];
  /** 前十大占净值比合计 % —— 估值覆盖度 */
  coverageWeight: number;
  /** 行业分布，用于「行业重叠度」 */
  industries: { code: string; name: string; weight: number }[];
}

export function holdingsUrl(code: string): string {
  return (
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition` +
    `?FCODE=${code}&deviceid=lookthru&plat=Iphone&product=EFund&version=6.2.8`
  );
}

interface RawHoldingsResp {
  Datas?: { fundStocks?: RawStock[] | null } | null;
  Expansion?: string | null;
}
interface RawStock {
  GPDM: string;
  GPJC: string;
  JZBL: string;
  NEWTEXCH?: string;
  TEXCH?: string;
  INDEXCODE?: string;
  INDEXNAME?: string;
}

export async function fetchHoldings(code: string, signal?: AbortSignal): Promise<HoldingsResult> {
  const raw = await fetchJson<RawHoldingsResp>(holdingsUrl(code), {
    source: 'em:holdings',
    // 用户冷启动和 waitUntil 后台刷新共用；必须在 Worker 的后台存活窗口内有界完成。
    timeoutMs: 4_000,
    retries: 0,
    signal,
  });
  return parseHoldings(raw);
}

export function parseHoldings(raw: RawHoldingsResp): HoldingsResult {
  const stocks = raw.Datas?.fundStocks ?? [];
  const holdings: TopHolding[] = [];
  const industryMap = new Map<string, { code: string; name: string; weight: number }>();

  for (const s of stocks) {
    const weight = Number(s.JZBL);
    if (!s.GPDM || !Number.isFinite(weight)) continue;
    // NEWTEXCH 已经是东财 secid 前缀（1=沪 0=深）；TEXCH 是旧编码(2=深)，不要用
    const market = s.NEWTEXCH;
    holdings.push({
      stockCode: s.GPDM,
      stockName: s.GPJC ?? '',
      weight,
      secid: market === '0' || market === '1' ? `${market}.${s.GPDM}` : null,
    });
    if (s.INDEXCODE && s.INDEXNAME) {
      const prev = industryMap.get(s.INDEXCODE);
      industryMap.set(s.INDEXCODE, {
        code: s.INDEXCODE,
        name: s.INDEXNAME,
        weight: (prev?.weight ?? 0) + weight,
      });
    }
  }

  return {
    reportDate: raw.Expansion ?? null,
    holdings,
    coverageWeight: holdings.reduce((a, h) => a + h.weight, 0),
    industries: [...industryMap.values()].sort((a, b) => b.weight - a.weight),
  };
}

// ─────────────────────────────────────────────────────────────
// 4. 历史净值（分页，需 Referer）
// ─────────────────────────────────────────────────────────────

export function lsjzUrl(code: string, pageIndex = 1, pageSize = 20): string {
  return (
    `https://api.fund.eastmoney.com/f10/lsjz` +
    `?fundCode=${code}&pageIndex=${pageIndex}&pageSize=${pageSize}&_=${Date.now()}`
  );
}

interface RawLsjz {
  Data?: { LSJZList?: RawNavRow[] | null } | null;
  TotalCount?: number;
}
interface RawNavRow {
  FSRQ: string;
  DWJZ: string;
  LJJZ: string;
  JZZZL: string;
  FHFCZ?: string;
  SGZT?: string;
  SHZT?: string;
}

export async function fetchNavHistory(
  code: string,
  pageIndex = 1,
  pageSize = 20,
): Promise<NavPoint[]> {
  const raw = await fetchJson<RawLsjz>(lsjzUrl(code, pageIndex, pageSize), {
    source: 'em:lsjz',
    referer: REFERER_F10,
    timeoutMs: 15_000,
  });
  const rows = raw.Data?.LSJZList ?? [];
  return rows
    .filter((r) => r.FSRQ && r.DWJZ)
    .map((r) => ({
      date: r.FSRQ,
      unitNav: Number(r.DWJZ),
      accNav: Number.isFinite(Number(r.LJJZ)) ? Number(r.LJJZ) : null,
      chgPct: Number.isFinite(Number(r.JZZZL)) ? Number(r.JZZZL) : null,
    }))
    .filter((p) => Number.isFinite(p.unitNav));
}

// ─────────────────────────────────────────────────────────────
// 5. 批量实时行情（股票 / ETF / 指数通用）—— 估值引擎的 r_i
// ─────────────────────────────────────────────────────────────

const QUOTE_FIELDS = 'f12,f13,f14,f2,f3,f18';
const QUOTE_CHUNK = 100;

/**
 * push2 的可用主机。实测（LAX 出口）：主域 502，编号分片健康度约一半，
 * push2delay 最稳但是**延时行情**，故排在最后。分片健康度会漂移，
 * 因此按序试而非写死一个。
 */
export const EM_QUOTE_HOSTS = [
  '3.push2.eastmoney.com',
  '19.push2.eastmoney.com',
  '33.push2.eastmoney.com',
  '50.push2.eastmoney.com',
  'push2.eastmoney.com',
] as const;

/** 延时行情主机：可用性最好，但数据滞后，只作最后兜底 */
export const EM_QUOTE_HOST_DELAYED = 'push2delay.eastmoney.com';

export function quotesUrl(secids: string[], host: string = EM_QUOTE_HOSTS[0]): string {
  return (
    `https://${host}/api/qt/ulist.np/get` +
    `?secids=${secids.join(',')}&fields=${QUOTE_FIELDS}&fltt=2&invt=2&_=${Date.now()}`
  );
}

interface RawQuoteResp {
  data?: { diff?: RawQuote[] | null } | null;
}
interface RawQuote {
  f2: number | string;
  f3: number | string;
  f12: string;
  f13: number;
  f14: string;
  f18?: number | string;
}

/** 分批请求，单批 100 只。上游停牌/无效标的会被直接省略，不会报错 */
export async function fetchQuotes(
  secids: string[],
  host: string = EM_QUOTE_HOSTS[0],
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const uniq = [...new Set(secids)];

  for (let i = 0; i < uniq.length; i += QUOTE_CHUNK) {
    const chunk = uniq.slice(i, i + QUOTE_CHUNK);
    const raw = await fetchJson<RawQuoteResp>(quotesUrl(chunk, host), {
      source: `em:quotes@${host}`,
      referer: REFERER_FUND,
      timeoutMs,
      // 主机不可用时不在这层重试，交给上层换主机 —— 重试同一台坏主机纯属浪费
      retries: 0,
      signal,
    });
    for (const q of raw.data?.diff ?? []) {
      const price = Number(q.f2);
      const chgPct = Number(q.f3);
      if (!q.f12 || !Number.isFinite(price)) continue;
      const secid = `${q.f13}.${q.f12}`;
      out.set(secid, {
        secid,
        code: q.f12,
        name: q.f14 ?? '',
        price,
        chgPct: Number.isFinite(chgPct) ? chgPct : 0,
        prevClose: Number.isFinite(Number(q.f18)) ? Number(q.f18) : null,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 6. 搜索建议（中文 / 拼音 / 代码模糊匹配）
// ─────────────────────────────────────────────────────────────

export function searchUrl(keyword: string): string {
  return (
    `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx` +
    `?callback=cb&m=1&key=${encodeURIComponent(keyword)}&_=${Date.now()}`
  );
}

interface RawSearchResp {
  Datas?:
    | {
        CODE: string;
        NAME: string;
        JP?: string;
        CATEGORYDESC?: string;
        FundBaseInfo?: {
          /** 细分类型，如「货币型-普通货币」「混合型-偏股」 */
          FTYPE?: string;
          /** 单位净值。⚠️ 货币基金这里是「万份收益」，不是净值 */
          DWJZ?: number;
          FSRQ?: string;
          JJGS?: string;
          JJJL?: string;
        } | null;
      }[]
    | null;
}

export interface FundSearchHit {
  code: string;
  name: string;
  /** 拼音缩写，前端可用于高亮拼音匹配 */
  pinyin: string;
  /** 细分类型（货币型/混合型/指数型…）。CATEGORYDESC 只有粗分类「基金」，不要用 */
  type: string;
  nav: number | null;
  navDate: string | null;
  company: string | null;
  isMoneyFund: boolean;
}

export async function searchFunds(keyword: string, signal?: AbortSignal): Promise<FundSearchHit[]> {
  const raw = await fetchJsonp<RawSearchResp>(searchUrl(keyword), {
    source: 'em:search',
    referer: REFERER_FUND,
    // 搜索只有一个候选源；失败应尽快显式返回，不能让过期输入在后台重试到 20–30 秒。
    timeoutMs: 4_000,
    retries: 0,
    signal,
  });
  return parseSearchResponse(raw);
}

export function parseSearchResponse(raw: RawSearchResp): FundSearchHit[] {
  return (raw.Datas ?? [])
    // 股票也是 6 位代码，但 FundBaseInfo 为 null。只按代码过滤会把 600519
    // 当基金返回，随后详情请求才失败，属于延迟暴露的静默脏数据。
    .filter((d) => /^\d{6}$/.test(d.CODE) && d.FundBaseInfo !== null && d.FundBaseInfo !== undefined)
    .map((d) => {
      const info = d.FundBaseInfo ?? {};
      const type = info.FTYPE ?? d.CATEGORYDESC ?? '';
      return {
        code: d.CODE,
        name: d.NAME,
        pinyin: d.JP ?? '',
        type,
        nav: typeof info.DWJZ === 'number' && Number.isFinite(info.DWJZ) ? info.DWJZ : null,
        navDate: info.FSRQ ?? null,
        company: info.JJGS ?? null,
        isMoneyFund: /货币/.test(type),
      };
    });
}
