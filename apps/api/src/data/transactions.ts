import type { Transaction } from '@lookthru/shared';

export interface DerivedPosition {
  fundCode: string;
  shares: number;
  costTotal: number;
  costPerShare: number;
}

export class TransactionDomainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransactionDomainError';
  }
}

export class TransactionNotFoundError extends Error {
  constructor(transactionId: string) {
    super(`流水不存在: ${transactionId}`);
    this.name = 'TransactionNotFoundError';
  }
}

export class TransactionConflictError extends Error {
  constructor() {
    super('持仓刚被另一笔请求修改，请刷新后重试');
    this.name = 'TransactionConflictError';
  }
}

export interface CreateTransactionInput {
  userId: string;
  fundCode: string;
  type: Transaction['type'];
  tradeDate: string;
  confirmDate: string | null;
  shares: number | null;
  amount: number | null;
  price: number | null;
  fee: number;
  status: Transaction['status'];
  note: string | null;
}

interface TransactionRow {
  id: string;
  user_id: string;
  fund_code: string;
  type: Transaction['type'];
  trade_date: string;
  confirm_date: string | null;
  shares: number | null;
  amount: number | null;
  price: number | null;
  fee: number;
  status: Transaction['status'];
  note: string | null;
}

interface MutablePosition {
  shares: number;
  costTotal: number;
}

const EPSILON = 1e-8;

function requiredPositive(value: number | null, field: string, transaction: Transaction): number {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    throw new TransactionDomainError(`流水 ${transaction.id} 的 ${field} 必须为正数`);
  }
  return value;
}

function requiredNonNegative(
  value: number | null,
  field: string,
  transaction: Transaction,
): number {
  if (value === null || !Number.isFinite(value) || value < 0) {
    throw new TransactionDomainError(`流水 ${transaction.id} 的 ${field} 必须为非负数`);
  }
  return value;
}

function applySell(position: MutablePosition, shares: number, transaction: Transaction): void {
  if (shares > position.shares + EPSILON) {
    throw new TransactionDomainError(
      `流水 ${transaction.id} 超卖：卖出 ${shares} 份，当前只有 ${position.shares} 份`,
    );
  }
  const currentAverage = position.shares > 0 ? position.costTotal / position.shares : 0;
  position.shares -= shares;
  position.costTotal -= currentAverage * shares;
  if (Math.abs(position.shares) <= EPSILON) {
    position.shares = 0;
    position.costTotal = 0;
  }
}

/**
 * 流水按调用方给定的稳定顺序依次应用；数据库读取固定按交易日、创建时间和 id 排序。
 * CONVERT 没有另造方向字段：amount 为空是转出（SELL），有 amount 是转入（BUY）。
 */
export function derivePositions(transactions: Transaction[]): DerivedPosition[] {
  const positions = new Map<string, MutablePosition>();
  for (const transaction of transactions) {
    if (transaction.status === 'PENDING') continue;
    const position = positions.get(transaction.fundCode) ?? { shares: 0, costTotal: 0 };

    switch (transaction.type) {
      case 'SNAPSHOT': {
        position.shares = requiredNonNegative(transaction.shares, 'shares', transaction);
        position.costTotal = requiredNonNegative(transaction.amount, 'amount', transaction);
        break;
      }
      case 'BUY': {
        const shares = requiredPositive(transaction.shares, 'shares', transaction);
        const amount = requiredNonNegative(transaction.amount, 'amount', transaction);
        position.shares += shares;
        position.costTotal += amount + transaction.fee;
        break;
      }
      case 'SELL': {
        applySell(position, requiredPositive(transaction.shares, 'shares', transaction), transaction);
        break;
      }
      case 'DIVIDEND': {
        if (transaction.shares !== null) {
          position.shares += requiredPositive(transaction.shares, 'shares', transaction);
        } else {
          position.costTotal -= requiredPositive(transaction.amount, 'amount', transaction);
        }
        break;
      }
      case 'CONVERT': {
        if (transaction.amount === null) {
          applySell(
            position,
            requiredPositive(transaction.shares, 'shares', transaction),
            transaction,
          );
        } else {
          const shares = requiredPositive(transaction.shares, 'shares', transaction);
          const amount = requiredNonNegative(transaction.amount, 'amount', transaction);
          position.shares += shares;
          position.costTotal += amount + transaction.fee;
        }
        break;
      }
    }
    if (!Number.isFinite(position.shares) || !Number.isFinite(position.costTotal)) {
      throw new TransactionDomainError(`流水 ${transaction.id} 产生非有限持仓数值`);
    }
    positions.set(transaction.fundCode, position);
  }

  return [...positions.entries()]
    .filter(([, position]) => position.shares > EPSILON)
    .map(([fundCode, position]) => ({
      fundCode,
      shares: position.shares,
      costTotal: position.costTotal,
      costPerShare: position.costTotal / position.shares,
    }))
    .sort((left, right) => left.fundCode.localeCompare(right.fundCode));
}

function rowToTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    userId: row.user_id,
    fundCode: row.fund_code,
    type: row.type,
    tradeDate: row.trade_date,
    confirmDate: row.confirm_date,
    shares: row.shares,
    amount: row.amount,
    price: row.price,
    fee: row.fee,
    status: row.status,
    note: row.note,
  };
}

export async function listTransactions(db: D1Database, userId: string): Promise<Transaction[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, fund_code, type, trade_date, confirm_date,
              shares, amount, price, fee, status, note
       FROM transactions
       WHERE user_id = ?
       ORDER BY trade_date, created_at, id`,
    )
    .bind(userId)
    .all<TransactionRow>();
  return results.map(rowToTransaction);
}

function cacheStatements(
  db: D1Database,
  userId: string,
  positions: DerivedPosition[],
  generation: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM positions_cache
         WHERE user_id = ?
           AND EXISTS (
             SELECT 1 FROM position_cache_generations
             WHERE user_id = ? AND current_generation = ?
           )`,
      )
      .bind(userId, userId, generation),
    ...positions.map((position) =>
      db
        .prepare(
          `INSERT INTO positions_cache (user_id, fund_code, shares, cost_total, updated_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM position_cache_generations
             WHERE user_id = ? AND current_generation = ?
           )`,
        )
        .bind(
          userId,
          position.fundCode,
          position.shares,
          position.costTotal,
          new Date().toISOString(),
          userId,
          generation,
        ),
    ),
    db
      .prepare(
        `UPDATE position_cache_generations
         SET cached_generation = ?
         WHERE user_id = ? AND current_generation = ?`,
      )
      .bind(generation, userId, generation),
  ];
}

async function currentGeneration(db: D1Database, userId: string): Promise<string> {
  const row = await db
    .prepare('SELECT current_generation FROM position_cache_generations WHERE user_id = ?')
    .bind(userId)
    .first<{ current_generation: string }>();
  if (!row) throw new Error(`用户缺少持仓世代号 user=${userId}`);
  return row.current_generation;
}

async function rebuildPositionCache(
  db: D1Database,
  userId: string,
  generation: string,
): Promise<void> {
  const positions = derivePositions(await listTransactions(db, userId));
  try {
    await db.batch(cacheStatements(db, userId, positions, generation));
  } catch (error) {
    // 流水已经提交，不能把真实成功伪装成 500 诱导用户重复录入；世代号会让读路径绕过旧缓存。
    console.error(`[positions-cache] 重建失败 user=${userId} generation=${generation}`, error);
  }
}

function generationStatement(
  db: D1Database,
  userId: string,
  expectedGeneration: string,
  nextGeneration: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE position_cache_generations
       SET current_generation = ?
       WHERE user_id = ? AND current_generation = ?`,
    )
    .bind(nextGeneration, userId, expectedGeneration);
}

function requireCommitted(results: D1Result[], mutationIndex: number, generationIndex: number): void {
  if (
    results[mutationIndex]?.meta.changes !== 1 ||
    results[generationIndex]?.meta.changes !== 1
  ) {
    throw new TransactionConflictError();
  }
}

export async function createTransaction(
  db: D1Database,
  input: CreateTransactionInput,
): Promise<Transaction> {
  const now = new Date().toISOString();
  const transaction: Transaction = { id: crypto.randomUUID(), ...input };
  const expectedGeneration = await currentGeneration(db, input.userId);
  const current = await listTransactions(db, input.userId);
  derivePositions(
    [...current, transaction].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate)),
  );
  const nextGeneration = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO transactions (
          id, user_id, fund_code, type, trade_date, confirm_date,
          shares, amount, price, fee, status, note, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM position_cache_generations
            WHERE user_id = ? AND current_generation = ?
          )`,
      )
      .bind(
        transaction.id,
        transaction.userId,
        transaction.fundCode,
        transaction.type,
        transaction.tradeDate,
        transaction.confirmDate,
        transaction.shares,
        transaction.amount,
        transaction.price,
        transaction.fee,
        transaction.status,
        transaction.note,
        now,
        now,
        input.userId,
        expectedGeneration,
      ),
    generationStatement(db, input.userId, expectedGeneration, nextGeneration),
  ]);
  requireCommitted(results, 0, 1);
  await rebuildPositionCache(db, input.userId, nextGeneration);
  return transaction;
}

