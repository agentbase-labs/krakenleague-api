/**
 * Runs Drizzle migrations against DATABASE_URL.
 * Invoked during predeploy on Render.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL not set — skipping.');
    process.exit(0);
  }
  const client = postgres(url, { max: 1, ssl: 'require', prepare: false });
  const db = drizzle(client);

  const here = dirname(fileURLToPath(import.meta.url));
  // dist/lib/migrate.js → ../../drizzle
  const folder = resolve(here, '..', '..', 'drizzle');
  console.log(`[migrate] running from ${folder}`);
  await migrate(db, { migrationsFolder: folder });
  console.log('[migrate] done');
  await client.end();
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
