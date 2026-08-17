import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Замок на ловушку «жёсткий газ у арбитрской кнопки».
 *
 * ⚠️ ЧЕМ ЭТО ОПАСНО. Явный `gas:` в вызове viem означает «кошелёк, не оценивай»:
 * `eth_estimateGas` не зовётся вовсе, транзакция уходит в цепь как есть. Дальше
 * два разных несчастья, и оба МОЛЧАТ:
 *
 *  1. ОТКАЗ. Вызов, который отвергнет контракт (или которого после разреза уже
 *     нет в даймонде), ревертит УЖЕ В ЦЕПИ — то есть после подписи и за деньги
 *     подписавшего, без единого слова о причине. Без литерала оценка провалится
 *     заранее: локально, бесплатно и до подписи.
 *  2. НЕХВАТКА. Литерал ставится однажды и не растёт вместе с функцией.
 *     Замерено 17 августа 2026 (`forge test -vvvv`,
 *     `test_AddArbiterWorksBeforeDao`): `DiamondProxy::fallback → addArbiter`
 *     стоит 134 389 газа, а на кнопке стояло 120 000. То есть кнопка была
 *     мертва по ПРАВИЛЬНОМУ пути и сжигала весь лимит впустую при каждом
 *     нажатии — и заметить это было неоткуда, потому что тост говорит
 *     «Transaction reverted on-chain» и на нехватке газа, и на отказе контракта.
 *
 * Оба несчастья видны только человеку с пустым кошельком и без объяснения,
 * поэтому правило простое: ПИСЬМО В АРБИТРАЖНЫЙ ФАСЕТ ИДЁТ БЕЗ `gas:`.
 * Экономия одного `eth_estimateGas` этого не стоит.
 *
 * ⚠️ ЧТО СЮДА НЕ ВХОДИТ И ПОЧЕМУ. Настройки комиссии и адресов
 * (`setFeeRecipient`, `setTrustedForwarder`, `setFeeBps`, `setFeeFloor`,
 * `setMaxPendingRequests`) идут по `DIAMOND_ABI` в FactoryFacet, которого эта
 * ветка не касалась вовсе, и свои литералы газа сохранили. Расширять правило на
 * них — отдельное решение с отдельным замером, а не побочный эффект этой
 * работы: замок сторожит ровно то, что было измерено.
 *
 * ⚠️ ЧЕГО ЭТОТ ЗАМОК НЕ ДОКАЗЫВАЕТ: что вызов вообще доходит до цепи. Он
 * сторожит состав аргумента, то есть текст — но текст здесь и есть предмет:
 * снять литерал = изменить поведение кошелька (появляется оценка), а не
 * «убрать строчку».
 */

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

/** Все `.ts`/`.tsx` под `src/`, кроме самих тестов. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Снятие комментариев.
 *
 * ⚠️ Без него замок был бы неотличим от сломанного: разбор этой самой ловушки
 * записан комментарием ПРЯМО ВНУТРИ тех вызовов, что он сторожит, и слова
 * «жёсткого `gas:` здесь больше нет» читались бы как найденный литерал. То есть
 * замок краснел бы именно на исправленном коде — идеальная имитация работы.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Объект-аргумент каждого вызова `writeContract`/`writeContractAsync`, целиком.
 * Границы берутся счётом скобок от первой `{` после имени вызова.
 */
function writeCallArguments(source: string): string[] {
  const blocks: string[] = [];
  const re = /\bwriteContract(?:Async)?\s*\(/g;
  for (const match of source.matchAll(re)) {
    const open = source.indexOf('{', match.index! + match[0].length);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) throw new Error('незакрытый объект аргументов writeContract — разбор ненадёжен');
    blocks.push(source.slice(open, end + 1));
  }
  return blocks;
}

const FILES = sourceFiles(SRC_DIR);

/** Пары «файл → аргумент вызова», уже без комментариев. */
const ARBITER_WRITES = FILES.flatMap((file) => {
  const stripped = stripComments(readFileSync(file, 'utf8'));
  return writeCallArguments(stripped)
    .filter((block) => block.includes('ARBITER_REGISTRY_ABI'))
    .map((block) => ({ file: file.slice(SRC_DIR.length), block }));
});

describe('письмо в арбитражный фасет оценивается кошельком, а не литералом', () => {
  it('такие вызовы вообще нашлись — иначе проверка ниже тавтологична', () => {
    // Разбор, который перестал что-либо находить (сменилось имя крючка, поехал
    // счёт скобок, сузился обход каталога), выглядит ровно как чистый код.
    // Число 4 — не «столько бывает», а нижняя граница: две кнопки посадки и две
    // кнопки снятия на двух страницах, admin и arbiter.
    expect(ARBITER_WRITES.length, `найдено вызовов: ${ARBITER_WRITES.length}`)
      .toBeGreaterThanOrEqual(4);
  });

  it('ни у одного нет жёсткого gas:', () => {
    const withGas = ARBITER_WRITES
      .filter(({ block }) => /\bgas\s*:/.test(block))
      .map(({ file, block }) => `${file}: ${/functionName\s*:\s*['"](\w+)['"]/.exec(block)?.[1] ?? '?'}`);
    expect(withGas).toEqual([]);
  });
});

describe('разбор сам по себе честен', () => {
  it('комментарий со словом gas: не принимается за литерал', () => {
    const fake = `
      await writeContractAsync({
        // жёсткого gas: здесь больше нет
        abi: ARBITER_REGISTRY_ABI, functionName: 'addArbiter',
      });
    `;
    const [block] = writeCallArguments(stripComments(fake));
    expect(/\bgas\s*:/.test(block)).toBe(false);
  });

  it('настоящий литерал находится', () => {
    const fake = `
      await writeContractAsync({
        abi: ARBITER_REGISTRY_ABI, functionName: 'addArbiter', gas: BigInt(120_000),
      });
    `;
    const [block] = writeCallArguments(stripComments(fake));
    expect(/\bgas\s*:/.test(block)).toBe(true);
  });

  it('вложенный объект не обрывает границу вызова', () => {
    // Наивный поиск ближайшей `}` закончил бы блок на первой вложенной скобке —
    // и всё, что стоит после неё, включая `gas:`, стало бы невидимым.
    const fake = `
      await writeContractAsync({
        abi: ARBITER_REGISTRY_ABI, args: [{ a: 1 }], gas: BigInt(1),
      });
    `;
    const [block] = writeCallArguments(stripComments(fake));
    expect(/\bgas\s*:/.test(block)).toBe(true);
  });

  it('вызов по чужому ABI под правило не подпадает', () => {
    const fake = `
      await writeContractAsync({ abi: DIAMOND_ABI, functionName: 'setFeeBps', gas: BigInt(100_000) });
    `;
    const blocks = writeCallArguments(stripComments(fake))
      .filter((b) => b.includes('ARBITER_REGISTRY_ABI'));
    expect(blocks).toEqual([]);
  });
});
