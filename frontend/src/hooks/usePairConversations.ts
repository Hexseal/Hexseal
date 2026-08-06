'use client';

/**
 * usePairConversations.ts — список переписок.
 *
 * Внутренности заменены целиком (Задача 6 плана «Клиент чата»): вместо
 * локальной базы XMTP — один запрос `GET /bags`, тот самый, который и так
 * ходит на каждом тике опроса. Наружный вид сохранён: `app/chat/page.tsx`
 * не должен заметить подмены.
 *
 * ─── ОТКУДА БЕРЁТСЯ СПИСОК ──────────────────────────────────────────────
 *
 * Из поля `peers` ответа склада (Задача 1): там ровно те, с кем у владельца
 * пропуска есть хоть один мешок в любую сторону. Не «все, кого сервер
 * знает» и не «все, кому я когда-либо открывал вкладку» — прежняя версия
 * этого хука как раз и вычищала фантомные строки, которые появлялись просто
 * от открытия `/chat?peer=X`.
 *
 * ─── ПРЕВЬЮ СТОИТ РАСШИФРОВКИ, И ЭТО НАМЕРЕННО ──────────────────────────
 *
 * Сервер не знает, что в мешке — значит текст последнего сообщения можно
 * получить только скачав и вскрыв его. Скачивается РОВНО ОДИН мешок на
 * собеседника (самый свежий), а не вся переписка: список из десяти
 * собеседников стоит одиннадцать запросов, а не десять переписок.
 *
 * Альтернатива — писать в превью «зашифровано» — была отвергнута: список
 * без превью перестаёт быть списком, по нему нельзя понять, куда идти.
 *
 * ⚠️ Собеседник БЕЗ единого читаемого мешка (истёк срок хранения, мешок
 * запечатан на прежний ключ) остаётся в списке с пустым превью. Убрать его
 * значило бы, что переписка «исчезла» на глазах у человека — она на месте,
 * просто предъявить из неё нечего.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { listBags, fetchBag, BagPassError, type BagSummary } from '@/lib/chatTransport';
import { receiveBags, type IncomingBag } from '@/lib/chatConversation';
import type { ChatSession } from '@/lib/chatSession';
import { useChatSession, getBagPass } from './useChatSession';

/**
 * Строка списка в том виде, в каком её ждёт `app/chat/page.tsx`. Форма
 * совпадает с прежним `PairConversation` из `lib/xmtp.ts`, кроме `group` —
 * поле было объектом группы MLS, потребитель его не читал НИ РАЗУ и даже
 * подставлял `null as any` для своих собственных строк. Оставлено
 * необязательным, чтобы тот код собрался без правок; Задача 7 его убирает.
 */
export interface PairConversation {
  peerAddress: string;
  lastText: string;
  lastAt: number;
  lastFromMe: boolean;
  /** @deprecated наследство XMTP, никем не читается. */
  group?: unknown;
}

/**
 * Собирает список переписок: один запрос списка плюс по одному скачиванию на
 * собеседника ради превью.
 *
 * Ошибки скачивания и разбора ОДНОГО собеседника не роняют весь список:
 * битый мешок не должен стоить человеку всех его переписок.
 */
export async function loadPairConversations(
  session: ChatSession,
  pass: string,
  signal?: AbortSignal,
): Promise<PairConversation[]> {
  const { inbox, sent, peers } = await listBags(pass, undefined, signal);

  // Самый свежий ВХОДЯЩИЙ мешок на собеседника — только его и качаем.
  const newestFrom = new Map<string, BagSummary>();
  for (const b of inbox) {
    const from = b.sender.toLowerCase();
    const prev = newestFrom.get(from);
    if (!prev || b.uploadedAt > prev.uploadedAt) newestFrom.set(from, b);
  }
  // И самый свежий ИСХОДЯЩИЙ — чтобы «последнее слово за мной» отличалось от
  // «последнее слово за ним» без чтения чужих мешков.
  const newestTo = new Map<string, number>();
  for (const s of sent) {
    const to = s.recipient.toLowerCase();
    const prev = newestTo.get(to) ?? 0;
    if (s.uploadedAt > prev) newestTo.set(to, s.uploadedAt);
  }

  const rows: PairConversation[] = [];
  for (const peer of peers) {
    const addr = peer.address.toLowerCase();
    const summary = newestFrom.get(addr);
    let lastText = '';
    let lastAt = 0;
    let lastFromMe = false;

    if (summary) {
      try {
        const body = await fetchBag(pass, summary.key, signal);
        if (body) {
          const bag: IncomingBag = {
            key: summary.key, sender: summary.sender,
            uploadedAt: summary.uploadedAt, body,
          };
          const state = await receiveBags(session, [bag], { peer: addr as `0x${string}` });
          const last = state.messages[state.messages.length - 1];
          if (last) {
            lastText = last.payload.text ?? last.payload.file?.name ?? '';
            lastAt = last.sentAt;
          }
        }
      } catch (err) {
        // Отмена — не «сломанная строка», а уход со страницы: пробрасываем,
        // чтобы вызывающий не принял оборванную загрузку за пустой список.
        if ((err as { name?: string })?.name === 'AbortError') throw err;
        console.warn('[usePairConversations] превью переписки не собралось', err);
      }
    }

    const sentAt = newestTo.get(addr) ?? 0;
    if (sentAt > lastAt) { lastAt = sentAt; lastFromMe = true; lastText = ''; }
    // Ни одного собственного признака времени не нашлось — берём то, что
    // сказал сервер. Это НЕ время сообщения, а «когда собеседник последний
    // раз тронул что-то моё» (см. `PeerSummary`), поэтому оно только
    // запасное.
    if (lastAt === 0 && peer.lastActivityWithMeAt) lastAt = peer.lastActivityWithMeAt;

    rows.push({ peerAddress: addr, lastText, lastAt, lastFromMe });
  }

  // Свежие сверху — та же сортировка, что была у версии на XMTP.
  return rows.sort((a, b) => b.lastAt - a.lastAt);
}

