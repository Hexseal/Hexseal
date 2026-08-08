/**
 * chatPassWallet.test.ts — пропуск склада просится У КОШЕЛЬКА, и больше нигде.
 *
 * ─── ПЕРЕВЁРНУТЫЙ ЗАМОК ─────────────────────────────────────────────────────
 *
 * 8 августа 2026 здесь стоял противоположный файл: он мерил, что окон кошелька
 * НОЛЬ, потому что пропуск подписывался самим ключом переписки. Дорога работала
 * (1 → 0 окон на заход) и **откачена решением владельца**: это развилка
 * архитектуры, а не мелочь. Дословно: «хочется и ux хороший, и не хочется дыры,
 * тем более подобной, где раз прорвался и всё читаешь».
 *
 * Файл оставлен и перевёрнут по прямому указанию координатора: «пусть тесты
 * сторожат, что подпись пропуска идёт кошельком. Иначе следующий, кто захочет
 * удобства, снимет это молча».
 *
 * Что заперто:
 *   1. пропуск берётся подписью КОШЕЛЬКА — ровно одно окно на холодный кэш;
 *   2. никакой второй дороги в запросе нет (`x-key-sig` не уезжает никогда);
 *   3. живой пропуск подписи не просит — то, что и раньше держало число окон
 *      на одном в 12 часов, а не на одном на тик.
 *
 * ⚠️ ПОЧЕМУ ОДНО ОКНО, А НЕ НОЛЬ, — не недоделка. Разбор в шапке `POST
 * /bags/pass` (`relayer/app.js`): подпись, из которой выводится ключ переписки,
 * И ЕСТЬ ключ, показать её серверу нельзя; а пропуск, выданный без доказательства
 * владения адресом, открыл бы захват чужой строки в справочнике.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import { requestBagPass, _resetBagPassCacheForTest } from '@/lib/chatTransport';
import type { ChatSession } from '@/lib/chatSession';

const ALICE = '0xa1ce00000000000000000000000000000000cafe' as const;

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}

async function makeSession(): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig('a')),
    address: ALICE, origin: 'signature', walletKind: 'eoa', restored: false, persisted: true,
  };
}

interface Server {
  /** Каждый POST /bags/pass: какие заголовки принесли. */
  calls: { ts: string; walletSig?: string; keySig?: string; address: string }[];
  /** Сколько раз открывали окно кошелька. */
  walletPrompts: number;
}

let server: Server;
let session: ChatSession;

function stubServer(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname !== '/bags/pass') return new Response('{}', { status: 404 });
    const h = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { address: string };
    const keySig = h.get('x-key-sig') ?? undefined;
    const walletSig = h.get('x-sig') ?? undefined;
    server.calls.push({
      ts: h.get('x-ts') ?? '', address: body.address,
      ...(walletSig ? { walletSig } : {}), ...(keySig ? { keySig } : {}),
    });
    // Сервер, как и настоящий, принимает ТОЛЬКО кошельковую подпись.
    if (!walletSig) {
      return new Response(
        JSON.stringify({ error: 'Missing x-ts or x-sig header', code: 'missing_credentials' }),
        { status: 401 },
      );
    }
    return new Response(
      JSON.stringify({ pass: 'v1.by-wallet.mac', expiresAt: Math.floor(Date.now() / 1000) + 43_200 }),
      { status: 200 },
    );
  }));
}

function walletSigner(): (msg: string) => Promise<string> {
  return async () => { server.walletPrompts++; return sig('b'); };
}

