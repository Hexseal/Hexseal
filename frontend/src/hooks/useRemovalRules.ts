'use client';

import { useReadContract } from 'wagmi';
import { ARBITER_ACCOUNTABILITY_ABI, CONTRACTS } from '@/config/contracts';
import { facetPresence, type FacetPresence } from '@/lib/facetPresence';

/**
 * Правила сноса, как их объявляет сама цепь: пауза, срок годности обвинения и
 * потолок слов.
 *
 * ⚠️ СВОИХ КОПИЙ НЕТ НИ ОДНОЙ, И ЭТО НЕ ПЕДАНТИЗМ. Все три числа — `private
 * constant` в `ArbiterAccountabilityFacet` с геттером наружу
 * (`getRemovalDelay`, `getProposalTTL`, `getMaxReasonBytes`), и у каждого в
 * докстринге сказано прямо, зачем геттер заведён: «спрашивать у цепи, а не
 * считать дома — копия разойдётся в тишине и покажет кнопку рабочей за час до
 * того, как она заработает». Тот же класс, что `useNoResponseFloor`.
 *
 * ⚠️ ОДНА ПРОБА НА ВЕСЬ ЭКРАН, А НЕ ПО ОДНОЙ НА КНОПКУ. Разрез в цепь ещё не
 * сделан: сегодня ВСЕ функции этого фасета отсутствуют, и вызов любой из них
 * ревертит в fallback даймонда. Спрашивать «а этот селектор есть?» перед каждым
 * действием значило бы засыпать человека одинаковыми отказами; поэтому
 * `getRemovalDelay()` служит пробой за всех — он `pure`, дешёвый и ничего не
 * значит сам по себе, кроме «фасет смонтирован».
 *
 * Разбор ответа живёт в `facetPresence` отдельной чистой функцией: его надо
 * звать из замка, а не разглядывать через полрендера.
 */
export interface RemovalRules {
  /** Пауза между предложением и сносом, СЕКУНДЫ. `null` — ещё не знаем. */
  removalDelay: number | null;
  /** Срок годности обвинения, СЕКУНДЫ. `null` — ещё не знаем. */
  proposalTTL: number | null;
  /** Потолок слов в БАЙТАХ. `null` — ещё не знаем, и это НЕ ноль. */
  maxReasonBytes: number | null;
  /**
   * С какой серии судейских ошибок повод `OverturnedVerdicts`/`Timeouts`
   * считается ДОКАЗАННЫМ (`MISTAKE_THRESHOLD`). `null` — ещё не знаем.
   */
  mistakeThreshold: number | null;
  /**
   * На какой ошибке цепь приостанавливает и обвиняет САМА
   * (`MAX_ARBITER_MISTAKES`). Это другое число, чем порог выше: порог на
   * единицу меньше, и путать их значит обещать снос на шаг раньше.
   */
  maxMistakes: number | null;
  /** Смонтирован ли фасет вообще. */
  presence: FacetPresence;
}

export function useRemovalRules(): RemovalRules {
  const common = { address: CONTRACTS.diamond, abi: ARBITER_ACCOUNTABILITY_ABI } as const;

  const delay = useReadContract({ ...common, functionName: 'getRemovalDelay' }) as {
    data: bigint | undefined; isLoading: boolean; error: { message?: string } | null;
  };
  const ttl = useReadContract({ ...common, functionName: 'getProposalTTL' }) as {
    data: bigint | undefined;
  };
  const cap = useReadContract({ ...common, functionName: 'getMaxReasonBytes' }) as {
    data: bigint | undefined;
  };
  const threshold = useReadContract({ ...common, functionName: 'getMistakeThreshold' }) as {
    data: bigint | undefined;
  };
  const maxMistakes = useReadContract({ ...common, functionName: 'getMaxArbiterMistakesMirror' }) as {
    data: bigint | undefined;
  };

  return {
    removalDelay:   delay.data != null ? Number(delay.data) : null,
    proposalTTL:    ttl.data   != null ? Number(ttl.data)   : null,
    maxReasonBytes: cap.data   != null ? Number(cap.data)   : null,
    mistakeThreshold: threshold.data   != null ? Number(threshold.data)   : null,
    maxMistakes:      maxMistakes.data != null ? Number(maxMistakes.data) : null,
    presence: facetPresence(delay),
  };
}
