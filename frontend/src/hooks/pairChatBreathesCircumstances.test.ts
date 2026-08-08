/**
 * pairChatBreathesCircumstances.test.ts — пять вопросов про обстоятельства,
 * ответ числом.
 *
 * Правило проекта (`docs/PROCESS.md`, введено владельцем 4 августа): про логику
 * думают всегда, потому что она в задаче написана; про обстоятельства не думает
 * никто, потому что их в задаче нет. Поэтому каждый ответ здесь — замер, а не
 * рассуждение:
 *
 *  1. перезапустили посреди — закрыл вкладку, пока висело окно подписи;
 *  2. склад/справочник отказал — человек отличает «не отправилось» от
 *     «не подключилось»?
 *  3. два процесса разом — две вкладки, обе просят пропуск: сколько окон?
 *  4. пришёл мусор — справочник отдал не тот ключ, битый ключ, пустой ответ;
 *  5. долбят нарочно — можно ли заставить человека переподписывать без конца?
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import type { ChatSession } from '@/lib/chatSession';
import { deriveLinkSigningKeypair, _resetConversationMemoryForTest } from '@/lib/chatConversation';
import { requestBagPass, _resetBagPassCacheForTest } from '@/lib/chatTransport';
import { startPairChat, type PairChatState, type PairChatEngine } from './usePairChat';

const ALICE = '0xa1ce00000000000000000000000000000000cafe' as const;
const BOB = '0xb0b1000000000000000000000000000000005eed' as const;

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}

async function makeSession(address: `0x${string}`, seed: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig(seed)),
    address, origin: 'signature', walletKind: 'eoa', restored: false, persisted: true,
  };
}

function hexOf(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FAST = { activeMs: 20, backgroundMs: 20, maxBackoffMs: 100 };

let alice: ChatSession;
let bobBoxKey: Uint8Array;
let bobSignKey: Uint8Array;
let engine: PairChatEngine | null = null;

beforeEach(async () => {
  _resetConversationMemoryForTest();
  _resetBagPassCacheForTest();
  alice = await makeSession(ALICE, 'a');
  const bob = await makeSession(BOB, 'b');
  bobBoxKey = bob.keypair.publicKey;
  bobSignKey = (await deriveLinkSigningKeypair(bob.keypair)).publicKey;
});

afterEach(() => {
  engine?.stop();
  engine = null;
  vi.unstubAllGlobals();
});

/* ───────── 1. перезапустили посреди: окно подписи висело и умерло ───────── */

describe('1. закрыл вкладку, пока висело окно подписи', () => {
  it('оборванный запрос пропуска НЕ запирает следующий', async () => {
    // Замер: если оборванный промис останется в дедупе, ВСЕ следующие попытки
    // этого адреса навсегда прилипнут к уже провалившейся — человек вернулся, а
    // чат для него мёртв до перезагрузки страницы.
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed'); // вкладку закрыли
      return new Response(
        JSON.stringify({ pass: 'v1.p.mac', expiresAt: Math.floor(Date.now() / 1000) + 43_200 }),
        { status: 200 },
      );
    }));

    await expect(requestBagPass(async () => sig('b'), ALICE)).rejects.toThrow();
    const second = await requestBagPass(async () => sig('b'), ALICE);
    expect(second.pass).toBe('v1.p.mac');
    expect(attempts).toBe(2);
  });

  it('вернувшись, человек подписывает РОВНО ОДИН раз, а не по кругу', async () => {
    // ⚠️ ЭТОТ ЗАМЕР ПЕРЕПИСАН ПОСЛЕ ОТКАТА, и число в нём изменилось честно.
    // Пока пропуск подписывался ключом переписки, ответ был «ноль окон». Дорога
    // откачена решением владельца (разбор — в шапке `POST /bags/pass`), значит
    // окно кошелька вернулось, и вопрос «что при возврате» получает другой
    // ответ: одно окно, и ТОЛЬКО одно.
    //
    // Оборванная подпись не оставляет ничего, что могло бы уцелеть, — значит
    // при возврате спросят снова. Важно другое: спросят ОДИН раз, а дальше
    // пропуск живёт 12 часов и подписи не просит. Замер именно на это: три
    // обращения за пропуском подряд — одно окно.
    let wallet = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ pass: 'v1.w.mac', expiresAt: Math.floor(Date.now() / 1000) + 43_200 }),
      { status: 200 },
    )));
    const signer = async () => { wallet++; return sig('b'); };
    await requestBagPass(signer, ALICE);
    await requestBagPass(signer, ALICE);
    await requestBagPass(signer, ALICE);
    expect(wallet).toBe(1);
  });
});

/* ───────── 2. «не отправилось» против «не подключилось» ───────── */

