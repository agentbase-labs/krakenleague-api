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
