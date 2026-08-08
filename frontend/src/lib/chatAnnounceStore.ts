/**
 * chatAnnounceStore.ts — общая память о том, объявлен ли наш ключ.
 *
 * ─── ПОЧЕМУ ОТДЕЛЬНО ОТ ХУКА, И ПОЧЕМУ БЕЗ REACT ────────────────────────────
 *
 * Две причины, и обе выяснились замером, а не рассуждением.
 *
 * 1. **Порог пропуска обязан быть ОДИН.** Первая версия проверяла «наш ключ
 *    объявлен?» в двух хуках сразу — в открытой переписке и в списке переписок.
 *    Мутации «снять проверку из `usePairChat`» и «снять из
 *    `usePairConversations`» проходили ЗЕЛЁНЫМИ на 73 замерах: у фронта нет
 *    jsdom, отрисовать хук нечем, и проводка внутри него не сторожится ничем.
 *    Проверка переехала в `getBagPass` — единственное место в чате, где вообще
 *    берётся пропуск, — и стала проверяемой напрямую.
 *
 * 2. **`getBagPass` живёт в `hooks/useChatSession.ts`.** Если склад держать в
 *    хуке, получается кольцо импортов: хук → склад → хук. Склад без React
 *    кольцо разрывает, а зависимости он получает аргументами.
 *
 * ─── ПОЧЕМУ СКЛАД ОБЩИЙ, А НЕ СВОЙ У КАЖДОГО ЭКЗЕМПЛЯРА ─────────────────────
 *
 * `useKeyAnnouncement()` живёт в нескольких местах страницы сразу: панель
 * переписки, список переписок, внутри `usePairChat`. Свой склад у каждого — это
 * три чтения справочника на одно открытие чата и, хуже, три одновременных
 * попытки объявить ключ. Второе одновременное окно кошелька прилетает как
 * `-32002`, и в мобильном MetaMask его нечем отменить.
 */

import {
  readOwnStanding, announceOwnKey, attemptAfterFailure, mailboxWorthPolling,
  type KeyStanding, type AnnounceAttempt,
} from '@/lib/chatAnnounce';
import type { ChatSession } from '@/lib/chatSession';
import type { PeerChatKeys } from '@/lib/chatDirectoryTypes';

interface Entry {
  standing: KeyStanding;
  attempt: AnnounceAttempt;
  errorCode: string | null;
  /** Чтение справочника в полёте — три экземпляра дают один запрос. */
  reading: Promise<void> | null;
  /** Объявление в полёте — три экземпляра дают ОДНУ запись в справочник. */
  announcing: Promise<void> | null;
}

const _store = new Map<string, Entry>();
const _listeners = new Set<() => void>();

function entry(address: string): Entry {
  let e = _store.get(address);
  if (!e) {
    e = { standing: 'unknown', attempt: 'none', errorCode: null, reading: null, announcing: null };
    _store.set(address, e);
  }
  return e;
}

function tell(): void {
  for (const fn of _listeners) {
    try { fn(); } catch { /* один плохой слушатель не ломает остальных */ }
  }
}

