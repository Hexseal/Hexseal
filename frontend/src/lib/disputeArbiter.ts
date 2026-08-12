import type { Abi, AbiEvent, Address, PublicClient } from 'viem';
import { ARBITER_REGISTRY_ABI, CONTRACTS } from '@/config/contracts';
import { readArbiterChatKeysFromChain, type BoxKey } from '@/lib/arbiterChatKey';
import { arbiterBoxKeyBytes, type ArbiterBoxKeyBytes } from '@/lib/presentation';
import { subscribeChainLogs } from '@/lib/chainEventBus';
import {
  runChainWatch,
  type ChainWatchIO,
  type VisibilityDoc,
  type WatchPhase,
} from '@/lib/chainWatchGate';

/**
 * Кто ведёт спор сейчас, чем его запечатать, разошёлся ли снимок с цепью — и
 * слежение за тем, чтобы сторона узнала о смене раньше, чем нажмёт «Отправить».
 *
 * ОДИН СНИМОК НА ВСЁ. `readDisputeArbiterKey` отдаёт адрес, ключ и ГОТОВЫЕ
 * байты печати одним чтением: человеку показывают их, ими же собирают и
 * печатают мешок (§6 договора). Перед записью в ящик Задача 6 читает цепь
 * ещё раз и сверяет свежее чтение С ЭТИМ снимком — `comparePresentedWith`.
 * Сверять два свежих чтения между собой бессмысленно: они сняты с разницей в
 * миллисекунды, а величина, на которую человек дал согласие, в такой сверке
 * не участвует вовсе.
 *
 * ЛОГ — ПОВОД, А НЕ АВТОРИТЕТ. Слежение (`watchDisputeArbiter`) не решает
 * ничего само: оно говорит «перечитай цепь», а решает та же `comparePresentedWith`
 * на свежем чтении. Поэтому у смены арбитра одна дверь, а не две, и разойтись
 * им негде.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ: вывода статуса арбитра из наличия ключа. Докстринг
 * контракта (`ArbiterRegistryFacet.sol:1344-1351`) говорит прямо: нули означают
 * «ключей нет», но ОБРАТНОЕ НЕВЕРНО — ключ не стирается при потере статуса, и
 * снятый арбитр отдаёт живой на вид ключ, заменить который уже некому.
 *
 * И ОБРАТНАЯ СТОРОНА ТОГО ЖЕ ФАКТА: снятый арбитр — по-прежнему тот, кто
 * вынесет вердикт. `submitVerdict` (`:648`) гейтится клеймом спора, а не
 * статусом; `removeArbiter` и демоушен клейм не снимают. Поэтому `registered`
 * здесь — приписка к ответу, а не отказ: отказать значило бы отнять у стороны
 * единственный способ быть услышанной тем, кто решает.
 *
 * ЦЕНА, ЗАМЕРЕННАЯ ТЕСТАМИ: снимок — 3 чтения цепи (`getDisputeClaimer`,
 * `isRegisteredArbiter`, `getArbiterChatKeys`) и 4, когда живого заявителя нет
 * и добавляется `getPendingVerdict`. Слежение — **НОЛЬ** обращений к цепи в
 * любом состоянии вкладки: своего фильтра у него нет, оно подписано на пачки
 * общего фильтра уведомлений через `lib/chainEventBus.ts`.
 */

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export type DisputeArbiterKey =
  | {
      state: 'ready';
      arbiter: Address;
      boxKey: BoxKey;
      /** Готовые байты печати. Задача 6 отдаёт ИХ в `sealPresentation`, не hex:
       *  перестановка box/sign в реальном вызове однажды дала 0 красных из 1826
       *  (`arbiterChatKey.ts:28-42`), и здесь переставлять просто нечего. */
      boxKeyBytes: ArbiterBoxKeyBytes;
      /** true — числится в реестре; false — статус снят (предъявлять всё равно
       *  ему); null — статус прочитать не удалось, и это не то же, что false. */
      registered: boolean | null;
    }
  | { state: 'no_arbiter' }
  | { state: 'no_key'; arbiter: Address; registered: boolean | null }
  | { state: 'unreadable'; error: unknown };

