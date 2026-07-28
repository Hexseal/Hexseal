'use client';

import { useTranslations } from 'next-intl';
import { useReadContract } from 'wagmi';
import { AGREEMENT_ABI } from '@/config/contracts';
import { decideArbiterTimeout } from '@/lib/arbiterTimeoutSettlement';
import { usdcExact } from '@/lib/splitPot';

/**
 * Какими словами описать таймаут арбитра — на всех четырёх экранах одинаково.
 *
 * Раньше подпись кнопки, тост и баннер обещали «автоматический возврат
 * клиенту», глядя только на статус и остаток окна. Но контракт делит котёл
 * пополам, если за спор никто не взялся, — и тогда обещание было ложью ровно в
 * момент действия: клиенту сулили всё, а исполнителю не говорили про
 * причитающуюся ему половину.
 *
 * Ветку выбирает `decideArbiterTimeout` (см. `lib/arbiterTimeoutSettlement` —
 * там же разобрано, почему одного поля `arbiter` недостаточно и откуда третий
 * исход). Здесь только чтения и слова.
 *
 * Срок окна и суммы читаются с контракта, а не хардкодятся: `DISPUTE_WINDOW`
 * уже менялась однажды с 7 дней на 4, и захардкоженный фронт после следующей
 * правки начал бы врать молча.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type ArbiterTimeoutKind = 'split' | 'refund' | 'unknown';

export interface ArbiterTimeoutOutcome {
  kind: ArbiterTimeoutKind;
  /** Подпись кнопки таймаута. */
  buttonLabel: string;
  /** Тост после успешной транзакции. */
  successToast: string;
  /** Текст баннера «окно арбитра истекло» на странице сделки. */
  bannerBody: string;
}

type Read = { data: bigint | undefined; error: unknown };

/**
 * @param agreementAddr адрес агримента
 * @param arbiter       поле `arbiter` агримента (из `getDetails`), `undefined`
 *                      пока не прочитано
 * @param enabled       звать чтения только когда ветка реально на экране —
 *                      статус DISPUTED и окно арбитра истекло
 */
export function useArbiterTimeoutOutcome(
  agreementAddr: string | undefined,
  arbiter: string | undefined,
  enabled: boolean,
): ArbiterTimeoutOutcome {
  const t = useTranslations();
  const address = agreementAddr as `0x${string}` | undefined;

  // Спор взяли — всё клиенту в любой реализации, читать нечего.
  const nobodyTook = arbiter !== undefined && arbiter.toLowerCase() === ZERO_ADDRESS;
  const probe = enabled && nobodyTook && !!address;

  const fee = useReadContract({
    address,
    abi: AGREEMENT_ABI,
    functionName: 'disputeFee',
    query: { enabled: probe },
  }) as Read;

  const pot = useReadContract({
    address,
    abi: AGREEMENT_ABI,
    functionName: 'totalPayout',
    query: { enabled: probe },
  }) as Read;

  const disputeWindow = useReadContract({
    address,
    abi: AGREEMENT_ABI,
    functionName: 'DISPUTE_WINDOW',
    query: { enabled: probe },
  }) as Read;

  const settlement = decideArbiterTimeout({
    arbiter,
    fee: fee.data,
    feeError: fee.error,
    pot: pot.data,
    disputeWindow: disputeWindow.data,
  });

  if (settlement.kind === 'split') {
    const sums = {
      toExecutor: usdcExact(settlement.toExecutor),
      toClient: usdcExact(settlement.toClient),
    };
    return {
      kind: 'split',
      buttonLabel: t('deal.timeout_arbiter_split'),
      successToast: t('deal.timeout_arbiter_split_success', sums),
      bannerBody: t('deal.stale_arbiter_split_body', { days: settlement.windowDays, ...sums }),
    };
  }

  if (settlement.kind === 'refund') {
    return {
      kind: 'refund',
      buttonLabel: t('deal.timeout_arbiter'),
      successToast: t('deal.timeout_arbiter_success'),
      bannerBody: t('deal.stale_arbiter_body'),
    };
  }

  return {
    kind: 'unknown',
    buttonLabel: t('deal.timeout_arbiter_unknown'),
    successToast: t('deal.timeout_arbiter_unknown_success'),
    bannerBody: t('deal.dispute_terms_unreadable'),
  };
}
