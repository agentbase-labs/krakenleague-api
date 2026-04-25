import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';

import { registerAuthRoutes } from './routes/auth.js';
import { registerWalletRoutes } from './routes/wallet.js';
import { registerStrategyRoutes } from './routes/strategies.js';
import { registerAllocationRoutes } from './routes/allocations.js';
import { registerPortfolioRoutes } from './routes/portfolio.js';
import { registerLeagueRoutes } from './routes/league.js';
import { registerTradeRoutes } from './routes/trades.js';
import { registerWsRoutes } from './routes/ws.js';
import { registerAdminRoutes } from './routes/admin.js';
import { startDepositListener } from './workers/deposit-listener.js';
import { startMarketDataPoller } from './services/market-data.js';
import { startStrategyRunner } from './services/strategy-runner.js';
import { startExecutor } from './services/executor.js';
import { startPnlTracker } from './services/pnl-tracker.js';

const PORT = Number(process.env.PORT ?? 10000);
const HOST = process.env.HOST ?? '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET ?? '';
const CORS_ORIGINS = (
  process.env.CORS_ORIGIN ??
  'https://krakenleague.xyz,https://krakenleague-xyz.onrender.com,http://localhost:3000'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 chars');
  process.exit(1);
}

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Redact common sensitive keys at the logger level too.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.password',
          '*.passwordHash',
          '*.signature',
          '*.mnemonic',
          '*.MASTER_MNEMONIC',
          '*.privateKey',
        ],
        censor: '[REDACTED]',
      },
    },
    trustProxy: true,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl
      if (CORS_ORIGINS.includes(origin) || origin.endsWith('.krakenleague.xyz')) {
        return cb(null, true);
      }
      return cb(new Error('CORS not allowed: ' + origin), false);
    },
    credentials: true,
  });

  await app.register(rateLimit, {
    global: false, // opt-in per route
    max: 300,
    timeWindow: '1 minute',
  });

  await app.register(jwt, { secret: JWT_SECRET });
  await app.register(websocket);

  app.get('/health', async () => ({
    ok: true,
    ts: new Date().toISOString(),
    version: '0.1.0',
  }));

  // Per-route rate limit on /auth/*
  app.register(async (instance) => {
    instance.addHook('onRoute', (routeOpts) => {
      if (routeOpts.url.startsWith('/auth/')) {
        routeOpts.config = routeOpts.config ?? {};
        (routeOpts.config as { rateLimit?: unknown }).rateLimit = { max: 10, timeWindow: '1 minute' };
      }
    });
    await registerAuthRoutes(instance);
  });

  await registerWalletRoutes(app);
  await registerStrategyRoutes(app);
  await registerAllocationRoutes(app);
  await registerPortfolioRoutes(app);
  await registerLeagueRoutes(app);
  await registerTradeRoutes(app);
  await registerWsRoutes(app);
  await registerAdminRoutes(app);

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`🐙 Kraken League API listening on http://${HOST}:${PORT}`);
    // Start background workers only after server is up
    startDepositListener();
    startMarketDataPoller();
    if (process.env.STRATEGY_RUNNER_ENABLED !== 'false') {
      startStrategyRunner();
    }
    if (process.env.EXECUTOR_ENABLED !== 'false') {
      startExecutor();
    }
    if (process.env.PNL_TRACKER_ENABLED !== 'false') {
      startPnlTracker();
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
