import { describe, it, expect, vi, afterEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { PublicClient, WalletClient } from 'viem';
import * as cryptoModule from './chatCrypto';
import { deriveChatKeypair, sealForRecipient, type ChatKeypair } from './chatCrypto';
import * as envelopeModule from './chatEnvelope';
import { packEnvelope, recoverOneTimeKey, envelopeAad } from './chatEnvelope';
import {
  deriveLinkSigningKeypair, encodeFrame, messageBodyHash, linkSignaturePreimage,
  type LinkSigningKeypair,
} from './chatConversation';
import { buildLink, linkHash, type ChainLink } from './chatChain';
import * as attestationModule from './chatKeyAttestation';
import { signChatKeyAttestation, type ChatKeyAttestation } from './chatKeyAttestation';
import {
  canonicalPresentationBytes, b64FromBytes, bytesFromB64,
  PRESENTATION_KIND, PRESENTATION_MAX_BYTES,
  type PresentationContainer, type SealedOneTimeKey, type UnsignedPresentation,
} from './presentation';
import { readPresentation, MAX_PRESENTED_LINKS, REDACTED_CARRIES_NO_KEY } from './presentationRead';
import type { ChatSession } from './chatSession';
import { SEALED_ATTACHMENT_KEY_HEX_LEN, type ChatPayload } from './chatPayloadForm';

/**
 * Замки читалки арбитра (4в, Задача 6).
 *
 * ⚠️ КОНТЕЙНЕРЫ СОБИРАЮТСЯ ЗДЕСЬ РУКАМИ, а не через `buildPresentation`
 * (Задача 5) — НАМЕРЕННО. Читалку надо проверить на том, чего сборщик никогда
 * не выпустит: подделанная подпись, чужое звено внутри цепочки, ключ,
 * запечатанный не тому, кадр вне цепочек. Прогонять враждебный вход через
 * сборщик нечем.
 *
 * От расхождения фикстуры с настоящим контейнером сторожат ТРИ вещи, и все три
 * — форма, а не договорённость:
 *  1. `unsigned` объявлен как `UnsignedPresentation` Задачи 5 — смена формы
 *     контейнера ломает сборку этого файла;
 *  2. подпись ставится тем же `canonicalPresentationBytes`, которым её ставит
 *     Задача 5 — второй канонизатор разошёлся бы молча;
 *  3. байты кодируются тем же `b64FromBytes` — чужая кодировка не падает, а
 *     тихо даёт другие байты (Л-8, четырнадцатый случай класса).
 *
 * Крипто везде настоящее: пары выводит `deriveChatKeypair`, подписи звеньев —
 * libsodium, заверения — настоящая EIP-712-подпись локального аккаунта viem
 * через `signChatKeyAttestation` Задачи 1. Единственное исключение — T10, где
 * поддельное заверение собирается подписью НАПРЯМУЮ: `signChatKeyAttestation`
 * на чужом кошельке бросает, и через неё эту фикстуру не собрать.
 *
 * ⚠️ ОДНО СООБЩЕНИЕ СОБИРАЕТСЯ В ОБХОД `packEnvelope` — старой формы, с открытым
 * ключом вложения внутри содержимого (`packLegacyEnvelope` ниже, Л-11). Боевой
 * путь такого больше не производит вовсе: после Задачи 3 ключ вложения всегда
 * уезжает в `sealedKey`. Через `packEnvelope` признак `legacyAttachmentExposed`
 * был бы `false` ВСЕГДА, и замок на него сторожил бы текст.
 *
 * ⚠️ `vi.spyOn` по модулю-пространству имён (T7, T19, T21, T24, T33, T38) — приём,
 * уже живущий в проекте: `chatEnvelope.test.ts:364` спит
 * `chatCryptoModule.openSealed`, `:565` — `chatPayloadFormModule.sanitizePayload`.
 * Если он однажды перестанет работать, эти замки упадут громко, а не позеленеют
 * молча. Считать вызовы приходится не из любви к числам: «отвергли до
 * крипто-работы» — утверждение о СТОИМОСТИ, и проверяется он числом обращений, а
 * не вердиктом.
 */

const DEAL = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const;

// ⚠️ НАХОДКА ИСПОЛНИТЕЛЯ (не по вкусу — замерено). Договор ожидает `p.a.lower <
// p.b.lower` («ДОПУЩЕНИЕ ФИКСТУРЫ, названное вслух» у T8) и называет это
// канарейкой на смену ключей. Для констант плана как есть (0x11…11 / 0x22…22)
// эта канарейка ЛОЖНАЯ: реальные адреса — 0x19e7… у 0x11…11 и 0x1563… у
// 0x22…22, то есть `p.a.lower > p.b.lower` — сама канарейка была не прогнана
// на настоящей крипто. Держались на этом допущении T8, T9, T25, T27, T28, T29,
// T30 — семь из тридцати восьми замков. Правка ниже — минимальная: значения
// PK_A/PK_B поменяны местами (роли/маркеры/сигонэйчеры не тронуты), так что
// присвоенный роли «А» (предъявитель, autor двух сообщений) адрес оказывается
// МЕНЬШЕ адреса роли «Б» — ровно то, что канарейка утверждает и что
// предполагают все зависимые сравнения ниже. Возражение — в отчёте задачи.
const PK_A = ('0x' + '22'.repeat(32)) as `0x${string}`;
const PK_B = ('0x' + '11'.repeat(32)) as `0x${string}`;
const PK_C = ('0x' + '33'.repeat(32)) as `0x${string}`; // посторонний кошелёк

/** Настоящая по форме ECDSA-подпись: 0x + 130 hex (65 байт). `deriveChatKeypair`
 *  проверяет форму на исполнении. Приём тот же, что в 21 тестовом файле проекта. */
function sigOf(marker: string): `0x${string}` {
  const body = marker.repeat(130).slice(0, 130).replace(/[^0-9a-f]/g, 'a');
  return `0x${body}` as `0x${string}`;
}

async function sodium() {
  const s = (await import('libsodium-wrappers')).default;
  await s.ready;
  return s;
}

interface Actor {
  session: ChatSession;
  client: WalletClient;
  address: `0x${string}`;
  lower: `0x${string}`;
}

/** Кошелёк, умеющий ровно то, что нужно заверению: подписать типизированные данные
 *  локально, без сети. `createWalletClient` не заводим — транспорт здесь не нужен
 *  и не должен быть нужен. */
async function actorOf(pk: `0x${string}`, marker: string): Promise<Actor> {
  const account = privateKeyToAccount(pk);
  const client = {
    account,
    getAddresses: async () => [account.address],
    signTypedData: (args: unknown) => account.signTypedData(args as never),
    signMessage: (args: unknown) => account.signMessage(args as never),
  } as unknown as WalletClient;
  const keypair = await deriveChatKeypair(sigOf(marker));
  return {
    session: { keypair, address: account.address, origin: 'signature', walletKind: 'eoa', restored: true, persisted: true },
    client,
    address: account.address,
    lower: account.address.toLowerCase() as `0x${string}`,
  };
}

interface Forged {
  link: ChainLink;
  frame: Uint8Array;
  envelope: Uint8Array;
  oneTime: Uint8Array;
}

/**
 * ⚠️ КОНВЕРТ СТАРОЙ ФОРМЫ, СОБРАННЫЙ РУКАМИ. **Боевой путь такого больше не
 * производит**, потому и собрано руками: после Задачи 3 `packEnvelope` уносит
 * ключ вложения в `sealedKey` ВСЕГДА, значит через неё `legacyAttachmentExposed`
 * равен `false` всегда, и замок на него сторожил бы текст, а не работу (Л-11).
 *
 * Собирается ровно так, как собирал прежний код (`chatEnvelope.ts`):
 * заголовок 173 = версия 1 | слот получателя 80 | свой слот 80 | вектор 12,
 * дальше AES-256-GCM над JSON содержимого, AAD — заголовок ЦЕЛИКОМ плюс адрес
 * автора (`envelopeAad`, вывезена наружу и берётся отсюда, а не переписывается).
 * Смещения записаны руками, потому что модуль их не вывозит; разъедется
 * раскладка — сцена перестанет открываться и T30 упадёт громко.
 */
async function packLegacyEnvelope(
  payload: ChatPayload, recipientPub: Uint8Array, ownPub: Uint8Array, author: `0x${string}`,
): Promise<Uint8Array> {
  const oneTime = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = new Uint8Array(173);
  header[0] = 1;
  header.set(await sealForRecipient(recipientPub, oneTime), 1);
  header.set(await sealForRecipient(ownPub, oneTime), 81);
  header.set(iv, 161);
  const key = await crypto.subtle.importKey('raw', oneTime, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: envelopeAad(header, author) },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  ));
  const out = new Uint8Array(header.length + ciphertext.length);
  out.set(header, 0);
  out.set(ciphertext, header.length);
  return out;
}

