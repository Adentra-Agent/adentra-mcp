import { createPublicClient, defineChain, fallback, http, type Chain } from 'viem';
import { arbitrum, base, mainnet } from 'viem/chains';

// Robinhood Chain (4663) — NEARL's home chain. Public RPC, no key needed.
export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

export const SUPPORTED_CHAIN_IDS = [8453, 1, 42161, 4663];

const CHAIN_MAP: Record<number, { chain: Chain; rpcs: string[] }> = {
  8453: {
    chain: base,
    rpcs: [
      process.env.RPC_URL_BASE || 'https://mainnet.base.org',
      process.env.RPC_URL_BASE_BACKUP || 'https://base-rpc.publicnode.com',
    ],
  },
  1: {
    chain: mainnet,
    rpcs: [process.env.RPC_URL_MAINNET || 'https://ethereum-rpc.publicnode.com'],
  },
  42161: {
    chain: arbitrum,
    rpcs: [process.env.RPC_URL_ARBITRUM || 'https://arb1.arbitrum.io/rpc'],
  },
  4663: {
    chain: robinhood,
    rpcs: [
      process.env.RPC_URL_ROBINHOOD || 'https://rpc.mainnet.chain.robinhood.com',
    ],
  },
};

export function getPublicClient(chainId = 8453) {
  const entry = CHAIN_MAP[chainId] || CHAIN_MAP[8453];
  return createPublicClient({
    chain: entry.chain,
    transport: fallback(entry.rpcs.map((url) => http(url, { timeout: 8000 }))),
  });
}
