'use client';

import { useAccount, useBalance, useReadContract, useWriteContract } from 'wagmi';
import type { Abi } from 'viem';
import { useTranslations } from 'next-intl';
import { toast } from 'react-hot-toast';
import { appChainId } from '@/config/chain';
import { CONTRACTS, ARBITER_REGISTRY_ABI, REPUTATION_ABI, DIAMOND_ABI } from '@/config/contracts';
import { useProfile } from '@/hooks/useProfile';
import { shortAddr } from '@/lib/utils';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Single source of truth for the account/profile/contract reads that both the
 * mobile and desktop WalletMenu instances (and Header's own nav) need. Header
 * calls this once and passes the result down as props — calling it separately
 * inside each WalletMenu instance would still resolve to one network request
 * per query (react-query dedupes by queryKey), but it'd mean two live
 * observers, two re-renders, and duplicate derived-state math for every
 * balance/XP/role read, on every page, for as long as the wallet is connected.
 */
export function useWalletAccountData() {
  const t = useTranslations();
  const { address, isConnected, status, chain } = useAccount();
  const isWrongChain = isConnected && !!chain && chain.id !== appChainId;

  const { displayName, avatarUrl: profileAvatarUrl } = useProfile(address);

  const { data: isArbiterRaw } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'isRegisteredArbiter',
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: !!address },
  }) as { data: boolean | undefined };
  const isArbiter = !!isArbiterRaw;

  const { data: daoActive } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'isDaoActive',
    query: { enabled: !!address },
  }) as { data: boolean | undefined };

  const { data: onchainXP } = useReadContract({
    address: CONTRACTS.diamond,
    abi: REPUTATION_ABI as Abi,
    functionName: 'getXP',
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: !!address },
  }) as { data: bigint | undefined };

  const { data: diamondOwner } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI as Abi,
    functionName: 'owner',
    query: { enabled: !!address },
  }) as { data: string | undefined };
  const isOwner = !!address && !!diamondOwner && address.toLowerCase() === diamondOwner.toLowerCase();

  const { data: usdcBalanceData } = useBalance({
    address,
    token: CONTRACTS.usdc as `0x${string}`,
    query: { enabled: !!address },
  });
  const usdcBalance = usdcBalanceData?.value ?? BigInt(0);

  const { writeContractAsync: applyAsArbiterWrite, isPending: applyPending } = useWriteContract();
  const canApplyAsArbiter = !!daoActive && !isArbiter && !!onchainXP && onchainXP >= 3000n;

  const handleApplyAsArbiter = async () => {
    try {
      await applyAsArbiterWrite({
        address: CONTRACTS.diamond,
        abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: 'applyAsArbiter',
      });
      toast.success(t('wallet.arbiter_apply_success'));
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || t('common.error'));
    }
  };

  // Display name priority: profile > truncated address
  const displayText = displayName || (address ? shortAddr(address) : '');
  // Avatar priority: profile > effigy identicon
  const avatarUrl = profileAvatarUrl || (address ? `https://effigy.im/a/${address}.svg` : '');

  return {
    address,
    isConnected,
    status,
    chain,
    isWrongChain,
    displayText,
    avatarUrl,
    usdcBalance,
    isArbiter,
    isOwner,
    canApplyAsArbiter,
    applyPending,
    handleApplyAsArbiter,
  };
}

export type WalletAccountData = ReturnType<typeof useWalletAccountData>;
