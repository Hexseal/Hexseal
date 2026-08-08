/**
 * pairChatFinalRound.test.ts — три находки финальной проверки ветки.
 *
 * Все три — одна семья: человек не сделал ничего плохого, а экран говорит,
 * что ему верить нельзя.
 *
 *  Б-1. Новое устройство с ТЕМ ЖЕ обычным кошельком: нумерация начинается с
 *       нуля, сталкивается со старой, сообщение у собеседника пропадает
 *       вовсе, и панель обвиняет его в подделке.
 *  Б-2. Честная смена ключа собеседником читается как подделка: справочник
 *       историю хранит, клиент её не спрашивает.
 *  Б-3. Любая претензия к СВОЕМУ мешку поднимает баннер про чужую подделку.
 *
 * ⚠️ ОТДЕЛЬНЫЙ ФАЙЛ со своими заготовками намеренно: `usePairChat.test.ts`
 * прямо сейчас правят соседние исполнители (экран кода восстановления,
 * пересадка панели), и дописывание в общий файл уже стоило мне потерянной
 * работы посреди круга. Здесь ничего общего с ним нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import type { ChatSession } from '@/lib/chatSession';
import {
  deriveLinkSigningKeypair, encodeFrame, messageBodyHash, linkSignaturePreimage,
  receiveBags, _resetConversationMemoryForTest,
} from '@/lib/chatConversation';
import { buildLink, type ChainLink } from '@/lib/chatChain';
import { packEnvelope } from '@/lib/chatEnvelope';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import { startPairChat, troubleSummary, furtherLink, type PairChatState } from './usePairChat';
import { fetchPeerChatKeys } from './useChatSession';

const ALICE = '0xA1cE00000000000000000000000000000000CAfE' as const;
const BOB   = '0xB0b1000000000000000000000000000000005eEd' as const;
const ALICE_LC = ALICE.toLowerCase() as `0x${string}`;
const BOB_LC   = BOB.toLowerCase() as `0x${string}`;

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

interface StoredBag {
  key: string; sender: string; recipient: string;
  size: number; uploadedAt: number; body: Uint8Array;
  /** Звено этого мешка — заготовке нужно, чтобы продолжать цепочку. */
  link: ChainLink;
}

/** Настоящие мешки: конверт → звено → подпись → кадр. */
async function buildChain(
  from: ChatSession, sender: `0x${string}`, recipient: `0x${string}`,
  recipientPub: Uint8Array, texts: string[], startAt = 1_700_000_000_000,
  /** Продолжить уже начатую цепочку. Смена ключа нумерацию НЕ сбрасывает:
   *  голова разговора живёт на устройстве и переживает смену ключа — сброс
   *  номера это совсем другой случай (Б-1, чистое хранилище). Первая версия
   *  этой заготовки начинала с нуля, и «смена ключа» на деле проверяла
   *  столкновение номеров. */
  continueFrom: ChainLink | null = null,
): Promise<StoredBag[]> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(from.keypair);
  const out: StoredBag[] = [];
  let prev: ChainLink | null = continueFrom;
  for (let i = 0; i < texts.length; i++) {
    const at = startAt + i;
    const envelope = await packEnvelope(
      { text: texts[i] }, recipientPub, from.keypair.publicKey, sender.toLowerCase() as `0x${string}`,
    );
    const bodyHash = messageBodyHash(signer.publicKey, envelope);
    const link = buildLink(prev, bodyHash, sender.toLowerCase() as `0x${string}`, at);
    const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
    const body = encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope });
    out.push({
      key: `${recipient.toLowerCase()}/${at}.bin`,
      sender: sender.toLowerCase(), recipient: recipient.toLowerCase(),
      size: body.length, uploadedAt: at, body, link,
    });
    prev = link;
  }
  return out;
}

/**
 * Склад, ведущий себя как настоящий в том, что здесь важно: `inbox`
 * владельца пропуска — ОБЕ половины переписки (`readable` в relayer/app.js,
 * К-1 задачи 7), скачивание своего мешка разрешено отправителю.
 */
