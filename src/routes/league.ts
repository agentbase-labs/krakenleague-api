/**
 * /league — mock leaderboard until strategies go live.
 *
 * TODO(live-trading): replace with query against `league_snapshots` keyed by
 * the current UTC Monday.
 */
import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '../lib/db.js';

function startOfWeekUTC(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setUTCDate(x.getUTCDate() + diff);
  return x;
}

function pseudoRandom(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

export async function registerLeagueRoutes(app: FastifyInstance) {
  app.get('/league', async () => {
    const db = getDb();
    const strategies = await db.select().from(schema.strategies);
    const weekStart = startOfWeekUTC(new Date()).toISOString();
    const rows = strategies
      .map((s, i) => ({
        rank: i + 1,
        strategyId: s.id,
        strategy: s.name,
        slug: s.slug,
        chains: s.chains,
        status: s.status,
        // All zeros — strategies are paper and haven't produced real P&L yet.
        // Keep a tiny deterministic jitter so the UI shows varied bars.
        return7d: pseudoRandom(s.slug + 'r7') * 0.0001,
        returnAll: pseudoRandom(s.slug + 'ra') * 0.0001,
        tvlUsd: 0,
        sharpe: 0,
        maxDrawdown: 0,
        tradeCount: 0,
      }))
      .sort((a, b) => a.rank - b.rank);
    return {
      weekStart,
      rows,
      note: 'Live trading not enabled yet — all 6 strategies are in paper mode.',
    };
  });
}
