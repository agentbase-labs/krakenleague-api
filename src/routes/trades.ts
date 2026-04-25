/**
 * /trades/recent — real trades from the trades table.
 */
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';

export async function registerTradeRoutes(app: FastifyInstance) {
  app.get('/trades/recent', async (req) => {
    const db = getDb();
    const q = (req.query ?? {}) as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const rows = await db
      .select({
        id: schema.trades.id,
        userId: schema.trades.userId,
        strategyId: schema.trades.strategyId,
        strategy: schema.strategies.name,
        slug: schema.strategies.slug,
        chain: schema.trades.chain,
        side: schema.trades.side,
        tokenIn: schema.trades.tokenIn,
        tokenOut: schema.trades.tokenOut,
        amountIn: schema.trades.amountIn,
        amountOut: schema.trades.amountOut,
        notionalUsd: schema.trades.notionalUsd,
        gasUsd: schema.trades.gasUsd,
        slippage: schema.trades.slippage,
        txHash: schema.trades.txHash,
        status: schema.trades.status,
        realizedPnlUsd: schema.trades.realizedPnlUsd,
        createdAt: schema.trades.createdAt,
      })
      .from(schema.trades)
      .leftJoin(schema.strategies, eq(schema.trades.strategyId, schema.strategies.id))
      .orderBy(desc(schema.trades.createdAt))
      .limit(limit);
    return {
      trades: rows.map((r) => ({
        id: r.id,
        strategyId: r.strategyId,
        strategy: r.strategy ?? '',
        strategySlug: r.slug ?? '',
        chain: r.chain,
        side: r.side,
        tokenIn: r.tokenIn,
        tokenOut: r.tokenOut,
        amountIn: r.amountIn,
        amountOut: r.amountOut,
        notionalUsd: Number(r.notionalUsd),
        gasUsd: Number(r.gasUsd),
        slippage: Number(r.slippage),
        txHash: r.txHash,
        status: r.status,
        realizedPnlUsd: Number(r.realizedPnlUsd),
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}