function relayer(opts: {
  bags: StoredBag[];
  me: `0x${string}`;
  keysBody: () => Record<string, unknown>;
  onPut?: (body: Uint8Array) => void;
}) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url)); const p = u.pathname;
    if (p === '/keys' && init?.method === 'POST') return new Response('{}', { status: 200 });
    if (p.startsWith('/keys/')) return new Response(JSON.stringify(opts.keysBody()), { status: 200 });
    if (p === '/bags' && (init?.method ?? 'GET') === 'GET') {
      const me = opts.me.toLowerCase();
      const readable = opts.bags.filter(b => b.recipient === me || b.sender === me);
      return new Response(JSON.stringify({
        inbox: readable.map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt })),
        sent: opts.bags.filter(b => b.sender === me)
          .map(({ key, recipient, uploadedAt }) => ({ key, recipient, uploadedAt, fetched: true })),
        peers: [],
      }), { status: 200 });
    }
    if (init?.method === 'PUT') {
      opts.onPut?.(new Uint8Array(init.body as ArrayBufferView as Uint8Array));
      return new Response(JSON.stringify({ key: `sent/${opts.bags.length}` }), { status: 200 });
    }
    const key = decodeURIComponent(p.replace(/^\/bags\//, ''));
    const bag = opts.bags.find(b => b.key === key);
    return bag ? new Response(bag.body, { status: 200 })
      : new Response(JSON.stringify({ error: 'no', code: 'bag_not_found' }), { status: 404 });
  });
}

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor: условие не наступило за отведённое время');
    await new Promise(r => setTimeout(r, 5));
  }
}

const tick = async () => { await new Promise(r => setTimeout(r, 1)); };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
  // ⚠️ ЭТО И ЕСТЬ «чистое хранилище». Окружение `node` — IndexedDB тут нет
  // вовсе, значит голова разговора живёт только в запасной памяти модуля, и
  // её сброс равен новому браузеру. Перезагрузка вкладки — ДРУГОЙ случай, и
  // он уже покрыт стендом: там хранилище живо.
  _resetConversationMemoryForTest();
});

/* ═════════════════ Б-1: новое устройство, тот же кошелёк ═════════════════ */

