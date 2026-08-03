import { describe, it, expect } from 'vitest';
import { size } from 'viem';
import { buildLink, linkHash, linkPreimage, verifyChain, GENESIS_HASH, LINK_ENCODING_TYPES, type ChainLink } from './chatChain';

const ALICE = '0x1111111111111111111111111111111111111111' as const;
const BOB   = '0x2222222222222222222222222222222222222222' as const;
const BODY  = ('0x' + 'aa'.repeat(32)) as `0x${string}`;

function chainOf(n: number): ChainLink[] {
  const out: ChainLink[] = [];
  for (let i = 0; i < n; i++) out.push(buildLink(out[i - 1] ?? null, BODY, ALICE, 1000 + i));
  return out;
}

describe('buildLink', () => {
  it('первое звено ссылается на генезис и имеет номер 0', () => {
    const link = buildLink(null, BODY, ALICE, 1000);
    expect(link.seq).toBe(0);
    expect(link.prevHash).toBe(GENESIS_HASH);
  });

  it('следующее звено наследует номер и отпечаток предыдущего', () => {
    const first  = buildLink(null, BODY, ALICE, 1000);
    const second = buildLink(first, BODY, BOB, 2000);
    expect(second.seq).toBe(1);
    expect(second.prevHash).toBe(linkHash(first));
  });

  it('адрес отправителя приводится к нижнему регистру', () => {
    const link = buildLink(null, BODY, ALICE.toUpperCase() as `0x${string}`, 1000);
    expect(link.sender).toBe(ALICE);
  });
});

describe('linkHash', () => {
  it('одинаковые звенья дают одинаковый отпечаток', () => {
    const a = buildLink(null, BODY, ALICE, 1000);
    const b = buildLink(null, BODY, ALICE, 1000);
    expect(linkHash(a)).toBe(linkHash(b));
  });

  it('изменение ЛЮБОГО поля меняет отпечаток', () => {
    const base = buildLink(null, BODY, ALICE, 1000);
    const h = linkHash(base);
    const OTHER_BODY = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    expect(linkHash({ ...base, seq: 1 })).not.toBe(h);
    expect(linkHash({ ...base, bodyHash: OTHER_BODY })).not.toBe(h);
    expect(linkHash({ ...base, sender: BOB })).not.toBe(h);
    expect(linkHash({ ...base, sentAt: 1001 })).not.toBe(h);
    expect(linkHash({ ...base, prevHash: OTHER_BODY })).not.toBe(h);
  });

  it('золотой вектор (раунд 5, находка I4): абсолютные байты, не сравнение двух вызовов', () => {
    // Все остальные тесты в этом файле ОТНОСИТЕЛЬНЫЕ — сравнивают два
    // вызова между собой или проверяют "изменилось ли что-то". Ревью
    // раунда 5 указало: этого недостаточно для порядка полей — молчаливая
    // перестановка (например prevHash <-> bodyHash, оба bytes32 —
    // I3 этого не ловит, список типов кодирования не меняется) обесценила
    // бы все уже сохранённые цепочки и любую независимую реализацию
    // (арбитраж, будущий бэкенд), а все относительные тесты остались бы
    // зелёными — они не видят СМЕЩЕНИЕ, только несовпадение с самим собой.
    //
    // Значение посчитано НЕЗАВИСИМО от этого файла и от viem — отдельным
    // скриптом на чистом node через `ethers` (`solidityPacked` +
    // `keccak256`, другая реализация обеих функций, не разделяет код с
    // viem/@noble). node:crypto для keccak256 непригоден: у него есть
    // только 'sha3-256' (NIST SHA3), который отличается от Keccak-256
    // паддингом и даёт другой хеш — ethers сам по себе уже независимая
    // от viem реализация обеих операций (упаковки и хеширования).
    //
    // Проверено также: перестановка prevHash <-> bodyHash в той же
    // упаковке даёт ДРУГОЙ хеш (0x569d95e64...c3f63d, не совпадает) —
    // золотой вектор ниже действительно чувствителен к порядку полей.
    //
    // Если этот тест когда-нибудь покраснеет — это ЛИБО осознанная
    // миграция формата (тогда вектор пересчитывается тем же способом и
    // обновляется здесь), ЛИБО молчаливая перестановка/подмена поля,
    // которую иначе не поймал бы ничто.
    const link: ChainLink = {
      seq: 3,
      prevHash: ('0x' + '11'.repeat(32)) as `0x${string}`,
      bodyHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
      sender: '0x2222222222222222222222222222222222222222',
      sentAt: 5000,
    };
    expect(linkHash(link)).toBe(
      '0x070203e565580826fa5ef0b28bf236c3586bbcfd7374ae9456cda08677fd9b9d',
    );
  });

  it('золотой вектор №2 (раунд 6, находка I1): sentAt за пределами 2^32, ловит усечение', () => {
    // Первый золотой вектор использует sentAt: 5000 — маленькое число,
    // 5000 % 2**32 === 5000, поэтому усечение BigInt(link.sentAt % 2**32)
    // (правдоподобная ошибка реализации — где-то в истории 32-битных
    // таймстампов, "оптимизация" или неверное приведение типа) дало бы
    // ТОТ ЖЕ отпечаток и осталось бы незамеченным. sentAt здесь —
    // 1_700_000_000_000 (реалистичный unix-таймстамп в миллисекундах,
    // ~1.7e12) — заведомо больше 2^32 (~4.29e9); усечённая версия
    // (sentAt % 2**32 = 3487918080) даёт ДРУГОЙ отпечаток, проверено
    // эмпирически при подготовке вектора. Считано тем же независимым
    // способом (ethers, отдельный node-скрипт), что и вектор №1.
    const link: ChainLink = {
      seq: 7,
      prevHash: ('0x' + '33'.repeat(32)) as `0x${string}`,
      bodyHash: ('0x' + '44'.repeat(32)) as `0x${string}`,
      sender: '0x1111111111111111111111111111111111111111',
      sentAt: 1_700_000_000_000,
    };
    expect(linkHash(link)).toBe(
      '0xdac5e09c1c85376d102b85f288e57c1410838bf0f12f8938e90b4d8c40aa4192',
    );
  });
});

describe('linkPreimage — раунд 5, находка I3: не более ОДНОГО поля переменной ширины', () => {
  // Раунд 4 запирал ЧИСЛО БАЙТ (148) — сигнализация, а не замок, и правило
  // под ней было неверным. encodePacked остаётся инъективной при РОВНО
  // ОДНОМ поле переменной ширины, где бы оно ни стояло — границы
  // восстанавливаются по фиксированным полям вокруг. Опасны ровно ДВА и
  // больше динамических поля: "ab"+"cdef" и "abcd"+"ef" дают идентичную
  // упаковку 0xabcdef (проверено эмпирически через encodePacked). Подпись
  // плана 3 (вероятно ПУСТАЯ на момент buildLink — подписать синхронно
  // нечем) не меняет число байт вообще и проходила бы мимо теста на 148
  // незамеченной; тест на список типов не зависит от того, пуста ли
  // подпись в конкретном звене — только от того, сколько типов в схеме
  // объявлено динамическими.
  //
  // Гейт НЕ ловит перестановку местами двух полей ОДИНАКОВОЙ ширины
  // (prevHash ↔ bodyHash) — список типов от такой перестановки не
  // меняется. От этого отдельно защищает золотой вектор ниже.

  function isDynamicAbiType(t: string): boolean {
    return t === 'bytes' || t === 'string' || /\[\]$/.test(t);
  }

  it('среди типов кодирования звена не более одного динамического поля', () => {
    const dynamicCount = LINK_ENCODING_TYPES.filter(isDynamicAbiType).length;
    expect(dynamicCount).toBeLessThanOrEqual(1);
  });

  it('текущая схема кодирования звена — ровно эти пять типов, ни одного динамического', () => {
    // Явный снимок состава (не просто "count <= 1") — чтобы случайное
    // удаление типа из массива тоже было заметно, а не спряталось за
    // тем, что 4 типа тоже проходят "не более одного динамического".
    expect(LINK_ENCODING_TYPES).toEqual(['uint256', 'bytes32', 'bytes32', 'address', 'uint256']);
  });
});

