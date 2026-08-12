import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { AGREEMENT_STATUS_DISPUTED } from './agreementStatus';

/**
 * Замок против расхождения статуса сделки с контрактом.
 *
 * ⚠️ ЧТО ЗДЕСЬ БЫЛО ВМЕСТО НЕГО. `expect(AGREEMENT_STATUS_DISPUTED).toBe(4)` —
 * то есть константа сверялась САМА С СОБОЙ, и правка в контракте не красила
 * ничего. Замер (итоговое ревью ветки 4в-2): вставка одного члена в
 * `enum Status` контракта перед `DISPUTED` не нарушает раскладку хранилища,
 * значит ни `check-storage-layout.sh`, ни `check-storage-structs.sh`, ни
 * `check-agreement-layout.sh` этого не увидят; на живой сети кнопка исчезает
 * у всех, склад отвечает 409 на всё — при полностью зелёном прогоне.
 *
 * Читаем ИСХОДНИК `.sol`, а не `out/*.json`: `out/` в гите нет (`.gitignore`),
 * и замок, зависящий от результата сборки, покраснел бы на чистой копии.
 * Прецедент — `claimAbiMatchesContract.test.ts`.
 */

/**
 * Члены enum'а из исходника, по порядку. Позиция члена и есть его число.
 *
 * ⚠️ КОММЕНТАРИИ СНИМАЮТСЯ ДО РАЗБИЕНИЯ ПО ЗАПЯТОЙ, и это не косметика: в
 * самом `enum Status` есть строка `FUNDED, // клиент задепонировал USDC, NFT
 * заминтен` — запятая внутри комментария сдвинула бы весь список и дала
 * «DISPUTED = 5» на неизменённом контракте.
 *
 * ⚠️ Падает, если объявлений больше одного: перегруженный (скопированный)
 * enum молча подменил бы список, по которому сверяется замок — ровно та дыра,
 * которую ревью Задачи 1 нашло у `solidityCanonicalSignature`.
 */
export function solidityEnumMembers(source: string, enumName: string): string[] {
  const re = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`, 'g');
  const matches = [...source.matchAll(re)];
  if (matches.length === 0) throw new Error(`объявление enum ${enumName} не найдено в исходнике`);
  if (matches.length > 1) {
    throw new Error(
      `enum ${enumName} объявлен ${matches.length} раза в исходнике — ` +
      'какой из них настоящий, сверке неизвестно',
    );
  }
  return matches[0][1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

const AGREEMENT_SOL = readFileSync(
  new URL('../../../src/Agreement.sol', import.meta.url),
  'utf8',
);

describe('число статуса «спор» не расходится с контрактом', () => {
  it('DISPUTED стоит в enum Status ровно там, где говорит константа фронта', () => {
    const members = solidityEnumMembers(AGREEMENT_SOL, 'Status');
    expect(members.indexOf('DISPUTED')).toBe(AGREEMENT_STATUS_DISPUTED);
  });

  it('и весь enum целиком — список написан РУКАМИ, чтобы краснела ЛЮБАЯ вставка', () => {
    // Позиция `DISPUTED` ловит вставку ПЕРЕД ним. Вставка ПОСЛЕ него ломает
    // `RESOLVED`/`REFUNDED`, которыми пользуются другие места фронта
    // (`app/arbiter/page.tsx`: TERMINAL, STATUS_KEYS), и молчала бы. Список
    // руками — единственное, что краснеет на обе стороны.
    expect(solidityEnumMembers(AGREEMENT_SOL, 'Status')).toEqual([
      'CREATED', 'FUNDED', 'ACTIVE', 'COMPLETED', 'DISPUTED', 'RESOLVED', 'REFUNDED',
    ]);
  });

  it('у реестра DISPUTED — ДРУГОЕ число, и это тоже сверено с исходником', () => {
    // Два разных enum, и путаница между ними уже стоила отдельного теста в
    // релеере (T2b ящика спора). Здесь она названа числом: 3 против 4.
    const registry = readFileSync(
      new URL('../../../src/RegistryFacet.sol', import.meta.url), 'utf8');
    const members = solidityEnumMembers(registry, 'AgreementStatus');
    expect(members.indexOf('DISPUTED')).toBe(3);
    expect(members.indexOf('DISPUTED')).not.toBe(AGREEMENT_STATUS_DISPUTED);
  });

  it('разбор падает, если enum объявлен дважды', () => {
    // Не на настоящем `.sol`: здесь проверяется поведение самой функции
    // разбора на сфабрикованном источнике.
    const fake = `
      enum Status { CREATED, DISPUTED }
      enum Status { DISPUTED, CREATED }
    `;
    expect(() => solidityEnumMembers(fake, 'Status')).toThrow();
  });

  it('запятая внутри комментария список НЕ сдвигает', () => {
    // Ровно то, что стоит в настоящем исходнике: «// клиент задепонировал
    // USDC, NFT заминтен». Без снятия комментариев эта запятая дала бы лишний
    // член и «DISPUTED = 5» на неизменённом контракте.
    const fake = 'enum Status { A, B, // одно, другое\n C }';
    expect(solidityEnumMembers(fake, 'Status')).toEqual(['A', 'B', 'C']);
  });
});