/* ─────────────── предел неудач входа для СВОЕГО цикла ─────────────────── */

/**
 * Сколько подряд идущих НЕУДАЧ ВХОДА терпеть, прежде чем остановиться.
 *
 * ⚠️ ЗАЧЕМ ЭТО ЗДЕСЬ ВООБЩЕ. Шапка `chatTransport.ts` запрещает свой цикл
 * опроса ДОСЛОВНО: «Если вы пишете СВОЙ цикл опроса поверх `listBags`/
 * `getPass` вместо `pollBags` — этот запрет снова в силе безо всякого
 * исключения, и защиты, которую даёт `authFailureLimit`, у вас не будет,
 * пока вы не скопируете и её тоже». Список переписок писал ровно такой цикл
 * (`setInterval` на 30 секунд плюс возврат во вкладку), отказ уходил в
 * состояние ошибки, и цикл НЕ ОСТАНАВЛИВАЛСЯ НИКОГДА: замер независимой
 * проверки — десять попыток означали десять окон кошелька, и так каждые
 * полминуты. Тот же дефект в этом проекте чинили как критический дважды.
 *
 * Через `pollBags` этот цикл не пропустишь: тот опрашивает СКЛАД мешков, а
 * здесь нужен разбор превью по собеседникам, и это другой запрос с другим
 * ответом. Значит скопирован сам механизм — счётчик, предел и один-
 * единственный сигнал наверх.
 *
 * Три — то же число и по той же причине, что `DEFAULT_AUTH_FAILURE_LIMIT`:
 * пережить единичный транзиентный сбой и не превратиться в бесконечные окна.
 */
export const CONVERSATION_AUTH_FAILURE_LIMIT = 3;

export interface ConversationLoaderOptions {
  /** Свежий пропуск. Именно ЗДЕСЬ живёт окно кошелька. */
  getPass: () => Promise<string>;
  loadWithPass: (pass: string) => Promise<PairConversation[]>;
  onRows: (rows: PairConversation[]) => void;
  onError?: (err: unknown) => void;
  /** Зовётся РОВНО один раз, когда предел достигнут и цикл остановлен. */
  onAuthFailed?: () => void;
  authFailureLimit?: number;
}

export interface ConversationLoader {
  /** Один заход. После остановки — пустышка, а не новая попытка. */
  run: () => Promise<void>;
  stopped: () => boolean;
}

/**
 * Один заход за списком переписок со счётчиком неудач ВХОДА.
 *
 * Что считается неудачей входа — тот же разбор, что в `pollBags` (C1-R2):
 * любой отказ самого `getPass()` (человек отказался подписать, обрыв сети
 * внутри неё, её собственный `BagPassError`) ПЛЮС `BagPassError` от загрузки
 * (пропуск получен, но сервер его не принял). Отказ загрузки ЛЮБОГО другого
 * рода — это отказ ЗАПРОСА, а не входа: он идёт в `onError` и счётчик не
 * трогает вовсе. Свести оба под один счётчик значило бы закрывать чат от
 * моргнувшей сети.
 *
 * Сбрасывается ТОЛЬКО полным успехом.
 */