/** Подписка на изменения: любое обновление перерисовывает всех, кто спрашивал. */
export function subscribeKeyAnnouncement(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export function ownKeyStanding(address: string | undefined): KeyStanding {
  if (!address) return 'unknown';
  return _store.get(address.toLowerCase())?.standing ?? 'unknown';
}

/**
 * Стоит ли брать пропуск ради ящика.
 *
 * ⚠️ ЭТО И ЕСТЬ ЕДИНСТВЕННЫЙ ПОРОГ, и зовёт его `getBagPass`. Разбор правила — в
 * `mailboxWorthPolling` (`lib/chatAnnounce.ts`): опрос блокируется только когда
 * мы ПОЛОЖИТЕЛЬНО знаем, что написать нам нельзя.
 */
export function mailboxWorthPollingFor(address: string | undefined): boolean {
  return mailboxWorthPolling(ownKeyStanding(address));
}

/**
 * Состояние объявления целиком.
 *
 * ⚠️ ОТКРЫТО НАРУЖУ ПОСЛЕ НАХОДКИ МУТАЦИИ. Мутация «писать `failed` всегда,
 * классификатор не звать» проходила ЗЕЛЁНОЙ на 58 замерах: чистая функция была
 * заперта, а её УПОТРЕБЛЕНИЕ — нет. Ровно тот класс, который в этом проекте
 * зовут «замок, который ищет имя, а не употребление». Теперь переход состояния
 * можно прочитать и замерить (`hooks/chatAnnounceStore.test.ts`).
 */
export function keyAnnouncementState(address: string | undefined): {
  standing: KeyStanding; attempt: AnnounceAttempt; errorCode: string | null;
} {
  const e = address ? _store.get(address.toLowerCase()) : undefined;
  return {
    standing: e?.standing ?? 'unknown',
    attempt: e?.attempt ?? 'none',
    errorCode: e?.errorCode ?? null,
  };
}

/** Только для замеров: забыть всё, что склад запомнил. */
export function _resetKeyAnnouncementForTest(): void {
  _store.clear();
  _listeners.clear();
}

/**
 * Спросить справочник про свой адрес — один раз на адрес, с дедупом в полёте.
 *
 * ⚠️ ЛЮБОЙ неудачный исход даёт `unreachable`, а НЕ `unknown`, и это отказ в
 * сторону работы: `unknown` не пускает опрос ящика, и застряв в нём, чат молчал
 * бы навсегда — перечитать по своей воле здесь нечем.
 */
export function readStandingInto(
  address: `0x${string}`,
  session: ChatSession,
  fetchKeys: (address: `0x${string}`, signal?: AbortSignal) => Promise<PeerChatKeys>,
): Promise<void> {
  const key = address.toLowerCase();
  const e = entry(key);
  if (e.reading) return e.reading;
  const run = (async () => {
    const standing = await readOwnStanding(address, session.keypair.publicKey, fetchKeys)
      .catch(() => 'unreachable' as KeyStanding);
    const cur = entry(key);
    cur.standing = standing;
    cur.reading = null;
    tell();
  })();
  e.reading = run;
  return run;
}

export interface AnnounceIntoDeps {
  /** Пропуск РАДИ ОБЪЯВЛЕНИЯ — не ради ящика: порог ящика тут не применяется,
   *  иначе получилось бы кольцо (объявиться нельзя без пропуска, пропуск нельзя
   *  без объявления). */
  getPass: (opts: { humanAsked: boolean }) => Promise<string>;
  publish: (pass: string, session: ChatSession, signal?: AbortSignal) => Promise<void>;
}

/**
 * Объявить ключ и записать исход. Дедуп в полёте: три экземпляра хука на одной
 * странице дают ОДНУ запись в справочник, а не три.
 */
export function announceInto(
  address: `0x${string}`,
  session: ChatSession,
  humanAsked: boolean,
  deps: AnnounceIntoDeps,
): Promise<void> {
  const key = address.toLowerCase();
  const e = entry(key);
  if (e.announcing) return e.announcing;

  const run = (async () => {
    const cur = entry(key);
    cur.attempt = 'busy';
    cur.errorCode = null;
    tell();
    try {
      await announceOwnKey({ address, session, humanAsked, ...deps });
      // Объявили, и это подтвердил сервер (`POST /keys` вернул 2xx). Перечитывать
      // справочник ради подтверждения незачем: тот же сервер только что записал.
      cur.standing = 'mine';
      cur.attempt = 'none';
    } catch (err) {
      // «Ещё не время» — не «не удалось». Разбор и цена промаха — в докстринге
      // `attemptAfterFailure`; там же сказано, что различие вынесено в чистую
      // функцию ПОСЛЕ того, как мутация нашла его без охраны.
      cur.attempt = attemptAfterFailure(err);
      cur.errorCode = cur.attempt === 'failed'
        ? (err instanceof Error ? err.message : 'announce_failed')
        : null;
    } finally {
      const fin = entry(key);
      fin.announcing = null;
      tell();
    }
  })();
  e.announcing = run;
  return run;
}
