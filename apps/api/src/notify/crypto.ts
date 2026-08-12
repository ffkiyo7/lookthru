import type { NotifyKind } from './types';

export interface EncryptedWebhook {
  version: 1;
  iv: string;
  ciphertext: string;
}

export interface WebhookContext {
  userId: string;
  kind: NotifyKind;
  provider: 'DISCORD';
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    throw new Error('NOTIFY_KEY 不是合法 base64/base64url');
  }
  const unpadded = value.replace(/=+$/, '');
  const padded = unpadded
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch (error) {
    throw new Error('NOTIFY_KEY 不是合法 base64/base64url', { cause: error });
  }
}

function additionalData(context: WebhookContext): Uint8Array {
  return new TextEncoder().encode(
    `lookthru:webhook:v1:${context.userId}:${context.kind}:${context.provider}`,
  );
}

async function importNotifyKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) {
    throw new Error('NOTIFY_KEY 未配置；拒绝以明文保存或读取 webhook');
  }
  const bytes = base64UrlDecode(secret);
  if (bytes.byteLength !== 32) {
    throw new Error('NOTIFY_KEY 必须是 32 字节随机值的 base64url 编码');
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function generateNotifyKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function encryptWebhookUrl(
  secret: string | undefined,
  webhookUrl: string,
  context: WebhookContext,
): Promise<EncryptedWebhook> {
  const key = await importNotifyKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(context) },
    key,
    new TextEncoder().encode(webhookUrl),
  );
  return {
    version: 1,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  };
}

export async function decryptWebhookUrl(
  secret: string | undefined,
  encrypted: EncryptedWebhook,
  context: WebhookContext,
): Promise<string> {
  if (encrypted.version !== 1) throw new Error(`不支持的 webhook 密文版本: ${encrypted.version}`);
  const key = await importNotifyKey(secret);
  const iv = base64UrlDecode(encrypted.iv);
  if (iv.byteLength !== 12) throw new Error('webhook 密文 IV 长度非法');
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(context) },
      key,
      base64UrlDecode(encrypted.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    throw new Error('webhook 密文解密失败；密钥、用户或用途不匹配', { cause: error });
  }
}
