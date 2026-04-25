import type { Config } from 'drizzle-kit';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/kraken';

export default {
  schema: './src/lib/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
} satisfies Config;
