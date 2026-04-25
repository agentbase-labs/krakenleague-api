/**
 * P&L tracker — every 5 min, mark-to-market every (user, strategy) fund
 * and append an `equity_snapshots` row. Powers the equity curves.
 */
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { getEthPriceUsd } from './market-data.js';

export async function snapshotEquityTick(): Promise<{ rowsWritten: number }> {
  const db = getDb();
  const ethPriceUsd = await getEthPriceUsd();
  if (!ethPriceUsd) return { rowsWritten: 0 };

  const funds = await db.select().from(schema.strategyFunds);
  if (funds.length === 0) return { rowsWritten: 0 };

  let rowsWritten = 0;
  for (const f of funds) {
    const usdc = Number(f.usdcBalance) / 1e6;
    const eth = Number(f.ethBalance) / 1e18;
    const equityUsd = usdc + eth * ethPriceUsd + Number(f.realizedPnlUsd);
    await db.insert(schema.equitySnapshots).values({
      userId: f.userId,
      strategyId: f.strategyId,
      equityUsd: equityUsd.toFixed(6),
      ethPriceUsd: ethPriceUsd.toFixed(6),
    });
    rowsWritten++;
  }
  return { rowsWritten };
}

export function startPnlTracker(): () => void {
  let stopped = false;
  let inflight = false;
  const tick = async () => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      const s = await snapshotEquityTick();
      if (s.rowsWritten > 0) {
        console.log(`[pnl-tracker] wrote ${s.rowsWritten} equity snapshots`);
      }
    } catch (err) {
      console.error('[pnl-tracker] crashed:', (err as Error).message);
    } finally {
      inflight = false;
    }
  };
  setTimeout(() => void tick(), 30_000);
  const id = setInterval(tick, 5 * 60_000);
  console.log('[pnl-tracker] started (5-minute ticks)');
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