export async function deleteTransaction(
  db: D1Database,
  userId: string,
  transactionId: string,
): Promise<void> {
  const expectedGeneration = await currentGeneration(db, userId);
  const current = await listTransactions(db, userId);
  if (!current.some((transaction) => transaction.id === transactionId)) {
    throw new TransactionNotFoundError(transactionId);
  }
  derivePositions(current.filter((transaction) => transaction.id !== transactionId));
  const nextGeneration = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM transactions
         WHERE id = ? AND user_id = ?
           AND EXISTS (
             SELECT 1 FROM position_cache_generations
             WHERE user_id = ? AND current_generation = ?
           )`,
      )
      .bind(transactionId, userId, userId, expectedGeneration),
    generationStatement(db, userId, expectedGeneration, nextGeneration),
  ]);
  requireCommitted(results, 0, 1);
  await rebuildPositionCache(db, userId, nextGeneration);
}

export async function confirmTransaction(
  db: D1Database,
  userId: string,
  transactionId: string,
  confirmDate: string,
): Promise<Transaction> {
  const expectedGeneration = await currentGeneration(db, userId);
  const current = await listTransactions(db, userId);
  const index = current.findIndex((transaction) => transaction.id === transactionId);
  if (index < 0) throw new TransactionNotFoundError(transactionId);
  const transaction = current[index]!;
  if (transaction.status !== 'PENDING') {
    throw new TransactionDomainError(`流水 ${transactionId} 已经确认，不能重复确认`);
  }
  if (confirmDate < transaction.tradeDate) {
    throw new TransactionDomainError('确认日期不能早于交易日期');
  }
  const confirmed = { ...transaction, status: 'CONFIRMED' as const, confirmDate };
  const next = [...current];
  next[index] = confirmed;
  derivePositions(next);
  const nextGeneration = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE transactions
         SET status = 'CONFIRMED', confirm_date = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'PENDING'
           AND EXISTS (
             SELECT 1 FROM position_cache_generations
             WHERE user_id = ? AND current_generation = ?
           )`,
      )
      .bind(confirmDate, now, transactionId, userId, userId, expectedGeneration),
    generationStatement(db, userId, expectedGeneration, nextGeneration),
  ]);
  requireCommitted(results, 0, 1);
  await rebuildPositionCache(db, userId, nextGeneration);
  return confirmed;
}

export async function listActiveFundCodes(db: D1Database): Promise<string[]> {
  const { results: cached } = await db
    .prepare(
      `SELECT DISTINCT p.fund_code
       FROM positions_cache p
       JOIN position_cache_generations g ON g.user_id = p.user_id
       WHERE p.shares > 0 AND g.cached_generation = g.current_generation`,
    )
    .all<{ fund_code: string }>();
  const { results: staleRows } = await db
    .prepare(
      `SELECT t.id, t.user_id, t.fund_code, t.type, t.trade_date, t.confirm_date,
              t.shares, t.amount, t.price, t.fee, t.status, t.note
       FROM transactions t
       JOIN position_cache_generations g ON g.user_id = t.user_id
       WHERE g.cached_generation IS NULL OR g.cached_generation <> g.current_generation
       ORDER BY t.user_id, t.trade_date, t.created_at, t.id`,
    )
    .all<TransactionRow>();
  const byUser = new Map<string, Transaction[]>();
  for (const row of staleRows) {
    const rows = byUser.get(row.user_id) ?? [];
    rows.push(rowToTransaction(row));
    byUser.set(row.user_id, rows);
  }
  const codes = new Set(cached.map((row) => row.fund_code));
  for (const transactions of byUser.values()) {
    for (const position of derivePositions(transactions)) codes.add(position.fundCode);
  }
  return [...codes].sort();
}
