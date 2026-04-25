/**
 * 🌊 Wave Rider — 4h momentum on ETH/USDC with trailing stop.
 *
 * Entry: 4h return > +2% AND 24h volume > 7d avg volume → buy ETH with
 *        20% of USDC allocation.
 * Exit:  current price < 97% of the max price since entry (3% trail), OR
 *        4h return < 0 → sell 100% of ETH holdings.
 *
 * Trailing-stop high-water marks are tracked per-user-strategy in memory.
 * They're rebuilt lazily on boot (conservative: starts at last known entry).
 */
import type { StrategyContext, TradeIntent } from './types.js';

const USDC_DECIMALS = 6n;
const TEN_POW_USDC = 10n ** USDC_DECIMALS;

/** Per-user trailing stop high-water marks, keyed by `userId:strategyId`. */
const highWaterMarks = new Map<string, number>();

function trailingKey(userId: string, strategyId: string): string {
  return `${userId}:${strategyId}`;
}

export function evaluateWaveRider(ctx: StrategyContext): TradeIntent[] {
  const intents: TradeIntent[] = [];
  const { fourHReturn, vol24hUsd, avg7dVolUsd, ethPriceUsd } = ctx.market;

  if (ethPriceUsd <= 0) return [];

  const haveMomentumData = typeof fourHReturn === 'number';
  const haveVolumeData = typeof vol24hUsd === 'number' && typeof avg7dVolUsd === 'number';

  for (const f of ctx.funds) {
    const key = trailingKey(f.userId, ctx.strategyId);
    const hasPosition = f.ethBalance > 0n;
    const hasUsdc = f.usdcBalance >= 5n * TEN_POW_USDC;

    // ------- EXIT logic (priority over entry) -------
    if (hasPosition) {
      const prevHigh = highWaterMarks.get(key) ?? ethPriceUsd;
      if (ethPriceUsd > prevHigh) highWaterMarks.set(key, ethPriceUsd);
      const mark = highWaterMarks.get(key)!;

      const trailHit = ethPriceUsd <= mark * 0.97;
      const momentumLost = haveMomentumData && fourHReturn! < 0;

      if (trailHit || momentumLost) {
        intents.push({
          userId: f.userId,
          strategyId: ctx.strategyId,
          side: 'sell',
          tokenIn: 'ETH',
          tokenOut: 'USDC',
          amountIn: f.ethBalance,
          reason: trailHit
            ? `Wave Rider trail stop: price ${ethPriceUsd.toFixed(2)} < 97% of high ${mark.toFixed(2)}`
            : `Wave Rider momentum flip: 4h return ${(fourHReturn! * 100).toFixed(2)}%`,
        });
        highWaterMarks.delete(key);
        continue;
      }
    }

    // ------- ENTRY logic -------
    if (!hasPosition && hasUsdc && haveMomentumData && haveVolumeData) {
      const momentumOk = fourHReturn! > 0.02;
      const volumeOk = vol24hUsd! > avg7dVolUsd!;
      if (momentumOk && volumeOk) {
        // 20% of USDC allocation
        const amountIn = (f.usdcBalance * 20n) / 100n;
        if (amountIn >= 5n * TEN_POW_USDC) {
          intents.push({
            userId: f.userId,
            strategyId: ctx.strategyId,
            side: 'buy',
            tokenIn: 'USDC',
            tokenOut: 'ETH',
            amountIn,
            reason: `Wave Rider entry: 4h +${(fourHReturn! * 100).toFixed(2)}% vol ${(vol24hUsd! / 1e9).toFixed(2)}B > avg ${(avg7dVolUsd! / 1e9).toFixed(2)}B`,
          });
          highWaterMarks.set(key, ethPriceUsd);
        }
      }
    }
  }
  return intents;
}

/** Exposed for admin / tests. */
export function waveRiderDebug() {
  return Object.fromEntries(highWaterMarks.entries());
}
