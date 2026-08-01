/**
 * connectWallet.ts — три решения, из которых состоит нажатие «Подключить»:
 * какой коннектор звать, считать ли неудачу отказом человека или поломкой, и
 * пускать ли второе нажатие, пока первое ещё в полёте.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ЕСТЬ
 *
 * На телефоне подключение шло в два экрана. Сначала модалка RainbowKit —
 * пять иконок и блок «Что такое кошелёк?». Только после нажатия на
 * «WalletConnect» открывалась родная модалка WalletConnect с полным списком
 * («All Wallets», поиск, MetaMask/Binance/Bitget/TokenPocket/Ledger/…).
 *
 * Первый экран на телефоне предлагает выбор, которого нет: расширений
 * браузера там не существует, а после снятия `metaMaskWallet` с мобильного
 * списка (см. `walletList.ts`) мобильный путь В ЛЮБОМ СЛУЧАЕ уходит через
 * WalletConnect. То есть человек с Bitget или TokenPocket обязан был сам
 * догадаться, что его кошелёк спрятан за иконкой «WalletConnect». Убираем
 * этот экран: на мобильном зовём коннектор WalletConnect напрямую, родная
 * модалка откроется сама.
 *
 * ДЕСКТОП НЕ ТРОГАЕМ — и это не осторожность, а обратное требование. Там
 * модалка RainbowKit уместна: расширение MetaMask стоит в ней первым пунктом,
 * а прямой вызов WalletConnect показал бы QR-код человеку, у которого кошелёк
 * уже в браузере. Это было бы ухудшением, а не упрощением.
 *
 * Признак «мобильный» здесь НЕ заводится: он один на всё приложение —
 * `isMobileClient()` из `walletList.ts`, тот же, которым вычитается MetaMask
 * из мобильного списка. Два независимых способа отличить телефон от
 * компьютера рано или поздно разъедутся, и разъедутся молча.
 *
 * Здесь только чистые функции — ни React, ни wagmi. Всё, что решает этот
 * файл, проверяется без браузера (`connectWallet.test.ts`); браузерного
 * раннера у фронта нет вовсе, так что вынести решения из компонента — это
 * единственный способ их вообще проверить.
 */

// ─── Идти ли в обход модалки RainbowKit ───────────────────────────────────────

/** Есть ли в странице инжектированный провайдер EIP-1193.
 *
 *  На телефоне это означает ровно одно: сайт открыт ВО ВСТРОЕННОМ БРАУЗЕРЕ
 *  кошелька (MetaMask, Trust, Bitget, OKX — у всех он есть). Никакого
 *  диплинка там не происходит, кошелёк уже здесь. */
export function hasInjectedProvider(
  win: { ethereum?: unknown } | undefined = typeof window !== "undefined" ? window : undefined,
): boolean {
  return !!win && typeof win.ethereum !== "undefined" && win.ethereum !== null;
}

/**
 * Главное решение файла: открыть ли по нажатию сразу родную модалку
 * WalletConnect вместо модалки RainbowKit.
 *
 * Два случая, когда НЕ надо, и оба — не осторожность, а обратное требование:
 *
 *  1. ДЕСКТОП. Модалка RainbowKit там уместна: расширение MetaMask стоит в ней
 *     первым пунктом. Прямой вызов WalletConnect показал бы QR-код человеку, у
 *     которого кошелёк уже в браузере, — это ухудшение, а не упрощение.
 *
 *  2. МОБИЛЬНЫЙ СО ВСТРОЕННЫМ ПРОВАЙДЕРОМ, то есть встроенный браузер
 *     кошелька. Это единственное место на телефоне, где выбор действительно
 *     есть: `injectedWallet` подключает в одно нажатие, без ухода из
 *     приложения, — он и оставлен в мобильном списке ради этого случая (см.
 *     `walletList.ts`). Уводить отсюда в WalletConnect значило бы менять
 *     работающее подключение на диплинк кошелька в самого себя.
 *
 * Во всех остальных мобильных случаях — обычный Safari/Chrome на телефоне —
 * выбора нет: расширений не существует, а `metaMaskWallet` из мобильного
 * списка снят, так что путь В ЛЮБОМ СЛУЧАЕ идёт через WalletConnect. Экран
 * RainbowKit там предлагает выбор, которого нет, и прячет полный список
 * кошельков за лишним нажатием.
 */
