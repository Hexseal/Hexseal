/**
 * usePairChat.test.ts — движок одной переписки: опрос, приём, отправка.
 *
 * Задача 6 плана «Клиент чата». Свойства, заперты здесь:
 *  1. опрос на БОЕВЫХ умолчаниях (5 с / 30 с), без подстановки своих чисел;
 *  2. курсор двигается — второй тик не скачивает того, что скачал первый;
 *  3. уход со страницы отменяет ВСЁ в полёте, не только перечисление;
 *  4. отказ склада различается кодом, не английским текстом;
 *  5. переписанная целиком чужим ключом цепочка отвергается — ПИН РЕАЛЬНО
 *     ДОЕЗЖАЕТ из справочника до проверки (в `useChatSession.test.ts`
 *     заперто, что `receiveBags` умеет пинить; здесь — что хук ей это даёт);
 *  6. слишком длинное сообщение получает отказ ДО отправки.
 *
 * ⚠️ Тестируется ЧИСТЫЙ движок (`startPairChat`), не React-обёртка: у фронта
 * нет ни jsdom, ни @testing-library (окружение vitest — `node`). Обёртка
 * сведена к состоянию и одному вызову `stop()` в уборке эффекта, движок
 * несёт всю логику. Разбор — в шапке `useChatSession.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import type { ChatSession } from '@/lib/chatSession';
import {
  deriveLinkSigningKeypair, encodeFrame, decodeFrame, messageBodyHash, linkSignaturePreimage,
  receiveBags, _resetConversationMemoryForTest,
} from '@/lib/chatConversation';
import { buildLink, type ChainLink } from '@/lib/chatChain';
import { packEnvelope, unpackEnvelope } from '@/lib/chatEnvelope';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import { startPairChat, troubleSummary, type PairChatState, type PairChatEngine } from './usePairChat';
import { fetchPeerChatKeys } from './useChatSession';

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

/** Настоящие мешки: конверт → звено → подпись → кадр, как их собирает отправка. */
async function buildBags(
  from: ChatSession, claimedSender: `0x${string}`, recipientPub: Uint8Array, texts: string[],
) {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(from.keypair);
  const out: { key: string; sender: string; size: number; uploadedAt: number; body: Uint8Array }[] = [];
  let prev: ChainLink | null = null;
  for (let i = 0; i < texts.length; i++) {
    const envelope = await packEnvelope(
      { text: texts[i] }, recipientPub, from.keypair.publicKey, claimedSender.toLowerCase() as `0x${string}`,
    );
    const bodyHash = messageBodyHash(signer.publicKey, envelope);
    const link = buildLink(prev, bodyHash, claimedSender.toLowerCase() as `0x${string}`, 1_700_000_000_000 + i);
    const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
    const body = encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope });
    out.push({
      key: `${ALICE.toLowerCase()}/${1_700_000_000_000 + i}.bin`,
      sender: claimedSender.toLowerCase(), size: body.length,
      uploadedAt: 1_700_000_000_000 + i, body,
    });
    prev = link;
  }
  return out;
}

/**
 * Поддельный релеер поверх `fetch`. Ведёт себя как настоящий там, где это
 * важно для замеров: `since` нестрогое (`>=`), скачивание отдаёт байты,
 * справочник отдаёт обе половины ключа.
 */
