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
import {
  ChatDirectoryError, CHAT_PUBLIC_KEY_LEN, KEY_HEX_RE, toKeyHex, fromKeyHex,
  type ChatDirectoryErrorCode, type PeerChatKeys,
} from '@/lib/chatDirectoryTypes';
import {
  cachedChatKeyAttestation, forgetChatKeyAttestation, parseChatKeyAttestation,
  type ChatKeyAttestation,
} from '@/lib/chatKeyAttestation';
import { withWalletLock } from '@/lib/walletLock';
import { noteWalletHandoff, requireSignatureGate, ChatSignatureDeferred } from '@/lib/chatSignatureGate';
import { mailboxWorthPollingFor } from '@/lib/chatAnnounceStore';
import { isChatDeclined, rememberChatDecline, forgetChatDecline, isUserDecline } from '@/lib/chatDecline';
import {
  publishChatSession, forgetPublishedSession, publishedChatSession, subscribeChatSession,
} from '@/lib/chatSessionStore';

/* ────────────────────────── справочник ключей ─────────────────────────── */

/* Форма справочника переехала в `@/lib/chatDirectoryTypes` — разбор причины в
 * шапке того файла (кольцо импортов через порог пропуска). Здесь — переэкспорт,
 * чтобы прежние импорты по всему фронту продолжали работать. */
export {
  ChatDirectoryError, CHAT_PUBLIC_KEY_LEN, toKeyHex, fromKeyHex, KEY_HEX_RE,
} from '@/lib/chatDirectoryTypes';
export type { ChatDirectoryErrorCode, PeerChatKeys } from '@/lib/chatDirectoryTypes';

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

/** Отказ именно про заверение? Тело читается ТОЛЬКО на этой ветке — на всех
 *  остальных его читает `directoryFailure`, и отобрать у неё тело значило бы
 *  потерять код отказа там, где вся дисциплина про имена отказов. */
async function refusedAttestation(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.json();
    return !!body && typeof body === 'object'
      && (body as { code?: unknown }).code === 'invalid_attestation';
  } catch {
    return false;
  }
}

/**
 * Кладёт в справочник ОБЕ открытые половины сеанса — и заверение кошельком,
 * если оно есть на устройстве.
 *
 * Адрес сервер берёт ИЗ ПРОПУСКА, не из тела — положить ключ за другого нельзя
 * (правило 1 Задачи 2). Поэтому сюда приходит `pass`, а не адрес.
 *
 * Байт-в-байт повторная публикация на сервере — ранний возврат без записи на
 * диск (`relayer/directory.js`), так что звать это на каждом открытии сеанса
 * дёшево и намеренно: устройство, где ключ уже лежал, всё равно обязано
 * убедиться, что справочник о нём знает.
 *
 * ⚠️ ПОДПИСИ ЗДЕСЬ НЕ ПРОСЯТ НИКОГДА. Заверение только ЧИТАЕТСЯ из кладовой:
 * эта функция зовётся на каждом открытии сеанса, и окно кошелька в ней
 * означало бы подпись при каждом заходе (и петлю на Android — два
 * автоподписания, столкнувшихся после выгрузки вкладки, 31 июля). Подписывает
 * `ensureChatKeyAttestation`, по нажатию человека.
 *
 * ⚠️ ОТКАЗ СПРАВОЧНИКА ИМЕННО ПРО ЗАВЕРЕНИЕ НЕ СМЕЕТ СТОИТЬ ЧЕЛОВЕКУ САМОГО
 * ОБЪЯВЛЕНИЯ. `POST /keys` — единственная дорога объявить ключ; не пройдёт
 * она, и человеку не сможет написать никто, при том что чат у него выглядит
 * работающим. Поэтому: повторить без заверения, негодное снять с устройства,
 * сказать в журнал. Молчать нельзя — иначе «сломалось» неотличимо от
 * «сработало».
 */
