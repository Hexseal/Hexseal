/**
 * Арифметика платного вызова арбитра — считается здесь, в одном месте, не в
 * разметке. Тот же принцип, что и в соседнем `splitPot.ts`: деньги, посчитанные
 * в двух местах (контракт — своё, фронт — своё), расходятся молча, и на этой
 * ветке так уже случалось дважды. Обе функции ниже раньше жили инлайн —
 * `computeArbiterReward` в `arbiter/page.tsx`, `canFundDispute` в
 * `deal/[address]/page.tsx` — и не были покрыты ничем.
 */

/**
 * Суммарная награда арбитра за спор: собственная доля (80% сбора) плюс
 * доплата стороны, если она есть.
 *
 * Собственная доля НЕ хардкодится через ARBITER_SHARE_BPS — у этой константы
 * нет геттера на диамонде, и завести здесь вторую копию значило бы разойтись
 * с фасетом молча при следующей правке доли. Вместо этого она решается из
 * уравнения самого контракта:
 *
 *     quoteDisputeTopUp(agreement) == ownShare < floor ? floor - ownShare : 0
 *
 * Значит при topUp > 0: ownShare = floor - topUp — точное значение без единой
 * продублированной константы.
 *
 * ИНВАРИАНТ (доказан ревью алгебраически, закреплён тестом ниже): после того
 * как доплата внесена, награда равна порогу НА МОМЕНТ ОПЛАТЫ и не меняется,
 * если порог потом подвинули (пока он не опустился ниже исходной ownShare —
 * тот более редкий случай, где topUp сам обнуляется, оставлен как есть,
 * см. `docs/OPEN-ITEMS.md`/триаж ревью). Доказательство: пусть в момент
 * оплаты floor = F0, собственная доля fee-based = S (S < F0, зафиксирована
 * disputeFee() сделки — сумма спора после открытия спора не меняется).
 * bounty, внесённый через fundDispute, равен topUp_на_тот_момент = F0 - S.
 * После смены порога на F1 (S всё ещё < F1) свежий topUp пересчитывается как
 * F1 - S, а bounty остаётся прежним (F0 - S) — контракт его не трогает.
 * Тогда:
 *
 *     computeArbiterReward(F1, F1 - S, F0 - S)
 *       = (F1 - (F1 - S)) + (F0 - S)
 *       = S + F0 - S
 *       = F0
 *
 * F1 сократился алгебраически — результат не зависит от того, каким стал
 * порог, только от того, каким он был в момент оплаты.
 *
 * Возвращает `undefined`, когда собственная доля точно не известна: это
 * происходит, когда котёл уже сам по себе (без доплаты) даёт арбитру
 * не меньше порога — тогда `topUp` равен 0, и quoteDisputeTopUp стирает
 * точное значение ownShare (отдаёт 0 вместо разницы). В этом состоянии
 * `bounty` тоже всегда 0 — доплата возможна только пока `topUp > 0`
 * (`fundDispute` иначе ревертит `TopUpNotNeeded`) — так что показывать
 * всё равно нечего.
 */
export function computeArbiterReward(
  floor: bigint,
  topUp: bigint,
  bounty: bigint,
): bigint | undefined {
  if (topUp <= 0n) return undefined;
  return (floor - topUp) + bounty;
}

/**
 * Пять условий показа кнопки доплаты за арбитра, одной чистой функцией.
 * Каждое закрыто своей ошибкой контракта — показать кнопку в обход любого
 * значит предложить транзакцию, которая гарантированно отревертит и потратит
 * газ релеера впустую:
 *
 *   1. isDisputedStatus  — статус сделки не DISPUTED → NotDisputed
 *   2. isParty           — не сторона сделки        → NotParty
 *   3. !disputeClaimed   — спор уже заклеймлен       → DisputeAlreadyClaimed
 *   4. disputeBounty === 0n
 *                        — доплата уже внесена       → BountyAlreadyFunded
 *                        (quoteDisputeTopUp не вычитает уже внесённую
 *                        доплату и продолжает возвращать то же число после
 *                        успешного fundDispute() — без этой отдельной
 *                        проверки кнопка осталась бы видна и после оплаты)
 *   5. disputeTopUp > 0n — доплата не нужна           → TopUpNotNeeded
 *
 * Непрочитанные данные (ещё `undefined`, чтение в процессе) — fail-closed:
 * кнопка скрыта, а не показана "оптимистично". Показать её на основе
 * неполных данных означает тот же риск отревертить, что и любое из пяти
 * условий выше.
 */
export function canFundDispute(params: {
  isDisputedStatus: boolean;
  isParty: boolean;
  disputeClaimed: boolean;
  disputeBounty: bigint | undefined;
  disputeTopUp: bigint | undefined;
}): boolean {
  const { isDisputedStatus, isParty, disputeClaimed, disputeBounty, disputeTopUp } = params;
  if (!isDisputedStatus) return false;
  if (!isParty) return false;
  if (disputeClaimed) return false;
  if (disputeBounty === undefined || disputeBounty > 0n) return false;
  if (disputeTopUp === undefined || disputeTopUp <= 0n) return false;
  return true;
}