describe('linkPreimage — раунд 6, находка I1: замок частичный, честно сказано об этом в JSDoc', () => {
  // Замок на LINK_ENCODING_TYPES (раунд 5) стоит на константе, которой
  // linkPreimage пользуется СЕЙЧАС, по соглашению — не на байтах, которые
  // РЕАЛЬНО уходят в encodePacked при каждом вызове. Две мутации живут
  // мимо него и мимо всех прочих тестов файла одновременно:
  //   (1) подпись, дописанная СНАРУЖИ через
  //       concat([encodePacked(LINK_ENCODING_TYPES,…), encodePacked(['bytes'],[sig??'0x'])])
  //       — вероятная форма плана 3, подпись пуста при buildLink;
  //   (2) linkPreimage зовёт encodePacked с ИНЛАЙН-списком типов,
  //       разошедшимся с LINK_ENCODING_TYPES, при нетронутой константе.
  // Полностью это тестом не закрыть (сказано прямо архитектором) — тест
  // на ширину ниже сужает дыру ЧАСТИЧНО: ловит добавленное фиксированное
  // поле и НЕПУСТОЕ динамическое, но не ловит (1) именно потому, что там
  // подпись пуста и байты не меняются — это ОСОЗНАННЫЙ, а не забытый
  // пробел, см. предупреждение над ChainLink в chatChain.ts.

  it('преимидж канонического звена — ровно 148 байт (частичная проверка, см. JSDoc над ChainLink)', () => {
    const link = buildLink(null, ('0x' + 'aa'.repeat(32)) as `0x${string}`, '0x1111111111111111111111111111111111111111', 1000);
    expect(size(linkPreimage(link))).toBe(148);
  });
});

describe('verifyChain', () => {
  // РАУНД 2, находка 2: ok/gap теперь несут unverifiedContentAtSeq — поле
  // ДОБАВЛЕНО в ожидаемые объекты этих семи тестов, остальные утверждения
  // (ok/reason/atSeq/missingAfterSeq) не изменены ни на символ. Диф — в
  // отчёте task-5-report.md, раздел "Раунд правок 2".
  it('целая цепочка проходит', () => {
    // РАУНД 3, находка I1: без сошедшегося expectedLastHash непроверено —
    // ВСЁ показанное, а не только последнее звено (доверие, не соседство).
    expect(verifyChain(chainOf(5))).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1, 2, 3, 4] });
  });

  it('пустая цепочка проходит — предъявлять нечего, но и врать не в чем', () => {
    expect(verifyChain([])).toEqual({ ok: true, unverifiedContentAtSeq: [] });
  });

  it('вырезанное сообщение видно как пропуск с номером', () => {
    const full = chainOf(5);
    const shown = [full[0], full[1], full[3], full[4]]; // убрали seq=2
    expect(verifyChain(shown)).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [1], unverifiedContentAtSeq: [0, 1, 3, 4] });
  });

  it('несколько дыр перечисляются все', () => {
    const full = chainOf(7);
    const shown = [full[0], full[2], full[4], full[6]];
    expect(verifyChain(shown)).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [0, 2, 4], unverifiedContentAtSeq: [0, 2, 4, 6] });
  });

  it('подделанное звено видно как разрыв, а не как пропуск', () => {
    const full = chainOf(4);
    const forged = [...full];
    forged[2] = { ...forged[2], bodyHash: ('0x' + 'bb'.repeat(32)) as `0x${string}` };
    expect(verifyChain(forged)).toEqual({ ok: false, reason: 'broken', atSeq: 3 });
  });

  it('перепутанный порядок отвергается отдельной причиной', () => {
    const full = chainOf(3);
    expect(verifyChain([full[1], full[0], full[2]])).toEqual({ ok: false, reason: 'unordered' });
  });

  it('цепочка, не начинающаяся с нуля, — это пропуск в начале', () => {
    const full = chainOf(4);
    expect(verifyChain([full[2], full[3]])).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [-1], unverifiedContentAtSeq: [2, 3] });
  });
});

describe('verifyChain — устойчивость к мусору из сети', () => {
  // Массив приходит от противной стороны спора. linkHash() на негодном звене
  // бросает исключение (так и задумано в Задаче 4 — там строит buildLink,
  // и бросок означает баг у нас). Здесь наоборот: непойманное исключение
  // означает, что предъявление вообще не проверилось — подарок тому, кому
  // невыгоден вердикт «подделано». Каждый сценарий обязан дать вердикт.

  it('испорченный адрес отправителя не роняет проверку', () => {
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], sender: '0xnotanaddress' as `0x${string}` };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });

  it('отпечаток не той длины не роняет проверку', () => {
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], bodyHash: ('0x' + 'aa'.repeat(31)) as `0x${string}` };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });

  it('дробный номер звена не роняет проверку', () => {
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], seq: 1.5 };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1.5 });
  });

  it('отрицательный номер в последнем звене — самое хитрое место — тоже ловится', () => {
    // Наивная реализация «поймать исключение из linkHash» никогда не считает
    // отпечаток последнего звена (сравнивать его не с чем — следующего
    // звена нет): мусор именно в последнем звене мог бы молча пройти как
    // ok:true. Проверка формы обязана идти ДО этой логики, а не полагаться
    // на побочный эффект связности.
    const full = chainOf(3);
    const garbled = [...full];
    garbled[2] = { ...garbled[2], seq: -5 };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: -5 });
  });

  it('отпечаток нечётной длины не проскакивает мимо проверки размера', () => {
    // 63 hex-символа — viem.size() округляет вверх до 32 и выглядит валидным,
    // но encodePacked всё равно бросает BytesSizeMismatchError("bytes31.5").
    // Проверка формы обязана быть точным regexp по длине строки, а не
    // полагаться на size().
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], bodyHash: ('0x' + 'a'.repeat(63)) as `0x${string}` };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });

  // prevHash не был заперт ни одним тестом отдельно от bodyHash — ревью
  // раунда 2 поймало живым прогоном: снятие isBytes32Hex(l.prevHash) даёт
  // TypeError наружу из verifyChain на null/undefined/42, а не вердикт.
  it('prevHash = null не роняет проверку', () => {
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], prevHash: null as unknown as `0x${string}` };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });

  it('prevHash = undefined не роняет проверку', () => {
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], prevHash: undefined as unknown as `0x${string}` };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });

  it('prevHash = число (42) не роняет проверку', () => {
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], prevHash: 42 as unknown as `0x${string}` };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });

  it('prevHash не той длины не роняет проверку', () => {
    // ЧЕСТНО: в отличие от null/undefined/42 выше, этот тест НЕ запирает
    // именно гейт формы — проверено мутацией (снятие isBytes32Hex(l.prevHash)
    // не красит этот тест). Структурная причина: prevHash каждого звена
    // сравнивается (sameHash) с GENESIS_HASH или с linkHash(предыдущего)
    // РАНЬШЕ, чем это же значение могло бы понадобиться как ВХОД в
    // encodePacked при вычислении linkHash САМОГО этого звена для проверки
    // следующего — и обычное неравенство строк разной длины не бросает.
    // Оставлен как замок против крэша вообще (не бросает — и то хорошо),
    // но не как доказательство именно этой строки гейта.
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], prevHash: ('0x' + 'aa'.repeat(31)) as `0x${string}` };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });
});

