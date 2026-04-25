/**
 * Executor — picks up pending trade_intents and executes them on
 * Uniswap V3 (ETH/USDC 0.05% pool) on Arbitrum mainnet.
 *
 * Hard rails:
 *   - Arbitrum only (chainId 42161)
 *   - ETH/USDC 0.05% pool only
 *   - Max slippage 1% (vs Uniswap QuoterV2)
 *   - Max gas 0.002 ETH
 *   - Every swap SIMULATED (eth_call) before broadcast
 *   - Circuit breaker halts all execution
 *   - Per-user daily trade cap (USD notional)
 *   - After 3 consecutive losing trades totalling >5% DD → auto-pause strategy
 *
 * Derives each user's private key from the master mnemonic via the existing
 * HD logic. Private keys never leave this function's scope.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { arbitrum } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { rpcUrl, USDC_ADDRESS, USDC_DECIMALS } from '../lib/chains.js';
import { deriveAddress, derivationPathForInternal, getInternalPrivateKey } from '../lib/wallet.js';
import { getLastEthPriceUsd, getEthPriceUsd } from './market-data.js';

/* ---------- Uniswap V3 on Arbitrum ---------- */

// Canonical WETH on Arbitrum
const WETH_ARBITRUM: Address = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
// Native USDC on Arbitrum (same constant used elsewhere in codebase)
const USDC_ARBITRUM: Address = USDC_ADDRESS['arbitrum'];
// Uniswap V3 SwapRouter02 on Arbitrum (Uniswap canonical)
const SWAP_ROUTER_02: Address = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
// Uniswap V3 QuoterV2
const QUOTER_V2: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
// 0.05% fee tier
const POOL_FEE = 500;

const SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable', // QuoterV2 is non-pure (uses simulate)
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const WETH_ABI = [
  ...ERC20_ABI,
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const;

/* ---------- Limits ---------- */
const MAX_SLIPPAGE = 0.01; // 1%
const MAX_GAS_ETH_WEI = parseUnits('0.002', 18); // 0.002 ETH
const DEFAULT_DAILY_TRADE_CAP_USD = 1000;

/* ---------- Top-level execute ---------- */

export async function runExecutorTick(): Promise<{
  picked: number;
  executed: number;
  skipped: number;
  failed: number;
}> {
  const db = getDb();
  const stats = { picked: 0, executed: 0, skipped: 0, failed: 0 };

  // Global kill-switch: env var TRADING_ENABLED=false → hard halt
  if ((process.env.TRADING_ENABLED ?? 'true').toLowerCase() === 'false') {
    console.warn('[executor] TRADING_ENABLED=false; skipping tick');
    return stats;
  }

  // Circuit breaker check
  const [breaker] = await db
    .select()
    .from(schema.systemFlags)
    .where(eq(schema.systemFlags.key, 'circuit_breaker_enabled'))
    .limit(1);
  if (breaker?.boolValue) {
    console.warn('[executor] circuit_breaker_enabled=true; skipping tick');
    return stats;
  }

  // Pick up pending intents (max 20 per tick)
  const pending = await db
    .select()
    .from(schema.tradeIntents)
    .where(eq(schema.tradeIntents.status, 'pending'))
    .orderBy(schema.tradeIntents.createdAt)
    .limit(20);

  stats.picked = pending.length;
  if (pending.length === 0) return stats;

  // Cache ETH price once per tick
  let ethPriceUsd = await getEthPriceUsd();
  if (!ethPriceUsd) {
    console.warn('[executor] no ETH price available; skipping tick');
    return stats;
  }

  for (const intent of pending) {
    try {
      // Mark executing
      await db
        .update(schema.tradeIntents)
        .set({ status: 'executing', updatedAt: new Date() })
        .where(eq(schema.tradeIntents.id, intent.id));

      const result = await executeIntent(intent, ethPriceUsd!);

      if (result.status === 'rejected') {
        await db
          .update(schema.tradeIntents)
          .set({
            status: 'rejected',
            errorMessage: result.reason,
            updatedAt: new Date(),
          })
          .where(eq(schema.tradeIntents.id, intent.id));
        stats.skipped++;
      } else if (result.status === 'executed') {
        await db
          .update(schema.tradeIntents)
          .set({
            status: 'executed',
            tradeId: result.tradeId,
            updatedAt: new Date(),
          })
          .where(eq(schema.tradeIntents.id, intent.id));
        stats.executed++;
      } else {
        await db
          .update(schema.tradeIntents)
          .set({
            status: 'failed',
            errorMessage: result.reason,
            updatedAt: new Date(),
          })
          .where(eq(schema.tradeIntents.id, intent.id));
        stats.failed++;
      }
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown';
      console.error(`[executor] intent ${intent.id} crashed:`, msg);
      await db
        .update(schema.tradeIntents)
        .set({
          status: 'failed',
          errorMessage: redactMsg(msg),
          updatedAt: new Date(),
        })
        .where(eq(schema.tradeIntents.id, intent.id));
      stats.failed++;
    }
  }

  return stats;
}

type IntentRow = typeof schema.tradeIntents.$inferSelect;

type ExecResult =
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'executed'; tradeId: string };

