import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { FORWARDER_CUSTOM_ERRORS } from '../app.js';

/**
 * Замок на шов «ошибки контракта → имя, которое видит человек».
 *
 * ⚠️ ЧЕГО ЗДЕСЬ НЕ БЫЛО ВООБЩЕ. Таблица `FORWARDER_CUSTOM_ERRORS` велась руками
 * и никем не сверялась. `MinimalForwarder.execute()` на отказе внутреннего
 * вызова НЕ ревертит — он возвращает `(false, revertData)`, и релеер обязан сам
 * разобрать первые четыре байта. Селектора нет в таблице — человеку уезжает
 * «Inner call reverted», то есть сырой хекс вместо причины. Проверено счётом на
 * 14 августа 2026: из ~54 ошибок арбитражного фасета в таблице лежала половина,
 * и промах этот класс порождает молча — новая ошибка просто не называется.
 *
 * ⚠️ ПОЧЕМУ СВЕРКА ИМЕННО С ИСХОДНИКОМ `.sol`, А НЕ С `out/*.json`. `out/` в
 * гите нет (.gitignore): замок, зависящий от результата сборки, был бы зелёным
 * на чистой копии репозитория — то есть сторожил бы ровно ничего. Тот же довод и
 * тот же приём, что в `agreementStatusEnum.test.js`.
 *
 * ⚠️ ЧЕГО ЭТОТ ЗАМОК НЕ ДОКАЗЫВАЕТ: что `decodeForwarderRevert` таблицей
 * пользуется. Это соседний шов, и он старше этой работы. Здесь сторожится
 * СОСТАВ: добавили ошибку в фасет и не вписали сюда — красный.
 *
 * ⚠️ ЧИТАЮТСЯ ВСЕ АРБИТРАЖНЫЕ ФАСЕТЫ, А НЕ ОДИН. До 17 августа 2026 здесь стоял
 * ровно один путь — `ArbiterRegistryFacet.sol`. Реестр упёрся в потолок EIP-170,
 * и четырнадцать чтений вместе с половиной арбитражной поверхности уехали в
 * `ArbiterAccountabilityFacet.sol` (коммит a88a2200). У нового фасета ВОСЕМЬ
 * своих ошибок, и ни одну из них замок не видел: тот самый класс промаха, ради
 * которого он заведён, жил у него под носом. Список файлов поэтому берётся с
 * диска, а не из литерала: третий арбитражный фасет попадёт под сверку сам,
 * без правки этого файла и без чьей-то памяти.
 *
 * Границей выбрано ИМЯ ФАЙЛА (`src/facets/Arbiter*.sol`), а не список
 * контрактов: имя — то, что видит человек, заводящий новый фасет, и назвать его
 * `Arbiter…` он не забудет ровно потому, что иначе не найдёт соседей.
 *
 * ⚠️ Что этот замок по-прежнему НЕ покрывает: ошибки `Agreement.sol`,
 * `FactoryFacet.sol` и прочих — в таблице они есть, но их состав не сверяется
 * ничем. Это соседний, не закрытый шов.
 */

const FACETS_DIR = new URL('../../src/facets/', import.meta.url);

/** Исходники всех арбитражных фасетов, по имени файла. */
const FACET_FILES = readdirSync(FACETS_DIR)
  .filter((f) => /^Arbiter.*\.sol$/.test(f))
  .sort();

const FACET_SOURCES = FACET_FILES.map((f) => ({
  file: f,
  src: readFileSync(new URL(f, FACETS_DIR), 'utf8'),
}));

/** Все `error Имя(типы);` из исходника — канонические подписи, по порядку. */
function solidityErrorSignatures(source) {
  return [...source.matchAll(/\berror\s+(\w+)\s*\(([^)]*)\)\s*;/g)].map(([, name, args]) => {
    const types = args
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
      .map((a) => a.split(/\s+/)[0]);
    return `${name}(${types.join(',')})`;
  });
}

/** Первые четыре байта keccak256 подписи — то же, что кладёт в revert цепь. */
const selectorOf = (signature) => ethers.id(signature).slice(0, 10).toLowerCase();

/**
 * Объединение по всем фасетам, БЕЗ дублей. Пять имён (NotOwner, NotOwnerOrChief,
 * NotAnArbiter, ArbiterZeroAddress, ZeroDigest) объявлены в обоих файлах с
 * одинаковой подписью — селектор у них один, и запись в таблице тоже одна.
 * Дубли в списке дали бы два одноимённых теста вместо одного и ничего бы не
 * добавили.
 */
const SIGNATURES = [...new Set(FACET_SOURCES.flatMap(({ src }) => solidityErrorSignatures(src)))];