describe('verifyChain — ревью, раунд 1', () => {
  // C1: isNonNegativeInt проверял только Number.isInteger && >= 0 — без
  // верхней границы. encodePacked(['uint256']) бросает IntegerOutOfRangeError
  // на значениях за пределами uint256, а BigInt() внутри linkHash — RangeError
  // на нецелых. Мусор кладём на link[0] (не последний!), чтобы связность
  // гарантированно вызвала linkHash именно на нём при проверке link[1].

  it('sentAt = 1e100 не роняет проверку', () => {
    const full = chainOf(2);
    const garbled = [...full];
    garbled[0] = { ...garbled[0], sentAt: 1e100 };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 0 });
  });

  it('sentAt = Number.MAX_VALUE не роняет проверку', () => {
    const full = chainOf(2);
    const garbled = [...full];
    garbled[0] = { ...garbled[0], sentAt: Number.MAX_VALUE };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 0 });
  });

  it('переполнение в последнем звене тоже ловится гейтом формы, а не связностью', () => {
    // Тот самый слепой пятак: у последнего звена в массиве linkHash никогда
    // не вычисляется связностью (сравнивать не с чем) — гейт формы обязан
    // поймать его сам, до всякой связности.
    const full = chainOf(2);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], sentAt: 1e100 };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });

  // I2: весь массив целиком тоже может быть мусором — не только звено внутри.
  it('не-массив на входе не роняет проверку', () => {
    expect(verifyChain({} as unknown as ChainLink[])).toEqual({ ok: false, reason: 'broken', atSeq: -1, linksNotArray: true });
    expect(verifyChain(null as unknown as ChainLink[])).toEqual({ ok: false, reason: 'broken', atSeq: -1, linksNotArray: true });
  });

  // Раунд 7, находка m1: atSeq:-1 раньше означал побайтово одно и то же в
  // ДВУХ разных ситуациях — «links вообще не массив» (тест выше) и «в звене
  // РЕАЛЬНО стоит seq:-1» (звено само по себе мусор, но это мусор ВНУТРИ
  // валидного массива, не вместо него). Вызывающий код не мог отличить
  // «мне дали не массив» от «в звене отрицательный номер» — оба вердикта
  // были структурно идентичны. `linksNotArray` разводит их, не добавляя
  // нового `reason` в объединение: он есть только у первого случая.
  it('раунд 7, находка m1: atSeq:-1 из «links не массив» отличим от atSeq:-1 из легитимного (хоть и негодного) звена с seq:-1', () => {
    const full = chainOf(2);
    const notArray = verifyChain(null as unknown as ChainLink[]);
    const malformedSeq = verifyChain([{ ...full[0], seq: -1 }]);
    expect(notArray).toEqual({ ok: false, reason: 'broken', atSeq: -1, linksNotArray: true });
    expect(malformedSeq).toEqual({ ok: false, reason: 'broken', atSeq: -1 });
    expect('linksNotArray' in malformedSeq).toBe(false);
  });

  it('мусор внутри валидного массива (null/undefined элементы) даёт broken, а не исключение', () => {
    expect(verifyChain([null as unknown as ChainLink])).toEqual({ ok: false, reason: 'broken', atSeq: 0 });
    const full = chainOf(2);
    expect(verifyChain([undefined as unknown as ChainLink, full[1]])).toEqual({ ok: false, reason: 'broken', atSeq: 0 });
  });

  it('раунд 6, находка I2: мусор НЕ на позиции 0 — reportedSeqFor обязана сообщить реальный индекс, не всегда 0', () => {
    // Обе прежние фикстуры (выше) кладут мусор ровно в индекс 0 — ветка
    // «позиция в массиве» внутри reportedSeqFor никогда не проверялась
    // ни на каком другом индексе. Мутация return index -> return 0
    // пережила бы оба прежних теста незамеченной.
    const full = chainOf(2);
    expect(verifyChain([full[0], full[1], null as unknown as ChainLink])).toEqual({ ok: false, reason: 'broken', atSeq: 2 });
  });

  // Граница проверки порядка: seq[i] <= seq[i-1], не только "<". Дубль номера
  // (тот же seq у двух звеньев подряд) — тоже unordered, а не молчаливый
  // проход дальше. Мутация "<=" → "<" не должна оставлять это зелёным.
  it('повторяющийся номер звена — тоже unordered, не пропуск и не разрыв', () => {
    const full = chainOf(2);
    const dup = { ...full[1], seq: full[0].seq };
    expect(verifyChain([full[0], dup])).toEqual({ ok: false, reason: 'unordered' });
  });

  // isBytes32Hex гейта принимает A-F (регистронезависимый regexp), но сравнение
  // отпечатков было строковым "!==" — та же по значению строка в другом
  // регистре давала ложный broken на криптографически валидной цепочке.
  function upperHex(hash: `0x${string}`): `0x${string}` {
    return ('0x' + hash.slice(2).toUpperCase()) as `0x${string}`;
  }

  it('генезис-отпечаток в верхнем регистре — та же цепочка, не разрыв', () => {
    const full = chainOf(1);
    const relabelled = { ...full[0], prevHash: upperHex(GENESIS_HASH) };
    expect(verifyChain([relabelled])).toEqual({ ok: true, unverifiedContentAtSeq: [0] });
  });

  it('prevHash соседнего звена в верхнем регистре — та же цепочка, не разрыв', () => {
    const full = chainOf(2);
    const relabelled = { ...full[1], prevHash: upperHex(full[1].prevHash) };
    expect(verifyChain([full[0], relabelled])).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1] });
  });

  // C2: при непустом missingAfterSeq функция возвращалась, не проверив ни
  // одного отпечатка. Одно намеренно опущенное сообщение покупало иммунитет
  // от broken для всей остальной цепочки. Пары, смежные по номерам,
  // проверяемы и внутри дырявой цепочки — их нужно проверять, и при
  // расхождении broken обязан побеждать gap.

  it('broken побеждает gap: подделка в смежной паре внутри дырявой цепочки', () => {
    const full = chainOf(5); // seq 0..4
    const tampered3 = { ...full[3], bodyHash: ('0x' + 'bb'.repeat(32)) as `0x${string}` };
    // full1 -> tampered3: дыра (нет seq=2), не проверяема.
    // tampered3 -> full4: смежная пара (3,4) — full4.prevHash указывает на
    // отпечаток ПОДЛИННОГО full3, а не подделанного tampered3 — обязан
    // разойтись.
    const shown = [full[0], full[1], tampered3, full[4]];
    expect(verifyChain(shown)).toEqual({ ok: false, reason: 'broken', atSeq: 4 });
  });

  it('честно предъявленное подмножество (без подделки смежных пар) остаётся gap, не broken', () => {
    // Собственный регресс-замок против перегиба в другую сторону: сама по
    // себе непроверяемая дыра не обязана становиться broken — только
    // расхождение в ПРОВЕРЯЕМОЙ смежной паре.
    const full = chainOf(5);
    const shown = [full[0], full[1], full[3], full[4]]; // full3/full4 подлинные, не тронуты
    expect(verifyChain(shown)).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [1], unverifiedContentAtSeq: [0, 1, 3, 4] });
  });

  it('честный предел: самосогласованная выдуманная подцепочка внутри дыры остаётся gap', () => {
    // Атакующий может построить свою МИНИ-цепочку (seq 2..4), внутренне
    // согласованную (сам себе buildLink), но не выводимую из настоящей
    // full1. Смежные пары (2,3) и (3,4) внутри неё сойдутся сами с собой —
    // это не ловится проверкой смежных пар и не обязано ловиться: без
    // внешнего якоря (Задача/пункт C3) отличить такую подмену от честного
    // «эти сообщения правда были показаны, а другие — нет» невозможно.
    const full = chainOf(2); // full0(seq0), full1(seq1) — настоящие
    const fake2 = { seq: 2, prevHash: ('0x' + 'cc'.repeat(32)) as `0x${string}`, bodyHash: BODY, sender: ALICE, sentAt: 2002 };
    const fake3 = buildLink(fake2, BODY, ALICE, 2003);
    const fake4 = buildLink(fake3, BODY, ALICE, 2004);
    const shown = [full[0], fake2, fake3, fake4];
    expect(verifyChain(shown)).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [0], unverifiedContentAtSeq: [0, 2, 3, 4] });
  });

  it('честный предел: полностью выдуманная цепочка с seq не с нуля остаётся gap', () => {
    const fake1 = { seq: 1, prevHash: ('0x' + 'cc'.repeat(32)) as `0x${string}`, bodyHash: BODY, sender: ALICE, sentAt: 3001 };
    const fake2 = buildLink(fake1, BODY, ALICE, 3002);
    const fake3 = buildLink(fake2, BODY, ALICE, 3003);
    const fake4 = buildLink(fake3, BODY, ALICE, 3004);
    expect(verifyChain([fake1, fake2, fake3, fake4])).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [-1], unverifiedContentAtSeq: [1, 2, 3, 4] });
  });

  // I1: якорь генезиса — отдельная, ничем прежде не запертая ветка. Цепочка
  // из ОДНОГО звена нарочно исключает пары (нет links[1], петля связности
  // не выполнится ни разу) — единственное, что может поймать подделку
  // здесь, это именно проверка генезиса, а не пропавший запасной путь через
  // цикл смежных пар.
  it('генезис-отпечаток единственного звена не сходится с GENESIS_HASH — отдельно запертая ветка', () => {
    const forgedGenesis: ChainLink = {
      seq: 0,
      prevHash: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
      bodyHash: BODY,
      sender: ALICE,
      sentAt: 1000,
    };
    expect(verifyChain([forgedGenesis])).toEqual({ ok: false, reason: 'broken', atSeq: 0 });
  });
});

