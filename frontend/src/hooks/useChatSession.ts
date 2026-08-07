'use client';

/**
 * useChatSession.ts — сеанс чата и справочник открытых ключей.
 *
 * Замена `contexts/XmtpContext.tsx`: наружу отдаёт те же поля
 * (`status`/`error`/`errorCode`/`retry`/`cancel`/`disable`), чтобы пересадка
 * отображения (Задача 7) не переписывала потребителей, плюс то, чего у XMTP
 * не было и быть не могло — сам сеанс, код восстановления и честный ответ на
 * вопрос «почему меня опять просят подписать».
 *
 * ─── ПОЧЕМУ ЛОГИКА ЖИВЁТ В ЧИСТЫХ ФУНКЦИЯХ ──────────────────────────────
 *
 * У фронта нет ни jsdom, ни @testing-library: `npm test` берёт vitest у
 * релеера, окружение `node` (frontend/vitest.config.mjs). Отрисовать хук и
 * проверить его эффекты НЕЧЕМ. Значит дисциплина обратная обычной: всё, что
 * может быть неверным, вынесено в чистые функции этого файла и заперто
 * тестами, а React-обёртка сведена к состоянию и одному вызову. Всё, что
 * нельзя проверить, обязано быть тривиальным — а не наоборот.
 *
 * ─── СПРАВОЧНИК: ЗАЧЕМ ТУДА ЕДЕТ ВТОРОЙ КЛЮЧ ────────────────────────────
 *
 * Ключей два, и они разные:
 *   - `boxKey`  — X25519, ЗАПЕЧАТЫВАНИЕ (`chatCrypto.sealForRecipient`);
 *   - `signKey` — Ed25519, ПРОВЕРКА ПОДПИСИ звена
 *                 (`chatConversation.deriveLinkSigningKeypair`).
 *
 * До этой задачи публиковался только первый. Последствие названо в шапке
 * `chatConversation.ts` дословно: без внешнего пина проверка подписи — это
 * проверка САМОСОГЛАСОВАННОСТИ. Она ловит подмену одного звена, порчу байтов
 * по дороге и смену ключа посреди переписки, но НЕ ловит того, кто перепишет
 * всю цепочку целиком своим ключом: подделка согласована сама с собой, и
 * отличить её не от чего. Замерено: без пина такая цепочка проходит как своя
 * — три сообщения, ноль претензий; с пином отвергается целиком.
 *
 * Из ключа ШИФРОВАНИЯ собеседника подписной не выводится: он выводится из
 * ЗАКРЫТОЙ половины, а нам доступна только открытая. Значит ключ обязан
 * прийти извне — отсюда справочник.
 *
 * ⚠️ ЧЕСТНО О ГРАНИЦЕ. Справочник держит сервер. Сервер, подменивший
 * `signKey`, подменяет и пин — то есть эта проводка закрывает подделку
 * СОБЕСЕДНИКОМ и не закрывает подделку СЕРВЕРОМ. Полное связывание «ключ
 * чата ↔ адрес в цепи» §11 общей спеки оставляет следующим планам; здесь
 * закрыт тот из двух случаев, который закрывается сегодня.
 *
 * ─── ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ ─────────────────────────────────────────
 *
 *  - НЕ решает, какого рода кошелёк и откуда брать ключ — это `chatSession.ts`.
 *  - НЕ показывает предупреждение про код восстановления. Здесь только
 *    признак «код есть и его надо показать» (`recoveryCode`).
 *
 * ⚠️ ТЕКСТ ПРЕДУПРЕЖДЕНИЯ ЖДЁТ СЛОВА ВЛАДЕЛЬЦА. Черновик разложен по всем
 * 14 локалям отдельными ключами — `chat.recovery_warning_title`,
 * `chat.recovery_warning_access`, `chat.recovery_warning_where`,
 * `chat.recovery_warning_loss` (`messages/*.json`; `zh.json` не трогается,
 * это сирота вне списка локалей). Четыре ключа, а не один абзац, ровно
 * затем, чтобы правка одной строки не требовала правки кода. Показывает их
 * отображение — Задача 7.
 *
 * Смысл, который текст ОБЯЗАН донести (это не черновик, это требование
 * плана): код — доступ ко всей переписке навсегда; кто его получил, читает
 * всё; восстановить или отозвать нельзя.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import {
  openSession, exportRecoveryCode, forgetSession,
  ChatSessionError,
  type ChatSession, type ChatSessionErrorCode,
} from '@/lib/chatSession';
import { CHAT_KEY_TYPED_DATA } from '@/lib/chatCrypto';
import { deriveLinkSigningKeypair } from '@/lib/chatConversation';
import { RELAYER_URL, requestBagPass } from '@/lib/chatTransport';
import { withWalletLock } from '@/lib/walletLock';
import { isChatDeclined, rememberChatDecline, forgetChatDecline, isUserDecline } from '@/lib/chatDecline';

/* ────────────────────────── справочник ключей ─────────────────────────── */

