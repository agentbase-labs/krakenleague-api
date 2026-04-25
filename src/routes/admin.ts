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

/**
 * Gate for bootstrap/debug endpoints. Uses the same token mechanism as
 * the existing /admin/bootstrap-* routes. Returns true iff the header
 * matches the env var; writes the 403 reply on failure.
 */
function requireBootstrap(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = (req.headers['x-admin-bootstrap-token'] as string | undefined) ?? '';
  const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!expected || expected.length < 16) {
    reply.code(503).send({ error: 'bootstrap_not_configured' });
    return false;
  }
  if (token !== expected) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  return true;
}

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

  /**
   * Revalue an existing ETH deposit at the current live ETH/USD price.
   * Updates `deposits.amount_usd` and rewrites the associated `ledger` row so that
   * the running balance reflects the new USD value. Append-only invariants are
   * preserved (we update, not delete, only two rows tied to this depositId).
   *
   * Body: { depositId: uuid }
   * Gated by X-Admin-Bootstrap-Token header.
   */
  app.post('/admin/debug/revalue-eth-deposit', async (req, reply) => {
    const token = (req.headers['x-admin-bootstrap-token'] as string | undefined) ?? '';
    const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
    if (!expected || token !== expected) return reply.code(403).send({ error: 'forbidden' });
    const body = (req.body ?? {}) as { depositId?: string };
    if (!body.depositId) return reply.code(400).send({ error: 'depositId_required' });

    const db = getDb();
    const [dep] = await db
      .select()
      .from(schema.deposits)
      .where(eq(schema.deposits.id, body.depositId))
      .limit(1);
    if (!dep) return reply.code(404).send({ error: 'deposit_not_found' });
    if (dep.token !== 'ETH') {
      return reply.code(400).send({ error: 'not_an_eth_deposit', token: dep.token });
    }

    const { getEthPriceUsd } = await import('../services/market-data.js');
    const price = await getEthPriceUsd();
    if (!price || price <= 0) return reply.code(503).send({ error: 'price_unavailable' });

    // formatEther from viem
    const { formatEther } = await import('viem');
    const oldUsd = Number(dep.amountUsd ?? '0');
    const newUsd = Number(formatEther(BigInt(dep.amount))) * price;
    const delta = newUsd - oldUsd;

    // 1) Update the deposit row
    await db
      .update(schema.deposits)
      .set({ amountUsd: newUsd.toFixed(6) })
      .where(eq(schema.deposits.id, dep.id));

    // 2) Find the ledger row tied to this deposit (refId + refType='deposit')
    const [lrow] = await db
      .select()
      .from(schema.ledger)
      .where(and(eq(schema.ledger.refType, 'deposit'), eq(schema.ledger.refId, dep.id)))
      .limit(1);
    if (!lrow) return reply.code(404).send({ error: 'ledger_row_not_found_for_deposit' });

    // 3) Recompute balance_after_usd for this row and all subsequent ledger rows
    //    for this user. Append-only friendly: we keep rows, we just adjust the
    //    balance_after_usd column by `delta`.
    const oldBal = Number(lrow.balanceAfterUsd);
    const newBal = oldBal + delta;
    await db
      .update(schema.ledger)
      .set({
        amountUsd: newUsd.toFixed(6),
        balanceAfterUsd: newBal.toFixed(6),
        notes: `${lrow.notes ?? ''} | revalued @${price.toFixed(2)}/ETH`,
      })
      .where(eq(schema.ledger.id, lrow.id));

    // Bump any later ledger rows for the same user by the same delta.
    const later = await db
      .select()
      .from(schema.ledger)
      .where(and(eq(schema.ledger.userId, dep.userId), gte(schema.ledger.createdAt, lrow.createdAt)))
      .orderBy(schema.ledger.createdAt);
    // later includes lrow itself; skip it.
    for (const r of later) {
      if (r.id === lrow.id) continue;
      const bumped = (Number(r.balanceAfterUsd) + delta).toFixed(6);
      await db
        .update(schema.ledger)
        .set({ balanceAfterUsd: bumped })
        .where(eq(schema.ledger.id, r.id));
    }

    return {
      ok: true,
      depositId: dep.id,
      userId: dep.userId,
      amountWei: dep.amount,
      ethPriceUsd: price,
      oldAmountUsd: oldUsd,
      newAmountUsd: newUsd,
      delta,
      laterRowsBumped: Math.max(0, later.length - 1),
    };
  });

  /* ============================================================
   * Bootstrap-gated debug endpoints for the autonomous engine.
   * All gated by X-Admin-Bootstrap-Token header.
   * ============================================================ */

  /**
   * GET /admin/debug/status — comprehensive read-only snapshot of the trading
   * engine. Returns market data, flags, strategies, strategy_funds for every
   * user, pending+recent intents, recent trades. Safe to poll from ops.
   */
  app.get('/admin/debug/status', async (req, reply) => {
    if (!requireBootstrap(req, reply)) return;
    const db = getDb();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [flags, strategies, funds, pendingIntents, recentIntents, recentTrades] =
      await Promise.all([
        db.select().from(schema.systemFlags),
        db.select().from(schema.strategies),
        db
          .select({
            userId: schema.strategyFunds.userId,
            strategyId: schema.strategyFunds.strategyId,
            slug: schema.strategies.slug,
            usdcBalance: schema.strategyFunds.usdcBalance,
            ethBalance: schema.strategyFunds.ethBalance,
            ethAvgEntryUsd: schema.strategyFunds.ethAvgEntryUsd,
            realizedPnlUsd: schema.strategyFunds.realizedPnlUsd,
            lastTradeAt: schema.strategyFunds.lastTradeAt,
            updatedAt: schema.strategyFunds.updatedAt,
          })
          .from(schema.strategyFunds)
          .leftJoin(schema.strategies, eq(schema.strategyFunds.strategyId, schema.strategies.id)),
        db
          .select()
          .from(schema.tradeIntents)
          .where(eq(schema.tradeIntents.status, 'pending'))
          .orderBy(desc(schema.tradeIntents.createdAt))
          .limit(20),
        db
          .select()
          .from(schema.tradeIntents)
          .where(gte(schema.tradeIntents.createdAt, since))
          .orderBy(desc(schema.tradeIntents.createdAt))
          .limit(50),
        db
          .select({
            id: schema.trades.id,
            userId: schema.trades.userId,
            strategyId: schema.trades.strategyId,
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
          .orderBy(desc(schema.trades.createdAt))
          .limit(20),
      ]);

    // Map strategy IDs to slugs for easier reading
    const slugById = new Map(strategies.map((s) => [s.id, s.slug]));

    const tradingEnabled =
      (process.env.TRADING_ENABLED ?? 'true').toLowerCase() !== 'false' &&
      !(flags.find((f) => f.key === 'circuit_breaker_enabled')?.boolValue ?? false);

    return {
      trading_enabled: tradingEnabled,
      trading_enabled_env: process.env.TRADING_ENABLED ?? 'true',
      circuit_breaker: flags.find((f) => f.key === 'circuit_breaker_enabled')?.boolValue ?? false,
      market: marketDataSnapshot(),
      flags: flags.map((f) => ({ key: f.key, bool: f.boolValue, string: f.stringValue })),
      strategies: strategies.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        status: s.status,
      })),
      funds: funds.map((f) => ({
        userId: f.userId,
        strategyId: f.strategyId,
        strategySlug: f.slug,
        usdc: Number(f.usdcBalance) / 1e6,
        eth: Number(f.ethBalance) / 1e18,
        ethAvgEntryUsd: Number(f.ethAvgEntryUsd),
        realizedPnlUsd: Number(f.realizedPnlUsd),
        lastTradeAt: f.lastTradeAt,
        updatedAt: f.updatedAt,
      })),
      pendingIntents: pendingIntents.map((i) => ({
        id: i.id,
        userId: i.userId,
        strategySlug: slugById.get(i.strategyId) ?? null,
        side: i.side,
        tokenIn: i.tokenIn,
        tokenOut: i.tokenOut,
        amountIn: i.amountIn,
        reason: i.reason,
        createdAt: i.createdAt,
      })),
      recentIntents: recentIntents.map((i) => ({
        id: i.id,
        userId: i.userId,
        strategySlug: slugById.get(i.strategyId) ?? null,
        side: i.side,
        tokenIn: i.tokenIn,
        tokenOut: i.tokenOut,
        amountIn: i.amountIn,
        reason: i.reason,
        status: i.status,
        errorMessage: i.errorMessage,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      })),
      recentTrades: recentTrades.map((t) => ({
        ...t,
        strategySlug: slugById.get(t.strategyId) ?? null,
        notionalUsd: Number(t.notionalUsd),
        gasUsd: Number(t.gasUsd),
        slippage: Number(t.slippage),
        realizedPnlUsd: Number(t.realizedPnlUsd),
        createdAt: t.createdAt,
      })),
    };
  });

  /**
   * POST /admin/debug/kill — flip the global circuit breaker.
   * Body: { enabled: boolean }.
   * Same effect as /admin/circuit-breaker but bootstrap-gated (no JWT needed).
   */
  app.post('/admin/debug/kill', async (req, reply) => {
    if (!requireBootstrap(req, reply)) return;
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled_boolean_required' });
    }
    const db = getDb();
    await db
      .insert(schema.systemFlags)
      .values({ key: 'circuit_breaker_enabled', boolValue: body.enabled })
      .onConflictDoUpdate({
        target: schema.systemFlags.key,
        set: { boolValue: body.enabled, updatedAt: new Date() },
      });
    return { ok: true, circuit_breaker_enabled: body.enabled };
  });

  /**
   * POST /admin/debug/seed-funds — create/update a strategy_funds row.
   * Used to bootstrap the initial allocation for a user's deposit.
   * Body: { userId, strategySlug, usdcBase (string), ethWei (string), ethAvgEntryUsd? (number) }
   * `usdcBase` is USDC base units (6 decimals), `ethWei` is ETH wei (18 decimals).
   * If a row already exists, it's overwritten. Existing realizedPnlUsd is preserved.
   */
  const SeedInput = z.object({
    userId: z.string().uuid(),
    strategySlug: z.string().min(1),
    usdcBase: z.string().regex(/^\d+$/),
    ethWei: z.string().regex(/^\d+$/),
    ethAvgEntryUsd: z.number().optional(),
  });
  app.post('/admin/debug/seed-funds', async (req, reply) => {
    if (!requireBootstrap(req, reply)) return;
    const parsed = SeedInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const db = getDb();
    const [strat] = await db
      .select()
      .from(schema.strategies)
      .where(eq(schema.strategies.slug, parsed.data.strategySlug))
      .limit(1);
    if (!strat) return reply.code(404).send({ error: 'strategy_not_found' });

    const [existing] = await db
      .select()
      .from(schema.strategyFunds)
      .where(
        and(
          eq(schema.strategyFunds.userId, parsed.data.userId),
          eq(schema.strategyFunds.strategyId, strat.id),
        ),
      )
      .limit(1);

    const avgEntry =
      parsed.data.ethAvgEntryUsd != null ? parsed.data.ethAvgEntryUsd.toFixed(6) : '0';

    if (existing) {
      const [updated] = await db
        .update(schema.strategyFunds)
        .set({
          usdcBalance: parsed.data.usdcBase,
          ethBalance: parsed.data.ethWei,
          ethAvgEntryUsd: avgEntry,
          updatedAt: new Date(),
        })
        .where(eq(schema.strategyFunds.id, existing.id))
        .returning();
      return { ok: true, action: 'updated', row: updated };
    } else {
      const [inserted] = await db
        .insert(schema.strategyFunds)
        .values({
          userId: parsed.data.userId,
          strategyId: strat.id,
          usdcBalance: parsed.data.usdcBase,
          ethBalance: parsed.data.ethWei,
          ethAvgEntryUsd: avgEntry,
          realizedPnlUsd: '0',
        })
        .returning();
      return { ok: true, action: 'inserted', row: inserted };
    }
  });

  /**
   * POST /admin/debug/force-intent — inject a trade intent directly.
   * Used for smoke-testing executor without waiting for strategy runner.
   * Body: { userId, strategySlug, side, tokenIn, tokenOut, amountIn (string base units), reason? }
   */
  const ForceIntent = z.object({
    userId: z.string().uuid(),
    strategySlug: z.string().min(1),
    side: z.enum(['buy', 'sell']),
    tokenIn: z.enum(['USDC', 'ETH']),
    tokenOut: z.enum(['USDC', 'ETH']),
    amountIn: z.string().regex(/^\d+$/),
    reason: z.string().max(200).optional(),
  });
  app.post('/admin/debug/force-intent', async (req, reply) => {
    if (!requireBootstrap(req, reply)) return;
    const parsed = ForceIntent.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const db = getDb();
    const [strat] = await db
      .select()
      .from(schema.strategies)
      .where(eq(schema.strategies.slug, parsed.data.strategySlug))
      .limit(1);
    if (!strat) return reply.code(404).send({ error: 'strategy_not_found' });
    const [row] = await db
      .insert(schema.tradeIntents)
      .values({
        userId: parsed.data.userId,
        strategyId: strat.id,
        chain: 'arbitrum',
        side: parsed.data.side,
        tokenIn: parsed.data.tokenIn,
        tokenOut: parsed.data.tokenOut,
        amountIn: parsed.data.amountIn,
        reason: parsed.data.reason ?? 'bootstrap-forced intent',
        status: 'pending',
      })
      .returning();
    return { ok: true, intent: row };
  });

  /**
   * POST /admin/debug/run — manually fire a scheduler tick.
   * Body: { which: 'strategy' | 'executor' | 'pnl' }
   */
  const RunInput = z.object({ which: z.enum(['strategy', 'executor', 'pnl']) });
  app.post('/admin/debug/run', async (req, reply) => {
    if (!requireBootstrap(req, reply)) return;
    const parsed = RunInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    try {
      if (parsed.data.which === 'strategy') {
        const { runStrategyTick } = await import('../services/strategy-runner.js');
        return { ok: true, ...(await runStrategyTick()) };
      }
      if (parsed.data.which === 'executor') {
        const { runExecutorTick } = await import('../services/executor.js');
        return { ok: true, ...(await runExecutorTick()) };
      }
      if (parsed.data.which === 'pnl') {
        const { snapshotEquityTick } = await import('../services/pnl-tracker.js');
        return { ok: true, ...(await snapshotEquityTick()) };
      }
    } catch (err) {
      return reply.code(500).send({ error: 'run_failed', message: (err as Error).message });
    }
  });

  /**
   * GET /admin/debug/user-onchain?userId=... — read live on-chain balances for a user's wallet(s).
   */
  app.get('/admin/debug/user-onchain', async (req, reply) => {
    if (!requireBootstrap(req, reply)) return;
    const q = req.query as { userId?: string };
    if (!q.userId) return reply.code(400).send({ error: 'userId_required' });
    const db = getDb();
    const wallets = await db
      .select()
      .from(schema.agentWallets)
      .where(eq(schema.agentWallets.userId, q.userId));
    if (wallets.length === 0) return reply.code(404).send({ error: 'no_wallets' });
    const { readBalances } = await import('../lib/wallet.js');
    const balances: Record<string, unknown> = {};
    for (const w of wallets) {
      try {
        const b = await readBalances(
          w.chain as 'ethereum' | 'arbitrum' | 'base' | 'optimism',
          w.address as `0x${string}`,
        );
        balances[w.chain] = { address: w.address, ...b };
      } catch (err) {
        balances[w.chain] = { address: w.address, error: (err as Error).message };
      }
    }
    return { userId: q.userId, balances };
  });
}