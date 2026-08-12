import type { Env } from '../env';
import { decryptWebhookUrl, encryptWebhookUrl } from '../notify/crypto';
import type { NotifyBinding, NotifyKind } from '../notify/types';

interface NotifyBindingRow {
  id: string;
  user_id: string;
  kind: NotifyKind;
  provider: 'DISCORD';
  encryption_version: 1;
  webhook_iv: string;
  webhook_ciphertext: string;
}

function context(row: Pick<NotifyBindingRow, 'user_id' | 'kind' | 'provider'>) {
  return { userId: row.user_id, kind: row.kind, provider: row.provider };
}

async function decryptRow(env: Env, row: NotifyBindingRow): Promise<NotifyBinding> {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    provider: row.provider,
    webhookUrl: await decryptWebhookUrl(
      env.NOTIFY_KEY,
      {
        version: row.encryption_version,
        iv: row.webhook_iv,
        ciphertext: row.webhook_ciphertext,
      },
      context(row),
    ),
  };
}

export async function upsertNotifyBinding(
  env: Env,
  userId: string,
  kind: NotifyKind,
  webhookUrl: string,
): Promise<void> {
  const provider = 'DISCORD' as const;
  const encrypted = await encryptWebhookUrl(env.NOTIFY_KEY, webhookUrl, {
    userId,
    kind,
    provider,
  });
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO notify_bindings (
       id, user_id, kind, provider, encryption_version,
       webhook_iv, webhook_ciphertext, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind) DO UPDATE SET
       provider = excluded.provider,
       encryption_version = excluded.encryption_version,
       webhook_iv = excluded.webhook_iv,
       webhook_ciphertext = excluded.webhook_ciphertext,
       updated_at = excluded.updated_at`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      kind,
      provider,
      encrypted.version,
      encrypted.iv,
      encrypted.ciphertext,
      now,
      now,
    )
    .run();
}

export async function listNotifyBindingKinds(
  db: D1Database,
  userId: string,
): Promise<NotifyKind[]> {
  const { results } = await db
    .prepare('SELECT kind FROM notify_bindings WHERE user_id = ? ORDER BY kind')
    .bind(userId)
    .all<{ kind: NotifyKind }>();
  return results.map((row) => row.kind);
}

export async function listNotifyBindings(
  env: Env,
  kind: NotifyKind,
): Promise<NotifyBinding[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, kind, provider, encryption_version, webhook_iv, webhook_ciphertext
     FROM notify_bindings
     WHERE kind = ?
     ORDER BY user_id`,
  )
    .bind(kind)
    .all<NotifyBindingRow>();
  return Promise.all(results.map((row) => decryptRow(env, row)));
}

export async function getNotifyBinding(
  env: Env,
  userId: string,
  kind: NotifyKind,
): Promise<NotifyBinding | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, kind, provider, encryption_version, webhook_iv, webhook_ciphertext
     FROM notify_bindings
     WHERE user_id = ? AND kind = ?`,
  )
    .bind(userId, kind)
    .first<NotifyBindingRow>();
  return row ? decryptRow(env, row) : null;
}

export async function deleteNotifyBinding(
  db: D1Database,
  userId: string,
  kind: NotifyKind,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM notify_bindings WHERE user_id = ? AND kind = ?')
    .bind(userId, kind)
    .run();
  return result.meta.changes === 1;
}
