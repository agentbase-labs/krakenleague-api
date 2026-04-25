/**
 * Arbitrum deposit listener.
 *
 * Every `POLL_INTERVAL_MS` (default 30s):
 *   1. For each agent wallet on chain=arbitrum:
 *      a. Read native ETH balance. If > lastNativeBalance, create a native deposit row
 *         for the diff. (Synthetic tx hash `native-diff:<block>:<addr>`.)
 *      b. Fetch USDC Transfer events from lastScannedBlock..latest to this address.
 *         Create deposit rows keyed by the real tx hash.
 *   2. On any new deposit:
 *      - Insert into `deposits` with status=confirmed (USDC/ETH) or status=unsupported.
 *      - Insert a `ledger` row with balance_after_usd based on prior ledger row.
 *      - Publish `deposit.new.user.<userId>` on the bus.
 *
 * Other chains (ethereum/base/optimism) are intentionally NOT listened to
 * in this sprint — see VISION.md. Their addresses are provisioned but the UI
 * labels them as "coming soon".
 */
import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
  parseAbiItem,
  type Address,
} from 'viem';
import { arbitrum } from 'viem/chains';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { rpcUrl, USDC_ADDRESS, USDC_DECIMALS } from '../lib/chains.js';
import { publish } from '../lib/bus.js';
import { getEthPriceUsd } from '../services/market-data.js';

const POLL_INTERVAL_MS = Number(process.env.DEPOSIT_POLL_MS ?? 30_000);
const BLOCK_LOOKBACK_CAP = 9000n; // Alchemy free tier caps eth_getLogs at 10k blocks; we stay safe.

// Fallback ETH price if CoinGecko call fails (first-boot only — cache persists after).
const ETH_PRICE_USD_FALLBACK = 3000;
const USDC_PRICE_USD = 1;

async function fetchLatestBlock(): Promise<bigint> {
  const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl('arbitrum')) });
  return await client.getBlockNumber();
}

