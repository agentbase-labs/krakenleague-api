export const CHAINS = ['ethereum', 'arbitrum', 'base', 'optimism'] as const;
export type Chain = (typeof CHAINS)[number];

export const CHAIN_IDS: Record<Chain, number> = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
  optimism: 10,
};

export const CHAIN_LABELS: Record<Chain, string> = {
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum One',
  base: 'Base',
  optimism: 'Optimism',
};

/** Canonical USDC addresses (native/bridged — per chain). */
export const USDC_ADDRESS: Record<Chain, `0x${string}`> = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // native USDC on Arbitrum
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
};

export const USDC_DECIMALS = 6;
export const ETH_DECIMALS = 18;

/** Resolve RPC URL for a chain. Prefers explicit *_RPC env var, then Alchemy template. */
export function rpcUrl(chain: Chain): string {
  const override = process.env[`${chain.toUpperCase()}_RPC`];
  if (override && override.length > 0) return override;
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) {
    // Public fallbacks (rate-limited but functional for light polling)
    const fallbacks: Record<Chain, string> = {
      ethereum: 'https://eth.llamarpc.com',
      arbitrum: 'https://arb1.arbitrum.io/rpc',
      base: 'https://mainnet.base.org',
      optimism: 'https://mainnet.optimism.io',
    };
    return fallbacks[chain];
  }
  const alchemy: Record<Chain, string> = {
    ethereum: `https://eth-mainnet.g.alchemy.com/v2/${key}`,
    arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${key}`,
    base: `https://base-mainnet.g.alchemy.com/v2/${key}`,
    optimism: `https://opt-mainnet.g.alchemy.com/v2/${key}`,
  };
  return alchemy[chain];
}
