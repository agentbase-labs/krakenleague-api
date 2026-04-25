/**
 * Kraken League — Postgres schema (Drizzle ORM).
 *
 * Append-only: `ledger`, `deposits` (status transitions allowed), `trades`,
 * `pnl_snapshots`, `league_snapshots`.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  numeric,
  integer,
  boolean,
  pgEnum,
  serial,
  uniqueIndex,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';

/* ---------------- Enums ---------------- */

export const chainEnum = pgEnum('chain', ['ethereum', 'arbitrum', 'base', 'optimism']);

export const strategyStatusEnum = pgEnum('strategy_status', [
  'paper',
  'live',
  'paused',
  'retired',
  'active',
  'coming_soon',
]);

export const tradeIntentStatusEnum = pgEnum('trade_intent_status', [
  'pending',
  'executing',
  'executed',
  'rejected',
  'expired',
  'failed',
]);

export const tradeSideEnum = pgEnum('trade_side', ['buy', 'sell']);

export const tradeStatusEnum = pgEnum('trade_status', [
  'pending',
  'simulated',
  'broadcast',
  'confirmed',
  'failed',
]);

export const depositStatusEnum = pgEnum('deposit_status', [
  'pending',
  'confirmed',
  'failed',
  'unsupported',
]);

export const withdrawalStatusEnum = pgEnum('withdrawal_status', [
  'pending',
  'signed',
  'broadcast',
  'confirmed',
  'rejected',
  'failed',
]);

export const ledgerEventEnum = pgEnum('ledger_event', [
  'deposit',
  'withdrawal',
  'trade_realized_pnl',
  'trade_fee',
  'allocation_change',
  'snapshot',
]);

/* ---------------- Users ---------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    /** Monotonic index used in the BIP-44 derivation path. */
    userIndex: serial('user_index').notNull(),
    /** Optional EOA the user has linked for withdrawals; signature-verified. */
    verifiedEoa: varchar('verified_eoa', { length: 42 }),
    /** Admin flag set when deposits push balance over the soft cap. */
    overCapFlag: boolean('over_cap_flag').notNull().default(false),
    /** Admin user (can hit /admin/* endpoints). */
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
    userIndexIdx: uniqueIndex('users_user_index_idx').on(t.userIndex),
  }),
);

/* ---------------- Agent wallets (per user, per chain) ---------------- */

export const agentWallets = pgTable(
  'agent_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull(),
    address: varchar('address', { length: 64 }).notNull(),
    /** BIP-44 derivation path, e.g. m/44'/60'/{userIndex}'/0/0 */
    derivationPath: varchar('derivation_path', { length: 64 }).notNull(),
    /** Last known on-chain native balance (wei), for native deposit diffing. */
    lastNativeBalance: numeric('last_native_balance', { precision: 78, scale: 0 })
      .notNull()
      .default('0'),
    /** Last block number scanned for ERC-20 Transfer events on this address. */
    lastScannedBlock: numeric('last_scanned_block', { precision: 20, scale: 0 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userChainIdx: uniqueIndex('agent_wallets_user_chain_idx').on(t.userId, t.chain),
    addressIdx: index('agent_wallets_address_idx').on(t.address),
    chainIdx: index('agent_wallets_chain_idx').on(t.chain),
  }),
);

/* ---------------- Deposits ---------------- */

export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => agentWallets.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull(),
    /** 'ETH', 'USDC', or the contract address for unsupported tokens. */
    token: varchar('token', { length: 64 }).notNull(),
    /** wei / base-units */
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    /** tx hash, or synthetic id like `native-diff:<block>:<addr>` for native balance diffs. */
    txHash: varchar('tx_hash', { length: 128 }).notNull(),
    status: depositStatusEnum('status').notNull().default('pending'),
    /** USD value at credit time (for balance/ledger tracking). */
    amountUsd: numeric('amount_usd', { precision: 20, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    txIdx: uniqueIndex('deposits_tx_idx').on(t.chain, t.txHash),
    userIdx: index('deposits_user_idx').on(t.userId),
  }),
);

/* ---------------- Withdrawals ---------------- */

export const withdrawals = pgTable(
  'withdrawals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => agentWallets.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull(),
    toAddress: varchar('to_address', { length: 64 }).notNull(),
    token: varchar('token', { length: 64 }).notNull(),
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    status: withdrawalStatusEnum('status').notNull().default('pending'),
    /** Raw user-signed payload + signature for audit. */
    signedPayload: jsonb('signed_payload').notNull(),
    /** Strictly increasing per-user; used in the signed payload. */
    nonce: integer('nonce').notNull(),
    txHash: varchar('tx_hash', { length: 128 }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('withdrawals_user_idx').on(t.userId),
    statusIdx: index('withdrawals_status_idx').on(t.status),
    userNonceIdx: uniqueIndex('withdrawals_user_nonce_idx').on(t.userId, t.nonce),
  }),
);

/* ---------------- Strategies ---------------- */

export const strategies = pgTable(
  'strategies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 128 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    description: text('description').notNull().default(''),
    chains: jsonb('chains').$type<string[]>().notNull().default([]),
    status: strategyStatusEnum('status').notNull().default('paper'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugIdx: uniqueIndex('strategies_slug_idx').on(t.slug),
  }),
);

/* ---------------- Allocations ---------------- */

export const allocations = pgTable(
  'allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id, { onDelete: 'cascade' }),
    percent: numeric('percent', { precision: 5, scale: 2 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userStrategyIdx: uniqueIndex('allocations_user_strategy_idx').on(t.userId, t.strategyId),
  }),
);

/* ---------------- Ledger (append-only audit) ---------------- */