describe('verifyChain — C3: якорь хвоста (opts.expectedLastSeq)', () => {
  // Начало заякорено генезисом, конец — ничем: обрезка и подмена последнего
  // предъявленного звена раньше давали ok:true. opts.expectedLastSeq —
  // необязательный второй аргумент; источник значения решается в другом
  // плане, verifyChain знает только само число.

  it('РАУНД 2, находка 2: якорь по количеству совпадает — ok:true, но последнее звено остаётся в unverifiedContentAtSeq', () => {
    // tailAnchored:true раунда 1 называл это "заверено" — неверно: якорь по
    // КОЛИЧЕСТВУ ничего не говорит о КОНТЕНТЕ последнего звена (см. тест
    // "ГРАНИЦА ЗАЩИТЫ" ниже). unverifiedContentAtSeq честно называет seq=2
    // непроверенным, даже когда expectedLastSeq совпал.
    const full = chainOf(3); // seq 0,1,2
    expect(verifyChain(full, { expectedLastSeq: 2 })).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1, 2] });
  });

  it('хвост утаён (якорь больше последнего показанного) — gap, недостающий номер в missingAfterSeq', () => {
    const full = chainOf(5); // seq 0..4, реальный последний — 4
    const shown = full.slice(0, 3); // показали только 0,1,2
    expect(verifyChain(shown, { expectedLastSeq: 4 })).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [2], unverifiedContentAtSeq: [0, 1, 2] });
  });

  it('предъявлено больше, чем существует, — broken, а не gap', () => {
    const full = chainOf(5); // seq 0..4
    expect(verifyChain(full, { expectedLastSeq: 2 })).toEqual({ ok: false, reason: 'broken', atSeq: 4 });
  });

  it('пустой массив с заданным якорем — вся переписка утаена, это gap, а не ok:true', () => {
    expect(verifyChain([], { expectedLastSeq: 0 })).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [-1], unverifiedContentAtSeq: [] });
  });

  it('пустой массив без якоря остаётся ok:true — брифовый тест не переопределён', () => {
    expect(verifyChain([])).toEqual({ ok: true, unverifiedContentAtSeq: [] });
  });

  it('раунд 7, находка m2: expectedLastSeq:-1 — явный якорь «сообщений действительно не было», подтверждён на пустом предъявлении', () => {
    // До находки m2 expectedLastSeq был обязан быть >= 0 — а реальный seq
    // ПЕРВОГО сообщения тоже 0, значит МИНИМАЛЬНЫЙ валидный якорь ("0") уже
    // означал «есть хотя бы одно сообщение, последнее — seq 0». Сказать
    // «сообщений было ровно ноль» было нечем: verifyChain([], {expectedLastSeq:
    // 0}) — это gap (см. тест выше), а не ok:true, потому что 0 утверждает
    // существование seq=0. -1 никогда не бывает НАСТОЯЩИМ seq (buildLink
    // начинает с 0), поэтому безопасен как выделенный сигнал пустоты —
    // симметрично уже существующему использованию -1 в missingAfterSeq
    // («пропуск перед самым началом»).
    expect(verifyChain([], { expectedLastSeq: -1 })).toEqual({ ok: true, unverifiedContentAtSeq: [] });
  });

  it('раунд 7, находка m2: expectedLastSeq:-1, но реально показаны сообщения — противоречие, broken', () => {
    // Заявка «сообщений не было» и предъявление настоящих сообщений —
    // взаимоисключающие утверждения о том же самом факте (сколько сообщений
    // существует), тот же класс, что «предъявлено больше, чем говорит
    // якорь» выше в этом файле.
    const full = chainOf(3); // seq 0,1,2
    expect(verifyChain(full, { expectedLastSeq: -1 })).toEqual({ ok: false, reason: 'broken', atSeq: 2 });
  });

  it('раунд 7, находка m2: expectedLastSeq:-1 вместе с expectedLastHash — bad_anchor (отпечатывать нечего, если сообщений не было)', () => {
    const H = ('0x' + '11'.repeat(32)) as `0x${string}`;
    expect(verifyChain([], { expectedLastSeq: -1, expectedLastHash: H })).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('мусорный expectedLastSeq (дробный) не роняет проверку', () => {
    // РАУНД 2, находка 3: было {broken, atSeq:1.5} — вина уходила на
    // предъявителя честной цепочки за чужую ошибку в якоре. Теперь
    // отдельный вердикт bad_anchor, см. describe ниже.
    expect(verifyChain(chainOf(2), { expectedLastSeq: 1.5 })).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('мусорный expectedLastSeq (отрицательный, не спецзначение -1) не роняет проверку', () => {
    // Раунд 7, находка m2: -1 стал ЗАРЕЗЕРВИРОВАННЫМ спецзначением
    // («сообщений не было вовсе», см. describe m2 ниже) — этот тест раньше
    // использовал именно -1 как «просто мусор», но с раунда 7 -1 больше не
    // мусор. -2 остаётся мусором: единственное разрешённое отрицательное
    // значение — ровно -1.
    expect(verifyChain(chainOf(2), { expectedLastSeq: -2 })).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('внутренняя дыра и утаённый хвост — обе позиции в missingAfterSeq', () => {
    const full = chainOf(5); // seq 0..4
    const shown = [full[0], full[1], full[3]]; // нет seq=2, и хвост (seq=4) тоже не показан
    expect(verifyChain(shown, { expectedLastSeq: 4 })).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [1, 3], unverifiedContentAtSeq: [0, 1, 3] });
  });

  it('якорь совпадает численно, но связность подделана В СЕРЕДИНЕ — broken побеждает', () => {
    const full = chainOf(4); // seq 0,1,2,3
    const tampered = [...full];
    tampered[2] = { ...tampered[2], bodyHash: ('0x' + 'bb'.repeat(32)) as `0x${string}` };
    // seq=3 честный: его prevHash по-прежнему указывает на ПОДЛИННЫЙ хеш
    // seq=2, а не на пересчитанный с подделкой — расхождение поймает пара (2,3).
    expect(verifyChain(tampered, { expectedLastSeq: 3 })).toEqual({ ok: false, reason: 'broken', atSeq: 3 });
  });

  it('ГРАНИЦА ЗАЩИТЫ (раунд 1) — раунд 2 закрыл её в типе: unverifiedContentAtSeq называет подделанное звено', () => {
    // expectedLastSeq — якорь по НОМЕРУ (сколько сообщений всего), а не по
    // контенту последнего звена. prevHash звена ссылается на ПРЕДЫДУЩЕЕ, не
    // на себя: у последнего звена в массиве нет следующего, которое могло
    // бы проверить его собственный отпечаток. Подмена bodyHash/sender
    // именно у ПОСЛЕДНЕГО звена, при сохранении верного seq и prevHash,
    // невидима даже при точно совпавшем якоре по количеству — вердикт всё
    // ещё ok:true (полная защита содержимого требует expectedLastHash,
    // находка 1, или подписи из плана 3). РАЗНИЦА С РАУНДОМ 1: раньше это
    // было ok:true с tailAnchored:true — интерфейс арбитра прочитал бы как
    // «хвост заверен». Теперь unverifiedContentAtSeq:[2] честно называет
    // seq=2 непроверенным, даже когда общий вердикт ok:true.
    const full = chainOf(3); // seq 0,1,2
    const tampered = [...full];
    tampered[2] = { ...tampered[2], bodyHash: ('0x' + 'bb'.repeat(32)) as `0x${string}` };
    expect(verifyChain(tampered, { expectedLastSeq: 2 })).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1, 2] });
  });
});

