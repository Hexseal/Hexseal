/**
 * presentationKeyRotation.test.ts — пункты 48 и 49 открытых находок (4в-2).
 *
 * ЧТО ЗДЕСЬ МЕРИТСЯ:
 *  48 — собеседник ЧЕСТНО сменил ключ чата (вошёл по коду восстановления), и
 *       половина его сообщений подписана ПРЕЖНИМ ключом. До правки контейнер
 *       вёз одно заверение на сторону, читалка брала НЫНЕШНЕЕ, и честные слова
 *       читались как подделка: `frame: malformed`, `attestation: wrong_keys` —
 *       то же самое, что на сочинённой цепочке. Замер до правки: красных НОЛЬ,
 *       такой сцены не было ни в одном из 2101 теста.
 *  49 — `no_session` отвечал на четыре разные беды, три из которых не про сеанс.
 *
 * ⚠️ ВСЁ КРИПТО НАСТОЯЩЕЕ. Пары выводит `deriveChatKeypair`, подписи звеньев —
 * libsodium, заверения — настоящая EIP-712-подпись локального аккаунта viem.
 * Смена ключа делается ЧЕСТНО: два разных сеанса чата ОДНОГО кошелька, каждый со
 * своим заверением, подписанным тем же кошельком.
 *
 * ⚠️ СЦЕНА ПРОВЕРЯЕТСЯ САМА НА СЕБЯ (R1): кадры 0-1 обязаны НАЗЫВАТЬ прежний
 * подписной ключ, кадры 2-3 — нынешний. Без этой сверки фикстура, случайно
 * собравшая всё одним ключом, дала бы зелёный замок ни о чём.
 *
 * ⚠️ ТРЕТЬЕ, ЧТО ЗДЕСЬ ЗАПИРАЕТСЯ (R13). Пока заверение на сторону было одно,
 * вопрос «какое из них показать» не существовал. Теперь их несколько, и порядок
 * массива — слово ПРЕДЪЯВИТЕЛЯ, не подписанное никем. Значит вердикт стороны
 * обязан быть функцией подписанного поля (`issuedAt`), а не раскладки: R13 подаёт
 * один и тот же контейнер двумя раскладками и требует одинакового ответа.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { deriveChatKeypair } from './chatCrypto';
import { packEnvelope } from './chatEnvelope';
import {
  archiveConversationFrames, decodeFrame, deriveLinkSigningKeypair, encodeFrame,
  linkSignaturePreimage, messageBodyHash,
  _resetConversationMemoryForTest, _resetParseCacheForTest,
  type ArchivedFrame,
} from './chatConversation';
import { buildLink, type ChainLink } from './chatChain';
import * as attestationModule from './chatKeyAttestation';
import {
  signChatKeyAttestation, verifyChatKeyAttestation, type ChatKeyAttestation,
} from './chatKeyAttestation';
import {
  buildPresentation, canonicalPresentationBytes, b64FromBytes, bytesFromB64,
  BUILD_FAILURE_NAMES, toArbiterBoxKeyBytes, toPeerBoxKeyBytes,
  type PresentationContainer, type UnsignedPresentation,
} from './presentation';
import { fittingMessageCount } from './presentationBag';
import { readPresentation } from './presentationRead';
import type { ChatSession } from './chatSession';
import { installFakeChatDisk, type FakeChatDisk } from './__stand__/fakeChatDisk';

/* ─────────────────────────── актёры ─────────────────────────── */

const ALICE_PK = ('0x' + '11'.repeat(32)) as `0x${string}`;
const BOB_PK = ('0x' + '22'.repeat(32)) as `0x${string}`;
const CAROL_PK = ('0x' + '33'.repeat(32)) as `0x${string}`;
const ALICE = privateKeyToAccount(ALICE_PK).address;   // с контрольной суммой, как из useAccount()
const BOB = privateKeyToAccount(BOB_PK).address;
const CAROL = privateKeyToAccount(CAROL_PK).address;
const DEAL = '0xdeadDEAD00000000000000000000000000c0ffee' as `0x${string}`;

