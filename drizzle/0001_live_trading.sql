-- 0001_live_trading.sql — adds live trading tables + enum extensions
-- Idempotent: safe to re-run.

-- Extend strategy_status enum
ALTER TYPE "public"."strategy_status" ADD VALUE IF NOT EXISTS 'active';--> statement-breakpoint
ALTER TYPE "public"."strategy_status" ADD VALUE IF NOT EXISTS 'coming_soon';--> statement-breakpoint

-- New enums
DO $$ BEGIN
  CREATE TYPE "public"."trade_intent_status" AS ENUM('pending','executing','executed','rejected','expired','failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."trade_side" AS ENUM('buy','sell');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."trade_status" AS ENUM('pending','simulated','broadcast','confirmed','failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Users: is_admin flag
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- strategy_funds
CREATE TABLE IF NOT EXISTS "strategy_funds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "strategy_id" uuid NOT NULL,
  "usdc_balance" numeric(78,0) NOT NULL DEFAULT '0',
  "eth_balance" numeric(78,0) NOT NULL DEFAULT '0',
  "eth_avg_entry_usd" numeric(20,6) NOT NULL DEFAULT '0',
  "realized_pnl_usd" numeric(20,6) NOT NULL DEFAULT '0',
  "last_trade_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_funds_user_strategy_idx" ON "strategy_funds" ("user_id","strategy_id");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "strategy_funds" ADD CONSTRAINT "strategy_funds_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "strategy_funds" ADD CONSTRAINT "strategy_funds_strategy_fk" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- trade_intents
CREATE TABLE IF NOT EXISTS "trade_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "strategy_id" uuid NOT NULL,
  "chain" "chain" NOT NULL DEFAULT 'arbitrum',
  "side" "trade_side" NOT NULL,
  "token_in" varchar(16) NOT NULL,
  "token_out" varchar(16) NOT NULL,
  "amount_in" numeric(78,0) NOT NULL,
  "reason" text NOT NULL DEFAULT '',
  "status" "trade_intent_status" NOT NULL DEFAULT 'pending',
  "error_message" text,
  "trade_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_intents_status_idx" ON "trade_intents" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_intents_user_idx" ON "trade_intents" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_intents_strategy_idx" ON "trade_intents" ("strategy_id");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_strategy_fk" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- trades
CREATE TABLE IF NOT EXISTS "trades" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "intent_id" uuid,
  "user_id" uuid NOT NULL,
  "strategy_id" uuid NOT NULL,
  "chain" "chain" NOT NULL DEFAULT 'arbitrum',
  "side" "trade_side" NOT NULL,
  "token_in" varchar(16) NOT NULL,
  "token_out" varchar(16) NOT NULL,
  "amount_in" numeric(78,0) NOT NULL,
  "amount_out" numeric(78,0) NOT NULL,
  "notional_usd" numeric(20,6) NOT NULL,
  "gas_wei" numeric(78,0) NOT NULL DEFAULT '0',
  "gas_usd" numeric(20,6) NOT NULL DEFAULT '0',
  "slippage" numeric(10,6) NOT NULL DEFAULT '0',
  "tx_hash" varchar(128),
  "status" "trade_status" NOT NULL DEFAULT 'pending',
  "error_message" text,
  "realized_pnl_usd" numeric(20,6) NOT NULL DEFAULT '0',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trades_user_created_idx" ON "trades" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trades_strategy_created_idx" ON "trades" ("strategy_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trades_tx_idx" ON "trades" ("tx_hash");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trades" ADD CONSTRAINT "trades_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trades" ADD CONSTRAINT "trades_strategy_fk" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- equity_snapshots
CREATE TABLE IF NOT EXISTS "equity_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "strategy_id" uuid NOT NULL,
  "equity_usd" numeric(20,6) NOT NULL,
  "eth_price_usd" numeric(20,6) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equity_snapshots_strategy_created_idx" ON "equity_snapshots" ("strategy_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equity_snapshots_user_strategy_created_idx" ON "equity_snapshots" ("user_id","strategy_id","created_at");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_strategy_fk" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