function fakeRelayer(opts: {
  bags: { key: string; sender: string; size: number; uploadedAt: number; body: Uint8Array }[];
  peerBoxKey: Uint8Array;
  peerSignKey: Uint8Array | null;
  keysStatus?: number;
  putStatus?: number;
  putBody?: unknown;
  /** Виснет ВСЁ (список и скачивание). */
  hang?: boolean;
  /** Виснет ТОЛЬКО скачивание — список отвечает нормально и приносит мешки.
   *  Разведено намеренно: замок «отмена доходит до скачивания» на общем
   *  `hang` был слеп — вис только список, который и так обрывается через
   *  `pollBags`, а мутация «stop() не зовёт abort()» проходила зелёной. */
  hangDownloads?: boolean;
}) {
  const downloads: string[] = [];
  const inFlight = new Set<number>();
  let n = 0;
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const p = u.pathname;

    if (p === '/keys' && init?.method === 'POST') {
      return new Response(JSON.stringify({ address: ALICE.toLowerCase() }), { status: 200 });
    }
    if (p.startsWith('/keys/')) {
      if (opts.keysStatus && opts.keysStatus !== 200) {
        return new Response(JSON.stringify({ error: 'no', code: 'key_not_found' }), { status: opts.keysStatus });
      }
      return new Response(JSON.stringify({
        address: BOB_LC, boxKey: hexOf(opts.peerBoxKey),
        ...(opts.peerSignKey ? { signKey: hexOf(opts.peerSignKey) } : {}),
      }), { status: 200 });
    }
    if (p === '/bags' && (init?.method ?? 'GET') === 'GET') {
      const raw = u.searchParams.get('since');
      const since = raw === null ? null : Number(raw);
      const inbox = (since === null ? opts.bags : opts.bags.filter(b => b.uploadedAt >= since))
        .map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt }));
      if (opts.hang) {
        const id = ++n; inFlight.add(id);
        return new Promise<Response>((_r, rej) => {
          init?.signal?.addEventListener('abort', () => { inFlight.delete(id); rej(new DOMException('Aborted', 'AbortError')); });
        });
      }
      return new Response(JSON.stringify({ inbox, sent: [], peers: [] }), { status: 200 });
    }
    if (init?.method === 'PUT') {
      return new Response(JSON.stringify(opts.putBody ?? { key: 'a/1' }), { status: opts.putStatus ?? 200 });
    }
    // скачивание мешка
    const key = decodeURIComponent(p.replace(/^\/bags\//, ''));
    downloads.push(key);
    if (opts.hang || opts.hangDownloads) {
      const id = ++n; inFlight.add(id);
      return new Promise<Response>((_r, rej) => {
        init?.signal?.addEventListener('abort', () => { inFlight.delete(id); rej(new DOMException('Aborted', 'AbortError')); });
      });
    }
    const bag = opts.bags.find(b => b.key === key);
    if (!bag) return new Response(JSON.stringify({ error: 'Bag not found', code: 'bag_not_found' }), { status: 404 });
    return new Response(bag.body, { status: 200 });
  });
  return { fetchMock, downloads, inFlight };
}

/** Ждёт условия НАСТОЯЩИМИ таймерами. Прокрутка микрозадач тут не годится:
 *  разбор мешка идёт через libsodium и `Response.arrayBuffer()`, а это не
 *  микрозадачи — первая версия этих тестов ждала `Promise.resolve()` и
 *  читала состояние ДО того, как оно появлялось. */
async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor: условие не наступило за отведённое время');
    await new Promise(r => setTimeout(r, 5));
  }
}

/**
 * Гоняет движок, пока не наберётся `states` состояний, и только потом
 * останавливает. Считать ТИКИ здесь нельзя: тик и выдача состояния —
 * разные события (скачивание и разбор идут после ответа списка), и замер по
 * тикам читал бы состояние раньше, чем оно родилось.
 */
function drive(engineOpts: Parameters<typeof startPairChat>[0], wantStates: number) {
  const states: PairChatState[] = [];
  const slept: number[] = [];
  const errors: unknown[] = [];
  const engine = startPairChat({
    ...engineOpts,
    onState: (s) => { states.push(s); },
    onError: (e) => { errors.push(e); },
    // ⚠️ НАСТОЯЩАЯ, пусть и крошечная, пауза — не мгновенно разрешённый
    // промис. Мгновенный `sleep` держит цикл опроса в микрозадачах, до
    // макрозадач управление не доходит НИКОГДА, `setTimeout` в `waitFor` не
    // срабатывает — и тест не падает, а убивает исполнителя тестов
    // («Worker exited unexpectedly»). Замерено здесь же, первой версией
    // этого файла.
    sleep: async (ms) => { slept.push(ms); await new Promise(r => setTimeout(r, 1)); },
  });
  const done = waitFor(() => states.length >= wantStates).finally(() => engine.stop());
  return { engine, done, states, slept, errors };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
});

/* ─────────────────── приём, курсор и боевые умолчания ─────────────────── */

