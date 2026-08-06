'use client';

/**
 * usePairChat.ts — одна переписка: опрос, приём, порядок, отправка.
 *
 * Внутренности заменены целиком (Задача 6 плана «Клиент чата»): вместо XMTP
 * — наш склад мешков (`chatTransport.ts`), наш конверт (`chatEnvelope.ts`),
 * наш сеанс (`chatSession.ts`) и наш разговор (`chatConversation.ts`).
 * НАРУЖНЫЙ ВИД СОХРАНЁН: `ChatPanel.tsx` не должен заметить подмены —
 * пересадка вида это Задача 7.
 *
 * ─── ПОЧЕМУ ДВИЖОК ОТДЕЛЬНО ОТ ХУКА ─────────────────────────────────────
 *
 * У фронта нет ни jsdom, ни @testing-library: `npm test` берёт vitest у
 * релеера, окружение `node`. Отрисовать хук и проверить его эффекты НЕЧЕМ.
 * Поэтому вся логика живёт в `startPairChat()` — обычной функции без React,
 * запертой замерами (`usePairChat.test.ts`), а хук сведён к состоянию и
 * ОДНОМУ вызову `stop()` в уборке эффекта. Всё, что нельзя проверить,
 * обязано быть тривиальным — не наоборот.
 *
 * ─── ЧТО ДЕЛАЕТ ДВИЖОК ЗА ОДИН ТИК ──────────────────────────────────────
 *
 *   опрос склада (курсор двигается сам) → скачать ТОЛЬКО новые мешки →
 *   разобрать ВСЁ накопленное (`receiveBags`) → отдать наверх
 *
 * Разбирается всегда весь накопленный набор, а не только новинки: цепочка
 * проверяется целиком, и вердикт по половине переписки — не вердикт.
 * Скачивается при этом каждый мешок ровно один раз — на этом и стоит смысл
 * курсора.
 *
 * ─── ГАЛОЧКА «ДОШЛО» НАКАПЛИВАЕТСЯ, А НЕ ПЕРЕЧИТЫВАЕТСЯ ─────────────────
 *
 * `sent[]` сервер фильтрует тем же `since`, что и `inbox`. Значит мешок,
 * забранный собеседником ДАВНО, из ответа со временем уходит. Если бы
 * галочка бралась из последнего ответа как есть, она бы ПРОПАДАЛА у старых
 * сообщений — «дошло» превращалось бы в «неизвестно» само собой. Поэтому
 * множество доставленных только пополняется.
 *
 * ─── ЧЕГО ДВИЖОК НЕ ДЕЛАЕТ ──────────────────────────────────────────────
 *
 *  - НЕ ходит за пропуском сам: `getPass` приходит снаружи. Уметь ходить
 *    значило бы уметь открывать окно кошелька из глубины опроса.
 *  - НЕ грузит вложения: файл шифруется и кладётся на склад ВЫШЕ (хук),
 *    сюда приезжает уже готовым `ChatPayload.file`. Так `fileStorage.ts` не
 *    попадает в движок, а движок остаётся проверяемым в `node`.
 *  - НЕ отменяет отправку на `stop()`. Разбор — в докстринге `putBag`:
 *    оборванная отправка оставляет сгоревший номер, то есть дыру, которую
 *    собеседник видит как утаивание. Экономия одного запроса того не стоит.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import {
  fetchBag, pollBags,
  BagTransportError,
  type BagPollHandle, type BagPollIntervalsMs, type ListBagsResult,
} from '@/lib/chatTransport';
import {
  sendMessage, receiveBags,
  type IncomingBag, type SentMessage, type ConversationTrouble,
} from '@/lib/chatConversation';
import type { ChatPayload } from '@/lib/chatPayloadForm';
import type { ChatSession } from '@/lib/chatSession';
import {
  useChatSession, fetchPeerChatKeys, publishChatKeys, getBagPass,
  ChatDirectoryError, type PeerChatKeys,
} from './useChatSession';
import { uploadFileWithEncryption } from '@/lib/fileStorage';
import { notifyPush } from '@/lib/webpush';

/* ─────────────────────────── наружная форма ───────────────────────────── */

