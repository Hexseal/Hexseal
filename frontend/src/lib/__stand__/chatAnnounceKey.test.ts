/**
 * chatAnnounceKey.test.ts — «ключ есть, но не объявлен»: опознать и вылечить.
 *
 * ─── ЧТО ЭТО ЗА СОСТОЯНИЕ ───────────────────────────────────────────────────
 *
 * Ключ переписки выводится из первой подписи и ложится в хранилище устройства.
 * Объявить его в справочнике (`POST /keys`) можно ТОЛЬКО пропуском — сервер
 * берёт адрес из пропуска, а не из тела запроса. Пропуск — вторая подпись.
 *
 * Значит между двумя подписями есть промежуток, в котором ключ существует, а
 * никто про него не знает. В этом промежутке:
 *
 *   - собеседник не может запечатать сообщение на наш ключ (его нет в
 *     справочнике) — то есть НАМ НЕЛЬЗЯ НАПИСАТЬ ВООБЩЕ;
 *   - человек при этом видит обычный чат и думает, что настроился.
 *
 * Это тихая поломка. Живой замер 8 августа: `castW2` (установленное приложение
 * владельца) — КЛЮЧА НЕТ, при том что подпись ключа прошла.
 *
 * ─── ЗАМЕР НА НАСТОЯЩЕМ СЕРВЕРЕ, А НЕ НА ПОДДЕЛКЕ ───────────────────────────
 *
 * Справочник здесь настоящий (`relayer/app.js` на стенде), кошельки настоящие
 * (`ethers.Wallet`), пропуск выдаётся по настоящей подписи. Подделана только
 * страница — ей надо уметь засыпать, а `document` в узле нет.
 *
 * Требование 3 задания дословно: «Нажатие кнопки доводит дело до конца — ключ
 * объявлен в справочнике. Замер: запись появилась». Поэтому проверяется не
 * «функция вызвана», а `GET /keys/<свой адрес>` после нажатия.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startChatStand } from './chatStand';

/* ──────────────────── подделка страницы: она умеет засыпать ────────────────── */

interface FakePage {
  visibilityState: 'visible' | 'hidden';
  listeners: Set<() => void>;
  addEventListener: (t: string, fn: () => void) => void;
  removeEventListener: (t: string, fn: () => void) => void;
  goAway: () => void;
  comeBack: () => void;
}

function fakePage(): FakePage {
  const page: FakePage = {
    visibilityState: 'visible',
    listeners: new Set(),
    addEventListener: (t, fn) => { if (t === 'visibilitychange') page.listeners.add(fn); },
    removeEventListener: (_t, fn) => { page.listeners.delete(fn); },
    goAway() { page.visibilityState = 'hidden'; for (const fn of page.listeners) fn(); },
    comeBack() { page.visibilityState = 'visible'; for (const fn of page.listeners) fn(); },
  };
  return page;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_RELAYER_URL;
});

/**
 * Всё, что нужно одному замеру: живой стенд, свежие модули, спящая страница.
 *
 * ⚠️ ЛЮБОЙ отказ на пути сборки останавливает стенд и только потом бросает.
 * Без этого первый же красный замер (например, нужного модуля ещё нет) оставлял
 * стенд поднятым, гейт «один стенд на процесс» запирался, и ВСЕ следующие замеры
 * падали с «already running» — то есть один настоящий отказ прятал за собой
 * четыре чужих, и красное перестало бы означать то, что означает.
 */
async function boot() {
  const stand = await startChatStand();
  try {
    return await bootOn(stand);
  } catch (e) {
    await stand.stop();
    throw e;
  }
}

