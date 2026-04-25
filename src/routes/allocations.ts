import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { requireAuth } from '../lib/auth-hook.js';

const AllocationInput = z.object({
  allocations: z
    .array(
      z.object({
        strategyId: z.string().uuid(),
        percent: z.number().min(0).max(100),
      }),
    )
    .refine((arr) => arr.reduce((s, a) => s + a.percent, 0) <= 100 + 1e-6, {
      message: 'Total allocation must be ≤ 100%',
    }),
});

export async function registerAllocationRoutes(app: FastifyInstance) {
  app.post('/allocations', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = AllocationInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const db = getDb();
    const userId = req.user.sub;
    // Replace all allocations for this user
    await db.delete(schema.allocations).where(eq(schema.allocations.userId, userId));
    for (const a of parsed.data.allocations) {
      await db.insert(schema.allocations).values({
        userId,
        strategyId: a.strategyId,
        percent: a.percent.toFixed(2),
      });
    }
    return reply.send({ ok: true, updatedAt: new Date().toISOString() });
  });

  app.get('/allocations', { preHandler: requireAuth }, async (req) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.allocations)
      .where(eq(schema.allocations.userId, req.user.sub));
    return {
      allocations: rows.map((r) => ({
        strategyId: r.strategyId,
        percent: Number(r.percent),
      })),
    };
  });
}