/** Выбор пути НЕ по вкусу: содержимое с открытым ключом вложения `packEnvelope`
 *  после Задачи 3 либо переделает (ключ уедет в `sealedKey`), либо отвергнет.
 *  Всё остальное собирается настоящим боевым сборщиком. */
const isLegacyForm = (p: ChatPayload): boolean =>
  p.file !== undefined && (p.file.keyHex !== undefined || p.file.ivHex !== undefined);

/** Настоящая цепочка настоящих кадров. `signer` можно подменить — так делаются
 *  фикстуры «подписано не заверенным ключом». */
async function forgeChain(
  from: Actor,
  toPub: Uint8Array,
  payloads: ChatPayload[],
  opts: { signer?: LinkSigningKeypair } = {},
): Promise<{ signer: LinkSigningKeypair; items: Forged[] }> {
  const signer = opts.signer ?? (await deriveLinkSigningKeypair(from.session.keypair));
  const s = await sodium();
  const items: Forged[] = [];
  let prev: ChainLink | null = null;
  for (const [i, payload] of payloads.entries()) {
    const envelope = isLegacyForm(payload)
      ? await packLegacyEnvelope(payload, toPub, from.session.keypair.publicKey, from.lower)
      : await packEnvelope(payload, toPub, from.session.keypair.publicKey, from.lower);
    const link = buildLink(prev, messageBodyHash(signer.publicKey, envelope), from.lower, 1_754_400_000_000 + i * 1000);
    const frame = encodeFrame({
      link,
      signature: s.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey),
      signerPublicKey: signer.publicKey,
      envelope,
    });
    // Разовый ключ добывается ЕДИНСТВЕННОЙ существующей дорогой — Задачей 2.
    // Автор открывает слот B своей парой, предъявитель чужое сообщение — слотом A;
    // `recoverOneTimeKey` пробует оба, читалке разницы нет.
    // ⚠️ `await` НЕСУЩИЙ, а не украшение: функция асинхронна безусловно
    // (libsodium — только динамическим импортом). Без `await` проверка ниже
    // получила бы `Promise` — всегда истинный — и «ключ не добылся» не смогло бы
    // упасть НИКОГДА. Это пятнадцатый случай того же класса.
    const oneTime = await recoverOneTimeKey(envelope, from.session.keypair);
    if (!oneTime) throw new Error('фикстура: разовый ключ не добылся');
    items.push({ link, frame, envelope, oneTime });
    prev = link;
  }
  return { signer, items };
}

/** ⚠️ Кодировка — base64 БЕЗ `0x`, и печатается она ТЕМ ЖЕ помощником, которым
 *  печатает Задача 5 (Л-8). Своего кодировщика в этом файле нет ни одного. */
async function sealKeys(items: Forged[], sender: `0x${string}`, arbPub: Uint8Array, peerPub: Uint8Array): Promise<SealedOneTimeKey[]> {
  const out: SealedOneTimeKey[] = [];
  for (const it of items) {
    out.push({
      seq: it.link.seq,
      sender,
      forArbiter: b64FromBytes(await sealForRecipient(arbPub, it.oneTime)),
      forPeer: b64FromBytes(await sealForRecipient(peerPub, it.oneTime)),
    });
  }
  return out;
}

function framesOf(items: Forged[], sender: `0x${string}`): PresentationContainer['frames'] {
  return items.map(it => ({ seq: it.link.seq, sender, frame: b64FromBytes(it.frame) }));
}

async function sign(
  unsigned: UnsignedPresentation,
  signer: LinkSigningKeypair,
): Promise<PresentationContainer> {
  const s = await sodium();
  return {
    ...unsigned,
    signature: b64FromBytes(s.crypto_sign_detached(canonicalPresentationBytes(unsigned), signer.privateKey)),
  };
}

const FILE_MARKERS = {
  /** ⚠️ НАСТОЯЩИЙ hex, а не строка-маркер, и это не косметика (Л-11, первая
   *  находка): ключ и вектор старой формы проходят сверку формы Задачи 3 —
   *  32 и 12 байт СТРОЧНОГО hex, — а маркер `'ЛЕГАСИ-КЛЮЧ-…'` заставлял
   *  заготовку БРОСАТЬ, и ни один замок файла не исполнялся вовсе.
   *  Различимость даёт сам вид числа: такой строки в выдаче не может быть ни
   *  при какой редактуре. В `text` маркер НЕ кладётся нарочно: текст в выдаче
   *  показывается, и замок «его нет наружу» краснел бы на честном поведении;
   *  наглядность здесь даёт имя поля и сверка формы рядом (T30). */
  keyHex:    '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0', // 64 hex = 32 байта
  ivHex:     '0badc0ffee0badc0ffee0bad',                                         // 24 hex = 12 байт
  /** ⚠️ 368 строчных hex БЕЗ `0x` — единственное hex-поле замысла (Л-8).
   *  Число записано РУКАМИ; равенство с константой Задачи 3 сверяется в T37. */
  sealedKey: 'ab'.repeat(184),
  url:       'https://relay.example/files/СЕКРЕТНЫЙ-АДРЕС.bin',
  fileKey:   'СЕКРЕТНЫЙ-КЛЮЧ-ФАЙЛА.bin',
} as const;

/** Старая форма: ключ вложения лежал В СОДЕРЖИМОМ открытым (`keyHex`/`ivHex`).
 *  Собирается только `packLegacyEnvelope` — боевой путь такого больше не
 *  производит (Л-11). */
const FILE_PAYLOAD: ChatPayload = {
  text: 'смета в файле',
  file: {
    url: FILE_MARKERS.url,
    name: 'смета.pdf',
    size: 4096,
    keyHex: FILE_MARKERS.keyHex,
    ivHex: FILE_MARKERS.ivHex,
    fileKey: FILE_MARKERS.fileKey,
    mime: 'application/pdf',
    chunked: false,
  },
  dealId: DEAL,
};

/** Новая форма: ключ вложения запечатан (`sealedKey`), открытого нет вовсе. */
const SEALED_FILE_PAYLOAD: ChatPayload = {
  text: 'смета в файле, ключ под замком',
  file: {
    url: FILE_MARKERS.url,
    name: 'смета-2.pdf',
    size: 8192,
    sealedKey: FILE_MARKERS.sealedKey,
    mime: 'application/pdf',
    chunked: false,
  },
  dealId: DEAL,
};

const A_TEXTS: ChatPayload[] = [
  { text: 'сроки я двигал по твоей просьбе', dealId: DEAL },
  FILE_PAYLOAD,
];
const B_TEXTS: ChatPayload[] = [{ text: 'да ты фигню намутил', dealId: DEAL }];

interface Parts {
  arbiter: ChatKeypair;
  a: Actor;
  b: Actor;
  aSigner: LinkSigningKeypair;
  bSigner: LinkSigningKeypair;
  aItems: Forged[];
  bItems: Forged[];
  unsigned: UnsignedPresentation;
}

/** Честное предъявление: обе цепочки целиком, оба заверения годные, ключи
 *  запечатаны арбитру и собеседнику. Тесты портят по одному месту и подписывают
 *  заново. */
async function parts(opts: {
  aSigner?: LinkSigningKeypair; bSigner?: LinkSigningKeypair; aPayloads?: ChatPayload[];
} = {}): Promise<Parts> {
  const arbiter = await deriveChatKeypair(sigOf('9'));
  const a = await actorOf(PK_A, '1');
  const b = await actorOf(PK_B, '2');

  const forgedA = await forgeChain(a, b.session.keypair.publicKey, opts.aPayloads ?? A_TEXTS, { signer: opts.aSigner });
  const forgedB = await forgeChain(b, a.session.keypair.publicKey, B_TEXTS, { signer: opts.bSigner });

  const attA = await signChatKeyAttestation(a.client, a.session);
  const attB = await signChatKeyAttestation(b.client, b.session);

  const unsigned: UnsignedPresentation = {
    kind: PRESENTATION_KIND,
    dealId: DEAL,
    presenter: a.lower,
    attestations: [attA, attB],
    chains: [
      {
        sender: a.lower,
        links: forgedA.items.map(i => i.link),
        anchor: { expectedMessageCount: forgedA.items.length, expectedLastHash: linkHash(forgedA.items[forgedA.items.length - 1].link) },
        anchorSource: 'own_head',
      },
      {
        sender: b.lower,
        links: forgedB.items.map(i => i.link),
        anchor: { expectedMessageCount: forgedB.items.length, expectedLastHash: linkHash(forgedB.items[forgedB.items.length - 1].link) },
        anchorSource: 'as_received_by_presenter',
      },
    ],
    frames: [...framesOf(forgedA.items, a.lower), ...framesOf(forgedB.items, b.lower)],
    keys: [
      ...(await sealKeys(forgedA.items, a.lower, arbiter.publicKey, b.session.keypair.publicKey)),
      ...(await sealKeys(forgedB.items, b.lower, arbiter.publicKey, a.session.keypair.publicKey)),
    ],
    // ⚠️ ТРИ числа, не четыре: `unopened` в контейнере быть НЕ МОЖЕТ —
    // предъявитель не арбитр (`DeclaredCounts`, Л-3). Значения читалка не читает
    // ни разу, поэтому в сценах ниже они нарочно остаются прежними и врут.
    counts: { read: 3, hidden: 0, notPrepared: 0 },
    notPrepared: [],
    issuedAt: 1_754_400_100_000,
  };

  return { arbiter, a, b, aSigner: forgedA.signer, bSigner: forgedB.signer, aItems: forgedA.items, bItems: forgedB.items, unsigned };
}

