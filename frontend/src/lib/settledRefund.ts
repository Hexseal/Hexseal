import {
  AbiFunctionNotFoundError,
  parseEventLogs,
  type Log,
  type PublicClient,
} from 'viem';
import { AGREEMENT_ABI, DISPUTE_SPLIT_EVENT } from '@/config/contracts';
import { decideArbiterTimeout } from './arbiterTimeoutSettlement';
import { usdcExact } from './splitPot';

/**
 * ЧТО ФАКТИЧЕСКИ ПРОИЗОШЛО с деньгами сделки, которая закрылась со статусом
 * REFUNDED. Это поверхность ПОСЛЕ действия, в отличие от
 * `lib/arbiterTimeoutSettlement`, который предсказывает исход ДО него.
 *
 * Различать обязательно, потому что реестр не различает: таймаут спора, за
 * который никто не взялся, делит котёл пополам и ставит тот же REFUNDED(2), что
 * и настоящий возврат — перечисление статусов расширять нельзя, оно повторяет
 * `enum Status` агримента, чья раскладка заморожена. Из-за этого лента
 * уведомлений говорила исполнителю, только что получившему половину эскроу, что
 * «сделка отменена и деньги вернулись клиенту».
 *
 * Два источника признака, в порядке надёжности:
 *
 *  1. `DisputeSplitNoVerdict` в логах ТОЙ ЖЕ транзакции. Суммы там фактически
 *     переведённые: если USDC заблокировал исполнителя, контракт отдаёт его
 *     половину клиенту, и событие покажет ноль. Это точный ответ — и
 *     единственный путь, на котором мы вправе называть суммы.
 *  2. Состояние агримента, когда хэша транзакции нет (холодный старт: лента
 *     достраивается из снимка реестра, где хэшей не было никогда). Тогда исход
 *     выводится тем же `decideArbiterTimeout`, что и на странице сделки —
 *     третьей копии этой логики в проекте нет. Но здесь исход ТОЛЬКО признак:
 *     «дележ был» — да, «кому сколько» — нет. Отсюда отдельный вид
 *     `split-amounts-unknown`.
 *
 * ПОЧЕМУ НА ВТОРОМ ПУТИ СУММ НЕТ.
 *
 * Посчитать нечем. `splitPot(totalPayout())` даёт половины ПО ПРАВИЛУ, а в
 * ветке заблокированного исполнителя контракт платит иначе: мягкий перевод не
 * прошёл, недоставленная половина ушла клиенту, событие несёт `toExecutor = 0`
 * (`src/Agreement.sol`, `triggerArbiterTimeout`). Расчёт об этом знать не может
 * и назвал бы заблокированному исполнителю половину, которой тот не получил, а
 * клиенту — половину вместо всего котла: ровно тот класс вранья про деньги, ради
 * которого всё это писалось, только в редкой ветке. Раньше это расхождение было
 * здесь записано как принятое; больше не принято. Правило одно: не называть
 * сумму, которой не знаешь.
 *
 * Дочитать фактические суммы с цепи тоже нечем, и это проверялось:
 *
 *  • `getLogs` требует диапазона блоков, а у ленты его нет — снимок реестра
 *    (`getClientDeals`/`getExecutorDeals`) отдаёт агримент, сумму и статус,
 *    номера блока в нём нет никогда, и сам агримент хранит только время
 *    (`resolvedAt`), а не блок. Перевод времени в блок — это бинарный поиск по
 *    цепи, десятки запросов на каждую сделку в цикле бэкфилла;
 *  • скан от начала цепи на публичном RPC неприемлем по той же причине, только
 *    хуже;
 *  • «спросить у USDC `isBlacklisted`» — эвристика, а не факт: она соврёт, если
 *    исполнителя заблокировали ПОСЛЕ выплаты, и по её ответу мы всё равно
 *    угадывали бы, а не читали.
 *
 * Один настоящий источник существует и здесь намеренно НЕ используется:
 * сабграф с версии 2.1.0 индексирует это самое событие в поля
 * `splitToClient`/`splitToExecutor` сущности Agreement (`subgraph/schema.graphql`,
 * `handleDisputeSplitNoVerdict`), и из браузера он доступен через уже
 * существующий прокси `/api/subgraph`. Цена — новая зависимость ленты
 * уведомлений от стороннего индексатора с его лагом, кэшем и версией деплоя,
 * ради сумм в одной редкой ветке. Это отдельное решение, а не побочный эффект
 * этой правки; молчание про сумму честно и без него.
 *
 * Если не удалось ни то, ни другое — 'unknown'. Молча выбрать «возврат» здесь
 * было бы тем же враньём, только по умолчанию.
 */