/**
 * Сообщение в том виде, в каком его рисует `ChatPanel.tsx`. Форма выросла из
 * прежнего `ChatMessage` XMTP-обвязки (файл удалён в Задаче 7) и добавила два
 * поля, которых у XMTP не было и быть не могло:
 *
 *  - `seq` — номер звена в цепочке ОТПРАВИТЕЛЯ. По нему панель ставит значок
 *    разрыва: `gapAfterSeq` называет номера, а не идентификаторы.
 *  - `delivered` — «дошло до устройства». Одна галочка, не две: прочтение
 *    глазами сервер не видит и видеть не должен (§3.3 спеки плана).
 */
export interface PairChatMessage {
  id: string;
  from: string;
  text: string;
  timestamp: number;
  isFromMe: boolean;
  /** Номер звена в цепочке отправителя. */
  seq: number;
  /** Мешок забран получателем. У ЧУЖИХ сообщений всегда `true` — они уже у
   *  нас; у своих — по ответу склада. «Неизвестно» и «дошло» не смешиваются:
   *  всё, чего склад не подтвердил, остаётся недошедшим. */
  delivered: boolean;
  attachment?: {
    name: string;
    url: string;
    fileKey?: string;
    size?: number;
    mime?: string;
    key?: string;
    iv?: string;
    chunked?: boolean;
    chunkCount?: number;
    chunkSize?: number;
  };
}

/**
 * Претензия движка в той форме, которая нужна разбору ниже. Своя структурная
 * форма, а не импорт `ConversationTrouble`: разбору важен ТОЛЬКО род, и
 * привязка к полному типу заставляла бы тест собирать поля, на которые никто
 * не смотрит.
 */
export interface ConversationTroubleLike { kind: string }

/**
 * Два признака, и они РАЗНЫЕ ПО СМЫСЛУ — смешивать их нельзя.
 *
 *  - `chainUnverified` — предъявленное НЕ ЗАСЛУЖИВАЕТ ДОВЕРИЯ: подпись не
 *    сходится, отпечаток тела не сходится, подписной ключ не тот, отправитель
 *    не тот, номер задвоен, кадр не разбирается. Это про подлинность.
 *  - `undecryptable` — звено ЧЕСТНОЕ, но наш ключ его не открывает
 *    (собеседник запечатал на прежний открытый ключ). Это про нас, а не про
 *    него, и говорить тут «подделка» значило бы обвинить человека в чужой
 *    беде.
 *
 * ⚠️ ЗАЧЕМ ЭТО ВООБЩЕ ВЫВЕДЕНО НАВЕРХ. Замерено до правки: цепочка
 * собеседника, переписанная чужим ключом, отвергается ЦЕЛИКОМ — ноль
 * сообщений, пустой `gapAfterSeq`. Панель в этом состоянии рисовала
 * «Сообщений пока нет», то есть УТВЕРЖДАЛА обратное тому, что произошло.
 */
export interface TroubleSummary {
  chainUnverified: boolean;
  undecryptable: boolean;
}

/** Роды претензий, означающие «предъявленному верить нельзя». Перечислены
 *  ЯВНО, а не «всё, что не undecryptable»: новый род претензии обязан быть
 *  отнесён руками, иначе он молча попал бы в самую мягкую формулировку. */
const UNVERIFIED_KINDS: ReadonlySet<string> = new Set([
  'malformed', 'sender_mismatch', 'body_mismatch', 'bad_signature',
  'signer_unexpected', 'signer_changed', 'duplicate_seq',
]);

export function troubleSummary(troubles: readonly ConversationTroubleLike[]): TroubleSummary {
  let chainUnverified = false;
  let undecryptable = false;
  for (const t of troubles) {
    if (t.kind === 'undecryptable') undecryptable = true;
    else if (UNVERIFIED_KINDS.has(t.kind)) chainUnverified = true;
  }
  return { chainUnverified, undecryptable };
}

