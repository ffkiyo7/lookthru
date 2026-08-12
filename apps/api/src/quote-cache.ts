import { Quote, type Quote as QuoteValue } from '@lookthru/shared';
import { z } from 'zod';
import type { Env } from './env';
import { fetchQuotesResilient } from './sources/quotes';

const HOT_TTL_SECONDS = 60;
const LAST_KNOWN_TTL_SECONDS = 7 * 24 * 60 * 60;

const QuoteEnvelope = z.object({
  quote: Quote,
  provider: z.string().min(1),
  delayed: z.boolean(),
  fetchedAt: z.string().datetime(),
});

type QuoteEnvelope = z.infer<typeof QuoteEnvelope>;

export interface CachedQuoteResult {
  provider: string | null;
  delayed: boolean;
  fetchedAt: string | null;
  quotes: Map<string, QuoteValue>;
  staleSecids: string[];
  unavailableSecids: string[];
}

async function readEnvelope(cache: KVNamespace, key: string): Promise<QuoteEnvelope | null> {
  const parsed = QuoteEnvelope.safeParse(await cache.get<unknown>(key, 'json'));
  if (parsed.success) return parsed.data;
  return null;
}

export async function getCachedQuotes(env: Env, requested: string[]): Promise<CachedQuoteResult> {
  const secids = [...new Set(requested)].sort();
  const envelopes = new Map<string, QuoteEnvelope>();
  const missing: string[] = [];
  await Promise.all(
    secids.map(async (secid) => {
      try {
        const envelope = await readEnvelope(env.CACHE, `quote:${secid}`);
        if (envelope) envelopes.set(secid, envelope);
        else missing.push(secid);
      } catch (error) {
        console.warn(`[quotes] 热缓存读取失败 secid=${secid}`, error);
        missing.push(secid);
      }
    }),
  );

  const staleSecids: string[] = [];
  const unavailableSecids: string[] = [];
  if (missing.length > 0) {
    const fresh = await fetchQuotesResilient(missing);
    const fetchedAt = new Date().toISOString();
    const writes: Promise<void>[] = [];
    for (const secid of missing) {
      const quote = fresh.quotes.get(secid);
      if (!quote || fresh.provider === null) continue;
      const envelope: QuoteEnvelope = {
        quote,
        provider: fresh.provider,
        delayed: fresh.delayed,
        fetchedAt,
      };
      envelopes.set(secid, envelope);
      const serialized = JSON.stringify(envelope);
      writes.push(
        env.CACHE.put(`quote:${secid}`, serialized, { expirationTtl: HOT_TTL_SECONDS }),
        env.CACHE.put(`quote-lkg:${secid}`, serialized, {
          expirationTtl: LAST_KNOWN_TTL_SECONDS,
        }),
      );
    }
    const writeResults = await Promise.allSettled(writes);
    if (writeResults.some((result) => result.status === 'rejected')) {
      console.warn('[quotes] 部分 KV 写入失败');
    }

    for (const secid of missing) {
      if (envelopes.has(secid)) continue;
      try {
        const lastKnown = await readEnvelope(env.CACHE, `quote-lkg:${secid}`);
        if (lastKnown) {
          envelopes.set(secid, lastKnown);
          staleSecids.push(secid);
        } else {
          unavailableSecids.push(secid);
        }
      } catch (error) {
        console.warn(`[quotes] last-known-good 读取失败 secid=${secid}`, error);
        unavailableSecids.push(secid);
      }
    }
  }

  const providers = [...new Set([...envelopes.values()].map((entry) => entry.provider))].sort();
  const fetchedAt = [...envelopes.values()]
    .map((entry) => entry.fetchedAt)
    .sort()
    .at(-1) ?? null;
  return {
    provider: providers.length === 0 ? null : providers.length === 1 ? providers[0]! : 'mixed',
    delayed: [...envelopes.values()].some((entry) => entry.delayed),
    fetchedAt,
    quotes: new Map([...envelopes].map(([secid, entry]) => [secid, entry.quote])),
    staleSecids: staleSecids.sort(),
    unavailableSecids: unavailableSecids.sort(),
  };
}