describe('verifyChain — ревью, раунд 2, находка 3: bad_anchor', () => {
  // Мусор со стороны якоря — не вина того, чью цепочку разбирают. Раньше
  // verifyChain(честнаяЦепочка, {expectedLastSeq: NaN}) отдавал
  // {ok:false, reason:'broken', atSeq: NaN} — предъявителю честной цепочки
  // приписывали подделку за чужую ошибку. Плюс opts не объект (число,
  // строка, null, массив) молча игнорировался — fail-open в функции, вся
  // суть которой в недоверии ко входу. Отдельный вердикт bad_anchor не
  // обвиняет предъявителя и не позволяет мусору в опциях тихо выключить
  // проверку целиком.

  it('opts — число, не объект', () => {
    expect(verifyChain(chainOf(2), 5 as unknown as { expectedLastSeq?: number })).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('opts — строка, не объект', () => {
    expect(verifyChain(chainOf(2), '2' as unknown as { expectedLastSeq?: number })).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('opts — null, отличается от undefined (не передан вообще)', () => {
    expect(verifyChain(chainOf(2), null as unknown as { expectedLastSeq?: number })).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('opts — массив, не объект-якорь', () => {
    expect(verifyChain(chainOf(2), [1, 2] as unknown as { expectedLastSeq?: number })).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('opts не передан вообще (undefined) — это НЕ bad_anchor, это просто нет якоря', () => {
    expect(verifyChain(chainOf(2))).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1] });
  });
});

describe('verifyChain — ревью, раунд 2, находка 1: якорь по отпечатку (expectedLastHash)', () => {
  // expectedLastSeq отвечает на «сколько», expectedLastHash — на «что
  // именно». По отдельности каждый неполон. Якорь по отпечатку последнего
  // звена закрывает КАСКАДНУЮ подделку — атакующий трогает ранее звено и
  // ПЕРЕСЧИТЫВАЕТ вперёд весь хвост через buildLink, отчего все смежные
  // пары внутри становятся самосогласованы и C2 (broken побеждает gap)
  // ничего не находит. Только итоговый отпечаток последнего звена отличается
  // от истинного — вот что ловит expectedLastHash.
  //
  // Совпадение отпечатка освобождает ИМЕННО последнее звено от
  // unverifiedContentAtSeq (находка 2, следующий блок теста) — здесь просто
  // подтверждаем "не broken", раз хеш совпал.

  it('отпечаток совпадает с честной цепочкой — не broken, и последнее звено не в unverifiedContentAtSeq', () => {
    const full = chainOf(3);
    expect(verifyChain(full, { expectedLastSeq: 2, expectedLastHash: linkHash(full[2]) })).toEqual({ ok: true, unverifiedContentAtSeq: [] });
  });

  it('отпечаток не совпадает — broken', () => {
    const full = chainOf(3);
    const fakeHash = ('0x' + 'dd'.repeat(32)) as `0x${string}`;
    expect(verifyChain(full, { expectedLastSeq: 2, expectedLastHash: fakeHash })).toEqual({ ok: false, reason: 'broken', atSeq: 2 });
  });

  it('каскадная подделка (ранее звено тронуто, хвост пересчитан вперёд через buildLink) — ловится только якорем по отпечатку', () => {
    const full = chainOf(5); // seq 0..4, настоящая цепочка
    const trueLastHash = linkHash(full[4]); // истинный отпечаток ДО подделки
    const tamperedLink2 = { ...full[2], bodyHash: ('0x' + 'ee'.repeat(32)) as `0x${string}` };
    // Пересчитываем 3 и 4 ВПЕРЁД от подделанного 2 — внутри цепочка
    // самосогласована, C2 (смежные пары + генезис) не находит ничего.
    const rebuiltLink3 = buildLink(tamperedLink2, BODY, ALICE, 1103);
    const rebuiltLink4 = buildLink(rebuiltLink3, BODY, ALICE, 1104);
    const cascaded = [full[0], full[1], tamperedLink2, rebuiltLink3, rebuiltLink4];
    // Контроль: без якоря по отпечатку это ok:true — подтверждает, что
    // подделка действительно невидима для существующих проверок. РАУНД 3,
    // находка I1: без сошедшегося expectedLastHash отпечаток последнего
    // звена ничем не привязан — вся цепочка readable как сочинение,
    // согласованное само с собой. unverifiedContentAtSeq называет ВСЕ
    // показанные номера, не только последний (старое правило раунда 2
    // называло только seq=4, оставляя ПОДДЕЛАННОЕ seq=2 непоименованным).
    expect(verifyChain(cascaded)).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1, 2, 3, 4] });
    expect(verifyChain(cascaded, { expectedLastSeq: 4, expectedLastHash: trueLastHash })).toEqual({ ok: false, reason: 'broken', atSeq: 4 });
  });

  it('якорь по отпечатку не роняет честный внутренний пропуск в broken — «через дыру не пришивает»', () => {
    // Дыра на seq=2, но full3/full4 — подлинные и связаны между собой.
    // Хеш последнего показанного звена совпадает с якорем (оно и правда
    // не тронуто) — но общий вердикт остаётся gap: якорь по отпечатку не
    // лечит дыру, он проверяет только само последнее звено.
    const full = chainOf(5);
    const shown = [full[0], full[1], full[3], full[4]];
    // Хеш совпал -> последнее звено (seq=4) НЕ в unverifiedContentAtSeq;
    // остаётся только seq=1 (звено перед дырой) — якорь по отпечатку
    // проверяет только сам последний элемент, не лечит дыру в середине.
    expect(verifyChain(shown, { expectedLastSeq: 4, expectedLastHash: linkHash(full[4]) })).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [1], unverifiedContentAtSeq: [0, 1] });
  });

  it('якорь по количеству указывает на утаённый хвост — якорь по отпечатку не проверяется вообще (не broken)', () => {
    // Показали только 0,1,2 из настоящих 0..4. Хеш последнего показанного
    // звена (seq=2) заведомо не совпадёт с истинным хешем seq=4 — но это
    // не подделка, а честная обрезка, которую УЖЕ обнаружил expectedLastSeq
    // как gap. Сравнивать здесь нечего: неверно было бы обвинять в broken
    // то, что честно классифицировано как gap другим якорем.
    const full = chainOf(5);
    const shown = full.slice(0, 3);
    const result = verifyChain(shown, { expectedLastSeq: 4, expectedLastHash: linkHash(full[4]) });
    expect(result).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [2], unverifiedContentAtSeq: [0, 1, 2] });
  });

  it('expectedLastHash неверной длины — bad_anchor, а не исключение', () => {
    // expectedLastSeq валиден (1) — изолирует именно проверку формы хеша,
    // не проверку "seq обязателен" (находка I2 раунда 3).
    expect(verifyChain(chainOf(2), { expectedLastSeq: 1, expectedLastHash: ('0x' + 'aa'.repeat(31)) as `0x${string}` })).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('expectedLastHash не строка (число) — bad_anchor, а не исключение', () => {
    expect(verifyChain(chainOf(2), { expectedLastSeq: 1, expectedLastHash: 42 as unknown as `0x${string}` })).toEqual({ ok: false, reason: 'bad_anchor' });
  });
});

