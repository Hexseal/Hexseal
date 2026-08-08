/**
 * pairChatBreathes.test.ts — ЗАМЕРЫ живой выкатки 8 августа (пункт 35).
 *
 * Человек открыл чат, увидел «Настройка шифрования сообщений» и УШЁЛ. Дословно:
 * «я как юзер уже вышел и закрыл приложение потому что сразу не подключился».
 *
 * Три свойства, каждое — числом, а не рассуждением:
 *
 *  1. ПЕРЕПИСКА ВИДНА СРАЗУ. Первый снимок состояния обязан приехать НЕ ДОЖИДАЯСЬ
 *     пропуска склада. Пропуск — это подпись кошелька; в установленном
 *     приложении круг через кошелёк идёт минутами, и всё это время движок не
 *     выдавал НИ ОДНОГО снимка: ни сообщений, ни ошибки. Значит `isLoading` не
 *     снимался никогда, и в центре экрана вечно крутился замок.
 *
 *  2. «СОБЕСЕДНИК НЕ ЗАХОДИЛ» ГОВОРИТСЯ ДО ПОДПИСИ. Справочник читается БЕЗ
 *     пропуска (правило 4 Задачи 2) — значит ответ «писать некуда» известен
 *     до всякого окна кошелька. До этой правки он спрашивался ВНУТРИ `getPass`,
 *     то есть человек сначала проходил настройку шифрования и только потом
 *     узнавал, что переписка невозможна в принципе.
 *
 *  3. КЛЮЧ СОБЕСЕДНИКА СПРАШИВАЕТСЯ ОДИН РАЗ. В консоли владельца пять
 *     одинаковых `GET /keys/<peer>` → 404 подряд. Ответ известен и не меняется.
 *
 * ⚠️ ЧТО ИМЕННО КРАСИТ КАЖДЫЙ ЗАМОК — написано в самом тесте. Замок, про
 * который нельзя сказать «что исчезнет из поведения, если снять правку», в этом
 * проекте уже ловили шесть раз за одну задачу.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import type { ChatSession } from '@/lib/chatSession';
import { deriveLinkSigningKeypair, _resetConversationMemoryForTest } from '@/lib/chatConversation';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import { startPairChat, type PairChatState, type PairChatEngine } from './usePairChat';

const ALICE = '0xA1cE00000000000000000000000000000000CAfE' as const;
const BOB   = '0xB0b1000000000000000000000000000000005eEd' as const;
const BOB_LC = BOB.toLowerCase() as `0x${string}`;

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

/** Настоящие часы, маленькими шагами: движок живёт на реальных таймерах, и
 *  подменять их здесь значило бы мерить не то, что видит человек. */
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Harness {
  /** Сколько раз движок попросил окно кошелька (пропуск склада). */
  walletPrompts: number;
  /** Каждое обращение к справочнику ключей собеседника. */
  keyLookups: string[];
  states: PairChatState[];
  errors: unknown[];
  /** Подпись подтверждена (пропуск отдан) — или ещё нет. */
  passResolved: boolean;
  /** Разрешить «подпись» — отдать пропуск. */
  resolvePass(): void;
}

/**
 * Поддельный релеер и поддельный кошелёк. Пропуск НЕ отдаётся, пока тест сам не
 * разрешит: это и есть «человек не подтвердил подпись» — ровно то состояние, в
 * котором владелец закрыл приложение.
 */
function harness(opts: {
  peerBoxKey: Uint8Array;
  peerSignKey: Uint8Array | null;
  /** 404 — собеседник ни разу не заходил. */
  keysStatus?: number;
  /** Справочник вообще не отвечает (сеть легла). */
  keysNetworkDown?: boolean;
}): Harness {
  const h: Harness = {
    walletPrompts: 0, keyLookups: [], states: [], errors: [],
    passResolved: false, resolvePass: () => {},
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const p = u.pathname;
    if (p === '/keys' && init?.method === 'POST') {
      return new Response(JSON.stringify({ address: ALICE.toLowerCase() }), { status: 200 });
    }
    if (p.startsWith('/keys/')) {
      h.keyLookups.push(p);
      if (opts.keysNetworkDown) throw new TypeError('fetch failed');
      if (opts.keysStatus && opts.keysStatus !== 200) {
        return new Response(
          JSON.stringify({ error: 'No chat key on file', code: 'key_not_found' }),
          { status: opts.keysStatus },
        );
      }
      return new Response(JSON.stringify({
        address: BOB_LC, boxKey: hexOf(opts.peerBoxKey),
        ...(opts.peerSignKey ? { signKey: hexOf(opts.peerSignKey) } : {}),
      }), { status: 200 });
    }
    if (p === '/bags' && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ inbox: [], sent: [], peers: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ key: 'a/1' }), { status: 200 });
  }));
  return h;
}

function start(
  session: ChatSession, h: Harness,
  extra?: { intervals?: { activeMs: number; backgroundMs: number; maxBackoffMs: number }; onAuthFailed?: () => void },
): PairChatEngine {
  // Пропуск, раз подтверждённый, остаётся подтверждённым: `requestBagPass` в
  // жизни кэширует его на 12 часов, и подделка, требующая нового подтверждения
  // на КАЖДЫЙ тик, мерила бы не то — она бы сама останавливала опрос после
  // первого круга (на чём этот замер один раз уже оказался слепым).
  const waiting: ((pass: string) => void)[] = [];
  h.resolvePass = () => {
    h.passResolved = true;
    for (const r of waiting.splice(0)) r('v1.pass.mac');
  };
  return startPairChat({
    session,
    peer: BOB_LC,
    getPass: () => {
      if (h.passResolved) return Promise.resolve('v1.pass.mac');
      h.walletPrompts++;
      return new Promise<string>((res) => { waiting.push(res); });
    },
    onState: (s) => { h.states.push(s); },
    onError: (e) => { h.errors.push(e); },
    ...(extra?.intervals ? { intervals: extra.intervals } : {}),
    ...(extra?.onAuthFailed ? { onAuthFailed: extra.onAuthFailed } : {}),
  });
}

