/**
 * /trades/recent — empty until live trading.
 *
 * TODO(live-trading): query `trades` ORDER BY created_at DESC LIMIT n.
 */
import type { FastifyInstance } from 'fastify';

export async function registerTradeRoutes(app: FastifyInstance) {
  app.get('/trades/recent', async () => {
    return {
      trades: [],
      note: 'Live trading not enabled yet. This endpoint will fill as strategies flip to live.',
    };
  });
}
