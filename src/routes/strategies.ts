import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '../lib/db.js';

export async function registerStrategyRoutes(app: FastifyInstance) {
  app.get('/strategies', async () => {
    const db = getDb();
    const rows = await db.select().from(schema.strategies);
    // Weekly rank placeholder: stable ordering by slug until live P&L is wired.
    const ranked = rows.map((r, i) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      chains: r.chains,
      status: r.status,
      weeklyRank: i + 1, // TODO: compute from league_snapshots once live
    }));
    return { strategies: ranked };
  });
}
