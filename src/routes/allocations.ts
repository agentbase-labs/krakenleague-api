/**
 * Allocations — two concepts:
 *
 * 1. `allocations` (percent-based, aspirational target mix). Legacy endpoint.
 * 2. `strategy_funds` (actual USDC/ETH balance per strategy). Funds a strategy
 *    by moving USDC from the user's on-chain wallet into a virtual bucket.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sum, sql } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { requireAuth } from '../lib/auth-hook.js';
import { readBalances } from '../lib/wallet.js';

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

const FundInput = z.object({
  strategyId: z.string().uuid(),
  /** USDC amount in human units (e.g. "25.00"). */
  usdcAmount: z.string().regex(/^\d+(\.\d+)?$/),
});

const USDC_DECIMALS = 6n;
const USDC_MULT = 10n ** USDC_DECIMALS;

function parseUsdcBaseUnits(s: string): bigint {
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '000000').slice(0, 6);
  return BigInt(whole!) * USDC_MULT + BigInt(padded || '0');
}

export async function registerAllocationRoutes(app: FastifyInstance) {
  app.post('/allocations', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = AllocationInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const db = getDb();
    const userId = req.user.sub;
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

    // Also return actual strategy_funds so the UI can show real balances
    const funds = await db
      .select({
        strategyId: schema.strategyFunds.strategyId,
        slug: schema.strategies.slug,
        name: schema.strategies.name,
        usdcBalance: schema.strategyFunds.usdcBalance,
        ethBalance: schema.strategyFunds.ethBalance,
        realizedPnlUsd: schema.strategyFunds.realizedPnlUsd,
      })
      .from(schema.strategyFunds)
      .leftJoin(schema.strategies, eq(schema.strategyFunds.strategyId, schema.strategies.id))
      .where(eq(schema.strategyFunds.userId, req.user.sub));

    return {
      allocations: rows.map((r) => ({
        strategyId: r.strategyId,
        percent: Number(r.percent),
      })),
      funds: funds.map((f) => ({
        strategyId: f.strategyId,
        strategySlug: f.slug ?? '',
        strategyName: f.name ?? '',
        usdcBalance: f.usdcBalance,
        ethBalance: f.ethBalance,
        realizedPnlUsd: Number(f.realizedPnlUsd),
      })),
    };
  });

  /**
   * POST /allocations/fund — move USDC from unallocated pool into a strategy
   * bucket. Off-chain accounting; we verify the user has at least that much
   * unallocated USDC available (deposited minus already-allocated).
   */
  app.post('/allocations/fund', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = FundInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const db = getDb();
    const userId = req.user.sub;
    const amountBase = parseUsdcBaseUnits(parsed.data.usdcAmount);
    if (amountBase <= 0n) return reply.code(400).send({ error: 'amount_must_be_positive' });

    // Check strategy is tradable
    const [strategy] = await db
      .select()
      .from(schema.strategies)
      .where(eq(schema.strategies.id, parsed.data.strategyId))
      .limit(1);
    if (!strategy) return reply.code(404).send({ error: 'strategy_not_found' });
    if (strategy.status !== 'active' && strategy.status !== 'live') {
      return reply.code(400).send({ error: 'strategy_not_tradable', status: strategy.status });
    }

    // Compute unallocated USDC. Source of truth for deposits is the live
    // wallet USDC balance on Arbitrum (we custody it). Allocated amount is the
    // sum of usdcBalance across all the user's strategy_funds rows.
    const [wallet] = await db
      .select()
      .from(schema.agentWallets)
      .where(
        and(
          eq(schema.agentWallets.userId, userId),
          eq(schema.agentWallets.chain, 'arbitrum'),
        ),
      )
      .limit(1);
    if (!wallet) return reply.code(404).send({ error: 'wallet_not_found' });

    const bals = await readBalances('arbitrum', wallet.address as `0x${string}`);
    const onchainUsdc = BigInt(bals.usdc.raw);

    const totals = await db
      .select({ total: sql<string>`COALESCE(SUM(${schema.strategyFunds.usdcBalance}),'0')` })
      .from(schema.strategyFunds)
      .where(eq(schema.strategyFunds.userId, userId));
    const allocated = BigInt(totals[0]?.total ?? '0');
    const unallocated = onchainUsdc > allocated ? onchainUsdc - allocated : 0n;

    if (amountBase > unallocated) {
      return reply.code(400).send({
        error: 'insufficient_unallocated_usdc',
        available: unallocated.toString(),
        requested: amountBase.toString(),
      });
    }

    // Upsert strategy_funds
    const [existing] = await db
      .select()
      .from(schema.strategyFunds)
      .where(
        and(
          eq(schema.strategyFunds.userId, userId),
          eq(schema.strategyFunds.strategyId, parsed.data.strategyId),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(schema.strategyFunds)
        .set({
          usdcBalance: (BigInt(existing.usdcBalance) + amountBase).toString(),
          updatedAt: new Date(),
        })
        .where(eq(schema.strategyFunds.id, existing.id));
    } else {
      await db.insert(schema.strategyFunds).values({
        userId,
        strategyId: parsed.data.strategyId,
        usdcBalance: amountBase.toString(),
      });
    }

    return reply.send({ ok: true, allocatedUsdc: amountBase.toString() });
  });
}
