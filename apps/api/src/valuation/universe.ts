import { listActiveFundCodes } from '../data/transactions';

/**
 * roadmap 的固定验收样本：2 只场内、3 只场外指数、5 只主动权益。
 * 它们与真实用户持仓共用同一批抓取，确保空仓期也能每天留下 14:55 对账数据。
 */
export const VALUATION_CALIBRATION_CODES = [
  '510300',
  '159919',
  '000961',
  '001051',
  '005918',
  '000001',
  '005827',
  '260108',
  '110022',
  '001938',
] as const;

export async function listValuationFundCodes(db: D1Database): Promise<string[]> {
  const active = await listActiveFundCodes(db);
  return [...new Set([...VALUATION_CALIBRATION_CODES, ...active])].sort();
}
