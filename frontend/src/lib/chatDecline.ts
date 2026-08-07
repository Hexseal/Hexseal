/**
 * chatDecline.ts — «я не хочу это подписывать» помнится (К-3, вторая половина).
 *
 * ⚠️ ЗАЧЕМ. Отказ подписать не запоминался нигде: человек закрывал окно
 * кошелька, переходил на другую страницу — и его спрашивали снова. Тем же
 * непонятным окном, без объяснения. Это читается не как «мы уважаем твой
 * выбор», а как «оно сломано и лезет».
 *
 * ⚠️ ЧТО ЗДЕСЬ НЕ ХРАНИТСЯ. Ни ключа, ни кода, ни адреса в открытом виде
 * сверх того, что и так лежит в `localStorage` у wagmi: значение — единица,
 * ключ — приставка плюс приведённый адрес. То же правило и та же причина,
 * что у отметки «код записан» (`chatRecovery.ts`).
 */

/** Приставка ключа. Экспортирована, чтобы тест сверялся с ней, а не
 *  задваивал строку литералом. */
export const CHAT_DECLINE_PREFIX = 'hexseal-chat-declined';

export function chatDeclineKey(address: string): string {
  return `${CHAT_DECLINE_PREFIX}-${address.toLowerCase()}`;
}

/**
 * Отказывался ли этот адрес подписывать.
 *
 * Отказ хранилища читается как «не отказывался»: спросить лишний раз хуже,
 * чем не спросить вовсе, но молча запереть чат — хуже обоих.
 */
export function isChatDeclined(address: string | null | undefined): boolean {
  if (!address) return false;
  try {
    return localStorage.getItem(chatDeclineKey(address)) === '1';
  } catch {
    return false;
  }
}

export function rememberChatDecline(address: string | null | undefined): void {
  if (!address) return;
  try {
    localStorage.setItem(chatDeclineKey(address), '1');
  } catch {
    // Приватный режим. Цена — спросим снова; ронять человека нельзя.
  }
}

/** Снимается только ЯВНЫМ действием человека («включить мессенджер»). */
export function forgetChatDecline(address: string | null | undefined): void {
  if (!address) return;
  try {
    localStorage.removeItem(chatDeclineKey(address));
  } catch {
    // То же: цена — лишний вопрос, а не потерянный чат.
  }
}

/**
 * Это отказ ЧЕЛОВЕКА, а не поломка?
 *
 * ⚠️ РАЗЛИЧАТЬ ОБЯЗАТЕЛЬНО. Считать отказом любую ошибку подписи значит
 * запирать чат на моргнувшей сети и на сбое кошелька — и человек не поймёт,
 * почему чат «сам выключился». Запирается только то, что человек выбрал сам.
 *
 * Признаков два, и оба нужны: wagmi/viem бросают `UserRejectedRequestError`
 * по имени, а часть кошельков (мобильные обёртки, WalletConnect) отдают
 * обычную `Error` с текстом. Ни один из двух не покрывает другого.
 */
export function isUserDecline(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === 'UserRejectedRequestError') return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /user rejected|user denied|rejected by user|request rejected/i.test(message);
}