export async function publishChatKeys(
  pass: string,
  session: ChatSession,
  signal?: AbortSignal,
): Promise<void> {
  const signer = await deriveLinkSigningKeypair(session.keypair);
  const keys = {
    boxKey: toKeyHex(session.keypair.publicKey),
    signKey: toKeyHex(signer.publicKey),
  };
  const attestation = await cachedChatKeyAttestation(session);

  const send = (body: unknown) => fetch(`${RELAYER_URL}/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bag-pass': pass },
    body: JSON.stringify(body),
    signal,
  });

  const res = await send(attestation ? { ...keys, attestation } : keys);
  if (res.ok) return;

  if (attestation && res.status === 400 && await refusedAttestation(res)) {
    forgetChatKeyAttestation(session.address);
    const bare = await send(keys);
    if (!bare.ok) await directoryFailure(bare, 'Не удалось опубликовать открытые ключи чата');
    console.warn('[chat] справочник отверг заверение ключей — ключи объявлены без него, заверение снято с устройства');
    return;
  }

  await directoryFailure(res, 'Не удалось опубликовать открытые ключи чата');
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

  // Заверение — данные из сети, и МУСОР В ОДНОМ ЗВЕНЕ не повод потерять
  // остальные: битое заверение прежней пары не должно стоить человеку
  // проверяемости нынешней.
  const attestation = parseChatKeyAttestation(rec.attestation);
  const attestationHistory: ChatKeyAttestation[] = [];
  if (Array.isArray(rec.history)) {
    for (const entry of rec.history) {
      const parsed = parseChatKeyAttestation((entry as Record<string, unknown> | null)?.attestation);
      if (parsed) attestationHistory.push(parsed);
    }
  }

  return {
    boxKey: fromKeyHex(rec.boxKey, 'ключ запечатывания'),
    signKey, signKeyHistory: history,
    attestation, attestationHistory,
  };
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
  onSigning?: (busy: boolean) => void,
  humanAsked = false,
): Promise<`0x${string}`> {
  return withWalletLock(address, async () => {
    // ⚠️ `onSigning` — ровно вокруг вызова кошелька, как у `getBagPass` ниже, и
    // по той же причине. Без него отображение не может отличить «читаем ключ с
    // устройства» (миллисекунды) от «висит окно кошелька» (в установленном
    // приложении — минуты): наружу и то, и другое выглядело как `status:
    // 'loading'`, и панель крутила спиннер «Подключение…» без слова о том, что
    // от человека чего-то ждут. Живая выкатка 8 августа: человек ушёл именно с
    // этого экрана.
    //
    // `false` ставится в `finally`, чтобы отказ человека подписать не оставил
    // экран с вечным «подпишите».
    // ⚠️ ПОРОГ СТОИТ ВНУТРИ ЗАМКА, а не перед ним. Пока мы ждём своей очереди у
    // кошелька (страница сделки, профиль, пуши), приложение успевает свернуться
    // — и решение, принятое до ожидания, к этому моменту устарело бы.
    requireSignatureGate(humanAsked);
    noteWalletHandoff();
    onSigning?.(true);
    try {
      return await signTypedDataAsync(CHAT_KEY_TYPED_DATA);
    } finally {
      onSigning?.(false);
    }
  });
}

/**
 * @param opts.humanAsked человек нажал кнопку. Прямое действие проходит порог:
 *   нажать по невидимой кнопке нельзя, значит страница жива и на переднем плане.
 *   ⚠️ Сюда обязано приезжать НАСТОЯЩЕЕ нажатие, а не `true` «чтобы работало»:
 *   подставив его из автоматики, мы вернём подпись в спящую страницу и замеры
 *   `chatPhoneSignature.test.ts` покраснеют.
 * @param opts.purpose зачем пропуск. `'mailbox'` (умолчание) — забрать мешки:
 *   такой пропуск НЕ БЕРЁТСЯ, пока наш ключ не объявлен, потому что запечатать
 *   нам нельзя ничего и на складе для нас нет ни одного мешка. `'announce'` —
 *   ради самой записи в справочник: этот порог к нему не применяется, иначе
 *   вышло бы кольцо (объявиться нельзя без пропуска, пропуск нельзя без
 *   объявления).
 *
 * ⚠️ ПОЧЕМУ ПОРОГ ЯЩИКА СТОИТ ЗДЕСЬ, А НЕ В ХУКАХ. Первая версия проверяла это в
 * `usePairChat` и в `usePairConversations` — по одной строке в каждом. Мутации
 * «снять проверку из открытой переписки» и «снять из списка» проходили ЗЕЛЁНЫМИ
 * на 73 замерах: у фронта нет jsdom, отрисовать хук нечем, и проводка внутри него
 * не сторожится НИЧЕМ. Здесь проверка одна, стоит на единственной дороге к
 * пропуску и мерится напрямую.
 */
