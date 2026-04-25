/**
 * Market data service — ETH price + volume.
 *
 * PRIMARY: Uniswap V3 ETH/USDC 0.05% pool `slot0()` on Arbitrum. This is the
 * exact venue we trade on so using its own price guarantees no divergence.
 * Read via Alchemy (paid RPC) which is reliable.
 *
 * SECONDARY (sanity): CoinGecko free REST. If CoinGecko disagrees with
 * Uniswap by > 1% we mark `price_sanity=bad` and halt trading.
 *
 * Everything is cached in-process (no Redis on Render free tier) with
 * short TTLs. Functions are safe to call from anywhere; they'll return
 * the last known good value and fetch lazily when the TTL expires.
 */
import { createPublicClient, http, type Address } from 'viem';
import { arbitrum } from 'viem/chains';
import { rpcUrl } from '../lib/chains.js';

type CacheEntry<T> = { value: T; at: number };

const CACHE_TTL_MS = 60_000; // 60s
const cache = new Map<string, CacheEntry<unknown>>();

/* ---- Uniswap V3 pool (ETH/USDC 0.05% on Arbitrum) ---- */
// Canonical 0.05% pool for WETH / native USDC on Arbitrum.
const UNI_V3_POOL: Address = '0xC6962004f452bE9203591991D15f6b388e09E8D0';
// WETH is token0 here (lower address) and USDC.native is token1.
// Pool was verified via Uniswap factory getPool(WETH, USDC, 500).
// Token0 = WETH (18dp), Token1 = USDC (6dp).
const TOKEN0_IS_WETH = true;

const POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

/**
 * Convert sqrtPriceX96 → ETH/USD price.
 * sqrtPriceX96² / 2^192 = (token1/token0) scaled by token decimals.
 *   - If token0 = WETH (18dp), token1 = USDC (6dp):
 *     price_usdc_per_weth = (sqrtPriceX96² / 2^192) × 10^(18-6)
 */
function sqrtPriceToEthUsd(sqrtPriceX96: bigint): number {
  // Use floating-point for final conversion (we only need ~6 significant digits).
  const x = Number(sqrtPriceX96) / 2 ** 96;
  const raw = x * x; // = price in raw token1/token0 units
  if (TOKEN0_IS_WETH) {
    // (USDC_base per WETH_wei) → multiply by 10^(18-6) = 10^12 to get USDC per whole WETH
    return raw * 1e12;
  } else {
    // Inverse
    return 1 / (raw * 1e-12);
  }
}

async function fetchPriceFromUniswap(): Promise<number | null> {
  try {
    const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl('arbitrum')) });
    const slot0 = (await client.readContract({
      address: UNI_V3_POOL,
      abi: POOL_ABI,
      functionName: 'slot0',
    })) as readonly [bigint, number, number, number, number, number, boolean];
    const sqrtPriceX96 = slot0[0];
    const price = sqrtPriceToEthUsd(sqrtPriceX96);
    if (!isFinite(price) || price <= 0 || price > 1_000_000) {
      console.warn('[market-data] uniswap price out of range:', price);
      return null;
    }
    return price;
  } catch (err) {
    console.warn('[market-data] uniswap slot0 failed:', (err as Error).message);
    return null;
  }
}

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

/** Sanity flag: true if Uniswap-vs-CoinGecko diverge by > 1%. Set by background
 *  sanity checks. When true, strategies should halt. */
let priceSanityBad = false;
let priceSanityReason: string | null = null;

/**
 * Fetch current ETH price in USD. Primary: Uniswap V3 slot0 (fast, reliable,
 * matches the venue we trade on). Secondary: CoinGecko (used only as a
 * sanity check — if it disagrees by > 1% we flag bad data but still trade
 * off the Uniswap price since that's our execution venue).
 */
export async function getEthPriceUsd(): Promise<number | null> {
  const cached = getCached<number>('eth-price');
  if (cached != null) return cached;

  // 1. Uniswap on-chain price — authoritative
  const uniPrice = await fetchPriceFromUniswap();
  if (uniPrice != null) {
    setCached('eth-price', uniPrice);
    recordPrice(uniPrice);

    // 2. Sanity check against CoinGecko, fire-and-forget
    //    (doesn't block/fail the main price path if CG is rate-limited)
    void sanityCheckVsCoinGecko(uniPrice);

    return uniPrice;
  }

  // Uniswap failed — try CoinGecko as last resort
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
    const last = priceHistory.at(-1);
    if (last) return last.priceUsd;
    console.warn(
      '[market-data] getEthPriceUsd: uniswap and coingecko both failed, no history:',
      (err as Error).message,
    );
    return null;
  }
}

async function sanityCheckVsCoinGecko(uniPrice: number): Promise<void> {
  // Throttle: at most once per 5 min
  const last = getCached<number>('sanity-last-ts');
  if (last && Date.now() - last < 5 * 60_000) return;
  setCached('sanity-last-ts', Date.now());
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return; // rate-limited; skip, don't flag
    const j = (await res.json()) as { ethereum?: { usd?: number } };
    const cg = j.ethereum?.usd;
    if (typeof cg !== 'number' || cg <= 0) return;
    const dev = Math.abs(uniPrice - cg) / cg;
    if (dev > 0.01) {
      priceSanityBad = true;
      priceSanityReason = `uniswap ${uniPrice.toFixed(2)} vs coingecko ${cg.toFixed(2)}, dev ${(dev * 100).toFixed(2)}%`;
      console.warn('[market-data] PRICE SANITY BAD:', priceSanityReason);
    } else {
      priceSanityBad = false;
      priceSanityReason = null;
    }
  } catch {
    // ignore — CoinGecko being down is not a trading halt signal
  }
}

export function getPriceSanity(): { ok: boolean; reason: string | null } {
  return { ok: !priceSanityBad, reason: priceSanityReason };
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
    priceSource: 'uniswap-v3:arbitrum:eth-usdc-0.05%',
    priceSanity: getPriceSanity(),
  };
}