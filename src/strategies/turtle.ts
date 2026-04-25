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

  for (const f of ctx.funds) {
    // Require at least $5 worth of USDC (5 * 1e6)
    const minUsdcIn = 5n * TEN_POW_USDC;
    if (f.usdcBalance < minUsdcIn) continue;

    if (f.lastTradeAt && now - f.lastTradeAt.getTime() < WEEK_MS) continue;

    // 10% of USDC allocation
    const amountIn = f.usdcBalance / 10n;
    if (amountIn < minUsdcIn) continue;

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