export type ChatDirectoryErrorCode =
  /** По адресу собеседника ключа нет — он ещё не заходил. НЕ ошибка сети и
   *  не поломка: единственная причина, у которой есть человеческое действие
   *  («пришлите ему ссылку»). */
  | 'peer_unknown'
  /** Справочник отдал что-то, что ключом не является: не hex, не 32 байта,
   *  не строка вовсе. Ровно тот мусор, который libsodium принял бы молча. */
  | 'peer_key_malformed'
  /** Сервер сказал, что справочник ему самому недоступен (503). */
  | 'directory_unavailable'
  /** Всё остальное: 4xx/5xx без разобранного кода, ответ не той формы. */
  | 'directory_failed';

/** Каждый отказ несёт `.code` ОТДЕЛЬНЫМ полем — та же дисциплина, что в
 *  `chatTransport.ts`, `chatSession.ts` и `chatConversation.ts`. `.status`
 *  проброшен, чтобы вызывающий отличал 413 от 400 не по тексту. */
export class ChatDirectoryError extends Error {
  readonly code: ChatDirectoryErrorCode;
  readonly status?: number;
  constructor(message: string, code: ChatDirectoryErrorCode, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = 'ChatDirectoryError';
    this.code = code;
    this.status = options?.status;
  }
}

/** Длина обеих половин обеих пар — 32 байта. Записана здесь ЯВНО, а не взята
 *  из чужого модуля: сервер применяет ровно это же число собственной
 *  проверкой (`relayer/directory.js`, `_isValidKeyHex`), и два места обязаны
 *  сходиться числом, а не ссылкой друг на друга. */
export const CHAT_PUBLIC_KEY_LEN = 32;

/** То, что сервер принимает и отдаёт: `0x` + 64 нижнерегистровых hex-цифры. */
const KEY_HEX_RE = /^0x[0-9a-f]{64}$/;

export interface PeerChatKeys {
  /** X25519 — на него запечатывается конверт. */
  boxKey: Uint8Array;
  /**
   * ВСЕ подписные ключи, которые собеседник когда-либо публиковал: нынешний
   * первым, дальше история от свежей к старой.
   *
   * ⚠️ Б-2 финальной проверки. Справочник хранит историю ДОСЛОВНО ради этого
   * случая — правило 3 Задачи 2 записано так: «старый сохраняется в истории,
   * иначе переписка, запечатанная на прежний ключ, станет нечитаемой молча».
   * Сервер своё выполнял, до двухсот записей; мы читали только нынешний ключ,
   * и честная смена ключа собеседником превращалась в ОБВИНЕНИЕ: два старых
   * сообщения пропадали с экрана, а панель говорила «не прошли проверку
   * подлинности». Половина обещания выполнена сервером, вторая не выполнена
   * нами — и платил за это человек, не сделавший ничего плохого.
   *
   * Пустой массив — собеседник подписного ключа не публиковал ни разу
   * (запись сделана до Задачи 6). Пина тогда нет, и это честно.
   */
  signKeyHistory: Uint8Array[];
  /** Ed25519 — им проверяется подпись звена. `null` — запись сделана до того,
   *  как публикация появилась: шифровать можно, пинить нечем. Отказать по
   *  такой записи значило бы закрыть чат тем, кто уже заходил. */
  signKey: Uint8Array | null;
}

