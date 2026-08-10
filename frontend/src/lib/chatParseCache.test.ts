/**
 * chatParseCache.test.ts — К-2: разбирать заново только новое.
 *
 * ЗАМЕР ДО ПРАВКИ (задача 7, отчёт): разбор 1000 мешков — 503 мс, и он идёт
 * ЦЕЛИКОМ на КАЖДОМ тике опроса, то есть каждые пять секунд, пока чат открыт.
 * Вместе с рендером это 605 мс на тик — 12 % ядра на десктопе и 48–60 % на
 * среднем телефоне, в основном потоке, с видимым подтормаживанием прокрутки.
 *
 * Разбирать всю переписку заново незачем: мешок неизменяем (ключ содержит
 * uuid, тело под ним не меняется никогда), а дорогое в нём — проверка подписи
 * и расшифровка конверта. И то, и другое зависит только от байтов мешка и от
 * нашей пары ключей.
 *
 * ⚠️ ЧТО ЗАПИРАЕТСЯ ЗДЕСЬ, КРОМЕ СКОРОСТИ. Кэш обязан давать ТОТ ЖЕ ответ.
 * Ускорение, которое меняет вердикт цепочки, — это не ускорение, а тихая
 * потеря проверки; поэтому первым замком идёт побайтовое совпадение
 * результата, и только вторым — время.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveChatKeypair } from './chatCrypto';
import {
  sendMessage, receiveBags, forgetConversationHead, decodeFrame, encodeFrame,
  deriveLinkSigningKeypair, messageBodyHash, linkSignaturePreimage, _resetParseCacheForTest,
  type SentMessage, type IncomingBag,
} from './chatConversation';
import { packEnvelope } from './chatEnvelope';
import { BoundedParseCache, PARSE_CACHE_MAX } from './chatParseCache';
import { buildLink } from './chatChain';
import type { ChatSession } from './chatSession';
import type { ChainLink } from './chatChain';

const ALICE = '0xA1cE00000000000000000000000000000000CAfE' as const;
const BOB = '0xB0b1000000000000000000000000000000005eEd' as const;

function signatureOf(marker: string): `0x${string}` {
  const body = marker.repeat(130).slice(0, 130).replace(/[^0-9a-f]/g, 'a');
  return `0x${body}` as `0x${string}`;
}

async function makeSession(address: `0x${string}`, marker: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(signatureOf(marker)),
    address, origin: 'signature', walletKind: 'eoa', restored: true, persisted: true,
  };
}

/** Склад-заглушка: принимает мешок и выдаёт ключ. Сеть здесь не при чём —
 *  меряется РАЗБОР, а не доставка. */