describe('движок переписки: приём и опрос', () => {
  it('ЗАМЕР: два сообщения приезжают, второй тик скачивает НОЛЬ мешков', async () => {
    // Свойство 2 задачи на уровне хука: без движущегося курсора движок качал
    // бы те же два мешка каждые пять секунд, вечно.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const bags = await buildBags(bob, BOB, alice.keypair.publicKey, ['раз', 'два']);
    const { fetchMock, downloads } = fakeRelayer({
      bags, peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true }, 3);
    await run.done;

    const last = run.states[run.states.length - 1];
    expect(last.messages.map(m => m.text)).toEqual(['раз', 'два']);
    // Каждый мешок скачан РОВНО один раз за ТРИ выдачи состояния — то есть
    // за три полных тика опроса, а не за один.
    expect(run.states.length).toBeGreaterThanOrEqual(3);
    expect(downloads).toHaveLength(2);
    expect(new Set(downloads).size).toBe(2);
  }, 20_000);

  it('ЗАМЕР: свои ключи уезжают в справочник РОВНО один раз, а не каждые пять секунд', async () => {
    // Без этого замка публикация «на всякий случай каждый тик» выглядела бы
    // безобидно: сервер отбрасывает байт-в-байт повтор ранним возвратом. Но
    // это запрос каждые пять секунд от каждого открытого чата — та самая
    // нагрузка, которую весь курсор и убирает.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const { fetchMock } = fakeRelayer({ bags: [], peerBoxKey: bob.keypair.publicKey, peerSignKey: null });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true }, 3);
    await run.done;

    const publishes = fetchMock.mock.calls.filter(
      c => new URL(String(c[0])).pathname === '/keys' && (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    const peerReads = fetchMock.mock.calls.filter(c => new URL(String(c[0])).pathname.startsWith('/keys/'));
    expect(run.states.length).toBeGreaterThanOrEqual(3);
    expect(publishes).toHaveLength(1);
    expect(peerReads).toHaveLength(1);
  }, 20_000);

  it('ЗАМЕР: боевые умолчания опроса — 5000 мс активно, 30000 мс в фоне', async () => {
    // ⚠️ `intervals` НЕ передаётся. Числа записаны руками: правка
    // ограничителя однажды прошла ревью зелёной ровно потому, что тесты
    // подставляли свои значения вместо боевых.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const { fetchMock } = fakeRelayer({ bags: [], peerBoxKey: bob.keypair.publicKey, peerSignKey: null });
    vi.stubGlobal('fetch', fetchMock);

    let active = true;
    const slept: number[] = [];
    let engine!: ReturnType<typeof startPairChat>;
    let resolveDone!: () => void;
    const done = new Promise<void>(r => { resolveDone = r; });
    engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p',
      isActive: () => active,
      onState: () => {},
      sleep: async (ms) => {
        slept.push(ms);
        if (slept.length === 1) active = false;
        if (slept.length >= 2) { engine.stop(); resolveDone(); }
        await new Promise(r => setTimeout(r, 1)); // см. комментарий в drive()
      },
    });
    await done;

    expect(slept).toEqual([5_000, 30_000]);
  }, 20_000);
});

/* ──────────── пин подписного ключа доезжает из справочника ────────────── */

describe('пин подписного ключа: справочник → receiveBags', () => {
  it('ЗАМЕР: переписанная целиком чужим ключом цепочка — ноль сообщений и три signer_unexpected', async () => {
    // Что красит: снятие `peerSigningPublicKeys` в движке. Тогда подделка
    // проходит как своя — три сообщения, ноль претензий (замерено в
    // useChatSession.test.ts второй половиной той же пары).
    const alice = await makeSession(ALICE, 'a1');
    const bobReal = await makeSession(BOB, 'bb');
    const mallory = await makeSession(BOB, 'ee');
    const bobSigner = await deriveLinkSigningKeypair(bobReal.keypair);
    const forged = await buildBags(mallory, BOB, alice.keypair.publicKey, ['раз', 'два', 'три']);

    const { fetchMock } = fakeRelayer({
      bags: forged,
      peerBoxKey: bobReal.keypair.publicKey,
      peerSignKey: bobSigner.publicKey, // справочник знает НАСТОЯЩИЙ ключ Боба
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true }, 1);
    await run.done;

    const last = run.states[run.states.length - 1];
    expect(last.messages).toHaveLength(0);
    expect(last.troubles.filter(t => t.kind === 'signer_unexpected')).toHaveLength(3);
  }, 20_000);

  it('справочник без signKey (старая запись) — переписка работает, просто без пина', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bags = await buildBags(bob, BOB, alice.keypair.publicKey, ['привет']);
    const { fetchMock } = fakeRelayer({ bags, peerBoxKey: bob.keypair.publicKey, peerSignKey: null });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true }, 1);
    await run.done;

    expect(run.states[run.states.length - 1].messages.map(m => m.text)).toEqual(['привет']);
  }, 20_000);

  it('«собеседник ещё не заходил» — не падение, а признак', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const { fetchMock } = fakeRelayer({
      bags: [], peerBoxKey: bob.keypair.publicKey, peerSignKey: null, keysStatus: 404,
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true }, 1);
    await run.done;

    expect(run.states[run.states.length - 1].peerKnown).toBe(false);
  }, 20_000);
});

/* ───────────────────────── отмена в полёте ────────────────────────────── */

