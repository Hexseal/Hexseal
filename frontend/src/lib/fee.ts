/**
 * Зеркало FactoryStorage.quote() — ТОЛЬКО для предпросмотра в интерфейсе.
 *
 * Значение, которое пользователь подписывает, читается у контракта в
 * lib/relay.ts и НИКОГДА не берётся отсюда: разойдись эта формула с
 * контрактом — подпись должна остаться верной, а неверным станет лишь
 * показанное число.
 *
 * Держать в шаге с src/FactoryFacet.sol: fee = max(amount * bps / 10_000, floor).
 */
export function quoteFeeLocal(amount: bigint, bps: bigint, floor: bigint): bigint {
  const pct = (amount * bps) / 10_000n;
  return pct < floor ? floor : pct;
}

/** USDC (6 decimals) → строка с двумя знаками, как в остальном интерфейсе. */
export function fmtUsdc(raw: bigint): string {
  return (Number(raw) / 1e6).toFixed(2);
}
