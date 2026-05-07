import { baseSepolia, base } from 'viem/chains';
import type { Chain } from 'viem';

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 84532);

export const isMainnet = chainId === 8453;

export const appChain: Chain = isMainnet ? base : baseSepolia;

export const appChainId: number = appChain.id;

export const appRpcUrl: string =
  process.env.NEXT_PUBLIC_RPC_URL ??
  process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ??
  (isMainnet ? 'https://mainnet.base.org' : 'https://sepolia.base.org');

export function explorerUrl(
  type: 'tx' | 'address' | 'token',
  value: string
): string {
  const root = isMainnet
    ? 'https://basescan.org'
    : 'https://sepolia.basescan.org';
  return `${root}/${type}/${value}`;
}