/** ⚠️ ЗАМОК КОМПИЛЯТОРА: «арбитра нет» не несёт ни ключа, ни адреса — иначе
 *  вызывающий однажды прочитал бы `boxKey` у состояния, где его быть не может,
 *  и получил `undefined` там, где ждал ключ. */
type NoArbiter = Extract<DisputeArbiterKey, { state: 'no_arbiter' }>;
export type NoArbiterCarriesNothingElse =
  [Extract<keyof NoArbiter, 'boxKey' | 'boxKeyBytes' | 'arbiter' | 'registered'>] extends [never]
    ? true : never;
export const NO_ARBITER_CARRIES_NOTHING_ELSE: NoArbiterCarriesNothingElse = true;

/**
 * ДВА поля снимка, которые человек ВИДЕЛ и на которые дал согласие.
 *
 * Ключ здесь не украшение: арбитр может повернуть его, оставшись тем же
 * человеком, и сверка по одному адресу пропустила бы мешок на протухший ключ.
 *
 * ⚠️ БАЙТОВ ПЕЧАТИ ЗДЕСЬ НЕТ, и это не забывчивость. Они лежат в `ready`-исходе
 * выше (`boxKeyBytes`), уже клеймёные, и Задача 6 берёт оттуда ТОТ ЖЕ объект
 * (`presentedFromKey`, `presentToArbiter.ts`), не пересчитывая. Переход «ключ
 * из цепи → байты печати» на весь фронт один и живёт здесь —
 * `readDisputeArbiterKey`; заводить второй раскладыватель снимка ради третьего
 * поля значило бы разъехаться с формой, которую Задача 6 уже написала.
 */
export interface PresentedTo { arbiter: Address; boxKey: BoxKey }

export type ArbiterChangeSignal =
  | { reason: 'arbiter_changed'; arbiter: Address }
  | { reason: 'key_changed';     arbiter: Address }
  | { reason: 'arbiter_left';    prevArbiter: Address };

/** Имена поводов одним хозяином. Употребляется тут же — таблицей `REASON_OF`. */
export type ArbiterChangeReason = ArbiterChangeSignal['reason'];

/**
 * ⚠️ ЗАМОК КОМПИЛЯТОРА: у сигнала НЕТ номера блока — ни в одном члене.
 *
 * Сигнал едет двумя путями: из лога (номер есть) и из сверки снимка (номера
 * нет и взять негде). Поле, которое одна половина заполняет, а вторая всегда
 * оставляет `null`, — обещание номера, которого нет; читателя у него тоже нет
 * (`PresentChangeNotice` Задачи 6 смотрит только на `reason`).
 *
 * Что исчезнет из поведения, если снять: возможность дописать `blockNumber` в
 * один член союза и получить `undefined` там, где вызывающий ждал номер.
 */
// ⚠️ `keyof` по союзу даёт ПЕРЕСЕЧЕНИЕ ключей (здесь — один `reason`), поэтому
// поле, дописанное в ОДИН член, такой замок не заметил бы. Ключи собираются
// распределённо — проверено `npm run type-check` на зонде, оба направления.
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
export type ArbiterChangeSignalCarriesNoBlock =
  [Extract<KeysOfUnion<ArbiterChangeSignal>, 'blockNumber'>] extends [never] ? true : never;
export const ARBITER_CHANGE_SIGNAL_CARRIES_NO_BLOCK: ArbiterChangeSignalCarriesNoBlock = true;

const lower = (v: unknown): string => String(v ?? '').toLowerCase();

/** Ненулевой адрес из ответа цепи, иначе `null`. Один предикат на оба чтения:
 *  «заявитель» и «арбитр вердикта» проверяются им же, а не двумя копиями. */
function liveAddress(v: unknown): Address | null {
  return typeof v === 'string' && lower(v) !== lower(ZERO_ADDRESS) ? (v as Address) : null;
}