const T0 = 1_754_400_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const L = (a: `0x${string}`): `0x${string}` => a.toLowerCase() as `0x${string}`;

/** Настоящая по форме ECDSA-подпись: 0x + 130 hex (65 байт). */
function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}
function hex32(bytes: Uint8Array): `0x${string}` {
  return ('0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}
async function sodium() {
  const s = (await import('libsodium-wrappers')).default;
  await s.ready;
  return s;
}
async function makeSession(address: `0x${string}`, seed: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig(seed)),
    address, origin: 'signature', walletKind: 'eoa', restored: true, persisted: true,
  };
}
function walletOf(pk: `0x${string}`): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(pk), chain: baseSepolia, transport: http('http://127.0.0.1:1'),
  }) as unknown as WalletClient;
}

/** Заверение, подписанное ДАВНО. Часы подменяются только на время подписи:
 *  `issuedAt` берётся из `Date.now()` (`chatKeyAttestation.ts:279`), а срок
 *  считается при ПРОВЕРКЕ, уже настоящими часами. */
async function attestedLongAgo(
  session: ChatSession, pk: `0x${string}`, ageMs: number,
): Promise<ChatKeyAttestation> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - ageMs);
  try {
    return await signChatKeyAttestation(walletOf(pk), session);
  } finally {
    spy.mockRestore();
  }
}

/* ─────────────────────── обстановка ─────────────────────── */

const TEXTS = [
  'работу сдал в среду, вот акт',
  'ссылка на архив в прошлом сообщении',
  'устройство потерял, зашёл по коду восстановления',
  'жду оплату по договору',
];

let disk: FakeChatDisk;
let alice: ChatSession;
let bobOld: ChatSession;      // пара ДО потери устройства
let bobNew: ChatSession;      // пара ПОСЛЕ входа по коду восстановления
let carol: ChatSession;
let arbiter: ChatSession;
let aliceAtt: ChatKeyAttestation;
let bobAttOld: ChatKeyAttestation;
let bobAttNew: ChatKeyAttestation;
let carolAtt: ChatKeyAttestation;

beforeEach(async () => {
  // Склад в этом файле НЕ участвует вовсе: любое обращение к сети — находка.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('сеть в этом замере звучать не должна'); }));
  _resetConversationMemoryForTest();
  _resetParseCacheForTest();
  disk = installFakeChatDisk();

  alice = await makeSession(ALICE, '1c3d');
  bobOld = await makeSession(BOB, '7f2e');
  bobNew = await makeSession(BOB, 'b0b2');
  carol = await makeSession(CAROL, 'ca40');
  arbiter = await makeSession('0xA4b1000000000000000000000000000000000001', 'a4b1');

  aliceAtt = await signChatKeyAttestation(walletOf(ALICE_PK), alice);
  bobAttOld = await signChatKeyAttestation(walletOf(BOB_PK), bobOld);
  bobAttNew = await signChatKeyAttestation(walletOf(BOB_PK), bobNew);
  carolAtt = await signChatKeyAttestation(walletOf(CAROL_PK), carol);
}, 60_000);

