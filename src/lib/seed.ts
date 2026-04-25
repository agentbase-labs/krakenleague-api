/**
 * Seeds the 6 launch strategies and system flags.
 * Turtle + Wave Rider → status='active' (live on Arbitrum).
 * Others → status='coming_soon'.
 */
import { eq } from 'drizzle-orm';
import { getDb, closeDb, schema } from './db.js';

const SEED = [
  {
    slug: 'wave-rider',
    name: '🌊 Wave Rider',
    description:
      '4h momentum on ETH/USDC Arbitrum. Buys when ETH 4h return > +2% AND 24h volume > 7d avg. 3% trailing stop.',
    chains: ['arbitrum'],
    status: 'active' as const,
  },
  {
    slug: 'mean-hunter',
    name: '🔄 Mean Hunter',
    description:
      'Mean-reversion on ETH/USDC. Z-score > 2 → fade; exits on mean or stop. 1min bars.',
    chains: ['arbitrum'],
    status: 'coming_soon' as const,
  },
  {
    slug: 'lp-sniper',
    name: '🏦 LP Sniper',
    description:
      'Uniswap V3 concentrated LP on ETH/USDC 0.05% pool. Rebalances ranges based on realized volatility.',
    chains: ['ethereum', 'arbitrum'],
    status: 'coming_soon' as const,
  },
  {
    slug: 'rain-edge',
    name: '🎲 Rain Edge',
    description: 'Buys undervalued options on Rain prediction markets.',
    chains: ['arbitrum'],
    status: 'coming_soon' as const,
  },
  {
    slug: 'arb-scout',
    name: '⚡ Arb Scout',
    description: 'Cross-DEX arbitrage via LiFi. Acts only when spread > gas + slippage + safety margin.',
    chains: ['ethereum', 'arbitrum', 'base', 'optimism'],
    status: 'coming_soon' as const,
  },
  {
    slug: 'turtle',
    name: '🐢 Turtle',
    description:
      'Weekly DCA into ETH on Arbitrum. Buys 10% of your USDC allocation every 7 days. Never sells.',
    chains: ['arbitrum'],
    status: 'active' as const,
  },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[seed] DATABASE_URL not set — skipping.');
    process.exit(0);
  }
  const db = getDb();
  for (const s of SEED) {
    // Upsert: insert if missing, or update the fields below if present.
    const [existing] = await db
      .select()
      .from(schema.strategies)
      .where(eq(schema.strategies.slug, s.slug))
      .limit(1);
    if (!existing) {
      await db.insert(schema.strategies).values({
        slug: s.slug,
        name: s.name,
        description: s.description,
        chains: s.chains,
        status: s.status,
      });
      console.log(`[seed] inserted strategy ${s.slug} status=${s.status}`);
    } else {
      await db
        .update(schema.strategies)
        .set({
          name: s.name,
          description: s.description,
          chains: s.chains,
          status: s.status,
        })
        .where(eq(schema.strategies.slug, s.slug));
      console.log(`[seed] updated strategy ${s.slug} status=${s.status}`);
    }
  }

  await db
    .insert(schema.systemFlags)
    .values({ key: 'circuit_breaker_enabled', boolValue: false })
    .onConflictDoNothing({ target: schema.systemFlags.key });
  await db
    .insert(schema.systemFlags)
    .values({ key: 'max_deposit_usd_soft_cap', stringValue: '500' })
    .onConflictDoNothing({ target: schema.systemFlags.key });
  await db
    .insert(schema.systemFlags)
    .values({ key: 'daily_trade_cap_usd', stringValue: '100' })
    .onConflictDoNothing({ target: schema.systemFlags.key });
  console.log('[seed] done');
  await closeDb();
}

main().catch(async (err) => {
  console.error('[seed] FAILED:', err);
  await closeDb();
  process.exit(1);
});