describe('verifyChain — ревью, раунд 2, находка 2: unverifiedContentAtSeq', () => {
  // Дыра — не только про звено ПОСЛЕ неё (missingAfterSeq), но и про
  // звено НЕПОСРЕДСТВЕННО ПЕРЕД ней: связность проверяет prevHash
  // СЛЕДУЮЩЕГО звена, а следующее (после дыры) выводится не из этого
  // звена — его собственное содержимое ничем не покрыто. Дословный пример
  // из ревью раунда 2. ПРАВИЛО СОСТАВА С ТЕХ ПОР ПЕРЕПИСАНО раундом 3
  // (находка I1, см. describe ниже) — здесь тесты БЕЗ якоря по отпечатку,
  // поэтому по новому правилу непроверено ВСЁ показанное (что тоже
  // называет tamperedC1, просто не единственного).

  it('звено перед дырой невидимо подделано (bodyHash) — verdict остаётся gap, но unverifiedContentAtSeq называет виновника', () => {
    const full = chainOf(5); // seq 0..4
    const tamperedC1 = { ...full[1], bodyHash: ('0x' + 'ff'.repeat(32)) as `0x${string}` };
    const shown = [full[0], tamperedC1, full[3], full[4]]; // нет seq=2
    // Контроль: подделка НЕ даёт broken — c3.prevHash выводится из
    // настоящего (нетронутого, не показанного) c2, а не из tamperedC1,
    // так что сравнивать tamperedC1 не с чем: гейт из C2 не находит его.
    expect(verifyChain(shown)).toEqual({
      ok: false,
      reason: 'gap',
      missingAfterSeq: [1],
      unverifiedContentAtSeq: [0, 1, 3, 4],
    });
  });

  it('звено перед дырой невидимо подделано (sentAt) — для спора это «кто что и когда сказал», дедлайны', () => {
    // sentAt не покрыт prevHash СЛЕДУЮЩЕГО звена ничем иначе, чем bodyHash —
    // тот же класс дыры, отдельно поимённый ревью (важно для дедлайнов).
    const full = chainOf(5);
    const tamperedC1 = { ...full[1], sentAt: 999999 };
    const shown = [full[0], tamperedC1, full[3], full[4]];
    expect(verifyChain(shown)).toEqual({
      ok: false,
      reason: 'gap',
      missingAfterSeq: [1],
      unverifiedContentAtSeq: [0, 1, 3, 4],
    });
  });

  it('без якоря по отпечатку непроверено ВСЁ показанное, сколько бы дыр ни было (переписано находкой I1 раунда 3)', () => {
    // Старая формулировка этого теста утверждала «k дыр -> k+1
    // непроверенных» как ОБЩЕЕ правило — это описывало правило раунда 2
    // (соседство), которое находка I1 раунда 3 отменила как заниженное.
    // Числа здесь совпадают с k+1 только потому, что в этой ЧАСТНОЙ
    // фикстуре каждое показанное звено и так изолировано дырой с обеих
    // сторон (кроме крайних) — общее правило теперь проще и жёстче: без
    // сошедшегося expectedLastHash непроверено ВСЁ показанное, длина
    // всегда равна длине массива, независимо от числа дыр.
    const full = chainOf(7); // seq 0..6
    const shown = [full[0], full[2], full[4], full[6]]; // 3 дыры (после 0,2,4)
    const result = verifyChain(shown);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'gap') {
      expect(result.missingAfterSeq).toHaveLength(3); // дыры не менялись
      expect(result.unverifiedContentAtSeq).toHaveLength(shown.length);
      expect(result.unverifiedContentAtSeq).toEqual([0, 2, 4, 6]); // = ВСЕ показанные, по возрастанию
    } else {
      throw new Error('ожидался gap');
    }
  });

  it('unverifiedContentAtSeq отсутствует на broken', () => {
    const full = chainOf(4);
    const forged = [...full];
    forged[2] = { ...forged[2], bodyHash: ('0x' + 'bb'.repeat(32)) as `0x${string}` };
    const result = verifyChain(forged);
    expect(result).toEqual({ ok: false, reason: 'broken', atSeq: 3 });
    expect('unverifiedContentAtSeq' in result).toBe(false);
  });

  it('unverifiedContentAtSeq отсутствует на unordered', () => {
    const full = chainOf(3);
    const result = verifyChain([full[1], full[0], full[2]]);
    expect(result).toEqual({ ok: false, reason: 'unordered' });
    expect('unverifiedContentAtSeq' in result).toBe(false);
  });

  it('unverifiedContentAtSeq отсутствует на bad_anchor', () => {
    // -2, не -1 — с раунда 7 -1 больше не мусорное значение (см. m2 ниже).
    const result = verifyChain(chainOf(2), { expectedLastSeq: -2 });
    expect(result).toEqual({ ok: false, reason: 'bad_anchor' });
    expect('unverifiedContentAtSeq' in result).toBe(false);
  });
});

describe('verifyChain — ревью, раунд 3, находка C1: пустой массив против якоря по отпечатку', () => {
  // Ранний возврат для пустого массива смотрел только на expectedLastSeq —
  // полное сокрытие переписки при якоре, называющем конкретное последнее
  // звено, получало вердикт «цело, непроверенного нет». Хеш-якорь обязан
  // входить в этот возврат наравне с номером.
  //
  // ПОСЛЕ находки I2 (тот же раунд) expectedLastSeq стал обязательным —
  // якорь «только по отпечатку» без номера физически недостижим (это уже
  // bad_anchor, см. describe про находку I2). Поэтому здесь оба поля
  // заданы вместе — C1 всё равно проверяем: hashAnchor в паре с seqAnchor
  // не должен обходить ранний возврат для пустого массива.
  const H = ('0x' + '11'.repeat(32)) as `0x${string}`;

  it('пустой массив с обоими якорями — gap, а не справка о здоровье', () => {
    expect(verifyChain([], { expectedLastSeq: 3, expectedLastHash: H })).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [-1], unverifiedContentAtSeq: [] });
  });

  it('согласованность: 1 звено против несходящегося хеш-якоря — broken, 0 звеньев против того же якоря — тоже отказ, не ok', () => {
    const full = chainOf(1);
    expect(verifyChain(full, { expectedLastSeq: 0, expectedLastHash: H })).toEqual({ ok: false, reason: 'broken', atSeq: 0 });
    expect(verifyChain([], { expectedLastSeq: 0, expectedLastHash: H })).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [-1], unverifiedContentAtSeq: [] });
  });
});

describe('verifyChain — ревью, раунд 3, находка I1: доверие идёт назад от якоря, а не соседство с дырой', () => {
  // Старое правило раунда 2 («последнее звено + звено перед каждой дырой»)
  // описывало СОСЕДСТВО. Нужно ДОВЕРИЕ: оно распространяется только назад
  // от внешне заякоренного отпечатка. Без сошедшегося expectedLastHash
  // отпечаток последнего звена ничем не привязан — его prevHash свободен,
  // значит содержимое предыдущего звена свободно, и так рекурсивно вся
  // цепочка читается как сочинение, согласованное само с собой.

  it('дословный пример ревью: доверие от сошедшегося хеш-якоря идёт НАЗАД только до последней дыры', () => {
    const real = chainOf(6); // seq 0..5, настоящая цепочка
    const FAKE_BODY1 = ('0x' + '22'.repeat(32)) as `0x${string}`;
    const FAKE_BODY2 = ('0x' + '33'.repeat(32)) as `0x${string}`;
    const fake0 = buildLink(null, FAKE_BODY1, BOB, 9000); // другой отправитель и тело
    const fake1 = buildLink(fake0, FAKE_BODY2, BOB, 9001); // самосогласовано само с собой
    // Дыра на seq=2 (настоящий real[2] не показан). real[3..5] — подлинные,
    // непрерывно связаны между собой и оканчиваются истинным хвостом.
    const shown = [fake0, fake1, real[3], real[4], real[5]];
    const result = verifyChain(shown, { expectedLastSeq: 5, expectedLastHash: linkHash(real[5]) });
    expect(result).toEqual({
      ok: false,
      reason: 'gap',
      missingAfterSeq: [1],
      // seq=0,1 — сочинение, доверие от якоря через дыру не дотягивается
      // (старое правило раунда 2 называло здесь только [1] — «звено перед
      // дырой» — оставляя ПОЛНОСТЬЮ ВЫДУМАННОЕ seq=0 непоименованным).
      unverifiedContentAtSeq: [0, 1],
    });
  });

  it('без сошедшегося expectedLastHash — непроверено ВСЁ показанное, без исключений (даже брифовая целая цепочка)', () => {
    // Явно поддерживает решение архитектора: chainOf(5) без якоря
    // возвращает [0,1,2,3,4], а не [4] — без внешнего якоря содержимое
    // подтвердить действительно нечем, и вердикт обязан это говорить
    // вслух, а не создавать впечатление проверенности.
    expect(verifyChain(chainOf(5))).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1, 2, 3, 4] });
  });

  it('expectedLastSeq совпал, но без expectedLastHash — непроверено ВСЁ, количество не защищает контент', () => {
    const full = chainOf(3);
    expect(verifyChain(full, { expectedLastSeq: 2 })).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1, 2] });
  });

  it('сошедшийся хеш-якорь на сплошной цепочке без дыр — непроверенных нет вообще', () => {
    const full = chainOf(3);
    expect(verifyChain(full, { expectedLastSeq: 2, expectedLastHash: linkHash(full[2]) })).toEqual({ ok: true, unverifiedContentAtSeq: [] });
  });
});

