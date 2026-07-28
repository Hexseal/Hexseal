import { parseEventLogs, type Log, type PublicClient } from 'viem';
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
 *     половину клиенту, и событие покажет ноль. Это точный ответ.
 *  2. Состояние агримента, когда хэша транзакции нет (холодный старт: лента
 *     достраивается из снимка реестра, где хэшей не было никогда). Тогда исход
 *     выводится тем же `decideArbiterTimeout`, что и на странице сделки —
 *     третьей копии этой логики в проекте нет, — а суммы получаются расчётом
 *     `splitPot`, то есть без поправки на заблокированного исполнителя. Это
 *     единственное расхождение между двумя путями, и оно в редкой ветке.
 *     Читать котёл после выплаты можно: `totalPayout()` — это
 *     `amount + extrasTotal`, и завершение сделки ни то, ни другое не обнуляет.
 *
 * Если не удалось ни то, ни другое — 'unknown'. Молча выбрать «возврат» здесь
 * было бы тем же враньём, только по умолчанию.
 */
export type SettledRefund =
  | { kind: 'split'; toClient: bigint; toExecutor: bigint }
  | { kind: 'refund' }
  | { kind: 'unknown' };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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
    } catch {
      // До цепи не доехали — ниже вторая попытка, по состоянию.
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

    if (settlement.kind === 'split') {
      return { kind: 'split', toClient: settlement.toClient, toExecutor: settlement.toExecutor };
    }
    return { kind: settlement.kind };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * Текст записи в ленте уведомлений. Строки захардкожены по-английски, как все
 * остальные в `hooks/useNotifications` — локализации у ленты нет, и заводить её
 * ради одной записи значило бы оставить рядом четырнадцать английских соседей.
 *
 * Суммы — обе, а не «пополам» словом: на нечётном котле они разные.
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
