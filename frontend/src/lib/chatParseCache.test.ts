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
  type SentMessage, type IncomingBag,
} from './chatConversation';
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
