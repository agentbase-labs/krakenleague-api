/**
 * Strategy runner — every 5 minutes, loads active strategies + funded users,
 * evaluates the strategy, and inserts `trade_intents` rows.
 */
import { and, eq, gt } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import {
  getEthPriceUsd,
  get4hReturn,
  getEth24hVolumeUsd,
  get7dAvgVolume,
  getLastEthPriceUsd,
} from './market-data.js';
import { evaluateTurtle } from '../strategies/turtle.js';
import { evaluateWaveRider } from '../strategies/wave-rider.js';
import type { StrategyContext, TradeIntent } from '../strategies/types.js';

/** Maps strategy slug → evaluator. */
const EVALUATORS: Record<string, (ctx: StrategyContext) => TradeIntent[]> = {
  turtle: evaluateTurtle,
  'wave-rider': evaluateWaveRider,
};

export async function runStrategyTick(): Promise<{ intentsCreated: number }> {
  const db = getDb();

  // Circuit breaker → skip
  const [breaker] = await db
    .select()
    .from(schema.systemFlags)
    .where(eq(schema.systemFlags.key, 'circuit_breaker_enabled'))
    .limit(1);
  if (breaker?.boolValue) {
    console.warn('[strategy-runner] circuit_breaker_enabled=true; skipping');
    return { intentsCreated: 0 };
  }

  // Load active strategies
  const strategies = await db
    .select()
    .from(schema.strategies)
    .where(eq(schema.strategies.status, 'active'));
  if (strategies.length === 0) return { intentsCreated: 0 };

  // Fresh price + volume
  const ethPriceUsd = await getEthPriceUsd();
  if (!ethPriceUsd) {
    console.warn('[strategy-runner] no ETH price, skipping tick');
    return { intentsCreated: 0 };
  }
  await getEth24hVolumeUsd(); // warm the cache
  const market = {
    ethPriceUsd,
    fourHReturn: get4hReturn(),
    vol24hUsd: (await getEth24hVolumeUsd()) ?? null,
    avg7dVolUsd: get7dAvgVolume(),
  };

  let total = 0;

  for (const strat of strategies) {
    const evalFn = EVALUATORS[strat.slug];
    if (!evalFn) {
      console.warn(`[strategy-runner] no evaluator for slug=${strat.slug}`);
      continue;
    }

    // Load all strategy_funds rows with any balance, joined to users for userIndex
    const rows = await db
      .select({
        userId: schema.strategyFunds.userId,
        userIndex: schema.users.userIndex,
        usdcBalance: schema.strategyFunds.usdcBalance,
        ethBalance: schema.strategyFunds.ethBalance,
        ethAvgEntryUsd: schema.strategyFunds.ethAvgEntryUsd,
        lastTradeAt: schema.strategyFunds.lastTradeAt,
      })
      .from(schema.strategyFunds)
      .leftJoin(schema.users, eq(schema.strategyFunds.userId, schema.users.id))
      .where(eq(schema.strategyFunds.strategyId, strat.id));

    const funds = rows
      .filter((r) => r.userIndex != null)
      .map((r) => ({
        userId: r.userId,
        userIndex: r.userIndex!,
        usdcBalance: BigInt(r.usdcBalance),
        ethBalance: BigInt(r.ethBalance),
        ethAvgEntryUsd: Number(r.ethAvgEntryUsd),
        lastTradeAt: r.lastTradeAt,
      }))
      .filter((r) => r.usdcBalance > 0n || r.ethBalance > 0n);

    if (funds.length === 0) continue;

    const ctx: StrategyContext = {
      strategyId: strat.id,
      strategyCode: strat.slug,
      funds,
      market,
    };

    const intents = evalFn(ctx);

    // Dedupe: skip inserting if a pending intent already exists for (user,strategy)
    for (const intent of intents) {
      const [existing] = await db
        .select({ id: schema.tradeIntents.id })
        .from(schema.tradeIntents)
        .where(
          and(
            eq(schema.tradeIntents.userId, intent.userId),
            eq(schema.tradeIntents.strategyId, intent.strategyId),
            eq(schema.tradeIntents.status, 'pending'),
          ),
        )
        .limit(1);
      if (existing) continue;

      await db.insert(schema.tradeIntents).values({
        userId: intent.userId,
        strategyId: intent.strategyId,
        chain: 'arbitrum',
        side: intent.side,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: intent.amountIn.toString(),
        reason: intent.reason,
        status: 'pending',
      });
      total++;
    }
  }

  if (total > 0) console.log(`[strategy-runner] created ${total} intents`);
  return { intentsCreated: total };
}

/** Start every-5-minute scheduler. */
export function startStrategyRunner(): () => void {
  let stopped = false;
  let inflight = false;
  const tick = async () => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      await runStrategyTick();
    } catch (err) {
      console.error('[strategy-runner] crashed:', (err as Error).message);
    } finally {
      inflight = false;
    }
  };
  // Defer initial tick a bit so market-data has at least one sample
  setTimeout(() => void tick(), 15_000);
  const id = setInterval(tick, 5 * 60_000);
  console.log('[strategy-runner] started (5-minute ticks)');
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
