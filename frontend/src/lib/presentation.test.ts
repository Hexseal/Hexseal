/**
 * presentation.test.ts — Задача 5 работы 4в: сборщик предъявления.
 *
 * ЧТО ЗДЕСЬ МЕРИТСЯ (по находкам разбора, §15 замысла):
 *  §15.3  диалог — ДВЕ цепочки; свой якорь честен, чужой помечен «сколько дошло»;
 *  §15.4  «не открылось» не уменьшает «скрыто» — и предъявителю нечем гадать за
 *         арбитра: поля `unopened` в объявленных числах НЕТ (исправление 7);
 *  §15.5  кадры, которые не читает сам предъявитель, — в «подготовить не удалось»,
 *         а их ЗВЕНЬЯ остаются в цепочке, иначе суммы не сходятся (исправление 8);
 *  §15.6  разовый ключ печатается на ДВОИХ: арбитру и второй стороне;
 *  §15.1  контейнер подписан ключом подписи предъявителя над каноническим видом;
 *  §15.2  этот ключ заверен кошельком, и заверение лежит внутри;
 *  §15.7  без ключа арбитра в цепи — отказ с названной причиной; род и dealId внутри.
 *
 * ⚠️ АРХИВ ВРЁТ ПОЛЕМ. Чужие кадры лежат с `seq: 0` и `sentAt = uploadedAt`
 * (`usePairChat.ts:930-937`). Здесь они архивируются ИМЕННО ТАК — иначе замок
 * мерил бы удобную выдумку, а не то, что лежит на устройстве у человека.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { deriveChatKeypair, openSealed } from './chatCrypto';
import { packEnvelope, type ChatPayload } from './chatEnvelope';
import {
  sendMessage, archiveConversationFrames, readConversationArchive,
  forgetConversationHead, readConversationHead,
  deriveLinkSigningKeypair, encodeFrame, decodeFrame, messageBodyHash, linkSignaturePreimage,
  _resetConversationMemoryForTest, _resetParseCacheForTest,
  type ArchivedFrame,
} from './chatConversation';
import { buildLink, linkHash, verifyChain, type ChainLink } from './chatChain';
import { signChatKeyAttestation, verifyChatKeyAttestation, type ChatKeyAttestation } from './chatKeyAttestation';
// ⚠️ `toOneTimeKey` — единственная законная точка клеймения байт, добытых ИЗ ПЕЧАТИ
// (исправление 1 договора). Прежний черновик приводил тип насильно
// (`as unknown as OneTimeKey`) — то есть обходил клеймо ровно там, где ключи и
// путаются: у арбитра слота конверта нет по построению.
import { openEnvelopeWithOneTimeKey, toOneTimeKey } from './chatEnvelope';
import { SEALED_ATTACHMENT_KEY_HEX_LEN } from './chatPayloadForm';
import {
  buildPresentation, canonicalPresentationBytes, b64FromBytes, bytesFromB64,
  PRESENTATION_KIND, DECLARED_COUNTS_CARRY_NO_UNOPENED, type PresentationContainer,
  toArbiterBoxKeyBytes, toPeerBoxKeyBytes,
} from './presentation';
import type { ChatSession } from './chatSession';
import { installFakeChatDisk, type FakeChatDisk } from './__stand__/fakeChatDisk';

/* ─────────────────────────── актёры ─────────────────────────── */

// Кошельки НАСТОЯЩИЕ: заверение (Задача 1) — это EIP-712 подпись кошельком, и
// подделать её строкой нельзя. Локальный аккаунт viem подписывает без сети.
const ALICE_PK = ('0x' + '11'.repeat(32)) as `0x${string}`;
const BOB_PK = ('0x' + '22'.repeat(32)) as `0x${string}`;
const ALICE = privateKeyToAccount(ALICE_PK).address;   // с контрольной суммой, как из useAccount()
const BOB = privateKeyToAccount(BOB_PK).address;
const DEAL = '0xdeadDEAD00000000000000000000000000c0ffee' as `0x${string}`;

function walletOf(pk: `0x${string}`): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(pk),
    chain: baseSepolia,
    transport: http('http://127.0.0.1:1'),   // подписи локальные, сеть не нужна
  }) as unknown as WalletClient;
}

/** Настоящая по форме ECDSA-подпись: 0x + 130 hex (65 байт). */
function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}
async function makeSession(address: `0x${string}`, seed: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig(seed)),
    address, origin: 'signature', walletKind: 'eoa', restored: true, persisted: true,
  };
}
function hex32(bytes: Uint8Array): string {
  return '0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Кадр от кого угодно кому угодно. `authorOverride` — чтобы собрать конверт с
 *  автором в AAD, отличным от отправителя звена: `null` — конверт БЕЗ автора
 *  вовсе (единственный путь получить `aad_mismatch`, см. ниже); строка —
 *  конверт с НАЗВАННЫМ, но ЧУЖИМ автором (тогда ни одна из двух проб AAD не
 *  сойдётся, и `openEnvelopeWithOneTimeKey` отдаёт `bad_key`, не
 *  `aad_mismatch` — замерено на живом коде, `chatEnvelope.ts:1042-1076`). */
async function frameFrom(
  from: ChatSession, toPub: Uint8Array, payload: ChatPayload,
  at: number, prev: ChainLink | null, authorOverride?: `0x${string}` | null,
): Promise<{ frame: Uint8Array; link: ChainLink; key: string }> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(from.keypair);
  const sender = from.address.toLowerCase() as `0x${string}`;
  const packAuthor = authorOverride === null ? undefined : (authorOverride ?? sender);
  const envelope = await packEnvelope(payload, toPub, from.keypair.publicKey, packAuthor);
  const link = buildLink(prev, messageBodyHash(signer.publicKey, envelope), sender, at);
  return {
    frame: encodeFrame({
      link,
      signature: sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey),
      signerPublicKey: signer.publicKey,
      envelope,
    }),
    link,
    key: `${ALICE.toLowerCase()}/${at}-${sender.slice(2, 6)}.bin`,
  };
}

/** Кладёт чужие кадры в архив ТАК ЖЕ, КАК ЭТО ДЕЛАЕТ ДВИЖОК: `seq: 0`,
 *  `sentAt = uploadedAt`. Врать полем — не наша прихоть, а состояние диска. */
async function archiveAsEngineDoes(frames: { frame: Uint8Array; key: string }[], from: `0x${string}`): Promise<void> {
  const rows: ArchivedFrame[] = frames.map((f, i) => ({
    key: f.key, from: from.toLowerCase() as `0x${string}`,
    seq: 0,                                   // ⚠️ ВРАНЬЁ, как в usePairChat.ts:932
    sentAt: 20_000 + i, receivedAt: 20_000 + i,
    frame: f.frame,
  }));
  await archiveConversationFrames(ALICE, BOB, rows);
}