export interface PairChatState {
  messages: PairChatMessage[];
  /** Номера, ПОСЛЕ которых чего-то не хватает; `-1` — не предъявлено начало. */
  gapAfterSeq: number[];
  troubles: ConversationTrouble[];
  /** `false` — собеседник ни разу не заходил, писать ему некуда. */
  peerKnown: boolean;
}

/* ──────────────────────────────── движок ──────────────────────────────── */

export interface PairChatEngineOptions {
  session: ChatSession;
  peer: `0x${string}`;
  /** Свежий пропуск склада. Обычно обёртка над `requestBagPass`. */
  getPass: () => Promise<string>;
  /** true — чат открыт (5 с), false — фон (30 с). */
  isActive?: () => boolean;
  onState: (state: PairChatState) => void;
  onError?: (err: unknown) => void;
  /** Опрос остановлен, пропуск не восстанавливается. */
  onAuthFailed?: () => void;
  /**
   * Приехало хотя бы одно НОВОЕ входящее сообщение на этом тике. Зовётся
   * только тогда, не на каждом тике.
   *
   * ⚠️ Существует ради списка переписок. Событие `hexseal-conv-update`
   * посылали ровно два файла XMTP, и оба снесены Задачей 7 — то есть
   * мгновенное обновление списка молча выродилось бы в тридцатисекундное
   * ожидание, и заметил бы это только человек, глядя на экран. Обратный
   * вызов, а не `window.dispatchEvent` прямо отсюда: движок про DOM не
   * знает и не должен (иначе его нельзя было бы проверить вне браузера).
   */
  onIncoming?: () => void;
  /** Только тесты. Умолчания и есть боевое поведение. */
  sleep?: (ms: number) => Promise<void>;
  intervals?: BagPollIntervalsMs;
}

export interface PairChatEngine {
  /** Останавливает опрос и обрывает ВСЁ в полёте (список и скачивания). */
  stop(): void;
  /** Отправляет готовый payload. Бросает `ChatConversationError` с `.code`. */
  send(payload: ChatPayload): Promise<PairChatMessage>;
  /** Сколько скачиваний движок начал и ещё не закончил. Для замеров. */
  inFlight(): number;
}

function payloadToMessage(
  payload: ChatPayload, from: string, seq: number, sentAt: number,
  isFromMe: boolean, delivered: boolean,
): PairChatMessage {
  return {
    id: `${from}-${seq}`,
    from,
    text: payload.text ?? payload.file?.name ?? '',
    timestamp: sentAt,
    isFromMe,
    seq,
    delivered,
    // Все девять полей, а не пять (В-3): признак нарезки, число и размер
    // кусков, ключ файла и тип содержимого молча терялись, и файл больше
    // 20 МБ приезжал битым. Необязательные поля кладутся ТОЛЬКО когда они
    // есть — иначе `chunked: undefined` отличалось бы от отсутствия ключа
    // при сравнении формы.
    ...(payload.file
      ? {
        attachment: {
          name: payload.file.name,
          url: payload.file.url,
          size: payload.file.size,
          key: payload.file.keyHex,
          iv: payload.file.ivHex,
          ...(payload.file.fileKey !== undefined ? { fileKey: payload.file.fileKey } : {}),
          ...(payload.file.mime !== undefined ? { mime: payload.file.mime } : {}),
          ...(payload.file.chunked !== undefined ? { chunked: payload.file.chunked } : {}),
          ...(payload.file.chunkCount !== undefined ? { chunkCount: payload.file.chunkCount } : {}),
          ...(payload.file.chunkSize !== undefined ? { chunkSize: payload.file.chunkSize } : {}),
        },
      }
      : {}),
  };
}

