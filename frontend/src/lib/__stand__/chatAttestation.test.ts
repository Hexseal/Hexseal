/**
 * chatAttestation.test.ts — заверение доезжает до НАСТОЯЩЕГО справочника
 * (`relayer/app.js` на стенде), с настоящим пропуском по настоящей подписи.
 *
 * ⚠️ ЗАЧЕМ СТЕНД, А НЕ ПОДДЕЛКА FETCH. Ровно тот класс промаха, который в этом
 * проекте ловили трижды за сутки: правка, которая не может подействовать.
 * Маршрут `POST /keys` мог бы молча выбрасывать новое поле, а замки на клиенте
 * и замки на сервере при этом оба зеленели бы — каждый проверяет свою
 * половину. Здесь проверяется дорога целиком.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startChatStand } from './chatStand';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_RELAYER_URL;
});

function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    clear: () => map.clear(),
  };
  return map;
}

async function boot() {
  const stand = await startChatStand();
  try {
    process.env.NEXT_PUBLIC_RELAYER_URL = stand.url;
    vi.resetModules();
    installStorage();

    const [wallet] = stand.wallets;
    const address = wallet.address as `0x${string}`;

    const { deriveChatKeypair } = await import('../chatCrypto');
    const chatSession = await import('../../hooks/useChatSession');
    const attestation = await import('../chatKeyAttestation');
    const gate = await import('../chatSignatureGate');
    gate._resetSignatureGateForTest();

    const keySig = await wallet.signMessage('форма подписи та же, что у кошелька');
    const session = {
      keypair: await deriveChatKeypair(keySig as `0x${string}`),
      address, origin: 'signature' as const, walletKind: 'eoa' as const,
      restored: false, persisted: true,
    };

    // Кошелёк стенда — ethers; `signTypedData` у него есть, имя другое.
    const walletClient = {
      account: { address },
      signTypedData: (args: { domain: unknown; types: unknown; primaryType: string; message: unknown }) =>
        wallet.signTypedData(
          args.domain as never,
          { [args.primaryType]: (args.types as Record<string, unknown>)[args.primaryType] } as never,
          args.message as never,
        ),
    } as never;

    const realFetch = globalThis.fetch;
    const pass = await chatSession.getBagPass(
      address, (m) => wallet.signMessage(m.message), undefined,
      { humanAsked: true, purpose: 'announce' as const },
    );

    return {
      stand, address, session, walletClient, pass, chatSession, attestation, realFetch,
      async record(): Promise<Record<string, unknown>> {
        const res = await realFetch(`${stand.url}/keys/${address.toLowerCase()}`);
        return res.ok ? (await res.json() as Record<string, unknown>) : { status: res.status };
      },
    };
  } catch (e) {
    await stand.stop();
    throw e;
  }
}

describe('ЗАМЕР: заверение проезжает до настоящего справочника', () => {
  // ⚠️ Таймаут поднят с умолчания (5000мс): S1 делает ДВА полных круга
  // publishChatKeys/fetchPeerChatKeys плюс настоящую EIP-712-подпись поверх
  // настоящего HTTP-сервера стенда — замерено живьём: 2,3с в одиночном
  // прогоне, 8,1с под нагрузкой полного набора (тот же класс дрожи по
  // времени, что у chatSession.test.ts, см. план). 15000 — тот же запас, что
  // relayer/vitest.config.js уже даёт интеграционным тестам с настоящим HTTP.
  it('S1 объявили ключ, ПОТОМ заверили — справочник отдаёт заверение, вердикт ok', async () => {
    const env = await boot();
    try {
      // Порядок как в жизни: сначала объявление (без заверения — его ещё нет),
      // потом человек нажал «заверить», потом объявление повторяется.
      await env.chatSession.publishChatKeys(env.pass, env.session);
      expect((await env.record()).attestation, 'заверения ещё не было, а оно есть').toBeUndefined();

      // ⚠️ Так выглядит ПЕРВЫЙ ДЕНЬ: настоящий сервер поля не отдаёт вовсе, и
      // вердикт обязан быть `absent` — «заверения нет», а не «пришёл мусор».
      // Замер идёт по НАСТОЯЩЕМУ ответу сервера, а не по подставленному
      // `undefined`: именно на стыке такое и терялось.
      expect(await env.attestation.verifyChatKeyAttestation((await env.record()).attestation))
        .toBe('absent');
      const peerBefore = await env.chatSession.fetchPeerChatKeys(env.address);
      expect(peerBefore.attestation).toBeNull();
      expect(await env.attestation.verifyChatKeyAttestation(peerBefore.attestation)).toBe('absent');

      const att = await env.attestation.ensureChatKeyAttestation(env.walletClient, env.session);
      await env.chatSession.publishChatKeys(env.pass, env.session);

      const stored = (await env.record()).attestation;
      expect(stored, 'заверение не доехало до справочника').toEqual(att);

      // И читается тем путём, которым его возьмёт читалка арбитра.
      const keys = await env.chatSession.fetchPeerChatKeys(env.address);
      expect(keys.attestation).toEqual(att);
      expect(await env.attestation.verifyChatKeyAttestation(keys.attestation)).toBe('ok');
    } finally {
      await env.stand.stop();
    }
  }, 15000);

  // Тот же запас времени, что у S1, той же причиной — настоящий HTTP-сервер
  // стенда плюс настоящая криптография, не голая подделка fetch.
  it('S2 сервер подменил ключ в ответе — wrong_address, а не ok', async () => {
    const env = await boot();
    try {
      const att = await env.attestation.ensureChatKeyAttestation(env.walletClient, env.session);
      await env.chatSession.publishChatKeys(env.pass, env.session);

      // Злой справочник: тот же ответ, но с подменённым boxKey. Ровно то, чего
      // мы боимся от собственного сервера (§15.2).
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        const res = await env.realFetch(url as string, init);
        if (!String(url).includes('/keys/')) return res;
        const body = await res.json() as Record<string, unknown>;
        const evil = { ...body, attestation: { ...(body.attestation as object), boxKey: '0x' + 'cc'.repeat(32) } };
        return new Response(JSON.stringify(evil), { status: 200, headers: { 'content-type': 'application/json' } });
      }));

      const keys = await env.chatSession.fetchPeerChatKeys(env.address);
      expect(await env.attestation.verifyChatKeyAttestation(keys.attestation)).toBe('wrong_address');
      // Честный ответ на тех же данных давал ok — значит разница в подмене, а
      // не в нашем коде.
      expect(await env.attestation.verifyChatKeyAttestation(att)).toBe('ok');
    } finally {
      await env.stand.stop();
    }
  }, 15000);
});
