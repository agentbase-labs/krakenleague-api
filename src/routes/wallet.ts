import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { requireAuth } from '../lib/auth-hook.js';
import {
  readBalances,
  signAndBroadcastWithdrawal,
  verifyWithdrawalSignature,
} from '../lib/wallet.js';
import { CHAINS, USDC_DECIMALS, type Chain } from '../lib/chains.js';
import { parseUnits, formatUnits, formatEther } from 'viem';
import { publish } from '../lib/bus.js';

const WithdrawRequest = z.object({
  chain: z.enum(CHAINS),
  toAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  token: z.enum(['ETH', 'USDC']),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  /** User's EOA (the one that signed the payload) — must match a registered or allowed EOA. */
  fromEoa: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  payload: z.string(),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
});

const GAS_RESERVE_WEI = parseUnits('0.0001', 18); // 0.0001 ETH on Arbitrum

export async function registerWalletRoutes(app: FastifyInstance) {
  // ---------- GET /wallet ----------
  app.get('/wallet', { preHandler: requireAuth }, async (req) => {
    const db = getDb();
    const wallets = await db
      .select()
      .from(schema.agentWallets)
      .where(eq(schema.agentWallets.userId, req.user.sub));
    return {
      wallets: wallets.map((w) => ({
        chain: w.chain,
        address: w.address,
        derivationPath: w.derivationPath,
      })),
      note:
        'Live deposits are detected on Arbitrum only. Addresses on other chains are provisioned ' +
        'but deposits will not be credited yet.',
    };
  });

  // ---------- GET /wallet/balance ----------
  app.get('/wallet/balance', { preHandler: requireAuth }, async (req) => {
    const db = getDb();
    const wallets = await db
      .select()
      .from(schema.agentWallets)
      .where(eq(schema.agentWallets.userId, req.user.sub));

    const out: Array<{
      chain: Chain;
      address: string;
      native: { raw: string; formatted: string };
      usdc: { raw: string; formatted: string };
      live: boolean;
    }> = [];
    for (const w of wallets) {
      if (w.chain === 'arbitrum') {
        try {
          const b = await readBalances(w.chain, w.address as `0x${string}`);
          out.push({ chain: w.chain, address: w.address, ...b, live: true });
        } catch (err) {
          app.log.warn({ err, chain: w.chain }, 'balance read failed');
          out.push({
            chain: w.chain,
            address: w.address,
            native: { raw: '0', formatted: '0' },
            usdc: { raw: '0', formatted: '0' },
            live: false,
          });
        }
      } else {
        // Other chains: address shown but not actively read (deposits not credited yet).
        out.push({
          chain: w.chain,
          address: w.address,
          native: { raw: '0', formatted: '0' },
          usdc: { raw: '0', formatted: '0' },
          live: false,
        });
      }
    }
    return { balances: out };
  });

  // ---------- GET /deposits ----------
  app.get('/deposits', { preHandler: requireAuth }, async (req) => {
    const db = getDb();
    const q = req.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 20)));
    const rows = await db
      .select()
      .from(schema.deposits)
      .where(eq(schema.deposits.userId, req.user.sub))
      .orderBy(desc(schema.deposits.createdAt))
      .limit(limit);
    return {
      deposits: rows.map((r) => ({
        id: r.id,
        chain: r.chain,
        token: r.token,
        amount: r.amount,
        amountFormatted:
          r.token === 'USDC'
            ? formatUnits(BigInt(r.amount), USDC_DECIMALS)
            : r.token === 'ETH'
              ? formatEther(BigInt(r.amount))
              : r.amount,
        amountUsd: r.amountUsd ? Number(r.amountUsd) : null,
        txHash: r.txHash,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  // ---------- GET /withdrawals ----------
  app.get('/withdrawals', { preHandler: requireAuth }, async (req) => {
    const db = getDb();
    const q = req.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 20)));
    const rows = await db
      .select()
      .from(schema.withdrawals)
      .where(eq(schema.withdrawals.userId, req.user.sub))
      .orderBy(desc(schema.withdrawals.createdAt))
      .limit(limit);
    return {
      withdrawals: rows.map((r) => ({
        id: r.id,
        chain: r.chain,
        token: r.token,
        amount: r.amount,
        amountFormatted:
          r.token === 'USDC'
            ? formatUnits(BigInt(r.amount), USDC_DECIMALS)
            : r.token === 'ETH'
              ? formatEther(BigInt(r.amount))
              : r.amount,
        toAddress: r.toAddress,
        status: r.status,
        txHash: r.txHash,
        createdAt: r.createdAt.toISOString(),
        errorMessage: r.errorMessage,
      })),
    };
  });

  // ---------- POST /wallet/withdraw ----------
  app.post('/wallet/withdraw', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = WithdrawRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const { chain, toAddress, token, amount, payload, signature, fromEoa } = parsed.data;
    if (chain !== 'arbitrum') {
      return reply.code(400).send({ error: 'chain_not_supported', message: 'Only arbitrum withdrawals are live.' });
    }
    if (Number(amount) <= 0) {
      return reply.code(400).send({ error: 'invalid_amount' });
    }

    const db = getDb();
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, req.user.sub))
      .limit(1);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    // ---- Throttle: max 3 withdrawal attempts per hour ----
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await db
      .select({ id: schema.withdrawals.id })
      .from(schema.withdrawals)
      .where(
        and(
          eq(schema.withdrawals.userId, user.id),
          gte(schema.withdrawals.createdAt, oneHourAgo),
        ),
      );
    if (recent.length >= 3) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Max 3 withdrawal attempts per hour.' });
    }

    // ---- Signature verification ----
    // The EOA to check against: if user has a verifiedEoa we require that;
    // otherwise we accept fromEoa provided in the request (first-time link).
    const signerEoa = (user.verifiedEoa ?? fromEoa) as `0x${string}` | null | undefined;
    if (!signerEoa) {
      return reply.code(400).send({ error: 'no_eoa', message: 'Link an EOA first (include fromEoa).' });
    }
    const sigOk = await verifyWithdrawalSignature(
      signerEoa,
      payload,
      signature as `0x${string}`,
    );
    if (!sigOk) {
      return reply.code(401).send({ error: 'bad_signature' });
    }

    // ---- Payload contents validation ----
    // Expected payload shape (exact match required):
    //   `Withdraw ${amount} ${token} from Kraken League to ${toAddress} nonce ${nonce}`
    // Extract nonce + ensure other fields match.
    const match = payload.match(
      /^Withdraw (\S+) (ETH|USDC) from Kraken League to (0x[a-fA-F0-9]{40}) nonce (\d+)$/,
    );
    if (!match) {
      return reply.code(400).send({ error: 'invalid_payload_format' });
    }
    const [, pAmount, pToken, pTo, pNonceStr] = match;
    if (pAmount !== amount || pToken !== token || pTo!.toLowerCase() !== toAddress.toLowerCase()) {
      return reply.code(400).send({ error: 'payload_mismatch' });
    }
    const nonce = Number(pNonceStr);

    // ---- Nonce must not be reused ----
    const dup = await db
      .select({ id: schema.withdrawals.id })
      .from(schema.withdrawals)
      .where(and(eq(schema.withdrawals.userId, user.id), eq(schema.withdrawals.nonce, nonce)))
      .limit(1);
    if (dup.length > 0) {
      return reply.code(409).send({ error: 'nonce_reused' });
    }

    // ---- Find agent wallet for this chain ----
    const [wallet] = await db
      .select()
      .from(schema.agentWallets)
      .where(and(eq(schema.agentWallets.userId, user.id), eq(schema.agentWallets.chain, chain)))
      .limit(1);
    if (!wallet) {
      return reply.code(500).send({ error: 'wallet_not_provisioned' });
    }

    // ---- Balance check (on-chain for ETH; for USDC we also check on-chain) ----
    const bal = await readBalances(chain, wallet.address as `0x${string}`);
    const amtWei =
      token === 'ETH' ? parseUnits(amount, 18) : parseUnits(amount, USDC_DECIMALS);

    if (token === 'ETH') {
      const nativeWei = BigInt(bal.native.raw);
      if (amtWei + GAS_RESERVE_WEI > nativeWei) {
        return reply
          .code(400)
          .send({ error: 'insufficient_balance', message: 'Must leave 0.0001 ETH gas reserve.' });
      }
    } else {
      const usdcWei = BigInt(bal.usdc.raw);
      if (amtWei > usdcWei) {
        return reply.code(400).send({ error: 'insufficient_balance' });
      }
      // Also need some gas reserve in native
      const nativeWei = BigInt(bal.native.raw);
      if (nativeWei < GAS_RESERVE_WEI) {
        return reply.code(400).send({
          error: 'insufficient_gas',
          message: `Agent wallet needs >= 0.0001 ETH on Arbitrum to pay gas. Current: ${bal.native.formatted} ETH.`,
        });
      }
    }

    // ---- Upsert EOA on first successful sig ----
    if (!user.verifiedEoa && fromEoa) {
      await db
        .update(schema.users)
        .set({ verifiedEoa: fromEoa.toLowerCase() })
        .where(eq(schema.users.id, user.id));
    }

    // ---- Insert withdrawal row (pending) ----
    const [wrow] = await db
      .insert(schema.withdrawals)
      .values({
        userId: user.id,
        walletId: wallet.id,
        chain,
        toAddress: toAddress.toLowerCase(),
        token,
        amount: amtWei.toString(),
        signedPayload: { payload, signature: '[REDACTED]' }, // we never store raw sig
        nonce,
        status: 'pending',
      })
      .returning();

    // ---- Broadcast ----
    try {
      const { txHash } = await signAndBroadcastWithdrawal({
        chain,
        userIndex: user.userIndex,
        toAddress: toAddress as `0x${string}`,
        token,
        amount,
      });
      await db
        .update(schema.withdrawals)
        .set({ status: 'broadcast', txHash })
        .where(eq(schema.withdrawals.id, wrow!.id));

      // Ledger entry (withdrawal debits balance_after_usd)
      // Approximate USD. ETH=3000, USDC=1 (replace with live prices later).
      const amountUsd =
        token === 'ETH' ? (Number(amount) * 3000).toFixed(6) : Number(amount).toFixed(6);
      const [prev] = await db
        .select({ balanceAfterUsd: schema.ledger.balanceAfterUsd })
        .from(schema.ledger)
        .where(eq(schema.ledger.userId, user.id))
        .orderBy(desc(schema.ledger.createdAt))
        .limit(1);
      const prevBal = prev ? Number(prev.balanceAfterUsd) : 0;
      const newBal = (prevBal - Number(amountUsd)).toFixed(6);
      await db.insert(schema.ledger).values({
        userId: user.id,
        eventType: 'withdrawal',
        amountUsd: `-${amountUsd}`,
        balanceAfterUsd: newBal,
        refId: wrow!.id,
        refType: 'withdrawal',
        notes: `withdrawal ${txHash}`,
      });

      publish(`withdrawal.confirmed.user.${user.id}`, {
        id: wrow!.id,
        txHash,
        chain,
        token,
        amount,
      });

      return reply.send({
        withdrawalId: wrow!.id,
        status: 'broadcast',
        txHash,
      });
    } catch (err) {
      const msg = (err as Error).message ?? 'broadcast failed';
      await db
        .update(schema.withdrawals)
        .set({ status: 'failed', errorMessage: msg.substring(0, 500) })
        .where(eq(schema.withdrawals.id, wrow!.id));
      app.log.error({ err }, 'withdrawal broadcast failed');
      return reply.code(500).send({ error: 'broadcast_failed', message: msg });
    }
  });
}