export function shouldOpenWalletConnectDirectly(env: {
  isMobile: boolean;
  hasInjectedProvider: boolean;
}): boolean {
  if (!env.isMobile) return false;
  if (env.hasInjectedProvider) return false;
  return true;
}

// ─── Какой коннектор звать ────────────────────────────────────────────────────

/** Минимум, который нам нужен от коннектора wagmi. Намеренно не импортируем
 *  тип `Connector`: файл обязан оставаться свободным от wagmi, чтобы тесты
 *  шли в node-окружении. */
export interface ConnectorLike {
  id: string;
  /** Служебная приписка RainbowKit. У коннекторов EIP-6963 её нет вовсе —
   *  отсюда `?`. */
  rkDetails?: {
    id?: string;
    isWalletConnectModalConnector?: boolean;
  };
}

/**
 * Находит коннектор, который открывает РОДНУЮ модалку WalletConnect.
 *
 * Ищем по флагу `rkDetails.isWalletConnectModalConnector`, а НЕ по
 * `connector.id` — и вот почему. RainbowKit заводит все свои кошельки на
 * WalletConnect (Trust, OKX, Rainbow, Bitget…) через один и тот же коннектор
 * wagmi, у которого `id` всегда `'walletConnect'`. То есть по `id` таких
 * коннекторов в конфиге несколько, и они неразличимы; настоящий идентификатор
 * кошелька RainbowKit прячет в `rkDetails.id`.
 *
 * Дальше: для кошелька `walletConnect` RainbowKit создаёт ДВА коннектора —
 * один с `showQrModal: false` (модалку рисует он сам, своим QR-кодом) и один с
 * `showQrModal: true`, помеченный `isWalletConnectModalConnector: true`. Нам
 * нужен строго второй: только он открывает родную модалку WalletConnect с
 * полным списком кошельков. Первый без своей обёртки не покажет ничего и
 * будет молча ждать.
 *
 * Флаг выставляется ровно одному коннектору на конфиг, так что первое
 * совпадение — оно же единственное.
 *
 * `null` означает «звать нечего» — например, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
 * не задан, и конфиг собран запасной веткой с одним `injected()`. Это не
 * повод падать: вызывающий обязан откатиться на модалку RainbowKit.
 */
export function findWalletConnectModalConnector<C extends ConnectorLike>(
  connectors: readonly C[] | null | undefined,
): C | null {
  if (!connectors) return null;
  return connectors.find(c => c?.rkDetails?.isWalletConnectModalConnector === true) ?? null;
}

// ─── Чем закончилась попытка ──────────────────────────────────────────────────

/**
 * Исход неудавшегося `connect()`:
 *
 *  • `cancelled`         — человек закрыл модалку или отказал в кошельке.
 *                          Ничего не сломалось, говорить нечего;
 *  • `already-connected` — кошелёк уже подключён (второе нажатие успело
 *                          проскочить). Состояние и так верное;
 *  • `failed`            — всё остальное. ОБЯЗАНО быть показано человеку.
 *
 * Разделение здесь не косметическое. Показывать ошибку на закрытие модалки —
 * это врать, что сломалось; молчать на настоящем отказе — это ровно тот класс
 * бага, который в этом проекте уже чинили: «отказ, притворяющийся нормой».
 */
export type ConnectOutcome = 'cancelled' | 'already-connected' | 'failed';

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  cause?: unknown;
}

/** Разворачивает цепочку `cause`. viem и wagmi заворачивают исходную ошибку
 *  провайдера в свою, а WalletConnect — ещё и в свою: настоящая причина часто
 *  лежит на два-три уровня вглубь. Глубина ограничена, чтобы кольцевая ссылка
 *  (`err.cause === err`) не увела в бесконечный цикл. */
function errorChain(err: unknown, maxDepth = 5): ErrorLike[] {
  const out: ErrorLike[] = [];
  let cur = err;
  for (let i = 0; i < maxDepth && cur && typeof cur === 'object'; i++) {
    const e = cur as ErrorLike;
    if (out.includes(e)) break;
    out.push(e);
    cur = e.cause;
  }
  return out;
}

