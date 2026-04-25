# 🐙 Kraken League — Live API

Backend service for [krakenleague.xyz](https://krakenleague.xyz). Handles:

- Email/password auth (JWT)
- Per-user HD wallet derivation (EVM) across Ethereum, Arbitrum, Base, Optimism
- Real on-chain deposit detection (Arbitrum mainnet: USDC + ETH)
- User-signed withdrawal flow (viem `verifyMessage` + server-side broadcast)
- WebSocket push for `deposit.new`, `withdrawal.confirmed`, `trades.new`, `league.update`

**Live trading is NOT enabled yet.** All 6 strategies remain in `paper` mode for this sprint.
Only deposits, balances, and withdrawals are live on Arbitrum mainnet.

## Environment

| var | description |
|---|---|
| `DATABASE_URL` | Render Postgres (auto-injected) |
| `JWT_SECRET` | JWT signing secret |
| `MASTER_MNEMONIC` | 24-word BIP-39 mnemonic for per-user HD derivation (**secret**) |
| `ALCHEMY_API_KEY` | Alchemy key for RPCs |
| `ARBITRUM_RPC` / `ETHEREUM_RPC` / `BASE_RPC` / `OPTIMISM_RPC` | override RPC URLs |
| `CORS_ORIGIN` | comma-separated allowlist, e.g. `https://krakenleague.xyz,https://krakenleague-xyz.onrender.com` |
| `PORT` | (Render injects 10000) |
| `DEPOSIT_LISTENER_ENABLED` | `true` to start Arbitrum deposit polling (default: `true` in prod) |

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET  | `/health` | — | Liveness |
| POST | `/auth/signup` | — | `{email,password}` → JWT |
| POST | `/auth/login` | — | `{email,password}` → JWT |
| GET  | `/auth/me` | JWT | Current user |
| GET  | `/wallet` | JWT | Per-chain agent wallet addresses |
| GET  | `/wallet/balance` | JWT | Live on-chain balances (Arbitrum: USDC + ETH) |
| POST | `/wallet/withdraw` | JWT | User-signed withdrawal intent |
| GET  | `/deposits` | JWT | User's deposit history |
| GET  | `/withdrawals` | JWT | User's withdrawal history |
| GET  | `/strategies` | — | All 6 strategies (all `paper`) |
| POST | `/allocations` | JWT | Set % per strategy |
| GET  | `/portfolio` | JWT | P&L, positions, trades (mock until live trading) |
| GET  | `/league` | — | Current-week leaderboard (mock until live trading) |
| GET  | `/trades/recent` | — | Trade ticker (mock until live trading) |
| WS   | `/ws` | — | Subscribe to `deposit.new.user.<id>`, `withdrawal.confirmed.user.<id>`, `trades.new`, `league.update` |

## Safety invariants

1. **No live trading.** `strategies.status='paper'` for all 6.
2. **Circuit breaker** via `system_flags.circuit_breaker_enabled` halts automated trading.
3. Private keys exist only in memory when signing a withdrawal. Never returned, never logged.
4. Master mnemonic backed up at `~/.joni/secrets/kraken-league-master-mnemonic.txt` (chmod 600) AND in Render env var `MASTER_MNEMONIC`. See `RECOVERY.md`.
5. Withdrawal throttle: max 3 attempts / hour / user.
6. Soft cap $1000 per-user balance; deposits above still credit + flag admin.