async function bootOn(stand: Awaited<ReturnType<typeof startChatStand>>) {
  process.env.NEXT_PUBLIC_RELAYER_URL = stand.url;
  vi.resetModules();
  const page = fakePage();
  vi.stubGlobal('document', page);

  const [wallet] = stand.wallets;
  const address = wallet.address as `0x${string}`;

  const { deriveChatKeypair } = await import('../chatCrypto');
  const chatSession = await import('../../hooks/useChatSession');
  const announce = await import('../chatAnnounce');
  const gate = await import('../chatSignatureGate');
  gate._resetSignatureGateForTest();

  // Ключ выводится из подписи кошелька, ровно как в приложении.
  const keySig = await wallet.signMessage('любая фраза — форма подписи та же');
  const session = {
    keypair: await deriveChatKeypair(keySig as `0x${string}`),
    address, origin: 'signature' as const, walletKind: 'eoa' as const,
    restored: false, persisted: true,
  };

  let walletPrompts = 0;
  let passRequests = 0;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('/bags/pass')) passRequests++;
    return realFetch(url as string, init);
  }));

  /** Кошелёк-приложение: открывая окно, уводит страницу из глаз. */
  const phoneSigner = async ({ message }: { message: string }) => {
    walletPrompts++;
    page.goAway();
    const sig = await wallet.signMessage(message);
    page.comeBack();
    return sig;
  };

  return {
    stand, page, address, session, announce, chatSession, gate,
    counters: () => ({ walletPrompts, passRequests }),
    phoneSigner,
    /** Что справочник СЕЙЧАС знает про наш адрес — прямым запросом, не через наш код. */
    async directoryRecord(): Promise<{ status: number; boxKey?: string }> {
      const res = await realFetch(`${stand.url}/keys/${address.toLowerCase()}`);
      if (!res.ok) return { status: res.status };
      const body = await res.json() as { boxKey?: string };
      return { status: res.status, boxKey: body.boxKey };
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('ЗАМЕР: ключ на устройстве, но не объявлен', () => {
  it('состояние опознано БЕЗ пропуска — справочник читается открыто', async () => {
    // Требование 2 задания: «При открытии чата надо проверять, объявлен ли свой
    // ключ (справочник читается без пропуска — замерено)». Здесь этот замер и
    // стоит: ноль подписей, ноль запросов пропуска, а состояние названо.
    const env = await boot();
    try {
      const standing = await env.announce.readOwnStanding(
        env.address, env.session.keypair.publicKey, env.chatSession.fetchPeerChatKeys,
      );

      expect(standing, 'своего ключа в справочнике нет — это и есть состояние').toBe('absent');
      expect(env.counters().walletPrompts, 'опознание состояния стоило окна кошелька').toBe(0);
      expect(env.counters().passRequests, 'опознание состояния стоило пропуска').toBe(0);
      expect((await env.directoryRecord()).status).toBe(404);
    } finally {
      await env.stand.stop();
    }
  });

  it('нажатие доводит до конца: ЗАПИСЬ ПОЯВИЛАСЬ в справочнике', async () => {
    // Требование 3 задания. Мерится запись в настоящем справочнике, а не факт
    // вызова функции.
    const env = await boot();
    try {
      await env.announce.announceOwnKey({
        address: env.address,
        session: env.session,
        humanAsked: true,
        getPass: (opts) => env.chatSession.getBagPass(env.address, env.phoneSigner, undefined, opts),
        publish: env.chatSession.publishChatKeys,
      });

      const record = await env.directoryRecord();
      expect(record.status, 'записи в справочнике так и нет').toBe(200);
      // Ровно НАШ ключ, а не какой-нибудь: иначе запись есть, а писать нам
      // по-прежнему некуда.
      const expected = '0x' + [...env.session.keypair.publicKey]
        .map(b => b.toString(16).padStart(2, '0')).join('');
      expect(record.boxKey).toBe(expected);
      expect(env.counters().walletPrompts, 'нажатие обошлось не одной подписью').toBe(1);

      const standing = await env.announce.readOwnStanding(
        env.address, env.session.keypair.publicKey, env.chatSession.fetchPeerChatKeys,
      );
      expect(standing, 'состояние не вылечилось').toBe('mine');
    } finally {
      await env.stand.stop();
    }
  });

  it('без нажатия, после ухода к кошельку — НОЛЬ запросов пропуска', async () => {
    // Требование 5 задания в том виде, в котором оно безопасно (разбор — в
    // отчёте): пока СВОЙ ключ не объявлен, запечатать нам сообщение НЕЛЬЗЯ,
    // значит забирать со склада нечего и пропуск не нужен.
    const env = await boot();
    try {
      // Первая подпись увела страницу в кошелёк — ровно как на телефоне.
      await env.chatSession.signChatKeyLocked(env.address, async () => {
        env.page.goAway();
        env.page.comeBack();
        return ('0x' + 'ab'.repeat(65)) as `0x${string}`;
      });

      await expect(env.announce.announceOwnKey({
        address: env.address,
        session: env.session,
        humanAsked: false,
        getPass: (opts) => env.chatSession.getBagPass(env.address, env.phoneSigner, undefined, opts),
        publish: env.chatSession.publishChatKeys,
      })).rejects.toSatisfy((e: unknown) => env.gate.isSignatureDeferred(e));

      expect(env.counters().walletPrompts, 'подпись ушла сама, без нажатия').toBe(0);
      expect(env.counters().passRequests, 'пропуск попросили, хотя объявлять ещё нечем').toBe(0);
      expect((await env.directoryRecord()).status).toBe(404);
    } finally {
      await env.stand.stop();
    }
  });

  it('десктоп: объявление проходит САМО, без нажатия и без кнопки', async () => {
    // Требование 6 задания. Отличие от замера выше — ровно одно: страница не
    // пропадала из глаз.
    const env = await boot();
    try {
      const [wallet] = env.stand.wallets;
      await env.announce.announceOwnKey({
        address: env.address,
        session: env.session,
        humanAsked: false,
        getPass: (opts) => env.chatSession.getBagPass(
          env.address, async ({ message }) => wallet.signMessage(message), undefined, opts,
        ),
        publish: env.chatSession.publishChatKeys,
      });

      expect((await env.directoryRecord()).status, 'на десктопе объявление перестало проходить само').toBe(200);
      expect(env.counters().passRequests).toBe(1);
    } finally {
      await env.stand.stop();
    }
  });
});

/* ═══════════ почему отсрочка ПО СОБЕСЕДНИКУ была бы потерей сообщений ═══════ */

describe('ЗАМЕР: пропуск по отсутствию СОБЕСЕДНИКА отложить нельзя', () => {
  it('собеседник ключа не объявил — и всё равно прислал мешок', async () => {
    // ⚠️ ЭТО ОПРОВЕРЖЕНИЕ ПОСЫЛКИ ЗАДАНИЯ, и оно замером, а не рассуждением.
    //
    // Задание допускает: «Если собеседник ключа не объявил — забирать нечего».
    // На настоящем сервере это НЕ ТАК. Чтобы отправить, нужны: наш открытый ключ
    // (он в справочнике, читается открыто) и СВОЙ пропуск (подпись своего
    // кошелька). Своего ключа в справочнике для этого не требуется нигде.
    //
    // Значит собеседник, не объявивший ключа, отправить может — и, отложив
    // пропуск по признаку «его нет в справочнике», мы бы его сообщение не
    // забрали. Поэтому отсрочка сделана по СВОЕМУ ключу, а не по чужому.
    const env = await boot();
    try {
      const [alice, bob] = env.stand.wallets;
      const { requestBagPass, listBags } = await import('../chatTransport');

      // Алиса объявлена, Боб — нет.
      await env.announce.announceOwnKey({
        address: env.address, session: env.session, humanAsked: true,
        getPass: (opts) => env.chatSession.getBagPass(
          env.address, async ({ message }) => alice.signMessage(message), undefined, opts,
        ),
        publish: env.chatSession.publishChatKeys,
      });

      const bobPass = await requestBagPass((m) => bob.signMessage(m), bob.address as `0x${string}`);
      const { putBag } = await import('../chatTransport');
      await putBag(bobPass.pass, env.address, new TextEncoder().encode('мешок от необъявленного'));

      // Боба в справочнике по-прежнему нет...
      const bobRec = await fetch(`${env.stand.url}/keys/${bob.address.toLowerCase()}`);
      expect(bobRec.status).toBe(404);

      // ...а мешок от него на складе лежит и виден.
      const alicePass = await requestBagPass((m) => alice.signMessage(m), env.address);
      const inbox = await listBags(alicePass.pass);
      expect(
        inbox.inbox.filter(b => b.sender.toLowerCase() === bob.address.toLowerCase()),
        'мешок от необъявленного собеседника не пришёл — тогда посылка задания верна',
      ).toHaveLength(1);
    } finally {
      await env.stand.stop();
    }
  });
});