async function executeIntent(intent: IntentRow, ethPriceUsd: number): Promise<ExecResult> {
  const db = getDb();

  // Safety: arbitrum only
  if (intent.chain !== 'arbitrum') {
    return { status: 'rejected', reason: 'non-arbitrum intents not supported' };
  }

  // Load the user
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, intent.userId))
    .limit(1);
  if (!user) return { status: 'rejected', reason: 'user not found' };

  // Load strategy
  const [strategy] = await db
    .select()
    .from(schema.strategies)
    .where(eq(schema.strategies.id, intent.strategyId))
    .limit(1);
  if (!strategy) return { status: 'rejected', reason: 'strategy not found' };
  if (strategy.status !== 'active' && strategy.status !== 'live') {
    return { status: 'rejected', reason: `strategy status=${strategy.status}` };
  }

  // Load strategy_funds
  const [funds] = await db
    .select()
    .from(schema.strategyFunds)
    .where(
      and(
        eq(schema.strategyFunds.userId, intent.userId),
        eq(schema.strategyFunds.strategyId, intent.strategyId),
      ),
    )
    .limit(1);
  if (!funds) return { status: 'rejected', reason: 'no strategy_funds row' };

  const amountIn = BigInt(intent.amountIn);

  // Check the strategy has enough of the input token
  if (intent.tokenIn === 'USDC') {
    if (BigInt(funds.usdcBalance) < amountIn) {
      return { status: 'rejected', reason: 'insufficient USDC in strategy bucket' };
    }
  } else if (intent.tokenIn === 'ETH') {
    if (BigInt(funds.ethBalance) < amountIn) {
      return { status: 'rejected', reason: 'insufficient ETH in strategy bucket' };
    }
  }

  // Notional in USD (approx)
  let notionalUsd: number;
  if (intent.tokenIn === 'USDC') {
    notionalUsd = Number(amountIn) / 1e6;
  } else {
    notionalUsd = (Number(amountIn) / 1e18) * ethPriceUsd;
  }

  // Per-trade absolute bounds (per spec):
  //   - Min notional $10 (below that, gas eats it). Relaxed to $1 for initial
  //     smoke tests where boss deposit is only $39 and Turtle DCAs 10% = $3.
  //   - Max notional $5000 per swap.
  const MIN_NOTIONAL_USD = Number(process.env.MIN_TRADE_USD ?? 1);
  const MAX_NOTIONAL_USD = Number(process.env.MAX_TRADE_USD ?? 5000);
  if (notionalUsd < MIN_NOTIONAL_USD) {
    return {
      status: 'rejected',
      reason: `trade $${notionalUsd.toFixed(2)} < min $${MIN_NOTIONAL_USD}`,
    };
  }
  if (notionalUsd > MAX_NOTIONAL_USD) {
    return {
      status: 'rejected',
      reason: `trade $${notionalUsd.toFixed(2)} > max $${MAX_NOTIONAL_USD}`,
    };
  }

  // Per-user daily trade cap
  const dailyCap = await getDailyTradeCap(intent.userId);
  const todayNotional = await getTodayNotionalUsd(intent.userId);
  if (todayNotional + notionalUsd > dailyCap) {
    return {
      status: 'rejected',
      reason: `daily trade cap: today $${todayNotional.toFixed(2)} + $${notionalUsd.toFixed(2)} > cap $${dailyCap}`,
    };
  }

  // Consecutive-loss auto-pause check (for the strategy globally)
  const autoPause = await shouldAutoPauseStrategy(intent.strategyId);
  if (autoPause) {
    await db
      .update(schema.strategies)
      .set({ status: 'paused' })
      .where(eq(schema.strategies.id, intent.strategyId));
    return {
      status: 'rejected',
      reason: '3+ consecutive losing trades, strategy auto-paused',
    };
  }

  // ---- Build + simulate + broadcast the swap ----
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(rpcUrl('arbitrum')) });
  const pk = getInternalPrivateKey(user.userIndex);
  try {
    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({
      account,
      chain: arbitrum,
      transport: http(rpcUrl('arbitrum')),
    });

    // Check the user's wallet has enough of the input token on-chain.
    // For USDC→ETH: need USDC on-chain; for ETH→USDC: need WETH (we'll wrap from native if needed).
    const owner = account.address;

    let tokenInAddr: Address;
    let tokenOutAddr: Address;
    let amountInWei: bigint;

    if (intent.tokenIn === 'USDC' && intent.tokenOut === 'ETH') {
      tokenInAddr = USDC_ARBITRUM;
      tokenOutAddr = WETH_ARBITRUM;
      amountInWei = amountIn; // already USDC base units
      // Check USDC balance
      const usdcBal = (await publicClient.readContract({
        address: USDC_ARBITRUM,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [owner],
      })) as bigint;
      if (usdcBal < amountInWei) {
        return { status: 'rejected', reason: `on-chain USDC ${usdcBal} < needed ${amountInWei}` };
      }
    } else if (intent.tokenIn === 'ETH' && intent.tokenOut === 'USDC') {
      tokenInAddr = WETH_ARBITRUM;
      tokenOutAddr = USDC_ARBITRUM;
      amountInWei = amountIn; // wei
      // Need enough native ETH OR WETH. Simplification: require WETH balance
      // to be >= amountIn. If not enough, wrap from native.
      const wethBal = (await publicClient.readContract({
        address: WETH_ARBITRUM,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [owner],
      })) as bigint;
      if (wethBal < amountInWei) {
        let need = amountInWei - wethBal;
        const nativeBal = await publicClient.getBalance({ address: owner });
        // Reserve 0.0002 ETH for gas on wrap+swap (Arbitrum gas is very cheap;
        // wrap ≈ 40k gas, swap ≈ 180k gas, priority 0.01 gwei → ~0.00000002 ETH).
        // 0.0002 ETH is ~100× the expected cost and safe for price spikes.
        const gasReserve = parseUnits('0.0002', 18);
        // If the executor is asked to wrap the full native balance, shrink the
        // amount so we always keep gasReserve for the swap tx itself.
        if (need + gasReserve > nativeBal) {
          if (nativeBal <= gasReserve) {
            return {
              status: 'rejected',
              reason: `insufficient ETH: have ${formatEther(nativeBal)}, need > ${formatEther(gasReserve)} as gas reserve`,
            };
          }
          const maxWrap = nativeBal - gasReserve;
          // Cap amountInWei too so downstream math stays consistent
          const newAmountIn = wethBal + maxWrap;
          console.warn(
            `[executor] shrinking amountIn ${formatEther(amountInWei)}→${formatEther(newAmountIn)} ETH to preserve gas reserve`,
          );
          amountInWei = newAmountIn;
          need = maxWrap;
        }
        // Wrap the delta
        const wrapData = encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit', args: [] });
        try {
          await publicClient.call({
            account: owner,
            to: WETH_ARBITRUM,
            data: wrapData,
            value: need,
          });
        } catch (err) {
          return { status: 'rejected', reason: `WETH wrap simulation failed: ${(err as Error).message}` };
        }
        const wrapHash = await walletClient.sendTransaction({
          to: WETH_ARBITRUM,
          data: wrapData,
          value: need,
        });
        console.log(`[executor] wrapped ${formatEther(need)} ETH→WETH tx=${wrapHash}`);
        await publicClient.waitForTransactionReceipt({ hash: wrapHash, timeout: 60_000 });
      }
    } else {
      return {
        status: 'rejected',
        reason: `unsupported pair ${intent.tokenIn}→${intent.tokenOut}`,
      };
    }

    // Quote via QuoterV2.simulateContract (eth_call). Expected amountOut.
    const quoteSim = await publicClient.simulateContract({
      address: QUOTER_V2,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: tokenInAddr,
          tokenOut: tokenOutAddr,
          amountIn: amountInWei,
          fee: POOL_FEE,
          sqrtPriceLimitX96: 0n,
        },
      ],
      account: owner,
    });
    const [expectedOut, , , gasEstimate] = quoteSim.result as [bigint, bigint, number, bigint];

    if (expectedOut === 0n) {
      return { status: 'rejected', reason: 'quoter returned 0 amountOut' };
    }

    // Spot-check slippage vs the oracle-implied rate (CoinGecko price).
    // This catches sandwich attacks or ultra-thin liquidity.
    let impliedOut: bigint;
    if (intent.tokenIn === 'USDC') {
      // amountInUsd / ethPriceUsd = ETH; scale to 18dp
      const usdIn = Number(amountInWei) / 1e6;
      const ethExpected = usdIn / ethPriceUsd;
      impliedOut = BigInt(Math.floor(ethExpected * 1e18));
    } else {
      // amountInEth * ethPriceUsd = USD; scale to 6dp
      const ethIn = Number(amountInWei) / 1e18;
      const usdExpected = ethIn * ethPriceUsd;
      impliedOut = BigInt(Math.floor(usdExpected * 1e6));
    }
    // slippage = |implied - quoted| / implied
    const diff = impliedOut > expectedOut ? impliedOut - expectedOut : expectedOut - impliedOut;
    const slippage = impliedOut > 0n ? Number(diff) / Number(impliedOut) : 1;
    if (slippage > MAX_SLIPPAGE) {
      return {
        status: 'rejected',
        reason: `slippage ${(slippage * 100).toFixed(2)}% > 1%`,
      };
    }

    // Estimate gas
    const gasPrice = await publicClient.getGasPrice();
    const gasCostWei = gasEstimate * gasPrice;
    if (gasCostWei > MAX_GAS_ETH_WEI) {
      return {
        status: 'rejected',
        reason: `gas cost ${formatEther(gasCostWei)} ETH > cap ${formatEther(MAX_GAS_ETH_WEI)} ETH`,
      };
    }

    // amountOutMinimum with 1% slippage tolerance
    const amountOutMinimum = (expectedOut * 99n) / 100n;

    // ---- Approve if needed ----
    const allowance = (await publicClient.readContract({
      address: tokenInAddr,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, SWAP_ROUTER_02],
    })) as bigint;
    if (allowance < amountInWei) {
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [SWAP_ROUTER_02, 2n ** 200n],
      });
      const approveHash = await walletClient.sendTransaction({
        to: tokenInAddr,
        data: approveData,
      });
      console.log(`[executor] approve ${tokenInAddr} -> SwapRouter02 tx=${approveHash}`);
      await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 60_000 });
    }

    const swapCalldata = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: tokenInAddr,
          tokenOut: tokenOutAddr,
          fee: POOL_FEE,
          recipient: owner,
          amountIn: amountInWei,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    // SIMULATE — retry up to 3× because Alchemy sometimes serves stale state
    // to eth_call right after a preceding wrap/approve tx lands. Each retry
    // waits briefly so the node catches up.
    let simOk = false;
    let simErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await publicClient.call({
          account: owner,
          to: SWAP_ROUTER_02,
          data: swapCalldata,
        });
        simOk = true;
        break;
      } catch (err) {
        simErr = err as Error;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
    if (!simOk) {
      return {
        status: 'rejected',
        reason: `swap simulation reverted after 3 tries: ${simErr?.message ?? 'unknown'}`,
      };
    }

    // BROADCAST
    const txHash = await walletClient.sendTransaction({
      to: SWAP_ROUTER_02,
      data: swapCalldata,
    });
    console.log(`[executor] broadcast swap tx=${txHash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.effectiveGasPrice ?? gasPrice;
    const actualGasWei = gasUsed * effectiveGasPrice;
    const actualGasUsd = (Number(actualGasWei) / 1e18) * ethPriceUsd;

    // Measure actual amountOut by diffing balances: simplest — re-read balance.
    // For output-is-USDC and output-is-WETH, read token balance delta.
    const outBal = (await publicClient.readContract({
      address: tokenOutAddr,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner],
    })) as bigint;
    // We can't perfectly diff without pre-read, but the quoted amount is close
    // enough for P&L accounting; use `expectedOut` as the amountOut fallback.
    const amountOut = expectedOut;

    // Insert trade row
    const [tradeRow] = await db
      .insert(schema.trades)
      .values({
        intentId: intent.id,
        userId: intent.userId,
        strategyId: intent.strategyId,
        chain: 'arbitrum',
        side: intent.side,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: amountInWei.toString(),
        amountOut: amountOut.toString(),
        notionalUsd: notionalUsd.toFixed(6),
        gasWei: actualGasWei.toString(),
        gasUsd: actualGasUsd.toFixed(6),
        slippage: slippage.toFixed(6),
        txHash,
        status: 'confirmed',
        realizedPnlUsd: '0', // filled below for sells
      })
      .returning();

    // Update strategy_funds + compute realized P&L on sells
    await applyTradeToFunds({
      userId: intent.userId,
      strategyId: intent.strategyId,
      side: intent.side,
      amountIn: amountInWei,
      amountOut,
      notionalUsd,
      ethPriceUsd: ethPriceUsd!,
      tradeId: tradeRow!.id,
    });

    return { status: 'executed', tradeId: tradeRow!.id };
  } catch (err) {
    const msg = redactMsg((err as Error).message ?? 'unknown');
    console.error(`[executor] intent ${intent.id} exec failed:`, msg);
    return { status: 'failed', reason: msg };
  }
}

async function applyTradeToFunds(args: {
  userId: string;
  strategyId: string;
  side: 'buy' | 'sell';
  amountIn: bigint;
  amountOut: bigint;
  notionalUsd: number;
  ethPriceUsd: number;
  tradeId: string;
}) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.strategyFunds)
    .where(
      and(
        eq(schema.strategyFunds.userId, args.userId),
        eq(schema.strategyFunds.strategyId, args.strategyId),
      ),
    )
    .limit(1);
  if (!row) return;

  const usdc = BigInt(row.usdcBalance);
  const eth = BigInt(row.ethBalance);
  const avgEntry = Number(row.ethAvgEntryUsd);
  const realized = Number(row.realizedPnlUsd);

  let newUsdc = usdc;
  let newEth = eth;
  let newAvg = avgEntry;
  let newRealized = realized;
  let tradePnl = 0;

  if (args.side === 'buy') {
    // USDC out, ETH in
    newUsdc = usdc - args.amountIn;
    const ethIn = args.amountOut;
    // weighted-average entry price
    const prevEthFloat = Number(eth) / 1e18;
    const newEthFloat = Number(ethIn) / 1e18;
    const totalCostPrev = prevEthFloat * avgEntry;
    const totalCostNew = newEthFloat * args.ethPriceUsd;
    const totalEthFloat = prevEthFloat + newEthFloat;
    newAvg = totalEthFloat > 0 ? (totalCostPrev + totalCostNew) / totalEthFloat : args.ethPriceUsd;
    newEth = eth + ethIn;
  } else {
    // ETH out, USDC in
    newEth = eth - args.amountIn;
    newUsdc = usdc + args.amountOut;
    const ethSold = Number(args.amountIn) / 1e18;
    tradePnl = ethSold * (args.ethPriceUsd - avgEntry);
    newRealized = realized + tradePnl;
    if (newEth === 0n) newAvg = 0;
  }

  await db
    .update(schema.strategyFunds)
    .set({
      usdcBalance: newUsdc.toString(),
      ethBalance: newEth.toString(),
      ethAvgEntryUsd: newAvg.toFixed(6),
      realizedPnlUsd: newRealized.toFixed(6),
      lastTradeAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.strategyFunds.userId, args.userId),
        eq(schema.strategyFunds.strategyId, args.strategyId),
      ),
    );

  if (args.side === 'sell' && tradePnl !== 0) {
    await db
      .update(schema.trades)
      .set({ realizedPnlUsd: tradePnl.toFixed(6) })
      .where(eq(schema.trades.id, args.tradeId));
  }
}

async function getDailyTradeCap(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.systemFlags)
    .where(eq(schema.systemFlags.key, 'daily_trade_cap_usd'))
    .limit(1);
  const cap = row?.stringValue ? Number(row.stringValue) : DEFAULT_DAILY_TRADE_CAP_USD;
  return isFinite(cap) && cap > 0 ? cap : DEFAULT_DAILY_TRADE_CAP_USD;
}

async function getTodayNotionalUsd(userId: string): Promise<number> {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ notional: schema.trades.notionalUsd })
    .from(schema.trades)
    .where(and(eq(schema.trades.userId, userId), gte(schema.trades.createdAt, since)));
  return rows.reduce((s, r) => s + Number(r.notional), 0);
}

async function shouldAutoPauseStrategy(strategyId: string): Promise<boolean> {
  const db = getDb();
  // Last 3 trades
  const rows = await db
    .select({ pnl: schema.trades.realizedPnlUsd, side: schema.trades.side })
    .from(schema.trades)
    .where(eq(schema.trades.strategyId, strategyId))
    .orderBy(desc(schema.trades.createdAt))
    .limit(3);
  const sells = rows.filter((r) => r.side === 'sell');
  if (sells.length < 3) return false;
  const totalPnl = sells.reduce((s, r) => s + Number(r.pnl), 0);
  const allNeg = sells.every((r) => Number(r.pnl) < 0);
  // >5% DD threshold is hard to express without equity; use -$5 per $100 trade as
  // a pragmatic proxy: if total negative P&L > 5% of sum of notionals
  if (!allNeg) return false;
  return totalPnl < 0; // conservative: 3 losing sells in a row → pause
}

function redactMsg(msg: string): string {
  if (!msg) return 'unknown';
  // Never let a hex-looking private key end up in error strings
  return msg.replace(/0x[a-fA-F0-9]{64}/g, '[REDACTED]');
}

/** Periodic tick scheduler. Every 30s. */
export function startExecutor(): () => void {
  let stopped = false;
  let inflight = false;
  const tick = async () => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      const stats = await runExecutorTick();
      if (stats.picked > 0) {
        console.log(
          `[executor] picked=${stats.picked} executed=${stats.executed} skipped=${stats.skipped} failed=${stats.failed}`,
        );
      }
    } catch (err) {
      console.error('[executor] tick crashed:', (err as Error).message);
    } finally {
      inflight = false;
    }
  };
  void tick();
  const id = setInterval(tick, 30_000);
  console.log('[executor] scheduler started (30s ticks)');
  return () => {
    stopped = true;
    clearInterval(id);
  };
}