function installPutStub(): void {
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://x').pathname;
    if (init?.method === 'PUT') {
      n++;
      return new Response(JSON.stringify({ key: `${ALICE.toLowerCase()}/${1000 + n}-k.bin` }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
}

function bagOf(sent: SentMessage, from: `0x${string}`, at: number): IncomingBag {
  return { key: sent.key, sender: from.toLowerCase() as `0x${string}`, uploadedAt: at, body: sent.frame };
}

async function conversation(n: number): Promise<{ alice: ChatSession; bags: IncomingBag[] }> {
  const alice = await makeSession(ALICE, '1c3d');
  const bob = await makeSession(BOB, '7f2e');
  await forgetConversationHead(BOB, ALICE);
  const bags: IncomingBag[] = [];
  let prev: ChainLink | null = null;
  for (let i = 0; i < n; i++) {
    const sent = await sendMessage(
      bob, ALICE, alice.keypair.publicKey, { text: `сообщение ${i}` }, prev, { pass: 'v1.p' },
    );
    bags.push(bagOf(sent, BOB, 1_000 + i));
    prev = sent.link;
  }
  return { alice, bags };
}

/**
 * Быстрая заготовка переписки: кадр собирается напрямую, минуя `sendMessage`.
 *
 * ⚠️ Зачем отдельно от `conversation()` выше. Замеру К-3 нужны ТЫСЯЧИ мешков, а
 * `sendMessage` на каждый берёт межвкладочный замок, пишет голову и ходит на
 * склад-заглушку — на пяти тысячах это минуты чистой обвязки, к разбору
 * отношения не имеющей. Кадр здесь собирается ровно тот же (это проверяется
 * тем, что `receiveBags` его принимает и отдаёт все сообщения).
 */
async function fastConversation(n: number): Promise<{ alice: ChatSession; bags: IncomingBag[] }> {
  const alice = await makeSession(ALICE, '1c3d');
  const bob = await makeSession(BOB, '7f2e');
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(bob.keypair);
  const bags: IncomingBag[] = [];
  let prev: ChainLink | null = null;
  const lc = BOB.toLowerCase() as `0x${string}`;
  for (let i = 0; i < n; i++) {
    const env = await packEnvelope({ text: `сообщение ${i}` }, alice.keypair.publicKey, bob.keypair.publicKey, lc);
    const link = buildLink(prev, messageBodyHash(signer.publicKey, env), lc, 1_700_000_000_000 + i);
    const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
    bags.push({
      key: `${ALICE.toLowerCase()}/${1_700_000_000_000 + i}-f.bin`,
      sender: lc, uploadedAt: 1_700_000_000_000 + i,
      body: encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope: env }),
    });
    prev = link;
  }
  return { alice, bags };
}

/**
 * Холодный и повторный разбор одного набора: время И ЧИСЛО ПРОВЕРОК ПОДПИСИ.
 *
 * ⚠️ ЧИСЛО, А НЕ ТОЛЬКО ВРЕМЯ, и это не педантизм. Время повторного разбора
 * отличается от холодного на столько, какую долю разбора занимает кэшируемое,
 * — на больших наборах это десять процентов, а разброс замера бывает четыре.
 * Порог по времени в этой зоне ничего не сторожит (первая версия замка на
 * 20 000 проходила зелёной на СЛОМАННОМ кэше). Число проверок подписи —
 * величина точная: сколько мешков кэш не узнал, столько раз и позвали
 * libsodium.
 */
async function timeParse(
  alice: ChatSession, bags: IncomingBag[],
): Promise<{ cold: number; warm: number; coldVerifies: number; warmVerifies: number }> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  _resetParseCacheForTest();
  const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');

  const t0 = Date.now();
  await receiveBags(alice, bags, { peer: BOB });
  const cold = Date.now() - t0;
  const coldVerifies = spy.mock.calls.length;

  spy.mockClear();
  const t1 = Date.now();
  await receiveBags(alice, bags, { peer: BOB });
  const warm = Date.now() - t1;
  const warmVerifies = spy.mock.calls.length;

  spy.mockRestore();
  return { cold, warm, coldVerifies, warmVerifies };
}