/** Частые тики — чтобы «спрашивает по кругу» вообще было чем измерить: на
 *  боевых 5 с за секунду теста происходит один тик, и любой замок про повторы
 *  был бы слепым (зелёным и без отступления). Сами числа отступления при этом
 *  БОЕВЫЕ — подставляется только частота опроса. */
const FAST = { activeMs: 20, backgroundMs: 20, maxBackoffMs: 100 };

let alice: ChatSession;
let bobSignKey: Uint8Array;
let bobBoxKey: Uint8Array;
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

describe('замер 1: переписка видна, не дожидаясь подписи', () => {
  it('снимок состояния приезжает ДО того, как пропуск подтверждён', async () => {
    // Что красит: движок снова ждёт `getPass()` перед первой выдачей состояния.
    // Тогда `isLoading` не снимается, и в центре экрана вечно «Настройка
    // шифрования сообщений» — ровно тот экран, с которого человек ушёл.
    const h = harness({ peerBoxKey: bobBoxKey, peerSignKey: bobSignKey });
    const t0 = Date.now();
    engine = start(alice, h);

    await wait(120);

    // Подпись НЕ подтверждена — окно кошелька открыто и висит.
    expect(h.walletPrompts).toBeGreaterThan(0);
    // ...и всё равно человеку уже что-то показали.
    expect(h.states.length).toBeGreaterThan(0);
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('первый снимок НЕ врёт про отказ склада: связь ещё не пробовали', async () => {
    // Замок против «своя починка хуже дефекта»: выдать первый снимок с
    // `transportError` означало бы поставить человеку «Не удалось подключиться»
    // там, где ни одного запроса к складу ещё не было.
    const h = harness({ peerBoxKey: bobBoxKey, peerSignKey: bobSignKey });
    engine = start(alice, h);
    await wait(120);
    expect(h.states[0]?.transportError).toBeNull();
  });
});

describe('замер 2: «собеседник не заходил» — до единой подписи', () => {
  it('404 справочника доезжает до снимка, пока подпись не подтверждена', async () => {
    // Что красит: справочник снова спрашивается ВНУТРИ `getPass` (или после
    // него). Тогда человек, которому писать некуда, сначала проходит настройку
    // шифрования, а узнаёт об этом после.
    const h = harness({ peerBoxKey: bobBoxKey, peerSignKey: bobSignKey, keysStatus: 404 });
    engine = start(alice, h);

    await wait(120);

    const said = h.states.find((s) => s.peerKnown === false);
    expect(said, 'ни один снимок не сказал «собеседник не заходил»').toBeDefined();
    // Подпись за это время НЕ подтверждалась ни разу.
    expect(h.passResolved).toBe(false);
  });

  it('справочник спрошен ДО первого снимка', async () => {
    const h = harness({ peerBoxKey: bobBoxKey, peerSignKey: bobSignKey, keysStatus: 404 });
    engine = start(alice, h);
    await wait(120);
    expect(h.keyLookups.length).toBeGreaterThan(0);
  });
});

describe('замер 3: ключ собеседника спрашивается один раз', () => {
  it('404 не переспрашивается каждый тик', async () => {
    // Замер владельца: пять одинаковых `GET /keys/<peer>` → 404 подряд.
    // Ответ известен и не меняется — спрашивать надо один раз и отступать.
    //
    // Что красит: снятие отступления. Тогда число обращений становится равным
    // числу тиков (за секунду при 20 мс — десятки), а на боевых пяти секундах
    // это те самые «пять одинаковых 404 подряд» из консоли владельца.
    const h = harness({ peerBoxKey: bobBoxKey, peerSignKey: bobSignKey, keysStatus: 404 });
    engine = start(alice, h, { intervals: FAST });
    // Пропуск отдаём сразу: без него тик не доходит до повторного опроса, и
    // замер был бы слепым — он мерил бы отсутствие тиков, а не отступление.
    await wait(20);
    h.resolvePass();

    await wait(1_000);

    // Тиков за секунду при 20 мс — десятки. Обращение к справочнику — одно.
    expect(h.keyLookups.length).toBe(1);
  });

  it('справочник лёг — переписка не умирает и НЕ врёт «собеседник не заходил»', async () => {
    // Два свойства одним замером, и оба про честность:
    //  1. отказ справочника (сеть) — НЕ то же самое, что «он не заходил»:
    //     сказать второе там, где верно первое, значит обвинить человека в
    //     том, чего он не делал;
    //  2. отказ справочника не имеет права остановить опрос целиком — до этой
    //     правки он вылетал из `getPass`, считался отказом ВХОДА, и на третьем
    //     подряд `pollBags` звал `onAuthFailed`: чат мёртв до перезагрузки
    //     страницы из-за того, что моргнул справочник.
    let authFailed = 0;
    const h = harness({ peerBoxKey: bobBoxKey, peerSignKey: bobSignKey, keysNetworkDown: true });
    engine = start(alice, h, { intervals: FAST, onAuthFailed: () => { authFailed++; } });
    await wait(20);
    h.resolvePass();
    await wait(1_000);

    expect(authFailed).toBe(0);
    expect(h.states.length).toBeGreaterThan(0);
    for (const s of h.states) expect(s.peerKnown).toBe(true);
  });
});
