import type { Transaction } from '@lookthru/shared';

export interface SnapshotInput {
  userId: string;
  fundCode: string;
  tradeDate: string;
  shares: number;
  costTotal: number;
  note?: string | null;
}

/**
 * v1 的编辑持仓仍写流水。以后开放 BUY/SELL 时，历史真相源不需要迁移；
 * 缓存与流水同批提交，避免只成功一半后向用户展示幽灵持仓。
 */
export async function recordSnapshot(db: D1Database, input: SnapshotInput): Promise<Transaction> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const transaction: Transaction = {
    id,
    userId: input.userId,
    fundCode: input.fundCode,
    type: 'SNAPSHOT',
    tradeDate: input.tradeDate,
    confirmDate: input.tradeDate,
    shares: input.shares,
    amount: input.costTotal,
    price: input.shares > 0 ? input.costTotal / input.shares : null,
    fee: 0,
    status: 'CONFIRMED',
    note: input.note ?? null,
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO transactions (
          id, user_id, fund_code, type, trade_date, confirm_date,
          shares, amount, price, fee, status, note, created_at, updated_at
        ) VALUES (?, ?, ?, 'SNAPSHOT', ?, ?, ?, ?, ?, 0, 'CONFIRMED', ?, ?, ?)`,
      )
      .bind(
        id,
        input.userId,
        input.fundCode,
        input.tradeDate,
        input.tradeDate,
        input.shares,
        input.costTotal,
        transaction.price,
        transaction.note,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO positions_cache (user_id, fund_code, shares, cost_total, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, fund_code) DO UPDATE SET
           shares = excluded.shares,
           cost_total = excluded.cost_total,
           updated_at = excluded.updated_at`,
      )
      .bind(input.userId, input.fundCode, input.shares, input.costTotal, now),
  ]);

  return transaction;
}

export async function createUser(db: D1Database, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)')
    .bind(id, now, now)
    .run();
}

export async function listActiveFundCodes(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT fund_code
       FROM positions_cache
       WHERE shares > 0
       ORDER BY fund_code`,
    )
    .all<{ fund_code: string }>();
  return results.map((row) => row.fund_code);
}
