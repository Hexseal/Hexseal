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
  it('целая цепочка проходит', () => {
    expect(verifyChain(chainOf(5))).toEqual({ ok: true });
  });

  it('пустая цепочка проходит — предъявлять нечего, но и врать не в чем', () => {
    expect(verifyChain([])).toEqual({ ok: true });
  });

  it('вырезанное сообщение видно как пропуск с номером', () => {
    const full = chainOf(5);
    const shown = [full[0], full[1], full[3], full[4]]; // убрали seq=2
    expect(verifyChain(shown)).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [1] });
  });

  it('несколько дыр перечисляются все', () => {
    const full = chainOf(7);
    const shown = [full[0], full[2], full[4], full[6]];
    expect(verifyChain(shown)).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [0, 2, 4] });
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
    expect(verifyChain([full[2], full[3]])).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [-1] });
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
    expect(verifyChain([relabelled])).toEqual({ ok: true });
  });

  it('prevHash соседнего звена в верхнем регистре — та же цепочка, не разрыв', () => {
    const full = chainOf(2);
    const relabelled = { ...full[1], prevHash: upperHex(full[1].prevHash) };
    expect(verifyChain([full[0], relabelled])).toEqual({ ok: true });
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
    expect(verifyChain(shown)).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [1] });
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
    expect(verifyChain(shown)).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [0] });
  });

  it('честный предел: полностью выдуманная цепочка с seq не с нуля остаётся gap', () => {
    const fake1 = { seq: 1, prevHash: ('0x' + 'cc'.repeat(32)) as `0x${string}`, bodyHash: BODY, sender: ALICE, sentAt: 3001 };
    const fake2 = buildLink(fake1, BODY, ALICE, 3002);
    const fake3 = buildLink(fake2, BODY, ALICE, 3003);
    const fake4 = buildLink(fake3, BODY, ALICE, 3004);
    expect(verifyChain([fake1, fake2, fake3, fake4])).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [-1] });
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

  it('якорь задан и совпадает — tailAnchored: true', () => {
    const full = chainOf(3); // seq 0,1,2
    expect(verifyChain(full, { expectedLastSeq: 2 })).toEqual({ ok: true, tailAnchored: true });
  });

  it('без якоря tailAnchored отсутствует в вердикте вообще (не false, а нет ключа)', () => {
    const result = verifyChain(chainOf(3));
    expect(result).toEqual({ ok: true });
    expect('tailAnchored' in result).toBe(false);
  });

  it('хвост утаён (якорь больше последнего показанного) — gap, недостающий номер в missingAfterSeq', () => {
    const full = chainOf(5); // seq 0..4, реальный последний — 4
    const shown = full.slice(0, 3); // показали только 0,1,2
    expect(verifyChain(shown, { expectedLastSeq: 4 })).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [2] });
  });

  it('предъявлено больше, чем существует, — broken, а не gap', () => {
    const full = chainOf(5); // seq 0..4
    expect(verifyChain(full, { expectedLastSeq: 2 })).toEqual({ ok: false, reason: 'broken', atSeq: 4 });
  });

  it('пустой массив с заданным якорем — вся переписка утаена, это gap, а не ok:true', () => {
    expect(verifyChain([], { expectedLastSeq: 0 })).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [-1] });
  });

  it('пустой массив без якоря остаётся ok:true — брифовый тест не переопределён', () => {
    expect(verifyChain([])).toEqual({ ok: true });
  });

  it('мусорный expectedLastSeq (дробный) не роняет проверку', () => {
    expect(verifyChain(chainOf(2), { expectedLastSeq: 1.5 })).toEqual({ ok: false, reason: 'broken', atSeq: 1.5 });
  });

  it('мусорный expectedLastSeq (отрицательный) не роняет проверку', () => {
    expect(verifyChain(chainOf(2), { expectedLastSeq: -1 })).toEqual({ ok: false, reason: 'broken', atSeq: -1 });
  });

  it('внутренняя дыра и утаённый хвост — обе позиции в missingAfterSeq', () => {
    const full = chainOf(5); // seq 0..4
    const shown = [full[0], full[1], full[3]]; // нет seq=2, и хвост (seq=4) тоже не показан
    expect(verifyChain(shown, { expectedLastSeq: 4 })).toEqual({ ok: false, reason: 'gap', missingAfterSeq: [1, 3] });
  });

  it('якорь совпадает численно, но связность подделана В СЕРЕДИНЕ — broken побеждает', () => {
    const full = chainOf(4); // seq 0,1,2,3
    const tampered = [...full];
    tampered[2] = { ...tampered[2], bodyHash: ('0x' + 'bb'.repeat(32)) as `0x${string}` };
    // seq=3 честный: его prevHash по-прежнему указывает на ПОДЛИННЫЙ хеш
    // seq=2, а не на пересчитанный с подделкой — расхождение поймает пара (2,3).
    expect(verifyChain(tampered, { expectedLastSeq: 3 })).toEqual({ ok: false, reason: 'broken', atSeq: 3 });
  });

  it('ГРАНИЦА ЗАЩИТЫ: якорь по количеству совпал, но контент ПОСЛЕДНЕГО звена подделан — это ok:true', () => {
    // expectedLastSeq — якорь по НОМЕРУ (сколько сообщений всего), а не по
    // контенту последнего звена. prevHash звена ссылается на ПРЕДЫДУЩЕЕ, не
    // на себя: у последнего звена в массиве нет следующего, которое могло
    // бы проверить его собственный отпечаток. Подмена bodyHash/sender
    // именно у ПОСЛЕДНЕГО звена, при сохранении верного seq и prevHash,
    // невидима даже при точно совпавшем якоре по количеству — это не баг
    // этой правки, а её честно объявленная граница (полная защита
    // содержимого последнего звена требует подписи отправителя из плана 3
    // или якоря по хешу, а не только по номеру — ни то, ни другое не было
    // частью контракта, заданного в этом раунде ревью).
    const full = chainOf(3); // seq 0,1,2
    const tampered = [...full];
    tampered[2] = { ...tampered[2], bodyHash: ('0x' + 'bb'.repeat(32)) as `0x${string}` };
    expect(verifyChain(tampered, { expectedLastSeq: 2 })).toEqual({ ok: true, tailAnchored: true });
  });
});