function toKeyHex(bytes: Uint8Array): string {
  let s = '0x';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function fromKeyHex(value: unknown, what: string): Uint8Array {
  if (typeof value !== 'string' || !KEY_HEX_RE.test(value)) {
    throw new ChatDirectoryError(
      `Справочник отдал ${what} не той формы (ожидалось 0x + 64 hex, ${CHAT_PUBLIC_KEY_LEN} байта)`,
      'peer_key_malformed',
    );
  }
  const out = new Uint8Array(CHAT_PUBLIC_KEY_LEN);
  for (let i = 0; i < CHAT_PUBLIC_KEY_LEN; i++) out[i] = parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

async function directoryFailure(res: Response, fallback: string): Promise<never> {
  let body: { error?: string; code?: string } = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') body = parsed as { error?: string; code?: string };
  } catch {
    // Тело не JSON (HTML от прокси, оборванный ответ) — само по себе не повод
    // молчать про отказ, просто код сервера мы не узнаем.
  }
  const code: ChatDirectoryErrorCode =
    res.status === 404 || body.code === 'key_not_found' ? 'peer_unknown'
      : body.code === 'directory_unavailable' ? 'directory_unavailable'
        : 'directory_failed';
  throw new ChatDirectoryError(body.error ?? fallback, code, { status: res.status });
}

/**
 * Кладёт в справочник ОБЕ открытые половины сеанса.
 *
 * Адрес сервер берёт ИЗ ПРОПУСКА, не из тела — положить ключ за другого
 * нельзя (правило 1 Задачи 2). Поэтому сюда приходит `pass`, а не адрес.
 *
 * Байт-в-байт повторная публикация на сервере — ранний возврат без записи на
 * диск (`relayer/directory.js`), так что звать это на каждом открытии сеанса
 * дёшево и намеренно: устройство, где ключ уже лежал, всё равно обязано
 * убедиться, что справочник о нём знает.
 */
export async function publishChatKeys(
  pass: string,
  session: ChatSession,
  signal?: AbortSignal,
): Promise<void> {
  const signer = await deriveLinkSigningKeypair(session.keypair);
  const res = await fetch(`${RELAYER_URL}/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bag-pass': pass },
    body: JSON.stringify({
      boxKey: toKeyHex(session.keypair.publicKey),
      signKey: toKeyHex(signer.publicKey),
    }),
    signal,
  });
  if (!res.ok) await directoryFailure(res, 'Не удалось опубликовать открытые ключи чата');
}

/**
 * Читает открытые ключи собеседника. Пропуск НЕ нужен: открытый ключ на то и
 * открытый, а требовать пропуск значило бы выдать серверу список тех, кто кем
 * интересуется (правило 4 Задачи 2).
 *
 * @throws {ChatDirectoryError} `peer_unknown` — не заходил; `peer_key_malformed`
 *   — отдал мусор; `directory_unavailable`/`directory_failed` — остальное.
 */
export async function fetchPeerChatKeys(
  address: `0x${string}`,
  signal?: AbortSignal,
): Promise<PeerChatKeys> {
  const res = await fetch(`${RELAYER_URL}/keys/${encodeURIComponent(address.toLowerCase())}`, { signal });
  if (!res.ok) await directoryFailure(res, 'Не удалось прочитать открытый ключ собеседника');

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ChatDirectoryError('Справочник ответил не JSON', 'directory_failed', { cause: err, status: res.status });
  }
  if (!body || typeof body !== 'object') {
    throw new ChatDirectoryError('Справочник ответил не объектом', 'directory_failed', { status: res.status });
  }
  const rec = body as Record<string, unknown>;
  const signKey = rec.signKey === undefined || rec.signKey === null
    ? null
    // Отсутствие — штатный случай (старая запись), мусор — нет.
    : fromKeyHex(rec.signKey, 'подписной ключ');

  // История — данные из сети, и МУСОР В ОДНОЙ ЗАПИСИ не повод потерять
  // остальные: старая запись без `signKey` законна, испорченная запись не
  // должна стоить человеку читаемости всей прежней переписки. Поэтому здесь
  // мягкий разбор поэлементно, а не общий гейт формы, как у нынешнего ключа
  // (тот один, и без него работать нечем).
  const history: Uint8Array[] = signKey ? [signKey] : [];
  const seen = new Set<string>(signKey ? [toKeyHex(signKey)] : []);
  if (Array.isArray(rec.history)) {
    for (const entry of rec.history) {
      const raw = (entry as Record<string, unknown> | null)?.signKey;
      if (typeof raw !== 'string' || !KEY_HEX_RE.test(raw) || seen.has(raw)) continue;
      seen.add(raw);
      history.push(fromKeyHex(raw, 'подписной ключ из истории'));
    }
  }

  return { boxKey: fromKeyHex(rec.boxKey, 'ключ запечатывания'), signKey, signKeyHistory: history };
}

/* ──────────────────────── пропуск склада ──────────────────────────────── */

/**
 * Пропуск склада для адреса — ЕДИНСТВЕННОЕ место в чате, где всплывает окно
 * подписи после заведения сеанса.
 *
 * ⚠️ ПОЧЕМУ ЗДЕСЬ, А НЕ В КАЖДОМ ХУКЕ. Первая версия задачи 6 звала
 * `signMessageAsync` прямо в `usePairChat.ts` И в `usePairConversations.ts`
 * — два места подписи вместо одного, и НИ ОДНО не брало общий мьютекс
 * кошелька. Поймано структурным гейтом `lib/signaturePaths.test.ts`, а не
 * рассуждением. Цена промаха там названа прямо: второй одновременный запрос
 * прилетает в кошелёк как `-32002`, и в мобильном MetaMask его нечем
 * отменить — человек заблокирован, пока не закроет кошелёк целиком. А
 * список чатов и открытая переписка стартуют РЯДОМ, на одной странице: это
 * не теоретическая гонка.
 *
 * `requestBagPass` кэширует пропуск на 12 часов и склеивает одновременные
 * вызовы одного адреса, так что на живом пропуске подписи нет вовсе —
 * мьютекс здесь для холодного кэша и для соседства с остальными окнами
 * приложения (страница сделки, профиль, пуши).
 *
 * ⚠️ `onSigning` — ЕДИНСТВЕННОЕ честное место, откуда отображение может
 * узнать, что окно кошелька открывается ПРЯМО СЕЙЧАС. Снаружи это неизвестно:
 * `requestBagPass` на живом пропуске подписи не просит вовсе, а угадать
 * заранее нельзя — срок пропуска знает только он. Колбэк зовётся ровно вокруг
 * вызова кошелька (`true` перед, `false` после — в `finally`, чтобы отказ
 * человека не оставил экран с вечным «подпишите»). Замер, ради которого он
 * заведён: подпись всплывает не по нажатию, а при открытии чата раз в 12
 * часов, и человеку это надо сказать словами (`chat.pass_signature_hint`).
 */
/**
 * Подпись типизированных данных, из которой рождается ключ переписки —
 * ВТОРОЙ и последний путь к окну кошелька в чате, и он тоже под общим
 * мьютексом.
 *
 * ⚠️ ПОЧЕМУ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ СТРОКА В ЭФФЕКТЕ. Находка В-1
 * независимой проверки, разбор по дереву импортов: `chatSession.ts` мьютекс
 * кошелька НЕ ИМПОРТИРУЕТ ВОВСЕ — у открытия сеанса свой межвкладочный замок
 * с ДРУГИМ именем (`hexseal-chat-session-<адрес>`), и с окном подписи от
 * подписки на уведомления, от страницы сделки или от гейслесс-действия он не
 * пересекается никак. То есть «оба пути под общим мьютексом» было неправдой,
 * пока эта обёртка не появилась. Замок берётся ЗДЕСЬ, снаружи, потому что
 * `chatSession.ts` трогать нельзя и не нужно: он получает подписывающую
 * функцию аргументом, а чем она обёрнута — его не касается.
 *
 * Замок держится на время самого окна подписи, а не на всё открытие сеанса:
 * `chatSession` зовёт эту функцию ровно там, где спрашивает кошелёк.
 */
export async function signChatKeyLocked(
  address: `0x${string}`,
  signTypedDataAsync: (typedData: typeof CHAT_KEY_TYPED_DATA) => Promise<`0x${string}`>,
): Promise<`0x${string}`> {
  return withWalletLock(address, () => signTypedDataAsync(CHAT_KEY_TYPED_DATA));
}

export async function getBagPass(
  address: `0x${string}`,
  signMessageAsync: (args: { message: string }) => Promise<string>,
  onSigning?: (busy: boolean) => void,
): Promise<string> {
  return withWalletLock(address, async () => {
    const pass = await requestBagPass(async (message) => {
      onSigning?.(true);
      try {
        return await signMessageAsync({ message });
      } finally {
        onSigning?.(false);
      }
    }, address);
    return pass.pass;
  });
}

/* ────────────────── «ключ не сохранился» — наверх ─────────────────────── */

export interface SessionStorageNotice {
  /** Всегда `false` — уведомление существует только когда не сохранилось. */
  persisted: false;
  /** Названная причина или `null`, если сеанс её не назвал. */
  code: ChatSessionErrorCode | null;
  /** `true` — у причины есть ДЕЙСТВИЕ, которое человек может выполнить
   *  («закройте другие вкладки сайта»). У кончившейся квоты и приватного
   *  режима действия нет, и предлагать его значило бы врать. */
  actionable: boolean;
}

/**
 * Единственная причина, у которой есть действие. Отдельным множеством, а не
 * сравнением в месте показа: список обязан жить рядом со своим смыслом.
 */
const ACTIONABLE_STORAGE_ISSUES: ReadonlySet<ChatSessionErrorCode> = new Set<ChatSessionErrorCode>([
  'storage_blocked',
]);

/**
 * Превращает флаги сеанса в то, что можно показать человеку.
 *
 * `null` — говорить нечего. Иначе человек ОБЯЗАН узнать: без этого он просто
 * получает окно подписи при каждой перезагрузке и не понимает, почему
 * обещанное «один раз в жизни» не сбывается именно у него.
 */
export function sessionStorageNotice(session: ChatSession): SessionStorageNotice | null {
  if (session.persisted) return null;
  const code = session.storageIssue ?? null;
  return { persisted: false, code, actionable: code !== null && ACTIONABLE_STORAGE_ISSUES.has(code) };
}

/* ───────────────────────────── сам хук ────────────────────────────────── */

export type ChatSessionStatus = 'loading' | 'ready' | 'error';

export interface UseChatSessionValue {
  /** Те же три значения, что у `useXmtp()` — потребители не переписываются. */
  status: ChatSessionStatus;
  /** Сырой текст отказа — только для того, что не разобралось в код. */
  error: string | null;
  /** Класс отказа. `null`, пока всё в порядке. */
  errorCode: ChatSessionErrorCode | null;
  retry: () => void;
  /** Бросить начатую попытку и вернуться к «включить». Решение человека НЕ
   *  отменяет — в отличие от `disable()`. */
  cancel: () => void;
  /** Снять ключ с устройства и выключить чат. Явное действие с явной ценой. */
  disable: () => void;

  /** Готовый сеанс. `null` — пока нет. */
  session: ChatSession | null;
  /**
   * Код восстановления, который ОБЯЗАН быть показан прямо сейчас (кошелёк-
   * контракт, ключ только что заведён, второго случая показать может не
   * быть). `null` — показывать нечего: обычный кошелёк либо уже показывали.
   */
  recoveryCode: string | null;
  /** Ключ не лёг на устройство — см. `sessionStorageNotice`. */
  storageNotice: SessionStorageNotice | null;
}

/* ─────────────── когда именно заводить ключ (К-3) ─────────────────────── */

/**
 * Просьба завести ключ чата, если его на устройстве нет.
 *
 * ⚠️ ЗАЧЕМ ОНА ЕСТЬ. Хук открывал сеанс, как только появлялся адрес, а живёт
 * он в шапке — то есть НА КАЖДОЙ СТРАНИЦЕ. Человек заходил посмотреть доску
 * заказов, и кошелёк просил подписать что-то без объяснений (находка К-3).
 * Теперь ЧТЕНИЕ ключа происходит везде и молча (оно бесплатно), а ЗАВЕДЕНИЕ —
 * только после этой просьбы.
 *
 * Просьба глобальная, а не своя у каждого экземпляра хука, по той же причине,
 * по которой глобален привратник кода: `useChatSession()` живёт в нескольких
 * местах страницы сразу, и они обязаны согласиться. Зовут её обе половины
 * чата — открытая переписка и список, — то есть ровно те места, попадание в
 * которые и означает «человек пришёл в чат».
 *
 * Взводится ОДИН РАЗ за жизнь вкладки и не снимается: уйдя из чата на доску,
 * человек не должен терять уже заведённый ключ.
 */
let _armed = false;
const _armListeners = new Set<() => void>();

export function armChatSession(): void {
  if (_armed) return;
  _armed = true;
  for (const listener of _armListeners) {
    try { listener(); } catch { /* один плохой слушатель не ломает остальных */ }
  }
}

/** Только для тестов: вернуть невзведённое состояние. */
export function _resetChatSessionArm(): void {
  _armed = false;
  _armListeners.clear();
}

export function useChatSession(): UseChatSessionValue {
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();

  const [status, setStatus] = useState<ChatSessionStatus>('loading');
  const [session, setSession] = useState<ChatSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ChatSessionErrorCode | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const cancelledRef = useRef(false);
  // Взведён ли запрос на заведение ключа. Подписка — чтобы экземпляр,
  // смонтированный ДО прихода человека в чат (шапка, привратник), узнал о
  // просьбе и перечитал сеанс, а не остался с `session_absent` навсегда.
  const [armed, setArmed] = useState(_armed);
  useEffect(() => {
    if (_armed) { setArmed(true); return; }
    const listener = () => setArmed(true);
    _armListeners.add(listener);
    return () => { _armListeners.delete(listener); };
  }, []);

  useEffect(() => {
    if (!address) {
      setStatus('loading');
      setSession(null);
      setError(null);
      setErrorCode(null);
      return;
    }
    let dropped = false;
    cancelledRef.current = false;
    setStatus('loading');
    setError(null);
    setErrorCode(null);

    (async () => {
      try {
        // ⚠️ ЗАВОДИТЬ — только когда человек пришёл в чат И не отказывался
        // раньше. Чтение с устройства идёт всегда: оно бесплатно и молчаливо,
        // и тот, у кого ключ уже есть, не должен подписывать ничего ни на
        // одной странице.
        const mayCreate = armed && !isChatDeclined(address);
        const opened = await openSession(address, (typedData) => {
          // Типизированные данные пробрасываются КАК ЕСТЬ — не собираются
          // заново: иначе появился бы второй источник истины о том, из чего
          // выводится ключ (разбор — в шапке `chatCrypto.ts`).
          if (typedData !== CHAT_KEY_TYPED_DATA) {
            throw new Error('useChatSession: сеанс попросил подписать не свои же данные');
          }
          // Через `signChatKeyLocked` — общий мьютекс кошелька (В-1). Прямой
          // вызов здесь означал бы второй путь к окну подписи вне очереди.
          return signChatKeyLocked(
            address,
            (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]) as Promise<`0x${string}`>,
          );
        }, { createIfMissing: mayCreate });
        if (dropped || cancelledRef.current) return;
        setSession(opened);
        // Код показывается ТОЛЬКО когда он только что заведён: у
        // восстановленного с устройства сеанса человек его уже видел, и
        // выкидывать двенадцать слов на экран заново — не забота, а утечка.
        setRecoveryCode(opened.origin === 'recovery' && !opened.restored ? exportRecoveryCode(opened) : null);
        setStatus('ready');
      } catch (err) {
        if (dropped || cancelledRef.current) return;
        // Отказ ЧЕЛОВЕКА помнится: спрашивать его снова на каждой странице —
        // это не уважение к выбору, а «оно сломано и лезет». Снимается
        // явным нажатием «включить» (`retry`). Поломка кошелька или сети
        // отказом НЕ считается — иначе моргнувшая сеть заперла бы чат.
        if (isUserDecline(err)) rememberChatDecline(address);
        setStatus('error');
        setErrorCode(err instanceof ChatSessionError ? err.code : null);
        setError(err instanceof Error ? err.message : 'Не удалось открыть переписку');
      }
    })();

    return () => { dropped = true; };
  }, [address, signTypedDataAsync, retryKey, armed]);

  const retry = useCallback(() => {
    cancelledRef.current = false;
    // Нажатие «включить мессенджер» — это и есть просьба завести ключ, и
    // одновременно снятие прежнего отказа. Без первого нажатие не сделало бы
    // ничего на странице, где чат ещё не просили; без второго — не сделало бы
    // ничего у того, кто однажды отказался.
    forgetChatDecline(address);
    armChatSession();
    setArmed(true);
    setRetryKey(k => k + 1);
  }, [address]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setStatus('error');
    setErrorCode(null);
    setError(null);
  }, []);

  const disable = useCallback(() => {
    cancelledRef.current = true;
    setSession(null);
    setRecoveryCode(null);
    setStatus('error');
    if (address) void forgetSession(address).catch(() => { /* уборка не важнее самого решения */ });
  }, [address]);

  return {
    status, error, errorCode, retry, cancel, disable,
    session, recoveryCode,
    storageNotice: session ? sessionStorageNotice(session) : null,
  };
}