describe('чистое хранилище: тот же обычный кошелёк, другой браузер', () => {
  // Замер ДО правки (финальная проверка):
  //   номера мешков Боба на складе: [0,1,2] | номер нового сообщения: 0
  //   Алиса видит два из трёх, претензия duplicate_seq, chainUnverified: true
  // Боб не узнаёт ничего: его собственный повтор номера ему же невидим.

  it('ЗАМЕР: на складе номера [0,1,2] — новое сообщение получает 3, а не 0', async () => {
    const bob = await makeSession(BOB, 'bb');
    const alice = await makeSession(ALICE, 'a1');
    const bags = await buildChain(bob, BOB, ALICE, alice.keypair.publicKey, ['раз', 'два', 'три']);

    vi.stubGlobal('fetch', relayer({
      bags, me: BOB,
      keysBody: () => ({ boxKey: hexOf(alice.keypair.publicKey) }),
    }));

    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: bob, peer: ALICE, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {}, sleep: tick,
    });
    try {
      // Своя половина со склада разобрана — только ПОСЛЕ этого шлём.
      await waitFor(() => states.length > 0 && states[states.length - 1].messages.length === 3);
      const mine = await engine.send({ text: 'с нового устройства' });
      expect(mine.seq).toBe(3);
    } finally { engine.stop(); }
  }, 60_000);

  it('ЗАМЕР: у собеседника четыре сообщения и НОЛЬ претензий', async () => {
    const bob = await makeSession(BOB, 'bb');
    const alice = await makeSession(ALICE, 'a1');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const bags = await buildChain(bob, BOB, ALICE, alice.keypair.publicKey, ['раз', 'два', 'три']);

    let put: Uint8Array | null = null;
    vi.stubGlobal('fetch', relayer({
      bags, me: BOB,
      keysBody: () => ({ boxKey: hexOf(alice.keypair.publicKey) }),
      onPut: (b) => { put = b; },
    }));

    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: bob, peer: ALICE, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {}, sleep: tick,
    });
    try {
      await waitFor(() => states.length > 0 && states[states.length - 1].messages.length === 3);
      await engine.send({ text: 'четвёртое' });
    } finally { engine.stop(); }

    expect(put).not.toBeNull();
    const forAlice = [
      ...bags.map(b => ({ key: b.key, sender: BOB_LC, uploadedAt: b.uploadedAt, body: b.body })),
      { key: `${ALICE_LC}/9999.bin`, sender: BOB_LC, uploadedAt: 1_700_000_009_999, body: put as unknown as Uint8Array },
    ];
    const seen = await receiveBags(alice, forAlice, {
      peer: BOB_LC,
      peerSigningPublicKeys: { [BOB_LC]: bobSigner.publicKey },
    });

    expect(seen.messages.map(m => m.payload.text)).toEqual(['раз', 'два', 'три', 'четвёртое']);
    expect(seen.troubles).toEqual([]);
    expect(troubleSummary(seen.troubles, ALICE_LC).chainUnverified).toBe(false);
  }, 90_000);

  it('своя половина со склада не сбивает нумерацию, когда голова НА МЕСТЕ', async () => {
    // Обратная сторона: восстановление обязано быть НИЖНЕЙ границей, а не
    // источником истины. Отправив два подряд в одном сеансе, второй обязан
    // получить следующий номер, а не переспросить у склада устаревшее.
    const bob = await makeSession(BOB, 'bb');
    const alice = await makeSession(ALICE, 'a1');
    const bags = await buildChain(bob, BOB, ALICE, alice.keypair.publicKey, ['раз']);

    vi.stubGlobal('fetch', relayer({
      bags, me: BOB, keysBody: () => ({ boxKey: hexOf(alice.keypair.publicKey) }),
    }));

    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: bob, peer: ALICE, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {}, sleep: tick,
    });
    try {
      await waitFor(() => states.length > 0 && states[states.length - 1].messages.length === 1);
      const a = await engine.send({ text: 'два' });
      const b = await engine.send({ text: 'три' });
      expect([a.seq, b.seq]).toEqual([1, 2]);
    } finally { engine.stop(); }
  }, 60_000);

  it('переписка с ДРУГИМ собеседником свою нумерацию не двигает', async () => {
    // Нумерация — на разговор, не на человека. Если бы восстановление
    // считало все свои мешки подряд, первое сообщение Кэрол получило бы
    // номер из переписки с Алисой, и у Кэрол образовалась бы дыра на пустом
    // месте.
    const bob = await makeSession(BOB, 'bb');
    const alice = await makeSession(ALICE, 'a1');
    const carolAddr = '0xCa401000000000000000000000000000000f00d5' as const;
    const bags = await buildChain(bob, BOB, ALICE, alice.keypair.publicKey, ['раз', 'два', 'три']);

    vi.stubGlobal('fetch', relayer({
      bags, me: BOB, keysBody: () => ({ boxKey: hexOf(alice.keypair.publicKey) }),
    }));

    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: bob, peer: carolAddr, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {}, sleep: tick,
    });
    try {
      await waitFor(() => states.length > 0);
      const first = await engine.send({ text: 'привет, Кэрол' });
      expect(first.seq).toBe(0);
    } finally { engine.stop(); }
  }, 60_000);
});

/* ═══════════════ Б-2: честная смена ключа — не подделка ═══════════════ */