export type SettledRefund =
  /** Дележ, суммы ФАКТИЧЕСКИЕ — взяты из события, а не посчитаны. */
  | { kind: 'split'; toClient: bigint; toExecutor: bigint }
  /** Дележ был, кому сколько — неизвестно. Сумм в этом виде нет намеренно. */
  | { kind: 'split-amounts-unknown' }
  | { kind: 'refund' }
  | { kind: 'unknown' };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Ошибка НАШЕГО кода, а не отказ цепи.
 *
 * Ниже три `catch`, и каждый по построению возвращает «не знаем»: сеть падает
 * буднично, и уведомление из-за этого падать не должно. Но тот же `catch`
 * ловит и опечатку — `client.readContrct(...)`, обращение к полю `undefined`,
 * имя функции, которого нет в ABI, — и обе стороны прочитают её как «RPC
 * недоступен». Такой баг живёт до первого разбора вручную; поэтому его отделяем
 * и печатаем, оставляя возвращаемое значение прежним.
 *
 * Классы движка (`TypeError` и родня) сюда попадают целиком: цепь их не бросает.
 * `AbiFunctionNotFoundError` добавлен отдельно, потому что он наследует
 * viem'овский `BaseError`, то есть по предку неотличим от сетевого, а означает
 * ровно опечатку в имени функции — и летит мимо обёртки `getContractError`
 * (`encodeFunctionData` в `readContract` вызывается ДО try).
 */
function isOwnBug(err: unknown): boolean {
  if (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError ||
    err instanceof RangeError
  ) {
    return true;
  }
  return err instanceof AbiFunctionNotFoundError;
}

function reportIfBug(err: unknown, where: string, agreement: string): void {
  if (!isOwnBug(err)) return;
  console.error(
    `[settledRefund] ${where} threw a programmer error, not a chain or network failure. `
      + `The outcome of ${agreement} is being reported as "unknown" because of a bug here, `
      + 'not because the chain was unreachable:',
    err,
  );
}

/**
 * `DisputeSplitNoVerdict` этого агримента среди логов чека, или null.
 * Фильтр по адресу намеренный: только сам агримент вправе решать, как читается
 * уведомление про его сделку.
 */
export function findSplitInLogs(
  logs: readonly Log[],
  agreement: string,
): { toClient: bigint; toExecutor: bigint } | null {
  const target = agreement.toLowerCase();
  const parsed = parseEventLogs({
    abi: [DISPUTE_SPLIT_EVENT],
    eventName: 'DisputeSplitNoVerdict',
    logs: logs as Log[],
  });
  for (const ev of parsed) {
    if (ev.address.toLowerCase() !== target) continue;
    return { toClient: ev.args.toClient, toExecutor: ev.args.toExecutor };
  }
  return null;
}

async function readOrError(
  client: PublicClient,
  agreement: `0x${string}`,
  functionName: 'disputeFee' | 'totalPayout' | 'DISPUTE_WINDOW',
): Promise<{ data: bigint | undefined; error: unknown }> {
  try {
    const data = (await client.readContract({
      address: agreement,
      abi: AGREEMENT_ABI,
      functionName,
    })) as bigint;
    return { data, error: undefined };
  } catch (error) {
    reportIfBug(error, `${functionName}()`, agreement);
    return { data: undefined, error };
  }
}