export function startPairChat(opts: PairChatEngineOptions): PairChatEngine {
  const own = opts.session.address.toLowerCase();
  const peer = opts.peer.toLowerCase() as `0x${string}`;

  // ОДИН контроллер на всю жизнь движка. Он и есть ответ на «уход со
  // страницы отменяет всё в полёте»: и перечисление (через pollBags), и
  // каждое скачивание держат ЭТОТ сигнал, а не свой собственный.
  const abort = new AbortController();
  let stopped = false;

  /** Всё скачанное за жизнь движка, по ключу мешка. Цепочка проверяется
   *  целиком — вердикт по половине переписки не вердикт. */
  const bags = new Map<string, IncomingBag>();
  /** Свои отправленные — чтобы разговор был разговором, а не половиной. */
  const ownSent: SentMessage[] = [];
  /** Только пополняется, см. шапку файла. */
  const delivered = new Set<string>();

  let peerKeys: PeerChatKeys | null = null;
  let peerKnown = true;
  let keysPublished = false;
  let downloads = 0;

  /** Ключи собеседника — один раз за жизнь движка, дальше из памяти. */
  async function ensurePeerKeys(): Promise<PeerChatKeys | null> {
    if (peerKeys) return peerKeys;
    try {
      peerKeys = await fetchPeerChatKeys(peer, abort.signal);
      peerKnown = true;
      return peerKeys;
    } catch (err) {
      if (err instanceof ChatDirectoryError && err.code === 'peer_unknown') {
        // Не поломка: у этой причины есть человеческое действие («пришлите
        // ему ссылку»). Смешать её с сетевым отказом значило бы показать
        // «что-то сломалось» там, где всё работает.
        peerKnown = false;
        return null;
      }
      throw err;
    }
  }

  /** Свои ключи в справочник — один раз. Повтор байт-в-байт сервер и так
   *  отбрасывает ранним возвратом, но лишний запрос каждые пять секунд
   *  незачем. */
  async function ensureOwnKeysPublished(pass: string): Promise<void> {
    if (keysPublished) return;
    await publishChatKeys(pass, opts.session, abort.signal);
    keysPublished = true;
  }

  async function emit(): Promise<void> {
    const pinned = peerKeys?.signKey ? { [peer]: peerKeys.signKey } : undefined;
    const state = await receiveBags(opts.session, [...bags.values()], {
      peer,
      ...(pinned ? { peerSigningPublicKeys: pinned } : {}),
      own: ownSent,
      deliveredKeys: [...delivered],
    });
    if (stopped) return;
    opts.onState({
      messages: state.messages.map(m =>
        payloadToMessage(m.payload, m.from, m.seq, m.sentAt, m.from.toLowerCase() === own, m.delivered)),
      gapAfterSeq: state.gapAfterSeq,
      troubles: state.troubles,
      peerKnown,
    });
  }

  /** Тики сериализуются: медленный разбор не должен наложиться на следующий
   *  и удвоить скачивания. */
  let chain: Promise<void> = Promise.resolve();

  async function handleTick(result: ListBagsResult, pass: string): Promise<void> {
    for (const s of result.sent) if (s.fetched) delivered.add(s.key);
    let arrived = 0;

    for (const summary of result.inbox) {
      if (stopped) return;
      // ⚠️ Честно: сегодня эта строка ничего не меняет — `pollBags` уже
      // отдаёт только новое (курсор плюс дедуп на границе миллисекунды), и
      // мутация «убрать её» не красит ни один замок. Оставлена вторым слоем
      // сознательно: настоящий дедуп заперт замерами уровнем ниже
      // (`chatTransportCursor.test.ts`), а здесь она стоит копейку и
      // страхует от регресса там. Утверждать, что она заперта, было бы
      // неправдой — поэтому сказано прямо.
      if (bags.has(summary.key)) continue;
      downloads++;
      try {
        const body = await fetchBag(pass, summary.key, abort.signal);
        // `null` — мешка нет (истёк, забрали, чужой ключ). Не повод падать и
        // не повод считать переписку сломанной: его место в цепочке всё равно
        // окажется дырой, и это честный вердикт.
        if (body) {
          bags.set(summary.key, {
            key: summary.key, sender: summary.sender,
            uploadedAt: summary.uploadedAt, body,
          });
          arrived++;
        }
      } finally {
        downloads--;
      }
    }
    if (stopped) return;
    await emit();
    // ПОСЛЕ выдачи состояния: список переписок пойдёт перечитывать превью, и
    // делать это раньше, чем сама переписка обновилась, незачем.
    if (arrived > 0) {
      try { opts.onIncoming?.(); } catch { /* чужой обработчик не должен ронять тик */ }
    }
  }

  const handle: BagPollHandle = pollBags({
    getPass: async () => {
      const pass = await opts.getPass();
      // Публикация своих ключей и добор чужих идут ВНУТРИ тика опроса
      // намеренно: у них тот же пропуск, та же отмена и тот же откат при
      // отказе, что у самого опроса — отдельная лестница повторов рядом с
      // существующей была бы вторым, несогласованным механизмом.
      await ensureOwnKeysPublished(pass);
      await ensurePeerKeys();
      return pass;
    },
    isActive: opts.isActive ?? (() => true),
    onBags: (result) => {
      chain = chain.then(async () => {
        if (stopped) return;
        const pass = await opts.getPass();
        await handleTick(result, pass);
      }).catch((err) => { if (!stopped) opts.onError?.(err); });
    },
    onError: (err) => { opts.onError?.(err); },
    onBagsError: (err) => { opts.onError?.(err); },
    ...(opts.onAuthFailed ? { onAuthFailed: opts.onAuthFailed } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.intervals ? { intervals: opts.intervals } : {}),
  });

  return {
    stop() {
      stopped = true;
      handle.stop();
      abort.abort();
    },
    inFlight: () => downloads,
    async send(payload: ChatPayload): Promise<PairChatMessage> {
      const pass = await opts.getPass();
      const keys = await ensurePeerKeys();
      if (!keys) {
        throw new ChatDirectoryError(
          'Собеседник ещё не заходил в переписку — писать ему пока некуда',
          'peer_unknown',
        );
      }
      const prev = ownSent.length > 0 ? ownSent[ownSent.length - 1].link : null;
      const sent = await sendMessage(opts.session, peer, keys.boxKey, payload, prev, { pass });
      ownSent.push(sent);
      await emit();
      // `delivered: false` — мешок только что положен, склад ещё не сказал,
      // что его забрали. Ставить здесь `true` значило бы рисовать галочку
      // «дошло» по факту УСПЕШНОЙ ОТПРАВКИ, то есть обещать за собеседника.
      return payloadToMessage(payload, own, sent.link.seq, sent.link.sentAt, true, false);
    },
  };
}