afterEach(() => { disk.restore(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/**
 * Четыре сообщения Боба ОДНОЙ цепочкой: 0-1 подписаны прежней парой, 2-3 —
 * нынешней. Цепочка сплошная (`prevHash` связывает все четыре), потому что
 * `verifyChain` подписи не смотрит вовсе — расходятся только ключи.
 *
 * `forgeLast` — последнее сообщение подписано СВЕЖЕЙ парой Ed25519, которую не
 * заверял никто: сцена «цепочка досочинена».
 */
async function bobChain(opts: { forgeLast?: boolean } = {}): Promise<{ link: ChainLink }[]> {
  const s = await sodium();
  const sender = L(BOB);
  const rogue = opts.forgeLast ? s.crypto_sign_keypair() : null;
  const out: { link: ChainLink; frame: Uint8Array }[] = [];
  let prev: ChainLink | null = null;

  for (const [i, text] of TEXTS.entries()) {
    const session = i < 2 ? bobOld : bobNew;
    const honest = await deriveLinkSigningKeypair(session.keypair);
    const signer = (rogue && i === TEXTS.length - 1)
      ? { publicKey: rogue.publicKey, privateKey: rogue.privateKey }
      : honest;
    const envelope = await packEnvelope({ text }, alice.keypair.publicKey, session.keypair.publicKey, sender);
    const link = buildLink(prev, messageBodyHash(signer.publicKey, envelope), sender, T0 + i * 1000);
    out.push({
      link,
      frame: encodeFrame({
        link,
        signature: s.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey),
        signerPublicKey: signer.publicKey,
        envelope,
      }),
    });
    prev = link;
  }

  // Архивируется ТАК ЖЕ, КАК ЭТО ДЕЛАЕТ ДВИЖОК: `seq: 0`, `sentAt = uploadedAt`
  // (`usePairChat.ts:930-937`). Врать полем — не прихоть, а состояние диска.
  const rows: ArchivedFrame[] = out.map((o, i) => ({
    key: `${L(ALICE)}/${T0 + i}-bob.bin`,
    from: sender,
    seq: 0,
    sentAt: T0 + i, receivedAt: T0 + i,
    frame: o.frame,
  }));
  await archiveConversationFrames(ALICE, BOB, rows);
  return out;
}

type BuildInput = Parameters<typeof buildPresentation>[0];

function inputFor(over: Partial<BuildInput> = {}): BuildInput {
  return {
    dealId: DEAL,
    presenter: ALICE,
    peer: L(BOB),
    arbiterBoxKey: toArbiterBoxKeyBytes(arbiter.keypair.publicKey),
    peerBoxKey: toPeerBoxKeyBytes(bobNew.keypair.publicKey),
    selected: TEXTS.map((_, seq) => ({ seq, sender: BOB })),
    session: alice,
    ownAttestation: aliceAtt,
    otherAttestations: [bobAttNew, bobAttOld],
    now: () => T0 + 100_000,
    ...over,
  };
}
const build = (over: Partial<BuildInput> = {}) => buildPresentation(inputFor(over));

async function mustBuild(over: Partial<BuildInput> = {}): Promise<PresentationContainer> {
  const built = await build(over);
  if (!built.ok) throw new Error(`сборка отказала: ${built.reason}`);
  return built.container;
}

/** Подписать контейнер заново — тем же каноническим видом и тем же ключом
 *  подписи, каким его подписывает сборщик. Второго канонизатора здесь нет. */
async function resign(unsigned: UnsignedPresentation): Promise<PresentationContainer> {
  const s = await sodium();
  const signer = await deriveLinkSigningKeypair(alice.keypair);
  return {
    ...unsigned,
    signature: b64FromBytes(s.crypto_sign_detached(canonicalPresentationBytes(unsigned), signer.privateKey)),
  };
}

/* ══════════════ ПУНКТ 48: заверения по ПАРЕ КЛЮЧЕЙ ══════════════ */

describe('4в-2/48: собеседник честно сменил ключ', () => {
  it('R1: половина сообщений подписана ПРЕЖНИМ ключом — все вердикты ok, слова читаются', async () => {
    const chain = await bobChain();
    expect(chain.map(x => x.link.seq), 'цепочка не сплошная — мерить нечего').toEqual([0, 1, 2, 3]);

    const c = await mustBuild();

    // ─── сцена настоящая, а не удобная ───
    expect(bobAttOld.signKey, 'фикстура собрала обе половины ОДНИМ ключом').not.toBe(bobAttNew.signKey);
    const named = c.frames.map(f => hex32(decodeFrame(bytesFromB64(f.frame)!)!.signerPublicKey));
    expect(named).toEqual([bobAttOld.signKey, bobAttOld.signKey, bobAttNew.signKey, bobAttNew.signKey]);

    // ─── контейнер везёт ОБА заверения собеседника ───
    // До пункта 48 это было невозможно дважды: на входе (одно поле) и на выходе
    // (гейт формы отвергал второе заверение на тот же адрес).
    expect(c.attestations).toHaveLength(3);
    expect(c.attestations[0].signKey, 'первым обязано быть своё — им подписан контейнер').toBe(aliceAtt.signKey);
    expect([...c.attestations.slice(1)].map(a => a.signKey).sort())
      .toEqual([bobAttOld.signKey, bobAttNew.signKey].sort());

    // ─── и арбитр читает их все ───
    const view = await readPresentation(c, arbiter.keypair);
    expect(view.container).toBe('ok');
    expect(view.messages).toHaveLength(4);
    for (const m of view.messages) {
      expect(m.attestation, `#${m.seq}: честное слово названо непроверенным`).toBe('ok');
      expect(m.frame.ok, `#${m.seq}: честный кадр объявлен негодным`).toBe(true);
      expect(m.state, `#${m.seq}: не прочитано`).toBe('read');
    }
    expect(view.messages.map(m => m.payload?.text)).toEqual(TEXTS);
    expect(view.counts).toEqual({ read: 4, unopened: 0, hidden: 0, notPrepared: 0 });
  }, 60_000);

  it('R2: два заверения на ОДНУ пару ключей — по-прежнему malformed («купить вердикт» нельзя)', async () => {
    await bobChain();
    const c = await mustBuild();
    const { signature: _drop, ...unsigned } = c;

    const bobRow = unsigned.attestations.find(a => a.signKey === bobAttNew.signKey)!;
    // Тот же адрес, та же ПАРА — другая подпись. Ровно тот случай, ради которого
    // `seenAtt` и заводился: читалка взяла бы первое, экран показал бы второе.
    const twin: ChatKeyAttestation = { ...bobRow, signature: aliceAtt.signature };
    const doubled = await resign({ ...unsigned, attestations: [...unsigned.attestations, twin] });
    expect((await readPresentation(doubled, arbiter.keypair)).container).toBe('malformed');

    // Тот же контейнер без близнеца — читается: отвергнут ИМЕННО дубль пары.
    expect((await readPresentation(await resign(unsigned), arbiter.keypair)).container).toBe('ok');
  }, 60_000);

  it('R3: цепочка досочинена свежей парой — wrong_keys и НЕ читается, честные соседи читаются', async () => {
    await bobChain({ forgeLast: true });
    const c = await mustBuild();
    const view = await readPresentation(c, arbiter.keypair);
    expect(view.container).toBe('ok');

    const rogue = view.messages.find(m => m.seq === 3)!;
    expect(rogue.attestation, 'сочинённая пара выдана за заверенную').toBe('wrong_keys');
    expect(rogue.frame.ok, 'сочинённый кадр прошёл как проверенный').toBe(false);
    expect(rogue.state).toBe('unopened');
    expect(rogue.payload, 'содержимое сочинённого сообщения показано арбитру').toBeUndefined();

    for (const m of view.messages.filter(x => x.seq !== 3)) {
      expect(m.attestation, `#${m.seq}: честное слово пострадало от соседа`).toBe('ok');
      expect(m.state, `#${m.seq}: честное слово не прочиталось`).toBe('read');
    }
    expect(view.counts).toEqual({ read: 3, unopened: 1, hidden: 0, notPrepared: 0 });
  }, 60_000);

  it('R4: заверение, не названное ни одним показанным кадром, в контейнер не кладётся', async () => {
    await bobChain();
    // Показываем ТОЛЬКО сообщения нынешней пары: прежнее заверение не накрывает
    // ничего, заверение постороннего не читает никто (карта читалки по адресу).
    const now = await mustBuild({
      selected: [{ seq: 2, sender: BOB }, { seq: 3, sender: BOB }],
      otherAttestations: [bobAttOld, bobAttNew, carolAtt],
    });
    expect(now.attestations.map(a => a.signKey)).toEqual([aliceAtt.signKey, bobAttNew.signKey]);

    // И наоборот: показали прежние — приехало прежнее, а нынешнее осталось дома.
    const then = await mustBuild({
      selected: [{ seq: 0, sender: BOB }, { seq: 1, sender: BOB }],
      otherAttestations: [bobAttOld, bobAttNew, carolAtt],
    });
    expect(then.attestations.map(a => a.signKey)).toEqual([aliceAtt.signKey, bobAttOld.signKey]);
  }, 60_000);

  it('R5: порядок заверений на входе не меняет ПОДПИСЫВАЕМЫЕ БАЙТЫ', async () => {
    await bobChain();
    const a = await mustBuild({ otherAttestations: [bobAttOld, bobAttNew] });
    const b = await mustBuild({ otherAttestations: [bobAttNew, bobAttOld] });

    expect(a.attestations, 'сцена вырождена: сравнивать порядок не на чем').toHaveLength(3);
    expect(a.attestations[0].signKey).toBe(aliceAtt.signKey);
    // Раскладка — та же, дословно, при обратном порядке на входе.
    expect(b.attestations).toEqual(a.attestations);

    // ⚠️ РАСХОЖДЕНИЕ С ЗАДАНИЕМ, ЗАМЕРЕНО И НАЗВАНО ВСЛУХ. Задание требовало здесь
    // `a.signature === b.signature`. Это НЕДОСТИЖИМО и не про заверения:
    // `sealForRecipient` — это `crypto_box_seal` (`chatCrypto.ts:153`), который на
    // каждый вызов берёт СВЕЖУЮ эфемерную пару. Значит `keys[].forArbiter` у двух
    // сборок одного и того же куска различны ВСЕГДА (зонд показал расхождение
    // ровно там, на первом же `forArbiter`), и контейнер целиком функцией
    // содержимого не является ни с сортировкой, ни без неё.
    //
    // Поэтому мерится ровно то, что сортировка ПОКУПАЕТ: раздел заверений в
    // подписываемых байтах есть функция НАБОРА, а не того, в каком порядке его
    // отдал справочник. Берём байты сборки `a`, подставляем в них массив
    // заверений сборки `b` — и подпись обязана совпасть с подписью `a` побайтово.
    const { signature: _drop, ...ua } = a;
    const canary = await resign(ua);
    expect(canary.signature, 'сам зонд сломан: пересборка подписи не воспроизводит сборщика')
      .toBe(a.signature);
    const swapped = await resign({ ...ua, attestations: b.attestations });
    expect(swapped.signature, 'порядок заверений уехал в подписываемые байты').toBe(a.signature);
  }, 60_000);

  it('R6: прежнее имя peerAttestation — громкий TypeError, а не молча потерянное заверение', async () => {
    await bobChain();
    await expect(buildPresentation({ ...inputFor(), peerAttestation: bobAttNew } as unknown as BuildInput))
      .rejects.toThrow(TypeError);
    // Пустое значение — тот же бросок: правку требуется внести ВЕЗДЕ.
    await expect(buildPresentation({ ...inputFor(), peerAttestation: undefined } as unknown as BuildInput))
      .rejects.toThrow(TypeError);
    // И не массив — тоже наш мусор, а не состояние мира.
    await expect(build({ otherAttestations: bobAttNew as unknown as ChatKeyAttestation[] }))
      .rejects.toThrow(TypeError);
  }, 60_000);

  it('R11 (ПРЕДЕЛ, названный вслух): заверению прежней пары больше года — прежние слова снова непроверяемы', async () => {
    await bobChain();
    const stale = await attestedLongAgo(bobOld, BOB_PK, YEAR_MS + 5 * 24 * 60 * 60 * 1000);
    expect(stale.signKey, 'просроченное заверение собрано не на ту пару').toBe(bobAttOld.signKey);

    const c = await mustBuild({ otherAttestations: [bobAttNew, stale] });
    expect(c.attestations, 'просроченное заверение не доехало — предел не мерится').toHaveLength(3);

    const view = await readPresentation(c, arbiter.keypair);
    // ⚠️ БЕЗ ЭТИХ ДВУХ СТРОК ОБА ЦИКЛА НИЖЕ ИДУТ ВХОЛОСТУЮ. У отвергнутого
    // контейнера `messages` пуст (`presentationRead.ts:220-221`), `filter` даёт
    // пустой массив, ни одного ожидания не исполняется — и тест зелен, ничего не
    // измерив. Мутация 2 (гейт формы: пара → адрес) отвергает контейнер этой
    // сцены целиком, и без строк ниже R11 зеленел бы под ней вхолостую.
    expect(view.container, 'контейнер отвергнут целиком — предел не мерится').toBe('ok');
    expect(view.messages, 'сообщений нет — оба цикла ниже прошли бы вхолостую').toHaveLength(4);
    for (const m of view.messages.filter(x => x.seq < 2)) {
      // Годного заверения под названный ключ нет → ключ прикалывается нынешним
      // годным, и честный кадр снова читается как подделка. Это ЦЕНА годового
      // срока (`ATTESTATION_MAX_AGE_MS`), названная вслух, а не закрытая.
      expect(m.attestation, `#${m.seq}`).toBe('wrong_keys');
      expect(m.state, `#${m.seq}`).toBe('unopened');
    }
    for (const m of view.messages.filter(x => x.seq >= 2)) {
      expect(m.attestation, `#${m.seq}`).toBe('ok');
      expect(m.state, `#${m.seq}`).toBe('read');
    }
  }, 60_000);

  it('R14: мусорное заверение с огромным issuedAt не становится «нынешним» для стороны', async () => {
    // Ревью, круг 1. `issuedAt` у заверения с НЕСОШЕДШЕЙСЯ подписью подписан
    // только сам собой — значит предъявитель волен написать туда что угодно.
    // Пока заверение на адрес было ОДНО, ручки не существовало; список её
    // создаёт, и мерится здесь именно она.
    await bobChain();
    const forged: ChatKeyAttestation = { ...bobAttOld, issuedAt: T0 + 10 * YEAR_MS };
    // Сцена не вырождена: подделка НЕ годна (правка `issuedAt` рвёт подпись
    // кошелька) и она СВЕЖЕЕ настоящего — то есть `newest` по всем записям
    // выбрал бы именно её.
    expect(await verifyChatKeyAttestation(forged), 'подделка прошла как годная').not.toBe('ok');
    expect(forged.issuedAt, 'подделка не свежее настоящего — ручка не мерится')
      .toBeGreaterThan(bobAttNew.issuedAt);

    const c = await mustBuild({ otherAttestations: [bobAttNew, forged] });
    expect(c.attestations, 'подделка не доехала — мерить нечего').toHaveLength(3);

    // Кадр сообщения #0 убираем: тогда `readOne` возвращается сразу, ДО разбора
    // кадра, и несёт ровно вердикт СТОРОНЫ — единственное место, где выбор
    // «нынешнего» заверения наблюдаем.
    const { signature: _drop, ...unsigned } = c;
    const gutted = await resign({
      ...unsigned,
      frames: unsigned.frames.filter(f => f.seq !== 0),
      keys: unsigned.keys.filter(k => k.seq !== 0),
    });
    const view = await readPresentation(gutted, arbiter.keypair);
    expect(view.container).toBe('ok');

    const orphan = view.messages.find(m => m.seq === 0)!;
    expect(orphan.frame.ok, 'кадр всё-таки разобрался — сцена не та').toBe(false);
    // Годное заверение у стороны есть, и вердикт стороны обязан быть ЕГО, а не
    // подделки, которую предъявитель пометил будущим числом.
    expect(orphan.attestation, 'мусорное заверение стало «нынешним» для стороны').toBe('ok');
  }, 60_000);

  it('R12 (ЗАМЕР): выбор по паре не покупает лишних проверок — числа названы', async () => {
    await bobChain();
    const c = await mustBuild();

    const verify = vi.spyOn(attestationModule, 'verifyChatKeyAttestation');
    const forKeys = vi.spyOn(attestationModule, 'verifyChatKeyAttestationForKeys');
    const view = await readPresentation(c, arbiter.keypair);
    expect(view.container).toBe('ok');

    console.info(
      `[4в-2/48 замер] заверений в контейнере ${c.attestations.length}; ` +
      `проверок заверения ${verify.mock.calls.length}; ` +
      `вопросов «те ли ключи» ${forKeys.mock.calls.length}`,
    );
    // По одному на заверение — цена, которую платит арбитр за историю ключей.
    expect(verify).toHaveBeenCalledTimes(3);
    // По одному на РАЗЛИЧНЫЙ названный кадром ключ, а не на сообщение: у Боба
    // ключа два, сообщений четыре. Снимут памятку — станет четыре.
    expect(forKeys).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('R13: два НЕгодных заверения стороны — вердикт не зависит от раскладки массива', async () => {
    await bobChain();
    // Сцена без злого умысла: Боб переехал на умный кошелёк. Прежнее заверение
    // (та пара, которой подписаны кадры 0-1) настоящее, но старше года; нынешнее
    // — ERC-1271, и БЕЗ клиента цепи проверить его нечем (`chatKeyAttestation.ts:453-459`).
    // Годного заверения у стороны нет ни одного — значит вердикт сообщений берётся
    // из выбора между двумя негодными, и вот этот выбор здесь и меряется.
    const staleOld = await attestedLongAgo(bobOld, BOB_PK, YEAR_MS + 5 * 24 * 60 * 60 * 1000);
    const contractNew: ChatKeyAttestation = {
      ...bobAttNew, signature: ('0x' + 'ab'.repeat(80)) as `0x${string}`,
    };
    // Сцена не вырождена: беды РАЗНЫЕ и обе не `ok`, поэтому по вердикту сообщения
    // видно, какое из двух заверений читалка выбрала.
    expect(await verifyChatKeyAttestation(staleOld), 'прежнее заверение обязано быть просрочено').toBe('expired');
    expect(await verifyChatKeyAttestation(contractNew), 'нынешнее обязано быть непроверяемым').toBe('absent');
    expect(staleOld.issuedAt, 'просроченное обязано быть СТАРШЕ').toBeLessThan(contractNew.issuedAt);

    const c = await mustBuild({ otherAttestations: [staleOld, contractNew] });
    const { signature: _drop, ...unsigned } = c;
    const own = unsigned.attestations[0];
    expect(own.signKey, 'первым в контейнере обязано лежать своё заверение').toBe(aliceAtt.signKey);

    // ⚠️ РАСКЛАДКУ ЗАДАЁТ ПРЕДЪЯВИТЕЛЬ, и подписью кошелька она не накрыта: два
    // контейнера, отличающиеся ТОЛЬКО порядком двух заверений собеседника.
    const first = await resign({ ...unsigned, attestations: [own, staleOld, contractNew] });
    const second = await resign({ ...unsigned, attestations: [own, contractNew, staleOld] });
    const vf = await readPresentation(first, arbiter.keypair);
    const vs = await readPresentation(second, arbiter.keypair);
    expect(vf.container).toBe('ok');
    expect(vs.container).toBe('ok');

    // Ответ один и тот же — вердикт есть функция ПОДПИСАННОГО поля (`issuedAt`),
    // а не раскладки. И это `absent` самого свежего, а не `expired` первого в
    // массиве: иначе предъявитель выбирал бы, какой упрёк арбитр прочитает.
    expect(vf.messages.map(m => m.attestation)).toEqual(vs.messages.map(m => m.attestation));
    expect(vf.messages.map(m => m.attestation)).toEqual(['absent', 'absent', 'absent', 'absent']);
    // Слова при этом читаются: годного заверения нет, ключ берётся из кадра —
    // «не подтверждено» не означает «не показано».
    expect(vf.messages.map(m => m.state)).toEqual(['read', 'read', 'read', 'read']);
  }, 60_000);
});

/* ══════════════ ПУНКТ 49: у отказа своё имя ══════════════ */

describe('4в-2/49: no_session больше не один отказ на четыре беды', () => {
  it('R7: заверение просрочено — attestation_expired, а не «нет сеанса чата»', async () => {
    await bobChain();
    const stale = await attestedLongAgo(alice, ALICE_PK, YEAR_MS + 5 * 24 * 60 * 60 * 1000);
    expect(stale.signKey, 'просрочено собрано не на те ключи').toBe(aliceAtt.signKey);
    expect(stale.boxKey).toBe(aliceAtt.boxKey);
    // Сцена пункта 49 дословно: у человека всё в порядке, кроме годового срока.
    // Он переподключал кошелёк и заводил сеанс заново — и получал то же самое.
    expect(await build({ ownAttestation: stale })).toEqual({ ok: false, reason: 'attestation_expired' });
  }, 60_000);

  it('R8: заверение не про этого человека — attestation_missing; no_session остался ТОЛЬКО про сеанс', async () => {
    await bobChain();
    expect(await build({ ownAttestation: bobAttNew }))
      .toEqual({ ok: false, reason: 'attestation_missing' });
    expect(await build({ ownAttestation: { ...aliceAtt, signature: sig('ab') } }))
      .toEqual({ ok: false, reason: 'attestation_missing' });
    expect(await build({ ownAttestation: undefined as unknown as ChatKeyAttestation }))
      .toEqual({ ok: false, reason: 'attestation_missing' });
    // А сеанс — по-прежнему сеанс: на руках сеанс не того человека.
    expect(await build({ presenter: BOB, peer: L(ALICE) }))
      .toEqual({ ok: false, reason: 'no_session' });
  }, 60_000);

  it('R9: проверить нечем — attestation_unproven, и то же имя доезжает через счёт влезающих', async () => {
    await bobChain();
    // Подпись НЕ 65 байт — это ERC-1271, местной арифметикой она не проверяется
    // вовсе (`chatKeyAttestation.ts:457-462`), а клиента цепи не дали. Вердикт —
    // `absent`, «доказательства нет», и это НЕ «нет сеанса чата».
    const contractSig = ('0x' + 'ab'.repeat(80)) as `0x${string}`;
    const over = { ownAttestation: { ...aliceAtt, signature: contractSig } };
    expect(await build(over)).toEqual({ ok: false, reason: 'attestation_unproven' });
    // Единственный сегодняшний потребитель союза прокидывает имя, а не глотает.
    expect(await fittingMessageCount(inputFor(over)))
      .toEqual({ ok: false, reason: 'attestation_unproven' });
  }, 60_000);

  it('R10: имена отказа — восемь, и они записаны здесь руками', () => {
    // Ожидаемое пишется в тесте, измеряемое берётся из кода: добавится девятое
    // имя — этот замок покраснеет, а не подстроится молча.
    expect(Object.keys(BUILD_FAILURE_NAMES).sort()).toEqual([
      'arbiter_has_no_key',
      'attestation_expired',
      'attestation_missing',
      'attestation_unproven',
      'no_session',
      'nothing_selected',
      'peer_has_no_key',
      'too_large',
    ]);
  });
});
