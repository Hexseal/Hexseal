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

/**
 * Каноническая подпись из объявления функции в .sol: только типы, по порядку.
 *
 * Обязана падать, если объявлений больше одного — иначе перегрузка молча
 * подменяет подпись, по которой сверяется замок (регулярка без флага `g`
 * раньше брала первое совпадение и не глядела, есть ли второе). Ревью
 * Задачи 1 подсунуло в .sol вторую перегрузку claimDispute(address) и
 * показало, что первые две проверки в этом файле сверяются с чем попало,
 * пока их не подпирает третья («ровно одно объявление»). Явный отказ здесь
 * убирает саму возможность тихой подмены, а не полагается на соседнюю
 * проверку это заметить.
 */
function solidityCanonicalSignature(source: string, fnName: string): string {
  // Объявление может быть многострочным, поэтому берём всё до закрывающей скобки.
  const re = new RegExp(`function\\s+${fnName}\\s*\\(([^)]*)\\)`, 'mg');
  const matches = [...source.matchAll(re)];
  if (matches.length === 0) throw new Error(`объявление ${fnName} не найдено в исходнике`);
  if (matches.length > 1) {
    throw new Error(
      `объявление ${fnName} встречается ${matches.length} раза в исходнике — ` +
      `подпись неоднозначна, каноническую сверку сделать нельзя`,
    );
  }
  const types = matches[0][1]
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

/**
 * Блок объявления функции целиком — от `function fnName(` до первой `{`
 * (начала тела). Нужен для типов ВОЗВРАТА: они стоят в `returns (...)`
 * ПОСЛЕ списка аргументов, `solidityCanonicalSignature` туда не заглядывает —
 * ей нужны только входы.
 *
 * Та же проверка «ровно одно объявление», что и выше, и по той же причине:
 * без неё вторая перегрузка молча подставила бы чужой `returns (...)`.
 */
function solidityDeclarationBlock(source: string, fnName: string): string {
  const re = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)[\\s\\S]*?(?:\\{|;)`, 'g');
  const matches = [...source.matchAll(re)];
  if (matches.length === 0) throw new Error(`объявление ${fnName} не найдено в исходнике`);
  if (matches.length > 1) {
    throw new Error(
      `объявление ${fnName} встречается ${matches.length} раза в исходнике — ` +
      `подпись неоднозначна, каноническую сверку сделать нельзя`,
    );
  }
  return matches[0][0];
}

/**
 * Канонические типы ВОЗВРАТА из объявления в .sol: `returns (t1 a, t2 b)` →
 * `"t1,t2"`. Пустая строка — функция без возврата (как у `claimDispute`).
 */
function solidityCanonicalReturnTypes(source: string, fnName: string): string {
  const decl = solidityDeclarationBlock(source, fnName);
  const returnsMatch = decl.match(/returns\s*\(([^)]*)\)/);
  if (!returnsMatch) return '';
  const types = returnsMatch[1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.split(/\s+/)[0]);
  return types.join(',');
}

/** Канонические типы возврата из ABI-записи viem (`entry.outputs`). */
function abiCanonicalReturnTypes(abi: readonly unknown[], fnName: string): string {
  const entry = (abi as any[]).find(
    (e) => e && e.type === 'function' && e.name === fnName,
  );
  if (!entry) throw new Error(`${fnName} не найдена в ABI`);
  const types = (entry.outputs ?? []).map((o: any) => o.type);
  return types.join(',');
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

  it('solidityCanonicalSignature падает, если объявлений больше одного', () => {
    // Не читаем реальный .sol — здесь важно только поведение самой функции
    // разбора на сфабрикованном источнике с перегрузкой. Именно так ревью
    // Задачи 1 и нашло дыру: вторая перегрузка в файле молча брала первую
    // найденную сигнатуру, и с ней «совпадала» проверка записи в
    // config/contracts.ts — по чистой случайности, а не потому что запись
    // была верна.
    const fakeSourceWithOverload = `
      function claimDispute(address agreement, bytes32 salt, bytes32 boxKey, bytes32 signKey) external {}
      function claimDispute(address agreement) external {}
    `;
    expect(() => solidityCanonicalSignature(fakeSourceWithOverload, 'claimDispute')).toThrow();
  });
});

/**
 * `getArbiterChatKeys` добавлена в `config/contracts.ts` только что (Задача 3,
 * следом за брифом, который сам об этой записи не знал: без неё
 * `readArbiterChatKeysFromChain` падал бы на живой странице — grep по этому
 * имени в contracts.ts до правки давал ноль совпадений). Тот же класс дыры,
 * что закрывал этот файл для `claimDispute`, здесь тоже есть, только с
 * дополнительной стороной: у `getArbiterChatKeys` есть ВОЗВРАТ, у `claimDispute`
 * его не было. Ошибка во ВХОДЕ ловится ревертом при вызове — она видна сразу.
 * Ошибка в ВЫХОДЕ (один `bytes32` вместо двух, перепутанный порядок box/sign)
 * не ревертит ничего: `readContract` в `readArbiterChatKeysFromChain`
 * приводит результат типом (`as [Hex, Hex]`), без проверки формы в рантайме —
 * рассинхрон читался бы молча, как неверный ключ, который никто не заметит
 * до первой попытки расшифровать чужую переписку.
 */
describe('ABI чтения ключей арбитра не расходится с контрактом', () => {
  it('входы совпадают с исходником контракта', () => {
    const fromContract = solidityCanonicalSignature(FACET, 'getArbiterChatKeys');
    const fromConfig = abiCanonicalSignature(
      ARBITER_REGISTRY_ABI as readonly unknown[],
      'getArbiterChatKeys',
    );
    expect(fromConfig).toBe(fromContract);
  });

  it('выходы совпадают с исходником контракта — здесь ошибка молчит', () => {
    const fromContract = solidityCanonicalReturnTypes(FACET, 'getArbiterChatKeys');
    const fromConfig = abiCanonicalReturnTypes(
      ARBITER_REGISTRY_ABI as readonly unknown[],
      'getArbiterChatKeys',
    );
    expect(fromConfig).toBe(fromContract);
  });

  it('исходник контракта содержит ровно одно объявление getArbiterChatKeys', () => {
    const count = (FACET.match(/function\s+getArbiterChatKeys\s*\(/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('solidityCanonicalReturnTypes падает, если объявлений больше одного', () => {
    // Тот же приём, что и для solidityCanonicalSignature выше: на сфабрикованном
    // источнике с перегрузкой, не на реальном .sol. Без этой проверки вторая
    // перегрузка молча взяла бы `returns (...)` первого совпадения — и «совпадение»
    // с ABI ничего бы не доказывало.
    const fakeSourceWithOverload = `
      function getArbiterChatKeys(address arbiter) external view returns (bytes32 boxKey, bytes32 signKey) {}
      function getArbiterChatKeys(bytes32 arbiter) external view returns (bytes32 boxKey) {}
    `;
    expect(() => solidityCanonicalReturnTypes(fakeSourceWithOverload, 'getArbiterChatKeys')).toThrow();
  });
});
