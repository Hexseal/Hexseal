'use client';

import { useReadContract } from 'wagmi';
import { ARBITER_REGISTRY_ABI, CONTRACTS } from '@/config/contracts';

/**
 * Пол записи о молчании — сколько должно пройти от взятия спора до того, как
 * арбитр сможет записать «просил переписку, ответа не было». В СЕКУНДАХ.
 *
 * ⚠️ СВОЕЙ КОПИИ ЧИСЛА ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО (замысел 5.2). Хозяин
 * значения один — контракт (`NO_RESPONSE_FLOOR` в `ArbiterRegistryFacet`),
 * фронт его спрашивает. Класс бага известен и назван: значение, объявленное
 * трижды, сверяется само с собой, и замок, который вроде бы его стережёт,
 * зелен всегда. Поменяли пол в контракте — интерфейс обязан поехать за ним без
 * единой правки здесь; это и проверяется в `useNoResponseFloor.test.ts`
 * подставным ответом цепи, а не литералом.
 *
 * ⚠️ Возврат `null` означает «ещё не знаем», а НЕ «ноль секунд». Экран, который
 * спутает одно с другим, обещает человеку кнопку раньше, чем она заработает:
 * запись отвергнется `NoResponseTooEarly`, и виноватым окажется интерфейс.
 * Поэтому «нет ответа» здесь именно `null`, а `isLoading` отдаётся наружу.
 *
 * Числу цепи здесь не тесно в `number`: пол — часы, а не эпоха, и в
 * `Number.MAX_SAFE_INTEGER` он помещается с запасом в тысячи лет. Наружу
 * отдаётся `number`, потому что дальше его складывают с временем взятия спора
 * и сравнивают с часами браузера, где всё и так `number`.
 */
export function useNoResponseFloor(): { floorSeconds: number | null; isLoading: boolean } {
  const { data, isLoading } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getNoResponseFloor',
  }) as { data: bigint | undefined; isLoading: boolean };

  return {
    floorSeconds: data != null ? Number(data) : null,
    isLoading,
  };
}
