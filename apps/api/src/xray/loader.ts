import type { Transaction } from '@lookthru/shared';
import { listTransactions } from '../data/transactions';
import type { Defer, Env } from '../env';
import { getHoldingsForRequest } from '../fund-holdings';
import { loadPositionSnapshot } from '../positions';
import { getCachedQuotes } from '../quote-cache';
import { beijingDate } from '../trading-calendar';
import { aggregateXRay, type XRayResult } from './service';

function isConfirmedInflow(transaction: Transaction): boolean {
  if (transaction.status !== 'CONFIRMED' || transaction.shares === null || transaction.shares <= 0) {
    return false;
  }
  return (
    transaction.type === 'SNAPSHOT' ||
    transaction.type === 'BUY' ||
    (transaction.type === 'DIVIDEND' && transaction.amount === null) ||
    (transaction.type === 'CONVERT' && transaction.amount !== null)
  );
}

export function heldDaysByFund(
  transactions: Transaction[],
  asOfMs: number,
): Map<string, number> {
  const latest = new Map<string, string>();
  for (const transaction of transactions) {
    if (!isConfirmedInflow(transaction)) continue;
    const date = transaction.confirmDate ?? transaction.tradeDate;
    const current = latest.get(transaction.fundCode);
    if (current === undefined || date > current) latest.set(transaction.fundCode, date);
  }
  const today = Date.parse(`${beijingDate(asOfMs)}T00:00:00Z`);
  return new Map(
    [...latest].map(([code, date]) => [
      code,
      Math.max(0, Math.floor((today - Date.parse(`${date}T00:00:00Z`)) / 86_400_000)),
    ]),
  );
}

export interface XRaySnapshot extends XRayResult {
  updatedAt: string | null;
  unavailableValueFundCount: number;
  holdingsStaleFundCount: number;
  quoteProvider: string | null;
  quoteDelayed: boolean;
  quoteStaleSecids: string[];
  quoteUnavailableSecids: string[];
}

export async function loadXRaySnapshot(
  env: Env,
  userId: string,
  defer: Defer,
  asOfMs = Date.now(),
): Promise<XRaySnapshot> {
  const [positionSnapshot, transactions] = await Promise.all([
    loadPositionSnapshot(env, userId),
    listTransactions(env.DB, userId),
  ]);
  const availablePositions = positionSnapshot.positions.filter((position) => {
    const valuation = position.valuation;
    return (
      position.marketValue !== null ||
      (valuation !== null && valuation.precision !== 'NONE' && valuation.estNav !== null)
    );
  });
  const holdingsSnapshots = await Promise.all(
    availablePositions.map((position) => getHoldingsForRequest(env, position.fundCode, defer)),
  );
  const secids = holdingsSnapshots.flatMap((snapshot) =>
    snapshot.data.holdings
      .map((holding) => holding.secid)
      .filter((secid): secid is string => secid !== null),
  );
  const quotes = await getCachedQuotes(env, secids, defer);
  const heldDays = heldDaysByFund(transactions, asOfMs);
  const funds = availablePositions.map((position, index) => {
    const valuation = position.valuation;
    const estimatedMarketValue =
      valuation !== null && valuation.precision !== 'NONE' && valuation.estNav !== null
        ? position.shares * valuation.estNav
        : null;
    return {
      fundCode: position.fundCode,
      fundName: position.fundName,
      officialMarketValue: position.marketValue,
      estimatedMarketValue,
      heldDays: heldDays.get(position.fundCode) ?? null,
      holdings: holdingsSnapshots[index]!.data,
    };
  });
  const result = aggregateXRay(
    funds,
    new Map([...quotes.quotes].map(([secid, quote]) => [secid, quote.chgPct])),
    new Date(asOfMs).toISOString(),
  );
  return {
    ...result,
    updatedAt: positionSnapshot.updatedAt,
    unavailableValueFundCount: positionSnapshot.positions.length - availablePositions.length,
    holdingsStaleFundCount: holdingsSnapshots.filter((snapshot) => snapshot.stale).length,
    quoteProvider: quotes.provider,
    quoteDelayed: quotes.delayed,
    quoteStaleSecids: quotes.staleSecids,
    quoteUnavailableSecids: quotes.unavailableSecids,
  };
}
