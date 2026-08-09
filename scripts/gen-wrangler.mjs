#!/usr/bin/env node
/**
 * 从 wrangler.toml（占位符版本，入库）生成 .wrangler.generated.toml（真实 id，不入库）。
 *
 * 为什么要这一层：D1 database_id / KV namespace id 是账号资源标识。它们不是密钥
 * （没有 API token 拿着也用不了），但仓库是公开的，没必要把账号里有哪些资源摊开。
 * 代价是多一个生成步骤，换来 wrangler.toml 仍是唯一配置真相源 —— 不会出现
 * example 文件与实际配置各改各的漂移。
 *
 * 约定：wrangler.toml 里写 "PLACEHOLDER_<KEY>"，.wrangler-ids 里写 <KEY>=<值>。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(root, 'wrangler.toml');
const IDS = join(root, '.wrangler-ids');
const OUT = join(root, '.wrangler.generated.toml');

function die(msg) {
  console.error(`\n✘ ${msg}\n`);
  process.exit(1);
}

if (!existsSync(IDS)) {
  die(
    `缺少 ${IDS}\n\n` +
      `  cp .wrangler-ids.example .wrangler-ids\n\n` +
      `然后填入 \`wrangler d1 create\` / \`wrangler kv namespace create\` 输出的 id。`,
  );
}

const ids = Object.fromEntries(
  readFileSync(IDS, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      if (i === -1) die(`.wrangler-ids 第 "${l}" 行不是 KEY=VALUE 格式`);
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const out = readFileSync(SRC, 'utf8').replace(/PLACEHOLDER_([A-Z0-9_]+)/g, (_, key) => {
  const v = ids[key];
  if (!v) die(`.wrangler-ids 里缺少 ${key}（wrangler.toml 中的 PLACEHOLDER_${key} 无法替换）`);
  return v;
});

// 兜底：占位符换漏了就直接失败，绝不把 PLACEHOLDER_ 推上 Cloudflare
const leftover = out.match(/PLACEHOLDER_[A-Z0-9_]+/g);
if (leftover) die(`仍有未替换的占位符：${[...new Set(leftover)].join(', ')}`);

writeFileSync(
  OUT,
  `# 由 scripts/gen-wrangler.mjs 从 wrangler.toml 生成，请勿手改，改动会被覆盖。\n${out}`,
);
console.log(`✓ ${OUT}`);