describe('2. склад/справочник отказал — две РАЗНЫЕ новости', () => {
  it('справочник лёг на отправке — код directory_failed, а не «он не заходил»', async () => {
    // ⚠️ Ровно вопрос «что мы обещаем, чего не делаем». Раньше здесь всегда
    // говорилось «собеседник ещё не заходил» — то есть отказ СЕТИ выдавался за
    // утверждение о человеке. Цена несимметрична: услышав «не заходил», человек
    // уходит искать другой способ связи; услышав «не дозвонились» — повторяет.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const p = new URL(String(url)).pathname;
      if (p.startsWith('/keys/')) throw new TypeError('fetch failed');
      if (p === '/keys') return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ inbox: [], sent: [], peers: [] }), { status: 200 });
    }));

    engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p',
      onState: () => {}, onError: () => {}, intervals: FAST,
    });
    await wait(100);
    await expect(engine.send({ text: 'привет' })).rejects.toMatchObject({ code: 'directory_failed' });
  });

  it('собеседник действительно не заходил — код peer_unknown, и это правда', async () => {
    // Замок, который горит всегда, — не замок: обе ветки обязаны быть разными.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const p = new URL(String(url)).pathname;
      if (p.startsWith('/keys/')) {
        return new Response(JSON.stringify({ error: 'no', code: 'key_not_found' }), { status: 404 });
      }
      if (p === '/keys') return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ inbox: [], sent: [], peers: [] }), { status: 200 });
    }));

    engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p',
      onState: () => {}, onError: () => {}, intervals: FAST,
    });
    await wait(100);
    await expect(engine.send({ text: 'привет' })).rejects.toMatchObject({ code: 'peer_unknown' });
  });
});

/* ───────── 3. две вкладки разом ───────── */

describe('3. две вкладки, обе просят пропуск', () => {
  it('окно кошелька ОДНО, запрос к серверу ОДИН — не два', async () => {
    // Число здесь тоже переписано после отката: было «ноль окон», стало «одно».
    // А вот вторая половина замера важнее и не изменилась: окно РОВНО ОДНО, не
    // два. Второй одновременный запрос прилетает в кошелёк как `-32002`, и в
    // мобильном MetaMask его нечем отменить — человек заблокирован, пока не
    // закроет приложение кошелька целиком.
    let requests = 0;
    let wallet = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests++;
      await wait(10);
      return new Response(
        JSON.stringify({ pass: 'v1.w.mac', expiresAt: Math.floor(Date.now() / 1000) + 43_200 }),
        { status: 200 },
      );
    }));
    const [a, b] = await Promise.all([
      requestBagPass(async () => { wallet++; return sig('b'); }, ALICE),
      requestBagPass(async () => { wallet++; return sig('b'); }, ALICE),
    ]);
    expect(wallet).toBe(1);
    expect(requests).toBe(1);
    expect(a.pass).toBe(b.pass);
  });
});

/* ───────── 4. пришёл мусор ───────── */

describe('4. справочник отдал мусор', () => {
  const GARBAGE: Record<string, unknown>[] = [
    {},                                            // пустой ответ
    { boxKey: 'не hex' },                          // не ключ вовсе
    { boxKey: '0x' + 'ff'.repeat(16) },            // 16 байт вместо 32
    { boxKey: hexOfPad(), signKey: 'мусор' },      // подписной ключ битый
  ];

  function hexOfPad(): string { return '0x' + 'ab'.repeat(32); }

  it('ни один вид мусора не роняет переписку и не врёт про собеседника', async () => {
    for (const body of GARBAGE) {
      _resetConversationMemoryForTest();
      const states: PairChatState[] = [];
      const errors: unknown[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        const p = new URL(String(url)).pathname;
        if (p.startsWith('/keys/')) return new Response(JSON.stringify(body), { status: 200 });
        if (p === '/keys') return new Response('{}', { status: 200 });
        return new Response(JSON.stringify({ inbox: [], sent: [], peers: [] }), { status: 200 });
      }));

      const e = startPairChat({
        session: alice, peer: BOB, getPass: async () => 'v1.p',
        onState: (s) => { states.push(s); }, onError: (err) => { errors.push(err); },
        intervals: FAST,
      });
      await wait(120);
      e.stop();

      // Переписка жива: снимки идут.
      expect(states.length, JSON.stringify(body)).toBeGreaterThan(0);
      // И НЕ говорится «собеседник не заходил» — справочник ответил, просто
      // мусором, а это не то же самое.
      for (const s of states) expect(s.peerKnown, JSON.stringify(body)).toBe(true);
      // Отказ НАЗВАН, а не проглочен: иначе человек нажал бы «отправить» и не
      // понял, почему ничего не происходит.
      expect(
        states.some(s => s.transportError !== null),
        `мусор ${JSON.stringify(body)} проглочен молча`,
      ).toBe(true);
    }
  });
});

/* ───────── 5. долбят нарочно ───────── */

describe('5. можно ли заставить переподписывать без конца', () => {
  it('публикация ключей отказывает на каждом тике — окон кошелька всё равно одно', async () => {
    // Худший случай: справочник о нас не знает и не узнает (диск потерян,
    // `POST /keys` отдаёт 503 каждый тик). Если бы пропуск не кэшировался,
    // каждый тик ходил бы к кошельку — замер это и проверяет.
    let wallet = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags/pass') {
        return new Response(
          JSON.stringify({ pass: 'v1.w.mac', expiresAt: Math.floor(Date.now() / 1000) + 43_200 }),
          { status: 200 },
        );
      }
      if (u.pathname === '/keys') return new Response('{}', { status: 503 });
      if (u.pathname.startsWith('/keys/')) {
        return new Response(JSON.stringify({
          address: BOB, boxKey: hexOf(bobBoxKey), signKey: hexOf(bobSignKey),
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ inbox: [], sent: [], peers: [] }), { status: 200 });
    }));

    engine = startPairChat({
      session: alice, peer: BOB, intervals: FAST,
      getPass: () => requestBagPass(
        async () => { wallet++; return sig('b'); }, ALICE,
      ).then(p => p.pass),
      onState: () => {}, onError: () => {},
    });
    await wait(1_000);

    // Десятки тиков — одно окно кошелька, потому что пропуск живёт 12 часов.
    expect(wallet).toBe(1);
  });
});
