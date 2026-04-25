/**
 * Strategy types — decision objects returned by strategy evaluators.
 */

export type TradeIntent = {
  userId: string;
  strategyId: string;
  side: 'buy' | 'sell';
  tokenIn: 'USDC' | 'ETH';
  tokenOut: 'USDC' | 'ETH';
  /** Amount of tokenIn to spend, base units (USDC=6dp, ETH=18dp). */
  amountIn: bigint;
  reason: string;
};

export type StrategyContext = {
  strategyId: string;
  strategyCode: string;
  /** Fund rows for this strategy, one per user with > 0 USDC or ETH. */
  funds: Array<{
    userId: string;
    userIndex: number;
    usdcBalance: bigint;
    ethBalance: bigint;
    ethAvgEntryUsd: number;
    lastTradeAt: Date | null;
  }>;
  /** Market data snapshot — immutable for this tick. */
  market: {
    ethPriceUsd: number;
    fourHReturn: number | null;
    vol24hUsd: number | null;
    avg7dVolUsd: number | null;
  };
};
