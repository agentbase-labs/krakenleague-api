/**
 * /league — real leaderboard aggregates.
 *   - TVL = sum(usdc+eth*price+realized) across all users' strategy_funds
 *   - 7d return = equity_snapshots: latest vs oldest in 7d window
 *   - Trade count last 7d
 *   - Sharpe + max DD computed from snapshots (simple daily approx)
 *
 * Zeroes are returned for strategies with no data yet (UI-safe).
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { getLastEthPriceUsd } from '../services/market-data.js';

function startOfWeekUTC(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setUTCDate(x.getUTCDate() + diff);
  return x;
}

export async function registerLeagueRoutes(app: FastifyInstance) {
  app.get('/league', async () => {
    const db = getDb();
    const strategies = await db.select().from(schema.strategies);
    const weekStart = startOfWeekUTC(new Date()).toISOString();
    const ethPriceUsd = getLastEthPriceUsd() ?? 0;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows = await Promise.all(
      strategies.map(async (s) => {
        // TVL
        const fundRows = await db
          .select()
          .from(schema.strategyFunds)
          .where(eq(schema.strategyFunds.strategyId, s.id));
        let tvlUsd = 0;
        for (const f of fundRows) {
          tvlUsd +=
            Number(f.usdcBalance) / 1e6 +
            (Number(f.ethBalance) / 1e18) * ethPriceUsd +
            Number(f.realizedPnlUsd);
        }

        // Trade count last 7d
        const tc = await db
          .select({ c: sql<number>`count(*)::int` })
          .from(schema.trades)
          .where(
            and(eq(schema.trades.strategyId, s.id), gte(schema.trades.createdAt, sevenDaysAgo)),
          );
        const tradeCount = tc[0]?.c ?? 0;

        // Equity snapshots in last 7d → return + Sharpe + maxDD
        const snaps = await db
          .select({
            equity: schema.equitySnapshots.equityUsd,
            createdAt: schema.equitySnapshots.createdAt,
          })
          .from(schema.equitySnapshots)
          .where(
            and(
              eq(schema.equitySnapshots.strategyId, s.id),
              gte(schema.equitySnapshots.createdAt, sevenDaysAgo),
            ),
          )
          .orderBy(schema.equitySnapshots.createdAt);

        let return7d = 0;
        let sharpe = 0;
        let maxDrawdown = 0;
        if (snaps.length >= 2) {
          // Aggregate per-strategy (sum across users) by timestamp bucket (day)
          const byDay = new Map<string, number>();
          for (const sn of snaps) {
            const key = sn.createdAt.toISOString().slice(0, 10);
            byDay.set(key, (byDay.get(key) ?? 0) + Number(sn.equity));
          }
          const series = Array.from(byDay.values());
          if (series.length >= 2) {
            const first = series[0]!;
            const last = series.at(-1)!;
            if (first > 0) return7d = last / first - 1;

            // Sharpe (daily-returns-based, un-annualised for simplicity)
            const rets: number[] = [];
            for (let i = 1; i < series.length; i++) {
              const prev = series[i - 1]!;
              if (prev > 0) rets.push(series[i]! / prev - 1);
            }
            if (rets.length > 1) {
              const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
              const variance =
                rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / rets.length;
              const sd = Math.sqrt(variance);
              sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
            }

            // Max drawdown
            let peak = series[0]!;
            for (const v of series) {
              if (v > peak) peak = v;
              const dd = peak > 0 ? (v - peak) / peak : 0;
              if (dd < maxDrawdown) maxDrawdown = dd;
            }
          }
        }

        return {
          strategyId: s.id,
          strategy: s.name,
          slug: s.slug,
          chains: s.chains,
          status: s.status,
          return7d,
          returnAll: return7d, // same for now
          tvlUsd,
          sharpe,
          maxDrawdown,
          tradeCount,
        };
      }),
    );

    // Rank: only active/live strategies ranked by return7d desc; others trail
    const tradable = rows.filter((r) => r.status === 'active' || r.status === 'live');
    const rest = rows.filter((r) => r.status !== 'active' && r.status !== 'live');
    tradable.sort((a, b) => b.return7d - a.return7d);
    const ranked = [...tradable, ...rest].map((r, i) => ({ ...r, rank: i + 1 }));

    return { weekStart, rows: ranked };
  });
}
