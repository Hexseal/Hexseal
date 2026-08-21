'use client';

import { useQuery } from 'urql';
import type { Address } from 'viem';
import { CHAIN_ACCUSATION_QUERY, SUBGRAPH_URL } from '@/lib/graph';

/**
 * Обвинение цепи и все споры, на которых оно стоит.
 *
 * ⚠️ ЭТО ВТОРАЯ ПОЛОВИНА КАРТИНКИ, А НЕ УКРАШЕНИЕ. Цепь про своё обвинение
 * отдаёт повод и момент; ОДИН договор несёт событие, а обвинение стоит на трёх
 * (решение владельца 15а). Показать один и промолчать про остальные значит
 * показать обвиняемому треть того, за что его снимают.
 *
 * ⚠️ И ЭТА ПОЛОВИНА СЕГОДНЯ НЕ ПРИЕДЕТ. Сабграф с сущностью `ChainAccusation`
 * лежит в репозитории и в цепи не выкачен — работает v2.3.0. Значит «споров
 * нет» и «спросить не у кого» обязаны быть РАЗНЫМИ ответами: первое — новость
 * про арбитра, второе — про нашу ленту. Свалить их в пустой список значило бы
 * молча сказать «обвинение стоит ни на чём».
 */
export interface ChainAccusationSeries {
  /** Договоры серии, старейший первым. `null` — спросить не удалось. */
  disputes: readonly `0x${string}`[] | null;
  /** Сколько их насчитала лента. `null` — не знаем. */
  disputeCount: number | null;
  /** Договор, который перевесил. */
  tippingAgreement: `0x${string}` | null;
  /** Момент обвинения по часам цепи. */
  proposedAt: number | null;
  /** Лента не ответила — сабграф старый, отключён или упал. */
  unavailable: boolean;
  isLoading: boolean;
}

interface GraphAnswer {
  arbiter: {
    id: string;
    chainAccusationCount: number;
    openChainAccusation: {
      id: string;
      path: number;
      agreement: `0x${string}`;
      proposedAt: string;
      disputes: `0x${string}`[];
      disputeCount: number;
      answeredAt: string | null;
      clearedAt: string | null;
      withdrawnAt: string | null;
      voidedAt: string | null;
    } | null;
  } | null;
}

export function useChainAccusation(
  arbiter: Address | undefined,
  enabled = true,
): ChainAccusationSeries {
  const [{ data, error, fetching }] = useQuery<GraphAnswer>({
    query: CHAIN_ACCUSATION_QUERY,
    // Сабграф держит адреса строчными: спросить смешанным регистром —
    // получить `null` и прочитать его как «обвинения нет».
    variables: { arbiter: (arbiter ?? '').toLowerCase() },
    pause: !enabled || !arbiter || !SUBGRAPH_URL,
  });

  const open = data?.arbiter?.openChainAccusation ?? null;

  // ⚠️ Отказ ленты — НЕ пустой список. Ошибка запроса (старая версия сабграфа
  // не знает поля `openChainAccusation` и отвечает ошибкой разбора) обязана
  // доехать наружу как `unavailable`, иначе экран напишет «споров нет».
  const unavailable = !!error || (enabled && !!arbiter && !SUBGRAPH_URL);

  return {
    disputes: unavailable ? null : (open?.disputes ?? null),
    disputeCount: unavailable ? null : (open?.disputeCount ?? null),
    tippingAgreement: open?.agreement ?? null,
    proposedAt: open?.proposedAt != null ? Number(open.proposedAt) : null,
    unavailable,
    isLoading: fetching,
  };
}