export function createConversationLoader(opts: ConversationLoaderOptions): ConversationLoader {
  const limit = opts.authFailureLimit ?? CONVERSATION_AUTH_FAILURE_LIMIT;
  let authFailures = 0;
  let stopped = false;

  return {
    stopped: () => stopped,
    async run(): Promise<void> {
      if (stopped) return;
      let stage: 'getPass' | 'load' = 'getPass';
      try {
        const pass = await opts.getPass();
        stage = 'load';
        const rows = await opts.loadWithPass(pass);
        authFailures = 0;
        opts.onRows(rows);
      } catch (err) {
        try { opts.onError?.(err); } catch { /* обработчик не должен стать новым сбоем */ }
        const isAuthFailure = stage === 'getPass' || err instanceof BagPassError;
        if (!isAuthFailure) return;
        authFailures++;
        if (authFailures >= limit) {
          // Стоп ДО любого следующего захода — не даём человеку ещё одно окно
          // кошелька после того, как решение «хватит» уже принято.
          stopped = true;
          try { opts.onAuthFailed?.(); } catch { /* тот же принцип */ }
        }
      }
    },
  };
}

/* ──────────────────────────────── хук ─────────────────────────────────── */

const _convCache = new Map<string, PairConversation[]>();

export function usePairConversations(isEnabled = false) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { status, session } = useChatSession();

  const addrLc = address?.toLowerCase();
  const [conversations, setConversations] = useState<PairConversation[]>(() =>
    addrLc ? (_convCache.get(addrLc) ?? []) : []
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef(session);
  const addressRef = useRef(address);
  useEffect(() => { sessionRef.current = session; addressRef.current = address; });

  // Список гасится в тот же миг, когда сменился адрес — не после того, как
  // загрузка доедет. Иначе после смены аккаунта на том же устройстве человек
  // видел бы ЧУЖИЕ переписки, пока не разрешится запрос.
  const prevAddrRef = useRef(addrLc);
  useEffect(() => {
    if (prevAddrRef.current === addrLc) return;
    prevAddrRef.current = addrLc;
    setConversations(addrLc ? (_convCache.get(addrLc) ?? []) : []);
  }, [addrLc]);

  // Загрузчик со счётчиком неудач входа. Живёт в ref, а не пересоздаётся на
  // каждый рендер: счётчик, который обнуляется сам собой при перерисовке, —
  // не счётчик, а его изображение.
  const loaderRef = useRef<ConversationLoader | null>(null);
  const [authFailed, setAuthFailed] = useState(false);

  const load = useCallback(async () => {
    const addr = addressRef.current;
    const s = sessionRef.current;
    if (!addr || !s) return;
    if (!loaderRef.current) {
      loaderRef.current = createConversationLoader({
        getPass: () => getBagPass(addressRef.current as `0x${string}`, signMessageAsync),
        loadWithPass: (pass) => loadPairConversations(sessionRef.current as ChatSession, pass),
        onRows: (rows) => {
          const a = addressRef.current;
          if (a) _convCache.set(a.toLowerCase(), rows);
          setConversations(rows);
        },
        onError: (err) => {
          // Код отдельным полем, текст запасным: разбор английского запрещён.
          setError((err as { code?: string })?.code ?? (err instanceof Error ? err.message : 'Failed to load conversations'));
        },
        onAuthFailed: () => { setAuthFailed(true); },
      });
    }
    setIsLoading(true);
    setError(null);
    try {
      await loaderRef.current.run();
    } finally {
      // ОБЯЗАТЕЛЬНО в `finally`: успешная загрузка, вернувшая ПУСТОЙ список,
      // иначе оставляла бы скелетон навсегда — исправная работа притворялась
      // бы поломкой. Урок прежней версии этого файла, не повторяем.
      setIsLoading(false);
    }
  }, [signMessageAsync]);

  // Смена аккаунта заводит новый счётчик: предыдущий адрес мог упереться в
  // предел, но это не приговор следующему.
  useEffect(() => { loaderRef.current = null; setAuthFailed(false); }, [addrLc]);

  // `authFailed` гасит и интервал, и слушатели: цикл остановлен по-настоящему,
  // а не «вернёт ошибку и попробует снова через полминуты».
  const ready = isEnabled && status === 'ready' && !!session && !authFailed;

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  // Тот же фоновый интервал, что был: 30 секунд. Список переписок не обязан
  // обновляться так же часто, как открытая переписка (5 с) — он и в старой
  // версии жил на тридцати.
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [ready, load]);

  // Мгновенное обновление, когда открытая переписка получила новое сообщение.
  useEffect(() => {
    if (!ready) return;
    const onUpdate = () => { void load(); };
    window.addEventListener('hexseal-conv-update', onUpdate);
    window.addEventListener('focus', onUpdate);
    return () => {
      window.removeEventListener('hexseal-conv-update', onUpdate);
      window.removeEventListener('focus', onUpdate);
    };
  }, [ready, load]);

  return {
    conversations, isLoading, error, reload: load,
    /** Опрос остановлен: пропуск не восстанавливается, нужен новый вход.
     *  Наружное поле, а не молчание, — иначе список просто перестал бы
     *  обновляться и никто не понял бы почему. */
    authFailed,
  };
}
