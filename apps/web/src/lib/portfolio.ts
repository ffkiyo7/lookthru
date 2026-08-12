import type { Position } from '@lookthru/shared';

export function positionPresentation(position: Position) {
  const valuation = position.valuation;
  const estimable =
    valuation !== null &&
    valuation.precision !== 'NONE' &&
    valuation.estNav !== null &&
    valuation.prevNav !== null;
  const marketValue = estimable ? position.shares * valuation.estNav! : position.marketValue;
  const dayReturn = estimable
    ? position.shares * (valuation.estNav! - valuation.prevNav!)
    : null;
  const holdingReturn = marketValue - position.costTotal;

  return {
    estimable,
    marketValue,
    dayReturn,
    holdingReturn,
    holdingReturnPct:
      position.costTotal > 0 ? (holdingReturn / position.costTotal) * 100 : 0,
  };
}

/** 汇总永远从持仓推导，不维护第二份总数。 */
export function summarizePositions(positions: Position[]) {
  const presented = positions.map(positionPresentation);
  const marketValue = presented.reduce((sum, position) => sum + position.marketValue, 0);
  const costTotal = positions.reduce((sum, position) => sum + position.costTotal, 0);
  const dayReturn = presented.reduce((sum, position) => sum + (position.dayReturn ?? 0), 0);
  const holdingReturn = marketValue - costTotal;
  const previousValue = marketValue - dayReturn;
  return {
    marketValue,
    dayReturn,
    dayReturnPct: previousValue > 0 ? (dayReturn / previousValue) * 100 : 0,
    holdingReturn,
    holdingReturnPct: costTotal > 0 ? (holdingReturn / costTotal) * 100 : 0,
    unestimatedCount: presented.filter((position) => !position.estimable).length,
  };
}