/** Отказ человека. Названия и тексты — не выдуманные: это то, чем реально
 *  отвечают wagmi (`UserRejectedRequestError`, код EIP-1193 4001) и модалка
 *  WalletConnect при закрытии («Connection request reset. Please try again.»
 *  — тот же текст RainbowKit у себя считает отказом). */
const CANCELLED_NAMES = ['UserRejectedRequestError'];
const CANCELLED_PATTERNS = [
  /user rejected/i,
  /user (?:closed|denied|cancell?ed)/i,
  /rejected the request/i,
  /connection request reset/i,
  /modal closed/i,
];

const ALREADY_CONNECTED_NAMES = ['ConnectorAlreadyConnectedError'];
const ALREADY_CONNECTED_PATTERN = /already connected/i;

export function classifyConnectError(err: unknown): ConnectOutcome {
  const chain = errorChain(err);
  // Строкой err быть тоже может — тогда цепочки объектов нет, но текст есть.
  const texts = chain
    .flatMap(e => [e.message, e.shortMessage])
    .concat(typeof err === 'string' ? [err] : [])
    .filter((s): s is string => typeof s === 'string');

  // «Уже подключён» проверяем ПЕРВЫМ: это не отказ и не поломка, и попасть под
  // общий разбор ниже оно не должно.
  if (chain.some(e => typeof e.name === 'string' && ALREADY_CONNECTED_NAMES.includes(e.name))) {
    return 'already-connected';
  }
  if (texts.some(s => ALREADY_CONNECTED_PATTERN.test(s))) return 'already-connected';

  if (chain.some(e => typeof e.name === 'string' && CANCELLED_NAMES.includes(e.name))) {
    return 'cancelled';
  }
  // 4001 — «user rejected request» из EIP-1193. Код приходит числом, но
  // некоторые обёртки отдают его строкой.
  if (chain.some(e => e.code === 4001 || e.code === '4001')) return 'cancelled';
  if (texts.some(s => CANCELLED_PATTERNS.some(re => re.test(s)))) return 'cancelled';

  return 'failed';
}

// ─── Одна попытка за раз ──────────────────────────────────────────────────────

/**
 * Потолок, после которого начатая попытка считается брошенной.
 *
 * Замок нужен затем, что повторное нажатие, пока модалка открыта, плодит
 * вторую сессию WalletConnect — а кошелёк держит ровно один открытый запрос.
 * Замок ВНЕ React (переменная модуля, а не `useRef`) намеренно: кнопка
 * «Подключить» живёт в шапке и на главной одновременно (`WalletMenu` рендерится
 * дважды — мобильный и десктопный экземпляры), и локальное состояние каждой из
 * них про соседнюю ничего не знает.
 *
 * Потолок обязателен по той же причине, что и у мьютекса подписи в
 * `walletLock.ts`: снять замок должен `finally` держателя, но обещание
 * `connect()` может не разрешиться никогда — человек ушёл в приложение
 * кошелька и не вернулся, мобильная сессия отвалилась молча. Без потолка одно
 * такое нажатие навсегда выключило бы кнопку подключения во всём приложении,
 * без ошибки и без выхода, кроме перезагрузки страницы.
 */
export const CONNECT_ATTEMPT_STALE_MS = 3 * 60_000;

/** `null` — попытки нет. Именно `null`, а не 0: ноль это законная метка
 *  времени, и путать «не начиналось» с «началось в нулевую миллисекунду»
 *  нельзя — на такой метке замок молча не держал бы ничего. */
let attemptStartedAt: number | null = null;

/** Резервирует право на попытку. `false` означает «уже идёт, нажатие
 *  проглочено» — и это не ошибка, показывать нечего. Освобождать обязан
 *  `endConnectAttempt()` в `finally`. */
export function beginConnectAttempt(now: number = Date.now()): boolean {
  if (isConnectAttemptInFlight(now)) return false;
  attemptStartedAt = now;
  return true;
}

export function endConnectAttempt(): void {
  attemptStartedAt = null;
}

export function isConnectAttemptInFlight(now: number = Date.now()): boolean {
  return attemptStartedAt !== null && now - attemptStartedAt < CONNECT_ATTEMPT_STALE_MS;
}
