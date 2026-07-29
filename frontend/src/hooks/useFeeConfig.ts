'use client';

import { useReadContract } from 'wagmi';
import { DIAMOND_ABI, CONTRACTS } from '@/config/contracts';

/**
 * Конфиг комиссии с контракта. Меняется редко (только владельцем), поэтому
 * читается один раз на монтирование и переиспользуется для предпросмотра.
 *
 * Для ПОДПИСИ это значение не годится — там комиссию читает lib/relay.ts
 * непосредственно перед подписанием.
 */
export function useFeeConfig() {
  const { data: feeBps, isLoading: bpsLoading } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    functionName: 'getFeeBps',
  }) as { data: bigint | undefined; isLoading: boolean };

  const { data: feeFloor, isLoading: floorLoading } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    functionName: 'getFeeFloor',
  }) as { data: bigint | undefined; isLoading: boolean };

  return { feeBps, feeFloor, isLoading: bpsLoading || floorLoading };
}
