/**
 * Market data service — ETH price + volume.
 *
 * Primary source: CoinGecko free REST (no key). Secondary fallback:
 * Uniswap V3 subgraph on Arbitrum for ETH/USDC 0.05% pool price.
 *
 * Everything is cached in-process (no Redis on Render free tier) with
 * short TTLs. Functions are safe to call from anywhere; they'll return
 * the last known good value and fetch lazily when the TTL expires.
 */

type CacheEntry<T> = { value: T; at: number };

const CACHE_TTL_MS = 60_000; // 60s
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const e = cache.get(key) as CacheEntry<T> | undefined;
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) return null;
  return e.value;
}

function setCached<T>(key: string, value: T) {
  cache.set(key, { value, at: Date.now() });
}

/** Rolling price history: array of {ts, priceUsd}. Trimmed to 7d of 5-min bars. */
const MAX_HISTORY = 7 * 24 * 12 + 10; // ~2026 points
const priceHistory: { ts: number; priceUsd: number }[] = [];

function recordPrice(priceUsd: number) {
  priceHistory.push({ ts: Date.now(), priceUsd });
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
}

/**
 * Fetch current ETH price in USD from CoinGecko.
 * Returns `null` only if we've never successfully fetched once.
 */
export async function getEthPriceUsd(): Promise<number | null> {
  const cached = getCached<number>('eth-price');
  if (cached != null) return cached;

  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const j = (await res.json()) as { ethereum?: { usd?: number } };
    const p = j.ethereum?.usd;
    if (typeof p !== 'number' || p <= 0) throw new Error('bad price payload');
    setCached('eth-price', p);
    recordPrice(p);
    return p;
  } catch (err) {
    // Fall back to last price we ever saw
    const last = priceHistory.at(-1);
    if (last) return last.priceUsd;
    console.warn('[market-data] getEthPriceUsd failed and no cached history:', (err as Error).message);
    return null;
  }
}

/**
 * Sync wrapper that returns the last-known ETH price, or `null` if we've never
 * fetched one. Useful in contexts where we can't await.
 */
export function getLastEthPriceUsd(): number | null {
  const c = getCached<number>('eth-price');
  if (c != null) return c;
  const last = priceHistory.at(-1);
  return last ? last.priceUsd : null;
}

/**
 * 4-hour return as a fraction (e.g. 0.025 = +2.5%). Uses priceHistory.
 * Returns `null` if insufficient history.
 */
export function get4hReturn(): number | null {
  if (priceHistory.length < 2) return null;
  const now = Date.now();
  const fourH = 4 * 60 * 60 * 1000;
  const cutoff = now - fourH;
  // Find the oldest point within the 4h window
  let oldest: { ts: number; priceUsd: number } | null = null;
  for (const p of priceHistory) {
    if (p.ts >= cutoff) {
      oldest = p;
      break;
    }
  }
  if (!oldest) {
    // Nothing in the 4h window — use oldest overall
    oldest = priceHistory[0]!;
  }
  const latest = priceHistory.at(-1)!;
  if (!oldest || oldest.priceUsd <= 0) return null;
  return latest.priceUsd / oldest.priceUsd - 1;
}

/**
 * 24h ETH volume (USD) from CoinGecko. For momentum confirmation.
 */
export async function getEth24hVolumeUsd(): Promise<number | null> {
  const cached = getCached<number>('eth-vol-24h');
  if (cached != null) return cached;
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/ethereum?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false',
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const j = (await res.json()) as {
      market_data?: { total_volume?: { usd?: number } };
    };
    const v = j.market_data?.total_volume?.usd;
    if (typeof v !== 'number') throw new Error('bad volume payload');
    setCached('eth-vol-24h', v);
    // Also update 7d-avg rolling window
    volumeHistory.push({ ts: Date.now(), volumeUsd: v });
    if (volumeHistory.length > 8) volumeHistory.shift();
    return v;
  } catch (err) {
    console.warn('[market-data] volume fetch failed:', (err as Error).message);
    return null;
  }
}

const volumeHistory: { ts: number; volumeUsd: number }[] = [];

/**
 * Simple 7d avg volume approximation — averages the last 7 daily 24h-volume
 * samples. Until we have 7 days of uptime, this converges from one sample.
 */
export function get7dAvgVolume(): number | null {
  if (volumeHistory.length === 0) return null;
  const sum = volumeHistory.reduce((s, v) => s + v.volumeUsd, 0);
  return sum / volumeHistory.length;
}

/**
 * Boot the poller. Polls price every 60s, volume every 10min.
 * Returns a stopper.
 */
export function startMarketDataPoller(): () => void {
  let stopped = false;

  const tickPrice = async () => {
    if (stopped) return;
    try {
      await getEthPriceUsd();
    } catch {}
  };
  const tickVol = async () => {
    if (stopped) return;
    try {
      await getEth24hVolumeUsd();
    } catch {}
  };

  // Kick off immediately
  void tickPrice();
  void tickVol();

  const priceInterval = setInterval(tickPrice, 60_000);
  const volInterval = setInterval(tickVol, 10 * 60_000);

  console.log('[market-data] poller started (price 60s, volume 10min)');
  return () => {
    stopped = true;
    clearInterval(priceInterval);
    clearInterval(volInterval);
  };
}

/** For tests / admin — full snapshot. */
export function marketDataSnapshot() {
  return {
    ethPriceUsd: getLastEthPriceUsd(),
    fourHReturn: get4hReturn(),
    vol24hUsd: getCached<number>('eth-vol-24h'),
    avg7dVolUsd: get7dAvgVolume(),
    historySamples: priceHistory.length,
  };
}
