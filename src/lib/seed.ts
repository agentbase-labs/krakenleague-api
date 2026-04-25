/**
 * Seeds the 6 launch strategies (all status=paper).
 */
import { getDb, closeDb, schema } from './db.js';

const SEED = [
  {
    slug: 'wave-rider',
    name: '🌊 Wave Rider',
    description:
      'Momentum on top-20 ERC-20s by 24h volume. Enters on >5% 4h breakout + volume confirmation, exits on 3% trailing stop.',
    chains: ['ethereum', 'arbitrum'],
  },
  {
    slug: 'mean-hunter',
    name: '🔄 Mean Hunter',
    description:
      'Mean-reversion on ETH/USDC, WBTC/USDC pairs. Z-score > 2 → fade; exits on mean or stop. 1min bars.',
    chains: ['arbitrum'],
  },
  {
    slug: 'lp-sniper',
    name: '🏦 LP Sniper',
    description:
      'Uniswap V3 concentrated LP on ETH/USDC 0.05% pool. Rebalances ranges based on realized volatility.',
    chains: ['ethereum', 'arbitrum'],
  },
  {
    slug: 'rain-edge',
    name: '🎲 Rain Edge',
    description: 'Buys undervalued options on Rain prediction markets.',
    chains: ['arbitrum'],
  },
  {
    slug: 'arb-scout',
    name: '⚡ Arb Scout',
    description: 'Cross-DEX arbitrage via LiFi. Acts only when spread > gas + slippage + safety margin.',
    chains: ['ethereum', 'arbitrum', 'base', 'optimism'],
  },
  {
    slug: 'turtle',
    name: '🐢 Turtle',
    description: 'Conservative baseline: 50/50 USDC/ETH, weekly rebalance. The index fund.',
    chains: ['arbitrum'],
  },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[seed] DATABASE_URL not set — skipping.');
    process.exit(0);
  }
  const db = getDb();
  for (const s of SEED) {
    await db
      .insert(schema.strategies)
      .values({ ...s, status: 'paper' })
      .onConflictDoNothing({ target: schema.strategies.slug });
    console.log(`[seed] upserted strategy ${s.slug}`);
  }
  // Seed system_flags defaults
  await db
    .insert(schema.systemFlags)
    .values({ key: 'circuit_breaker_enabled', boolValue: false })
    .onConflictDoNothing({ target: schema.systemFlags.key });
  await db
    .insert(schema.systemFlags)
    .values({ key: 'max_deposit_usd_soft_cap', stringValue: '1000' })
    .onConflictDoNothing({ target: schema.systemFlags.key });
  console.log('[seed] done');
  await closeDb();
}

main().catch(async (err) => {
  console.error('[seed] FAILED:', err);
  await closeDb();
  process.exit(1);
});
