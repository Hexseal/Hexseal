import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { CLAIM_DISPUTE_ABI } from './relay';
import { ARBITER_REGISTRY_ABI } from '@/config/contracts';

/**
 * Замок против расхождения ABI фронта с контрактом.
 *
 * Заводится потому, что 9 августа подпись заявки на спор сменилась
 * (claimDispute(address,bytes32) → claimDispute(address,bytes32,bytes32,bytes32)),
 * и единственное, что связывало фронт с контрактом, — внимание человека. Селектор
 * сменился вместе с подписью: старого входа в даймонде не остаётся, и вызов по нему
 * отдаёт отказ, который снаружи читается как «арбитраж сломался».
 *
 * Читаем ИСХОДНИК .sol, а не out/*.json: out/ в гите нет (.gitignore), и замок,
 * зависящий от результата сборки, покраснеет на чистой копии репозитория.
 * Прецедент чтения исходника — disputeBounty.test.ts.
 */

/** Каноническая подпись из объявления функции в .sol: только типы, по порядку. */
function solidityCanonicalSignature(source: string, fnName: string): string {
  // Объявление может быть многострочным, поэтому берём всё до закрывающей скобки.
  const re = new RegExp(`function\\s+${fnName}\\s*\\(([^)]*)\\)`, 'm');
  const m = source.match(re);
  if (!m) throw new Error(`объявление ${fnName} не найдено в исходнике`);
  const types = m[1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.split(/\s+/)[0]);
  return `${fnName}(${types.join(',')})`;
}

/** Каноническая подпись из ABI-записи viem. */
function abiCanonicalSignature(abi: readonly unknown[], fnName: string): string {
  const entry = (abi as any[]).find(
    (e) => e && e.type === 'function' && e.name === fnName,
  );
  if (!entry) throw new Error(`${fnName} не найдена в ABI`);
  const types = (entry.inputs ?? []).map((i: any) => i.type);
  return `${fnName}(${types.join(',')})`;
}

const FACET = readFileSync(
  new URL('../../../src/facets/ArbiterRegistryFacet.sol', import.meta.url),
  'utf8',
);

describe('ABI заявки на спор не расходится с контрактом', () => {
  it('ABI, которым идёт вызов, совпадает с исходником контракта', () => {
    const fromContract = solidityCanonicalSignature(FACET, 'claimDispute');
    const fromFront = abiCanonicalSignature(CLAIM_DISPUTE_ABI, 'claimDispute');
    expect(fromFront).toBe(fromContract);
  });

  it('запись в config/contracts.ts тоже совпадает — она читается людьми', () => {
    // Эта запись для записи в цепь не используется, но врать не должна:
    // до 9 августа она объявляла claimDispute(address) — без соли вообще.
    const fromContract = solidityCanonicalSignature(FACET, 'claimDispute');
    const fromConfig = abiCanonicalSignature(ARBITER_REGISTRY_ABI as readonly unknown[], 'claimDispute');
    expect(fromConfig).toBe(fromContract);
  });

  it('исходник контракта содержит ровно одно объявление заявки', () => {
    // Перегрузка означала бы вторую дорогу к заявке — то есть дорогу к заявке
    // без ключа, ровно ту дыру, которую 4б-1 закрывал.
    const count = (FACET.match(/function\s+claimDispute\s*\(/g) ?? []).length;
    expect(count).toBe(1);
  });
});