describe('собеседник честно сменил ключ', () => {
  // Справочник хранит историю ДОСЛОВНО ради этого (правило 3 задачи 2:
  // «старый сохраняется в истории, иначе переписка, запечатанная на прежний
  // ключ, станет нечитаемой молча»). Сервер своё выполняет, до двухсот
  // записей. `fetchPeerChatKeys` читал только текущие:
  //   видно: ["новое раз"] | претензии: ["signer_unexpected","signer_unexpected"]

  it('fetchPeerChatKeys отдаёт историю подписных ключей, а не только нынешний', async () => {
    const older = '0x' + '33'.repeat(32);
    const previous = '0x' + '22'.repeat(32);
    const current = '0x' + '11'.repeat(32);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      address: BOB_LC, boxKey: '0x' + 'aa'.repeat(32), signKey: current, keyChangeCount: 2,
      history: [
        { boxKey: '0x' + 'bb'.repeat(32), signKey: previous, replacedAt: 2, changed: ['signKey'] },
        { boxKey: '0x' + 'cc'.repeat(32), signKey: older, replacedAt: 1, changed: ['signKey'] },
      ],
    }), { status: 200 })));

    const keys = await fetchPeerChatKeys(BOB);
    expect(hexOf(keys.signKey as Uint8Array)).toBe(current);
    expect(keys.signKeyHistory.map(hexOf)).toEqual([current, previous, older]);
  });

  it('мусор в ОДНОЙ записи истории не отменяет остальные', async () => {
    const current = '0x' + '11'.repeat(32);
    const good = '0x' + '22'.repeat(32);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      boxKey: '0x' + 'aa'.repeat(32), signKey: current,
      history: [{ signKey: 'не ключ вовсе' }, { signKey: good }, { }],
    }), { status: 200 })));

    const keys = await fetchPeerChatKeys(BOB);
    expect(keys.signKeyHistory.map(hexOf)).toEqual([current, good]);
  });

  it('записи без signKey (до задачи 6) историю не ломают', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      boxKey: '0x' + 'aa'.repeat(32),
      history: [{ boxKey: '0x' + 'bb'.repeat(32), replacedAt: 1, changed: ['boxKey'] }],
    }), { status: 200 })));

    const keys = await fetchPeerChatKeys(BOB);
    expect(keys.signKey).toBeNull();
    expect(keys.signKeyHistory).toEqual([]);
  });

  it('ЗАМЕР: переписка через смену ключа — видны ВСЕ три, ноль signer_unexpected', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bobOld = await makeSession(BOB, 'b1');
    const bobNew = await makeSession(BOB, 'b2');
    const oldSigner = await deriveLinkSigningKeypair(bobOld.keypair);
    const newSigner = await deriveLinkSigningKeypair(bobNew.keypair);

    const older = await buildChain(bobOld, BOB, ALICE, alice.keypair.publicKey, ['старое раз', 'старое два']);
    // Смена ключа нумерацию НЕ сбрасывает — цепочка продолжается со звена 1.
    const newer = await buildChain(
      bobNew, BOB, ALICE, alice.keypair.publicKey, ['новое раз'], 1_700_000_000_500,
      older[older.length - 1].link,
    );
    expect(newer[0].link.seq).toBe(2);
    const bags = [...older, ...newer];

    vi.stubGlobal('fetch', relayer({
      bags, me: ALICE,
      keysBody: () => ({
        boxKey: hexOf(bobNew.keypair.publicKey), signKey: hexOf(newSigner.publicKey),
        history: [{
          boxKey: hexOf(bobOld.keypair.publicKey), signKey: hexOf(oldSigner.publicKey),
          replacedAt: 1, changed: ['boxKey', 'signKey'],
        }],
      }),
    }));

    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {}, sleep: tick,
    });
    try {
      await waitFor(() => states.length > 0 && states[states.length - 1].messages.length === 3);
      const last = states[states.length - 1];
      expect(last.messages.map(m => m.text)).toEqual(['старое раз', 'старое два', 'новое раз']);
      expect(last.troubles.filter(t => t.kind === 'signer_unexpected')).toEqual([]);
      expect(troubleSummary(last.troubles, ALICE_LC).chainUnverified).toBe(false);
    } finally { engine.stop(); }
  }, 90_000);

  it('ключ, которого в справочнике НЕТ ВОВСЕ, по-прежнему отвергается', async () => {
    // Замок, который принимает всех, — не замок.
    const alice = await makeSession(ALICE, 'a1');
    const bobReal = await makeSession(BOB, 'bb');
    const mallory = await makeSession(BOB, 'ee');
    const realSigner = await deriveLinkSigningKeypair(bobReal.keypair);
    const forged = await buildChain(mallory, BOB, ALICE, alice.keypair.publicKey, ['подделка']);

    const st = await receiveBags(alice, forged.map(b => ({
      key: b.key, sender: BOB_LC, uploadedAt: b.uploadedAt, body: b.body,
    })), {
      peer: BOB_LC,
      peerSigningPublicKeys: { [BOB_LC]: [realSigner.publicKey] },
    });
    expect(st.messages).toHaveLength(0);
    expect(st.troubles.filter(t => t.kind === 'signer_unexpected')).toHaveLength(1);
  }, 60_000);
});

/* ══════════ Б-3: претензия к своему мешку не обвиняет собеседника ══════════ */