export async function getBagPass(
  address: `0x${string}`,
  signMessageAsync: (args: { message: string }) => Promise<string>,
  onSigning?: (busy: boolean) => void,
  opts: { humanAsked?: boolean; purpose?: 'mailbox' | 'announce' } = {},
): Promise<string> {
  if ((opts.purpose ?? 'mailbox') === 'mailbox' && !mailboxWorthPollingFor(address)) {
    throw new ChatSignatureDeferred('not_announced');
  }
  return withWalletLock(address, async () => {
    const pass = await requestBagPass(async (message) => {
      // ⚠️ ПОРОГ ЗДЕСЬ, ВНУТРИ КОЛБЭКА, — И ЭТО ГЛАВНОЕ РЕШЕНИЕ ФАЙЛА.
      // `requestBagPass` зовёт этот колбэк ТОЛЬКО когда пропуска нет и его
      // правда надо подписывать. Поставив порог этажом выше, мы отказали бы и
      // тем, у кого пропуск живой (12 часов в `localStorage`) — то есть
      // большинству заходов, где никакого окна кошелька и не намечалось.
      requireSignatureGate(opts.humanAsked);
      noteWalletHandoff();
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
  /**
   * Снять ключ с устройства и выключить чат.
   *
   * ⚠️ БЕЗ `acknowledged` НЕ ДЕЛАЕТ НИЧЕГО, и подтверждение сюда обязано
   * ПРИЕХАТЬ ОТ ПОДТВЕРЖДЕНИЯ, а не сочиняться здесь. Иначе охрана
   * возвращается туда, откуда её уже обошли: `onClick={() => disable()}`
   * снимал ключ одним нажатием, и 1338 тестов молчали.
   *
   * @returns сняли или нет — чтобы вызывающий не считал молчание согласием.
   */
  disable: (opts?: { acknowledged?: boolean }) => boolean;

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
  /**
   * Окно кошелька за ПОДПИСЬЮ КЛЮЧА ПЕРЕПИСКИ открыто прямо сейчас.
   *
   * Второй признак рядом с `passSignaturePending` у `usePairChat`, и они разные
   * по смыслу: та подпись берёт пропуск к складу, эта выводит ключ. Причины
   * разные, значит и слова человеку разные (`chat.signature_wanted_key` против
   * `chat.signature_wanted_pass`) — свести их в один признак значило бы
   * объяснить не то, чего ждут.
   */
  keySignaturePending: boolean;
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

  // ⚠️ НАЧАЛЬНОЕ ЗНАЧЕНИЕ — ИЗ ОБЩЕГО СКЛАДА, а не `null`. Экземпляр,
  // смонтированный после того, как ключ уже завели (меню в шапке после перехода
  // на другую страницу, панель переписки, привратник кода), обязан знать факт
  // сразу, а не выяснять его заново.
  const [status, setStatus] = useState<ChatSessionStatus>(
    () => (publishedChatSession(address) ? 'ready' : 'loading'),
  );
  const [session, setSession] = useState<ChatSession | null>(() => publishedChatSession(address));
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ChatSessionErrorCode | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [keySignaturePending, setKeySignaturePending] = useState(false);
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

  /**
   * ⚠️ КЛЮЧ — ОБЩИЙ ФАКТ, И ЭТО ПРАВКА, НАЙДЕННАЯ НА ЖИВОМ ТЕЛЕФОНЕ.
   *
   * Замер 9 августа: чат работает, ключ на устройстве и объявлен, а меню
   * кошелька в шапке пишет «Подключить мессенджер». Причина не в меню: у ЕГО
   * экземпляра этого хука сеанса нет. Экземпляр спросил ключ на доске заказов,
   * не нашёл (заводить там нельзя — К-3), получил `error`, а потом человек завёл
   * ключ в чате — и шапка об этом не узнала НИКОГДА: её эффект зависит от
   * адреса, подписывателя и просьбы завести ключ, а не изменилось ни одно из
   * трёх. До перемонтирования, то есть до перехода на другую страницу.
   *
   * Та же беда давала вторую жалобу — «кнопка появляется, только если со
   * страницы перешелкнуть»: экземпляр внутри `useKeyAnnouncement` застревал так
   * же, а без сеанса кнопки нет по построению.
   *
   * Разбор и замеры — `lib/chatSessionStore.ts` и `lib/walletMenuChat.test.ts`.
   */
  useEffect(() => subscribeChatSession(() => {
    const shared = publishedChatSession(address);
    if (shared) {
      setSession(prev => (prev === shared ? prev : shared));
      setStatus('ready');
      setError(null);
      setErrorCode(null);
    } else {
      // Ключ сняли (человек выключил чат) — узнают все, а не только то место,
      // где нажали.
      setSession(prev => (prev === null ? prev : null));
      setStatus(prev => (prev === 'ready' ? 'error' : prev));
    }
  }), [address]);

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
            setKeySignaturePending,
          );
        }, { createIfMissing: mayCreate });
        if (dropped || cancelledRef.current) return;
        setSession(opened);
        // Сказать всем: ключ на устройстве есть. Без этой строки соседние места
        // страницы остаются со своим прежним «его нет» до перемонтирования.
        publishChatSession(address, opened);
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

  const disable = useCallback((opts: { acknowledged?: boolean } = {}) => {
    // Отказ ЗАКРЫТЫЙ: не сказавший про подтверждение не снимает ничего.
    // Сама `forgetSession` откажет и так, но экран не должен при этом
    // делать вид, что чат выключен.
    if (!opts.acknowledged) return false;
    cancelledRef.current = true;
    setSession(null);
    setRecoveryCode(null);
    setStatus('error');
    // ⚠️ ПОДТВЕРЖДЕНИЕ ПРОБРАСЫВАЕТСЯ, А НЕ СОЧИНЯЕТСЯ ЗДЕСЬ. Замерено:
    // если хук подставляет `true` сам, то снятие его собственной проверки
    // выше снова стирает ключ — и ни один тест не краснеет (мутация М-64).
    // С пробросом нижний слой (`forgetSession`) отказывает всё равно:
    // охрана держится, даже когда её сняли этажом выше.
    if (address) {
      forgetPublishedSession(address);
      void forgetSession(address, { acknowledged: opts.acknowledged })
        .catch(() => { /* уборка не важнее самого решения */ });
    }
    return true;
  }, [address]);

  return {
    status, error, errorCode, retry, cancel, disable,
    session, recoveryCode,
    storageNotice: session ? sessionStorageNotice(session) : null,
    keySignaturePending,
  };
}
