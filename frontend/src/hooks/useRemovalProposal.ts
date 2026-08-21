'use client';

import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { ARBITER_ACCOUNTABILITY_ABI, CONTRACTS } from '@/config/contracts';
import type { RemovalProposalRecord } from '@/lib/arbiterRemovalFlow';

/**
 * Обвинение, стоящее против одного арбитра, — целиком и одним чтением.
 *
 * ⚠️ ЧИТАЕТСЯ `getRemovalProposal`, А НЕ `hasLiveProposal`, хотя у карточки
 * положения признак «живо» уже есть. Признака мало: чтобы ПОКАЗАТЬ обвинение,
 * нужны повод, отпечаток, момент и автор, а чтобы выбрать дверь исполнения —
 * автор особенно (`by == 0` означает обвинение самой цепи, и оно исполняется
 * `executeChainRemoval`, а не общей дверью). Пятое поле `live` тот же вызов
 * отдаёт заодно — это ВЫЗОВ `hasLiveProposal` внутри контракта, а не вторая
 * формула, так что разойтись с ним нельзя структурно.
 *
 * ⚠️ ЗАПИСЬ ЧИТАЕТСЯ И ПРОТУХШАЯ. `getRemovalProposal` отдаёт архивную запись,
 * пока её не перезаписали новой, — и это нужно: обвинение, которое просрочили,
 * обязано читаться как «было и протухло», а не исчезать, будто его не бывало.
 */
export interface RemovalProposalRead {
  /** `null` — ещё не знаем (или спрашивать некого). */
  record: RemovalProposalRecord | null;
  isLoading: boolean;
  refetch: () => void;
}

export function useRemovalProposal(
  arbiter: Address | undefined,
  enabled = true,
): RemovalProposalRead {
  const ask = enabled && !!arbiter;

  const read = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_ACCOUNTABILITY_ABI,
    functionName: 'getRemovalProposal',
    args: [arbiter as Address],
    query: { enabled: ask },
  }) as {
    data: readonly [number, `0x${string}`, bigint, Address, boolean] | undefined;
    isLoading: boolean;
    refetch: () => void;
  };

  const t = read.data;
  return {
    // Поля разбираются ПО МЕСТУ и названы именами возвратов ABI: пять значений
    // приезжают кортежем, и `cause`/`live` — единственная пара, которую типы
    // различают. Перепутать `proposedAt` с чем-нибудь ещё нечем, а вот `by`
    // взять не оттуда — как раз можно, и тогда обвинение цепи стало бы
    // человеческим.
    record: t
      ? { cause: Number(t[0]), evidenceDigest: t[1], proposedAt: Number(t[2]), by: t[3], live: t[4] }
      : null,
    isLoading: read.isLoading,
    refetch: read.refetch,
  };
}
