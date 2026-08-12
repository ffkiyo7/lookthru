#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const varsPath = join(root, '.dev.vars');
const configPath = join(root, '.wrangler.generated.toml');
const wranglerPath = join(root, 'node_modules', '.bin', 'wrangler');

function die(message) {
  console.error(`✘ ${message}`);
  process.exit(1);
}

function readVars(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) die('.dev.vars 含无效行');
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1);
        }
        return [key, value];
      }),
  );
}

function validateWebhook(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    die(`${name} 不是合法 URL`);
  }
  if (
    url.protocol !== 'https:' ||
    !['discord.com', 'discordapp.com'].includes(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)
  ) {
    die(`${name} 不是官方 Discord webhook URL`);
  }
}

function rawWebhook(value) {
  const markdown = /^\[[^\]]*\]\((https:\/\/[^)]+)\)$/.exec(value);
  return markdown?.[1] ?? value;
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function encrypt(key, webhookUrl, userId, kind) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const aad = new TextEncoder().encode(`lookthru:webhook:v1:${userId}:${kind}:DISCORD`);
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    cryptoKey,
    new TextEncoder().encode(webhookUrl),
  );
  return { iv: base64Url(iv), ciphertext: base64Url(new Uint8Array(ciphertext)) };
}

const userIdIndex = process.argv.indexOf('--user-id');
const userId = userIdIndex >= 0 ? process.argv[userIdIndex + 1] : undefined;
if (!userId || !/^[A-Za-z0-9-]{8,128}$/.test(userId)) {
  die('用法：npm run notify:seed:local -- --user-id <本地用户 ID>');
}
if (!existsSync(varsPath)) die('缺少 .dev.vars');
if (!existsSync(configPath)) die('缺少 .wrangler.generated.toml；先运行 npm run cf:config');
if (!existsSync(wranglerPath)) die('缺少本地 wrangler；先运行 npm install');

const vars = readVars(varsPath);
const secret = vars.NOTIFY_KEY;
const dailyUrl = vars.DISCORD_WEBHOOK_DAILY ? rawWebhook(vars.DISCORD_WEBHOOK_DAILY) : undefined;
const alertUrl = vars.DISCORD_WEBHOOK_ALERT ? rawWebhook(vars.DISCORD_WEBHOOK_ALERT) : undefined;
if (!secret || !dailyUrl || !alertUrl) {
  die('.dev.vars 必须同时配置 NOTIFY_KEY、DISCORD_WEBHOOK_DAILY、DISCORD_WEBHOOK_ALERT');
}
let key;
try {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(secret)) throw new Error('invalid encoding');
  key = Buffer.from(secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
} catch {
  die('NOTIFY_KEY 不是合法 base64/base64url');
}
if (key.byteLength !== 32) die('NOTIFY_KEY 必须解码为 32 字节');
validateWebhook(dailyUrl, 'DISCORD_WEBHOOK_DAILY');
validateWebhook(alertUrl, 'DISCORD_WEBHOOK_ALERT');

const now = new Date().toISOString();
const rows = await Promise.all(
  [
    ['DAILY', dailyUrl],
    ['ALERT', alertUrl],
  ].map(async ([kind, url]) => ({
    id: randomUUID(),
    kind,
    ...(await encrypt(key, url, userId, kind)),
  })),
);
const sql = rows
  .map(
    (row) =>
      `INSERT INTO notify_bindings (` +
      `id,user_id,kind,provider,encryption_version,webhook_iv,webhook_ciphertext,created_at,updated_at` +
      `) VALUES (` +
      `'${row.id}','${userId}','${row.kind}','DISCORD',1,'${row.iv}','${row.ciphertext}','${now}','${now}'` +
      `) ON CONFLICT(user_id,kind) DO UPDATE SET ` +
      `provider=excluded.provider,encryption_version=excluded.encryption_version,` +
      `webhook_iv=excluded.webhook_iv,webhook_ciphertext=excluded.webhook_ciphertext,` +
      `updated_at=excluded.updated_at`,
  )
  .join(';');

const result = spawnSync(
  wranglerPath,
  ['d1', 'execute', 'lookthru', '--local', '-c', configPath, '--command', sql],
  {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, WRANGLER_LOG_PATH: '/tmp/lookthru-wrangler.log' },
  },
);
if (result.status !== 0) die('本地通知绑定写入失败');
console.log('✓ 已将 DAILY / ALERT 两个 webhook 加密写入本地 D1（未输出 URL）');
