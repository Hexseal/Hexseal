'use client';

import { useCallback, useEffect, useState } from 'react';
import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { AGREEMENT_ABI, ARBITER_REGISTRY_ABI, CONTRACTS } from '@/config/contracts';
import { useNoResponseFloor } from '@/hooks/useNoResponseFloor';
import { releaseAdvice, type NoResponseFacts } from '@/lib/arbiterNoResponse';

/**
 * Всё, что цепь знает про запись «просил переписку, ответа не было» по ОДНОМУ
 * спору, — и ничего сверх этого.
 *
 * ⚠️ ЧИТАЕТСЯ ИМЕННО `disputeClaims` (`getDisputeClaimer`), а не «кто ведёт спор»
 * в понимании стороны. `disputeArbiterOf` (`lib/disputeArbiter.ts`) отвечает на
 * другой вопрос — «кому предъявлять» — и намеренно падает на арбитра поданного
 * вердикта, когда клеймо уже снято. `recordNoResponse` сверяет ровно
 * `disputeClaims`, поэтому второй источник показал бы кнопку тому, кого контракт
 * отвергнет `NotClaimingArbiter`. Один вопрос — один хозяин.
 *
 * ⚠️ ПОЛ НЕ ЧИТАЕТСЯ ЗДЕСЬ ВТОРОЙ РАЗ: он приезжает из `useNoResponseFloor`,
 * который его у цепи и спрашивает. Своей копии числа нет ни здесь, ни в
 * компоненте — хозяин один, контракт.
 *
 * ⚠️ ТРИ ЛИШНИХ ЧТЕНИЯ — ТОЛЬКО ПРИ НУЛЕВОМ ВРЕМЕНИ ВЗЯТИЯ. Они нужны ровно
 * одному состоянию — спору, взятому ДО разреза 4в-2, — и только затем, чтобы
 * совет «отпустите спор и возьмите заново» не обещал выхода, которого нет.
 * Таких споров на 14 августа ровно один, и платить за них тремя `eth_call` на
 * каждую карточку было бы платой всех за случай одного.
 *
 * ⚠️ `enabled` — НЕ УДОБСТВО, А ЦЕНА (ревью Задачи 8, круг 1). Карточки ящика
 * ставятся на ВСЮ историю арбитра (`getArbiterDeals` — все дела, что он когда-
 * либо брал), а не на открытые споры. Без гейта арбитр с сотней разобранных дел
 * платил бы тремя чтениями цепи за каждое — и на каждом читал бы «спор ведёт
 * другой» про спор, кончившийся месяц назад. Гейт при этом ничего не прячет:
 * `Agreement` зовёт `clearDisputeClaim` при выходе из спора, значит вне статуса
 * DISPUTED клеймо нулевое и `recordNoResponse` ответил бы `NotClaimingArbiter`
 * в любом случае.
 *
 * ⚠️ ПОЛ ГЕЙТОМ НЕ ЗАКРЫТ, и это осознанно: у `getNoResponseFloor` нет
 * аргументов, ключ запроса у всех карточек ОДИН, и React Query сводит их к
 * одному обращению на страницу независимо от числа дел.
 */

/** Как часто пересчитываются часы. Обратный отсчёт до пола идёт минутами, и
 *  чаще шевелить экран не за чем; реже — и кнопка появится не сама, а по
 *  перезагрузке страницы. */
export const NO_RESPONSE_TICK_MS = 30_000;

export interface NoResponseRecord {
  facts: NoResponseFacts;
  /** Перечитать цепь. Зовётся ПОСЛЕ попытки записи — в том числе неудачной:
   *  отказ `NoResponseAlreadyRecorded` означает, что наше чтение устарело, и
   *  экран обязан догнать цепь, а не остаться с прежней кнопкой. */
  refetch: () => void;
}

export function useNoResponseRecord(
  agreement: Address, me: Address | undefined, enabled: boolean,
): NoResponseRecord {
  const diamond = { address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI, args: [agreement] } as const;

  const { data: claimer, refetch: refetchClaimer } = useReadContract({
    ...diamond, functionName: 'getDisputeClaimer', query: { enabled },
  }) as { data: string | undefined; refetch: () => void };

  const { data: claimedAt, refetch: refetchClaimedAt } = useReadContract({
    ...diamond, functionName: 'getDisputeClaimedAt', query: { enabled },
  }) as { data: bigint | undefined; refetch: () => void };

  const { data: recordedAt, refetch: refetchRecordedAt } = useReadContract({
    ...diamond, functionName: 'getNoResponseAt', query: { enabled },
  }) as { data: bigint | undefined; refetch: () => void };

  const { floorSeconds } = useNoResponseFloor();

  const mine = typeof claimer === 'string' && !!me
    && claimer.toLowerCase() === me.toLowerCase();
  /** Спор взят до разреза: только здесь нужен совет про отпускание. */
  const legacyClaim = enabled && mine && claimedAt === BigInt(0);

  // ⚠️ Окно берётся у САМОЙ СДЕЛКИ, а не из `config/constants`: клоны EIP-1167
  // прибиты к своей реализации намертво, и у старого клона `DISPUTE_WINDOW`
  // может быть прежней (она уже менялась с 7 суток на 4). Тот же довод, что у
  // `disputeSpan` в `lib/arbiterTurn.ts` и у страницы сделки.
  const { data: disputedAt } = useReadContract({
    address: agreement, abi: AGREEMENT_ABI, functionName: 'disputedAt',
    query: { enabled: legacyClaim },
  }) as { data: bigint | undefined };

  const { data: disputeWindow } = useReadContract({
    address: agreement, abi: AGREEMENT_ABI, functionName: 'DISPUTE_WINDOW',
    query: { enabled: legacyClaim },
  }) as { data: bigint | undefined };

  const { data: pendingVerdict } = useReadContract({
    ...diamond, functionName: 'getPendingVerdict',
    query: { enabled: legacyClaim },
  }) as { data: { submittedAt: bigint } | undefined };

  // Часы отдельным состоянием: без них обратный отсчёт замирает, кнопка не
  // появляется сама, и человек узнаёт о готовности перезагрузкой страницы.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  /** Тикать есть смысл ровно тогда, когда экран чего-то ждёт. Иначе каждая
   *  карточка спора перерисовывалась бы дважды в минуту без причины. */
  const waiting = mine && recordedAt === BigInt(0)
    && typeof claimedAt === 'bigint' && claimedAt > BigInt(0);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), NO_RESPONSE_TICK_MS);
    return () => clearInterval(id);
  }, [waiting]);

  const refetch = useCallback(() => {
    refetchClaimer();
    refetchClaimedAt();
    refetchRecordedAt();
    setNowSec(Math.floor(Date.now() / 1000));
  }, [refetchClaimer, refetchClaimedAt, refetchRecordedAt]);

  return {
    facts: {
      nowSec,
      me: me ?? null,
      claimer: typeof claimer === 'string' ? claimer : null,
      claimedAt: typeof claimedAt === 'bigint' ? Number(claimedAt) : null,
      recordedAt: typeof recordedAt === 'bigint' ? Number(recordedAt) : null,
      floorSeconds,
      release: releaseAdvice({
        nowSec,
        disputedAt: typeof disputedAt === 'bigint' ? Number(disputedAt) : null,
        disputeWindow: typeof disputeWindow === 'bigint' ? Number(disputeWindow) : null,
        verdictPending: pendingVerdict ? pendingVerdict.submittedAt > BigInt(0) : null,
      }),
    },
    refetch,
  };
}
