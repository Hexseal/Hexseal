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
 * ⚠️ ПРАВИЛО РАСШИРЕНО НА ВТОРОЙ АРБИТРАЖНЫЙ ABI 21 АВГУСТА 2026, И ЭТО БЫЛА
 * ДЫРА, А НЕ ПРЕДОСТОРОЖНОСТЬ. Разбор ниже искал ровно строку
 * `ARBITER_REGISTRY_ABI`, а поток сноса (`proposeRemoval`, `withdrawProposal`,
 * `removeArbiterForCause`, `executeChainRemoval`) идёт по
 * `ARBITER_ACCOUNTABILITY_ABI` — другому имени, тому же фасету, тем же двум
 * несчастьям. Причём ИМЕННО ЭТИ кнопки сегодня опаснее всех: разрез не сделан,
 * все четыре функции в даймонде отсутствуют, и с жёстким литералом каждое
 * нажатие уходило бы в цепь и сжигало лимит на ревёрте fallback'а.
 * Класс тот же, что уже ловили дважды: сканер узнаёт НАПИСАНИЕ, а не то, на что
 * оно ссылается.
 *
 * ⚠️ И РАСШИРЕНИЯ СПИСКА ИМЁН НЕ ХВАТИЛО — ЗАМЕРЕНО, А НЕ ПРЕДПОЛОЖЕНО (круг
 * правок 1, тот же день). Третье написание того же класса: взять ABI В
 * ПЕРЕМЕННУЮ.
 *
 *     const REMOVAL_ABI = ARBITER_ACCOUNTABILITY_ABI;
 *     await writeContractAsync({ abi: REMOVAL_ABI, …, gas: BigInt(300_000) });
 *
 * Замок со списком из двух имён на этом давал 8 passed, 0 failed. То же и с
 * переименованием на импорте (`import { ARBITER_REGISTRY_ABI as REG }`).
 *
 * Обиднее всего, что в ЭТОМ ЖЕ ФАЙЛЕ класс однажды осознан: `writerNames`
 * понимает переименование крючка. Для аргумента `abi` — не понимал.
 *
 * Поэтому имён больше не ищем вовсе. `arbiterAbiNames` РАЗРЕШАЕТ псевдонимы:
 * базовые имена → переименования на импорте → присваивания в переменные, и так
 * до устойчивого множества. Имя переменной перестало иметь значение.
 *
 * ⚠️ И ЧЕТВЁРТОЕ НАПИСАНИЕ ЗАКРЫТО НЕ ПЕРЕЧИСЛЕНИЕМ, А УМОЛЧАНИЕМ В ПОЛЬЗУ
 * ПРАВИЛА. Разрешить можно не всё: `abi` бывает параметром функции
 * (`sendAgreementGasless` в `relay.ts` шлёт `{ address, abi, functionName }`),
 * бывает полем объекта, бывает возвратом вызова. Перечислять эти формы значило
 * бы заводить пятое написание раз в месяц. Поэтому: если разбор НЕ СМОГ
 * доказать, что ABI чужой, — правило применяется. Случай, который сканер не
 * разобрал, обязан краснеть, а не молчать. Цена умолчания нулевая: у обоих
 * таких вызовов в дереве жёсткого газа нет и быть не должно — они уходят в
 * даймонд и в клон агримента с ЧУЖИМ ABI, то есть оценка нужна им тем более.
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
 * Как в этом файле зовут писателя.
 *
 * ⚠️ ДОБАВЛЕНО 17 АВГУСТА 2026, И ЭТО БЫЛА НАСТОЯЩАЯ ДЫРА, А НЕ ПРЕДОСТОРОЖНОСТЬ.
 * Разбор искал два имени, `writeContract` и `writeContractAsync`, — а крючок
 * отдаётся деструктуризацией и его законно переименовывают. В дереве такой
 * вызов ровно один и он арбитрский: `const { writeContractAsync:
 * applyAsArbiterWrite } = useWriteContract()` в `hooks/useWalletAccountData.ts`.
 * Замер: поставить туда `gas: BigInt(120_000)` — 0 красных из 6. То есть правило
 * «письмо в арбитражный фасет идёт без gas:» обходилось одной строкой
 * переименования, и обходилось бы молча.
 */
function writerNames(source: string): string[] {
  const names = new Set(['writeContract', 'writeContractAsync']);
  for (const [, inside] of source.matchAll(/\{([^}]*)\}\s*=\s*useWriteContract\s*\(/g)) {
    for (const [, alias] of inside.matchAll(/writeContract(?:Async)?\s*:\s*(\w+)/g)) {
      names.add(alias);
    }
  }
  return [...names];
}

/**
 * Объект-аргумент каждого вызова писателя, целиком.
 * Границы берутся счётом скобок от первой `{` после имени вызова.
 */
function writeCallArguments(source: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`\\b(?:${writerNames(source).join('|')})\\s*\\(`, 'g');
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

