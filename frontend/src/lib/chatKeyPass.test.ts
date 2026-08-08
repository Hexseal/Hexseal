/**
 * chatKeyPass.test.ts — сколько окон кошелька стоит один заход в чат.
 *
 * Живая выкатка 8 августа (пункт 35 `docs/OPEN-ITEMS.md`), дословно:
 * «оба просят вечное подключение/подпись». Подписей было две, и вторая — та,
 * что берёт пропуск к складу, — не нужна: как только адрес объявил свою
 * открытую половину подписного ключа в справочнике, владение адресом
 * доказывается ЭТИМ ключом, молча.
 *
 * Замер здесь — ЧИСЛО ВЫЗОВОВ КОШЕЛЬКА, а не наличие кода. Мутация «не звать
 * ключевую подпись вовсе» обязана поднять это число, иначе замок сторожит
 * текст.
 *
 * Первый вход в жизни адреса остаётся с подписью кошелька, и это не недоделка:
 * `POST /keys` берёт адрес ИЗ ПРОПУСКА, значит пропуск, выданный без
 * доказательства владения адресом, дал бы кому угодно занять чужую строку в
 * справочнике. Корень доверия обязан быть в кошельке — тогда и только тогда
 * ключевая подпись что-то значит.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import { deriveLinkSigningKeypair, signChallengeWithLinkKey } from '@/lib/chatConversation';
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
  /** Каждый POST /bags/pass: что именно принесли. */
  calls: { ts: string; walletSig?: string; keySig?: string; address: string }[];
  /** Сколько раз открывали окно кошелька. */
  walletPrompts: number;
  /** Ключ объявлен в справочнике — сервер принимает ключевую подпись. */
  enrolled: boolean;
  /** Ответ на ключевую дорогу вместо нормального: {status, body}. */
  keyPathFailure?: { status: number; body: Record<string, unknown> };
}

let server: Server;

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
    if (walletSig) {
      return new Response(
        JSON.stringify({ pass: 'v1.by-wallet.mac', expiresAt: Math.floor(Date.now() / 1000) + 43_200 }),
        { status: 200 },
      );
    }
    if (server.keyPathFailure) {
      return new Response(JSON.stringify(server.keyPathFailure.body), { status: server.keyPathFailure.status });
    }
    if (!server.enrolled) {
      return new Response(
        JSON.stringify({ error: 'No chat signing key on file', code: 'key_not_enrolled' }),
        { status: 401 },
      );
    }
    return new Response(
      JSON.stringify({ pass: 'v1.by-key.mac', expiresAt: Math.floor(Date.now() / 1000) + 43_200 }),
      { status: 200 },
    );
  }));
}

let session: ChatSession;

beforeEach(async () => {
  _resetBagPassCacheForTest();
  server = { calls: [], walletPrompts: 0, enrolled: true };
  session = await makeSession();
  stubServer();
});

afterEach(() => { vi.unstubAllGlobals(); });

function walletSigner(): (msg: string) => Promise<string> {
  return async () => { server.walletPrompts++; return sig('b'); };
}

function chatKeySigner(): (msg: string) => Promise<string> {
  return (msg) => signChallengeWithLinkKey(session.keypair, msg);
}

describe('ЗАМЕР: окон кошелька за заход', () => {
  it('ключ объявлен — НОЛЬ окон кошелька', async () => {
    // Что красит: клиент снова идёт кошельковой дорогой. Число подскочит с
    // нуля до единицы, и в установленном приложении это круг на минуты.
    const pass = await requestBagPass(walletSigner(), ALICE, {
      signWithChatKey: chatKeySigner(),
    });
    expect(server.walletPrompts).toBe(0);
    expect(pass.pass).toBe('v1.by-key.mac');
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].keySig).toBeDefined();
    expect(server.calls[0].walletSig).toBeUndefined();
  });

  it('ключ ещё не объявлен — РОВНО ОДНО окно, и пропуск всё равно получен', async () => {
    // Первый вход в жизни адреса. Откат обязан быть: без него человек с чистым
    // справочником не получил бы пропуска вовсе, то есть чат не заводился бы
    // никогда — «своя починка хуже дефекта» в чистом виде.
    server.enrolled = false;
    const pass = await requestBagPass(walletSigner(), ALICE, {
      signWithChatKey: chatKeySigner(),
    });
    expect(server.walletPrompts).toBe(1);
    expect(pass.pass).toBe('v1.by-wallet.mac');
    // Две попытки: сначала молча ключом, потом кошельком.
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0].keySig).toBeDefined();
    expect(server.calls[1].walletSig).toBeDefined();
  });

  it('отказ ключевой дороги НЕ по «ключа нет» — кошелёк не открывается', async () => {
    // ⚠️ ЭТУ ДЫРУ НАШЛА МУТАЦИЯ, а не рассуждение: «откатываться на любой отказ»
    // проходило зелёным на 94 тестах. Цена — своя починка хуже дефекта: моргнула
    // сеть, сервер ответил 429 или 500 — и человек получает окно кошелька по
    // случайному поводу, ровно от чего эта правка уходит. Кошелёк нужен ТОЛЬКО
    // когда сервер сказал «ключа за этим адресом нет».
    for (const failure of [
      { status: 429, body: { error: 'Rate limit exceeded', code: 'rate_limited_pass' } },
      { status: 500, body: { error: 'boom', code: 'internal_error' } },
      { status: 401, body: { error: 'Invalid signature', code: 'invalid_signature' } },
      { status: 503, body: { error: 'directory down', code: 'directory_unavailable' } },
    ]) {
      _resetBagPassCacheForTest();
      server.calls = [];
      server.walletPrompts = 0;
      server.keyPathFailure = failure;
      await expect(requestBagPass(walletSigner(), ALICE, { signWithChatKey: chatKeySigner() }))
        .rejects.toThrow();
      expect(server.walletPrompts, `status ${failure.status}`).toBe(0);
      expect(server.calls, `status ${failure.status}`).toHaveLength(1);
    }
    server.keyPathFailure = undefined;
  });

  it('ключа на устройстве нет — кошельковая дорога, ключевую даже не пробуем', async () => {
    const pass = await requestBagPass(walletSigner(), ALICE);
    expect(server.walletPrompts).toBe(1);
    expect(pass.pass).toBe('v1.by-wallet.mac');
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].keySig).toBeUndefined();
  });

  it('живой пропуск — ни одного запроса и ни одной подписи вообще', async () => {
    await requestBagPass(walletSigner(), ALICE, { signWithChatKey: chatKeySigner() });
    const before = server.calls.length;
    await requestBagPass(walletSigner(), ALICE, { signWithChatKey: chatKeySigner() });
    expect(server.calls.length).toBe(before);
    expect(server.walletPrompts).toBe(0);
  });

  it('два одновременных вызова — один запрос, не два', async () => {
    // Дедуп в полёте существовал против ДВУХ окон кошелька сразу; ключевая
    // дорога не имеет права его отменить.
    const [a, b] = await Promise.all([
      requestBagPass(walletSigner(), ALICE, { signWithChatKey: chatKeySigner() }),
      requestBagPass(walletSigner(), ALICE, { signWithChatKey: chatKeySigner() }),
    ]);
    expect(a.pass).toBe(b.pass);
    expect(server.calls).toHaveLength(1);
  });
});