describe('verifyChain — ревью, раунд 4, находка I1: граница держит только один частный случай фикстур', () => {
  // Все фикстуры раунда 3, доходящие до непустого среза (tailVerifiedByHash
  // = true с непустым исключённым префиксом), устроены ОДИНАКОВО: цепочка
  // от нуля, ровно одна дыра, префикс [0,1] и по номерам, и по индексам
  // массива. Совпадение номера и индекса скрывает три возможные мутации:
  // (1) граница по ПЕРВОЙ дыре вместо ПОСЛЕДНЕЙ — не проверяемо одной
  //     дырой, нужно ≥2; (2) tailVerifiedByHash подменённый на
  //     "links[0].seq === 0" — не проверяемо цепочкой, начинающейся с 0;
  //     (3) доверенная ветка возвращает ИНДЕКС вместо seq — не проверяемо,
  //     когда префикс сам по себе не содержит дыр (индекс==seq внутри него).
  // Фикстуры ниже нарочно ломают все три совпадения одновременно.

  it('дословный тест ревью А: chainOf(7), показано [0,2,3,5,6], правдивый якорь → unverified [0,2,3]', () => {
    const full = chainOf(7); // seq 0..6
    const shown = [full[0], full[2], full[3], full[5], full[6]];
    // Две дыры (после seq0 и после seq3) — граница обязана взять ПОСЛЕДНЮЮ.
    // Префикс [full[0], full[2], full[3]] имеет seq [0,2,3], но индексы
    // внутри среза [0,1,2] — расхождение ловит мутацию на "индекс вместо seq".
    const result = verifyChain(shown, { expectedLastSeq: 6, expectedLastHash: linkHash(full[6]) });
    expect(result).toEqual({
      ok: false,
      reason: 'gap',
      missingAfterSeq: [0, 3],
      unverifiedContentAtSeq: [0, 2, 3],
    });
  });

  it('дословный тест ревью Б: chainOf(5), показано [2,3,4], правдивый якорь → gap [-1], unverified []', () => {
    // Цепочка НЕ начинается с seq=0 — links[0].seq === 0 ложно, но хвост
    // всё равно честно заякорен и подтверждён целиком: ловит мутацию
    // "tailVerifiedByHash = links[0].seq === 0" (она сказала бы false и
    // объявила бы весь показанный кусок непроверенным).
    const full = chainOf(5); // seq 0..4
    const shown = [full[2], full[3], full[4]];
    const result = verifyChain(shown, { expectedLastSeq: 4, expectedLastHash: linkHash(full[4]) });
    expect(result).toEqual({
      ok: false,
      reason: 'gap',
      missingAfterSeq: [-1],
      unverifiedContentAtSeq: [],
    });
  });

  it('своя фикстура: три дыры, не с нуля, правдивый якорь — граница и seq/индекс проверены одновременно', () => {
    const full = chainOf(9); // seq 0..8
    // Показаны seq 2,4,5,7,8 (индексы 0..4) — не с нуля, две дыры внутри
    // показанного (2->4 и 5->7), плюс дыра в начале (seq[0]=2 != 0).
    const shown = [full[2], full[4], full[5], full[7], full[8]];
    const result = verifyChain(shown, { expectedLastSeq: 8, expectedLastHash: linkHash(full[8]) });
    expect(result).toEqual({
      ok: false,
      reason: 'gap',
      // -1 (не с нуля), 2 (перед дырой к 4), 5 (перед дырой к 7)
      missingAfterSeq: [-1, 2, 5],
      // Последний сплошной кусок — [seq7, seq8] (индексы 3,4). Непроверено —
      // всё ДО него: seq [2,4,5], индексы [0,1,2]. Расхождение seq/индекс
      // внутри самого префикса (4≠1, 5≠2) ловит мутацию "индекс вместо seq"
      // даже без опоры на дословные тесты ревью.
      unverifiedContentAtSeq: [2, 4, 5],
    });
  });
});

