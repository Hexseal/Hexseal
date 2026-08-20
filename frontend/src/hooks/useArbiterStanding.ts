'use client';

import { useCallback } from 'react';
import { useReadContract } from 'wagmi';
import type { Address, Hex } from 'viem';
import { ARBITER_ACCOUNTABILITY_ABI, CONTRACTS } from '@/config/contracts';
import { decodeRemovalCause, type RemovalCause } from '@/lib/arbiterRemovalCause';

/**
 * Положение арбитра одним чтением — ВСЁ, что цепь знает про его репутацию,
 * залог, приостановку и историю сносов, плюс его собственный ответ на
 * обвинение.
 *
 * ⚠️ ОДНО ЧТЕНИЕ, А НЕ СЕМЬ. `getArbiterStanding` отдаёт тринадцать полей
 * разом именно затем, чтобы карточка не расходилась сама с собой: собери их
 * семью отдельными запросами — между ними пройдут блоки, и залог окажется
 * прочитан до сноса, а статус после (докстринг функции в
 * `ArbiterAccountabilityFacet`). Здесь этот замысел обязаны продолжить, а не
 * сломать вторым набором геттеров.
 *
 * ⚠️ ВТОРОЕ ЧТЕНИЕ ЕСТЬ, И ОНО ОБЯЗАТЕЛЬНОЕ — ОТВЕТ ОБВИНЯЕМОГО. Решение
 * владельца от 17 августа: ответ обвинённого показывается НАРАВНЕ с обвинением.
 * И это уже не только ответ СНЯТОГО: с 19 августа 2026 цепь принимает
 * возражение во время 48-часовой паузы, то есть карточка действующего арбитра
 * под живым обвинением тоже обязана его показывать.
 * Обвинение против настоящего адреса лежит в цепи вечно, и карточка, которая
 * умеет показать только его, — это половина дела, выданная за целое. Поэтому
 * `getRemovalReply` читается здесь же, а не оставляется на усмотрение экрана.
 *
 * ⚠️ И ПОЭТОМУ ЖЕ КАРТОЧКИ НЕТ, ПОКА НЕ ПРИЕХАЛИ ОБЕ ПОЛОВИНЫ. Два чтения
 * приходят в разное время, и вернуть обвинение раньше ответа значило бы на
 * несколько кадров показать ровно то, что решение владельца запрещает.
 * `standing === null` означает «ещё не знаем», и это не то же самое, что
 * «нечего показывать».
 *
 * ⚠️ ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Ни ТЕКСТА ответа, ни МОМЕНТА ответа в цепи не
 * существует: `respondToRemoval` кладёт только отпечаток, а «когда» живёт
 * исключительно в событии `RemovalAnswered`, читателя которому (сабграфа) в
 * проекте пока нет. Поле под момент объявлено типом `null` — чтобы экран, когда
 * его будут писать, не изобрёл своего места под него и не подставил туда, к
 * примеру, `lastRemovalAt`. Симметрия при этом соблюдена честно: обвинение в
 * цепи — это тоже всего лишь отпечаток доказательства, который цепь не читала.
 *
 * ⚠️ ЭКРАНОВ У ЭТОГО КРЮЧКА ПОКА НЕТ, и это не забывчивость: какие именно —
 * решает владелец. Если до него дойдёт чистка мёртвого кода, её надо
 * остановить.
 */

/** Ответ обвинённого арбитра — на живое обвинение или на состоявшийся снос. */
export interface RemovalAnswer {
  /** Отпечаток ответа из цепи. `null` — не отвечал (или отвечать не на что). */
  digest: Hex | null;
  /**
   * Момент ответа. Всегда `null` сегодня — он есть ТОЛЬКО в событии
   * `RemovalAnswered`, а читателя событий у нас нет. Тип именно `null`, а не
   * `number | null`: подставить сюда что-нибудь похожее по смыслу не даст
   * тип-чекер, и «примерно тогда же» на экран не попадёт.
   */
  at: null;
}

/**
 * Поля названы РОВНО так же, как возвраты `getArbiterStanding` в ABI, и это не
 * косметика: тринадцать значений приезжают кортежем, то есть ПО МЕСТУ, а восемь
 * из них — `uint256`, структурно неразличимые. Перестановка любых двух не
 * ревертит ничего и не ловится типами (тот же класс, что `boxKey`/`signKey` в
 * `relay.ts`). Совпадение имён позволяет замку сверить порядок полей с порядком
 * возвратов в ABI, а тот уже заперт на исходник контракта
 * (`lib/arbiterAccountabilityAbi.test.ts`).
 */