/**
 * КТО ВЕДЁТ СПОР — ПРАВИЛО, ОТДЕЛЁННОЕ ОТ ЧТЕНИЯ, и хозяин у него один.
 *
 * Сначала живой заявитель (`getDisputeClaimer`), при нуле — подавший вердикт
 * (`getPendingVerdict`, клейм стирается `clearDisputeClaim`, запись о вердикте
 * остаётся). Второй половины нет у `getDisputeClaimer` в одиночку, и без неё
 * фронт сказал бы «арбитра нет» там, где сервер по тому же адресу отдаёт ящик.
 * Зеркало правила — `relayer/app.js:201-218`.
 *
 * ⚠️ ПОЧЕМУ ЧИСТАЯ ФУНКЦИЯ, А НЕ ТОЛЬКО ЧИТАЛКА (итоговое ревью ветки, правка
 * 1). С этого круга по тому же признаку решается, ПОКАЗЫВАТЬ ЛИ КНОПКУ
 * предъявления, а компонент берёт оба ответа цепи хуками (`useReadContract`) —
 * эффектов у него в отрисовке нет вовсе. Держи правило только внутри
 * `disputeArbiterOf`, и у кнопки завелась бы вторая, своя копия композиции:
 * ровно тот шов, на котором эта ветка уже обожглась.
 */
export function disputeArbiterFrom(claimer: unknown, pendingVerdict: unknown): Address | null {
  const live = liveAddress(claimer);
  if (live) return live;
  const verdict = pendingVerdict as { arbiter?: unknown; submittedAt?: unknown } | null | undefined;
  if (!verdict || typeof verdict !== 'object') return null;
  const submittedAt = verdict.submittedAt;
  if (typeof submittedAt !== 'bigint' || submittedAt === BigInt(0)) return null;
  return liveAddress(verdict.arbiter);
}

/**
 * То же правило, но с цепью.
 *
 * ⚠️ БРОСАЕТ, если узел молчит. `null` здесь означает ровно «спор никто не
 * ведёт», и склеивать с ним «мы не спросили» нельзя: с экрана это выглядело бы
 * одинаково, а значит человек решил бы, что предъявлять некому.
 *
 * ⚠️ ВТОРОЕ ЧТЕНИЕ — ТОЛЬКО ПРИ НУЛЕВОМ ЗАЯВИТЕЛЕ, и это не «вторая копия
 * правила»: тем же `liveAddress` решает и `disputeArbiterFrom`, а ответ наружу
 * в обоих случаях отдаёт она. Читать `getPendingVerdict` всегда значило бы два
 * eth_call на каждый живой спор вместо одного.
 */
export async function disputeArbiterOf(
  publicClient: PublicClient, agreement: Address,
): Promise<Address | null> {
  const claimer = await publicClient.readContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'getDisputeClaimer',
    args: [agreement],
  }) as Address;
  if (liveAddress(claimer)) return disputeArbiterFrom(claimer, null);

  const verdict = await publicClient.readContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'getPendingVerdict',
    args: [agreement],
  }) as { arbiter?: unknown; submittedAt?: unknown } | null;
  return disputeArbiterFrom(claimer, verdict);
}

export async function readDisputeArbiterKey(
  publicClient: PublicClient, agreement: Address,
): Promise<DisputeArbiterKey> {
  let arbiter: Address | null;
  try {
    arbiter = await disputeArbiterOf(publicClient, agreement);
  } catch (error) {
    return { state: 'unreadable', error };
  }
  if (arbiter === null) return { state: 'no_arbiter' };

  // Статус — ОТДЕЛЬНЫМ чтением, и его отказ не топит ответ целиком: ключ здесь
  // существо дела, статус — приписка.
  let registered: boolean | null;
  try {
    registered = Boolean(await publicClient.readContract({
      address: CONTRACTS.diamond,
      abi: ARBITER_REGISTRY_ABI as Abi,
      functionName: 'isRegisteredArbiter',
      args: [arbiter],
    }));
  } catch { registered = null; }

  try {
    const keys = await readArbiterChatKeysFromChain(publicClient, arbiter);
    if (!keys.present) return { state: 'no_key', arbiter, registered };
    return {
      state: 'ready',
      arbiter,
      boxKey: keys.boxKey,
      boxKeyBytes: arbiterBoxKeyBytes(keys.boxKey),
      registered,
    };
  } catch (error) {
    return { state: 'unreadable', error };
  }
}

