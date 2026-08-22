import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Отсечка газа для заявки на спор не должна опускаться ниже замеренной нужды.
 *
 * Замер по фасету: первая в жизни запись ключа арбитра — до 72 868 газа, и это
 * поверх прежней стоимости заявки. Слишком низкая отсечка валит предварительный
 * staticCall релеера, действие отдаёт отказ, снаружи это «арбитраж сломался».
 * Такое в этом файле уже случалось: 126 383 против отсечки 120 000.
 */
const RELAY = readFileSync(new URL('./relay.ts', import.meta.url), 'utf8');

function gasCeiling(fnName: string): bigint {
  const m = RELAY.match(new RegExp(`\\n\\s*${fnName}:\\s*([0-9_]+)n`, 'm'));
  if (!m) throw new Error(`отсечка ${fnName} не найдена в GAS_DEFAULTS`);
  return BigInt(m[1].replace(/_/g, ''));
}

describe('отсечка газа заявки на спор', () => {
  it('не ниже замеренной нужды', () => {
    expect(gasCeiling('claimDispute')).toBeGreaterThanOrEqual(260_000n);
  });

  it('предварительная заявка своей отсечки не потеряла', () => {
    // Соседняя запись: если кто-то перепишет объект целиком, это заметно.
    expect(gasCeiling('commitDisputeClaim')).toBeGreaterThanOrEqual(100_000n);
  });
});

/**
 * ШОВ С ЦЕПЬЮ: пол по `gasleft()` в `src/Agreement.sol`.
 *
 * С 23 августа 2026 `_complete()` ОТКАЗЫВАЕТСЯ звать `autoAwardXP`, если
 * `gasleft()` не хватает на полную передачу капа (500 000), и ревертит всю
 * транзакцию `NotEnoughGasForDiamondCall`. Сделано затем, чтобы клиент не мог
 * подобрать лимит так, что сделка закроется, деньги уйдут, а исполнитель
 * тихо останется без XP (XP — вход в реестр арбитров).
 *
 * Цена — не расход, а МИНИМАЛЬНЫЙ ЛИМИТ. Расход цепь берёт по факту; но лимит
 * ниже порога теперь не «дороже», а «отказ». Отсечки ниже — единственное место
 * во фронте, где лимит берётся не из живой оценки узла, поэтому именно они
 * рвутся первыми, и рвутся молча: `estimateGas` упал, ушла отсечка, транзакция
 * отдала NotEnoughGasForDiamondCall.
 *
 * ⚠️ Числа — РУКАМИ, из замера двоичным поиском в forge (минимальный лимит, при
 * котором вызов проходит на здоровом даймонде). Их источник — не эта таблица и
 * не контракт, а отдельный прогон:
 * test/DiamondDeathGasCaps.t.sol, секции 15 и 16.
 */
const MEASURED_MIN_WITH_FLOOR: Record<string, bigint> = {
  release:            600_980n,
  triggerAutoApprove: 601_125n,
  finalizeVerdict:    703_138n,
};

describe('отсечки путей, перед которыми в цепи стоит пол по gasleft()', () => {
  for (const [fn, measured] of Object.entries(MEASURED_MIN_WITH_FLOOR)) {
    it(`${fn}: отсечка не ниже замеренного минимума ${measured}`, () => {
      expect(gasCeiling(fn)).toBeGreaterThanOrEqual(measured);
    });
  }

  it('resolveDispute держится вровень с release — тот же хвост функции', () => {
    // Прямой человеческий `resolveDispute` в нынешней модели недостижим
    // (claimDispute ставит арбитром сам диамонд), поэтому своего замера у него
    // нет. Но кнопки на странице сделки его зовут, а хвост у него тот же
    // `_complete` плюс сбор за спор ПЕРЕД выплатой — то есть дороже release,
    // не дешевле. Равнять по соседу честнее, чем оставить прежние 200 000,
    // которых не хватало даже до пола (замер здорового пути — 462 016).
    expect(gasCeiling('resolveDispute')).toBeGreaterThanOrEqual(gasCeiling('release'));
  });
});