/**
 * Имена, под которыми арбитражный ABI приходит ИЗ `config/contracts.ts`.
 *
 * ⚠️ ОБА ВЕДУТ В ОДИН ФАСЕТ АРБИТРАЖА, и держать правило на одном имени
 * означало бы, что вторая половина дверей обходит его молча — одним импортом.
 * Дальше эти два имени только НАЧАЛО: `arbiterAbiNames` доращивает их
 * псевдонимами, найденными в самом файле.
 */
const ARBITER_ABIS = ['ARBITER_REGISTRY_ABI', 'ARBITER_ACCOUNTABILITY_ABI'] as const;

/**
 * Все имена, которые В ЭТОМ ФАЙЛЕ означают арбитражный ABI.
 *
 * Три источника, и третий — тот, на котором замок молчал:
 *
 *  1. базовые имена экспорта;
 *  2. переименование на импорте — `import { ARBITER_REGISTRY_ABI as REG }`;
 *  3. присваивание в переменную — `const REMOVAL_ABI = ARBITER_..._ABI` (и
 *     через `as Abi`, и с объявленным типом), ТРАНЗИТИВНО: псевдоним
 *     псевдонима тоже псевдоним.
 *
 * ⚠️ Переименование ищется только ВНУТРИ фигурных скобок импорта. Наивный
 * поиск `X as Y` по всему файлу принял бы за псевдоним утверждение типа
 * `ARBITER_REGISTRY_ABI as Abi` и завёл бы имя `Abi`.
 */
export function arbiterAbiNames(source: string): Set<string> {
  const names = new Set<string>(ARBITER_ABIS);

  for (const clause of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
    for (const [, imported, alias] of clause[1].matchAll(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      if (names.has(imported)) names.add(alias);
    }
  }

  // Замыкание по присваиваниям: пока множество растёт, идём ещё круг.
  for (let grew = true; grew;) {
    grew = false;
    for (const [, alias, rhs] of source.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*([A-Za-z_$][\w$]*)/g,
    )) {
      if (names.has(rhs) && !names.has(alias)) { names.add(alias); grew = true; }
    }
  }

  return names;
}

/**
 * Значение `abi:` из блока аргументов — без утверждения типа.
 *
 * `null` означает «разобрать не смог»: сокращённая запись `{ address, abi,
 * functionName }`, поле объекта, возврат вызова. Это НЕ «здесь чужой ABI» —
 * см. умолчание в пользу правила в шапке.
 */
export function abiIdentifier(block: string): string | null {
  const m = /\babi\s*:\s*([^,\n}]+)/.exec(block);
  if (!m) return null;
  const bare = m[1].trim().replace(/\s+as\s+[\w.<>[\]|]+$/, '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(bare) ? bare : null;
}

const FILES = sourceFiles(SRC_DIR);

/** Пары «файл → аргумент вызова», уже без комментариев. */
const ARBITER_WRITES = FILES.flatMap((file) => {
  const stripped = stripComments(readFileSync(file, 'utf8'));
  const names = arbiterAbiNames(stripped);
  // Файл, где арбитражный ABI не упоминается ни под каким именем, писать в этот
  // фасет по константе не может — и умолчание в пользу правила его не касается.
  const touchesArbiter = [...names].some((n) => new RegExp(`\\b${n}\\b`).test(stripped));

  return writeCallArguments(stripped)
    .filter((block) => {
      const abi = abiIdentifier(block);
      if (abi === null) return touchesArbiter;   // не разобрали — правило применяем
      return names.has(abi);
    })
    .map((block) => ({ file: file.slice(SRC_DIR.length), block }));
});