export interface ArbiterStanding {
  xp: bigint;
  cleanStreak: bigint;
  mistakeStreak: bigint;
  /** Залог в USDC (6 знаков). Остаётся `bigint` — второй копии денег в другом
   *  представлении заводить не за чем, показывает их `fmtUSDC`. */
  bond: bigint;
  /** Кто посадил. Ноль — «посадившего не записано»: у самозаписи
   *  (`applyAsArbiter`) это признак «сел сам», у постороннего адреса — просто
   *  пустота. Отдаётся как есть, домысливать это здесь нечем. */
  seatedBy: Address;
  /** Секунды эпохи. Ноль — не приостановлен. */
  suspendedUntil: number;
  openClaims: bigint;
  cleanVerdicts: bigint;
  /** Секунды эпохи. Ноль — снос не действует СЕЙЧАС (не снимали либо посадили
   *  заново); история сносов при этом никуда не девается, см. `removalCount`. */
  removedAt: number;
  hasLiveRemovalProposal: boolean;
  removalCount: bigint;
  /** Секунды эпохи. В отличие от `removedAt`, повторной посадкой НЕ стирается. */
  lastRemovalAt: number;
  /** Расшифрованный повод — с признаком «проверила ли цепь сама». */
  lastRemovalCause: RemovalCause;
  /** Ответ обвиняемого — показывается наравне с обвинением. */
  answer: RemovalAnswer;
}

export interface ArbiterStandingRead {
  /** `null` — ещё не знаем (или спрашивать нечего/некого). */
  standing: ArbiterStanding | null;
  isLoading: boolean;
  /** Перечитать обе половины. Звать после любой записи, меняющей положение. */
  refetch: () => void;
}

const ZERO_DIGEST = `0x${'00'.repeat(32)}` as Hex;

/**
 * @param arbiter  чьё положение. `undefined` — читать нечего, оба запроса спят.
 * @param enabled  гейт стоимости. Карточку могут ставить в список, а это два
 *                 `eth_call` на каждую строку; выключенный крючок не ходит в
 *                 цепь вовсе и честно отвечает «ещё не знаем».
 */
export function useArbiterStanding(
  arbiter: Address | undefined,
  enabled = true,
): ArbiterStandingRead {
  const ask = enabled && !!arbiter;

  const standingRead = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_ACCOUNTABILITY_ABI,
    functionName: 'getArbiterStanding',
    args: [arbiter as Address],
    query: { enabled: ask },
  }) as {
    data: readonly [
      bigint, bigint, bigint, bigint, Address, bigint, bigint, bigint, bigint,
      boolean, bigint, bigint, number,
    ] | undefined;
    isLoading: boolean;
    refetch: () => void;
  };

  const replyRead = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_ACCOUNTABILITY_ABI,
    functionName: 'getRemovalReply',
    args: [arbiter as Address],
    query: { enabled: ask },
  }) as { data: Hex | undefined; isLoading: boolean; refetch: () => void };

  const refetchStanding = standingRead.refetch;
  const refetchReply = replyRead.refetch;
  const refetch = useCallback(() => {
    refetchStanding();
    refetchReply();
  }, [refetchStanding, refetchReply]);

  const tuple = standingRead.data;
  const reply = replyRead.data;

  // Обе половины или ничего — см. шапку про «ответ наравне с обвинением».
  const standing: ArbiterStanding | null = tuple !== undefined && reply !== undefined
    ? {
      xp:                     tuple[0],
      cleanStreak:            tuple[1],
      mistakeStreak:          tuple[2],
      bond:                   tuple[3],
      seatedBy:               tuple[4],
      suspendedUntil:         Number(tuple[5]),
      openClaims:             tuple[6],
      cleanVerdicts:          tuple[7],
      removedAt:              Number(tuple[8]),
      hasLiveRemovalProposal: tuple[9],
      removalCount:           tuple[10],
      lastRemovalAt:          Number(tuple[11]),
      lastRemovalCause:       decodeRemovalCause(Number(tuple[12])),
      answer: {
        // Нулевой отпечаток — это «не отвечал», а не «ответ пустой»: контракт
        // нулевой ответ не принимает вовсе (`ZeroDigest`).
        digest: reply === ZERO_DIGEST ? null : reply,
        at: null,
      },
    }
    : null;

  return { standing, isLoading: standingRead.isLoading || replyRead.isLoading, refetch };
}