describe('уход со страницы отменяет всё в полёте', () => {
  it('ЗАМЕР: после stop() незавершённых запросов ноль', async () => {
    // ⚠️ Виснет СКАЧИВАНИЕ, а не список. Список обрывается своим собственным
    // контроллером внутри `pollBags` — на нём мутация «stop() не зовёт
    // abort()» проходит зелёной, потому что до скачиваний замер просто не
    // доходит. Ровно то, ради чего задача добавляла сигнал `fetchBag`.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bags = await buildBags(bob, BOB, alice.keypair.publicKey, ['раз', 'два', 'три']);
    const { fetchMock, inFlight } = fakeRelayer({
      bags, peerBoxKey: bob.keypair.publicKey, peerSignKey: null, hangDownloads: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: () => {}, onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });

    // Список ответил, движок пошёл качать — и завис на первом же мешке.
    await waitFor(() => inFlight.size > 0);
    expect(inFlight.size).toBeGreaterThan(0);
    expect(engine.inFlight()).toBeGreaterThan(0);

    engine.stop();
    // Оба счётчика: у сети (запрос реально оборван) и у движка (он узнал об
    // этом и снял свой). Ждём ОБА — отмена доходит до сети синхронно, а до
    // `finally` внутри `fetchBag` микрозадачей позже, и замер по одному
    // счётчику прочёл бы «единица» на совершенно исправной отмене.
    await waitFor(() => inFlight.size === 0 && engine.inFlight() === 0);
    expect(inFlight.size).toBe(0);
    expect(engine.inFlight()).toBe(0);
  }, 20_000);
});

/* ──────────────────────── отказы различаются кодом ─────────────────────── */

describe('отказ склада различается кодом, а не английским текстом', () => {
  const CASES: { status: number; code: string }[] = [
    { status: 400, code: 'invalid_recipient' },
    { status: 401, code: 'pass_expired' },
    { status: 404, code: 'bag_not_found' },
    { status: 413, code: 'payload_too_large' },
    { status: 429, code: 'rate_limited_write' },
    { status: 500, code: 'internal_error' },
  ];

  it('ЗАМЕР: шесть кодов — шесть разных вердиктов отправки, ни одного разбора текста', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const seen: { status?: number; code?: string }[] = [];

    for (const c of CASES) {
      const { fetchMock } = fakeRelayer({
        bags: [], peerBoxKey: bob.keypair.publicKey, peerSignKey: null,
        putStatus: c.status, putBody: { error: 'whatever the english says', code: c.code },
      });
      vi.stubGlobal('fetch', fetchMock);

      const engine = startPairChat({
        session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
        onState: () => {}, onError: () => {}, sleep: async () => new Promise(() => {}),
      });
      try {
        await engine.send({ text: `проба ${c.status}` });
        seen.push({});
      } catch (err) {
        const e = err as { status?: number; cause?: { code?: string } };
        seen.push({ status: e.status, code: e.cause?.code });
      } finally {
        engine.stop();
      }
    }

    expect(seen.map(s => s.status)).toEqual(CASES.map(c => c.status));
    expect(seen.map(s => s.code)).toEqual(CASES.map(c => c.code));
    expect(new Set(seen.map(s => s.code)).size).toBe(6);
  }, 30_000);

  it('ЗАМЕР: только что отправленное — НЕ «дошло», пока склад не подтвердил', async () => {
    // Пойман мутацией, а не рассуждением: `delivered: true` на возврате
    // `send()` проходил все замки зелёным. Галочка «дошло» по факту успешной
    // ОТПРАВКИ обещает за собеседника — мешок лежит на складе, забрал он его
    // или нет, мы в этот момент не знаем и знать не можем.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const { fetchMock } = fakeRelayer({
      bags: [], peerBoxKey: bob.keypair.publicKey, peerSignKey: null,
    });
    vi.stubGlobal('fetch', fetchMock);

    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: () => {}, onError: () => {}, sleep: async () => new Promise(() => {}),
    });
    try {
      const sent = await engine.send({ text: 'только что' });
      expect(sent.delivered).toBe(false);
      expect(sent.isFromMe).toBe(true);
    } finally {
      engine.stop();
    }
  }, 20_000);
});

/* ─────────────── слишком длинное — отказ ДО отправки ──────────────────── */

