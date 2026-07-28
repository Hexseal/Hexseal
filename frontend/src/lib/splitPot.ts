import { formatUnits } from 'viem';

/**
 * Деньги таймаута спора — считаются и печатаются здесь, в одном месте.
 *
 * Арифметика жила внутри `DisputeCostNotice`, пока её нужно было ровно в одном
 * диалоге. Теперь те же суммы показывают баннер сделки, подписи кнопок и тосты
 * в трёх разных компонентах — а два независимых места разошлись бы при первой
 * же правке, и разошлись бы молча: расхождение видно только тому, кто сравнит
 * показанное число с пришедшим на кошелёк.
 */

/**
 * Делит котёл ровно так, как это делает `Agreement.triggerArbiterTimeout` в
 * ветке `arbiter == address(0)`: исполнителю — floor(pot/2), клиенту —
 * ОСТАТОК. Считать вычитанием обязательно: на нечётном котле два деления
 * пополам теряют юнит, и показанное разошлось бы с выплаченным.
 *
 * Контракт: `src/Agreement.sol`, `triggerArbiterTimeout`.
 */
export function splitPot(pot: bigint): { toExecutor: bigint; toClient: bigint } {
  const toExecutor = pot / 2n;
  return { toExecutor, toClient: pot - toExecutor };
}

/**
 * Точное значение USDC, но не короче двух знаков после запятой:
 * 200 → "200.00", 25.000001 → "25.000001". Округление здесь недопустимо —
 * числа обязаны совпасть с тем, что заплатит контракт.
 */
export function usdcExact(value: bigint): string {
  const [whole, frac = ''] = formatUnits(value, 6).split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
}