/* ──────────────────────────────── хук ─────────────────────────────────── */

/** Пережимает переходы между страницами — тот же приём, что был у прежней
 *  версии на XMTP. Ключ — `${мой}:${собеседник}`, не только собеседник:
 *  голый ключ собеседника однажды показал расшифрованную переписку одного
 *  аккаунта под другим после смены кошелька на том же устройстве. */
const _msgCache = new Map<string, PairChatMessage[]>();

/**
 * Тело пуш-уведомления. НЕ текст сообщения и НЕ имя файла — намеренно.
 *
 * ⚠️ ЭТО БЫЛА ДЫРА, И ОНА ПРОТИВОРЕЧИЛА БЕЙДЖУ. До 6 августа 2026 сюда
 * уезжал `text.trim()` и `📎 ${file.name}`: пуш идёт `POST /api/push` →
 * релеер → служба доставки, то есть содержимое сообщения покидало браузер
 * ОТКРЫТЫМ ТЕКСТОМ — по пути, к мешкам отношения не имеющему. Всё остальное
 * в этом плане пряталось от сервера, а превью уведомления отдавало его
 * добровольно.
 *
 * Экран теперь говорит «сервер не имеет ключей». Пока превью ехало открытым,
 * это было бы правдой про склад и ложью про человека.
 *
 * Цена честная и названная: в шторке ОС видно, что сообщение пришло, и не
 * видно, от кого и о чём. Так же поступает Signal по умолчанию. Английский
 * без перевода — язык получателя отправителю неизвестен, а придумать его за
 * него хуже, чем не угадать.
 */