describe('слишком длинное сообщение', () => {
  it('ЗАМЕР: отказ с кодом message_too_large и НОЛЬ обращений к складу за отправку', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const { fetchMock } = fakeRelayer({ bags: [], peerBoxKey: bob.keypair.publicKey, peerSignKey: null });
    vi.stubGlobal('fetch', fetchMock);

    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: () => {}, onError: () => {}, sleep: async () => new Promise(() => {}),
    });
    try {
      // Дать движку добрать ключ собеседника (иначе отказ пришёл бы «нет ключа»,
      // а не «слишком длинно» — и замок проверял бы не то).
      await waitFor(() => fetchMock.mock.calls.some(c => String(c[0]).includes('/keys/')));
      const before = fetchMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PUT').length;

      await expect(engine.send({ text: 'я'.repeat(263_000) }))
        .rejects.toMatchObject({ code: 'message_too_large' });

      const after = fetchMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PUT').length;
      expect(after - before).toBe(0);
    } finally {
      engine.stop();
    }
  }, 20_000);
});

/* ────────────────────────────── мусор ─────────────────────────────────── */

describe('пришёл мусор — вердикт, а не падение', () => {
  it('склад отдал половину мешка и чужой мешок — переписка жива, претензии названы', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const good = await buildBags(bob, BOB, alice.keypair.publicKey, ['целое']);
    // Обрезок: те же байты, но половина.
    const half = {
      ...good[0], key: `${ALICE.toLowerCase()}/1700000000009.bin`,
      uploadedAt: 1_700_000_000_009,
      body: good[0].body.slice(0, Math.floor(good[0].body.length / 2)),
    };

    const { fetchMock } = fakeRelayer({
      bags: [good[0], half], peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true }, 1);
    await run.done;

    const last = run.states[run.states.length - 1];
    expect(last.messages.map(m => m.text)).toEqual(['целое']);
    expect(last.troubles.length).toBeGreaterThan(0);
  }, 20_000);
});

/* ────────── В-4/В-5: два видимых поля, не запертых ничем ────────── */

