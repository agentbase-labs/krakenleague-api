/**
 * /portfolio — returns P&L + positions + trades.
 *
 * TODO(live-trading): replace mock recentTrades + pnlSeries with real
 * `trades` + `pnl_snapshots` queries once strategies flip to live. The
 * allocation + equity math below already reads from the DB via `ledger`.
 */
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { requireAuth } from '../lib/auth-hook.js';

export async function registerPortfolioRoutes(app: FastifyInstance) {
  app.get('/portfolio', { preHandler: requireAuth }, async (req) => {
    const db = getDb();
    const userId = req.user.sub;

    // Real: last ledger row → current balance
    const [last] = await db
      .select({ balanceAfterUsd: schema.ledger.balanceAfterUsd })
      .from(schema.ledger)
      .where(eq(schema.ledger.userId, userId))
      .orderBy(desc(schema.ledger.createdAt))
      .limit(1);
    const equityUsd = last ? Number(last.balanceAfterUsd) : 0;

    // Real: user's allocations
    const allocRows = await db
      .select({
        strategyId: schema.allocations.strategyId,
        percent: schema.allocations.percent,
        strategySlug: schema.strategies.slug,
        strategyName: schema.strategies.name,
      })
      .from(schema.allocations)
      .leftJoin(schema.strategies, eq(schema.allocations.strategyId, schema.strategies.id))
      .where(eq(schema.allocations.userId, userId));

    const allocations = allocRows.map((a) => ({
      strategyId: a.strategyId,
      strategySlug: a.strategySlug ?? '',
      strategyName: a.strategyName ?? '',
      percent: Number(a.percent),
    }));

    // Mock (TODO: live trading) — recentTrades + pnlSeries
    const recentTrades: unknown[] = [];
    const pnlSeries: { t: string; equityUsd: number }[] = [];
    // Build a trivial flat series so the chart renders
    const now = Date.now();
    for (let i = 47; i >= 0; i--) {
      pnlSeries.push({
        t: new Date(now - i * 3_600_000).toISOString(),
        equityUsd,
      });
    }

    return {
      equityUsd,
      unrealizedPnlUsd: 0, // TODO when positions are live
      realizedPnlUsd: 0, // TODO when trades are live
      allocations,
      positions: [], // TODO when trades are live
      recentTrades,
      pnlSeries,
      note: 'Paper mode. Trading P&L is 0 because live trading is not enabled yet — only deposits/withdrawals affect equity.',
    };
  });
}