describe('подписывается ровно то, что проверит сервер', () => {
  it('фраза — та же, что у кошельковой дороги, и подпись сходится ключом из справочника', async () => {
    // Что красит: подпись не по той фразе или не тем ключом. Сервер её отвергнет,
    // человек получит окно кошелька — то есть правка молча выродится в прежнее
    // поведение, и без этого замка это выглядело бы как «работает».
    await requestBagPass(walletSigner(), ALICE, { signWithChatKey: chatKeySigner() });
    const call = server.calls[0];
    const message = `hexseal:chat-bags:${ALICE}:${call.ts}`;

    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const signer = await deriveLinkSigningKeypair(session.keypair);
    const raw = Uint8Array.from(
      (call.keySig as string).slice(2).match(/../g)!.map(h => parseInt(h, 16)),
    );
    expect(raw.length).toBe(64);
    expect(sodium.crypto_sign_verify_detached(
      raw, new TextEncoder().encode(message), signer.publicKey,
    )).toBe(true);
  });

  it('подписная метка звена и фраза пропуска не пересекаются ни одним префиксом', async () => {
    // ⚠️ Один и тот же ключ теперь подписывает ДВА разных вида байтов: звенья
    // цепочки и вызов склада. Значит нужен разбор, может ли одно быть принято за
    // другое. Звено подписывается с меткой `hexseal.chat.link.sig.v1` (точки),
    // вызов — фразой `hexseal:chat-bags:` (двоеточия). Ни одна не является
    // префиксом другой, то есть подпись вызова не может быть предъявлена как
    // подпись звена и наоборот.
    const { LINK_SIGNATURE_DOMAIN } = await import('@/lib/chatConversation');
    const challengePrefix = 'hexseal:chat-bags:';
    expect(LINK_SIGNATURE_DOMAIN.startsWith(challengePrefix)).toBe(false);
    expect(challengePrefix.startsWith(LINK_SIGNATURE_DOMAIN)).toBe(false);
  });
});


/* ─────────── проводка: сеанс реально доезжает до транспорта ─────────── */

describe('getBagPass: сеанс доезжает до транспорта, а не остаётся возможностью', () => {
  it('с сеансом — ноль окон кошелька; без сеанса — одно', async () => {
    // ⚠️ ЗАЧЕМ ОТДЕЛЬНО ОТ ЗАМЕРОВ ВЫШЕ. Те мерят `requestBagPass`, то есть
    // умение. Здесь мерится УПОТРЕБЛЕНИЕ: `getBagPass` — единственное место
    // чата, откуда берётся пропуск, и если сеанс до него не доедет, ключевая
    // дорога останется мёртвым кодом при зелёных тестах. Ровно тот класс
    // промаха, который в этом проекте назван «правка, которая не может
    // подействовать».
    const { getBagPass } = await import('@/hooks/useChatSession');

    const withSession = await getBagPass(
      ALICE, async () => { server.walletPrompts++; return sig('b'); }, undefined, session,
    );
    expect(server.walletPrompts).toBe(0);
    expect(withSession).toBe('v1.by-key.mac');

    _resetBagPassCacheForTest();
    server.calls = [];
    const withoutSession = await getBagPass(
      ALICE, async () => { server.walletPrompts++; return sig('b'); }, undefined, null,
    );
    expect(server.walletPrompts).toBe(1);
    expect(withoutSession).toBe('v1.by-wallet.mac');
  });
});
