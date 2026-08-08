/**
 * staleStorage.ts — что можно выбросить из хранилища браузера.
 *
 * Два отбора, и цена ошибки у них разная:
 *
 *  1. `staleLegacyKeys` — мусор снесённого мессенджера. Никто не читает его с
 *     6 августа; выбрасывается сам, без спроса;
 *  2. `walletSessionKeys` — записи сеанса WalletConnect. Выбрасываются ТОЛЬКО
 *     по нажатию человека «переподключить кошелёк». Снести их без спроса
 *     значило бы отключить работающее подключение у того, у кого всё в порядке.
 *
 * ⚠️ ГЛАВНОЕ ТРЕБОВАНИЕ — НЕ ТРОНУТЬ НАШИ КЛЮЧИ. В хранилище лежат ключ
 * переписки, пропуск склада, метки прочтения и счётчик чтений. Ошибка в
 * шаблоне здесь стоит человеку переписки, а не удобства, поэтому отбор идёт по
 * ТОЧНЫМ именам и по одному явному семейству, а не по «всё, что не наше».
 *
 * ⚠️ Записи самой wagmi (`wagmi.store`, `wagmi.recentConnectorId`) НЕ ТРОГАЕМ:
 * их ведёт библиотека, и лезть в них — это чинить библиотеку своими руками,
 * что прямо запрещено. Мы убираем только записи сеанса кошелька, которые
 * протухли, и делаем это ПОСЛЕ штатного `disconnect()`.
 */

/** Мёртвые ключи снесённого мессенджера. Точные имена, без шаблонов. */
const LEGACY_DEAD_KEYS: readonly string[] = [
  'hexseal-xmtp-crumb',
  'hexseal-xmtp-crumb-prev',
];

/**
 * Записи сеанса WalletConnect. Семейство `wc@2:` — его собственное
 * пространство имён; два старых имени — с версии 1, они встречаются на
 * устройствах, которые подключались давно.
 */
const WALLET_SESSION_EXACT: readonly string[] = [
  'walletconnect',
  'WALLETCONNECT_DEEPLINK_CHOICE',
];
const WALLET_SESSION_PREFIX = 'wc@2:';

export function staleLegacyKeys(keys: readonly string[]): string[] {
  return keys.filter(k => LEGACY_DEAD_KEYS.includes(k));
}

export function walletSessionKeys(keys: readonly string[]): string[] {
  return keys.filter(k => k.startsWith(WALLET_SESSION_PREFIX) || WALLET_SESSION_EXACT.includes(k));
}

/** Наименьшее, что нам нужно от хранилища. Тип свой: модуль обязан работать и
 *  на сервере, и в замерах с подделанным хранилищем. */
export interface StorageLike {
  length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/** Все имена ключей. Отдельной функцией: перебор по индексам — единственный
 *  способ узнать их у `localStorage`, и врать он умеет (ключи сдвигаются при
 *  удалении), поэтому список снимается ДО удаления. */
export function allKeys(storage: StorageLike | null | undefined): string[] {
  if (!storage) return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (typeof k === 'string') out.push(k);
    }
  } catch {
    // Приватный режим и запреты третьих сторон умеют бросать на любом
    // обращении. Уборка не имеет права ронять страницу.
  }
  return out;
}

/**
 * Удаляет перечисленное. Возвращает СКОЛЬКО удалено — число, а не молчание:
 * «прибрали» без числа невозможно замерить.
 */
export function dropKeys(storage: StorageLike | null | undefined, keys: readonly string[]): number {
  if (!storage) return 0;
  let dropped = 0;
  for (const k of keys) {
    try {
      storage.removeItem(k);
      dropped++;
    } catch {
      // Один запертый ключ не отменяет остальных.
    }
  }
  return dropped;
}

/** Убрать мусор снесённого мессенджера. Зовётся один раз на загрузку страницы. */
export function sweepLegacyStorage(storage: StorageLike | null | undefined): number {
  return dropKeys(storage, staleLegacyKeys(allKeys(storage)));
}

/** Убрать записи сеанса кошелька. ТОЛЬКО по нажатию человека. */
export function dropWalletSession(storage: StorageLike | null | undefined): number {
  return dropKeys(storage, walletSessionKeys(allKeys(storage)));
}