describe('verifyChain — ревью, раунд 3, находка I2: expectedLastSeq обязателен', () => {
  // Отпечаток в одиночку не отличает обрезку от подделки — нужен номер,
  // чтобы сказать «сколько». verifyChain(полная.slice(0,3), {expectedLastHash:
  // linkHash(полная[4])}) раньше отдавал broken: честное умолчание (сторона
  // просто не показала хвост) превращалось в обвинение в подделке — разные
  // санкции по живому человеку, а разводить их и есть весь смысл функции.

  it('честная обрезка + якорь ТОЛЬКО по отпечатку раньше была broken — теперь expectedLastSeq обязателен, и это bad_anchor (вызывающий забыл номер)', () => {
    const full = chainOf(5);
    const shown = full.slice(0, 3); // честно показали только 0,1,2
    // Без expectedLastSeq вызов вообще не имеет права дойти до сравнения
    // отпечатков — типобезопасный вызов такого не построит (expectedLastSeq
    // обязателен в ChainAnchor), а на JS-границе это bad_anchor.
    const badOpts = { expectedLastHash: linkHash(full[4]) } as unknown as { expectedLastSeq: number; expectedLastHash?: `0x${string}` };
    expect(verifyChain(shown, badOpts)).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('честная обрезка + оба якоря (номер и отпечаток) — теперь корректно gap, минус в репутацию, не broken', () => {
    const full = chainOf(5);
    const shown = full.slice(0, 3);
    expect(verifyChain(shown, { expectedLastSeq: 4, expectedLastHash: linkHash(full[4]) })).toEqual({
      ok: false,
      reason: 'gap',
      missingAfterSeq: [2],
      unverifiedContentAtSeq: [0, 1, 2],
    });
  });

  it('пустой объект {} — bad_anchor, а не молчаливое «якоря нет» (fail-open находки 3 прошлого раунда)', () => {
    expect(verifyChain(chainOf(2), {} as unknown as { expectedLastSeq: number })).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('мелочь: verifyChain(null, 5) — форма якоря проверяется РАНЬШЕ формы links, не обвиняет предъявителя за мусор с обеих сторон', () => {
    // Раньше: {ok:false, reason:'broken', atSeq:-1} — обвиняло предъявителя
    // (Array.isArray(null) проверялась первой), хотя мусор пришёл и со
    // стороны опций тоже.
    expect(verifyChain(null as unknown as ChainLink[], 5 as unknown as { expectedLastSeq: number })).toEqual({ ok: false, reason: 'bad_anchor' });
  });
});

describe('verifyChain — ревью, раунд 5, находка C1: вердикт без якоря — нижняя граница, не замена', () => {
  // Прошлый JSDoc (раунд 4) советовал при bad_anchor "перезвать без опций
  // и разбирать уже тот вердикт" — плохой совет: это ровно тот fail-open,
  // который закрывали находкой 3 раунда 2 и находкой I2 раунда 3.
  // Вердикт без якоря — НИЖНЯЯ ГРАНИЦА: его ok:true значит «самопротиворечий
  // не найдено», а не «цепочка цела». До арбитра как справка о здоровье
  // доходить не должен НИКОГДА.

  it('честная пара: подделка + {} даёт bad_anchor, та же цепочка без якоря — честный broken', () => {
    // Здесь "перезвать без якоря" случайно совпадает с осмысленным
    // вердиктом — но это НЕ гарантия, см. следующий тест.
    //
    // РАУНД 6, мелочь: фикстура намеренно ОТЛИЧАЕТСЯ от "подделанное звено
    // видно как разрыв" (другой индекс — 3, не 2; другое поле — sender, не
    // bodyHash; другой итоговый atSeq — 4, не 3). Побайтовое совпадение с
    // существующей фикстурой раньше означало, что тест держит только
    // конъюнкцию с чужим прогоном, а не стоит на своих ногах — не краснел
    // поодиночке ни в одной из 30 мутаций раундов 1-5, только вместе с
    // фикстурой-близнецом.
    const full = chainOf(5);
    const forged = [...full];
    forged[3] = { ...forged[3], sender: BOB };
    expect(verifyChain(forged, {} as unknown as { expectedLastSeq: number })).toEqual({ ok: false, reason: 'bad_anchor' });
    expect(verifyChain(forged)).toEqual({ ok: false, reason: 'broken', atSeq: 4 });
  });

  it('КОНТРПРИМЕР (прибивает предел): каскадная подделка + негодный якорь тоже bad_anchor, но без якоря — ok:true', () => {
    // Это и есть довод против старого совета: "перезвать без якоря" здесь
    // дало бы ok:true на цепочке, где ПОДДЕЛАНО звено seq=1 — с честным
    // якорем (expectedLastHash) было бы broken. bad_anchor не заменяется
    // вердиктом без якоря — он остаётся строго слабее.
    //
    // РАУНД 6, мелочь: фикстура отличается от других каскадных тестов
    // файла (длина цепочки 6, не 5; тронут индекс 1, не 2; поле sender,
    // не bodyHash) — та же причина, что в предыдущем тесте.
    const full = chainOf(6); // seq 0..5
    const tamperedLink1 = { ...full[1], sender: BOB };
    const rebuiltLink2 = buildLink(tamperedLink1, BODY, ALICE, 2202);
    const rebuiltLink3 = buildLink(rebuiltLink2, BODY, ALICE, 2203);
    const rebuiltLink4 = buildLink(rebuiltLink3, BODY, ALICE, 2204);
    const rebuiltLink5 = buildLink(rebuiltLink4, BODY, ALICE, 2205);
    const cascaded = [full[0], tamperedLink1, rebuiltLink2, rebuiltLink3, rebuiltLink4, rebuiltLink5];
    expect(verifyChain(cascaded, {} as unknown as { expectedLastSeq: number })).toEqual({ ok: false, reason: 'bad_anchor' });
    expect(verifyChain(cascaded)).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1, 2, 3, 4, 5] });
  });
});

describe('verifyChain — ревью, раунд 5, находка I2: atSeq на broken — номер, не позиция в массиве', () => {
  // Мутация того же класса, что чинили раунды 1/2/4: atSeq: lastSeq ->
  // atSeq: links.length - 1 в ОБОИХ местах возврата broken, связанных с
  // якорем (переобъявление хвоста и несовпадение отпечатка), выживала бы
  // на всех прежних фикстурах — все они цепочки без дыр от нуля, где
  // lastSeq === links.length - 1 совпадает случайно. atSeq на broken —
  // указатель, по которому арбитр пойдёт искать подлог, под самой тяжёлой
  // санкцией: подать неверный номер здесь хуже, чем не подать никакого.

  it('несовпадение отпечатка: показано 3 звена не с нуля (seq 2,3,4) — atSeq обязан быть 4, не 2 (длина-1)', () => {
    const full = chainOf(5);
    const shown = [full[2], full[3], full[4]];
    const wrongHash = ('0x' + 'dd'.repeat(32)) as `0x${string}`;
    expect(verifyChain(shown, { expectedLastSeq: 4, expectedLastHash: wrongHash })).toEqual({
      ok: false,
      reason: 'broken',
      atSeq: 4,
    });
  });

  it('переобъявление хвоста: показано 2 звена не с нуля (seq 3,4), якорь занижен — atSeq обязан быть 4, не 1 (длина-1)', () => {
    const full = chainOf(5);
    const shown = [full[3], full[4]];
    expect(verifyChain(shown, { expectedLastSeq: 2 })).toEqual({
      ok: false,
      reason: 'broken',
      atSeq: 4,
    });
  });
});

describe('verifyChain — ревью, раунд 5, мелочь: собственные поля, не цепочка прототипов', () => {
  // opts.expectedLastSeq раньше читался обычным доступом к свойству, а он
  // проходит по цепочке прототипов — Object.create({expectedLastSeq: 3})
  // не имеет ни одного СОБСТВЕННОГО поля, но opts.expectedLastSeq всё
  // равно резолвится в 3 через прототип. Замок раунда 3 на {} обходился:
  // мусор снаружи (JSON.parse не создаёт такого, но конструктор объекта в
  // руках вызывающего может) выдавал себя за годный якорь.

  it('Object.create({expectedLastSeq: N}) — унаследованное поле не считается заданным, bad_anchor', () => {
    const full = chainOf(4);
    const evil = Object.create({ expectedLastSeq: 3 }) as { expectedLastSeq: number };
    expect(Object.keys(evil)).toEqual([]); // подтверждаем: собственных полей действительно нет
    expect(verifyChain(full, evil)).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('expectedLastSeq — собственное поле (валидно), expectedLastHash — только унаследованное: хеш игнорируется, не bad_anchor и не broken', () => {
    // Изолирует ИМЕННО expectedLastHash-проверку от expectedLastSeq-
    // проверки (та тоже даёт bad_anchor на {}, и без этой развязки любой
    // мусор в expectedLastHash был бы замаскирован первой проверкой,
    // сработавшей раньше). Здесь expectedLastSeq — настоящее собственное
    // поле, совпадающее с длиной цепочки; expectedLastHash — заведомо
    // НЕСОВПАДАЮЩИЙ хеш, доступный только через прототип.
    const full = chainOf(4); // seq 0..3, честная цепочка
    const wrongHash = ('0x' + '11'.repeat(32)) as `0x${string}`;
    const evil = Object.create({ expectedLastHash: wrongHash }) as { expectedLastSeq: number; expectedLastHash?: `0x${string}` };
    evil.expectedLastSeq = 3; // собственное поле, совпадает с реальным последним seq
    expect(Object.prototype.hasOwnProperty.call(evil, 'expectedLastHash')).toBe(false);
    // Если бы унаследованный expectedLastHash читался — несовпадение дало
    // бы broken. Он должен быть проигнорирован как «не задан»: остаётся
    // только валидный собственный expectedLastSeq, связность честная —
    // ok:true.
    expect(verifyChain(full, evil)).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1, 2, 3] });
  });
});

describe('verifyChain — ревью, раунд 6, находка I4: гейт формы адреса регистр не так, как отпечаток', () => {
  // linkHash регистро-НЕзависим для адреса: encodePacked нормализует
  // валидный (checksummed или полностью однорегистровый) адрес к одному и
  // тому же 20-байтному значению независимо от текстового регистра. Но
  // гейт формы использовал viem.isAddress(sender) БЕЗ {strict:false} —
  // тот принимает checksummed mixed-case и ПОЛНОСТЬЮ НИЖНИЙ регистр, но
  // отвергает ПОЛНОСТЬЮ ВЕРХНИЙ (легальное по EIP-55 представление
  // "не чек-сумлено") как невалидный. Честная цепочка получала broken
  // из-за текстового регистра одного поля — то же зеркало находки раунда 1
  // про sameHash, перенесённое с хеша на адрес.
  const CAROL = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const; // с буквами — регистр значим

  it('адрес отправителя в верхнем регистре (валидная форма) — цепочка не отвергается', () => {
    const link0 = buildLink(null, BODY, ALICE, 1000);
    const link1 = buildLink(link0, BODY, CAROL, 1001);
    const link2 = buildLink(link1, BODY, ALICE, 1002);
    // ('0x' + ...toUpperCase()), НЕ link1.sender.toUpperCase() целиком —
    // тот заодно превращает префикс "0x" в "0X", который isAddress не
    // распознаёт вообще, независимо от strict. Проверено эмпирически на
    // собственной ошибке при первом проходе.
    const upperCased = { ...link1, sender: ('0x' + link1.sender.slice(2).toUpperCase()) as `0x${string}` };
    const shown = [link0, upperCased, link2];
    expect(verifyChain(shown)).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1, 2] });
  });

  it('мусор вместо адреса (не просто другой регистр, а неверная форма) по-прежнему даёт broken', () => {
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], sender: ('0x' + 'ab'.repeat(19)) as `0x${string}` }; // на байт короче
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });
});

describe('verifyChain — ревью, раунд 6, находка I3: atSeq обязан быть пригодным указателем', () => {
  // reportedSeqFor возвращал seq как есть, если typeof seq === 'number' —
  // а NaN и Infinity/-Infinity тоже проходят typeof-проверку (они числа
  // по JS-типу), но JSON.stringify превращает ЛЮБОЙ из них в null.
  // Арбитр получил бы «подделка в звене null» вместо номера или позиции —
  // вердикт верный, указатель непригоден.

  it('seq = NaN — atSeq обязан быть индексом (числом), не NaN (который JSON превращает в null)', () => {
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], seq: NaN };
    const result = verifyChain(garbled);
    expect(result).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
    expect(JSON.stringify(result)).not.toContain('null');
  });

  it('seq = Infinity — тот же класс: atSeq обязан быть пригодным указателем', () => {
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], seq: Infinity };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });

  it('seq = -Infinity — тот же класс', () => {
    const full = chainOf(3);
    const garbled = [...full];
    garbled[1] = { ...garbled[1], seq: -Infinity };
    expect(verifyChain(garbled)).toEqual({ ok: false, reason: 'broken', atSeq: 1 });
  });
});
