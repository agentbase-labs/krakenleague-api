/**
 * /portfolio — real P&L + positions + trades from live data.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { requireAuth } from '../lib/auth-hook.js';
import { getLastEthPriceUsd } from '../services/market-data.js';

export async function registerPortfolioRoutes(app: FastifyInstance) {
  app.get('/portfolio', { preHandler: requireAuth }, async (req) => {
    const db = getDb();
    const userId = req.user.sub;
    const ethPriceUsd = getLastEthPriceUsd() ?? 0;

    // Ledger last row → base USD equity
    const [last] = await db
      .select({ balanceAfterUsd: schema.ledger.balanceAfterUsd })
      .from(schema.ledger)
      .where(eq(schema.ledger.userId, userId))
      .orderBy(desc(schema.ledger.createdAt))
      .limit(1);
    const ledgerBalanceUsd = last ? Number(last.balanceAfterUsd) : 0;

    // Allocations (percent targets)
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

    // Strategy funds → positions
    const fundRows = await db
      .select({
        strategyId: schema.strategyFunds.strategyId,
        slug: schema.strategies.slug,
        name: schema.strategies.name,
        usdcBalance: schema.strategyFunds.usdcBalance,
        ethBalance: schema.strategyFunds.ethBalance,
        avg: schema.strategyFunds.ethAvgEntryUsd,
        realized: schema.strategyFunds.realizedPnlUsd,
      })
      .from(schema.strategyFunds)
      .leftJoin(schema.strategies, eq(schema.strategyFunds.strategyId, schema.strategies.id))
      .where(eq(schema.strategyFunds.userId, userId));

    const positions = fundRows.map((f) => {
      const usdc = Number(f.usdcBalance) / 1e6;
      const eth = Number(f.ethBalance) / 1e18;
      const avg = Number(f.avg);
      const realized = Number(f.realized);
      const markValue = usdc + eth * ethPriceUsd + realized;
      const unrealized = eth > 0 && avg > 0 ? eth * (ethPriceUsd - avg) : 0;
      return {
        strategyId: f.strategyId,
        strategySlug: f.slug ?? '',
        strategyName: f.name ?? '',
        usdc,
        eth,
        ethAvgEntryUsd: avg,
        equityUsd: markValue,
        realizedPnlUsd: realized,
        unrealizedPnlUsd: unrealized,
      };
    });

    const unrealizedPnlUsd = positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
    const realizedPnlUsd = positions.reduce((s, p) => s + p.realizedPnlUsd, 0);
    const strategyEquity = positions.reduce((s, p) => s + p.equityUsd, 0);
    const equityUsd = Math.max(ledgerBalanceUsd, strategyEquity);

    // Recent trades (user's)
    const recentTrades = await db
      .select({
        id: schema.trades.id,
        strategyId: schema.trades.strategyId,
        side: schema.trades.side,
        tokenIn: schema.trades.tokenIn,
        tokenOut: schema.trades.tokenOut,
        amountIn: schema.trades.amountIn,
        amountOut: schema.trades.amountOut,
        notionalUsd: schema.trades.notionalUsd,
        gasUsd: schema.trades.gasUsd,
        txHash: schema.trades.txHash,
        status: schema.trades.status,
        realizedPnlUsd: schema.trades.realizedPnlUsd,
        createdAt: schema.trades.createdAt,
      })
      .from(schema.trades)
      .where(eq(schema.trades.userId, userId))
      .orderBy(desc(schema.trades.createdAt))
      .limit(20);

    // Equity series: last 48 points, one per hour, max taken from snapshots or
    // filled with current equity.
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const snaps = await db
      .select({
        equity: schema.equitySnapshots.equityUsd,
        createdAt: schema.equitySnapshots.createdAt,
      })
      .from(schema.equitySnapshots)
      .where(
        and(
          eq(schema.equitySnapshots.userId, userId),
          gte(schema.equitySnapshots.createdAt, since),
        ),
      )
      .orderBy(schema.equitySnapshots.createdAt);

    const pnlSeries: { t: string; equityUsd: number }[] = [];
    if (snaps.length > 0) {
      // Aggregate by hour
      const byHour = new Map<string, number>();
      for (const s of snaps) {
        const hour = new Date(s.createdAt);
        hour.setMinutes(0, 0, 0);
        const key = hour.toISOString();
        byHour.set(key, (byHour.get(key) ?? 0) + Number(s.equity));
      }
      for (const [t, eq] of Array.from(byHour.entries()).sort()) {
        pnlSeries.push({ t, equityUsd: eq });
      }
    } else {
      const now = Date.now();
      for (let i = 47; i >= 0; i--) {
        pnlSeries.push({
          t: new Date(now - i * 3_600_000).toISOString(),
          equityUsd,
        });
      }
    }

    return {
      equityUsd,
      unrealizedPnlUsd,
      realizedPnlUsd,
      allocations,
      positions,
      recentTrades: recentTrades.map((r) => ({
        ...r,
        notionalUsd: Number(r.notionalUsd),
        gasUsd: Number(r.gasUsd),
        realizedPnlUsd: Number(r.realizedPnlUsd),
        createdAt: r.createdAt.toISOString(),
      })),
      pnlSeries,
    };
  });
}
