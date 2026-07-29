/**
 * Зеркало FactoryStorage.quote() — ТОЛЬКО для предпросмотра в интерфейсе.
 *
 * Значение, которое пользователь подписывает, читается у контракта в
 * lib/relay.ts и НИКОГДА не берётся отсюда: разойдись эта формула с
 * контрактом — подпись должна остаться верной, а неверным станет лишь
 * показанное число.
 *
 * Держать в шаге с src/FactoryFacet.sol: fee = max(amount * bps / 10_000, floor).
 *
 * Расходится с контрактом при floor === 0n: `FactoryStorage.quote()` в этом
 * случае ревертит `FeeNotConfigured()` (диамонд смонтирован, но
 * `initFeeModel` ещё не вызван) — эта функция такой ветки не имеет и просто
 * вернёт 0n. Не звать с floor === 0n без отдельной проверки "конфиг ещё не
 * готов" на вызывающей стороне (см. `feeConfigReady` во всех местах, где
 * читается `useFeeConfig()`) — иначе предпросмотр покажет комиссию 0 для
 * заявки, которая на сабмите обязательно упадёт в нераскодированном реверте.
 */
export function quoteFeeLocal(amount: bigint, bps: bigint, floor: bigint): bigint {
  const pct = (amount * bps) / 10_000n;
  return pct < floor ? floor : pct;
}

/** USDC (6 decimals) → строка с двумя знаками, как в остальном интерфейсе. */
export function fmtUsdc(raw: bigint): string {
  return (Number(raw) / 1e6).toFixed(2);
}
