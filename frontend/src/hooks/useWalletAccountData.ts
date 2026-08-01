'use client';

import { useState } from 'react';
import { useAccount, useBalance, useReadContract, useWriteContract, usePublicClient } from 'wagmi';
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
  const { address, isConnected, status, chain, chainId } = useAccount();
  // Считаем по СЫРОМУ `chainId`, а не по объекту `chain`.
  //
  // `chain` у wagmi — это `config.chains.find(c => c.id === connection.chainId)`
  // (@wagmi/core/dist/esm/actions/getAccount.js:7), а в конфиге приложения ровно
  // одна сеть (`providers.tsx`: `const chains = [appChain]`). Отсюда прежнее
  // условие `isConnected && !!chain && chain.id !== appChainId` было тождественно
  // ложным:
  //   • кошелёк в нашей сети  → chain = appChain → chain.id === appChainId → false;
  //   • кошелёк в чужой сети  → find() ничего не нашёл → chain === undefined
  //                             → `!!chain` false → тоже false.
  // То есть ровно в том случае, ради которого проверка написана, она молчала.
  //
  // Цена молчания высокая, и оно было идеально незаметным: баланс, XP и роль
  // читаются через наш собственный RPC-прокси и потому отвечают правильно даже
  // когда кошелёк стоит в чужой сети, — меню выглядело совершенно обычным.
  // Ни оранжевой точки на аватаре, ни надписи «Wrong Network», ни кнопки
  // «Switch to …» (всё это уже написано в WalletMenu и просто никогда не
  // показывалось), а любая транзакция уходила в чужую сеть по адресу, где
  // нашего кода нет.
  //
  // `chainId` в том же объекте — это `connection.chainId`, настоящий номер сети
  // кошелька, который обновляется по событию chainChanged независимо от того,
  // сконфигурирована сеть или нет. Так это уже сделано в двух других местах
  // репозитория: `app/board/client/post/page.tsx` и
  // `app/board/executor/post/page.tsx` (`chainId !== EXPECTED_CHAIN_ID`).
  //
  // Проверка на `undefined` обязательна: в статусе reconnecting адрес уже есть,
  // а номер сети может ещё не подтянуться — без неё меню моргало бы ложным
  // «Wrong Network» на каждом восстановлении сессии.
  const isWrongChain = isConnected && chainId !== undefined && chainId !== appChainId;

  const { displayName, avatarUrl: profileAvatarUrl } = useProfile(address);

  const { data: isArbiterRaw, refetch: refetchIsArbiter } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'isRegisteredArbiter',
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: !!address },
  }) as { data: boolean | undefined; refetch: () => void };
  const isArbiter = !!isArbiterRaw;

  const { data: daoActive } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'isDaoActive',
    query: { enabled: !!address },
  }) as { data: boolean | undefined };

  const { data: onchainXP, refetch: refetchXP } = useReadContract({
    address: CONTRACTS.diamond,
    abi: REPUTATION_ABI as Abi,
    functionName: 'getXP',
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: !!address },
  }) as { data: bigint | undefined; refetch: () => void };

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

  const [isApplying, setIsApplying] = useState(false);
  const publicClient = usePublicClient();
  const { writeContractAsync: applyAsArbiterWrite } = useWriteContract();
  const canApplyAsArbiter = !!daoActive && !isArbiter && !!onchainXP && onchainXP >= 3000n;

  const handleApplyAsArbiter = async () => {
    if (!publicClient) { toast.error(t('common.error')); return; }
    setIsApplying(true);
    try {
      const hash = await applyAsArbiterWrite({
        address: CONTRACTS.diamond,
        abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: 'applyAsArbiter',
      });
      // wagmi's own useWriteContract().isPending flips false as soon as the tx
      // is BROADCAST, not mined — waiting for the receipt here, then
      // explicitly refetching isRegisteredArbiter/getXP, closes the window
      // where "Become Arbiter" stayed enabled with stale pre-application
      // state and could fire a second, guaranteed-to-revert applyAsArbiter().
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain');
      toast.success(t('wallet.arbiter_apply_success'));
      refetchIsArbiter();
      refetchXP();
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || t('common.error'));
    } finally {
      setIsApplying(false);
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
    applyPending: isApplying,
    handleApplyAsArbiter,
  };
}

export type WalletAccountData = ReturnType<typeof useWalletAccountData>;
