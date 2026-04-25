/**
 * /admin/* — requires JWT + users.is_admin=true.
 *   POST /admin/circuit-breaker { enabled: bool }
 *   GET  /admin/system-status — balances, open positions, recent trades, error rate
 *   POST /admin/strategy/:slug/status — flip strategy status
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { requireAuth } from '../lib/auth-hook.js';
import { marketDataSnapshot } from '../services/market-data.js';

async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  const db = getDb();
  const [u] = await db
    .select({ isAdmin: schema.users.isAdmin })
    .from(schema.users)
    .where(eq(schema.users.id, req.user.sub))
    .limit(1);
  if (!u?.isAdmin) {
    reply.code(403).send({ error: 'admin_required' });
  }
}

const CBInput = z.object({ enabled: z.boolean() });
const StrategyStatusInput = z.object({
  status: z.enum(['active', 'paper', 'paused', 'live', 'coming_soon', 'retired']),
});

export async function registerAdminRoutes(app: FastifyInstance) {
  app.post('/admin/circuit-breaker', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CBInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const db = getDb();
    await db
      .insert(schema.systemFlags)
      .values({ key: 'circuit_breaker_enabled', boolValue: parsed.data.enabled })
      .onConflictDoUpdate({
        target: schema.systemFlags.key,
        set: { boolValue: parsed.data.enabled, updatedAt: new Date() },
      });
    return { ok: true, circuit_breaker_enabled: parsed.data.enabled };
  });

  app.get('/admin/system-status', { preHandler: requireAdmin }, async () => {
    const db = getDb();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [flags, strategies, tradeCount, intentCount, fundTotals, recentTrades, errorCount] =
      await Promise.all([
        db.select().from(schema.systemFlags),
        db.select().from(schema.strategies),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(schema.trades)
          .where(gte(schema.trades.createdAt, dayAgo)),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(schema.tradeIntents)
          .where(gte(schema.tradeIntents.createdAt, dayAgo)),
        db
          .select({
            totalUsdc: sql<string>`COALESCE(SUM(${schema.strategyFunds.usdcBalance}),'0')`,
            totalEth: sql<string>`COALESCE(SUM(${schema.strategyFunds.ethBalance}),'0')`,
          })
          .from(schema.strategyFunds),
        db
          .select({
            id: schema.trades.id,
            side: schema.trades.side,
            tokenIn: schema.trades.tokenIn,
            tokenOut: schema.trades.tokenOut,
            notionalUsd: schema.trades.notionalUsd,
            txHash: schema.trades.txHash,
            status: schema.trades.status,
            error: schema.trades.errorMessage,
            createdAt: schema.trades.createdAt,
          })
          .from(schema.trades)
          .orderBy(desc(schema.trades.createdAt))
          .limit(10),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(schema.tradeIntents)
          .where(
            and(
              eq(schema.tradeIntents.status, 'failed'),
              gte(schema.tradeIntents.createdAt, dayAgo),
            ),
          ),
      ]);

    return {
      market: marketDataSnapshot(),
      flags: flags.map((f) => ({ key: f.key, bool: f.boolValue, string: f.stringValue })),
      strategies: strategies.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        status: s.status,
      })),
      counters: {
        trades24h: tradeCount[0]?.c ?? 0,
        intents24h: intentCount[0]?.c ?? 0,
        failedIntents24h: errorCount[0]?.c ?? 0,
        totalUsdcAcrossFunds: fundTotals[0]?.totalUsdc ?? '0',
        totalEthAcrossFunds: fundTotals[0]?.totalEth ?? '0',
      },
      recentTrades,
    };
  });

  app.post('/admin/strategy/:slug/status', { preHandler: requireAdmin }, async (req, reply) => {
    const params = req.params as { slug?: string };
    const parsed = StrategyStatusInput.safeParse(req.body);
    if (!parsed.success || !params.slug) {
      return reply.code(400).send({ error: 'invalid_input' });
    }
    const db = getDb();
    const [updated] = await db
      .update(schema.strategies)
      .set({ status: parsed.data.status })
      .where(eq(schema.strategies.slug, params.slug))
      .returning();
    if (!updated) return reply.code(404).send({ error: 'strategy_not_found' });
    return { ok: true, slug: updated.slug, status: updated.status };
  });

  // Manual trigger — useful for smoke tests
  app.post('/admin/run/strategy-tick', { preHandler: requireAdmin }, async () => {
    const { runStrategyTick } = await import('../services/strategy-runner.js');
    const r = await runStrategyTick();
    return { ok: true, ...r };
  });
  app.post('/admin/run/executor-tick', { preHandler: requireAdmin }, async () => {
    const { runExecutorTick } = await import('../services/executor.js');
    const r = await runExecutorTick();
    return { ok: true, ...r };
  });
  app.post('/admin/run/pnl-tick', { preHandler: requireAdmin }, async () => {
    const { snapshotEquityTick } = await import('../services/pnl-tracker.js');
    const r = await snapshotEquityTick();
    return { ok: true, ...r };
  });

  /**
   * Manual intent injection — bypasses strategy-runner, useful for smoke tests.
   * Body: { strategyId, side, tokenIn, tokenOut, amountIn (stringified base units), reason }
   */
  const ManualIntent = z.object({
    userId: z.string().uuid(),
    strategyId: z.string().uuid(),
    side: z.enum(['buy', 'sell']),
    tokenIn: z.enum(['USDC', 'ETH']),
    tokenOut: z.enum(['USDC', 'ETH']),
    amountIn: z.string().regex(/^\d+$/),
    reason: z.string().max(200).optional(),
  });
  app.post('/admin/intents', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ManualIntent.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const db = getDb();
    const [row] = await db
      .insert(schema.tradeIntents)
      .values({
        userId: parsed.data.userId,
        strategyId: parsed.data.strategyId,
        chain: 'arbitrum',
        side: parsed.data.side,
        tokenIn: parsed.data.tokenIn,
        tokenOut: parsed.data.tokenOut,
        amountIn: parsed.data.amountIn,
        reason: parsed.data.reason ?? 'manual admin intent',
        status: 'pending',
      })
      .returning();
    return { ok: true, intent: row };
  });

  /**
   * Flag a user as admin by email. Gated by X-Admin-Bootstrap-Token header
   * matching ADMIN_BOOTSTRAP_TOKEN env var. Use once for first admin.
   */
  app.post('/admin/bootstrap-admin', async (req, reply) => {
    const token = (req.headers['x-admin-bootstrap-token'] as string | undefined) ?? '';
    const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
    if (!expected || expected.length < 16) {
      return reply.code(503).send({ error: 'bootstrap_not_configured' });
    }
    if (token !== expected) return reply.code(403).send({ error: 'forbidden' });
    const body = (req.body ?? {}) as { email?: string };
    if (!body.email) return reply.code(400).send({ error: 'email_required' });
    const db = getDb();
    const [u] = await db
      .update(schema.users)
      .set({ isAdmin: true })
      .where(eq(schema.users.email, body.email.toLowerCase()))
      .returning();
    if (!u) return reply.code(404).send({ error: 'user_not_found' });
    return { ok: true, userId: u.id, email: u.email, isAdmin: u.isAdmin };
  });

  /**
   * Bootstrap-gated read of all users and their wallets. Used by ops to diagnose
   * deposit mismatches. Gated by X-Admin-Bootstrap-Token header.
   */
  app.get('/admin/debug/users-and-wallets', async (req, reply) => {
    const token = (req.headers['x-admin-bootstrap-token'] as string | undefined) ?? '';
    const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
    if (!expected || token !== expected) return reply.code(403).send({ error: 'forbidden' });
    const db = getDb();
    const users = await db.select().from(schema.users);
    const wallets = await db.select().from(schema.agentWallets);
    const deposits = await db.select().from(schema.deposits);
    return {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        userIndex: u.userIndex,
        verifiedEoa: u.verifiedEoa,
        overCapFlag: u.overCapFlag,
        isAdmin: u.isAdmin,
        createdAt: u.createdAt,
      })),
      wallets: wallets.map((w) => ({
        id: w.id,
        userId: w.userId,
        chain: w.chain,
        address: w.address,
        derivationPath: w.derivationPath,
        lastScannedBlock: w.lastScannedBlock,
        lastNativeBalance: w.lastNativeBalance,
      })),
      deposits: deposits.map((d) => ({
        id: d.id,
        userId: d.userId,
        chain: d.chain,
        token: d.token,
        amount: d.amount,
        amountUsd: d.amountUsd,
        txHash: d.txHash,
        status: d.status,
        createdAt: d.createdAt,
      })),
    };
  });

  /**
   * Force a rescan on arbitrum wallets. Optional body: { fromBlock: string }
   * If fromBlock is provided, reset lastScannedBlock to that value (minus 1 so
   * next poll starts from it). Also resets lastNativeBalance to 0 so that the
   * balance-diff detector recounts any existing balance as a new deposit
   * (idempotent via the synthetic tx hash).
   *
   * Gated by X-Admin-Bootstrap-Token header.
   */
  app.post('/admin/debug/rescan-arbitrum', async (req, reply) => {
    const token = (req.headers['x-admin-bootstrap-token'] as string | undefined) ?? '';
    const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
    if (!expected || token !== expected) return reply.code(403).send({ error: 'forbidden' });
    const body = (req.body ?? {}) as { fromBlock?: string; resetNativeBalance?: boolean };
    const db = getDb();
    const update: Record<string, string> = {};
    if (body.fromBlock) {
      const fb = BigInt(body.fromBlock);
      update.lastScannedBlock = (fb - 1n).toString();
    }
    if (body.resetNativeBalance) {
      update.lastNativeBalance = '0';
    }
    if (Object.keys(update).length === 0) {
      return reply.code(400).send({ error: 'nothing_to_update' });
    }
    const rows = await db
      .update(schema.agentWallets)
      .set(update)
      .where(eq(schema.agentWallets.chain, 'arbitrum'))
      .returning();
    return {
      ok: true,
      updated: rows.length,
      wallets: rows.map((w) => ({
        id: w.id,
        address: w.address,
        lastScannedBlock: w.lastScannedBlock,
        lastNativeBalance: w.lastNativeBalance,
      })),
    };
  });

  /**
   * Poll the deposit listener once right now (instead of waiting 30s).
   * Gated by X-Admin-Bootstrap-Token header.
   */
  app.post('/admin/debug/poll-now', async (req, reply) => {
    const token = (req.headers['x-admin-bootstrap-token'] as string | undefined) ?? '';
    const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
    if (!expected || token !== expected) return reply.code(403).send({ error: 'forbidden' });
    try {
      const mod = await import('../workers/deposit-listener.js');
      if (typeof (mod as { pollOnce?: () => Promise<void> }).pollOnce === 'function') {
        await (mod as { pollOnce: () => Promise<void> }).pollOnce();
        return { ok: true, triggered: 'pollOnce' };
      }
      return reply.code(500).send({ error: 'pollOnce_not_exported' });
    } catch (err) {
      return reply.code(500).send({ error: 'poll_failed', message: (err as Error).message });
    }
  });
}
