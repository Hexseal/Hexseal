/**
 * Все рода событий, которые нужны приложению с диамонда, — ОДНИМ фильтром.
 *
 * ⚠️ РОДОВ ЗДЕСЬ БОЛЬШЕ, ЧЕМ УВЕДОМЛЕНИЙ, и это нарочно. Провод общий, а
 * читателей у него два: разводка уведомлений (`NOTIF_EVENT_NAMES`) и слежение за
 * сменой арбитра (`WIRE_ONLY_EVENT_NAMES`). Списки раздельны и названы
 * по-разному — из имени видно, что человек увидит, а что просто приехало.
 *
 * ЗАЧЕМ ИМЕННО ТАК. viem умеет фильтр по НАБОРУ событий (`events`), и тогда
 * `topics[0]` уходит на узел массивом: один `eth_newFilter`, один
 * `eth_getFilterChanges` за такт на ВСЕ рода набора (сегодня их одиннадцать:
 * девять уведомлений плюс два «только на провод»). Прежние тринадцать
 * `useWatchContractEvent` давали тринадцать фильтров и тринадцать запросов за
 * такт — 140 в минуту на простое (`docs/OPEN-ITEMS.md`, пункт 38).
 *
 * ⚠️ ПОЧЕМУ НЕ «БЕЗ eventName». Соблазн: передать целый ABI без имени события —
 * viem так тоже умеет, и это один фильтр. Но `createContractEventFilter` в этом
 * случае НЕ СТАВИТ topics вовсе (проверено по
 * `node_modules/viem/_esm/actions/public/createContractEventFilter.js`), то есть
 * узел вернёт ВСЕ логи диамонда — постинг заказов, начисления опыта, заявки
 * арбитров, всё. Один запрос, но ответ тем больше, чем живее биржа. Набор
 * событий даёт и один запрос, и узкий ответ.
 *
 * ⚠️ ОПИСАНИЯ БЕРУТСЯ ИЗ БОЕВЫХ ABI, А НЕ ПЕРЕПИСЫВАЮТСЯ РУКАМИ. topic0 — это
 * хэш подписи события; переписанное от руки описание с другим типом поля даёт
 * другой topic0, фильтр молча перестаёт ловить, и уведомление исчезает без
 * следа. Поэтому события ВЫНИМАЮТСЯ из тех же ABI, что используются в остальном
 * приложении, а `notifEvents.test.ts` проверяет, что вынулись все девять.
 */

import type { AbiEvent } from 'viem';
import { DIAMOND_ABI, SERVICE_BOARD_ABI, ARBITER_REGISTRY_ABI } from '@/config/contracts';
import {
  NOTIF_EVENT_NAMES,
  WIRE_ONLY_EVENT_NAMES,
  type NotifEventName,
  type WireOnlyEventName,
} from '@/lib/notifRouter';

/**
 * Такт опроса уведомлений. Было шесть секунд (общий из конфига wagmi) на каждый
 * из тринадцати фильтров. Двадцать — потому что колокольчик это ИЗВЕЩЕНИЕ, а не
 * живой экран: задержка до двадцати секунд человеку незаметна, а цена падает
 * втрое даже после схлопывания тринадцати фильтров в один. Живой экран сделки
 * держит свой, более частый такт (`hooks/useDealLiveRefresh.ts`).
 */
export const NOTIF_POLL_MS = 20_000;

/** Где искать каждый род. Порядок важен только для повторяемости. */
const SOURCES: readonly (readonly unknown[])[] = [
  DIAMOND_ABI,
  SERVICE_BOARD_ABI,
  ARBITER_REGISTRY_ABI,
];

function pickEvent(name: string): AbiEvent | null {
  for (const abi of SOURCES) {
    for (const item of abi) {
      const it = item as { type?: string; name?: string };
      if (it.type === 'event' && it.name === name) return item as AbiEvent;
    }
  }
  return null;
}

/**
 * ЧТО ЕДЕТ ПО ПРОВОДУ — объединение двух РАЗНЫХ по смыслу списков:
 *
 *  • `NOTIF_EVENT_NAMES`     — рода, которые становятся уведомлениями (колокольчик);
 *  • `WIRE_ONLY_EVENT_NAMES` — рода, которые уведомлениями НЕ становятся и нужны
 *                              другому читателю (слежение за сменой арбитра,
 *                              `lib/disputeArbiter.ts`).
 *
 * ⚠️ ПОЧЕМУ ОДИН ФИЛЬТР, А НЕ ВТОРОЙ РЯДОМ. Второй цикл опроса стоил бы ещё
 * `60000 / такт` запросов в минуту на каждую открытую вкладку, а бюджет уже
 * выбран (`hooks/chainPollBudget.test.ts`: не больше двух циклов и восьми
 * запросов в минуту). Добавление рода в общий набор стоит **ноль** лишних
 * обращений: viem кладёт `topics[0]` массивом, то есть растёт только фильтр на
 * узле, а не число запросов.
 *
 * ⚠️ `DisputeClaimed` состоит в ОБОИХ списках — он и уведомление («ваш спор
 * взят»), и повод перечитать цепь. Поэтому здесь объединение через `Set`, а не
 * склейка: дубль в наборе дал бы два одинаковых `topics[0]` и лишнюю работу
 * узлу.
 */
export const WIRE_EVENT_NAMES: readonly (NotifEventName | WireOnlyEventName)[] =
  [...new Set<NotifEventName | WireOnlyEventName>([
    ...NOTIF_EVENT_NAMES,
    ...WIRE_ONLY_EVENT_NAMES,
  ])];

/**
 * Набор для фильтра. Собирается на загрузке модуля; пропущенный род — не
 * «меньше уведомлений», а тихая потеря целого рода, поэтому он попадает в
 * `MISSING_WIRE_EVENTS`, и это проверяется замером.
 */
export const WIRE_EVENTS: AbiEvent[] = [];
export const MISSING_WIRE_EVENTS: (NotifEventName | WireOnlyEventName)[] = [];

for (const name of WIRE_EVENT_NAMES) {
  const ev = pickEvent(name);
  if (ev) WIRE_EVENTS.push(ev);
  else MISSING_WIRE_EVENTS.push(name);
}