export async function classifySettledRefund(
  client: PublicClient | undefined,
  agreement: `0x${string}`,
  txHash?: `0x${string}`,
): Promise<SettledRefund> {
  if (!client) return { kind: 'unknown' };

  // (1) Признак и точные суммы лежат в чеке той же транзакции.
  if (txHash) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      const split = findSplitInLogs(receipt.logs, agreement);
      if (split) return { kind: 'split', ...split };
      // События нет — это ещё не значит «возврат»: если `updateStatus` упал при
      // завершении (RegistrySyncFailed), статус в реестр приносит уже отдельная
      // транзакция `syncRegistry()`, в чьих логах дележа не будет. Поэтому
      // падаем в состояние, а не отвечаем сразу.
    } catch (err) {
      // До цепи не доехали — ниже вторая попытка, по состоянию. Если же это не
      // цепь, а мы сами, пусть об этом хотя бы останется след.
      reportIfBug(err, 'the receipt path', agreement);
    }
  }

  // (2) По состоянию агримента.
  try {
    const details = (await client.readContract({
      address: agreement,
      abi: AGREEMENT_ABI,
      functionName: 'getDetails',
    })) as readonly unknown[];
    const arbiter    = details[2] as string;
    const disputedAt = details[9] as bigint;

    // Спора не было вовсе — REFUNDED означает ровно возврат (отмена до
    // активации, таймаут активации, таймаут дедлайна). Дележ без спора
    // невозможен, поэтому дальше читать нечего.
    if (disputedAt === 0n) return { kind: 'refund' };

    // За спор брались — весь котёл клиенту в любой реализации.
    if (arbiter.toLowerCase() !== ZERO_ADDRESS) return { kind: 'refund' };

    const [fee, pot, disputeWindow] = await Promise.all([
      readOrError(client, agreement, 'disputeFee'),
      readOrError(client, agreement, 'totalPayout'),
      readOrError(client, agreement, 'DISPUTE_WINDOW'),
    ]);

    const settlement = decideArbiterTimeout({
      arbiter,
      fee: fee.data,
      feeError: fee.error,
      pot: pot.data,
      disputeWindow: disputeWindow.data,
    });

    // Суммы у `decideArbiterTimeout` есть, и они РАСЧЁТНЫЕ — `splitPot(pot)`.
    // На странице сделки это верно: там они предсказывают, что случится, и
    // ветку заблокированного исполнителя никто предсказать не может. Здесь же
    // выплата уже прошла, и назвать расчётное числом «сколько тебе пришло»
    // значило бы соврать всякий раз, когда мягкий перевод не прошёл. Признак
    // берём, суммы — намеренно роняем.
    if (settlement.kind === 'split') return { kind: 'split-amounts-unknown' };
    return { kind: settlement.kind };
  } catch (err) {
    reportIfBug(err, 'the state path', agreement);
    return { kind: 'unknown' };
  }
}

/**
 * Текст записи в ленте уведомлений. Строки захардкожены по-английски, как все
 * остальные в `hooks/useNotifications` — локализации у ленты нет, и заводить её
 * ради одной записи значило бы оставить рядом четырнадцать английских соседей.
 *
 * Суммы — обе, а не «пополам» словом: на нечётном котле они разные. И только
 * там, где они фактические: `split-amounts-unknown` не называет ни одной, ровно
 * как 'unknown'.
 */
export function refundNotifCopy(
  outcome: SettledRefund,
  role: 'client' | 'executor',
): { title: string; body: string } {
  if (outcome.kind === 'split') {
    const mine  = usdcExact(role === 'client' ? outcome.toClient : outcome.toExecutor);
    const other = usdcExact(role === 'client' ? outcome.toExecutor : outcome.toClient);
    const otherParty = role === 'client' ? 'the executor' : 'the client';
    return {
      title: 'Escrow Split',
      body:
        'Nobody took the dispute, so there was nobody to judge it. The escrow was split — '
        + `${mine} USDC to you, ${other} USDC to ${otherParty}.`,
    };
  }

  // Дележ без сумм. Обеим сторонам одно и то же — назвать «твою половину» здесь
  // нельзя ни одной из них.
  if (outcome.kind === 'split-amounts-unknown') {
    return {
      title: 'Escrow Split',
      body:
        'Nobody took the dispute, so there was nobody to judge it, and the escrow was split '
        + "between the two of you. We couldn't read the exact amounts — check your wallet for "
        + 'the amount you received.',
    };
  }

  if (outcome.kind === 'refund') {
    return {
      title: 'Deal Refunded',
      body: role === 'client'
        ? 'Funds returned to your wallet.'
        : 'The deal was refunded to the client.',
    };
  }

  return {
    title: 'Deal Closed',
    body: "This deal closed as refunded, but we couldn't read how the escrow was settled. "
        + 'Check your wallet for the amount you received.',
  };
}
