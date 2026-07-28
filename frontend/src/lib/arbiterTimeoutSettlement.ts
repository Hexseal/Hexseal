import { classifyReadFailure } from './contractReadError';
import { splitPot } from './splitPot';

/**
 * Что `Agreement.triggerArbiterTimeout` СДЕЛАЕТ С ДЕНЬГАМИ — решение вынесено
 * из React в чистую функцию, потому что это не оформление, а деньги: ветку
 * должно быть можно проверить без браузера, кошелька и зависшей сделки.
 *
 * Контракт ведёт себя двумя разными способами, и различает их поле `arbiter`:
 *
 *  • `arbiter == 0` — за спор никто не взялся: котёл делится, floor(pot/2)
 *    исполнителю, остаток клиенту (`DisputeSplitNoVerdict`);
 *  • `arbiter != 0` — взялись и не довели: весь котёл клиенту
 *    (`ArbiterTimedOut`).
 *
 * Дележ, однако, появился вместе с новой реализацией `Agreement`. Уже
 * созданные клоны EIP-1167 делегируют в СТАРУЮ реализацию и живут по старым
 * правилам, где таймаут без клейма возвращает всё клиенту, — на Base Sepolia
 * это сегодня все существующие сделки. Поэтому «arbiter == 0» сам по себе
 * ветку не определяет: нужен признак новой реализации, и им служит наличие
 * селектора `disputeFee` (у Agreement нет fallback, у старого клона вызов
 * реверта).
 *
 * Отсюда третий исход, 'unknown'. Если чтение не удалось из-за сети, мы не
 * знаем ни правил, ни сумм — и обещать нельзя ни возврат, ни дележ. Молча
 * выбрать «старые правила» было бы тем же классом вранья, который эта задача
 * убирает, только в другую сторону.
 */
export type ArbiterTimeoutSettlement =
  | { kind: 'refund' }
  | { kind: 'unknown' }
  | { kind: 'split'; toExecutor: bigint; toClient: bigint; windowDays: number };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const SECONDS_PER_DAY = 86_400;

export interface ArbiterTimeoutReads {
  /** Поле `arbiter` агримента; `undefined` пока `getDetails` не прочитан. */
  arbiter: string | undefined;
  /** `disputeFee()` — не показывается, служит признаком новой реализации. */
  fee: bigint | undefined;
  /** Ошибка того же чтения: реверт = старый клон, сеть = ничего не знаем. */
  feeError: unknown;
  /** `totalPayout()` — котёл, который будет делиться. */
  pot: bigint | undefined;
  /** `DISPUTE_WINDOW()` — срок, за который спор никто не взял. */
  disputeWindow: bigint | undefined;
}

export function decideArbiterTimeout(reads: ArbiterTimeoutReads): ArbiterTimeoutSettlement {
  const { arbiter, fee, feeError, pot, disputeWindow } = reads;

  // Кто арбитр ещё неизвестно — называть исход рано.
  if (arbiter === undefined) return { kind: 'unknown' };

  // За спор брались: весь котёл клиенту, и это верно в любой реализации.
  if (arbiter.toLowerCase() !== ZERO_ADDRESS) return { kind: 'refund' };

  // Старый клон: селектора сбора нет, значит и дележа у него нет.
  //
  // Но верить этому выводу можно только если ДРУГОЕ чтение того же контракта
  // доехало. `classifyReadFailure` разбирает уже завёрнутую viem'ом ошибку, а
  // viem заворачивает JSON-RPC `-32603 Internal error` в
  // `ContractFunctionRevertedError`, если при нём пришли хоть какие-то данные:
  // в `utils/errors/getContractError.ts` код `InternalRpcError` стоит в том же
  // списке, что и код 3 «execution reverted», а исходную ошибку затирает
  // созданной. То есть серверный сбой RPC на уровне типов НЕОТЛИЧИМ от «у этого
  // клона нет `disputeFee()`» — и без этой проверки интерфейс уверенно обещал бы
  // новому клону полный возврат, хотя котёл разделят пополам. Ровно тот класс
  // вранья, который весь этот файл убирает, только в другую сторону.
  //
  // Различает их то, что признак старого клона локальный (реверта одного
  // селектора), а `-32603` — серверный: он валит все три чтения разом. На
  // настоящем старом клоне `DISPUTE_WINDOW()` работает (на живой реализации
  // `0xf7cBecE7…` измерено: `disputeFee()` ревертит, `DISPUTE_WINDOW()` отдаёт
  // 345600), поэтому «дочиталось окно» и есть подтверждение, что цепь на связи и
  // отказ пришёл от контракта. При `-32603`-шторме не доезжает ничего, и
  // результатом честно становится 'unknown'.
  //
  // Проверено `arbiterTimeoutSettlement.test.ts` — там собрана настоящая
  // viem-ошибка `-32603`, чтобы правка в viem не прошла незамеченной.
  if (feeError && classifyReadFailure(feeError) === 'contract' && disputeWindow !== undefined) {
    return { kind: 'refund' };
  }

  if (fee === undefined || pot === undefined || disputeWindow === undefined) {
    return { kind: 'unknown' };
  }

  const { toExecutor, toClient } = splitPot(pot);
  return {
    kind: 'split',
    toExecutor,
    toClient,
    // Дробное значение допустимо намеренно: окно в 36 часов даст 1.5, и
    // ICU-plural отрендерит "1.5 days" вместо вранья про "1 day".
    windowDays: Number(disputeWindow) / SECONDS_PER_DAY,
  };
}
