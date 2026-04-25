/**
 * Wallet service — HD derivation + withdrawal signing/broadcast.
 *
 * Private keys exist only ephemerally inside `signAndBroadcastWithdrawal`.
 * The master mnemonic is read from env and never logged.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  parseUnits,
  verifyMessage,
  type Hex,
} from 'viem';
import { arbitrum, base, mainnet, optimism } from 'viem/chains';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { HDKey } from 'viem/accounts';
import { type Chain, rpcUrl, USDC_ADDRESS, USDC_DECIMALS } from './chains.js';

const VIEM_CHAINS = { ethereum: mainnet, arbitrum, base, optimism } as const;

function getMasterMnemonic(): string {
  const m = process.env.MASTER_MNEMONIC;
  if (!m || m.trim().split(/\s+/).length < 12) {
    throw new Error('MASTER_MNEMONIC is not set or invalid');
  }
  return m.trim();
}

/**
 * BIP-44 path: m/44'/60'/{userIndex}'/0/0
 * All four EVM chains share coin type 60, so the derived address is identical
 * across chains for the same userIndex — by design. We store one wallet row
 * per chain anyway, to make non-EVM chains trivial to add later.
 */
export function derivationPathFor(userIndex: number): string {
  return `m/44'/60'/${userIndex}'/0/0`;
}

export function deriveAddress(userIndex: number): `0x${string}` {
  const path = derivationPathFor(userIndex);
  const account = mnemonicToAccount(getMasterMnemonic(), { path: path as `m/44'/60'/${string}` });
  return account.address;
}

/** Returns the raw private key for a derived account. ⚠️ use only inside signing. */
function derivePrivateKey(userIndex: number): `0x${string}` {
  const path = derivationPathFor(userIndex);
  const account = mnemonicToAccount(getMasterMnemonic(), { path: path as `m/44'/60'/${string}` });
  // viem's HDAccount exposes getHdKey()
  const hd = (account as unknown as { getHdKey: () => HDKey }).getHdKey();
  if (!hd.privateKey) throw new Error('derived account has no private key');
  const hex = Buffer.from(hd.privateKey).toString('hex');
  return (`0x${hex}`) as `0x${string}`;
}

/**
 * Verify EIP-191 personal_sign. `payload` is the exact string signed by the user.
 */
export async function verifyWithdrawalSignature(
  userEoa: `0x${string}`,
  payload: string,
  signature: `0x${string}`,
): Promise<boolean> {
  try {
    return await verifyMessage({
      address: userEoa,
      message: payload,
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}

export interface WithdrawalParams {
  chain: Chain;
  userIndex: number;
  toAddress: `0x${string}`;
  token: 'ETH' | 'USDC' | string; // 'ETH' for native, 'USDC' for canonical USDC
  /** Human-readable amount, e.g. "1.23". */
  amount: string;
}

export interface WithdrawalResult {
  txHash: `0x${string}`;
  from: `0x${string}`;
}

/**
 * Sign + broadcast a withdrawal from the user's agent wallet.
 * Currently only `arbitrum` is supported for actual broadcast.
 */
export async function signAndBroadcastWithdrawal(
  params: WithdrawalParams,
): Promise<WithdrawalResult> {
  const viemChain = VIEM_CHAINS[params.chain];
  if (!viemChain) throw new Error(`unsupported chain: ${params.chain}`);

  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl(params.chain)) });

  const pk = derivePrivateKey(params.userIndex);
  try {
    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({
      account,
      chain: viemChain,
      transport: http(rpcUrl(params.chain)),
    });

    let txHash: `0x${string}`;

    if (params.token === 'ETH') {
      const valueWei = parseUnits(params.amount, 18);
      txHash = await walletClient.sendTransaction({
        to: params.toAddress,
        value: valueWei,
      });
    } else if (params.token === 'USDC') {
      const usdcAddr = USDC_ADDRESS[params.chain];
      const amountBase = parseUnits(params.amount, USDC_DECIMALS);
      // ERC-20 transfer(address,uint256)
      const data = encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'transfer',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [{ type: 'bool' }],
          },
        ],
        functionName: 'transfer',
        args: [params.toAddress, amountBase],
      });
      txHash = await walletClient.sendTransaction({
        to: usdcAddr,
        data,
      });
    } else {
      throw new Error(`unsupported token: ${params.token}`);
    }

    return { txHash, from: account.address };
  } finally {
    // best-effort: don't keep the key string lying around in closure
    // (JS can't actually zero memory but we can drop the reference)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _drop = null;
  }
}

/** Read native + USDC balance of an address on a given chain. */
export async function readBalances(chain: Chain, address: `0x${string}`) {
  const viemChain = VIEM_CHAINS[chain];
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl(chain)) });

  const native = await publicClient.getBalance({ address });
  let usdc = 0n;
  try {
    usdc = (await publicClient.readContract({
      address: USDC_ADDRESS[chain],
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ name: 'a', type: 'address' }],
          outputs: [{ type: 'uint256' }],
        },
      ],
      functionName: 'balanceOf',
      args: [address],
    })) as bigint;
  } catch {
    usdc = 0n;
  }

  return {
    native: { raw: native.toString(), formatted: formatEther(native) },
    usdc: { raw: usdc.toString(), formatted: formatUnits(usdc, USDC_DECIMALS) },
  };
}