describe('баннер про подделку поднимается только на ЧУЖИЕ претензии', () => {
  const OWN = ALICE_LC;
  const PEER = BOB_LC;
  const KINDS = [
    'malformed', 'sender_mismatch', 'body_mismatch', 'bad_signature',
    'signer_unexpected', 'signer_changed', 'duplicate_seq',
  ];

  // Замер до правки: четыре претензии, авторы всех четырёх — мы сами,
  // chainUnverified: true. Вырезан был РОВНО ОДИН род из шести.

  it('ЗАМЕР: семь родов претензий к СВОИМ мешкам — баннер молчит по всем семи', () => {
    for (const kind of KINDS) {
      expect(troubleSummary([{ kind, from: OWN }], OWN).chainUnverified,
        `род «${kind}» к своему мешку поднял баннер`).toBe(false);
    }
  });

  it('те же семь родов к мешкам СОБЕСЕДНИКА баннер поднимают', () => {
    for (const kind of KINDS) {
      expect(troubleSummary([{ kind, from: PEER }], OWN).chainUnverified,
        `род «${kind}» к чужому мешку баннер не поднял`).toBe(true);
    }
  });

  it('НОВЫЙ, ещё не существующий род разбирается по автору, а не по списку родов', () => {
    // Тот самый замок, ради которого правка делается «по существу»: пока
    // разбор перечисляет рода руками, шестой род проезжает молча.
    expect(troubleSummary([{ kind: 'какой_то_будущий_род', from: OWN }], OWN).chainUnverified).toBe(false);
    expect(troubleSummary([{ kind: 'какой_то_будущий_род', from: PEER }], OWN).chainUnverified).toBe(true);
  });

  it('нерасшифрованное СВОЁ — тоже не повод жаловаться', () => {
    const s = troubleSummary([{ kind: 'undecryptable', from: OWN }], OWN);
    expect(s.chainUnverified).toBe(false);
    expect(s.undecryptable).toBe(false);
  });

  it('нерасшифрованное ЧУЖОЕ по-прежнему называется своим именем', () => {
    const s = troubleSummary([{ kind: 'undecryptable', from: PEER }], OWN);
    expect(s.chainUnverified).toBe(false);
    expect(s.undecryptable).toBe(true);
  });

  it('автор неизвестен — считается чужим: честнее сказать, чем промолчать', () => {
    expect(troubleSummary([{ kind: 'malformed' }], OWN).chainUnverified).toBe(true);
  });

  it('свои и чужие вперемешку: одна чужая — баннер есть', () => {
    expect(troubleSummary([
      { kind: 'signer_changed', from: OWN },
      { kind: 'undecryptable', from: OWN },
      { kind: 'bad_signature', from: PEER },
    ], OWN).chainUnverified).toBe(true);
  });

  it('свой адрес в другом регистре — всё равно свой', () => {
    expect(troubleSummary([{ kind: 'bad_signature', from: ALICE }], OWN).chainUnverified).toBe(false);
  });

  it('без адреса владельца разбор ведёт себя как раньше — обвиняет по роду', () => {
    // Обратная совместимость для вызывающего, который своего адреса не знает.
    expect(troubleSummary([{ kind: 'bad_signature', from: OWN }]).chainUnverified).toBe(true);
  });
});

/* ───── Б-1, две подпорки, которые мутации нашли пустыми ───── */

describe('выбор головы: вперёд, но не назад', () => {
  const mk = (seq: number): ChainLink => ({
    seq, prevHash: `0x${'11'.repeat(32)}`, bodyHash: `0x${'22'.repeat(32)}`,
    sender: BOB_LC, sentAt: 1,
  });

  it('склад дальше памяти — берётся склад', () => {
    expect(furtherLink(mk(5), mk(2))?.seq).toBe(5);
  });

  it('ПАМЯТЬ дальше склада — берётся память, а не склад', () => {
    // Ровно та мутация, что проходила зелёной инлайном: «пусть склад просто
    // побеждает». В живом сеансе склад и память сходятся сами, и разница
    // видна только здесь — на голых значениях.
    expect(furtherLink(mk(2), mk(7))?.seq).toBe(7);
  });

  it('одного из двух нет — берётся второй, а не null', () => {
    expect(furtherLink(null, mk(3))?.seq).toBe(3);
    expect(furtherLink(mk(3), null)?.seq).toBe(3);
    expect(furtherLink(null, null)).toBeNull();
  });
});

