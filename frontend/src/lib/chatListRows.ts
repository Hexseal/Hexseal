/**
 * chatListRows.ts — сшивание нового набора строк со старым.
 *
 * ─── ЗАЧЕМ ЭТО ЕСТЬ ─────────────────────────────────────────────────────────
 *
 * Владелец, дословно: «максимум +чат а не ресет до скелетона и обратно».
 *
 * Каждый заход за списком собирает строки С НУЛЯ — новые объекты, новый массив.
 * Для React это «всё изменилось»: состояние пришло другой ссылкой, значит
 * перерисовывается страница, значит пересобирается разметка всех строк. Раз в
 * тридцать секунд, плюс на каждое новое сообщение в открытой переписке, плюс на
 * каждый возврат во вкладку.
 *
 * Здесь новый набор ПРИМЕРЯЕТСЯ к старому: что не изменилось — остаётся прежней
 * ссылкой, и React такую строку не трогает вовсе (`memo` у `ConvoItem` +
 * `Object.is` у самого React). Если не изменилось НИЧЕГО, наружу уходит тот же
 * массив, и обновление состояния гаснет в React'е целиком — ни одной
 * перерисовки, а не «дешёвая перерисовка».
 *
 * ⚠️ СРАВНИВАЮТСЯ РОВНО ТЕ ПОЛЯ, КОТОРЫЕ ВИДНЫ. Появится новое поле, влияющее
 * на вид строки, — его обязано добавить и сюда, иначе строка перестанет
 * обновляться (сшиватель скажет «то же самое», а на экране другое). Поэтому
 * поля перечислены явно, а не «всё, кроме служебного»: список из четырёх имён
 * заставляет об этом подумать, а `Object.keys` — нет.
 */

import type { PairConversation } from '@/hooks/usePairConversations';

/** Одинаковы ли строки ПО ВИДУ. `group` — наследство XMTP, никем не читается. */
export function sameConversationRow(a: PairConversation, b: PairConversation): boolean {
  return a.peerAddress === b.peerAddress
    && a.lastText === b.lastText
    && a.lastAt === b.lastAt
    && a.lastFromMe === b.lastFromMe;
}

/**
 * Сшить новый набор со старым, сохранив всё, что можно сохранить.
 *
 * Порядок берётся у НОВОГО набора: он отсортирован по свежести, и подменять его
 * прежним значило бы прятать переехавшую наверх переписку.
 */
export function mergeConversationRows(
  prev: readonly PairConversation[],
  next: readonly PairConversation[],
): PairConversation[] {
  let changed = prev.length !== next.length;
  const merged: PairConversation[] = new Array(next.length);

  for (let i = 0; i < next.length; i++) {
    const before = prev[i];
    if (before && sameConversationRow(before, next[i])) {
      merged[i] = before;
    } else {
      merged[i] = next[i];
      changed = true;
    }
  }

  // Ничего не изменилось — наружу уходит СТАРЫЙ массив. Это и есть «ноль
  // перерисовок»: `setState` с тем же объектом React гасит сам.
  return changed ? merged : (prev as PairConversation[]);
}
