CREATE TYPE "public"."chain" AS ENUM('ethereum', 'arbitrum', 'base', 'optimism');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('pending', 'confirmed', 'failed', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."ledger_event" AS ENUM('deposit', 'withdrawal', 'trade_realized_pnl', 'trade_fee', 'allocation_change', 'snapshot');--> statement-breakpoint
CREATE TYPE "public"."strategy_status" AS ENUM('paper', 'live', 'paused', 'retired');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('pending', 'signed', 'broadcast', 'confirmed', 'rejected', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain" "chain" NOT NULL,
	"address" varchar(64) NOT NULL,
	"derivation_path" varchar(64) NOT NULL,
	"last_native_balance" numeric(78, 0) DEFAULT '0' NOT NULL,
	"last_scanned_block" numeric(20, 0) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"chain" "chain" NOT NULL,
	"token" varchar(64) NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"tx_hash" varchar(128) NOT NULL,
	"status" "deposit_status" DEFAULT 'pending' NOT NULL,
	"amount_usd" numeric(20, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" "ledger_event" NOT NULL,
	"amount_usd" numeric(20, 6) NOT NULL,
	"balance_after_usd" numeric(20, 6) NOT NULL,
	"ref_id" uuid,
	"ref_type" varchar(32),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(128) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"chains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "strategy_status" DEFAULT 'paper' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_flags" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"bool_value" boolean,
	"string_value" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" text NOT NULL,
	"user_index" serial NOT NULL,
	"verified_eoa" varchar(42),
	"over_cap_flag" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"chain" "chain" NOT NULL,
	"to_address" varchar(64) NOT NULL,
	"token" varchar(64) NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"status" "withdrawal_status" DEFAULT 'pending' NOT NULL,
	"signed_payload" jsonb NOT NULL,
	"nonce" integer NOT NULL,
	"tx_hash" varchar(128),
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "allocations" ADD CONSTRAINT "allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "allocations" ADD CONSTRAINT "allocations_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposits" ADD CONSTRAINT "deposits_wallet_id_agent_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."agent_wallets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger" ADD CONSTRAINT "ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_wallet_id_agent_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."agent_wallets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wallets_user_chain_idx" ON "agent_wallets" USING btree ("user_id","chain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wallets_address_idx" ON "agent_wallets" USING btree ("address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wallets_chain_idx" ON "agent_wallets" USING btree ("chain");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "allocations_user_strategy_idx" ON "allocations" USING btree ("user_id","strategy_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deposits_tx_idx" ON "deposits" USING btree ("chain","tx_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deposits_user_idx" ON "deposits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_user_created_idx" ON "ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_ref_idx" ON "ledger" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategies_slug_idx" ON "strategies" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_user_index_idx" ON "users" USING btree ("user_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_user_idx" ON "withdrawals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_status_idx" ON "withdrawals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_user_nonce_idx" ON "withdrawals" USING btree ("user_id","nonce");