describe('таблица причин релеера не отстаёт от ошибок арбитражных фасетов', () => {
  it('фасетов найдено больше одного — иначе половина поверхности не сторожится', () => {
    // Именно так замок и ослеп бы обратно: путь сузили до одного файла, тесты
    // зелёные, ошибки второго фасета доезжают до человека сырым хексом. Число
    // 2 — не «столько бывает», а «меньше двух означает, что сверка читает не
    // всю арбитражную поверхность».
    expect(FACET_FILES.length, `найдено: ${FACET_FILES.join(', ') || '(ничего)'}`)
      .toBeGreaterThanOrEqual(2);
  });

  it('каждый найденный фасет вносит хотя бы одну ошибку', () => {
    // Файл, прочитанный впустую (не тот путь, поехавшая регулярка), иначе
    // растворяется в объединении: соседний фасет один даёт больше сорока
    // подписей, и общая проверка ниже остаётся зелёной.
    for (const { file, src } of FACET_SOURCES) {
      expect(solidityErrorSignatures(src).length, `${file}: ни одной ошибки не разобрано`)
        .toBeGreaterThan(0);
    }
  });

  it('ошибки в исходниках вообще нашлись — иначе сверка тавтологична', () => {
    // Без этой строки достаточно испортить регулярку разбора, чтобы получить
    // пустой список и зелёный прогон: замок, который ничего не проверяет,
    // выглядит точно так же, как замок, у которого всё хорошо.
    expect(SIGNATURES.length).toBeGreaterThan(40);
  });

  it.each(SIGNATURES)('%s разбирается в имя, а не в сырой хекс', (signature) => {
    const name = signature.slice(0, signature.indexOf('('));
    const selector = selectorOf(signature);
    expect(FORWARDER_CUSTOM_ERRORS[selector], `${signature} (${selector}) нет в таблице`)
      .toBe(name);
  });

  it('у имён из фасета в таблице стоит правильный селектор, а не похожий хекс', () => {
    // Обратная сторона: проверка выше ловит ОТСУТСТВИЕ записи, эта — запись с
    // опечаткой в хексе. Без неё «имя есть, но под чужим селектором» читалось
    // бы как порядок: имя-то в файле присутствует.
    const byName = new Map(SIGNATURES.map((s) => [s.slice(0, s.indexOf('(')), s]));
    for (const [selector, name] of Object.entries(FORWARDER_CUSTOM_ERRORS)) {
      const signature = byName.get(name);
      if (!signature) continue; // ошибка не арбитражного фасета — не наше дело
      expect(selector.toLowerCase(), `${name}: селектор в таблице не сходится`)
        .toBe(selectorOf(signature));
    }
  });

  it('одно имя не занимает в таблице два разных селектора', () => {
    const seen = new Map();
    for (const [selector, name] of Object.entries(FORWARDER_CUSTOM_ERRORS)) {
      expect(seen.has(name), `${name} лежит в таблице дважды: ${seen.get(name)} и ${selector}`)
        .toBe(false);
      seen.set(name, selector);
    }
  });

  it('разбор подписей снимает имена аргументов, а не типы', () => {
    expect(solidityErrorSignatures('error InsufficientXP(uint256 have, uint256 need);'))
      .toEqual(['InsufficientXP(uint256,uint256)']);
    expect(solidityErrorSignatures('error ZeroDigest();')).toEqual(['ZeroDigest()']);
  });
});

/**
 * ⚠️ ВТОРАЯ ДОРОГА ЧЕРЕЗ ТОТ ЖЕ ФОРВАРДЕР. Браузер шлёт гейслесс не сюда, а в
 * `frontend/src/app/api/relay/route.ts`, и та таблица — своя, отдельная (общего
 * кода у двух рантаймов нет, см. комментарий над таблицей в app.js). Значит
 * отстать может любая из двух, и молча: релеерная половина зелена сама по себе.
 * Замерено 14 августа: пять ошибок платного вызова арбитра были дописаны в
 * app.js 31 июля и НЕ дописаны в route.ts, где ходит человек.
 */
describe('две таблицы одного форвардера не противоречат друг другу', () => {
  const ROUTE_SRC = readFileSync(
    new URL('../../frontend/src/app/api/relay/route.ts', import.meta.url), 'utf8');

  function routeErrorTable(source) {
    const block = /const CUSTOM_ERRORS: Record<string, string> = \{([\s\S]*?)\n\s*\};/.exec(source);
    if (!block) throw new Error('таблица CUSTOM_ERRORS не найдена в route.ts');
    const table = {};
    for (const [, selector, name] of block[1].matchAll(/'(0x[0-9a-fA-F]{8})':\s*'(\w+)'/g)) {
      table[selector.toLowerCase()] = name;
    }
    if (Object.keys(table).length === 0) throw new Error('таблица CUSTOM_ERRORS пуста');
    return table;
  }

  const ROUTE_TABLE = routeErrorTable(ROUTE_SRC);

  it('на общих селекторах имена совпадают', () => {
    for (const [selector, name] of Object.entries(FORWARDER_CUSTOM_ERRORS)) {
      if (ROUTE_TABLE[selector] === undefined) continue;
      expect(ROUTE_TABLE[selector], `${selector}: релеер и фронт называют разное`).toBe(name);
    }
  });

  it('ошибки арбитражных фасетов есть в обеих таблицах, а не в одной', () => {
    const missingInRoute = SIGNATURES.filter((s) => ROUTE_TABLE[selectorOf(s)] === undefined);
    const missingInRelayer = SIGNATURES.filter(
      (s) => FORWARDER_CUSTOM_ERRORS[selectorOf(s)] === undefined,
    );
    expect({ missingInRoute, missingInRelayer }).toEqual({
      missingInRoute: [],
      missingInRelayer: [],
    });
  });
});
