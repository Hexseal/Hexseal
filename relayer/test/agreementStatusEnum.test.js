import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AGREEMENT_STATUS_DISPUTED } from '../app.js';

/**
 * Замок против расхождения статуса сделки с контрактом — релеерная половина.
 *
 * ⚠️ ЧЕГО ЗДЕСЬ НЕ БЫЛО ВООБЩЕ. Число 4 жило в релеере совсем без проверки, а
 * на фронте сверялось само с собой (`expect(AGREEMENT_STATUS_DISPUTED).toBe(4)`).
 * Замер итогового ревью ветки 4в-2: вставка одного члена в `enum Status`
 * контракта перед `DISPUTED` раскладку хранилища не нарушает — то есть ни один
 * из трёх гейтов раскладки этого не увидит, — а на живой сети рушит и пуши
 * спора, и ночное продление мешков ящика, при полностью зелёном прогоне.
 *
 * ⚠️ ПОЧЕМУ ЗАМОК ЗДЕСЬ СВОЙ, А НЕ ОБЩИЙ С ФРОНТОМ. Разные рантаймы, общего
 * кода быть не может — ровно тот же случай, что у `relayTargetVerdict`. Обе
 * стороны читают ОДИН исходник контракта, и отстанет та, что забыла прийти.
 *
 * Читаем `.sol`, а не `out/*.json`: `out/` в гите нет, и замок, зависящий от
 * результата сборки, покраснел бы на чистой копии репозитория.
 */

/** Члены enum'а по порядку. Позиция члена и есть его число. */
function solidityEnumMembers(source, enumName) {
  const re = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`, 'g');
  const matches = [...source.matchAll(re)];
  if (matches.length === 0) throw new Error(`объявление enum ${enumName} не найдено в исходнике`);
  if (matches.length > 1) {
    throw new Error(`enum ${enumName} объявлен ${matches.length} раза — сверять не с чем`);
  }
  return matches[0][1]
    // ⚠️ Комментарии снимаются ДО разбиения по запятой: в самом enum есть
    // строка «FUNDED, // клиент задепонировал USDC, NFT заминтен», и запятая
    // внутри неё сдвинула бы весь список на неизменённом контракте.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

const AGREEMENT_SOL = readFileSync(
  new URL('../../src/Agreement.sol', import.meta.url), 'utf8');

describe('число статуса «спор» в релеере не расходится с контрактом', () => {
  it('DISPUTED стоит в enum Status ровно там, где говорит константа релеера', () => {
    expect(solidityEnumMembers(AGREEMENT_SOL, 'Status').indexOf('DISPUTED'))
      .toBe(AGREEMENT_STATUS_DISPUTED);
  });

  it('и весь enum целиком — список написан РУКАМИ, чтобы краснела ЛЮБАЯ вставка', () => {
    // Позиция DISPUTED ловит вставку ПЕРЕД ним; вставка ПОСЛЕ ломает
    // RESOLVED/REFUNDED, о которых релеер судит по тем же числам (пуши
    // развязки, ночное продление). Список руками краснеет на обе стороны.
    expect(solidityEnumMembers(AGREEMENT_SOL, 'Status')).toEqual([
      'CREATED', 'FUNDED', 'ACTIVE', 'COMPLETED', 'DISPUTED', 'RESOLVED', 'REFUNDED',
    ]);
  });

  it('у реестра DISPUTED — ДРУГОЕ число, и это сверено с исходником, а не с памятью', () => {
    const registry = readFileSync(
      new URL('../../src/RegistryFacet.sol', import.meta.url), 'utf8');
    expect(solidityEnumMembers(registry, 'AgreementStatus').indexOf('DISPUTED')).toBe(3);
    expect(AGREEMENT_STATUS_DISPUTED).not.toBe(3);
  });

  it('разбор падает, если enum объявлен дважды', () => {
    const fake = 'enum Status { CREATED, DISPUTED }\nenum Status { DISPUTED, CREATED }';
    expect(() => solidityEnumMembers(fake, 'Status')).toThrow();
  });

  it('запятая внутри комментария список НЕ сдвигает', () => {
    expect(solidityEnumMembers('enum Status { A, B, // одно, другое\n C }', 'Status'))
      .toEqual(['A', 'B', 'C']);
  });
});
