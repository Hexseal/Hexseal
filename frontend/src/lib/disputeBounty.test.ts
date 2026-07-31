import { describe, expect, it } from 'vitest';
import { canFundDispute, computeArbiterReward } from './disputeBounty';

/**
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
 *
 * Обе функции — деньги, посчитанные во фронте параллельно с контрактом.
 * `computeArbiterReward` дублирует не формулу сбора (та по-прежнему берётся с
 * контракта через disputeFee()/quoteDisputeTopUp), а способ ВОССТАНОВИТЬ
 * собственную долю арбитра из porog − topUp, не храня константу
 * ARBITER_SHARE_BPS во фронте. `canFundDispute` — пять условий показа кнопки,
 * гарантирующих, что клик никогда не отревертит.
 *
 * До этого файла обе жили инлайн в разметке (`arbiter/page.tsx`,
 * `deal/[address]/page.tsx`) и не проверялись ничем — расхождение с
 * контрактом было бы тихим, как уже дважды случалось на этой ветке.
 */

// ─── computeArbiterReward ───────────────────────────────────────────────────
//
// Эталон — src/facets/ArbiterRegistryFacet.sol, quoteDisputeTopUp:
//
//     uint256 arbiterGets = (fee * ARBITER_SHARE_BPS) / 10_000;
//     uint256 floor_ = getArbiterFloor();
//     return arbiterGets >= floor_ ? 0 : floor_ - arbiterGets;
//
// Значит при topUp > 0: floor_ - topUp === arbiterGets (собственная доля).

describe('computeArbiterReward', () => {
  it('неоплаченный спор (bounty = 0) → награда равна собственной доле floor - topUp', () => {
    // Котёл $100 из плана: сбор $3, арбитру 80% = $2.40, порог $10,
    // topUp = $7.60. Собственная доля = 10_000_000n - 7_600_000n = 2_400_000n.
    expect(computeArbiterReward(10_000_000n, 7_600_000n, 0n)).toBe(2_400_000n);
  });

  it('оплаченный спор: награда = собственная доля + доплата, обе части видны отдельно', () => {
    const floor = 10_000_000n;
    const topUp = 7_600_000n;
    const bounty = 7_600_000n; // доплачено ровно по котировке
    // 2_400_000 (своя доля) + 7_600_000 (доплата) = 10_000_000 — ровно порог.
    expect(computeArbiterReward(floor, topUp, bounty)).toBe(10_000_000n);
  });

  // ГЛАВНЫЙ ИНВАРИАНТ, ради которого всё затевалось (доказан ревью
  // алгебраически, закреплён здесь тестом): после того как доплата внесена,
  // награда равна порогу НА МОМЕНТ ОПЛАТЫ и не меняется, если порог потом
  // подвинули. Владелец диамонда может позвать setArbiterFloor() в любой
  // момент — доплата, уже лежащая в disputeBounty[agreement], пересчёту не
  // подлежит, а свежий quoteDisputeTopUp() после смены порога вернёт другое
  // число. Показанная награда обязана остаться прежней.
  it('инвариант: награда не меняется, если порог подвинули ПОСЛЕ того как доплата внесена', () => {
    // Момент оплаты: floor = $10, ownShare (fee-based, фиксирована) = $2.40,
    // topUp = $7.60, bounty оплачен ровно на $7.60.
    const ownShare = 2_400_000n;
    const bounty = 7_600_000n; // сколько реально доплатили в момент оплаты
    const floor0 = ownShare + bounty; // 10_000_000n — порог на момент оплаты
    const topUp0 = floor0 - ownShare; // 7_600_000n — то, что действительно доплатили
    expect(bounty).toBe(topUp0); // sanity: bounty равен ровно тому, что попросили доплатить

    const rewardAtFundingTime = computeArbiterReward(floor0, topUp0, bounty);
    expect(rewardAtFundingTime).toBe(floor0);

    // Порог подняли (владелец диамонда setArbiterFloor). bounty не меняется —
    // контракт его не трогает после оплаты. Свежий topUp пересчитывается с
    // НОВЫМ порогом относительно ТОЙ ЖЕ фиксированной ownShare.
    for (const floor1 of [floor0, 12_000_000n, 50_000_000n, 1_000_000_000n]) {
      const topUp1 = floor1 - ownShare; // всегда > 0 в этих случаях (ownShare < floor1)
      const rewardAfterFloorMoved = computeArbiterReward(floor1, topUp1, bounty);
      expect(rewardAfterFloorMoved).toBe(floor0);
      expect(rewardAfterFloorMoved).toBe(rewardAtFundingTime);
    }
  });

  it('topUp = 0 (котёл сам по себе покрывает порог) → собственная доля неизвестна точно, undefined', () => {
    expect(computeArbiterReward(10_000_000n, 0n, 0n)).toBeUndefined();
  });

  it('topUp = 0 при ненулевом bounty (несогласованное чтение) → всё равно undefined, не мусорное число', () => {
    // На практике так быть не должно (bounty > 0 требует, что в момент оплаты
    // topUp был > 0), но если чтения окажутся рассинхронизированы во времени
    // (устаревший topUp против свежего bounty), функция обязана остаться
    // fail-closed, а не напечатать что-то, выведенное из topUp = 0.
    expect(computeArbiterReward(10_000_000n, 0n, 5_000_000n)).toBeUndefined();
  });
});

// ─── canFundDispute ──────────────────────────────────────────────────────────

const BASE_PARAMS = {
  isDisputedStatus: true,
  isParty: true,
  disputeClaimed: false,
  disputeBounty: 0n,
  disputeTopUp: 7_600_000n,
};

describe('canFundDispute — пять условий, каждое проверено отдельно', () => {
  it('все пять условий выполнены → true', () => {
    expect(canFundDispute(BASE_PARAMS)).toBe(true);
  });

  it('условие 1 — статус не DISPUTED → false (иначе contract revert NotDisputed)', () => {
    expect(canFundDispute({ ...BASE_PARAMS, isDisputedStatus: false })).toBe(false);
  });

  it('условие 2 — не сторона сделки → false (иначе contract revert NotParty)', () => {
    expect(canFundDispute({ ...BASE_PARAMS, isParty: false })).toBe(false);
  });

  it('условие 3 — спор уже заклеймлен → false (иначе contract revert DisputeAlreadyClaimed)', () => {
    expect(canFundDispute({ ...BASE_PARAMS, disputeClaimed: true })).toBe(false);
  });

  it('условие 4 — доплата уже внесена (bounty > 0) → false (иначе contract revert BountyAlreadyFunded)', () => {
    expect(canFundDispute({ ...BASE_PARAMS, disputeBounty: 1_000_000n })).toBe(false);
  });

  it('условие 5 — доплата не нужна (topUp === 0) → false (иначе contract revert TopUpNotNeeded)', () => {
    expect(canFundDispute({ ...BASE_PARAMS, disputeTopUp: 0n })).toBe(false);
  });

  it('непрочитанный disputeBounty (undefined, чтение в процессе) → false, fail-closed', () => {
    expect(canFundDispute({ ...BASE_PARAMS, disputeBounty: undefined })).toBe(false);
  });

  it('непрочитанный disputeTopUp (undefined, чтение в процессе) → false, fail-closed', () => {
    expect(canFundDispute({ ...BASE_PARAMS, disputeTopUp: undefined })).toBe(false);
  });

  it('оба чтения ещё не прилетели → false, а не какое-то промежуточное "почти true"', () => {
    expect(canFundDispute({ ...BASE_PARAMS, disputeBounty: undefined, disputeTopUp: undefined })).toBe(false);
  });
});