const PUSH_BODY = 'New message';

export function usePairChat(peerAddress: string) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { status, session, storageNotice } = useChatSession();

  const peerLc = peerAddress.toLowerCase();
  const myLc = address?.toLowerCase() ?? '';
  const pairKey = `${myLc}:${peerLc}`;

  const [messages, setMessages] = useState<PairChatMessage[]>(() => _msgCache.get(pairKey) ?? []);
  const [isLoading, setIsLoading] = useState(() => (_msgCache.get(pairKey) ?? []).length === 0);
  const [isInitialized, setIsInitialized] = useState(() => (_msgCache.get(pairKey) ?? []).length > 0);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [gapAfterSeq, setGapAfterSeq] = useState<number[]>([]);
  const [peerKnown, setPeerKnown] = useState(true);
  const [troubles, setTroubles] = useState<TroubleSummary>({ chainUnverified: false, undecryptable: false });
  const [streamDead, setStreamDead] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  /** Окно кошелька за пропуском склада открыто ПРЯМО СЕЙЧАС. Ставится из
   *  `getBagPass`, вокруг самого вызова кошелька — см. его докстринг. */
  const [passSignaturePending, setPassSignaturePending] = useState(false);

  const engineRef = useRef<PairChatEngine | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    if (!address || !peerAddress || status !== 'ready' || !session) {
      setError(null);
      setIsLoading(false);
      return;
    }
    setError(null);
    setStreamDead(false);
    if (!_msgCache.has(pairKey)) setIsLoading(true);

    const engine = startPairChat({
      session,
      peer: peerAddress as `0x${string}`,
      // Единственное место подписи во всём чате — и оно под общим мьютексом
      // кошелька (`getBagPass`, см. его докстринг).
      getPass: () => getBagPass(address, signMessageAsync, setPassSignaturePending),
      isActive: () => activeRef.current,
      onState: (s) => {
        _msgCache.set(pairKey, s.messages);
        setMessages(s.messages);
        setGapAfterSeq(s.gapAfterSeq);
        setPeerKnown(s.peerKnown);
        setTroubles(troubleSummary(s.troubles));
        setIsInitialized(true);
        setIsLoading(false);
      },
      onError: (err) => {
        // Код отказа — отдельным полем, текст только как запасной вариант:
        // разбор английского запрещён прямым требованием плана.
        setError(err instanceof BagTransportError || err instanceof ChatDirectoryError
          ? (err.code ?? err.message)
          : err instanceof Error ? err.message : 'Chat error');
        setIsLoading(false);
      },
      onAuthFailed: () => { setStreamDead(true); },
      // Список переписок слушает это событие и перечитывает превью сразу, а
      // не через тридцать секунд. Его посылали два файла XMTP, снесённые
      // Задачей 7; движок обязан взять эту обязанность на себя, иначе
      // отзывчивость теряется молча.
      onIncoming: () => {
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('hexseal-conv-update'));
      },
    });
    engineRef.current = engine;

    // Единственная строка уборки — и она же весь смысл того, что движок
    // отдельный: одна отмена, обрывающая и перечисление, и скачивания.
    return () => { engine.stop(); engineRef.current = null; };
  }, [address, peerAddress, status, session, pairKey, signMessageAsync, retryKey]);

  // Вкладка ушла в фон — опрос переходит на 30 секунд. Читается на КАЖДОМ
  // тике (`isActive`), поэтому хватает ссылки: перезапускать движок ради
  // смены интервала незачем.
  useEffect(() => {
    const onVisibility = () => { activeRef.current = document.visibilityState === 'visible'; };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const sendMessageText = useCallback(async (text: string) => {
    const engine = engineRef.current;
    if (!engine || !text.trim()) return;
    await engine.send({ text: text.trim() });
    notifyPush(peerLc, PUSH_BODY, `/chat?peer=${myLc}`, `/chat?peer=${peerLc}`);
  }, [peerLc, myLc]);

  const sendFile = useCallback(async (file: File, signal?: AbortSignal) => {
    const engine = engineRef.current;
    if (!engine) throw new Error('Chat is not ready');
    setUploadProgress(0);
    let result: Awaited<ReturnType<typeof uploadFileWithEncryption>>;
    try {
      result = await uploadFileWithEncryption(
        file, file.name, setUploadProgress, signal,
        address ? { self: address, peer: peerAddress } : undefined,
      );
    } finally {
      setUploadProgress(null);
    }
    signal?.throwIfAborted();
    await engine.send({
      file: {
        url: result.url, name: file.name, size: file.size,
        keyHex: result.keyHex, ivHex: result.ivHex,
        // В-3: без этих пяти большой файл приезжает битым, картинка теряет
        // превью, а протухший адрес нечем обновить. `fileKey` кладём всегда
        // — он единственный способ обновить `url`, запечатанный в конверте.
        fileKey: result.fileKey,
        ...(file.type ? { mime: file.type } : {}),
        chunked: result.chunked === true,
        ...(result.chunkCount !== undefined ? { chunkCount: result.chunkCount } : {}),
        ...(result.chunkSize !== undefined ? { chunkSize: result.chunkSize } : {}),
      },
    });
    notifyPush(peerLc, PUSH_BODY, `/chat?peer=${myLc}`, `/chat?peer=${peerLc}`);
  }, [address, peerAddress, peerLc, myLc]);

  // ─── ЧЕГО ЗДЕСЬ БОЛЬШЕ НЕТ И ПОЧЕМУ ───────────────────────────────────
  //
  // Задача 6 оставила три пустышки ради того, чтобы `ChatPanel.tsx` собрался
  // без правок. Задача 7 их УБРАЛА, а не доделала — по каждой есть причина,
  // и ни одна из них не «руки не дошли»:
  //
  //  - `loadMore`/`hasMore` — склад отдаёт всё, что у него есть, ОДНИМ
  //    списком (`GET /bags`), страниц не существует. Пустая функция, которую
  //    зовёт кнопка, выглядит как работа: человек жмёт «загрузить старые» и
  //    не получает ничего, а винит связь. Кнопка убрана вместе с функцией.
  //  - `markDealContext` — метка сделки уезжала отдельным сообщением боту;
  //    теперь она едет ВНУТРИ запечатанного каждого сообщения
  //    (`ChatPayload.dealId`), и звать отдельно нечего.
  //  - `peerLastReadAt` — «прочитано глазами» серверу неизвестно и не должно
  //    быть известно. Осталась ОДНА галочка, и она в самих сообщениях
  //    (`PairChatMessage.delivered`).

  const reconnect = useCallback(() => {
    setStreamDead(false);
    setIsInitialized(false);
    setRetryKey(k => k + 1);
  }, []);

  return {
    messages, sendMessage: sendMessageText, sendFile,
    isLoading, isInitialized, error, uploadProgress,
    streamDead, reconnect, needsSetup: status !== 'ready',
    /** Разрывы в цепочке собеседника и «собеседник ещё не заходил». */
    gapAfterSeq, peerKnown,
    /** Предъявленному верить нельзя (подпись, отпечаток, ключ, номер). */
    chainUnverified: troubles.chainUnverified,
    /** Честное звено, которое не открывается нашим ключом. */
    undecryptable: troubles.undecryptable,
    /** Окно кошелька за пропуском склада открыто прямо сейчас. */
    passSignaturePending,
    /** Ключ переписки не лёг на устройство — см. `sessionStorageNotice`. */
    storageNotice,
  };
}