/**
 * АВТОРИТЕТНАЯ сверка: снимок, показанный человеку, против свежего чтения
 * цепи. Зовётся ПЕРЕД записью в ящик (Задача 6, шаг 3.4) и на каждый повод от
 * следящего — но решает всегда она одна, а не лог.
 *
 * ⚠️ `null` означает «просьбы нет», а НЕ «всё в порядке»: при `unreadable` мы
 * просто ничего не знаем, и показать это состояние обязана Задача 6 — у неё на
 * руках сам `DisputeArbiterKey` (см. Возражение 5).
 */
export function comparePresentedWith(
  presented: PresentedTo | null, now: DisputeArbiterKey,
): ArbiterChangeSignal | null {
  if (!presented) return null;
  if (now.state === 'unreadable') return null;
  if (now.state === 'no_arbiter') {
    return { reason: 'arbiter_left', prevArbiter: presented.arbiter };
  }
  if (lower(now.arbiter) !== lower(presented.arbiter)) {
    return { reason: 'arbiter_changed', arbiter: now.arbiter };
  }
  // Тот же человек. Ключа в цепи нет вовсе — запечатанное им уже не вскрыть.
  if (now.state === 'no_key') {
    return { reason: 'key_changed', arbiter: now.arbiter };
  }
  if (lower(now.boxKey) !== lower(presented.boxKey)) {
    return { reason: 'key_changed', arbiter: now.arbiter };
  }
  return null;
}

/* ═════════ слежение: узнать о смене раньше, чем нажмут «Отправить» ═════════
 *
 * ⚠️ ЛОГ — ПОВОД, А НЕ АВТОРИТЕТ. Отсюда наружу уходит «перечитай цепь», и
 * решает всё та же `comparePresentedWith` на свежем чтении (Задача 6, шаг 3.5).
 * Иначе у вопроса «сменился ли арбитр» стало бы два ответчика, и один из них
 * (лог) отвечал бы по данным, которые могли не доехать.
 *
 * ⚠️ СВОЕГО ДОГОНА НЕТ — И ОН НЕ НУЖЕН, ПОТОМУ ЧТО ЕСТЬ ЧУЖОЙ. `runChainWatch`
 * зовётся здесь БЕЗ курсора, поэтому `io.blockNumber` и `io.getLogs` не зовутся
 * вовсе: своих запросов истории слежение не делает ни одного. Но пропущенное за
 * время скрытой вкладки **добирается** — его добирает владелец общего фильтра
 * (`useNotifications` идёт с курсором в `localStorage`), и добранные логи
 * приезжают сюда обычной пачкой через раздатчик.
 *
 * ⚠️ ЭТО ИСПРАВЛЕНИЕ ПРЕЖНЕГО ОБЪЯВЛЕНИЯ, А НЕ ОПИСКА. Пока у слежения был свой
 * фильтр, здесь было написано «пропущенное не добирается», и это было правдой.
 * С переездом на общий фильтр правдой быть перестало — переписаны и объявление,
 * и его замер (тест «пропущенное за время скрытой вкладки ДОБИРАЕТСЯ»).
 */

/** Три рода, по которым «кто ведёт спор и чем печатать» может измениться.
 *  Пополняется РУКАМИ — новый род сам себя не найдёт. Сверяется со списком
 *  замка ABI (`arbiterEventAbiMatchesContract.test.ts`, `WATCHED`). */
export const ARBITER_CHANGE_EVENT_NAMES = [
  'DisputeClaimed', 'DisputeReleased', 'ArbiterChatKeySet',
] as const;
type ArbiterChangeEventName = (typeof ARBITER_CHANGE_EVENT_NAMES)[number];

/**
 * Род события → повод перечитать. `satisfies` держит сразу две вещи: каждому
 * роду назначен повод (четвёртый род без повода не соберётся) и повод — из
 * `ArbiterChangeReason`, а не любая строка. `as const` нужен, чтобы значения
 * остались литералами: иначе они расширятся до союза и перестанут собираться
 * в члены `ArbiterChangeSignal`.
 */
