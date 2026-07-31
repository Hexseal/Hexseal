import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARBITER_SHARE_BPS, canFundDispute, computeArbiterReward } from './disputeBounty';

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

  it('topUp = 0 без прочитанного сбора → undefined, а не число, выведенное из нуля', () => {
    // Единственный оставшийся fail-closed: сбор ещё не приехал с цепи (или
    // сделка — старый клон Agreement без селектора disputeFee). Выводить
    // собственную долю из topUp = 0 нельзя: котировка её в этом состоянии
    // стирает, из неё следует только «ownShare >= floor».
    expect(computeArbiterReward(10_000_000n, 0n, 0n)).toBeUndefined();
    expect(computeArbiterReward(10_000_000n, 0n, 5_000_000n)).toBeUndefined();
  });

  // ─── topUp = 0: награда обязана показываться, а не исчезать ───────────────
  //
  // Это ровно те споры, где награда МАКСИМАЛЬНА и где она сама по себе
  // достаточна — котёл от ~$417 и выше. До правки функция отдавала здесь
  // undefined, и список арбитра показывал мелкий спор за $2.40, оплаченный за
  // $10.00, а спор на $1000 с реальной наградой $24 — пустотой.

  it('topUp = 0 со сбором с цепи → собственная доля = сбор × доля арбитра', () => {
    // Котёл $1000: сбор 3% = $30 (потолок $500 не достигнут), арбитру 80% = $24.
    expect(computeArbiterReward(10_000_000n, 0n, 0n, 30_000_000n)).toBe(24_000_000n);
  });

  it('topUp = 0 ровно на стыке: собственная доля равна порогу — граница включительно', () => {
    // Контракт: return arbiterGets >= floor_ ? 0 : floor_ - arbiterGets.
    // Сбор $12.50 → 80% = $10.00 = порог → topUp = 0 (а не «почти 0»).
    expect(computeArbiterReward(10_000_000n, 0n, 0n, 12_500_000n)).toBe(10_000_000n);
  });

  it('topUp = 0 при потолке сбора: $500 → арбитру $400', () => {
    // DISPUTE_FEE_CAP = 500 USDC в Agreement; выше него сбор не растёт,
    // значит и награда арбитра упирается в $400 на любом котле от ~$16 667.
    expect(computeArbiterReward(10_000_000n, 0n, 0n, 500_000_000n)).toBe(400_000_000n);
  });

  it('доля меньше порога при topUp = 0 невозможна по контракту → fail-closed, а не число', () => {
    // Если такое посчиталось, значит ARBITER_SHARE_BPS во фронте разошлась с
    // фасетом (тест ниже это ловит отдельно и громко). Печатать число,
    // которому цепь прямо противоречит, нельзя — арбитр примет решение по нему.
    // Сбор $1 → 80% = $0.80 < порог $10, но котировка при этом сказала 0.
    expect(computeArbiterReward(10_000_000n, 0n, 0n, 1_000_000n)).toBeUndefined();
  });

  // Припаркованная мелочь из ревью: «при понижении порога ниже своей доли
  // иконка награды исчезает». Это частный случай той же дыры — доплата уже
  // оплачена и лежит в disputeBounty, а свежий topUp схлопнулся в 0, потому
  // что владелец диамонда опустил порог НИЖЕ собственной доли арбитра.
  it('порог опустили ниже собственной доли ПОСЛЕ оплаты → награда = доля + уже внесённая доплата', () => {
    const fee = 30_000_000n;      // сбор сделки, $30 — от котла, порогом не движется
    const ownShare = 24_000_000n; // 80% от него
    const bounty = 7_600_000n;    // доплачено когда-то при пороге $31.60
    const floorNow = 5_000_000n;  // порог опустили до $5 — ниже ownShare, topUp схлопнулся в 0
    expect(computeArbiterReward(floorNow, 0n, bounty, fee)).toBe(ownShare + bounty);
  });
});

// ─── ARBITER_SHARE_BPS прибита к фасету ──────────────────────────────────────
//
// Единственная копия доли во фронте существует потому, что у константы нет
// геттера на диамонде (`private constant`) — прочитать её с цепи нельзя ничем,
// а без неё крупные споры остаются без показанной награды.
//
// Запрет на вторую копию был про МОЛЧАЛИВОЕ расхождение. Этот тест читает сам
// файл фасета и делает расхождение громким: правка доли в Solidity роняет
// `npm test` фронта, а не тихо превращает показанные $24 во враньё.
describe('ARBITER_SHARE_BPS прибита к src/facets/ArbiterRegistryFacet.sol', () => {
  it('значение во фронте совпадает с константой фасета', () => {
    const facet = readFileSync(
      new URL('../../../src/facets/ArbiterRegistryFacet.sol', import.meta.url),
      'utf8',
    );
    const m = facet.match(/uint256\s+(?:private|internal|public)\s+constant\s+ARBITER_SHARE_BPS\s*=\s*([0-9_]+)\s*;/);
    // Пропала сама константа (переименовали/убрали) — это тоже расхождение,
    // и молчать о нём нельзя: ветка topUp = 0 после такого считает мимо.
    expect(m, 'ARBITER_SHARE_BPS не найдена в ArbiterRegistryFacet.sol').not.toBeNull();
    expect(BigInt(m![1].replace(/_/g, ''))).toBe(ARBITER_SHARE_BPS);
  });

  it('делитель тот же, что в контракте: доля выражена в bps от 10 000', () => {
    // Уравнение фасета — (fee * ARBITER_SHARE_BPS) / 10_000. Если делитель в
    // Solidity когда-нибудь станет другим, эта проверка тоже обязана упасть.
    const facet = readFileSync(
      new URL('../../../src/facets/ArbiterRegistryFacet.sol', import.meta.url),
      'utf8',
    );
    expect(facet).toContain('(fee * ARBITER_SHARE_BPS) / 10_000');
  });
});

// ─── canFundDispute ──────────────────────────────────────────────────────────

const BASE_PARAMS = {
  isDisputedStatus: true,
  isParty: true,
  disputeClaimed: false,
  disputeBounty: 0n,
  disputeTopUp: 7_600_000n,
  disputeWindowOpen: true,
};

describe('canFundDispute — шесть условий, каждое проверено отдельно', () => {
  it('все шесть условий выполнены → true', () => {
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

  it('условие 6 — окно спора истекло → false (иначе contract revert DisputeWindowPassed)', () => {
    // Состояние, которое НЕ ловится статусом: после disputedAt + DISPUTE_WINDOW
    // сделка остаётся DISPUTED, пока таймаут никто не дёрнул, — все пять
    // прежних условий выполнены, а fundDispute уже отвергает деньги.
    expect(canFundDispute({ ...BASE_PARAMS, disputeWindowOpen: false })).toBe(false);
  });

  it('окно спора ещё не прочитано (undefined) → false, fail-closed', () => {
    expect(canFundDispute({ ...BASE_PARAMS, disputeWindowOpen: undefined })).toBe(false);
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
