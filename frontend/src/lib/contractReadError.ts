import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from 'viem';

/**
 * Почему чтение с контракта не вернуло значения — две принципиально разные
 * причины, которые в UI выглядят одинаково (`data === undefined`):
 *
 *  • 'contract' — цепь ответила, и ответ отрицательный: селектора нет
 *    (у `Agreement` нет fallback, поэтому вызов реверта), либо функция
 *    реверта сама, либо по адресу вообще нет кода. Для клона Agreement,
 *    созданного до апгрейда, это НОРМА и сама по себе информация: такая
 *    сделка живёт по старым правилам.
 *  • 'transport' — до цепи не доехали: RPC отвалился, таймаут, оффлайн.
 *    Мы не знаем ничего, и молча показывать «старые правила» здесь нельзя.
 *
 * viem заворачивает оба случая в `ContractFunctionExecutionError`, а разницу
 * держит в `cause`: реверт даёт `ContractFunctionRevertedError`, пустой ответ
 * (нет кода / нет данных) — `ContractFunctionZeroDataError`, сетевой сбой не
 * даёт ни того, ни другого и остаётся собой (`HttpRequestError`,
 * `TimeoutError`, …). Поэтому классифицируем по наличию «контрактной»
 * причины в цепочке `cause`, а не по её отсутствию: любой незнакомый класс
 * ошибки попадёт в 'transport', то есть в честное «не знаем», а не в
 * уверенное утверждение про старые правила.
 *
 * Источник: `viem/utils/errors/getContractError.ts`.
 */
export type ReadFailureKind = 'contract' | 'transport';

export function classifyReadFailure(err: unknown): ReadFailureKind {
  if (err instanceof BaseError) {
    const fromChain = err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError,
    );
    if (fromChain) return 'contract';
  }
  return 'transport';
}
