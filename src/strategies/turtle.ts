/**
 * 🐢 Turtle — weekly DCA into ETH.
 *
 * Rules:
 *   - If user has USDC allocated AND (lastTradeAt is null OR > 7d ago)
 *     → buy ETH with 10% of USDC allocation (min $5 notional).
 *   - Never sells. Accumulation only.
 */
import type { StrategyContext, TradeIntent } from './types.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const USDC_DECIMALS = 6n;
const TEN_POW_USDC = 10n ** USDC_DECIMALS;

export function evaluateTurtle(ctx: StrategyContext): TradeIntent[] {
  const intents: TradeIntent[] = [];
  const now = Date.now();

  // Per-trade minimum: $1 notional (so small test allocations can still tick).
  const MIN_TRADE_USDC_BASE = 1_000_000n; // $1 in 6dp

  for (const f of ctx.funds) {
    if (f.usdcBalance < MIN_TRADE_USDC_BASE) continue;
    if (f.lastTradeAt && now - f.lastTradeAt.getTime() < WEEK_MS) continue;

    // 10% of USDC allocation, or $1 minimum — whichever is greater — but
    // never more than the entire bucket.
    let amountIn = f.usdcBalance / 10n;
    if (amountIn < MIN_TRADE_USDC_BASE) amountIn = MIN_TRADE_USDC_BASE;
    if (amountIn > f.usdcBalance) amountIn = f.usdcBalance;

    intents.push({
      userId: f.userId,
      strategyId: ctx.strategyId,
      side: 'buy',
      tokenIn: 'USDC',
      tokenOut: 'ETH',
      amountIn,
      reason: `Turtle weekly DCA: 10% of $${(Number(f.usdcBalance) / 1e6).toFixed(2)} USDC`,
    });
  }

  return intents;
}