const REASON_OF = {
  DisputeClaimed:    'arbiter_changed',
  DisputeReleased:   'arbiter_left',
  ArbiterChatKeySet: 'key_changed',
} as const satisfies Record<ArbiterChangeEventName, ArbiterChangeReason>;

/** Описания ВЫНИМАЮТСЯ из боевого ABI, а не переписываются руками: переписанное
 *  с другим типом поля даёт другой topic0, и фильтр молча перестаёт ловить.
 *  Тот же приём и по той же причине, что `notifEvents.ts:44-53`. */
export const ARBITER_CHANGE_EVENTS: AbiEvent[] = [];
export const MISSING_ARBITER_CHANGE_EVENTS: string[] = [];

for (const name of ARBITER_CHANGE_EVENT_NAMES) {
  const found = (ARBITER_REGISTRY_ABI as unknown as { type?: string; name?: string }[])
    .find((e) => e && e.type === 'event' && e.name === name);
  if (found) ARBITER_CHANGE_EVENTS.push(found as AbiEvent);
  else MISSING_ARBITER_CHANGE_EVENTS.push(name);
}

/** Адрес из лога, либо null. Всё, что приезжает с узла, читается через это:
 *  при `strict: false` лог с неподошедшей раскладкой доезжает с
 *  `args: undefined`, и падение стоило бы всей пачки. */
function logAddress(v: unknown): Address | null {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null;
}

/**
 * Логи → поводы перечитать цепь, В ПОРЯДКЕ ЛОГОВ. Чистая функция: ни цепи, ни
 * состояния, ни времени.
 *
 * ⚠️ `presentedTo` нужен ровно для `ArbiterChatKeySet`: у этого рода адреса
 * сделки в логе НЕТ вовсе (индексирован по арбитру,
 * `ArbiterRegistryFacet.sol:197`), и «наш ли это поворот ключа» решается только
 * сверкой с тем, кого показали человеку. Снимка нет — логи этого рода
 * отбрасываются: чей поворот, неизвестно.
 */
export function routeArbiterChangeLogs(
  logs: readonly unknown[],
  target: { agreement: Address; presentedTo: Address | null },
): ArbiterChangeSignal[] {
  if (!Array.isArray(logs)) return [];
  const deal = lower(target.agreement);
  const mine = target.presentedTo ? lower(target.presentedTo) : null;
  const out: ArbiterChangeSignal[] = [];

  for (const raw of logs) {
    const log = raw as { eventName?: unknown; args?: unknown } | null;
    if (!log || typeof log !== 'object') continue;
    const name = log.eventName;
    if (typeof name !== 'string') continue;
    if (!(ARBITER_CHANGE_EVENT_NAMES as readonly string[]).includes(name)) continue;
    const args = log.args as Record<string, unknown> | undefined;
    if (!args || typeof args !== 'object') continue;

    if (name === 'DisputeClaimed') {
      if (lower(args.agreement) !== deal) continue;
      const arbiter = logAddress(args.arbiter);
      if (!arbiter) continue;
      out.push({ reason: REASON_OF.DisputeClaimed, arbiter });
      continue;
    }
    if (name === 'DisputeReleased') {
      if (lower(args.agreement) !== deal) continue;
      const prevArbiter = logAddress(args.prevArbiter);
      if (!prevArbiter) continue;
      out.push({ reason: REASON_OF.DisputeReleased, prevArbiter });
      continue;
    }
    // ArbiterChatKeySet: сделки в логе нет — сверяем с показанным арбитром.
    if (mine === null) continue;
    const arbiter = logAddress(args.arbiter);
    if (!arbiter || lower(arbiter) !== mine) continue;
    out.push({ reason: REASON_OF.ArbiterChatKeySet, arbiter });
  }
  return out;
}