describe('восстановление головы берёт СВОЮ цепочку, а не чужую', () => {
  it('ЗАМЕР: у собеседника номера до 4, у нас один — наше следующее получает 1, а не 5', async () => {
    // Что красит: отбор восстановления без проверки автора. Чужая цепочка
    // длиннее нашей — обычное дело, — и её номер, взятый за свой, выдал бы
    // собеседнику дыру в нашей нумерации на ровном месте.
    const bob = await makeSession(BOB, 'bb');
    const alice = await makeSession(ALICE, 'a1');
    const mine = await buildChain(bob, BOB, ALICE, alice.keypair.publicKey, ['моё нулевое']);
    const theirs = await buildChain(
      alice, ALICE, BOB, bob.keypair.publicKey,
      ['их 0', 'их 1', 'их 2', 'их 3', 'их 4'], 1_700_000_000_100,
    );

    vi.stubGlobal('fetch', relayer({
      bags: [...mine, ...theirs], me: BOB,
      keysBody: () => ({ boxKey: hexOf(alice.keypair.publicKey) }),
    }));

    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: bob, peer: ALICE, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {}, sleep: tick,
    });
    try {
      await waitFor(() => states.length > 0 && states[states.length - 1].messages.length === 6);
      const sent = await engine.send({ text: 'моё первое' });
      expect(sent.seq).toBe(1);
    } finally { engine.stop(); }
  }, 90_000);
});

describe('own_numbering_reset несёт автора в собственном имени', () => {
  it('молчит и БЕЗ адреса владельца — этот род бывает только про свой мешок', () => {
    // Обвинением не становится — но и молчанием тоже: третий признак назван
    // отдельно (пункт «сбитая своя нумерация не показывается»).
    expect(troubleSummary([{ kind: 'own_numbering_reset' }])).toEqual({
      chainUnverified: false, undecryptable: false, ownNumberingReset: true,
    });
  });

  it('а чужой повтор номера по-прежнему признак подделки', () => {
    expect(troubleSummary([{ kind: 'duplicate_seq', from: BOB_LC }], ALICE_LC).chainUnverified).toBe(true);
  });
});

/* ───── своя беда доезжает от разговора до экрана, а не только до хранилища ───── */

describe('сгоревшие номера доходят до состояния переписки', () => {
  it('ЗАМЕР: отправка не удалась — номер сгорел и НАЗВАН в состоянии', async () => {
    // Панельные замки кормят состояние руками; здесь проверяется сама
    // проводка «разговор → движок → состояние». Без неё список сгоревших
    // номеров остаётся в хранилище, а человек уверен, что отправил.
    const bob = await makeSession(BOB, 'bb');
    const alice = await makeSession(ALICE, 'a1');

    // 500 — «судьба мешка неизвестна»: номер сгорает (не откатывается).
    let failPut = true;
    const base = relayer({ bags: [], me: BOB, keysBody: () => ({ boxKey: hexOf(alice.keypair.publicKey) }) });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'PUT' && failPut) {
        return new Response(JSON.stringify({ error: 'boom', code: 'internal_error' }), { status: 500 });
      }
      return base(url, init);
    }));

    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: bob, peer: ALICE, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {}, sleep: tick,
    });
    try {
      await waitFor(() => states.length > 0);
      await expect(engine.send({ text: 'не доедет' })).rejects.toMatchObject({ code: 'send_failed' });
      failPut = false;
      await waitFor(() => states[states.length - 1].burnedSeqs.length > 0);
      expect(states[states.length - 1].burnedSeqs).toEqual([0]);
    } finally { engine.stop(); }
  }, 90_000);

  it('удачная отправка сгоревших номеров не оставляет', async () => {
    const bob = await makeSession(BOB, 'bb');
    const alice = await makeSession(ALICE, 'a1');
    vi.stubGlobal('fetch', relayer({
      bags: [], me: BOB, keysBody: () => ({ boxKey: hexOf(alice.keypair.publicKey) }),
    }));

    const states: PairChatState[] = [];
    const engine = startPairChat({
      session: bob, peer: ALICE, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {}, sleep: tick,
    });
    try {
      await waitFor(() => states.length > 0);
      await engine.send({ text: 'доедет' });
      const mark = states.length;
      await waitFor(() => states.length > mark + 1);
      expect(states[states.length - 1].burnedSeqs).toEqual([]);
    } finally { engine.stop(); }
  }, 90_000);
});

describe('своя перенумерация не съедается отсевом по автору', () => {
  it('претензия с НАШИМ адресом всё равно доносится третьим признаком', () => {
    // Мутация «переставить отсев по автору вперёд» проглатывала её целиком:
    // в бою `own_numbering_reset` ВСЕГДА несёт наш адрес, и отсев «это наше,
    // молчим» убирал ровно то, что надо сказать.
    const s = troubleSummary([{ kind: 'own_numbering_reset', from: ALICE_LC }], ALICE_LC);
    expect(s.ownNumberingReset).toBe(true);
    expect(s.chainUnverified).toBe(false);
  });
});