/* ───────────────────── обычная обстановка ───────────────────── */

let disk: FakeChatDisk;
let alice: ChatSession;
let bob: ChatSession;
let arbiter: ChatSession;
let carol: ChatSession;
let aliceAtt: ChatKeyAttestation;
let bobAtt: ChatKeyAttestation;

beforeEach(async () => {
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      n++;
      return new Response(JSON.stringify({ key: `${BOB.toLowerCase()}/${5000 + n}-a1c.bin` }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
  _resetConversationMemoryForTest();
  _resetParseCacheForTest();
  disk = installFakeChatDisk();

  alice = await makeSession(ALICE, '1c3d');
  bob = await makeSession(BOB, '7f2e');
  arbiter = await makeSession('0xA4b1000000000000000000000000000000000001', 'a4b1');
  carol = await makeSession('0xCa401000000000000000000000000000000000c1', 'ca40');
  aliceAtt = await signChatKeyAttestation(walletOf(ALICE_PK), alice);
  bobAtt = await signChatKeyAttestation(walletOf(BOB_PK), bob);
});
afterEach(() => { disk.restore(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Переписка: 4 своих (0..3) + `peerTexts.length` чужих (0..N-1).
 *  Возвращает свои звенья и чужие кадры. */
async function conversation(peerTexts: string[]): Promise<{ own: ChainLink[]; peer: ChainLink[] }> {
  const own: ChainLink[] = [];
  let prev: ChainLink | null = null;
  for (const text of ['своё-раз', 'своё-два', 'своё-три', 'своё-четыре']) {
    const s = await sendMessage(alice, BOB, bob.keypair.publicKey, { text }, prev, { pass: 'v1.p' });
    prev = s.link; own.push(s.link);
  }
  const peer: ChainLink[] = [];
  const built: { frame: Uint8Array; key: string }[] = [];
  let bprev: ChainLink | null = null;
  for (const [i, text] of peerTexts.entries()) {
    const f = await frameFrom(bob, alice.keypair.publicKey, { text }, 20_000 + i, bprev);
    bprev = f.link; peer.push(f.link); built.push({ frame: f.frame, key: f.key });
  }
  await archiveAsEngineDoes(built, BOB);
  return { own, peer };
}

/** Обычный вызов сборщика: всё честно, выбор задаётся.
 *  `peer` — ОБЯЗАТЕЛЬНОЕ поле (исправление 6): архив и голова лежат под ПАРОЙ
 *  адресов, и без второго своя же копия переписки не адресуется ничем. */
async function build(selected: { seq: number; sender: `0x${string}` }[], over: Partial<Parameters<typeof buildPresentation>[0]> = {}) {
  return buildPresentation({
    dealId: DEAL, presenter: ALICE, peer: L(BOB),
    arbiterBoxKey: toArbiterBoxKeyBytes(arbiter.keypair.publicKey),
    peerBoxKey: toPeerBoxKeyBytes(bob.keypair.publicKey),
    selected, session: alice,
    ownAttestation: aliceAtt, otherAttestations: [bobAtt],
    now: () => 1_754_500_000_000,
    ...over,
  });
}
const L = (a: `0x${string}`): `0x${string}` => a.toLowerCase() as `0x${string}`;

/* ═══════════════════════ контейнер по договору ═══════════════════════ */

describe('4в-5: контейнер предъявления', () => {
  it('ЗАМЕР: предъявлено 4 из 10 — и три объявленных числа сходятся', async () => {
    // Что красит: любое расхождение в четырёх числах (§15.4-15.5) и потеря
    // рода/dealId (§15.7 — иначе арбитр не сведёт мешок с делом).
    await conversation(['чужое-0', 'чужое-1', 'чужое-2', 'чужое-3', 'чужое-4', 'чужое-5']);
    // Порядок выбора НАРОЧНО обратный: сортировка по номеру — несущая, без неё
    // verifyChain отдаёт `unordered`, то есть обвинение в подделке за порядок кнопок.
    const res = await build([
      { seq: 3, sender: ALICE }, { seq: 1, sender: ALICE },
      { seq: 5, sender: BOB }, { seq: 4, sender: BOB },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.container;

    console.info(
      `[4в-5 замер] в переписке 10 (4 своих + 6 чужих); предъявлено ${c.frames.length}; ` +
      `прочитано ${c.counts.read}, скрыто ${c.counts.hidden}, ` +
      `подготовить не удалось ${c.counts.notPrepared}; ` +
      `сумма ${c.counts.read + c.counts.hidden + c.counts.notPrepared} из 10`,
    );

    expect(c.kind).toBe(PRESENTATION_KIND);
    expect(c.dealId).toBe(L(DEAL));
    expect(c.presenter).toBe(L(ALICE));
    expect(c.issuedAt).toBe(1_754_500_000_000);
    expect(c.frames).toHaveLength(4);
    expect(c.keys).toHaveLength(4);
    // ⚠️ ТРИ числа, и `toEqual` здесь несущий: дописанное поле `unopened` красит
    // эту строку (исправление 7). Ожидаемые числа записаны РУКАМИ — 10 сообщений
    // в переписке, 4 показаны, 6 скрыты, — и сходятся в сумму без подсказки модуля.
    expect(c.counts).toEqual({ read: 4, hidden: 6, notPrepared: 0 });
    expect(c.counts.read + c.counts.hidden + c.counts.notPrepared).toBe(10);
    expect(c.notPrepared).toEqual([]);

    // Диалог — ДВЕ цепочки (§15.3), и звенья в каждой по своему отправителю.
    expect(c.chains).toHaveLength(2);
    expect(c.chains.map(ch => ch.sender)).toEqual([L(ALICE), L(BOB)]);
    expect(c.chains[0].links.map(l => l.seq)).toEqual([1, 3]);
    expect(c.chains[1].links.map(l => l.seq)).toEqual([4, 5]);
    for (const ch of c.chains) {
      expect(ch.links.every(l => l.sender === ch.sender)).toBe(true);
    }
    // Порядок кадров и печатей — тот же и единственный: сперва свои по номеру,
    // потом чужие по номеру. Он несущий: несортированный вход даёт `unordered`,
    // то есть обвинение в подделке за порядок нажатых кнопок.
    expect(c.frames.map(f => `${f.sender}#${f.seq}`)).toEqual([
      `${L(ALICE)}#1`, `${L(ALICE)}#3`, `${L(BOB)}#4`, `${L(BOB)}#5`,
    ]);
    expect(c.keys.map(k => `${k.sender}#${k.seq}`)).toEqual(c.frames.map(f => `${f.sender}#${f.seq}`));
    // Адреса внутри контейнера — в нижнем регистре, все до одного: арбитр сводит
    // мешок с делом сравнением строк, и контрольная сумма развела бы их молча.
    expect(c.frames.every(f => f.sender === f.sender.toLowerCase())).toBe(true);
    expect(c.keys.every(k => k.sender === k.sender.toLowerCase())).toBe(true);
    // Заверения кладутся ДОСЛОВНО (правка любого поля рвёт подпись кошелька).
    expect(c.attestations).toEqual([aliceAtt, bobAtt]);
  }, 60_000);

  it('архив врёт полем seq — выбор чужих сообщений идёт по разобранным байтам', async () => {
    // Что красит: сопоставление выбора по `ArchivedFrame.seq`. На диске у всех
    // шести чужих кадров `seq: 0` (usePairChat.ts:932) — по полю нашлось бы
    // максимум одно, и то не то.
    await conversation(['чужое-0', 'чужое-1', 'чужое-2', 'чужое-3']);
    const stored = await readConversationArchive(ALICE, BOB);
    const peerRows = stored.filter(f => f.from === L(BOB));
    expect(peerRows).toHaveLength(4);
    expect(peerRows.every(f => f.seq === 0)).toBe(true);           // ⚠️ вот оно, враньё
    expect(new Set(peerRows.map(f => decodeFrame(f.frame)!.link.seq))).toEqual(new Set([0, 1, 2, 3]));

    const res = await build([{ seq: 2, sender: BOB }, { seq: 3, sender: BOB }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.container.frames.map(f => f.seq)).toEqual([2, 3]);
    expect(res.container.notPrepared).toEqual([]);
    // И кадр — тот самый: разобранный номер кадра совпал с выбранным.
    for (const f of res.container.frames) {
      expect(decodeFrame(bytesFromB64(f.frame)!)!.link.seq).toBe(f.seq);
    }
  }, 60_000);

  it('дубли в выборе не удваивают контейнер, и сборка ничего не пишет на устройство', async () => {
    // Что красит: снятие дедупа (два звена с одним номером — вердикт `unordered`,
    // то есть обвинение предъявителя в подделке) и любая запись на диск: сборка
    // предъявления — чтение, она не смеет менять свою же переписку.
    await conversation(['чужое-0', 'чужое-1']);
    const before = new Map(disk.disk);
    const res = await build([
      { seq: 1, sender: BOB }, { seq: 1, sender: BOB }, { seq: 1, sender: BOB },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.container.frames).toHaveLength(1);
    expect(res.container.keys).toHaveLength(1);
    expect(res.container.counts.read).toBe(1);
    expect([...disk.disk.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, v] of before) expect(disk.disk.get(k)).toBe(v);
  }, 60_000);

  it('предъявляю только своё, заверения собеседника нет — собирается, потому что peer назван', async () => {
    // Дыра договора v1, закрытая исправлением 6: второй адрес выводился из
    // `peerAttestation` или из выбора, а случай «показываю только свои сообщения,
    // заверения собеседника у меня нет» не выводился ниоткуда — архив и голова
    // лежат под ПАРОЙ адресов. Что красит: возврат к выводу второй стороны из
    // чего попало — тогда этот вызов отказывает `nothing_selected`, то есть врёт
    // про причину: выбор был.
    await conversation(['чужое-0']);
    const res = await build([{ seq: 2, sender: ALICE }], { otherAttestations: [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.container.attestations).toEqual([aliceAtt]);
    expect(res.container.chains.map(ch => ch.sender)).toEqual([L(ALICE), L(BOB)]);
    expect(res.container.frames.map(f => f.seq)).toEqual([2]);
  }, 60_000);
});

/* ═══════════════════════ якоря по отправителю ═══════════════════════ */

describe('4в-5: якоря по отправителю (§15.3)', () => {
  it('свой якорь — из головы разговора и помечен own_head; чужой — только «сколько дошло»', async () => {
    // Что красит: единый якорь на диалог; отпечаток хвоста у ЧУЖОЙ цепочки
    // (он схлопывает «непроверенное» в пустоту словом самого предъявителя);
    // потеря пометки источника.
    await conversation(['чужое-0', 'чужое-1', 'чужое-2', 'чужое-3', 'чужое-4', 'чужое-5']);
    const head = await readConversationHead(ALICE, BOB);
    expect(head!.link.seq).toBe(3);

    const res = await build([
      { seq: 3, sender: ALICE }, { seq: 1, sender: ALICE },
      { seq: 5, sender: BOB }, { seq: 4, sender: BOB },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [own, peer] = res.container.chains;

    expect(own.anchorSource).toBe('own_head');
    expect(own.anchor).toEqual({ expectedMessageCount: 4, expectedLastHash: linkHash(head!.link) });
    expect(peer.anchorSource).toBe('as_received_by_presenter');
    // ⚠️ У ЧУЖОЙ ЦЕПОЧКИ ОТПЕЧАТКА ХВОСТА НЕТ НАМЕРЕННО.
    expect(peer.anchor).toEqual({ expectedMessageCount: 6 });
    expect(peer.anchor.expectedLastHash).toBeUndefined();

    // Свой якорь работает: показан хвост (3) — он заверен, показанное до дыры (1) нет.
    expect(verifyChain(own.links, own.anchor)).toEqual({
      ok: false, reason: 'gap', missingAfterSeq: [-1, 1], unverifiedContentAtSeq: [1],
    });
    // Чужая цепочка: тот же сплошной хвост (4,5), но заверять его нечем —
    // «непроверено ВСЁ показанное». Дай ей отпечаток — стало бы `[]`, то есть
    // «проверено» со слов предъявителя. Это и есть §15.2.
    expect(verifyChain(peer.links, peer.anchor)).toEqual({
      ok: false, reason: 'gap', missingAfterSeq: [-1], unverifiedContentAtSeq: [4, 5],
    });
  }, 60_000);

  it('головы на устройстве нет — свой якорь не выдаётся за истину', async () => {
    // Приватный режим, другая версия записи, стёртое хранилище. Что красит:
    // `expectedMessageCount: 0` (обвинение себя в подделке) и пометка own_head
    // на якоре, который головой не подтверждён.
    await conversation(['чужое-0']);
    await forgetConversationHead(ALICE, BOB);
    expect(await readConversationHead(ALICE, BOB)).toBeNull();

    const res = await build([{ seq: 3, sender: ALICE }, { seq: 1, sender: ALICE }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const own = res.container.chains[0];
    expect(own.anchorSource).toBe('as_received_by_presenter');
    expect(own.anchor).toEqual({ expectedMessageCount: 4 });   // max(seq)+1 по своим кадрам
    expect(verifyChain(own.links, own.anchor)).toEqual({
      ok: false, reason: 'gap', missingAfterSeq: [-1, 1], unverifiedContentAtSeq: [1, 3],
    });
  }, 60_000);

  it('голова отстала от архива — предъявитель не обвиняет себя в подделке', async () => {
    // Мешок ушёл, номер на диск не лёг (`persisted: false`). Что красит: снятие
    // условия «голова покрывает то, что на руках» — якорь становится 2 при
    // показанном номере 3, и verifyChain отдаёт `broken`, то есть ПОДДЕЛКУ.
    const { own } = await conversation(['чужое-0']);
    const id = `${ALICE.toLowerCase()}|${BOB.toLowerCase()}`;
    const rec = disk.disk.get(id) as { link: ChainLink };
    rec.link = own[1];                       // голова помнит только номер 1
    disk.disk.set(id, rec);
    _resetConversationMemoryForTest();
    expect((await readConversationHead(ALICE, BOB))!.link.seq).toBe(1);

    const res = await build([{ seq: 1, sender: ALICE }, { seq: 3, sender: ALICE }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const chain = res.container.chains[0];
    expect(chain.anchorSource).toBe('as_received_by_presenter');
    expect(chain.anchor).toEqual({ expectedMessageCount: 4 });
    const verdict = verifyChain(chain.links, chain.anchor);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('gap');      // умолчание, а НЕ `broken`
  }, 60_000);
});

/* ═══════════════════════ три объявленных числа ═══════════════════════ */

describe('4в-5: три объявленных числа (§15.4, §15.5)', () => {
  it('«подготовить не удалось» не уменьшает «скрыто», а звено остаётся в цепочке', async () => {
    // Кадр, чей конверт нашей парой не вскрывается (пришёл до смены ключа, беда
    // `undecryptable`). Что красит: выброшенное звено неподготовленного кадра
    // (тогда `hidden = ожидалось − звенья` даёт +1 к утаиванию за чужую поломку,
    // прямо против §11 замысла) и вычет неподготовленных ВТОРОЙ раз (тогда
    // «скрыто» занижается на их число). Раскладка — исправление 8: звено в
    // цепочке остаётся, кадр в `frames` не кладётся.
    await conversation(['чужое-0', 'чужое-1', 'чужое-2', 'чужое-3', 'чужое-4', 'чужое-5']);
    const stored = await readConversationArchive(ALICE, BOB);
    const last = stored
      .map(f => ({ f, d: decodeFrame(f.frame)! }))
      .filter(x => x.d.link.sender === L(BOB))
      .sort((a, b) => b.d.link.seq - a.d.link.seq)[0];
    // Седьмое чужое (seq 6) запечатано НЕ НА АЛИСУ — ключа ей не достать ничем.
    const orphan = await frameFrom(bob, carol.keypair.publicKey, { text: 'не для неё' }, 20_006, last.d.link);
    await archiveAsEngineDoes([{ frame: orphan.frame, key: orphan.key }], BOB);

    const res = await build([{ seq: 5, sender: BOB }, { seq: 6, sender: BOB }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.container;
    expect(c.notPrepared).toEqual([{ seq: 6, sender: L(BOB), reason: 'undecryptable' }]);
    expect(c.frames.map(f => f.seq)).toEqual([5]);
    // ⚠️ РАСКЛАДКА §15.5: кадра 6 в предъявлении нет, а ЗВЕНО 6 в цепочке есть.
    // Без него цепочка рвётся на пустом месте, и арбитр видит лишний `gap` —
    // обвинение в утаивании того, что предъявитель назвал вслух.
    expect(c.chains[1].links.map(l => l.seq)).toEqual([5, 6]);
    expect(c.frames.some(f => f.seq === 6)).toBe(false);
    // Руками: своё — 4 ожидалось, 0 звеньев → скрыто 4;
    //         чужое — 7 ожидалось, 2 звена (5 показан, 6 не подготовлен) → скрыто 5.
    expect(c.counts).toEqual({ read: 1, hidden: 9, notPrepared: 1 });
  }, 60_000);

  it('кадр, который сам предъявитель не открыл, уходит в «не удалось», а не в «прочитано»', async () => {
    // Ключ достаётся, а содержимое не открывается: у конверта в AAD другой автор
    // (`chatEnvelope.ts:306-310`). Что красит: включение кадра по одному факту
    // добычи ключа, без действия «а открылось ли им». Тогда арбитр получит кадр,
    // который не откроется, и это будет выглядеть как ЕГО поломка (§15.4).
    await conversation(['чужое-0', 'чужое-1']);
    const stored = await readConversationArchive(ALICE, BOB);
    const last = stored
      .map(f => ({ f, d: decodeFrame(f.frame)! }))
      .filter(x => x.d.link.sender === L(BOB))
      .sort((a, b) => b.d.link.seq - a.d.link.seq)[0];
    // ⚠️ ОТКЛОНЕНИЕ ОТ ЧЕРНОВИКА ПЛАНА, ЗАМЕРЕНО: черновик задачи звал сюда
    // `L(carol.address)` (конверт с ЧУЖИМ, но НАЗВАННЫМ автором). На живом коде
    // это даёт `bad_key`, а не `aad_mismatch` — обе пробы AAD внутри
    // `openEnvelopeWithOneTimeKey` мимо (ни AAD с bob, ни голый заголовок не
    // совпадают с AAD, которым запечатано «carol»). Единственный путь получить
    // `aad_mismatch` — конверт БЕЗ автора вовсе (`null`), тогда проба с bob
    // мимо, а голый заголовок совпадает — ровно случай «ключ дам, прочесть не
    // дам»: тег сошёлся, но привязки к автору, которого назвал предъявитель, у
    // конверта нет (`chatEnvelope.ts:946-958`).
    const skew = await frameFrom(
      bob, alice.keypair.publicKey, { text: 'ключ дам, прочесть не дам' },
      20_002, last.d.link, null,   // конверт БЕЗ автора в AAD
    );
    await archiveAsEngineDoes([{ frame: skew.frame, key: skew.key }], BOB);

    const res = await build([{ seq: 1, sender: BOB }, { seq: 2, sender: BOB }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.container;
    // ⚠️ Имя причины уезжает арбитру. Если Задача 2 назвала эту беду иначе —
    // краснеет здесь, и правится ВМЕСТЕ с читалкой Задачи 6, а не в одиночку.
    expect(c.notPrepared).toEqual([{ seq: 2, sender: L(BOB), reason: 'aad_mismatch' }]);
    expect(c.frames.map(f => f.seq)).toEqual([1]);
    expect(c.keys.map(k => k.seq)).toEqual([1]);
    // Звено — в цепочке, кадр — нет (исправление 8). Ключа тоже нет: печатать
    // разовый ключ сообщения, которое сам не открыл, значит выдать за прочитанное.
    expect(c.chains[1].links.map(l => l.seq)).toEqual([1, 2]);
    expect(c.counts.read).toBe(1);
  }, 60_000);

  it('ЗАМЕР §15.5: 3 + 2 + 1 = 6 — суммы сходятся, потому что звенья на месте', async () => {
    // Раскладка исправления 8 на стенде, где все числа видны целиком: шесть чужих
    // сообщений, своих нет вовсе. Показаны три, одно не подготовлено, два скрыты.
    // Что красит: выброшенное звено неподготовленного (сумма 7 — арбитру
    // объявляют больше сообщений, чем в переписке было) и вычет неподготовленного
    // второй раз (сумма 5 — «скрыто» занижено на его число).
    const built: { frame: Uint8Array; key: string }[] = [];
    let prev: ChainLink | null = null;
    for (let i = 0; i < 6; i++) {
      // Шестое (номер 5) запечатано НЕ НА АЛИСУ — ключа ей не достать ничем.
      const f = await frameFrom(
        bob, i === 5 ? carol.keypair.publicKey : alice.keypair.publicKey,
        { text: `чужое-${i}` }, 20_000 + i, prev,
      );
      prev = f.link;
      built.push({ frame: f.frame, key: f.key });
    }
    await archiveAsEngineDoes(built, BOB);
    expect(await readConversationHead(ALICE, BOB)).toBeNull();   // своих сообщений нет вовсе

    const res = await build([
      { seq: 2, sender: BOB }, { seq: 3, sender: BOB }, { seq: 4, sender: BOB }, { seq: 5, sender: BOB },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.container;

    expect(c.frames.map(f => f.seq)).toEqual([2, 3, 4]);
    expect(c.chains[1].links.map(l => l.seq)).toEqual([2, 3, 4, 5]);
    expect(c.notPrepared).toEqual([{ seq: 5, sender: L(BOB), reason: 'undecryptable' }]);
    // Своя цепочка пуста, и якорь у неё нулевой: иначе «скрыто» вобрало бы
    // сообщения, которых предъявитель не писал.
    expect(c.chains[0].links).toEqual([]);
    expect(c.chains[0].anchor.expectedMessageCount).toBe(0);
    expect(c.chains[1].anchor.expectedMessageCount).toBe(6);

    // Ожидаемые числа записаны РУКАМИ: 6 сообщений, 3 показаны, 1 не подготовлено,
    // значит скрыто 2. Ни одно из них не взято из проверяемого модуля.
    expect(c.counts).toEqual({ read: 3, hidden: 2, notPrepared: 1 });
    expect(c.counts.read + c.counts.hidden + c.counts.notPrepared).toBe(6);
    console.info(
      `[4в-5 замер §15.5] в переписке 6; прочитано ${c.counts.read} + скрыто ${c.counts.hidden} + ` +
      `не подготовлено ${c.counts.notPrepared} = ${c.counts.read + c.counts.hidden + c.counts.notPrepared}; ` +
      `звеньев в чужой цепочке ${c.chains[1].links.length}, кадров ${c.frames.length}. ` +
      'То же самое у арбитра читается как 0 + 3 + 2 + 1 = 6 (Задача 6).',
    );
  }, 60_000);

  it('«не открылось» предъявитель не угадывает — такого поля нет вовсе', async () => {
    // Что красит: поле `unopened` в объявленных числах — в любом виде, даже с
    // нулём. Предъявитель физически не может знать, что не открылось у арбитра, а
    // ноль на этом месте выглядит как измеренное число и подменяет счёт арбитра
    // словом заинтересованной стороны (исправление 7).
    await conversation(['чужое-0', 'чужое-1']);
    const res = await build([{ seq: 0, sender: BOB }, { seq: 1, sender: BOB }, { seq: 0, sender: ALICE }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const counts = res.container.counts;
    expect(Object.keys(counts).sort()).toEqual(['hidden', 'notPrepared', 'read']);
    expect('unopened' in counts).toBe(false);
    // Выбор разошёлся ровно на два: прочитано + не подготовлено.
    expect(counts.read + counts.notPrepared).toBe(3);
    // ⚠️ НАСТОЯЩИЙ замок этого правила — не строка выше, а ТИП в боевом файле:
    // `npm run type-check` тестов не видит (`tsconfig.json:exclude`), поэтому
    // проверка формы живёт в `presentation.ts` и краснеет у компилятора. Здесь —
    // только употребление этой константы, чтобы её нельзя было удалить незаметно.
    expect(DECLARED_COUNTS_CARRY_NO_UNOPENED).toBe(true);
  }, 60_000);
});

/* ═══ доработка ревью: not_in_archive / not_in_conversation — ноль тестов было ═══ */

describe('4в-5: подготовить не удалось БЕЗ звена — not_in_archive и not_in_conversation (доработка ревью)', () => {
  // ⚠️ ДО ЭТОГО КРУГА этих двух родов не проверял ни один тест: грепом по всем
  // трём файлам тестов задачи — ноль попаданий на `not_in_conversation` и
  // `not_in_archive`. Опасность именно в этом: сумма «прочитано+скрыто+
  // notPrepared» у ЭТИХ ДВУХ родов НАМЕРЕННО превышает число сообщений в
  // переписке (звена нет физически — кадра нет на устройстве вовсе, ни своего,
  // ни чужого), в отличие от `undecryptable`/`aad_mismatch` (звено остаётся в
  // цепочке, суммы сходятся день-в-день). Кто-нибудь увидит превышение, решит,
  // что это баг, и «починит» — а поведение названо вслух намеренным
  // (`presentation.ts:713-717`).

  it('выбор от третьего лица (не сторона переписки) — not_in_conversation, звена нет НИГДЕ', async () => {
    await conversation(['чужое-0', 'чужое-1']);   // own 4 (seq0..3) + peer 2 (seq0..1) = 6 сообщений
    const res = await build([
      { seq: 1, sender: ALICE },              // настоящее своё — прочитано
      { seq: 0, sender: L(carol.address) },   // третье лицо: не presenter, не peer
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.container;

    expect(c.notPrepared).toEqual([{ seq: 0, sender: L(carol.address), reason: 'not_in_conversation' }]);
    expect(c.frames.map(f => f.seq)).toEqual([1]);
    // Клеймо carol не встречается НИ В ОДНОЙ из двух цепочек (не presenter,
    // не peer) — звена нет нигде, не только среди показанных.
    expect(c.chains[0].sender).toBe(L(ALICE));
    expect(c.chains[1].sender).toBe(L(BOB));
    expect(c.chains.every(ch => ch.links.every(l => l.sender !== L(carol.address)))).toBe(true);

    // Руками: own — 4 ожидалось (голова покрывает), 1 звено (seq1) → скрыто 3;
    // peer — 2 ожидалось (архивных сообщений двое), 0 звеньев (carol —
    // не участник, ни один peer-выбор не удался) → скрыто 2.
    expect(c.counts).toEqual({ read: 1, hidden: 5, notPrepared: 1 });
    const sum = c.counts.read + c.counts.hidden + c.counts.notPrepared;
    expect(sum).toBe(7);   // на 1 БОЛЬШЕ настоящих 6 — ровно число not_in_conversation записей
    console.info(
      `[4в-5 доработка] переписка 6 (4 своих + 2 чужих); прочитано ${c.counts.read}, ` +
      `скрыто ${c.counts.hidden}, не подготовлено ${c.counts.notPrepared} (not_in_conversation); ` +
      `сумма ${sum} — намеренно на 1 больше 6.`,
    );
  }, 60_000);

  it('дыра в архиве (кадр не долетел/место кончилось) — not_in_archive, звена тоже нет', async () => {
    // Реальное сообщение существовало (номер внутри диапазона, который якорь
    // подтверждает по максимуму АРХИВНОГО номера), но кадра на устройстве нет:
    // сеть оборвалась на приёме, кончилось место, вкладку свернули до записи.
    // Дыра НАМЕРЕННО посередине (seq 2 из 0..3), а не на хвосте — иначе она бы
    // просто не попала в диапазон и не отличалась бы от «ещё не написали».
    const built: { frame: Uint8Array; key: string }[] = [];
    let prev: ChainLink | null = null;
    for (let i = 0; i < 4; i++) {
      const f = await frameFrom(bob, alice.keypair.publicKey, { text: `чужое-${i}` }, 20_000 + i, prev);
      prev = f.link;
      if (i !== 2) built.push({ frame: f.frame, key: f.key });   // ⚠️ seq 2 НЕ архивируется
    }
    await archiveAsEngineDoes(built, BOB);
    const stored = await readConversationArchive(ALICE, BOB);
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map(f => decodeFrame(f.frame)!.link.seq))).toEqual(new Set([0, 1, 3]));

    const res = await build([{ seq: 1, sender: BOB }, { seq: 2, sender: BOB }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.container;

    expect(c.notPrepared).toEqual([{ seq: 2, sender: L(BOB), reason: 'not_in_archive' }]);
    expect(c.frames.map(f => f.seq)).toEqual([1]);
    // Звена 2 нет НИГДЕ в цепочке — в отличие от `undecryptable`/`aad_mismatch`,
    // где кадр физически есть на устройстве и звено остаётся.
    expect(c.chains[1].links.map(l => l.seq)).toEqual([1]);

    // Руками: own — Алиса не писала вовсе, якорь нулевой → скрыто 0;
    // peer — максимум АРХИВНОГО номера 3 → ожидалось 4, звеньев 1 (seq1) →
    // скрыто 3.
    expect(c.chains[0].links).toEqual([]);
    expect(c.chains[0].anchor.expectedMessageCount).toBe(0);
    expect(c.chains[1].anchor.expectedMessageCount).toBe(4);
    expect(c.counts).toEqual({ read: 1, hidden: 3, notPrepared: 1 });
    const sum = c.counts.read + c.counts.hidden + c.counts.notPrepared;
    expect(sum).toBe(5);   // диапазон 4 сообщения (0,1,[дыра],3) — намеренно на 1 больше
    console.info(
      `[4в-5 доработка] дыра в архиве на seq 2; прочитано ${c.counts.read}, ` +
      `скрыто ${c.counts.hidden}, не подготовлено ${c.counts.notPrepared} (not_in_archive); ` +
      `сумма ${sum} — намеренно на 1 больше диапазона 4.`,
    );
  }, 60_000);
});

/* ═══════════════════════ ключ на двоих ═══════════════════════ */

describe('4в-5: разовый ключ печатается на двоих (§15.6)', () => {
  it('ЗАМЕР: арбитр читает сообщение, вторая сторона читает его же, третий — нет', async () => {
    // Это главный замер задачи: доказательство доходит до третьего лица.
    // Что красит: печать только на арбитра (§7 замысла к доставленным
    // предъявлениям тогда не достроить никогда) и любая перешифровка кадра.
    await conversation(['чужое-0', 'чужое-1']);
    const res = await build([{ seq: 1, sender: BOB }, { seq: 2, sender: ALICE }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.container;

    const read = async (who: ChatSession, pick: (k: typeof c.keys[number]) => string): Promise<string[]> => {
      const out: string[] = [];
      for (const k of c.keys) {
        const raw = await openSealed(who.keypair, bytesFromB64(pick(k))!);
        if (!raw) { out.push('<не открылось>'); continue; }
        const frame = c.frames.find(f => f.seq === k.seq && f.sender === k.sender)!;
        const decoded = decodeFrame(bytesFromB64(frame.frame)!)!;
        // Клеймо ставится ЕДИНСТВЕННОЙ законной точкой — `toOneTimeKey`, и она же
        // проверяет длину. Насильное приведение (`as unknown as OneTimeKey`)
        // обходило бы клеймо ровно там, где ключи и путаются: у арбитра слота
        // конверта нет по построению. Возражение принято договором v2.
        const oneTime = toOneTimeKey(raw);
        if (!oneTime) { out.push('<ключ не той длины>'); continue; }
        const opened = await openEnvelopeWithOneTimeKey(decoded.envelope, oneTime, decoded.link.sender);
        out.push(opened.ok ? (opened.payload.text ?? '') : `<${opened.reason}>`);
      }
      return out;
    };

    const byArbiter = await read(arbiter, k => k.forArbiter);
    const byPeer = await read(bob, k => k.forPeer);
    console.info(`[4в-5 замер] арбитр прочитал: ${byArbiter.join(' | ')}; вторая сторона: ${byPeer.join(' | ')}`);
    expect(byArbiter).toEqual(['своё-три', 'чужое-1']);
    expect(byPeer).toEqual(['своё-три', 'чужое-1']);

    // Третий не читает ни одной печати — печать адресная, а не «для всех».
    for (const k of c.keys) {
      expect(await openSealed(carol.keypair, bytesFromB64(k.forArbiter)!)).toBeNull();
      expect(await openSealed(carol.keypair, bytesFromB64(k.forPeer)!)).toBeNull();
    }
  }, 60_000);
});

/* ═══════════════════════ подпись контейнера ═══════════════════════ */

describe('4в-5: контейнер подписан (§15.1, §15.2)', () => {
  it('подпись сходится ключом подписи предъявителя, а он заверен кошельком', async () => {
    // Что красит: отсутствие подписи (личность предъявителя приходила бы из
    // свидетельства сервера, которому мы не верим — crypto_box_seal анонимен) и
    // подпись ключом, не заверенным кошельком (§15.2: арбитр не смог бы связать
    // ключ с адресом и обязан был бы пометить всё непроверенным).
    await conversation(['чужое-0']);
    const res = await build([{ seq: 0, sender: BOB }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.container;

    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const signer = await deriveLinkSigningKeypair(alice.keypair);
    expect(sodium.crypto_sign_verify_detached(
      bytesFromB64(c.signature)!, canonicalPresentationBytes(c), signer.publicKey,
    )).toBe(true);

    expect(await verifyChatKeyAttestation(c.attestations[0])).toBe('ok');
    expect(c.attestations[0].address.toLowerCase()).toBe(L(ALICE));
    expect(c.attestations[0].signKey.toLowerCase()).toBe(hex32(signer.publicKey));
    expect(c.attestations[0].boxKey.toLowerCase()).toBe(hex32(alice.keypair.publicKey));
  }, 60_000);

  it('подмена чисел, предъявителя или кадра рвёт подпись', async () => {
    // Что красит: канонический вид, в который не входят `counts` (тогда
    // посредник перепишет «скрыто: 0», и подпись сойдётся), `presenter`
    // (подмена предъявителя) или `frames` (подмена доказательства).
    await conversation(['чужое-0', 'чужое-1', 'чужое-2']);
    const res = await build([{ seq: 0, sender: BOB }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.container;
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const signer = await deriveLinkSigningKeypair(alice.keypair);
    const holds = (x: PresentationContainer): boolean => sodium.crypto_sign_verify_detached(
      bytesFromB64(c.signature)!, canonicalPresentationBytes(x), signer.publicKey,
    );

    expect(holds(c)).toBe(true);
    expect(holds({ ...c, counts: { ...c.counts, hidden: 0 } })).toBe(false);
    expect(holds({ ...c, presenter: L(BOB) })).toBe(false);
    expect(holds({ ...c, dealId: L(BOB) })).toBe(false);
    expect(holds({ ...c, notPrepared: [{ seq: 1, sender: L(BOB), reason: 'undecryptable' }] })).toBe(false);
    // ⚠️ ОТКЛОНЕНИЕ ОТ ЧЕРНОВИКА ПЛАНА, ЗАМЕРЕНО: черновик менял ПЕРВЫЙ символ
    // base64 на `'A'`. Первый байт любого кадра — `FRAME_VERSION = 1`
    // (`chatConversation.ts:254`), а `1 >> 2 === 0`, то есть первый символ
    // base64 кадра ВСЕГДА `'A'` — правка была NO-OP на каждом прогоне, не
    // «повезло». Флип символа вместо этого адресный: берём символ вглубь
    // строки (за пределами версии/фиксированных полей заголовка) и меняем на
    // заведомо другой.
    const flip = (s: string): string => {
      const i = 20;
      const alt = s[i] === 'A' ? 'B' : 'A';
      return s.slice(0, i) + alt + s.slice(i + 1);
    };
    expect(holds({
      ...c,
      frames: [{ ...c.frames[0], frame: flip(c.frames[0].frame) }],
    })).toBe(false);
    // ⚠️ ОТКЛОНЕНИЕ ОТ ЧЕРНОВИКА ПЛАНА, ЗАМЕРЕНО: черновик мутировал
    // `chains[0]` (СВОЮ цепочку) — в этой сцене Алиса честно звала
    // `sendMessage` четыре раза, голова покрывает архив, и `chains[0]` У НЕЁ
    // И ТАК `own_head`: подмена значением, которое уже стоит, — no-op.
    // Чужая цепочка (`chains[1]`) в этом коде НИКОГДА не бывает `own_head`
    // (полная честность её якоря — 4г, не эта задача), поэтому подмена именно
    // её — гарантированное, а не случайное расхождение с подписанным видом.
    expect(holds({
      ...c,
      chains: [c.chains[0], { ...c.chains[1], anchorSource: 'own_head' }],
    })).toBe(false);
  }, 60_000);
});

/* ═══════════════════════ отказы ═══════════════════════ */

describe('4в-5: отказы названы, а не проглочены', () => {
  it('арбитр без ключа в цепи — отказ arbiter_has_no_key', async () => {
    // §15.7: печать на нулевой ключ даёт контейнер, который не откроет НИКТО.
    // Предъявитель видел бы «сдано», арбитр — пустоту, а молчание истолковали бы
    // против предъявителя. Что красит: печать на нулевой ключ вместо отказа.
    await conversation(['чужое-0']);
    const res = await build([{ seq: 0, sender: BOB }], { arbiterBoxKey: toArbiterBoxKeyBytes(new Uint8Array(32)) });
    expect(res).toEqual({ ok: false, reason: 'arbiter_has_no_key' });
  }, 60_000);

  it('вторая сторона без ключа чата — отказ с именем peer_has_no_key, а не бросок', async () => {
    // Исправление 6 договора: `SealedOneTimeKey.forPeer` обязателен по типу, а
    // ключа второй стороны может не быть — она не заводила чат на этом устройстве,
    // либо её ключ в справочнике нулевой. Что красит: бросок `TypeError` (человек
    // посреди спора видит поломку вместо причины) и печать на нулевой ключ (она
    // выглядит как ключ и не открывается ничем, а §7 замысла тогда молча не
    // достроить никогда).
    await conversation(['чужое-0']);
    expect(await build([{ seq: 0, sender: BOB }], { peerBoxKey: toPeerBoxKeyBytes(new Uint8Array(32)) }))
      .toEqual({ ok: false, reason: 'peer_has_no_key' });
  }, 60_000);

  it('ключ не той длины и адрес не адрес — это наш баг, и он громкий', async () => {
    // Разделение намеренное: «ключа нет» — состояние мира и отказ с именем;
    // «ключ длиной 31 байт» или «peer не адрес» — мусор, который может прийти
    // только из нашего же кода. Отказ здесь врал бы про причину, поэтому громко,
    // как в openSealed на нашем мусоре (chatCrypto.ts:197-205).
    await conversation(['чужое-0']);
    await expect(build([{ seq: 0, sender: BOB }], { peerBoxKey: toPeerBoxKeyBytes(new Uint8Array(31).fill(7)) }))
      .rejects.toThrow(TypeError);
    await expect(build([{ seq: 0, sender: BOB }], { arbiterBoxKey: toArbiterBoxKeyBytes(new Uint8Array(31).fill(7)) }))
      .rejects.toThrow(TypeError);
    // `peer` теперь обязателен договором — и мусор в нём не проглатывается.
    await expect(build([{ seq: 0, sender: BOB }], { peer: 'не адрес' as `0x${string}` }))
      .rejects.toThrow(TypeError);
    await expect(build([{ seq: 0, sender: BOB }], { peer: L(ALICE) }))
      .rejects.toThrow(TypeError);
  }, 60_000);

  it('нечего предъявлять, не тот сеанс, заверение не о том адресе — три РАЗНЫХ имени', async () => {
    // Что красит: сборка контейнера, подписанного ключом, который заверением НЕ
    // накрыт (арбитр обязан будет пометить всё непроверенным — §15.2), и сборка
    // пустого предъявления, которое выглядит как «сдано».
    await conversation(['чужое-0']);
    expect(await build([])).toEqual({ ok: false, reason: 'nothing_selected' });
    // ⚠️ Вторая сторона здесь тоже переставлена: `peer` обязателен, и «предъявитель
    // BOB при паре BOB↔BOB» — это уже наш мусор, а не «не тот сеанс». Мерим ровно
    // то, что хотели: сеанс на руках чужой предъявителю.
    expect(await build([{ seq: 0, sender: BOB }], { presenter: BOB, peer: L(ALICE) }))
      .toEqual({ ok: false, reason: 'no_session' });
    // ⚠️ НЕ `no_session` (пункт 49 открытых находок): сеанс в обоих случаях
    // безупречен, беда в заверении, и лечение у неё другое — «заверить ключи», а
    // не «перезайти в чат».
    expect(await build([{ seq: 0, sender: BOB }], { ownAttestation: bobAtt }))
      .toEqual({ ok: false, reason: 'attestation_missing' });
    expect(await build([{ seq: 0, sender: BOB }], {
      ownAttestation: { ...aliceAtt, signature: sig('ab') },
    })).toEqual({ ok: false, reason: 'attestation_missing' });
  }, 60_000);
});

/* ═════════════ через сервер едет только нечитаемое (§10) ═════════════ */

describe('4в-5: открытого текста в контейнере нет', () => {
  it('содержимое не уходит ни одним полем, а кадр уезжает байт в байт', async () => {
    // Что красит: «удобное» поле payload/preview рядом с кадром — ровно тот
    // возврат доверия к серверу, от которого проект уходил с 2 августа. И
    // пересборка кадра своими руками вместо байтов с устройства: подпись
    // накрывает БАЙТЫ, и предъявлять надо их, а не свою копию.
    // ⚠️ Первое своё сообщение — С ВЛОЖЕНИЕМ, и в нём два разных секрета: адрес
    // файла на складе и запечатанный ключ вложения (368 hex, единственное hex-поле
    // всего плана — `SEALED_ATTACHMENT_KEY_HEX_LEN` Задачи 3). Без вложения строка
    // «не содержит keyHex» была бы пустой: в переписке без файлов такого поля нет
    // ни у кого, и замок сторожил бы текст, а не работу.
    const SEALED_KEY = 'ab'.repeat(SEALED_ATTACHMENT_KEY_HEX_LEN / 2);
    let prev: ChainLink | null = null;
    const payloads: ChatPayload[] = [
      {
        text: 'абрикос-пароль-77',
        file: {
          url: 'https://relay.example/files/АДРЕС-ФАЙЛА-ВИНОГРАД.bin',
          name: 'смета.pdf', size: 1234, mime: 'application/pdf',
          sealedKey: SEALED_KEY,
        },
      },
      { text: 'своё-два' }, { text: 'своё-три' }, { text: 'своё-четыре' },
    ];
    for (const payload of payloads) {
      const s = await sendMessage(alice, BOB, bob.keypair.publicKey, payload, prev, { pass: 'v1.p' });
      prev = s.link;
    }
    const f = await frameFrom(bob, alice.keypair.publicKey, { text: 'банан-секрет-88' }, 20_000, null);
    await archiveAsEngineDoes([{ frame: f.frame, key: f.key }], BOB);

    const res = await build([{ seq: 0, sender: ALICE }, { seq: 0, sender: BOB }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ⚠️ Сначала — что предъявление НЕ ПУСТО. Пустой контейнер прошёл бы все
    // проверки ниже, ничего не доказав: это ровно тот зелёный, который ничего не
    // мерит (у пустого набора «не содержит» верно всегда).
    expect(res.container.frames).toHaveLength(2);
    const json = JSON.stringify(res.container);
    expect(json).not.toContain('абрикос');
    expect(json).not.toContain('банан');
    expect(json).not.toContain('ВИНОГРАД');
    expect(json).not.toContain(SEALED_KEY);
    expect(json).not.toContain('sealedKey');
    expect(json).not.toContain('keyHex');

    const stored = await readConversationArchive(ALICE, BOB);
    for (const entry of res.container.frames) {
      const bytes = bytesFromB64(entry.frame)!;
      const onDisk = stored.find(s => {
        const d = decodeFrame(s.frame);
        return d && d.link.seq === entry.seq && d.link.sender === entry.sender;
      })!;
      expect([...bytes]).toEqual([...onDisk.frame]);   // байт в байт
    }
  }, 60_000);
});

/* ═════════════ кодировка, на которую опирается Задача 6 ═════════════ */

describe('4в-5: base64 туда и обратно', () => {
  it('любые байты переживают круг, а мусор отвергается', async () => {
    // Что красит: «снисходительный» разбор. Задача 6 читает контейнер от
    // НЕДРУГА: разбор, который на мусоре возвращает полупустой массив вместо
    // null, выдаёт мусор за доказательство.
    for (const len of [0, 1, 2, 3, 80, 193, 1000]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      const round = bytesFromB64(b64FromBytes(bytes));
      expect(round).not.toBeNull();
      expect([...round!]).toEqual([...bytes]);
    }
    expect(bytesFromB64('AAA')).toBeNull();        // длина не кратна четырём
    expect(bytesFromB64('A===')).toBeNull();       // три знака набивки
    expect(bytesFromB64('!!!!')).toBeNull();       // не тот алфавит
    expect(bytesFromB64('AAAA AAAA')).toBeNull();  // пробел внутри
  });
});