describe('поля, которые человек видит глазами', () => {
  it('ЗАМЕР (В-4): «это моё сообщение» отличает своё от чужого — 1 своё, 1 чужое', async () => {
    // Самое заметное поле панели (пузырь слева или справа) в первой версии
    // моих тестов не наблюдалось НИ РАЗУ: мутация «всегда ложь» давала 0
    // красных. Независимая проверка нашла это раньше меня.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const bags = await buildBags(bob, BOB, alice.keypair.publicKey, ['от Боба']);
    const { fetchMock } = fakeRelayer({
      bags, peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
    });
    vi.stubGlobal('fetch', fetchMock);

    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    try {
      await waitFor(() => states.length > 0 && states[states.length - 1].messages.length === 1);
      await engine.send({ text: 'от Алисы' });
      await waitFor(() => states[states.length - 1].messages.length === 2);

      const last = states[states.length - 1].messages;
      const mine = last.filter(m => m.isFromMe);
      const theirs = last.filter(m => !m.isFromMe);
      expect(mine.map(m => m.text)).toEqual(['от Алисы']);
      expect(theirs.map(m => m.text)).toEqual(['от Боба']);
      expect(mine[0].from).toBe(ALICE.toLowerCase());
      expect(theirs[0].from).toBe(BOB.toLowerCase());
    } finally {
      engine.stop();
    }
  }, 30_000);

  it('ЗАМЕР (В-5): галочка «дошло» НЕ пропадает, когда склад перестал о ней рассказывать', async () => {
    // Собственная шапка описывала именно этот регресс («галочка пропадала бы
    // у старых сообщений»), а мутация «очищать множество перед каждым тиком»
    // проходила молча. Сервер фильтрует `sent` тем же `since`, что и `inbox`,
    // значит давняя доставка из ответа СО ВРЕМЕНЕМ УХОДИТ — это не выдумка.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');

    let sentView: { key: string; recipient: string; uploadedAt: number; fetched: boolean }[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const p = u.pathname;
      if (p === '/keys' && init?.method === 'POST') return new Response('{}', { status: 200 });
      if (p.startsWith('/keys/')) {
        return new Response(JSON.stringify({ boxKey: hexOf(bob.keypair.publicKey) }), { status: 200 });
      }
      if (p === '/bags' && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ inbox: [], sent: sentView, peers: [] }), { status: 200 });
      }
      if (init?.method === 'PUT') return new Response(JSON.stringify({ key: 'a/1' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    try {
      await waitFor(() => states.length > 0);
      await engine.send({ text: 'моё' });

      // 1) склад ещё не отдавал мешок собеседнику
      sentView = [{ key: 'a/1', recipient: BOB.toLowerCase(), uploadedAt: 1, fetched: false }];
      await waitFor(() => states[states.length - 1].messages.length === 1);
      const before = states.length;
      await waitFor(() => states.length > before);
      expect(states[states.length - 1].messages[0].delivered).toBe(false);

      // 2) забрал — галочка появилась
      sentView = [{ key: 'a/1', recipient: BOB.toLowerCase(), uploadedAt: 1, fetched: true }];
      await waitFor(() => states[states.length - 1].messages[0].delivered === true);

      // 3) курсор уехал, склад больше про этот мешок не рассказывает —
      //    галочка обязана ОСТАТЬСЯ.
      sentView = [];
      const mark = states.length;
      await waitFor(() => states.length > mark + 2);
      expect(states[states.length - 1].messages[0].delivered).toBe(true);
    } finally {
      engine.stop();
    }
  }, 30_000);

  it('ЗАМЕР: список переписок получает сигнал о НОВОМ входящем и не получает на тихом тике', async () => {
    // Мелочь независимой проверки, но заметная глазами: событие
    // `hexseal-conv-update` слали только те два файла XMTP, которые сносит
    // задача 7. Без него мгновенное обновление списка вырождалось в тридцать
    // секунд ожидания.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const all = await buildBags(bob, BOB, alice.keypair.publicKey, ['раз', 'два']);
    const bags = [all[0]];
    const { fetchMock } = fakeRelayer({
      bags, peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
    });
    vi.stubGlobal('fetch', fetchMock);

    let signals = 0;
    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {},
      onIncoming: () => { signals++; },
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    try {
      await waitFor(() => signals === 1);
      const quiet = states.length;
      await waitFor(() => states.length > quiet + 3);
      expect(signals).toBe(1);          // тихие тики сигнала не дают

      bags.push(all[1]);                 // приехало второе
      await waitFor(() => signals === 2);
      expect(signals).toBe(2);
    } finally {
      engine.stop();
    }
  }, 30_000);
});

/* ───────── В-3: вложение теряло пять полей по дороге ───────── */

describe('вложение доезжает целиком, а не наполовину', () => {
  /** Гоняет один payload через настоящую отправку и настоящий приём. */
  async function roundTrip(payload: Parameters<PairChatEngine['send']>[0]) {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    let stored: Uint8Array | null = null;

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url)); const p = u.pathname;
      if (p === '/keys' && init?.method === 'POST') return new Response('{}', { status: 200 });
      if (p.startsWith('/keys/')) return new Response(JSON.stringify({ boxKey: hexOf(alice.keypair.publicKey) }), { status: 200 });
      if (p === '/bags' && (init?.method ?? 'GET') === 'GET') {
        const inbox = stored ? [{ key: 'a/1', sender: ALICE.toLowerCase(), size: stored.length, uploadedAt: 7 }] : [];
        return new Response(JSON.stringify({ inbox, sent: [], peers: [] }), { status: 200 });
      }
      if (init?.method === 'PUT') {
        stored = new Uint8Array(init.body as ArrayBufferView as Uint8Array);
        return new Response(JSON.stringify({ key: 'a/1' }), { status: 200 });
      }
      return new Response(stored ?? new Uint8Array(0), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Алиса шлёт (сама себе как «собеседнику» — ключ в справочнике её же,
    // значит Боб ниже её мешок вскроет ровно как настоящий получатель).
    const sender = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: () => {}, onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    try {
      const mine = await sender.send(payload);
      // …и она же читает своё обратно со склада: конверт запечатан ДВАЖДЫ,
      // отправитель обязан читать своё (свойство 2 конверта).
      const states: PairChatState[] = [];
      const receiver = startPairChat({
        session: alice, peer: ALICE, getPass: async () => 'v1.p', isActive: () => true,
        onState: (s) => { states.push(s); }, onError: () => {},
        sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
      });
      try {
        await waitFor(() => states.some(s => s.messages.length > 0));
        const got = states[states.length - 1].messages[0];
        return { mine, got };
      } finally { receiver.stop(); }
    } finally { sender.stop(); }
  }

  it('ЗАМЕР: большой файл — все пять потерянных полей на месте у ПОЛУЧАТЕЛЯ', async () => {
    // Что красит: сегодня отправка кладёт в конверт только url/name/size/
    // keyHex/ivHex. Признак нарезки теряется — панель идёт НЕ ТОЙ веткой
    // расшифровки, и файл больше 20 МБ приезжает битым.
    const { got } = await roundTrip({
      file: {
        url: 'https://relay.example/files/abc', name: 'большой.zip', size: 41_943_040,
        keyHex: 'aa'.repeat(32), ivHex: 'bb'.repeat(12),
        fileKey: 'files/abc', mime: 'application/zip',
        chunked: true, chunkCount: 5, chunkSize: 8 * 1024 * 1024,
      },
    });

    expect(got.attachment).toEqual({
      name: 'большой.zip',
      url: 'https://relay.example/files/abc',
      size: 41_943_040,
      key: 'aa'.repeat(32),
      iv: 'bb'.repeat(12),
      fileKey: 'files/abc',
      mime: 'application/zip',
      chunked: true,
      chunkCount: 5,
      chunkSize: 8 * 1024 * 1024,
    });
  }, 40_000);

  it('маленький файл: ключ файла и тип содержимого доезжают, нарезки нет', async () => {
    const { got } = await roundTrip({
      file: {
        url: 'https://relay.example/files/small', name: 'кот.png', size: 12_345,
        keyHex: 'cc'.repeat(32), ivHex: 'dd'.repeat(12),
        fileKey: 'files/small', mime: 'image/png', chunked: false,
      },
    });

    // Тип содержимого — то, из-за чего есть превью картинки и правильное имя
    // при сохранении. Ключ файла — то, чем обновляют протухший адрес; без
    // него адрес, запечатанный в конверте, не обновить НИКОГДА.
    expect(got.attachment?.mime).toBe('image/png');
    expect(got.attachment?.fileKey).toBe('files/small');
    expect(got.attachment?.chunked).toBe(false);
    expect(got.attachment?.chunkCount).toBeUndefined();
  }, 40_000);

  it('старое вложение без новых полей читается как прежде — обратная совместимость', async () => {
    const { got } = await roundTrip({
      file: {
        url: 'https://relay.example/files/old', name: 'старое.txt', size: 10,
        keyHex: 'ee'.repeat(32), ivHex: 'ff'.repeat(12),
      },
    });
    expect(got.attachment).toEqual({
      name: 'старое.txt', url: 'https://relay.example/files/old', size: 10,
      key: 'ee'.repeat(32), iv: 'ff'.repeat(12),
    });
  }, 40_000);
});

/* ─── В-3, вторая половина: мусор в новых полях вложения ─── */

describe('гейт формы вложения знает и о новых полях', () => {
  // Мутация «убрать проверку признака нарезки» на замках выше НЕ КРАСНЕЛА:
  // те гоняют честно собранный payload, а гейт стоит на РАЗБОРЕ чужих
  // данных. Форму проверяем там, где она проверяется, — иначе `chunked:
  // "yes"` из сети повёл бы панель не той веткой расшифровки.
  const BASE = {
    url: 'https://relay.example/f', name: 'f.bin', size: 1,
    keyHex: 'aa'.repeat(32), ivHex: 'bb'.repeat(12),
  };

  const CASES: Array<[string, Record<string, unknown>]> = [
    ['chunked строкой',        { chunked: 'yes' }],
    ['chunkCount строкой',     { chunkCount: '5' }],
    ['chunkCount дробным',     { chunkCount: 2.5 }],
    ['chunkCount отрицательным', { chunkCount: -1 }],
    ['chunkSize строкой',      { chunkSize: '8' }],
    ['fileKey числом',         { fileKey: 7 }],
    ['mime объектом',          { mime: {} }],
  ];

  it.each(CASES)('%s — сообщение отвергается целиком, а не принимается молча', async (_label, bad) => {
    const { sanitizePayload } = await import('@/lib/chatPayloadForm');
    expect(sanitizePayload({ file: { ...BASE, ...bad } })).toBeNull();
  });

  it('годные новые поля проходят и сохраняются', async () => {
    const { sanitizePayload } = await import('@/lib/chatPayloadForm');
    const ok = sanitizePayload({
      file: { ...BASE, fileKey: 'files/x', mime: 'image/png', chunked: true, chunkCount: 3, chunkSize: 8 },
    });
    expect(ok?.file).toEqual({
      ...BASE, fileKey: 'files/x', mime: 'image/png', chunked: true, chunkCount: 3, chunkSize: 8,
    });
  });

  it('старое вложение без новых полей по-прежнему годно', async () => {
    const { sanitizePayload } = await import('@/lib/chatPayloadForm');
    expect(sanitizePayload({ file: { ...BASE } })?.file).toEqual(BASE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Метка сделки: без неё план 4 не соберёт «кусок про эту сделку»
// ═══════════════════════════════════════════════════════════════════════════

describe('метка сделки едет внутри каждого сообщения', () => {
  const DEAL = '0x760F07367888C62f7c2Dfb619A5e534132855ce5' as const;

  /**
   * Читает то, что РЕАЛЬНО уехало в запечатанном, а не то, что подали на вход:
   * перехватывает тела PUT, разбирает кадр и вскрывает конверт ключом
   * ПОЛУЧАТЕЛЯ. Наблюдать возвращённый объект было бы слабее — он собран нами
   * же и о содержимом мешка не свидетельствует.
   */
  function recordPuts(fetchMock: typeof fetch) {
    const bodies: Uint8Array[] = [];
    const wrapped = (async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT' && init.body instanceof Uint8Array) bodies.push(init.body);
      return (fetchMock as unknown as (i: unknown, x?: RequestInit) => Promise<Response>)(input, init);
    }) as unknown as typeof fetch;
    return { bodies, wrapped };
  }

  async function dealIdOnWire(body: Uint8Array, recipient: ChatSession, author: `0x${string}`) {
    const frame = decodeFrame(body)!;
    const payload = await unpackEnvelope(frame.envelope, recipient.keypair, author);
    return payload;
  }

  it('ЗАМЕР: метка стоит на КАЖДОМ пути отправки — и на тексте, и на вложении', async () => {
    // Замер финальной проверки: два комментария утверждали, что метка «едет
    // ВНУТРИ запечатанного каждого сообщения», а НИ ОДИН путь отправки её не
    // ставил. Весь аппарат проверки формы в `chatPayloadForm.ts` был мёртвым
    // кодом.
    //
    // Метка нужна: переписка пары ОДНА на все их сделки (`usePairChat`
    // ключуется только адресом собеседника), а панель сама показывает
    // переключатель, когда сделок больше одной. Значит без метки предъявить
    // арбитру «кусок про эту сделку» (§7 общей спеки) не из чего.
    //
    // Ставится В ДВИЖКЕ, а не в двух обработчиках панели: одно место вместо
    // двух, и третий путь отправки не сможет её забыть.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const { fetchMock } = fakeRelayer({
      bags: [], peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
    });
    const { bodies, wrapped } = recordPuts(fetchMock);
    vi.stubGlobal('fetch', wrapped);

    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      dealId: DEAL,
      onState: () => {}, onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    try {
      await engine.send({ text: 'по сделке' });
      await engine.send({ file: { url: 'u', name: 'n', size: 1, keyHex: 'k', ivHex: 'i' } });
      expect(bodies).toHaveLength(2);
      const asText = await dealIdOnWire(bodies[0], bob, ALICE.toLowerCase() as `0x${string}`);
      const asFile = await dealIdOnWire(bodies[1], bob, ALICE.toLowerCase() as `0x${string}`);
      expect(asText?.dealId?.toLowerCase()).toBe(DEAL.toLowerCase());
      expect(asFile?.dealId?.toLowerCase()).toBe(DEAL.toLowerCase());
      // И содержимое при этом не потеряно.
      expect(asText?.text).toBe('по сделке');
      expect(asFile?.file?.name).toBe('n');
    } finally {
      engine.stop();
    }
  }, 30_000);

  it('без сделки поля НЕТ вовсе, а не есть пустым', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const { fetchMock } = fakeRelayer({
      bags: [], peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
    });
    const { bodies, wrapped } = recordPuts(fetchMock);
    vi.stubGlobal('fetch', wrapped);
    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: () => {}, onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    try {
      await engine.send({ text: 'болтовня без сделки' });
      const payload = await dealIdOnWire(bodies[0], bob, ALICE.toLowerCase() as `0x${string}`);
      expect(payload && 'dealId' in payload).toBe(false);
    } finally {
      engine.stop();
    }
  }, 30_000);

  it('своя метка не перебивает уже поставленную вызывающим', async () => {
    // Движок ДОБАВЛЯЕТ метку, а не переписывает: если вызывающий (план 4,
    // предъявление) собрал payload сам и указал другую сделку — его слово
    // старше.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const other = '0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f' as const;
    const { fetchMock } = fakeRelayer({
      bags: [], peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
    });
    const { bodies, wrapped } = recordPuts(fetchMock);
    vi.stubGlobal('fetch', wrapped);
    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      dealId: DEAL,
      onState: () => {}, onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    try {
      await engine.send({ text: 'по другой', dealId: other });
      const payload = await dealIdOnWire(bodies[0], bob, ALICE.toLowerCase() as `0x${string}`);
      expect(payload?.dealId?.toLowerCase()).toBe(other.toLowerCase());
    } finally {
      engine.stop();
    }
  }, 30_000);
});