/** Годное по форме, но бессмысленное звено — для замков на потолки. */
function junkLinks(n: number, sender: `0x${string}`): ChainLink[] {
  const out: ChainLink[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      seq: i,
      prevHash: ('0x' + '11'.repeat(32)) as `0x${string}`,
      bodyHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
      sender,
      sentAt: 1000 + i,
    });
  }
  return out;
}

afterEach(() => { vi.restoreAllMocks(); });

// ─────────────────────────── мусор и форма контейнера ───────────────────────────

describe('контейнер: мусор даёт вердикт, а не падение', () => {
  it('T1: семь видов мусора — malformed, ни одного броска, прототип не отравлен', async () => {
    const arbiter = await deriveChatKeypair(sigOf('9'));
    const junk: unknown[] = [
      null,
      undefined,
      'предъявление',
      42,
      [],
      {},
      JSON.parse('{"__proto__":{"polluted":true},"kind":"hexseal.presentation.v1"}'),
    ];
    for (const value of junk) {
      const view = await readPresentation(value, arbiter);
      expect(view.container).toBe('malformed');
      expect(view.messages).toEqual([]);
      expect(view.perSender).toEqual([]);
      expect(view.notPrepared).toEqual([]);
      expect(view.counts).toEqual({ read: 0, unopened: 0, hidden: 0, notPrepared: 0 });
      // Это не контейнер — значит и заявлять ему нечего: ни сделки, ни
      // предъявителя, ни времени (§15.9 выдачи: `dealId`/`presenter`/`issuedAt`
      // есть только у того, что прошло гейт формы).
      expect(view.dealId).toBeUndefined();
      expect(view.presenter).toBeUndefined();
      expect(view.issuedAt).toBeUndefined();
    }
    expect((({}) as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('T2: род не тот и подпись не той длины — malformed (§15.7: предъявление надо УЗНАТЬ)', async () => {
    // Род записан РУКАМИ: взятый из проверяемого модуля, он сравнивал бы значение
    // с самим собой. Смена боевой константы обязана КРАСНИТЬ этот замок.
    expect(PRESENTATION_KIND).toBe('hexseal.presentation.v1');

    const p = await parts();
    const c = await sign(p.unsigned, p.aSigner);
    const wrongKind = { ...c, kind: 'hexseal.presentation.v2' };
    expect((await readPresentation(wrongKind, p.arbiter)).container).toBe('malformed');

    // Подпись — base64 БЕЗ `0x`, ровно 88 знаков (64 байта Ed25519); число
    // записано руками. Не та длина — это НЕ «подпись не сошлась», а «форма не та»:
    // сойтись ей не с чем, и звать это `bad_signature` значило бы обвинить
    // предъявителя в подделке там, где он просто прислал другую структуру.
    expect(c.signature).toHaveLength(88);
    expect((await readPresentation({ ...c, signature: c.signature.slice(0, -4) }, p.arbiter)).container).toBe('malformed');
  });

  it('T3: два заверения на один адрес — malformed (нельзя «купить» удобный вердикт)', async () => {
    const p = await parts();
    const [attA, attB] = p.unsigned.attestations;
    const twin: ChatKeyAttestation = { ...attA, signature: attB.signature };
    const c = await sign({ ...p.unsigned, attestations: [attA, twin, attB] }, p.aSigner);
    expect((await readPresentation(c, p.arbiter)).container).toBe('malformed');
  });

  it('T4: кадр, которого нет ни в одной цепочке — malformed (лишнее не показываем молча)', async () => {
    const p = await parts();
    const extra = { seq: 99, sender: p.a.lower, frame: b64FromBytes(p.aItems[0].frame) };
    const c = await sign({ ...p.unsigned, frames: [...p.unsigned.frames, extra] }, p.aSigner);
    expect((await readPresentation(c, p.arbiter)).container).toBe('malformed');
  });

  it('T5: звено чужого отправителя внутри цепочки — malformed (verifyChain этого не проверяет НИ РАЗУ)', async () => {
    const p = await parts();
    const chains = structuredClone(p.unsigned.chains);
    chains[0].links[1] = { ...chains[0].links[1], sender: p.b.lower };
    const c = await sign({ ...p.unsigned, chains }, p.aSigner);
    expect((await readPresentation(c, p.arbiter)).container).toBe('malformed');
  });

  it('T6: третья цепочка — malformed (переписка по сделке всегда на двоих)', async () => {
    const p = await parts();
    const third = await actorOf(PK_C, '4');
    const chains = [...p.unsigned.chains, {
      sender: third.lower,
      links: junkLinks(1, third.lower),
      anchor: { expectedMessageCount: 1 },
      anchorSource: 'as_received_by_presenter' as const,
    }];
    const c = await sign({ ...p.unsigned, chains }, p.aSigner);
    expect((await readPresentation(c, p.arbiter)).container).toBe('malformed');
  });

  it('T7: потолок звеньев — 5000 судится, 5001 отвергается целиком и БЕЗ крипто-работы', async () => {
    // Число записано РУКАМИ: потолок, взятый из проверяемого модуля, доказывал бы
    // только «какой-то потолок есть» (та же находка, что у MAX_ENVELOPE_BYTES).
    expect(MAX_PRESENTED_LINKS).toBe(5000);

    const p = await parts();
    const build = async (n: number) => sign({
      ...p.unsigned,
      chains: [{ sender: p.a.lower, links: junkLinks(n, p.a.lower), anchor: { expectedMessageCount: n }, anchorSource: 'own_head' as const }],
      frames: [],
      keys: [],
    }, p.aSigner);

    const atCap = await readPresentation(await build(5000), p.arbiter);
    expect(atCap.container).toBe('ok');
    expect(atCap.perSender[0].verdict).toEqual({ ok: false, reason: 'broken', atSeq: 0 });

    // ⚠️ «Отвергается ДО крипто-работы» — утверждение о СТОИМОСТИ, и мерится оно
    // числом обращений, а не вердиктом (иначе это просто слова в комментарии).
    // Шпионы ставятся ПОСЛЕ сборки сцены: фикстура вскрывает мешки сама.
    const unseal = vi.spyOn(cryptoModule, 'openSealed');
    const open = vi.spyOn(envelopeModule, 'openEnvelopeWithOneTimeKey');
    expect((await readPresentation(await build(5001), p.arbiter)).container).toBe('malformed');
    expect(unseal).toHaveBeenCalledTimes(0);
    expect(open).toHaveBeenCalledTimes(0);
  });
});

// ─────────────────────────── подпись контейнера ───────────────────────────

describe('подпись контейнера проверяется САМА (§15.1)', () => {
  it('T8: честное предъявление читается целиком — те самые слова', async () => {
    const p = await parts();
    // ⚠️ ДОПУЩЕНИЕ ФИКСТУРЫ, названное вслух: порядок выдачи — по отправителю, и
    // ожидаемые массивы ниже написаны в расчёте на «А раньше Б». Если ключи
    // фикстуры сменятся и адреса поменяются местами, падёт ЭТА строка, а не пять
    // непонятных сравнений — и падение будет читаться как «сменилась фикстура», а
    // не «читалка перестала упорядочивать».
    expect(p.a.lower < p.b.lower).toBe(true);

    const view = await readPresentation(await sign(p.unsigned, p.aSigner), p.arbiter);

    expect(view.container).toBe('ok');
    expect(view.messages.map(m => `${m.sender}#${m.seq}:${m.state}`)).toEqual([
      `${p.a.lower}#0:read`, `${p.a.lower}#1:read`, `${p.b.lower}#0:read`,
    ]);
    expect(view.messages.map(m => m.payload?.text)).toEqual([
      'сроки я двигал по твоей просьбе', 'смета в файле', 'да ты фигню намутил',
    ]);
    expect(view.messages.every(m => m.attestation === 'ok')).toBe(true);
    expect(view.messages.every(m => m.frame.ok)).toBe(true);
    expect(view.messages.every(m => m.reason === undefined)).toBe(true);
    expect(view.counts).toEqual({ read: 3, unopened: 0, hidden: 0, notPrepared: 0 });
    expect(view.notPrepared).toEqual([]);
    // Заявленная шапка доезжает: без неё арбитр не знает, о какой сделке речь и
    // кто принёс. Утверждать о ней читалка ничего не утверждает (см. «НЕ делает»).
    expect(view.dealId).toBe(DEAL);
    expect(view.presenter).toBe(p.a.lower);
    expect(view.issuedAt).toBe(1_754_400_100_000);
    // Метка сделки — ЗАЯВЛЕНИЕ автора, но заявление подписанное: доезжает как есть.
    expect(view.messages[0].payload?.dealId).toBe(DEAL);
    // Факт вложения виден, ключа нет.
    expect(view.messages[1].payload?.file).toEqual({ name: 'смета.pdf', size: 4096, mime: 'application/pdf', chunked: false });
    // ⚠️ «У этого вложения ключ лежал открытым» — НАЗВАНО, а не только снято:
    // второе сообщение старой формы (keyHex/ivHex), два других — без вложения.
    // Оговорка §5 («защита только у сообщений после правки формы») доходит до
    // арбитра сама, а не остаётся в документации.
    expect(view.messages.map(m => m.legacyAttachmentExposed)).toEqual([false, true, false]);
  });

  it('T9: подпись контейнера подделана — bad_signature, вердикты видны, ни одного слова наружу', async () => {
    const p = await parts();
    const c = await sign(p.unsigned, p.aSigner);
    // ⚠️ Портится ПЕРВЫЙ знак base64: он несёт шесть значащих бит нулевого байта,
    // и подпись обязана разъехаться. Порча последнего знака при `==`-выравнивании
    // могла бы задеть только неиспользуемые биты, байты остались бы теми же — и
    // замок позеленел бы молча.
    const broken = { ...c, signature: (c.signature[0] === 'X' ? 'Y' : 'X') + c.signature.slice(1) };

    const view = await readPresentation(broken, p.arbiter);
    expect(view.container).toBe('bad_signature');

    // ⚠️ ВЕРДИКТЫ НЕ СТЁРТЫ (Л-10). Кто предъявил — неизвестно, поэтому
    // содержимое могло быть сочинено целиком и наружу не идёт. Но вердикты кадров
    // и заверений самопроверяемы и от подписи контейнера не зависят вовсе.
    expect(view.messages.map(m => `${m.sender}#${m.seq}:${m.state}`)).toEqual([
      `${p.a.lower}#0:unopened`, `${p.a.lower}#1:unopened`, `${p.b.lower}#0:unopened`,
    ]);
    expect(view.messages.every(m => m.frame.ok === true)).toBe(true);
    expect(view.messages.every(m => m.attestation === 'ok')).toBe(true);
    expect(view.messages.every(m => m.payload === undefined)).toBe(true);
    // Причины ОТКРЫТИЯ нет ни у одного: вскрывать не пробовали, и выдумать ей род
    // значило бы соврать о месте отказа.
    expect(view.messages.every(m => m.reason === undefined)).toBe(true);
    // Непрочитанное не может быть «защищено»: не открыли — не знаем.
    expect(view.messages.every(m => m.legacyAttachmentExposed === false)).toBe(true);
    expect(view.perSender.map(s => s.verdict.ok)).toEqual([true, true]);
    expect(view.counts).toEqual({ read: 0, unopened: 3, hidden: 0, notPrepared: 0 });
    // Шапка ЗАЯВЛЕНА и показана — вместе с вердиктом контейнера, который прямо
    // говорит, что ничем её не подтвердили.
    expect(view.dealId).toBe(DEAL);
    expect(view.presenter).toBe(p.a.lower);

    const wire = JSON.stringify(view);
    expect(wire).not.toContain('фигню');
    expect(wire).not.toContain('сроки');
    expect(wire).not.toContain('смета.pdf');   // имя файла — тоже содержимое
  });

  it('T10: заверение предъявителя подписано ДРУГИМ кошельком — bad_signature, вердикты видны', async () => {
    const p = await parts();
    // ⚠️ Подпись ставится НАПРЯМУЮ, а не через `signChatKeyAttestation`: та берёт
    // адрес из своего же кошелька и на чужой сессии бросает — этой фикстуры ею не
    // собрать вовсе. Ключи и адрес в заверении — настоящие А, подпись —
    // постороннего кошелька, по форме годная (65 байт, 0x + 130 hex).
    const outsider = privateKeyToAccount(PK_C);
    const forged: ChatKeyAttestation = {
      ...p.unsigned.attestations[0],
      signature: await outsider.signMessage({ message: 'подпись постороннего кошелька' }),
    };
    const container = await sign({ ...p.unsigned, attestations: [forged, p.unsigned.attestations[1]] }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    expect(view.container).toBe('bad_signature');
    // Какой ИМЕННО вердикт назовёт Задача 1 — `bad_signature` или `wrong_address`
    // — читалке безразлично: «не ok» значит «контейнер не приписан никому».
    expect(view.messages.filter(m => m.sender === p.a.lower).every(m => m.attestation !== 'ok')).toBe(true);
    expect(view.messages).toHaveLength(3);
    expect(view.messages.every(m => m.state === 'unopened')).toBe(true);
    expect(view.messages.every(m => m.payload === undefined)).toBe(true);
    expect(JSON.stringify(view)).not.toContain('сроки');
  });

  it('T11: заверения предъявителя нет вовсе — absent и bad_signature (подпись нечем проверить)', async () => {
    const p = await parts();
    const container = await sign({ ...p.unsigned, attestations: [p.unsigned.attestations[1]] }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    expect(view.container).toBe('bad_signature');
    // ⚠️ `absent`, а НЕ `malformed`: «сторона не заверялась» и «заверение
    // подделано» — для арбитра разные вещи, и договор v2 их разделил.
    expect(view.messages.filter(m => m.sender === p.a.lower).map(m => m.attestation)).toEqual(['absent', 'absent']);
    expect(view.messages.filter(m => m.sender === p.b.lower).map(m => m.attestation)).toEqual(['ok']);
    expect(view.messages.every(m => m.state === 'unopened')).toBe(true);
    expect(view.messages.every(m => m.payload === undefined)).toBe(true);
  });

  it('T12: просроченное заверение предъявителя закрывает содержимое целиком', async () => {
    // ⚠️ ПОРЯДОК ЗНАЧИМ: `parts()` вызывается ДО подмены часов, иначе просроченными
    // окажутся ОБА заверения, и тест перестанет мерить то, что назван мерить.
    // Заверение подписывается «в 2001 году»: `issuedAt` уходит в подпись и правке
    // не подлежит, поэтому подменить его после подписи нельзя.
    const p = await parts();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    const stale = await signChatKeyAttestation(p.a.client, p.a.session);
    now.mockRestore();

    const container = await sign({ ...p.unsigned, attestations: [stale, p.unsigned.attestations[1]] }, p.aSigner);
    const view = await readPresentation(container, p.arbiter);
    expect(view.container).toBe('bad_signature');
    expect(view.messages.filter(m => m.sender === p.a.lower).map(m => m.attestation)).toEqual(['expired', 'expired']);
    expect(view.messages.every(m => m.state === 'unopened')).toBe(true);
    expect(view.messages.every(m => m.payload === undefined)).toBe(true);
    expect(JSON.stringify(view)).not.toContain('сроки');
  });

  it('T32: контейнер объявляет «не открылось» — malformed (предъявитель не арбитр)', async () => {
    const p = await parts();
    // `DeclaredCounts` — ТРИ числа. Четвёртое, `unopened`, может посчитать только
    // тот, кто пробовал вскрывать, то есть арбитр. Контейнер, который его
    // объявляет, выдаёт чужую работу за свою — и это не предъявление.
    const c = await sign(
      { ...p.unsigned, counts: { read: 3, unopened: 0, hidden: 0, notPrepared: 0 } } as unknown as UnsignedPresentation,
      p.aSigner,
    );
    expect((await readPresentation(c, p.arbiter)).container).toBe('malformed');
  });

  it('T33: publicClient доезжает до ОБЕИХ дверей заверения (иначе Safe не предъявит вовсе)', async () => {
    const p = await parts();
    // Настоящей ветки ERC-1271 здесь нет и быть не должно — она в Задаче 1 и в её
    // замках. Мерится РОВНО стык: прокинули ли клиент цепи. Без него два рода
    // кошельков из четырёх получают `malformed` всегда, и §1 замысла для них ложь.
    // Дверей ДВЕ, и обе надо мерить: вердикт стороны и вердикт по ключу, названному
    // кадром. У второй без клиента цепи `wrong_keys` не отличить от `malformed`.
    const spy = vi.spyOn(attestationModule, 'verifyChatKeyAttestation');
    const forKeys = vi.spyOn(attestationModule, 'verifyChatKeyAttestationForKeys');
    const publicClient = { uid: 'стенд' } as unknown as PublicClient;

    const view = await readPresentation(await sign(p.unsigned, p.aSigner), p.arbiter, publicClient);

    expect(view.container).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(2);            // по одному на заверение
    for (const call of spy.mock.calls) expect(call[1]).toBe(publicClient);

    // ⚠️ ДВА, а не три: спрашивается КАЖДЫЙ РАЗЛИЧНЫЙ названный кадром ключ, а не
    // каждое сообщение. У честного контейнера ключ на цепочку один, значит по
    // одному вопросу на сторону; у сообщений А ключ тот же, и второй раз он не
    // покупается (памятка вердиктов, замер 2). Снимут памятку — станет три, и
    // этот замок покраснеет: цена сверки на 10 000 кадров не должна быть
    // незамеченной.
    expect(forKeys).toHaveBeenCalledTimes(2);
    for (const call of forKeys.mock.calls) expect(call[2]).toBe(publicClient);
    // Ожидаемый ключ подаётся тот, который назвал КАДР, — в форме заверения
    // (`0x` + 64 строчных hex, Л-8). Свой ключ читалка сюда не подставляет.
    for (const call of forKeys.mock.calls) {
      expect((call[1] as { signKey?: string }).signKey).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

// ─────────────────────── заверения сторон: молчания нет (§15.2) ───────────────────────

describe('вердикт заверения стоит в КАЖДОМ сообщении и никогда не молчит', () => {
  it('T13: заверения собеседника нет — его слова читаются, но помечены непроверенными', async () => {
    const p = await parts();
    const container = await sign({ ...p.unsigned, attestations: [p.unsigned.attestations[0]] }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    expect(view.container).toBe('ok');
    const mine = view.messages.filter(m => m.sender === p.a.lower);
    const theirs = view.messages.filter(m => m.sender === p.b.lower);
    expect(mine.every(m => m.attestation === 'ok')).toBe(true);
    // ⚠️ `absent` — «этой стороны в заверениях нет вовсе». НЕ `malformed`: мусор
    // на месте заверения и отсутствие заверения — разные обвинения, и договор v2
    // их разделил именно потому, что арбитр решает по ним по-разному.
    expect(theirs.map(m => m.attestation)).toEqual(['absent']);
    // Пометили — но НЕ спрятали: слова видны, вердикт рядом.
    expect(theirs.map(m => m.state)).toEqual(['read']);
    expect(theirs[0].payload?.text).toBe('да ты фигню намутил');
  });

  it('T14: просроченное заверение собеседника — expired на каждом его сообщении', async () => {
    // Порядок тот же и по той же причине, что в T12: сначала честная сцена,
    // потом одно просроченное заверение.
    const p = await parts();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    const stale = await signChatKeyAttestation(p.b.client, p.b.session);
    now.mockRestore();

    const container = await sign({ ...p.unsigned, attestations: [p.unsigned.attestations[0], stale] }, p.aSigner);
    const view = await readPresentation(container, p.arbiter);

    expect(view.container).toBe('ok');
    expect(view.messages.filter(m => m.sender === p.b.lower).map(m => m.attestation)).toEqual(['expired']);
    expect(view.messages.filter(m => m.sender === p.a.lower).every(m => m.attestation === 'ok')).toBe(true);
  });

  it('T15: подделанное заверение собеседника — bad_signature на каждом его сообщении', async () => {
    const p = await parts();
    const attB = p.unsigned.attestations[1];
    // ⚠️ НАХОДКА ИСПОЛНИТЕЛЯ (замерено сценой): последний байт 65-байтной
    // подписи — признак чётности `v`, и переключение между ДВУМЯ ГОДНЫМИ его
    // значениями (0/1) не портит подпись — оно восстанавливает ДРУГОЙ, тоже
    // действительный адрес: `verifyChatKeyAttestation` честно отвечает
    // `wrong_address`, не `bad_signature` (проверено на этих самых константах).
    // «Подделанная» подпись, которая ПАДАЕТ, требует негодного признака чётности
    // (вне {0,1,27,28}) — тогда восстановление бросает, и вердикт настоящий
    // `bad_signature`. Возражение — в отчёте задачи.
    const tampered: ChatKeyAttestation = {
      ...attB,
      signature: (attB.signature.slice(0, -2) + 'ff') as `0x${string}`,
    };
    const container = await sign({ ...p.unsigned, attestations: [p.unsigned.attestations[0], tampered] }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    expect(view.container).toBe('ok');
    expect(view.messages.filter(m => m.sender === p.b.lower).map(m => m.attestation)).toEqual(['bad_signature']);
  });
});

// ─────────────────────── кадр: проверяем ЗАВЕРЕННЫМ ключом ───────────────────────

describe('кадр проверяется вынесенной проверкой, ключом ИЗ ЗАВЕРЕНИЯ', () => {
  it('T16: подпись звена поставлена не тем ключом, кадр называет заверенный — bad_signature', async () => {
    const p = await parts();
    const alien = await deriveLinkSigningKeypair(await deriveChatKeypair(sigOf('7')));
    const s = await sodium();
    const it = p.bItems[0];
    // Отпечаток тела и ключ в кадре — настоящие Б; подпись — чужая.
    const badFrame = encodeFrame({
      link: it.link,
      signature: s.crypto_sign_detached(linkSignaturePreimage(it.link), alien.privateKey),
      signerPublicKey: p.bSigner.publicKey,
      envelope: it.envelope,
    });
    const frames = p.unsigned.frames.map(f =>
      f.sender === p.b.lower && f.seq === 0 ? { ...f, frame: b64FromBytes(badFrame) } : f);
    const container = await sign({ ...p.unsigned, frames }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    const theirs = view.messages.filter(m => m.sender === p.b.lower);
    expect(theirs[0].frame).toEqual({ ok: false, reason: 'bad_signature' });
    // ⚠️ ПРОТИВОПОСТАВЛЕНИЕ T17, и оно несущее. Здесь кадр называет ИМЕННО
    // заверенный ключ — заверение к кадру придраться не может, беда в подписи:
    // `attestation` остаётся `ok`, негодна подпись. В T17 наоборот: подпись
    // сходится, а ключ назван не заверенный, и это `wrong_keys`. Один
    // `bad_signature` на оба случая склеил бы два разных обвинения.
    expect(theirs[0].attestation).toBe('ok');
    expect(theirs[0].state).toBe('unopened');
    expect(theirs[0].payload).toBeUndefined();
  });

  it('T17: цепочка собеседника подписана свежей парой — wrong_keys, и НЕ читается', async () => {
    // Ровно нападение из §15.2: три проверки, которые арбитр делает сам, проходят
    // и на цепочке, сочинённой предъявителем за собеседника свежей парой Ed25519.
    // Спасает только заверение кошельком — и только если ключ подписи берут ОТТУДА.
    const alien = await deriveLinkSigningKeypair(await deriveChatKeypair(sigOf('7')));
    const p = await parts({ bSigner: alien });
    const view = await readPresentation(await sign(p.unsigned, p.aSigner), p.arbiter);

    const theirs = view.messages.filter(m => m.sender === p.b.lower);
    expect(theirs).toHaveLength(1);
    // ⚠️ ЕДИНСТВЕННАЯ ДВЕРЬ К `wrong_keys`, и она открыта. Заверение Б само в
    // порядке (подпись кошелька верна), но кадр называет НЕ заверённый ключ —
    // вердикт добывает `verifyChatKeyAttestationForKeys` Задачи 1, своей сверки
    // байтов ключа нет ни в тесте, ни в читалке. Без этого вызова одно из семи
    // значений вердикта было бы недостижимо, а нападение приезжало бы с `ok`.
    expect(theirs[0].attestation).toBe('wrong_keys');
    expect(theirs[0].frame.ok).toBe(false);     // и кадр заверенному ключу не принадлежит
    expect(theirs[0].state).toBe('unopened');
    expect(theirs[0].payload).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('фигню');
  });

  it('T18: цепочка ПРЕДЪЯВИТЕЛЯ подписана свежей парой — контейнер ok, его слова не читаются', async () => {
    const alien = await deriveLinkSigningKeypair(await deriveChatKeypair(sigOf('7')));
    const p = await parts({ aSigner: alien });
    // Контейнер подписывается НАСТОЯЩИМ ключом подписи А (тем, что в заверении),
    // а кадры — чужим. Контейнер честен, содержимое — нет.
    const realA = await deriveLinkSigningKeypair(p.a.session.keypair);
    const view = await readPresentation(await sign(p.unsigned, realA), p.arbiter);

    // ⚠️ Вердикт КОНТЕЙНЕРА считается по заверению СТОРОНЫ (оно годное, и подпись
    // контейнера поставлена заверенным ключом), а вердикт СООБЩЕНИЯ — по ключу,
    // названному его кадром. Отсюда `ok` сверху и `wrong_keys` внизу: два разных
    // вопроса, два разных ответа, и склеивать их нельзя.
    expect(view.container).toBe('ok');
    const mine = view.messages.filter(m => m.sender === p.a.lower);
    expect(mine.every(m => m.attestation === 'wrong_keys')).toBe(true);
    expect(mine.every(m => m.frame.ok === false)).toBe(true);
    expect(mine.every(m => m.state === 'unopened')).toBe(true);
    expect(JSON.stringify(view)).not.toContain('сроки');
  });

  it('T19: ЗАЯВЛЕННОЕ звено разошлось с кадром — malformed и НИ ОДНОГО обращения к расшифровке', async () => {
    // ⚠️ ОЖИДАНИЕ ИСПРАВЛЕНО СВЕРКОЙ. Здесь портится ЗАЯВЛЕННОЕ звено, а байты
    // кадра целы: `verifyFrameEvidence` сперва сверяет заявленное с разобранным и
    // отвечает `malformed` — до всякой арифметики отпечатков. Ждать здесь
    // `body_mismatch` значило бы сторожить вердикт, которого этой сценой не
    // добыть; настоящий `body_mismatch` — T38, и он получается ТОЛЬКО порчей
    // байтов конверта ВНУТРИ кадра.
    const p = await parts();
    const spy = vi.spyOn(envelopeModule, 'openEnvelopeWithOneTimeKey');
    const chains = structuredClone(p.unsigned.chains);
    chains[1].links[0] = { ...chains[1].links[0], bodyHash: ('0x' + 'cd'.repeat(32)) as `0x${string}` };
    const container = await sign({ ...p.unsigned, chains }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    const theirs = view.messages.filter(m => m.sender === p.b.lower);
    expect(theirs[0].frame).toEqual({ ok: false, reason: 'malformed' });
    expect(theirs[0].state).toBe('unopened');
    expect(theirs[0].payload).toBeUndefined();
    // Ключ у арбитра ГОДНЫЙ — и всё равно расшифровка не оплачивается:
    // ровно два обращения, оба на годные кадры А, и ни одного на подменённое звено.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(view)).not.toContain('фигню');
    // Цепочка Б при этом получает `broken`: якорь называл другой последний хеш.
    // Здесь мерится не он — названо, чтобы падение читалось однозначно.
    expect(view.perSender.find(s => s.sender === p.b.lower)!.verdict.ok).toBe(false);
  });

  it('T38: подменены БАЙТЫ КОНВЕРТА внутри кадра — body_mismatch (единственная дорога к нему)', async () => {
    // §15.2, третья проверка арбитра: отпечаток тела считается над тем, что
    // ЛЕЖИТ В КАДРЕ, и сверяется с тем, что ОБЪЯВЛЕНО в звене. Заявленное звено
    // здесь не тронуто вовсе — испорчен последний байт шифротекста, то есть
    // ровно то, что склад мог бы подменить по дороге. Порча заявленного даёт
    // `malformed` (T19), и без этой сцены `body_mismatch` был бы вердиктом,
    // которого ни один замок не производит.
    const p = await parts();
    const spy = vi.spyOn(envelopeModule, 'openEnvelopeWithOneTimeKey');
    const tampered = Uint8Array.from(p.bItems[0].frame);
    tampered[tampered.length - 1] ^= 0xff;   // байт шифротекста, заголовок кадра цел
    const frames = p.unsigned.frames.map(f =>
      f.sender === p.b.lower && f.seq === 0 ? { ...f, frame: b64FromBytes(tampered) } : f);

    const view = await readPresentation(await sign({ ...p.unsigned, frames }, p.aSigner), p.arbiter);
    const theirs = view.messages.filter(m => m.sender === p.b.lower);
    expect(theirs[0].frame).toEqual({ ok: false, reason: 'body_mismatch' });
    expect(theirs[0].state).toBe('unopened');
    expect(theirs[0].payload).toBeUndefined();
    // Заверение Б тут ни при чём — ключ в кадре заверенный, испорчено содержимое.
    expect(theirs[0].attestation).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(view)).not.toContain('фигню');
  });

  it('T20: кадра для звена нет — frame malformed, причины ОТКРЫТИЯ нет (беда не в ключе)', async () => {
    const p = await parts();
    const frames = p.unsigned.frames.filter(f => !(f.sender === p.b.lower && f.seq === 0));
    const container = await sign({ ...p.unsigned, frames }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    const theirs = view.messages.filter(m => m.sender === p.b.lower);
    expect(theirs[0].frame).toEqual({ ok: false, reason: 'malformed' });
    expect(theirs[0].state).toBe('unopened');
    expect(theirs[0].reason).toBeUndefined();
    expect(view.counts).toEqual({ read: 2, unopened: 1, hidden: 0, notPrepared: 0 });
    // ⚠️ ПРОТИВОПОСТАВЛЕНИЕ T36: здесь кадр просто снят и НИЧЕМ не объяснён —
    // «не открылось» с негодным кадром. Названная поломка склада (`notPrepared`)
    // считается отдельным числом и в `messages` не попадает вовсе (Л-9).
    expect(view.notPrepared).toEqual([]);
  });

  it('T21: кадр не base64 и кадр толще потолка предъявления — frame malformed', async () => {
    // Потолок записан РУКАМИ: взятый из проверяемого модуля, он сравнивал бы
    // значение с самим собой (исправление 12 договора). Смена боевой константы
    // обязана краснить этот замок, а не молча переписать его смысл.
    expect(PRESENTATION_MAX_BYTES).toBe(262144);

    const p = await parts();
    const spy = vi.spyOn(envelopeModule, 'openEnvelopeWithOneTimeKey');
    const cases = ['это не base64!!!', 'A'.repeat(4 * 100_000)];
    for (const value of cases) {
      spy.mockClear();
      const frames = p.unsigned.frames.map(f =>
        f.sender === p.b.lower && f.seq === 0 ? { ...f, frame: value } : f);
      const view = await readPresentation(await sign({ ...p.unsigned, frames }, p.aSigner), p.arbiter);
      const theirs = view.messages.filter(m => m.sender === p.b.lower);
      expect(theirs[0].frame).toEqual({ ok: false, reason: 'malformed' });
      expect(theirs[0].state).toBe('unopened');
      // Кадр на 400 000 знаков не оплачивается расшифровкой: ровно два обращения,
      // оба на годные кадры А. Число, а не обещание в комментарии.
      expect(spy).toHaveBeenCalledTimes(2);
    }
  });
});

// ─────────────────────── ключи: только свой, только forArbiter ───────────────────────

describe('разовый ключ вскрывается только своей парой и только из forArbiter', () => {
  it('T22: ключа для звена нет — unopened/bad_key при ГОДНОМ кадре', async () => {
    const p = await parts();
    const keys = p.unsigned.keys.filter(k => !(k.sender === p.b.lower && k.seq === 0));
    const view = await readPresentation(await sign({ ...p.unsigned, keys }, p.aSigner), p.arbiter);

    const theirs = view.messages.filter(m => m.sender === p.b.lower);
    expect(theirs[0].frame).toEqual({ ok: true });
    expect(theirs[0].state).toBe('unopened');
    expect(theirs[0].reason).toBe('bad_key');
    expect(theirs[0].payload).toBeUndefined();
  });

  it('T23: forArbiter запечатан собеседнику, forPeer — арбитру: НЕ открылось', async () => {
    const p = await parts();
    const keys = p.unsigned.keys.map(k =>
      k.sender === p.b.lower && k.seq === 0 ? { ...k, forArbiter: k.forPeer, forPeer: k.forArbiter } : k);
    // forPeer этого сообщения запечатан на А (собеседника Б), forArbiter — на арбитра;
    // после перестановки в forArbiter лежит мешок для А.
    const view = await readPresentation(await sign({ ...p.unsigned, keys }, p.aSigner), p.arbiter);

    const theirs = view.messages.filter(m => m.sender === p.b.lower);
    expect(theirs[0].frame).toEqual({ ok: true });
    expect(theirs[0].state).toBe('unopened');
    expect(theirs[0].reason).toBe('bad_key');
    expect(JSON.stringify(view)).not.toContain('фигню');
  });

  it('T24: forArbiter не той формы — unopened/malformed, и hex тоже НЕ ТА ФОРМА', async () => {
    const p = await parts();
    const honest = p.unsigned.keys.find(k => k.sender === p.b.lower && k.seq === 0)!.forArbiter;
    // 108 знаков base64 = 80 байт мешка (32 ключа + 48 накладных). Число записано
    // РУКАМИ: сменится форма запечатывания в Задаче 5 — покраснеет здесь.
    expect(honest).toHaveLength(108);
    // ⚠️ ЧЕТЫРНАДЦАТЫЙ КЛАСС В УПОР (Л-8): те же самые байты, но hex-ом — БЕЗ
    // префикса `0x` и длиной, кратной четырём. Это важно до последнего знака:
    // с `0x` строка отвергается по алфавиту («x» не буква base64), при длине не
    // кратной четырём — по выравниванию, и оба раза класс НЕ воспроизводится, а
    // подменяется обычным мусором. Настоящий случай — строка, которая разбирается
    // УСПЕШНО и тихо даёт другие байты (проверено `bytesFromB64` тут же), и
    // ловится она гейтом ДЛИНЫ, а не разбором. Без него арбитр получил бы
    // правдоподобный `bad_key` — «предъявитель дал не тот ключ» — вместо
    // «предъявление написано не той кодировкой».
    const sealedBytes = await sealForRecipient(p.arbiter.publicKey, p.bItems[0].oneTime);
    const asHex = [...sealedBytes].map(x => x.toString(16).padStart(2, '0')).join('');
    expect(asHex).toMatch(/^[0-9a-f]{160}$/);        // 80 байт hex-ом, без 0x
    expect(asHex.length % 4).toBe(0);                // выравнивание base64 соблюдено
    expect(bytesFromB64(asHex)).not.toBeNull();      // и разбор её ПРИНИМАЕТ
    expect(bytesFromB64(asHex)!).toHaveLength(120);  // 160 знаков base64 = 120 байт ≠ 80
    // ⚠️ И самый коварный: ДЛИНА ТА ЖЕ (108 знаков), но выравнивание `==` — значит
    // 79 байт вместо 80. Один этот случай доказывает, что гейта длины СТРОКИ мало
    // и проверка длины БАЙТОВ после разбора не декоративна.
    const shortByPadding = honest.slice(0, 105) + 'A==';

    const unseal = vi.spyOn(cryptoModule, 'openSealed');
    for (const bad of ['', 'не base64!!!', 'AAAA', honest.slice(0, -4), honest + 'AAAA', asHex, shortByPadding]) {
      unseal.mockClear();
      const keys = p.unsigned.keys.map(k =>
        k.sender === p.b.lower && k.seq === 0 ? { ...k, forArbiter: bad } : k);
      const view = await readPresentation(await sign({ ...p.unsigned, keys }, p.aSigner), p.arbiter);
      const theirs = view.messages.filter(m => m.sender === p.b.lower);
      expect(theirs[0].frame).toEqual({ ok: true });   // кадр-то годный
      expect(theirs[0].state).toBe('unopened');
      expect(theirs[0].reason).toBe('malformed');
      // Мешок не той формы даже не вскрывается: ровно два вскрытия, оба на
      // годные ключи А. «Отвергается по длине, до вскрытия» — числом.
      expect(unseal).toHaveBeenCalledTimes(2);
    }
  });
});

// ─────────────────────── числа и вердикты цепочек ───────────────────────

describe('числа считает читалка, а не контейнер (§15.4)', () => {
  it('T25: контейнер врёт про счёт — выдача считает сама, и причина доезжает СЛОВАМИ', async () => {
    const p = await parts();
    // У А предъявлено 2 звена из 5 (скрыто 3), второе названо неподготовленным:
    // звено ОСТАЛОСЬ в цепочке, кадра для него нет (Л-9). У Б всё цело.
    const chains = structuredClone(p.unsigned.chains);
    chains[0].anchor = { expectedMessageCount: 5 };
    const container = await sign({
      ...p.unsigned, chains,
      frames: p.unsigned.frames.filter(f => !(f.sender === p.a.lower && f.seq === 1)),
      keys: p.unsigned.keys.filter(k => !(k.sender === p.a.lower && k.seq === 1)),
      counts: { read: 99, hidden: 0, notPrepared: 0 },
      notPrepared: [{ seq: 1, sender: p.a.lower, reason: 'кадр не нашёлся на складе' }],
    }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    expect(view.container).toBe('ok');
    expect(view.counts).toEqual({ read: 2, unopened: 0, hidden: 3, notPrepared: 1 });
    // §15.5: «с причиной». Числа мало — предъявитель окажется наказан молчанием
    // за поломку склада, а это прямо против §11.
    expect(view.notPrepared).toEqual([{ seq: 1, sender: p.a.lower, reason: 'кадр не нашёлся на складе' }]);
    // Неподготовленное звено НЕ сообщение: иначе его посчитают дважды.
    expect(view.messages.map(m => `${m.sender}#${m.seq}`)).toEqual([`${p.a.lower}#0`, `${p.b.lower}#0`]);
  });

  it('T26: «не открылось» НЕ уменьшает «скрыто»', async () => {
    const p = await parts();
    // Оба звена А предъявлены, якорь ровно 2 — СКРЫТЫХ НЕТ. Одно из двух не
    // открывается (ключ снят). «Скрыто» обязано остаться нулём.
    const keys = p.unsigned.keys.filter(k => !(k.sender === p.a.lower && k.seq === 1));
    const container = await sign({
      ...p.unsigned,
      chains: [p.unsigned.chains[0]],
      frames: p.unsigned.frames.filter(f => f.sender === p.a.lower),
      keys: keys.filter(k => k.sender === p.a.lower),
      counts: { read: 2, hidden: 0, notPrepared: 0 },
    }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    expect(view.counts).toEqual({ read: 1, unopened: 1, hidden: 0, notPrepared: 0 });
  });

  it('T34: неподготовленное звено, у которого ЕСТЬ кадр — malformed (противоречие)', async () => {
    const p = await parts();
    // «Кадр подготовить не удалось» и кадр рядом — взаимоисключающие заявления.
    // Пропустить их значило бы дать предъявителю ДВА способа посчитать одно
    // сообщение и выбирать удобный.
    const container = await sign({
      ...p.unsigned,
      notPrepared: [{ seq: 1, sender: p.a.lower, reason: 'кадр не нашёлся на складе' }],
    }, p.aSigner);
    expect((await readPresentation(container, p.arbiter)).container).toBe('malformed');
  });

  it('T35: неподготовленное — про несуществующее звено или дважды — malformed', async () => {
    const p = await parts();
    const frames = p.unsigned.frames.filter(f => !(f.sender === p.a.lower && f.seq === 1));
    const cases = [
      // Звена нет ни в одной цепочке: чистая прибавка к числу «скрыто» без якоря.
      [{ seq: 7, sender: p.a.lower, reason: 'кадр не нашёлся на складе' }],
      // Одно и то же звено дважды: раздувает число, ничего не добавляя.
      [
        { seq: 1, sender: p.a.lower, reason: 'кадр не нашёлся на складе' },
        { seq: 1, sender: p.a.lower, reason: 'и ещё раз' },
      ],
    ];
    for (const notPrepared of cases) {
      const container = await sign({ ...p.unsigned, frames, notPrepared }, p.aSigner);
      expect((await readPresentation(container, p.arbiter)).container).toBe('malformed');
    }
  });

  it('T36: стенд §15.5 — суммы сходятся: 3+0+2+1 = 6 и 0+3+2+1 = 6', async () => {
    // Числа записаны РУКАМИ и сверяются с якорем, а не берутся из модуля.
    // У А шесть сообщений всего, предъявлено четыре звена, четвёртое названо
    // неподготовленным: скрыто = 6 − 4 = 2 (Л-9), и «не открылось» этого числа
    // не касается вовсе.
    const four: ChatPayload[] = [
      { text: 'первое', dealId: DEAL }, { text: 'второе', dealId: DEAL },
      { text: 'третье', dealId: DEAL }, { text: 'четвёртое НЕ ПОДГОТОВЛЕНО', dealId: DEAL },
    ];
    const p = await parts({ aPayloads: four });

    const scene = (opts: { withKeys: boolean }) => ({
      ...p.unsigned,
      chains: [{ ...p.unsigned.chains[0], anchor: { expectedMessageCount: 6 } }],
      frames: p.unsigned.frames.filter(f => f.sender === p.a.lower && f.seq !== 3),
      keys: opts.withKeys ? p.unsigned.keys.filter(k => k.sender === p.a.lower && k.seq !== 3) : [],
      counts: { read: 99, hidden: 99, notPrepared: 99 },
      notPrepared: [{ seq: 3, sender: p.a.lower, reason: 'кадр не нашёлся на складе' }],
    });

    // Сцена 1: ключи есть — прочитано 3, не открылось 0, скрыто 2, не подготовлено 1.
    const read = await readPresentation(await sign(scene({ withKeys: true }), p.aSigner), p.arbiter);
    expect(read.counts).toEqual({ read: 3, unopened: 0, hidden: 2, notPrepared: 1 });
    expect(read.counts.read + read.counts.unopened + read.counts.hidden + read.counts.notPrepared).toBe(6);

    // Сцена 2: ключей нет вовсе — прочитано 0, не открылось 3, скрыто ТЕ ЖЕ 2.
    const blind = await readPresentation(await sign(scene({ withKeys: false }), p.aSigner), p.arbiter);
    expect(blind.counts).toEqual({ read: 0, unopened: 3, hidden: 2, notPrepared: 1 });
    expect(blind.counts.read + blind.counts.unopened + blind.counts.hidden + blind.counts.notPrepared).toBe(6);

    // Сцена 3: та же сцена с испорченной подписью контейнера — вердикты видны,
    // а СВОБОДНЫЙ ТЕКСТ неизвестного автора наружу не идёт (Л-10).
    const signed = await sign(scene({ withKeys: true }), p.aSigner);
    const broken = { ...signed, signature: (signed.signature[0] === 'X' ? 'Y' : 'X') + signed.signature.slice(1) };
    const closed = await readPresentation(broken, p.arbiter);
    expect(closed.container).toBe('bad_signature');
    // ЧИСЛО остаётся (числом ничего не насочиняешь, и суммы обязаны сходиться и
    // здесь: 0+3+2+1 = 6), а СЛОВА — нет.
    expect(closed.counts).toEqual({ read: 0, unopened: 3, hidden: 2, notPrepared: 1 });
    expect(closed.notPrepared).toEqual([]);
    expect(JSON.stringify(closed)).not.toContain('кадр не нашёлся');
  });

  it('T27: вердикт на каждого отправителя, с ЯКОРЕМ и с источником якоря', async () => {
    const p = await parts();
    const chains = structuredClone(p.unsigned.chains);
    chains[0].links = [chains[0].links[0]];                  // показано 1 из 3
    chains[0].anchor = { expectedMessageCount: 3 };
    const container = await sign({
      ...p.unsigned, chains,
      frames: p.unsigned.frames.filter(f => !(f.sender === p.a.lower && f.seq === 1)),
      keys: p.unsigned.keys.filter(k => !(k.sender === p.a.lower && k.seq === 1)),
    }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    expect(view.perSender).toEqual([
      {
        sender: p.a.lower,
        verdict: { ok: false, reason: 'gap', missingAfterSeq: [0], unverifiedContentAtSeq: [0] },
        anchorSource: 'own_head',
      },
      {
        sender: p.b.lower,
        verdict: { ok: true, unverifiedContentAtSeq: [] },
        anchorSource: 'as_received_by_presenter',
      },
    ]);
    expect(view.counts.hidden).toBe(2);
  });

  it('T28: переставленные звенья — unordered, читалка НЕ сортирует', async () => {
    const p = await parts();
    const chains = structuredClone(p.unsigned.chains);
    chains[0].links = [chains[0].links[1], chains[0].links[0]];
    const container = await sign({ ...p.unsigned, chains }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    expect(view.perSender[0].verdict).toEqual({ ok: false, reason: 'unordered' });
    expect(view.messages.filter(m => m.sender === p.a.lower).map(m => m.seq)).toEqual([1, 0]);
  });

  it('T29: негодный якорь — bad_anchor, и скрытых по нему НЕ считаем', async () => {
    const p = await parts();
    const chains = structuredClone(p.unsigned.chains);
    chains[0].anchor = { expectedMessageCount: -1 };
    const container = await sign({ ...p.unsigned, chains }, p.aSigner);

    const view = await readPresentation(container, p.arbiter);
    expect(view.perSender[0].verdict).toEqual({ ok: false, reason: 'bad_anchor' });
    expect(view.counts.hidden).toBe(0);
  });
});

// ─────────────────────── что уходит наружу ───────────────────────

describe('ключ вложения наружу не выходит ни одним байтом', () => {
  it('T30: старая форма — ни ключа, ни IV, ни адреса файла; и «ключ лежал открытым» НАЗВАНО', async () => {
    // ⚠️ ФОРМА ФИКСТУРЫ СВЕРЯЕТСЯ ЗДЕСЬ, а не подразумевается: ключ и вектор
    // старой формы обязаны быть 32 и 12 байтами СТРОЧНОГО hex, иначе сцену не
    // собрать вовсе (Задача 3 сверяет форму, а прежний маркер заставлял
    // заготовку бросать — и тогда не исполнялся ни один замок файла, Л-11).
    expect(FILE_MARKERS.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(FILE_MARKERS.ivHex).toMatch(/^[0-9a-f]{24}$/);

    const p = await parts();
    const view = await readPresentation(await sign(p.unsigned, p.aSigner), p.arbiter);
    const wire = JSON.stringify(view);

    // ⚠️ Перечислено ИМЕННО ТО, что в этой сцене есть. `Object.values(FILE_MARKERS)`
    // затянул бы сюда и `sealedKey`, которого в старой форме нет вовсе, — и замок
    // доказывал бы «этой строки в сцене не было», а не «наружу не вышла».
    // Новая форма — T37, там `sealedKey` в сцене настоящий.
    for (const marker of [FILE_MARKERS.keyHex, FILE_MARKERS.ivHex, FILE_MARKERS.url, FILE_MARKERS.fileKey]) {
      expect(wire).not.toContain(marker);
    }
    // Факт вложения при этом виден целиком.
    expect(wire).toContain('смета.pdf');
    expect(view.messages[1].payload?.file).toEqual({ name: 'смета.pdf', size: 4096, mime: 'application/pdf', chunked: false });
    // Ключ не только снят, но и НАЗВАН снятым: арбитр узнаёт, что у этого
    // сообщения замка не было (оговорка §5 доходит до него сама).
    expect(view.messages[1].legacyAttachmentExposed).toBe(true);
  });

  it('T37: новая форма — sealedKey не выходит, и «открытым не лежал» тоже названо', async () => {
    // Длина запечатанного ключа вложения записана РУКАМИ, а из Задачи 3 берётся
    // только сверяемое. Разъедется её форма — покраснеет здесь, а не молча на
    // проводе (Л-8, единственное hex-поле замысла).
    expect(SEALED_ATTACHMENT_KEY_HEX_LEN).toBe(368);
    expect(FILE_MARKERS.sealedKey).toHaveLength(SEALED_ATTACHMENT_KEY_HEX_LEN);
    expect(FILE_MARKERS.sealedKey).toMatch(/^[0-9a-f]+$/);   // без 0x, строчные

    const p = await parts({ aPayloads: [SEALED_FILE_PAYLOAD] });
    const view = await readPresentation(await sign(p.unsigned, p.aSigner), p.arbiter);
    const wire = JSON.stringify(view);

    expect(wire).not.toContain(FILE_MARKERS.sealedKey);
    expect(wire).not.toContain(FILE_MARKERS.url);
    const mine = view.messages.filter(m => m.sender === p.a.lower);
    expect(mine[0].state).toBe('read');
    expect(mine[0].payload?.file).toEqual({ name: 'смета-2.pdf', size: 8192, mime: 'application/pdf', chunked: false });
    expect(mine[0].legacyAttachmentExposed).toBe(false);
  });

  it('T31: форма, а не правило — у RedactedFilePayload полей ключа нет вовсе', () => {
    // ⚠️ ЭТО НЕ ПОВЕДЕНЧЕСКИЙ ЗАМОК. Настоящий замок стоит в БОЕВОМ файле
    // (`REDACTED_CARRIES_NO_KEY` в presentationRead.ts) и краснеет в
    // `npm run type-check`. Здесь — только напоминание, что он там есть:
    // тестовые файлы исключены из программы tsc (`tsconfig.json:exclude`),
    // замерено — заведомая ошибка типов в *.test.ts даёт ноль диагностик.
    expect(REDACTED_CARRIES_NO_KEY).toBe(true);
  });
});
