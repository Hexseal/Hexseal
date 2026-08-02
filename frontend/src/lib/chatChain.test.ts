import { describe, it, expect } from 'vitest';
import { buildLink, linkHash, verifyChain, GENESIS_HASH, type ChainLink } from './chatChain';

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
    expect(verifyChain({} as unknown as ChainLink[])).toEqual({ ok: false, reason: 'broken', atSeq: -1 });
    expect(verifyChain(null as unknown as ChainLink[])).toEqual({ ok: false, reason: 'broken', atSeq: -1 });
  });

  it('мусор внутри валидного массива (null/undefined элементы) даёт broken, а не исключение', () => {
    expect(verifyChain([null as unknown as ChainLink])).toEqual({ ok: false, reason: 'broken', atSeq: 0 });
    const full = chainOf(2);
    expect(verifyChain([undefined as unknown as ChainLink, full[1]])).toEqual({ ok: false, reason: 'broken', atSeq: 0 });
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

  it('мусорный expectedLastSeq (дробный) не роняет проверку', () => {
    // РАУНД 2, находка 3: было {broken, atSeq:1.5} — вина уходила на
    // предъявителя честной цепочки за чужую ошибку в якоре. Теперь
    // отдельный вердикт bad_anchor, см. describe ниже.
    expect(verifyChain(chainOf(2), { expectedLastSeq: 1.5 })).toEqual({ ok: false, reason: 'bad_anchor' });
  });

  it('мусорный expectedLastSeq (отрицательный) не роняет проверку', () => {
    expect(verifyChain(chainOf(2), { expectedLastSeq: -1 })).toEqual({ ok: false, reason: 'bad_anchor' });
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
    const result = verifyChain(chainOf(2), { expectedLastSeq: -1 });
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