/**
 * Цепь для следящего — БЕЗ СВОЕГО ЦИКЛА ОПРОСА.
 *
 * ⚠️ СВОЕГО ФИЛЬТРА ЗДЕСЬ НЕТ, И ЭТО НЕСУЩЕЕ. Фильтр на диамонде в приложении
 * один, его взводит `hooks/useNotifications.ts`, а наши три рода добавлены в его
 * набор (`WIRE_ONLY_EVENT_NAMES` в `notifRouter.ts` плюс уже бывший там
 * `DisputeClaimed`). Мы подписываемся на готовую пачку через
 * `lib/chainEventBus.ts`. Цена — **ноль** обращений к цепи: viem кладёт
 * `topics[0]` массивом, растёт фильтр на узле, а не число запросов.
 *
 * Второй цикл рядом стоил бы три запроса в минуту с каждой открытой вкладки и
 * пробил бы бюджет опроса: `hooks/chainPollBudget.test.ts` держит потолок в два
 * цикла и восемь запросов в минуту — замерено, что с третьим выходит 3 цикла и
 * 11 запросов. Бюджет стоит там после замера 8 100 обращений в час с одной
 * вкладки, и обходить его подбором такта нельзя.
 *
 * ⚠️ ТАКТА У НАС НЕТ ВОВСЕ — он принадлежит общему фильтру (`NOTIF_POLL_MS`,
 * 20 с). Параметра такта здесь нет намеренно: ручка, которая ни на что не
 * влияет, хуже отсутствующей — следующий передал бы в неё число, увидел зелёные
 * тесты и решил, что настроил опрос.
 *
 * ⚠️ `blockNumber` и `getLogs` — настоящие, а не заглушки, хотя без курсора их
 * никто не зовёт (`runChainWatch:190, :246`). Заглушка `async () => []` ждала бы
 * ровно того дня, когда сюда передадут курсор, и в этот день молча вернула бы
 * пустой догон — то есть «догнали», не сходив никуда.
 *
 * ⚠️ `onError` этого ввода-вывода не сработает НИКОГДА: отказы общего фильтра
 * ловит и печатает его владелец (`useNotifications`, `console.warn`), а
 * раздатчик отказов не возит. Сказано вслух, чтобы Задача 6 не считала свой
 * `onError` дверью к ошибкам цепи — он остаётся дверью к ошибкам ЛЮБОГО
 * `ChainWatchIO`, а у этого их не бывает.
 */
export function arbiterChangeWatchIO(publicClient: PublicClient): ChainWatchIO {
  return {
    watch: (onLogs, onError) => {
      void onError; // см. шапку: у раздатчика отказов нет
      return subscribeChainLogs(onLogs);
    },
    blockNumber: () => publicClient.getBlockNumber(),
    getLogs: async (fromBlock, toBlock) => {
      const logs = await publicClient.getLogs({
        address: CONTRACTS.diamond,
        events: ARBITER_CHANGE_EVENTS,
        fromBlock,
        toBlock,
      } as never);
      return Array.isArray(logs) ? (logs as unknown[]) : [];
    },
  };
}

export interface WatchDisputeArbiterOptions {
  io: ChainWatchIO;
  doc: VisibilityDoc;
  agreement: Address;
  /** Кому предъявляем — ФУНКЦИЕЙ, а не значением: арбитр меняется по ходу
   *  спора, и замыкание на момент взвода следило бы за предшественником. */
  presentedTo: () => Address | null;
  onChange: (signal: ArbiterChangeSignal) => void;
  onError?: (error: unknown, phase: WatchPhase) => void;
  /** Только ради тестов: иначе они ждали бы `HIDE_GRACE_MS` живого времени. */
  hideGraceMs?: number;
}

/**
 * Поднять слежение. Возвращает снятие.
 *
 * ⚠️ ОДИН `onChange` НА ПАЧКУ, и это про цену: на каждый повод Задача 6 делает
 * свежее чтение цепи. Пачка из трёх логов при «сигнал на лог» стоила бы три
 * чтения подряд с одинаковым ответом, поэтому наружу уходит ПОСЛЕДНИЙ — самый
 * свежий — повод.
 */
export function watchDisputeArbiter(opts: WatchDisputeArbiterOptions): () => void {
  return runChainWatch({
    io: opts.io,
    doc: opts.doc,
    hideGraceMs: opts.hideGraceMs,
    onLogs: (logs) => {
      const signals = routeArbiterChangeLogs(logs, {
        agreement: opts.agreement,
        presentedTo: opts.presentedTo(),
      });
      const last = signals[signals.length - 1];
      if (last) opts.onChange(last);
    },
    onError: opts.onError,
  });
}