beforeEach(() => { installPutStub(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('К-2: повторный разбор того же набора', () => {
  it('ЗАМЕР: второй разбор того же набора дешевле первого в РАЗЫ', async () => {
    const { alice, bags } = await conversation(300);

    const t1 = Date.now();
    const first = await receiveBags(alice, bags, { peer: BOB });
    const firstMs = Date.now() - t1;

    const t2 = Date.now();
    const second = await receiveBags(alice, bags, { peer: BOB });
    const secondMs = Date.now() - t2;

    console.info(`[замер К-2] 300 мешков: первый разбор ${firstMs} мс, повторный ${secondMs} мс`);

    // ГЛАВНОЕ — ответ ТОТ ЖЕ. Ускорение, меняющее вердикт, это потеря проверки.
    expect(second.messages).toEqual(first.messages);
    expect(second.gaps).toEqual(first.gaps);
    expect(second.gapAfterSeq).toEqual(first.gapAfterSeq);
    expect(second.chains).toEqual(first.chains);
    expect(second.troubles).toEqual(first.troubles);

    // И только потом — скорость. Порог щедрый: замок ловит «кэша нет вовсе»,
    // а не микросекунды на медленной машине.
    //
    // ⚠️ ЧЕСТНО О ГРАНИЦЕ ЭТОГО ЗАМКА. Кэша два — подписи и расшифровки, — и
    // порог ×3 держится на ЛЮБОМ ОДНОМ из них: мутация «убрать кэш подписи»
    // проходит зелёной (4 из 4), потому что расшифровка одна даёт достаточно.
    // Ужесточать порог — значит начать мигать на медленной машине, а это
    // хуже. Поэтому КАЖДЫЙ кэш заперт отдельно по СМЫСЛУ, а не по времени:
    // подписи — тестом с подделанной подписью под тем же ключом,
    // расшифровки — тестом с чужим сеансом. Обе мутации краснеют.
    expect(secondMs * 3).toBeLessThan(firstMs);
  }, 300_000);

  it('ЗАМЕР: один новый мешок к 300 старым стоит как один, а не как 301', async () => {
    // Ровно тот случай, что происходит каждые пять секунд при открытом чате.
    const { alice, bags } = await conversation(301);
    const head = bags.slice(0, 300);

    const t1 = Date.now();
    await receiveBags(alice, head, { peer: BOB });
    const fullMs = Date.now() - t1;

    const t2 = Date.now();
    const grown = await receiveBags(alice, bags, { peer: BOB });
    const incrementalMs = Date.now() - t2;

    console.info(`[замер К-2] 300 → 301: полный разбор ${fullMs} мс, прирост ${incrementalMs} мс`);
    expect(grown.messages).toHaveLength(301);
    expect(grown.gapAfterSeq).toEqual([]);
    expect(incrementalMs * 3).toBeLessThan(fullMs);
  }, 300_000);

  it('подделанный мешок с ТЕМ ЖЕ ключом не проходит по кэшу предыдущего', async () => {
    // Дыра, которую кэш по ключу мешка открыл бы, если бы не смотрел на тело:
    // сервер отдаёт под тем же ключом ДРУГИЕ байты, а мы верим прошлому
    // разбору. Ключ мешка выдаёт сервер — доверять ему как отпечатку нельзя.
    //
    // ⚠️ ПОДДЕЛКА ЦЕЛИТ ИМЕННО В ПОДПИСЬ, и это не педантизм. Первая версия
    // этого теста портила последний байт тела — и краснела на проверке
    // ОТПЕЧАТКА ТЕЛА, которая идёт раньше подписи и не кэшируется вовсе.
    // Мутация «кэшировать по ключу, не глядя на тело» проходила зелёной: 4 из
    // 4. Здесь испорчена ТОЛЬКО подпись, а отпечаток тела и свидетельство
    // отправителя оставлены верными — поймать это может ровно та проверка,
    // результат которой кэшируется.
    const { alice, bags } = await conversation(3);
    const clean = await receiveBags(alice, bags, { peer: BOB });
    expect(clean.messages).toHaveLength(3);
    expect(clean.troubles).toEqual([]);

    const victim = bags[1];
    const frame = decodeFrame(victim.body)!;
    const badSignature = new Uint8Array(frame.signature);
    badSignature[0] ^= 0xff;
    const forged: IncomingBag = {
      ...victim,                                  // ТОТ ЖЕ ключ мешка
      body: encodeFrame({ ...frame, signature: badSignature }),
    };
    const tampered = bags.map((b, i) => (i === 1 ? forged : b));

    const after = await receiveBags(alice, tampered, { peer: BOB });
    expect(after.troubles.map(t => t.kind)).toContain('bad_signature');
    expect(after.messages.map(m => m.seq)).not.toContain(1);
  }, 300_000);

  it('чужой сеанс не читает расшифрованное из кэша нашего', async () => {
    // Расшифровка зависит от НАШЕЙ пары ключей. Кэш, не учитывающий её,
    // отдал бы содержимое сеансу, который вскрыть его не может.
    const { alice, bags } = await conversation(3);
    await receiveBags(alice, bags, { peer: BOB });

    const stranger = await makeSession(ALICE, 'beef');
    const seen = await receiveBags(stranger, bags, { peer: BOB });
    expect(seen.messages).toHaveLength(0);
    expect(seen.troubles.every(t => t.kind === 'undecryptable')).toBe(true);
  }, 300_000);
});

/* ─────────── К-5: своя цепочка не с нуля — это не обвинение ─────────── */

describe('К-5: своя половина после истечения старых мешков', () => {
  it('своя цепочка начинается НЕ С НУЛЯ — разрыв назван, но НЕ в плоском списке', async () => {
    // Мешки живут семь дней. Через неделю уцелевшее начнётся не с нуля, и
    // цепочка честно скажет «начало не предъявлено» — но НА НАШЕМ адресе.
    // Плоский `gapAfterSeq` читается панелью как «собеседник что-то скрыл» и
    // рисуется значком разрыва; своя истёкшая история туда попасть не должна.
    const { alice, bags } = await conversation(5);
    const tail = bags.slice(2);                     // «первые два истекли»

    const own = await makeSession(BOB, '7f2e');     // читаем СВОЮ половину
    const state = await receiveBags(own, tail, { peer: ALICE });

    expect(state.messages.map(m => m.seq)).toEqual([2, 3, 4]);
    // Разрыв ЕСТЬ и назван автором — это мы сами.
    expect(state.gaps).toEqual([{ from: BOB.toLowerCase(), afterSeq: -1 }]);
    // …и в плоском списке его НЕТ: обвинять некого и не в чем.
    expect(state.gapAfterSeq).toEqual([]);
  }, 300_000);

  it('сбитая своя нумерация — своя претензия, а не «подделка собеседника»', async () => {
    // Вкладка потеряла голову разговора и начала счёт заново: два своих
    // звена с одним номером. Это НАША беда (очистили хранилище), и читаться
    // она обязана не как «предъявленному верить нельзя».
    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    await forgetConversationHead(BOB, ALICE);
    const one = await sendMessage(bob, ALICE, alice.keypair.publicKey, { text: 'раз' }, null, { pass: 'v1.p' });
    await forgetConversationHead(BOB, ALICE);        // голова потеряна
    const two = await sendMessage(bob, ALICE, alice.keypair.publicKey, { text: 'два' }, null, { pass: 'v1.p' });
    expect(two.link.seq).toBe(one.link.seq);         // номер повторился

    const own = await makeSession(BOB, '7f2e');
    const state = await receiveBags(own, [bagOf(one, BOB, 1), bagOf(two, BOB, 2)], { peer: ALICE });

    const kinds = state.troubles.map(t => t.kind);
    expect(kinds).toContain('own_numbering_reset');
    expect(kinds).not.toContain('duplicate_seq');
  }, 300_000);
});

/* ───────────── К-3: обрыв кэша разбора ровно на потолке ───────────── */

/**
 * ⚠️ ЭТО РОВНО ТОТ СЛУЧАЙ, О КОТОРОМ ПРЕДУПРЕЖДАЕТ ПРАВИЛО «СВОЯ ПОЧИНКА ХУЖЕ
 * ДЕФЕКТА». Кэш заведён ради ускорения; за своим потолком он ускорение ТЕРЯЕТ
 * ЦЕЛИКОМ и вдобавок берёт плату — то есть механизм превращается в тормоз хуже
 * исходного, и ровно в тот момент, когда переписка стала длинной.
 *
 * Причина — вытеснение САМОГО СТАРОГО при ЦИКЛИЧЕСКОМ обходе. Разбор идёт по
 * всему накопленному набору, в одном и том же порядке, каждый тик. При наборе
 * чуть больше потолка первый же мешок вытесняет тот, который понадобится
 * следующим, и так по кругу: доля попаданий не «немного падает», а становится
 * РОВНО НУЛЬ. Классическое вырождение FIFO/LRU на кольцевом проходе.
 *
 * ЗАМЕР ДО ПРАВКИ (эта машина, боевой потолок 5000):
 *   4999: холодный 2511 мс, повторный  255 мс  (в 9,8 раза дешевле)
 *   5000: холодный 2461 мс, повторный  244 мс  (в 10 раз дешевле)
 *   5001: холодный 2438 мс, повторный 2456 мс  (ДОРОЖЕ холодного)
 *  20000: холодный 9541 мс, повторный 9709 мс  (ДОРОЖЕ холодного)
 */
describe('К-3: потолок кэша разбора', () => {
  it('ЗАМЕР: 5001 мешок разбирается повторно не дороже, чем 5000', async () => {
    // Боевой потолок, без подстановки своих чисел: 5000 — это то, что стоит в
    // модуле, и мерять надо ровно вокруг него.
    //
    // Что красит: возврат вытеснения «самого старого». Тогда повторный разбор
    // 5001 мешка требует 5001 проверки подписи вместо одной, и стоит столько
    // же, сколько холодный, — в десять раз дороже, чем повторный разбор 5000.
    const { alice, bags } = await fastConversation(5001);

    const atCap = await timeParse(alice, bags.slice(0, 5000));
    const overCap = await timeParse(alice, bags);

    console.info(
      `[замер К-3] 5000: холодный ${atCap.cold} мс / ${atCap.coldVerifies} проверок подписи, ` +
      `повторный ${atCap.warm} мс / ${atCap.warmVerifies}; ` +
      `5001: холодный ${overCap.cold} мс / ${overCap.coldVerifies}, ` +
      `повторный ${overCap.warm} мс / ${overCap.warmVerifies}`,
    );

    // 1. ТОЧНОЕ ЧИСЛО. Один лишний мешок сверх потолка обязан стоить повторно
    //    ОДНОЙ непопавшей проверки, а не пяти тысяч. Порог с большим запасом —
    //    он ловит обрыв, а не единицы.
    expect(atCap.warmVerifies).toBe(0);
    expect(overCap.warmVerifies).toBeLessThan(50);
    // 2. И время: повторный разбор за потолком остаётся кратно дешевле
    //    холодного. Порог щедрый — замок ловит «кэша не стало вовсе».
    expect(overCap.warm * 2).toBeLessThan(overCap.cold);
  }, 300_000);

  it('ЗАМЕР: 20 000 мешков при потолке 5000 — попаданий примерно четверть, а не ноль', async () => {
    // Вопрос «что если этого станет очень много», ответ числом. Кэш вчетверо
    // меньше набора; доля попаданий обязана падать ПЛАВНО (примерно как
    // потолок/набор), а не обрываться в ноль.
    //
    // ⚠️ ЗАМОК — ПО ЧИСЛУ ПРОВЕРОК, А НЕ ПО ВРЕМЕНИ, и это исправление
    // собственной ошибки. Первая версия писала «повторный дешевле холодного» и
    // проходила ЗЕЛЁНОЙ на СЛОМАННОМ кэше: 9798 мс против 10173, разница 4 % —
    // чистый шум замера. Кэшируемое (подпись и расшифровка) занимает лишь часть
    // разбора, поэтому четверть попаданий даёт около десяти процентов времени —
    // то есть по времени этот случай в принципе неотличим от шума на этой
    // машине. Число вызовов libsodium от машины не зависит вовсе.
    //
    // Что красит: возврат вытеснения «самого старого» — повторный разбор
    // требует ВСЕ 20 000 проверок, попаданий ноль.
    const { alice, bags } = await fastConversation(20_000);
    const { cold, warm, coldVerifies, warmVerifies } = await timeParse(alice, bags);
    const hitRate = 1 - warmVerifies / coldVerifies;
    console.info(
      `[замер К-3] 20000: холодный ${cold} мс / ${coldVerifies} проверок подписи, ` +
      `повторный ${warm} мс / ${warmVerifies} — попаданий ${(hitRate * 100).toFixed(1)} %, ` +
      `экономия времени ${((1 - warm / cold) * 100).toFixed(0)} %`,
    );
    expect(coldVerifies).toBe(20_000);
    // Ожидается около потолок/набор = 25 %. Порог 20 % — с запасом ниже
    // ожидаемого и заведомо выше нуля, в который вырождалось прежнее правило.
    expect(hitRate).toBeGreaterThan(0.2);
  }, 900_000);
});

/* ─────────── К-3: сам механизм вытеснения, без пяти тысяч мешков ────────── */

describe('BoundedParseCache: правило вытеснения', () => {
  /** Доля попаданий при кольцевом обходе набора `set` кэшем на `cap` записей,
   *  за `rounds` проходов. Ровно то, что делает `receiveBags` каждый тик. */
  function hitRateOnCycle(cap: number, set: number, rounds: number): number {
    const cache = new BoundedParseCache<number>(cap);
    let hits = 0;
    let looks = 0;
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < set; i++) {
        const key = `k${i}`;
        looks++;
        if (cache.get(key) !== undefined) hits++;
        else cache.put(key, i);
      }
    }
    // Первый проход весь холодный по определению — он в долю не входит.
    return hits / (looks - set);
  }

  it('ЗАМЕР: доля попаданий падает ПЛАВНО, а не обрывом на потолке', () => {
    // Что красит: возврат вытеснения «самого старого» (`cache.keys().next()`).
    // Тогда 5001 даёт РОВНО ноль вместо почти единицы.
    const rows = [4999, 5000, 5001, 20_000].map(set => ({
      set, rate: hitRateOnCycle(PARSE_CACHE_MAX, set, 6),
    }));
    console.info(
      '[замер К-3, механизм] потолок 5000 → ' +
      rows.map(r => `${r.set}: ${(r.rate * 100).toFixed(1)} %`).join('; '),
    );

    expect(rows[0].rate).toBe(1);          // 4999 — всё помещается
    expect(rows[1].rate).toBe(1);          // 5000 — ровно потолок
    expect(rows[2].rate).toBeGreaterThan(0.99);  // 5001 — обрыва НЕТ
    // 20 000: верхний предел — потолок/набор = 25 %. Порог 18 % с запасом.
    expect(rows[3].rate).toBeGreaterThan(0.18);
  });

  it('потолок 5000 записан руками и совпадает с модулем', () => {
    // Правило проекта: величина, взятая из проверяемого модуля, доказывает
    // только «какая-то есть». Здесь она сверена с написанным числом.
    expect(PARSE_CACHE_MAX).toBe(5_000);
  });

  it('НЕПРИНЯТАЯ запись всё равно возвращает значение', () => {
    // ⚠️ Самая дорогая ловушка «приёма не всегда», и она не про скорость.
    // Вызывающий читает результат сразу: `_payloadCache.put(...).payload`.
    // Верни `put` что-нибудь другое, когда запись не принята, — и содержимое
    // стало бы `undefined`, то есть КАЖДЫЙ мешок сверх потолка получил бы
    // беду «не вскрылось». Обвинение за переполненный кэш.
    // (Кэш вердикта кадра эту опору снял: `receiveBags` берёт вердикт из
    // локальной переменной, а `put` зовёт только ради записи.)
    const cache = new BoundedParseCache<{ ok: boolean }>(2);
    cache.put('a', { ok: true });
    cache.put('b', { ok: true });
    let admitted = 0;
    for (let i = 0; i < 200; i++) {
      const back = cache.put(`n${i}`, { ok: true });
      expect(back.ok).toBe(true);          // значение вернулось в любом случае
      if (cache.get(`n${i}`) !== undefined) admitted++;
    }
    expect(cache.size).toBe(2);            // потолок держится
    expect(admitted).toBeGreaterThan(0);   // и приём не выродился в «никогда»
    expect(admitted).toBeLessThan(200);    // и не в «всегда»
  });

  it('потолок меньше единицы — отказ, а не тихий кэш из воздуха', () => {
    expect(() => new BoundedParseCache(0)).toThrow(TypeError);
    expect(() => new BoundedParseCache(-1)).toThrow(TypeError);
    expect(() => new BoundedParseCache(1.5)).toThrow(TypeError);
  });
});
