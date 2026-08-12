const SESSION_COOKIE = 'lookthru_session';
const SESSION_MAX_AGE_SECONDS = 7_776_000;

interface SessionRow {
  user_id: string;
}

interface InviteRow {
  code_hash: string;
  redeemed_user_id: string | null;
}

interface RecoveryRow {
  user_id: string;
}

export class InvalidCredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidCredentialError';
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function generateSecretToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function hashSecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE) {
      const token = part.slice(separator + 1).trim();
      return token || null;
    }
  }
  return null;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

async function insertSession(
  db: D1Database,
  userId: string,
  nowMs: number,
): Promise<{ token: string; statement: D1PreparedStatement }> {
  const token = generateSecretToken();
  const tokenHash = await hashSecret(token);
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + SESSION_MAX_AGE_SECONDS * 1_000).toISOString();
  return {
    token,
    statement: db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(tokenHash, userId, createdAt, expiresAt),
  };
}

export async function redeemInvite(
  db: D1Database,
  inviteCode: string,
  nowMs = Date.now(),
): Promise<{ userId: string; sessionToken: string; recoveryCode: string }> {
  const codeHash = await hashSecret(inviteCode);
  const invite = await db
    .prepare(
      `SELECT i.code_hash, r.user_id AS redeemed_user_id
       FROM invite_codes i
       LEFT JOIN invite_redemptions r ON r.code_hash = i.code_hash
       WHERE i.code_hash = ?`,
    )
    .bind(codeHash)
    .first<InviteRow>();
  if (!invite || invite.redeemed_user_id !== null) {
    throw new InvalidCredentialError('邀请码无效或已经使用');
  }

  const userId = crypto.randomUUID();
  const recoveryCode = generateSecretToken();
  const recoveryHash = await hashSecret(recoveryCode);
  const now = new Date(nowMs).toISOString();
  const session = await insertSession(db, userId, nowMs);
  const positionGeneration = crypto.randomUUID();

  try {
    await db.batch([
      db.prepare('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)').bind(
        userId,
        now,
        now,
      ),
      db
        .prepare(
          `INSERT INTO invite_redemptions (code_hash, user_id, redeemed_at)
           VALUES (?, ?, ?)`,
        )
        .bind(codeHash, userId, now),
      db
        .prepare(
          `INSERT INTO user_recovery_codes (user_id, recovery_hash, created_at)
           VALUES (?, ?, ?)`,
        )
        .bind(userId, recoveryHash, now),
      db
        .prepare(
          `INSERT INTO position_cache_generations (
             user_id, current_generation, cached_generation
           ) VALUES (?, ?, ?)`,
        )
        .bind(userId, positionGeneration, positionGeneration),
      session.statement,
    ]);
  } catch (error) {
    const available = await db
      .prepare(
        `SELECT i.code_hash, r.user_id AS redeemed_user_id
         FROM invite_codes i
         LEFT JOIN invite_redemptions r ON r.code_hash = i.code_hash
         WHERE i.code_hash = ?`,
      )
      .bind(codeHash)
      .first<InviteRow>();
    if (!available || available.redeemed_user_id !== null) {
      throw new InvalidCredentialError('邀请码无效或已经使用', { cause: error });
    }
    throw new Error('邀请码兑换写入失败', { cause: error });
  }

  return { userId, sessionToken: session.token, recoveryCode };
}

export async function recoverSession(
  db: D1Database,
  recoveryCode: string,
  nowMs = Date.now(),
): Promise<{ userId: string; sessionToken: string }> {
  const recoveryHash = await hashSecret(recoveryCode);
  const recovery = await db
    .prepare('SELECT user_id FROM user_recovery_codes WHERE recovery_hash = ?')
    .bind(recoveryHash)
    .first<RecoveryRow>();
  if (!recovery) throw new InvalidCredentialError('恢复码无效');

  const session = await insertSession(db, recovery.user_id, nowMs);
  await session.statement.run();
  return { userId: recovery.user_id, sessionToken: session.token };
}

export async function authenticateSession(
  db: D1Database,
  token: string | null,
  nowMs = Date.now(),
): Promise<string | null> {
  if (!token) return null;
  const tokenHash = await hashSecret(token);
  const session = await db
    .prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, new Date(nowMs).toISOString())
    .first<SessionRow>();
  return session?.user_id ?? null;
}

export async function revokeSession(db: D1Database, token: string | null): Promise<void> {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashSecret(token)).run();
}