beforeEach(async () => {
  _resetBagPassCacheForTest();
  server = { calls: [], walletPrompts: 0 };
  session = await makeSession();
  stubServer();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('ЗАМЕР: окон кошелька за заход', () => {
  it('холодный кэш — РОВНО ОДНО окно, и пропуск получен', async () => {
    const pass = await requestBagPass(walletSigner(), ALICE);
    expect(server.walletPrompts).toBe(1);
    expect(pass.pass).toBe('v1.by-wallet.mac');
    expect(server.calls).toHaveLength(1);
  });

  it('второй дороги в запросе НЕТ: `x-key-sig` не уезжает никогда', async () => {
    // ⚠️ ГЛАВНЫЙ ЗАМОК ФАЙЛА. Что красит: возврат ключевой дороги на клиенте.
    // Сторожит употребление, а не текст: заголовок либо есть в запросе, либо нет.
    await requestBagPass(walletSigner(), ALICE);
    for (const call of server.calls) {
      expect(call.keySig, 'клиент снова подписывает пропуск ключом переписки').toBeUndefined();
      expect(call.walletSig).toBeDefined();
    }
  });

  it('ключевую дорогу НЕЛЬЗЯ включить снаружи — даже подсунув подписывающего', async () => {
    // ⚠️ ЭТО И ЕСТЬ ЗАМОК НА ОТКАТ, и он мерит УПОТРЕБЛЕНИЕ, а не имя.
    //
    // Первая версия этого файла просто не передавала ключевого подписывающего —
    // и была зелёной ДО отката, то есть не сторожила ничего. Замерено: 8 из 8
    // зелёных на коде, который ключевую дорогу ещё имел.
    //
    // Здесь ключевой подписывающий подсовывается НАСИЛЬНО, через приведение
    // типа: так замок продолжает компилироваться и после того, как параметр из
    // подписи функции исчез, и продолжает мерить поведение. Если дорога
    // вернётся — окон кошелька станет ноль, а в запросе появится `x-key-sig`,
    // и обе строки ниже покраснеют.
    const forced = requestBagPass as unknown as (
      signMessage: (m: string) => Promise<string>,
      address: string,
      opts?: { signWithChatKey?: (m: string) => Promise<string> },
    ) => Promise<{ pass: string }>;

    const { signChallengeWithLinkKey } = await import('@/lib/chatConversation')
      .then(m => m as unknown as { signChallengeWithLinkKey?: (k: unknown, m: string) => Promise<string> });

    const pass = await forced(walletSigner(), ALICE, {
      // Если функция вывода подписи ещё существует — берём её; если её уже
      // снесли вместе с дорогой, подсовываем заведомо годную по форме подпись.
      signWithChatKey: signChallengeWithLinkKey
        ? (m: string) => signChallengeWithLinkKey(session.keypair, m)
        : async () => '0x' + 'ab'.repeat(64),
    });

    expect(server.walletPrompts, 'ключевая дорога вернулась: кошелёк не спросили').toBe(1);
    expect(pass.pass).toBe('v1.by-wallet.mac');
    for (const call of server.calls) expect(call.keySig).toBeUndefined();
  });

  it('живой пропуск — ни одного запроса и ни одной подписи', async () => {
    await requestBagPass(walletSigner(), ALICE);
    const before = server.calls.length;
    const promptsBefore = server.walletPrompts;
    await requestBagPass(walletSigner(), ALICE);
    expect(server.calls.length).toBe(before);
    expect(server.walletPrompts).toBe(promptsBefore);
  });

  it('два одновременных вызова — один запрос и одно окно, не два', async () => {
    // Дедуп в полёте существует против ДВУХ окон кошелька сразу: второй
    // одновременный запрос прилетает в кошелёк как `-32002`, и в мобильном
    // MetaMask его нечем отменить.
    const [a, b] = await Promise.all([
      requestBagPass(walletSigner(), ALICE),
      requestBagPass(walletSigner(), ALICE),
    ]);
    expect(a.pass).toBe(b.pass);
    expect(server.calls).toHaveLength(1);
    expect(server.walletPrompts).toBe(1);
  });
});

describe('подписывается ровно то, что проверит сервер', () => {
  it('фраза — `hexseal:chat-bags:<адрес>:<время>`, буква в букву', async () => {
    let signed = '';
    await requestBagPass(async (m) => { signed = m; server.walletPrompts++; return sig('b'); }, ALICE);
    const call = server.calls[0];
    expect(signed).toBe(`hexseal:chat-bags:${ALICE}:${call.ts}`);
  });
});

/* ─────────── проводка: getBagPass открывает окно и говорит об этом ─────────── */

/* ⚠️ ВЕЗДЕ НИЖЕ `purpose: 'announce'`, И ЭТО НЕ ОСЛАБЛЕНИЕ ЗАМКА.
 * У пропуска два назначения. Пропуск РАДИ ЯЩИКА `getBagPass` теперь отказывает
 * сама, пока свой ключ не объявлен в справочнике: запечатать нам нельзя ничего,
 * значит на складе для нас нет ни одного мешка и подписывать нечего (требование
 * «ноль запросов пропуска», замер — `hooks/chatAnnounceStore.test.ts`).
 * Пропуск РАДИ ОБЪЯВЛЕНИЯ этим порогом не отсекается — иначе вышло бы кольцо.
 * Замки ниже про ОКНО КОШЕЛЬКА и про мьютекс, а до окна доходит именно этот
 * вызов; оставив умолчание, они мерили бы отказ порога, а не то, ради чего
 * заведены. */
describe('getBagPass: единственное место подписи в чате', () => {
  it('окно кошелька открывается, и наверх об этом сообщают', async () => {
    // `onSigning` — единственный честный способ для отображения узнать, что
    // окно кошелька открыто ПРЯМО СЕЙЧАС. Он и есть то, чем панель и список
    // показывают «Подтвердите подпись в кошельке» в центре экрана. Без замера
    // на него признак мог бы перестать взводиться, и экран вернулся бы к
    // молчаливому спиннеру — то есть к тому, с чего человек ушёл 8 августа.
    const { getBagPass } = await import('@/hooks/useChatSession');
    const busy: boolean[] = [];
    const pass = await getBagPass(
      ALICE,
      async () => { server.walletPrompts++; return sig('b'); },
      (b) => { busy.push(b); },
      { purpose: 'announce' },
    );
    expect(pass).toBe('v1.by-wallet.mac');
    expect(server.walletPrompts).toBe(1);
    expect(busy).toEqual([true, false]);
  });

  it('сеанс, подсунутый четвёртым аргументом, окно не отменяет', async () => {
    // Тот же приём, что выше, на уровень выше: `getBagPass` — единственное
    // место подписи в чате, и откат обязан быть полным именно здесь. Приведение
    // типа держит замок живым после того, как параметр сеанса из подписи ушёл.
    const { getBagPass } = await import('@/hooks/useChatSession');
    const forced = getBagPass as unknown as (
      address: string,
      signMessageAsync: (a: { message: string }) => Promise<string>,
      onSigning?: (b: boolean) => void,
      session?: unknown,
    ) => Promise<string>;

    // ⚠️ Сеанс подсовывается ЧЕТВЁРТЫМ аргументом — там же, где теперь живут
    // `humanAsked`/`purpose`. Поэтому назначение уезжает вместе с ним: замок
    // продолжает мерить, что окно кошелька всё равно открывается.
    const pass = await forced(
      ALICE, async () => { server.walletPrompts++; return sig('b'); }, undefined,
      { purpose: 'announce', session } as unknown,
    );
    expect(server.walletPrompts, 'сеанс снова отменяет окно кошелька').toBe(1);
    expect(pass).toBe('v1.by-wallet.mac');
    for (const call of server.calls) expect(call.keySig).toBeUndefined();
  });

  it('на живом пропуске окно не открывается и признак не взводится', async () => {
    const { getBagPass } = await import('@/hooks/useChatSession');
    await getBagPass(ALICE, async () => { server.walletPrompts++; return sig('b'); }, undefined, { purpose: 'announce' });
    const busy: boolean[] = [];
    await getBagPass(ALICE, async () => { server.walletPrompts++; return sig('b'); }, (b) => busy.push(b), { purpose: 'announce' });
    expect(server.walletPrompts).toBe(1);
    expect(busy).toEqual([]);
  });
});