export const ledger = pgTable(
  'ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: ledgerEventEnum('event_type').notNull(),
    amountUsd: numeric('amount_usd', { precision: 20, scale: 6 }).notNull(),
    balanceAfterUsd: numeric('balance_after_usd', { precision: 20, scale: 6 }).notNull(),
    refId: uuid('ref_id'),
    refType: varchar('ref_type', { length: 32 }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userCreatedIdx: index('ledger_user_created_idx').on(t.userId, t.createdAt),
    refIdx: index('ledger_ref_idx').on(t.refType, t.refId),
  }),
);

/* ---------------- Config / kill-switch ---------------- */

export const systemFlags = pgTable('system_flags', {
  key: varchar('key', { length: 64 }).primaryKey(),
  boolValue: boolean('bool_value'),
  stringValue: text('string_value'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/* ---------------- Strategy allocations (off-chain $ balance per strategy) ---------------- */

/**
 * Tracks the **USD value** a user has allocated to a given strategy. Source
 * of truth for "what funds can this strategy use". Starts at 0; `POST /allocations/fund`
 * moves USD from the user's unallocated wallet balance into a strategy bucket.
 *
 * NOTE: this is OFF-CHAIN accounting. There is ONE on-chain wallet per user;
 * the strategy just gets a virtual sub-balance.
 */
export const strategyFunds = pgTable(
  'strategy_funds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id, { onDelete: 'cascade' }),
    /** USDC balance allocated to this strategy (base units, 6 decimals). */
    usdcBalance: numeric('usdc_balance', { precision: 78, scale: 0 }).notNull().default('0'),
    /** ETH balance held by this strategy (wei, 18 decimals). */
    ethBalance: numeric('eth_balance', { precision: 78, scale: 0 }).notNull().default('0'),
    /** Avg entry price in USD for the ETH held (for P&L). Numeric for precision. */
    ethAvgEntryUsd: numeric('eth_avg_entry_usd', { precision: 20, scale: 6 }).notNull().default('0'),
    /** Realized USD P&L across all closed trades for this strategy. */
    realizedPnlUsd: numeric('realized_pnl_usd', { precision: 20, scale: 6 }).notNull().default('0'),
    /** Last trade timestamp, used by Turtle for weekly DCA gating. */
    lastTradeAt: timestamp('last_trade_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userStrategyIdx: uniqueIndex('strategy_funds_user_strategy_idx').on(t.userId, t.strategyId),
  }),
);

/* ---------------- Trade intents ---------------- */

/**
 * Decisions produced by the strategy runner, picked up by the executor.
 * One row per (userId, strategyId, decision).
 */
export const tradeIntents = pgTable(
  'trade_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull().default('arbitrum'),
    side: tradeSideEnum('side').notNull(),
    /** 'ETH' or 'USDC' — the token being BOUGHT. */
    tokenIn: varchar('token_in', { length: 16 }).notNull(),
    tokenOut: varchar('token_out', { length: 16 }).notNull(),
    /** Amount of tokenIn to spend (base units). */
    amountIn: numeric('amount_in', { precision: 78, scale: 0 }).notNull(),
    /** Human-readable rationale for this intent. */
    reason: text('reason').notNull().default(''),
    status: tradeIntentStatusEnum('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    /** Link to the trade that executed this intent (if any). */
    tradeId: uuid('trade_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusIdx: index('trade_intents_status_idx').on(t.status),
    userIdx: index('trade_intents_user_idx').on(t.userId),
    strategyIdx: index('trade_intents_strategy_idx').on(t.strategyId),
  }),
);

/* ---------------- Trades ---------------- */

export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull().default('arbitrum'),
    side: tradeSideEnum('side').notNull(),
    tokenIn: varchar('token_in', { length: 16 }).notNull(),
    tokenOut: varchar('token_out', { length: 16 }).notNull(),
    amountIn: numeric('amount_in', { precision: 78, scale: 0 }).notNull(),
    amountOut: numeric('amount_out', { precision: 78, scale: 0 }).notNull(),
    /** USD notional at execution (positive). */
    notionalUsd: numeric('notional_usd', { precision: 20, scale: 6 }).notNull(),
    /** Gas spent (wei). */
    gasWei: numeric('gas_wei', { precision: 78, scale: 0 }).notNull().default('0'),
    gasUsd: numeric('gas_usd', { precision: 20, scale: 6 }).notNull().default('0'),
    /** Realised slippage observed between quote and fill, as a fraction (e.g. 0.003 = 30bps). */
    slippage: numeric('slippage', { precision: 10, scale: 6 }).notNull().default('0'),
    txHash: varchar('tx_hash', { length: 128 }),
    status: tradeStatusEnum('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    /** P&L realised on this specific trade (sells only). */
    realizedPnlUsd: numeric('realized_pnl_usd', { precision: 20, scale: 6 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userCreatedIdx: index('trades_user_created_idx').on(t.userId, t.createdAt),
    strategyCreatedIdx: index('trades_strategy_created_idx').on(t.strategyId, t.createdAt),
    txIdx: uniqueIndex('trades_tx_idx').on(t.txHash),
  }),
);

/* ---------------- Equity snapshots (time-series) ---------------- */

export const equitySnapshots = pgTable(
  'equity_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id, { onDelete: 'cascade' }),
    equityUsd: numeric('equity_usd', { precision: 20, scale: 6 }).notNull(),
    ethPriceUsd: numeric('eth_price_usd', { precision: 20, scale: 6 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    strategyCreatedIdx: index('equity_snapshots_strategy_created_idx').on(t.strategyId, t.createdAt),
    userStrategyCreatedIdx: index('equity_snapshots_user_strategy_created_idx').on(
      t.userId,
      t.strategyId,
      t.createdAt,
    ),
  }),
);