describe('письмо в арбитражный фасет оценивается кошельком, а не литералом', () => {
  it('такие вызовы вообще нашлись — иначе проверка ниже тавтологична', () => {
    // Разбор, который перестал что-либо находить (сменилось имя крючка, поехал
    // счёт скобок, сузился обход каталога), выглядит ровно как чистый код.
    // Число 5 — не «столько бывает», а нижняя граница: кнопки посадки на двух
    // страницах (admin и arbiter), `applyAsArbiter`, которого прежний разбор не
    // видел вовсе (см. `writerNames`), общий путь письма потока сноса в
    // `components/AdminArbiterAccountability.tsx` и два неразобранных вызова
    // `relay.ts`, попадающих сюда по умолчанию в пользу правила. Кнопок снятия
    // в этом счёте больше нет: обе удалены 21 августа вместе с селектором
    // `removeArbiter`. Вердикт, финализация и награда 17 августа ушли на
    // гейслесс и прямыми вызовами больше не идут.
    expect(ARBITER_WRITES.length, `найдено вызовов: ${ARBITER_WRITES.length}`)
      .toBeGreaterThanOrEqual(5);
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

  it('переименованный писатель виден разбору', () => {
    // Тот самый обход, который дерево уже содержало: имя крючка сменили при
    // деструктуризации, и вызов стал невидим.
    const fake = `
      const { writeContractAsync: applyAsArbiterWrite } = useWriteContract();
      await applyAsArbiterWrite({ abi: ARBITER_REGISTRY_ABI, functionName: 'applyAsArbiter', gas: BigInt(1) });
    `;
    const [block] = writeCallArguments(stripComments(fake));
    expect(block).toBeDefined();
    expect(/\bgas\s*:/.test(block)).toBe(true);
  });

  /** Так решает боевой сбор: имя `abi:` — псевдоним арбитражного или нет. */
  const subject = (source: string) => {
    const stripped = stripComments(source);
    const names = arbiterAbiNames(stripped);
    const touches = [...names].some((n) => new RegExp(`\\b${n}\\b`).test(stripped));
    return writeCallArguments(stripped).filter((b) => {
      const abi = abiIdentifier(b);
      return abi === null ? touches : names.has(abi);
    });
  };

  it('вызов по чужому ABI под правило не подпадает', () => {
    expect(subject(`
      await writeContractAsync({ abi: DIAMOND_ABI, functionName: 'setFeeBps', gas: BigInt(100_000) });
    `)).toEqual([]);
  });

  /**
   * ⚠️ Сцена ровно на ту дыру, которой этот замок болел до 21 августа: тот же
   * фасет, другое имя ABI.
   */
  it('второй арбитражный ABI разбору виден', () => {
    const blocks = subject(`
      await writeContractAsync({
        abi: ARBITER_ACCOUNTABILITY_ABI, functionName: 'proposeRemoval', gas: BigInt(300_000),
      });
    `);
    expect(blocks.length).toBe(1);
    expect(/\bgas\s*:/.test(blocks[0])).toBe(true);
  });

  /**
   * ⚠️ ТРЕТЬЕ НАПИСАНИЕ, ЗАМЕРЕННОЕ РЕВЬЮЕРОМ: ABI взят в переменную. На
   * прежнем замке — 8 passed, 0 failed, ноль красных. Имя переменной здесь
   * нарочно не похоже ни на одно из базовых: замок, узнающий подстроку `ABI`,
   * прошёл бы мимо.
   */
  it('ABI, взятый в переменную, разбору виден — как бы её ни назвали', () => {
    const blocks = subject(`
      import { ARBITER_ACCOUNTABILITY_ABI } from '@/config/contracts';
      const removalDoor = ARBITER_ACCOUNTABILITY_ABI;
      await writeContractAsync({
        abi: removalDoor, functionName: 'proposeRemoval', gas: BigInt(300_000),
      });
    `);
    expect(blocks.length).toBe(1);
    expect(/\bgas\s*:/.test(blocks[0])).toBe(true);
  });

  it('и псевдоним псевдонима тоже', () => {
    const blocks = subject(`
      const first = ARBITER_REGISTRY_ABI as Abi;
      const second: Abi = first;
      await writeContractAsync({ abi: second, functionName: 'addArbiter', gas: BigInt(1) });
    `);
    expect(blocks.length).toBe(1);
  });

  it('переименование на импорте разбору видно', () => {
    const blocks = subject(`
      import { ARBITER_REGISTRY_ABI as REG, CONTRACTS } from '@/config/contracts';
      await writeContractAsync({ abi: REG, functionName: 'addArbiter', gas: BigInt(1) });
    `);
    expect(blocks.length).toBe(1);
  });

  it('«ARBITER_REGISTRY_ABI as Abi» не заводит псевдоним по имени типа', () => {
    // Наивный поиск `X as Y` по всему файлу добавил бы сюда имя `Abi`, и любой
    // вызов `abi: Abi` стал бы «арбитражным».
    expect(arbiterAbiNames('const x = { abi: ARBITER_REGISTRY_ABI as Abi };').has('Abi')).toBe(false);
  });

  /**
   * ⚠️ УМОЛЧАНИЕ В ПОЛЬЗУ ПРАВИЛА. `abi` сокращённой записью разобрать нечем —
   * и именно поэтому такой вызов обязан попасть под правило, а не выпасть из
   * него. Обратное поведение и есть способ обойти замок навсегда: достаточно
   * положить ABI в переменную с именем `abi`.
   */
  it('неразобранный abi в арбитражном файле правилу подчиняется', () => {
    const blocks = subject(`
      import { ARBITER_REGISTRY_ABI } from '@/config/contracts';
      const abi = pickAbi();
      await writeContractAsync({ address: DIAMOND, abi, functionName, args, gas: BigInt(1) });
    `);
    expect(blocks.length).toBe(1);
  });

  it('а в файле, где арбитражного ABI нет вовсе, — не подчиняется', () => {
    expect(subject(`
      const abi = pickAbi();
      await writeContractAsync({ address: USDC, abi, functionName, args, gas: BigInt(1) });
    `)).toEqual([]);
  });
});