export async function pollOnce(): Promise<void> {
  const db = getDb();
  const wallets = await db.select().from(schema.agentWallets).where(eq(schema.agentWallets.chain, 'arbitrum'));
  if (wallets.length === 0) return;

  const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl('arbitrum')) });

  const latest = await client.getBlockNumber();

  // ---- 1. Native ETH: balance-diff detection ----
  for (const w of wallets) {
    try {
      const balance = await client.getBalance({ address: w.address as Address });
      const last = BigInt(w.lastNativeBalance ?? '0');
      if (balance > last) {
        const diff = balance - last;
        const syntheticHash = `native-diff:${latest.toString()}:${w.address}`;
        // Insert deposit row (ignore if already exists for this tx)
        const existing = await db
          .select({ id: schema.deposits.id })
          .from(schema.deposits)
          .where(and(eq(schema.deposits.chain, 'arbitrum'), eq(schema.deposits.txHash, syntheticHash)))
          .limit(1);
        if (existing.length === 0) {
          // Live ETH price (CoinGecko, 60s cache). Falls back to 3000 on first-boot fetch failure.
          const livePrice = await getEthPriceUsd();
          const ethPrice = livePrice ?? ETH_PRICE_USD_FALLBACK;
          const amountUsd = (Number(formatEther(diff)) * ethPrice).toFixed(6);
          const [dep] = await db
            .insert(schema.deposits)
            .values({
              userId: w.userId,
              walletId: w.id,
              chain: 'arbitrum',
              token: 'ETH',
              amount: diff.toString(),
              txHash: syntheticHash,
              status: 'confirmed',
              amountUsd,
            })
            .returning();
          await appendDepositLedger(w.userId, amountUsd, dep!.id);
          publish(`deposit.new.user.${w.userId}`, {
            id: dep!.id,
            chain: 'arbitrum',
            token: 'ETH',
            amount: formatEther(diff),
            amountUsd: Number(amountUsd),
            txHash: syntheticHash,
          });
          console.log(`[deposit-listener] NEW native deposit user=${w.userId} eth=${formatEther(diff)}`);
        }
      }
      // Always update the snapshot
      if (balance.toString() !== (w.lastNativeBalance ?? '0')) {
        await db
          .update(schema.agentWallets)
          .set({ lastNativeBalance: balance.toString() })
          .where(eq(schema.agentWallets.id, w.id));
      }
    } catch (err) {
      console.error(`[deposit-listener] native balance read failed for ${w.address}:`, (err as Error).message);
    }
  }

  // ---- 2. USDC Transfer events ----
  // We use a single eth_getLogs call across all tracked addresses.
  const usdc = USDC_ADDRESS.arbitrum;
  const addressesByLower = new Map<string, typeof wallets[number]>();
  for (const w of wallets) addressesByLower.set(w.address.toLowerCase(), w);

  // Determine fromBlock: min(lastScannedBlock) across all wallets, default latest-200.
  let fromBlock: bigint;
  const scanned = wallets.map((w) => BigInt(w.lastScannedBlock ?? '0'));
  const minScanned = scanned.reduce((a, b) => (a < b ? a : b), scanned[0] ?? 0n);
  if (minScanned === 0n) {
    fromBlock = latest - 200n > 0n ? latest - 200n : 0n;
  } else {
    fromBlock = minScanned + 1n;
  }
  // Cap the range so we don't blow up on first boot
  if (latest - fromBlock > BLOCK_LOOKBACK_CAP) {
    fromBlock = latest - BLOCK_LOOKBACK_CAP;
  }

  if (fromBlock <= latest) {
    try {
      const logs = await client.getLogs({
        address: usdc,
        event: parseAbiItem(
          'event Transfer(address indexed from, address indexed to, uint256 value)',
        ),
        args: { to: wallets.map((w) => w.address as Address) },
        fromBlock,
        toBlock: latest,
      });
      for (const log of logs) {
        const toAddr = (log.args.to as string).toLowerCase();
        const w = addressesByLower.get(toAddr);
        if (!w) continue;
        const txHash = log.transactionHash as string;
        // Dedup
        const existing = await db
          .select({ id: schema.deposits.id })
          .from(schema.deposits)
          .where(and(eq(schema.deposits.chain, 'arbitrum'), eq(schema.deposits.txHash, txHash)))
          .limit(1);
        if (existing.length > 0) continue;
        const value = log.args.value as bigint;
        const amountUsd = (Number(formatUnits(value, USDC_DECIMALS)) * USDC_PRICE_USD).toFixed(6);
        const [dep] = await db
          .insert(schema.deposits)
          .values({
            userId: w.userId,
            walletId: w.id,
            chain: 'arbitrum',
            token: 'USDC',
            amount: value.toString(),
            txHash,
            status: 'confirmed',
            amountUsd,
          })
          .returning();
        await appendDepositLedger(w.userId, amountUsd, dep!.id);
        publish(`deposit.new.user.${w.userId}`, {
          id: dep!.id,
          chain: 'arbitrum',
          token: 'USDC',
          amount: formatUnits(value, USDC_DECIMALS),
          amountUsd: Number(amountUsd),
          txHash,
        });
        console.log(`[deposit-listener] NEW USDC deposit user=${w.userId} usdc=${formatUnits(value, USDC_DECIMALS)}`);
      }
    } catch (err) {
      console.error('[deposit-listener] getLogs failed:', (err as Error).message);
    }
  }

  // Advance lastScannedBlock for all wallets to `latest`
  await db
    .update(schema.agentWallets)
    .set({ lastScannedBlock: latest.toString() })
    .where(
      and(
        eq(schema.agentWallets.chain, 'arbitrum'),
        inArray(
          schema.agentWallets.id,
          wallets.map((w) => w.id),
        ),
      ),
    );
}

async function appendDepositLedger(userId: string, amountUsd: string, depositId: string) {
  const db = getDb();
  const [prev] = await db
    .select({ balanceAfterUsd: schema.ledger.balanceAfterUsd })
    .from(schema.ledger)
    .where(eq(schema.ledger.userId, userId))
    .orderBy(desc(schema.ledger.createdAt))
    .limit(1);
  const prevBal = prev ? Number(prev.balanceAfterUsd) : 0;
  const newBal = prevBal + Number(amountUsd);

  await db.insert(schema.ledger).values({
    userId,
    eventType: 'deposit',
    amountUsd,
    balanceAfterUsd: newBal.toFixed(6),
    refId: depositId,
    refType: 'deposit',
    notes: 'on-chain deposit confirmed',
  });

  // Soft cap flag
  if (newBal > 1000) {
    await db
      .update(schema.users)
      .set({ overCapFlag: true })
      .where(eq(schema.users.id, userId));
    console.warn(`[deposit-listener] user ${userId} over $1000 soft cap (balance=$${newBal.toFixed(2)})`);
  }
}

export function startDepositListener() {
  if ((process.env.DEPOSIT_LISTENER_ENABLED ?? 'true').toLowerCase() !== 'true') {
    console.log('[deposit-listener] disabled via DEPOSIT_LISTENER_ENABLED');
    return;
  }
  console.log(`[deposit-listener] starting. polling Arbitrum every ${POLL_INTERVAL_MS}ms`);
  // Kick off immediately, then interval
  const run = async () => {
    try {
      await pollOnce();
    } catch (err) {
      console.error('[deposit-listener] poll iteration failed:', (err as Error).message);
    }
  };
  void run();
  setInterval(run, POLL_INTERVAL_MS);
}