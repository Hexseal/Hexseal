/**
 * presentationStand.test.ts — 4в, сквозной замер: «сторона предъявила →
 * арбитр прочитал». Без сети, без браузера, окружение `node`.
 *
 * ЧТО ЗДЕСЬ МЕРИТСЯ ЧИСЛАМИ:
 *   T1  арбитр прочитал РОВНО выбранное, текст сошёлся ПОБАЙТОВО, вердикты
 *       цепочек и происхождение якорей — честные, четыре числа дают 6
 *       (`3+0+2+1`, раскладка исправления 8);
 *   T2  замок на ключ вложения поставил БОЕВОЙ ПУТЬ (на проводе есть
 *       `sealedKey`, открытых ключей нет), и арбитр вложение видит, но открыть
 *       не может: ни ключа в форме, ни ключа в байтах, ни расшифровки — при
 *       том что обе стороны тот же файл открывают;
 *   T3  арбитр сменил ключ посреди спора: «не открылось» ≠ «сторона молчит»,
 *       числа арбитра НЕ равны числам предъявителя (`0+3+2+1`), и типы у них
 *       разные — `unopened` у предъявителя нет вовсе;
 *   T4  подпись кадра проверяет арбитр САМ: испорченный байт подписи и
 *       испорченный байт конверта дают разные названные отказы;
 *   T5  битая подпись контейнера называется битой и содержимого не показывает,
 *       НО вердикты по кадрам и заверениям остаются (исправление 10); мусор на
 *       входе даёт вердикт, а не падение;
 *   T6  предъявление арбитру без ключа, собеседнику без ключа и предъявление
 *       пустоты — отказ с названной причиной, ДО отправки.
 *
 * ⚠️ ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ — раздел «чего этот прогон не докажет» в отчёте
 * задачи 7. Стенд, у которого не названы границы, читается как доказательство
 * того, чего он не проверял.
 *
 * ⚠️ РАСХОЖДЕНИЕ С ЗАДАНИЕМ (см. шапку `presentationStand.ts`): `arbiterBoxKey`/
 * `peerBoxKey` входа `buildPresentation` — фирменные `ArbiterBoxKeyBytes`/
 * `PeerBoxKeyBytes`, не голый `Uint8Array`. `present()` ниже клеймит байты
 * `toArbiterBoxKeyBytes`/`toPeerBoxKeyBytes` на границе вызова — единственном
 * месте, где этому файлу вообще нужно об этом знать.
 */
import { describe, it, expect } from 'vitest';
import { openSealed } from '../chatCrypto';
import { decodeFrame, FRAME_HEADER_LEN } from '../chatConversation';
import { SEALED_ATTACHMENT_KEY_HEX_LEN } from '../chatPayloadForm';
import {
  buildPresentation, bytesFromB64, b64FromBytes,
  PRESENTATION_KIND, PRESENTATION_SEAL_OVERHEAD,
  toArbiterBoxKeyBytes, toPeerBoxKeyBytes,
  type PresentationContainer,
} from '../presentation';
import { readPresentation, type PresentationView, type PresentedMessage } from '../presentationRead';
import { signChatKeyAttestation } from '../chatKeyAttestation';
import {
  DEAL_ID, TEXTS, TOTAL_MESSAGES, openAttachmentKey, startPresentationStand,
  type PresentationStand,
} from './presentationStand';

/* ─────────────────────────── мелкая утварь ─────────────────────────── */

const eq = (a?: string, b?: string): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Расшифровать AES-GCM. Отказ = отказ: тег не сходится и plaintext не рождается. */
async function aesGcm(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, data));
}

/**
 * Разобрать запечатанный разовый ключ из контейнера. Кодировка договором
 * НАЗВАНА (исправление 2): base64 без `0x`, и разбирает её `bytesFromB64` из
 * `presentation.ts` — тот же самый разбор, которым пользуется Задача 6. Своего
 * разбора base64 здесь нет намеренно: две реализации кодировки — это
 * четырнадцатый случай класса «оба зелёные, стык мёртв».
 *
 * ⚠️ `bytesFromB64` отдаёт `Uint8Array | null` (исправление F): он придирается к
 * знаку вне алфавита, к длине не кратной четырём, к трём знакам набивки и к
 * обрубку. Отказ проверяется ПЕРВОЙ строкой — иначе `b.length` дал бы
 * `TypeError` о `null` вместо названной причины, и приехавший hex читался бы как
 * «стенд сломался», а не как «кодировка разошлась».
 *
 * Длина записана РУКАМИ: 32 байта разового ключа + 48 накладных
 * `crypto_box_seal` = 80. Само равенство `PRESENTATION_SEAL_OVERHEAD === 48`
 * проверяется отдельной строкой в T1 — иначе замер сравнивал бы величину с
 * самой собой (исправление 12).
 */
function sealedOneTimeKeyBytes(s: string): Uint8Array {
  const b = bytesFromB64(s);
  if (!b) {
    throw new Error(
      `стенд: «${s.slice(0, 16)}…» (${s.length} знаков) — не base64 вовсе: ` +
      `bytesFromB64 отказал. Приехал hex, префикс 0x или обрубок?`,
    );
  }
  if (b.length !== 80) {
    throw new Error(
      `стенд: запечатанный разовый ключ ${b.length} байт (ожидалось 80 = 32 + 48), ` +
      `строка «${s.slice(0, 16)}…» (${s.length} знаков) — base64 ли это?`,
    );
  }
  return b;
}

function frameBytes(s: string): Uint8Array {
  const b = bytesFromB64(s);
  if (!b) {
    throw new Error(
      `стенд: кадр «${s.slice(0, 16)}…» (${s.length} знаков) — не base64 вовсе: ` +
      `bytesFromB64 отказал. Приехал hex, префикс 0x или обрубок?`,
    );
  }
  if (b.length <= FRAME_HEADER_LEN) {
    throw new Error(`стенд не разобрал кадр: ${b.length} байт при заголовке ${FRAME_HEADER_LEN} — не base64?`);
  }
  return b;
}

function msg(view: PresentationView, sender: string, seq: number): PresentedMessage {
  const found = view.messages.find(m => m.seq === seq && eq(m.sender, sender));
  if (!found) {
    throw new Error(
      `арбитр не показал ${sender}#${seq}; показаны: ` +
      `${view.messages.map(m => `${m.sender}#${m.seq}(${m.state})`).join(', ') || '(ничего)'}`,
    );
  }
  return found;
}

function chainOf(view: PresentationView, sender: string): PresentationView['perSender'][number] {
  const c = view.perSender.find(p => eq(p.sender, sender));
  if (!c) throw new Error(`нет вердикта по цепочке ${sender}; есть: ${view.perSender.map(p => p.sender).join(', ')}`);
  return c;
}

const sum = (c: PresentationView['counts']): number => c.read + c.unopened + c.hidden + c.notPrepared;

/** Собрать предъявление так, как его собрал бы интерфейс. */
async function present(
  stand: PresentationStand,
  over: Partial<Parameters<typeof buildPresentation>[0]> = {},
): Promise<PresentationContainer> {
  const { presenter, peer, arbiter } = stand.actors;
  const A = presenter.address;
  const B = peer.address;
  const built = await buildPresentation({
    dealId: DEAL_ID,
    presenter: A,
    // ⚠️ Вторая сторона названа ЯВНО (исправление 6 договора). Без этого поля
    // собеседника пришлось бы выводить из `selected[].sender`, и предъявление
    // «вот что я ему писал» (только свои сообщения) не нашло бы переписку
    // вовсе: и голова разговора, и архив лежат под парой `${own}|${peer}`.
    peer: B,
    // ⚠️ Клеймение на границе (см. шапку файла): вход `buildPresentation`
    // требует фирменные `ArbiterBoxKeyBytes`/`PeerBoxKeyBytes`, стенд отдаёт
    // голые байты. Перестановка этих двух строк не скомпилируется — ровно та
    // защита, ради которой клеймо заведено (см. `presentation.ts`).
    arbiterBoxKey: toArbiterBoxKeyBytes(arbiter.boxKey),
    peerBoxKey: toPeerBoxKeyBytes(peer.session.keypair.publicKey),
    // ⚠️ Выбор приходит из интерфейса, а там адреса С КОНТРОЛЬНОЙ СУММОЙ
    // (`useAccount()`), тогда как `sender` в звене всегда строчными
    // (`buildLink`, chatChain.ts). Подаём НАРОЧНО как приходит из жизни:
    // сравнение без приведения регистра обязано покраснеть здесь, а не у людей.
    selected: [
      { seq: 1, sender: A }, { seq: 2, sender: A },
      { seq: 0, sender: B }, { seq: 1, sender: B },
    ],
    session: presenter.session,
    ownAttestation: await signChatKeyAttestation(presenter.wallet, presenter.session),
    ...over,
  });
  if (!built.ok) throw new Error(`сборка предъявления отказала: ${built.reason}`);
  return built.container;
}

async function withStand<T>(body: (s: PresentationStand) => Promise<T>): Promise<T> {
  const stand = await startPresentationStand();
  try {
    return await body(stand);
  } finally {
    stand.stop();
  }
}

/**
 * Портит один кадр УЖЕ СОБРАННОГО контейнера — единственная сцена без склада,
 * в которой байтово испорченный кадр вообще может доехать до арбитра.
 *
 * ⚠️ НАХОДКА, РАЗЪЯСНЕНА В ОТЧЁТЕ ЗАДАЧИ 7. Черновик T4 портил кадр ДО того,
 * как он ляжет в архив предъявителя (`presentationStand.ts`, было
 * `FrameTamper`) — и это не работает: `buildPresentation` (Задача 5) сама
 * зовёт `verifyFrameEvidence` над каждым кандидатом ДО сборки контейнера
 * («то, что арбитр гарантированно назовёт подделкой, предъявителю предъявлять
 * незачем», `presentation.ts`), и испорченный так кадр уезжает в
 * `notPrepared` — до `container.frames` ему дойти неоткуда, замерено:
 * `container.frames.find(...)` возвращал `undefined`. Это ровно третье
 * требование из «Возражения» задания (пункт 6, третья точка), которое
 * договор v2/v3 НЕ принял, и задание само предупреждало: «разойдись Задача 5
 * — красным станет мой файл, а не её».
 *
 * Раз кадр, дошедший до `container.frames`, уже прошёл проверку предъявителя,
 * единственный способ получить в контейнере испорченный кадр — испортить его
 * ПОСЛЕ подписи контейнера, тем же приёмом, каким T5 портит `dealId`. Байты
 * кадра входят в `canonicalPresentationBytes` (`presentation.ts`), поэтому
 * подпись контейнера при этом неизбежно перестаёт сходиться —
 * `view.container` станет `'bad_signature'`, не `'ok'` (расхождение с
 * буквальным текстом задания, тоже в отчёте). Но `readOne`
 * (`presentationRead.ts`) считает вердикт КАЖДОГО кадра БЕЗУСЛОВНО, до и
 * независимо от проверки `mayOpen` — значит «подпись кадра проверяет арбитр
 * сам, адресно» по-прежнему измеримо, просто на фоне `bad_signature`
 * контейнера, а не `ok`.
 */
function tamperContainerFrame(
  container: PresentationContainer, seq: number, sender: `0x${string}`, spot: 'signature' | 'envelope',
): PresentationContainer {
  const idx = container.frames.findIndex(f => f.seq === seq && eq(f.sender, sender));
  if (idx < 0) throw new Error(`стенд: кадр ${sender}#${seq} не найден в контейнере — портить нечего`);
  const bytes = frameBytes(container.frames[idx].frame);
  const spoiled = new Uint8Array(bytes);
  if (spot === 'signature') {
    // Байт ВНУТРИ подписи звена: [33..97) кадра (chatConversation.ts,
    // OFF_SIGNATURE=33, LINK_SIGNATURE_LEN=64).
    spoiled[40] ^= 0x01;
  } else {
    // Последний байт кадра — заведомо шифротекст конверта (заголовок конверта
    // начинается на 193-м байте кадра, FRAME_HEADER_LEN), значит слоты целы,
    // разовый ключ добывается, а `bodyHash` больше не сходится.
    //
    // ⚠️ И портятся именно БАЙТЫ КОНВЕРТА ВНУТРИ КАДРА, а не заявленное звено
    // (исправление H договора v3): `body_mismatch` достижим только так. Испорти
    // `chains[].links[].bodyHash` — и `verifyFrameEvidence` не сойдёт заявленное
    // с разобранным ещё до отпечатка тела и ответит `malformed`, то есть замер
    // мерил бы другой вердикт под тем же именем.
    spoiled[spoiled.length - 1] ^= 0x01;
  }
  const frames = container.frames.slice();
  frames[idx] = { ...frames[idx], frame: b64FromBytes(spoiled) };
  return { ...container, frames };
}

/* ──────────────────────────── замеры ──────────────────────────── */

describe('4в: сторона предъявила — арбитр прочитал', () => {
  it('T1: прочитано РОВНО выбранное, побайтово; числа сходятся; якоря честные', async () => {
    await withStand(async (stand) => {
      const { presenter, peer, arbiter } = stand.actors;
      const A = presenter.address;
      const B = peer.address;

      const container = await present(stand);
      const view = await readPresentation(container, arbiter.keypair);

      // ─── боевые константы записаны здесь РУКАМИ (исправление 12 договора):
      // ожидаемое число берётся из теста, измеряемое — из кода. Поменяется
      // боевая константа — замер ПОКРАСНЕЕТ, а не подстроится молча.
      expect(PRESENTATION_KIND).toBe('hexseal.presentation.v1');
      expect(PRESENTATION_SEAL_OVERHEAD).toBe(48);
      expect(SEALED_ATTACHMENT_KEY_HEX_LEN).toBe(368);
      expect(FRAME_HEADER_LEN).toBe(193);
      expect(TOTAL_MESSAGES).toBe(6);

      // ─── контейнер: род, дело, предъявитель, состав ───
      expect(view.container).toBe('ok');
      expect(container.kind).toBe('hexseal.presentation.v1');
      expect(eq(container.dealId, DEAL_ID)).toBe(true);
      expect(eq(container.presenter, A)).toBe(true);
      // Заверение ОДНО — своё. Заверения собеседника у предъявителя нет.
      expect(container.attestations).toHaveLength(1);
      expect(eq(container.attestations[0].address, A)).toBe(true);
      // Кадров и ключей — три: четвёртый выбранный подготовить не удалось.
      expect(container.frames).toHaveLength(3);
      expect(container.keys).toHaveLength(3);
      // На двоих сразу, с первого дня (§15.6): без этого §7 не достроить никогда.
      // Заодно запирается КОДИРОВКА (исправление 2): base64 без `0x`, 80 байт в
      // каждом слоте. Приедь hex — `sealedOneTimeKeyBytes` бросит с числом.
      for (const k of container.keys) {
        expect(sealedOneTimeKeyBytes(k.forArbiter).length).toBe(80);
        expect(sealedOneTimeKeyBytes(k.forPeer).length).toBe(80);
        expect(k.forArbiter.startsWith('0x')).toBe(false);
        expect(k.forPeer).not.toBe(k.forArbiter);
      }

      // ─── ровно выбранное, ни больше ни меньше ───
      expect(view.messages.map(m => `${m.sender.toLowerCase()}#${m.seq}`).sort()).toEqual(
        [`${A.toLowerCase()}#1`, `${A.toLowerCase()}#2`, `${B.toLowerCase()}#1`].sort(),
      );
      // Невыбранные не доехали НИ В КАКОМ виде — проверка по байтам того, что
      // ушло наружу, а не по полям, которые мы решили посмотреть.
      const wire = JSON.stringify(view);
      expect(wire).not.toContain(TEXTS.a0);
      expect(wire).not.toContain(TEXTS.b2);
      expect(wire).not.toContain(TEXTS.b0);

      // ─── текст ПОБАЙТОВО ───
      expect(bytesOf(msg(view, A, 1).payload!.text!)).toEqual(bytesOf(TEXTS.a1));
      expect(msg(view, A, 2).payload!.text).toBe(TEXTS.a2);
      expect(bytesOf(msg(view, A, 2).payload!.text!)).toEqual(bytesOf(TEXTS.a2));
      expect(bytesOf(msg(view, B, 1).payload!.text!)).toEqual(bytesOf(TEXTS.b1));
      // Метка сделки доехала внутри запечатанного (а не рядом с ним).
      expect(eq(msg(view, A, 1).payload!.dealId, DEAL_ID)).toBe(true);

      // ─── подпись КАЖДОГО кадра проверена самим арбитром ───
      for (const m of view.messages) {
        expect(m.state).toBe('read');
        expect(m.reason).toBeUndefined();
        expect(m.frame).toEqual({ ok: true });
        // Ни одного легаси-ключа вложения арбитру не показали — и не могли:
        // отправка шла боевым путём, замок поставлен (мерится числами в T2).
        // ⚠️ Признак приезжает из `redactPayload` Задачи 3 (`Redaction`,
        // исправление B), а Задача 6 кладёт его как есть и своего не считает.
        // Значит красная строка здесь — вопрос к Задаче 3, а не к читалке.
        expect(m.legacyAttachmentExposed).toBe(false);
      }

      // ─── заверения: своё «ok», чужого НЕТ ВОВСЕ — и это отдельное слово ───
      expect(msg(view, A, 1).attestation).toBe('ok');
      expect(msg(view, A, 2).attestation).toBe('ok');
      // ⚠️ Точное значение, а не «что угодно кроме ok»: `absent` (исправление 5
      // договора) — это «подтвердить связку НЕЧЕМ», и оно не то же самое, что
      // `malformed` («принесли мусор») или `bad_signature` («принесли ложь»).
      // Прежняя формулировка `not.toBe('ok')` пережила бы подмену одного отказа
      // другим, то есть неправду о том, что произошло.
      expect(msg(view, B, 1).attestation).toBe('absent');

      // ─── цепочки: две, и якоря названы тем, чем они являются (§15.3) ───
      expect(view.perSender).toHaveLength(2);
      const mine = chainOf(view, A);
      expect(mine.anchorSource).toBe('own_head');
      // Сплошной хвост, упирающийся в настоящий последний номер: единственная
      // форма выборки, при которой показанное считается проверенным (chatchain §5, Г).
      expect(mine.verdict).toEqual({
        ok: false, reason: 'gap', missingAfterSeq: [-1], unverifiedContentAtSeq: [],
      });
      const his = chainOf(view, B);
      expect(his.anchorSource).toBe('as_received_by_presenter');
      // Хвост не показан → отпечаток не сверяется вовсе → непроверено ВСЁ
      // показанное (chatchain §5, Б). Честно и невыгодно предъявителю.
      expect(his.verdict).toEqual({
        ok: false, reason: 'gap', missingAfterSeq: [1], unverifiedContentAtSeq: [0, 1],
      });

      // ─── звенья неподготовленного кадра ОСТАЛИСЬ в цепочке (исправление 8) ───
      const chainA = container.chains.find(c => eq(c.sender, A))!;
      const chainB = container.chains.find(c => eq(c.sender, B))!;
      expect(chainA.links.map(l => l.seq)).toEqual([1, 2]);
      expect(chainB.links.map(l => l.seq)).toEqual([0, 1]);
      // …а сам кадр — в отдельном списке, с названной причиной, и НЕ в «скрыто».
      expect(container.notPrepared).toHaveLength(1);
      expect(container.notPrepared[0].seq).toBe(0);
      expect(eq(container.notPrepared[0].sender, B)).toBe(true);
      expect(container.notPrepared[0].reason.length).toBeGreaterThan(0);
      // …и арбитр показывает этот список ОТДЕЛЬНО от сообщений (исправление 9):
      // «лёг, но подготовить не смогли» обязано читаться не как «скрыл».
      expect(view.notPrepared).toHaveLength(1);
      expect(view.notPrepared[0].seq).toBe(0);
      expect(eq(view.notPrepared[0].sender, B)).toBe(true);
      expect(view.notPrepared[0].reason.length).toBeGreaterThan(0);

      // ─── ЧИСЛА СХОДЯТСЯ: 3 + 0 + 2 + 1 = 6 ───
      expect(view.counts).toEqual({ read: 3, unopened: 0, hidden: 2, notPrepared: 1 });
      expect(sum(view.counts)).toBe(TOTAL_MESSAGES);
      // Раскладка исправления 8 РУКАМИ, по цепочкам: скрытое считается как
      // «сколько якорь обещал минус сколько звеньев показано», и звено
      // неподготовленного B#0 в этом счёте УЧАСТВУЕТ — иначе у B вышло бы 2
      // скрытых, сумма дала бы 7, и предъявителя обвинили бы за арифметику.
      expect(chainA.anchor.expectedMessageCount - chainA.links.length).toBe(1); // 3 − 2
      expect(chainB.anchor.expectedMessageCount - chainB.links.length).toBe(1); // 3 − 2
      expect(view.counts.hidden).toBe(2);
      // …и шестёрка не константа из воздуха: столько же дают якоря контейнера.
      expect(container.chains.reduce((s, c) => s + c.anchor.expectedMessageCount, 0))
        .toBe(TOTAL_MESSAGES);
    });
  }, 120_000);

  it('T2: замок ставит боевой путь; вложение видно и не открывается', async () => {
    await withStand(async (stand) => {
      const { presenter, peer, arbiter } = stand.actors;
      const B = peer.address;
      const { file, wireFile, wirePayloadJson } = stand.conversation;

      // ─── ПРОВОД: сообщение уехало ровно как из `sendFile` — с открытыми
      // `keyHex`/`ivHex` и БЕЗ `sealedKey`. Значит всё, что видно ниже, сделал
      // боевой путь отправки, а не стенд.
      expect(SEALED_ATTACHMENT_KEY_HEX_LEN).toBe(368);
      expect(typeof wireFile.sealedKey).toBe('string');
      expect(wireFile.sealedKey!.length).toBe(368);          // два слота по 92 байта
      expect(/^[0-9a-f]{368}$/.test(wireFile.sealedKey!)).toBe(true);  // строчный hex без 0x
      // …а открытых ключей на проводе НЕ ОСТАЛОСЬ — ни полями…
      expect(wireFile.keyHex).toBeUndefined();
      expect(wireFile.ivHex).toBeUndefined();
      // …ни байтами (сверка по строке, а не по полям, которые мы решили смотреть).
      expect(wirePayloadJson).not.toContain(file.keyHex);
      expect(wirePayloadJson).not.toContain(file.ivHex);
      // Остальное вложение доехало нетронутым — иначе замок «работал» бы ценой
      // потери файла: адрес, имя и признак нарезки нужны панели собеседника.
      expect(wireFile.url).toBe(file.url);
      expect(wireFile.fileKey).toBe(file.fileKey);
      expect(wireFile.chunked).toBe(false);
      expect(bytesOf(wireFile.name)).toEqual(bytesOf(file.name));

      const container = await present(stand);
      const view = await readPresentation(container, arbiter.keypair);
      const m = msg(view, B, 1);
      expect(m.state).toBe('read');
      // Легаси-ключа арбитру не показывали, и это сказано ЯВНО, а не пропуском
      // поля (исправление 9: `legacyAttachmentExposed` обязательное).
      expect(m.legacyAttachmentExposed).toBe(false);

      // ─── форма: ни одного поля ключа, ни адреса скачивания ───
      const f = m.payload!.file!;
      const ALLOWED = ['name', 'size', 'mime', 'chunked'];
      expect(Object.keys(f).filter(k => !ALLOWED.includes(k))).toEqual([]);
      expect(Object.keys(f)).toContain('name');
      expect(Object.keys(f)).toContain('size');
      expect(Object.keys(m.payload!).filter(k => !['text', 'file', 'dealId'].includes(k))).toEqual([]);
      // Видит ИМЕННО ТО, что было, побайтово.
      expect(bytesOf(f.name)).toEqual(bytesOf(file.name));
      expect(f.size).toBe(file.size);
      expect(f.mime).toBe(file.mime);

      // ─── байты того, что ушло наружу ───
      const wire = JSON.stringify(view);
      expect(wire).not.toContain(file.keyHex);
      expect(wire).not.toContain(file.ivHex);
      expect(wire).not.toContain(wireFile.sealedKey!);
      expect(wire).not.toContain(file.url);
      expect(wire).not.toContain(file.fileKey);

      // ─── попытка расшифровать: у арбитра есть ровно один ключ, разовый ───
      const key = container.keys.find(k => k.seq === 1 && eq(k.sender, B))!;
      const oneTime = await openSealed(arbiter.keypair, sealedOneTimeKeyBytes(key.forArbiter));
      expect(oneTime).not.toBeNull();
      expect(oneTime!.length).toBe(32);
      // ⚠️ AES-GCM не отдаёт «мусор» — он ОТКАЗЫВАЕТ: тег не сходится. Это
      // сильнее мусора: предъявить нечего вовсе, даже испорченного файла.
      await expect(aesGcm(oneTime!, hexBytes(file.ivHex), file.encrypted)).rejects.toThrow();
      // И «взять первые 64 знака замка за ключ» (путь Б-8: `hexToBytes` мусор не
      // ловит и молча даёт байты) тоже даёт отказ, а не файл.
      await expect(aesGcm(hexBytes(wireFile.sealedKey!.slice(0, 64)), hexBytes(file.ivHex), file.encrypted))
        .rejects.toThrow();
      // …а с настоящим ключом файл собирается БАЙТ В БАЙТ — значит отказ выше
      // про ключ, а не про то, что стенд подсунул битые байты.
      expect(await aesGcm(hexBytes(file.keyHex), hexBytes(file.ivHex), file.encrypted))
        .toEqual(file.bytes);

      // ─── замок настоящий: ОБЕ стороны снимают, арбитр нет ───
      // Ключи внутри — те самые, что отдал `encryptFile`: значит замок закрыл
      // настоящий ключ настоящего файла, а не что-то похожее на него.
      expect(await openAttachmentKey(wireFile.sealedKey!, presenter.session.keypair))
        .toEqual({ keyHex: file.keyHex, ivHex: file.ivHex });
      expect(await openAttachmentKey(wireFile.sealedKey!, peer.session.keypair))
        .toEqual({ keyHex: file.keyHex, ivHex: file.ivHex });
      expect(await openAttachmentKey(wireFile.sealedKey!, arbiter.keypair)).toBeNull();
    });
  }, 120_000);

  it('T3: арбитр сменил ключ — «не открылось» это не молчание стороны, и числа его, не чужие', async () => {
    await withStand(async (stand) => {
      const { peer, arbiter, arbiterStale } = stand.actors;
      const B = peer.address;

      // Предъявитель запечатал на ПРЕЖНИЙ ключ (§9: арбитр сменил его посреди
      // спора). Контейнер подписан честно, ничего не подделано.
      const container = await present(stand, { arbiterBoxKey: toArbiterBoxKeyBytes(arbiterStale.boxKey) });
      const view = await readPresentation(container, arbiter.keypair);

      expect(view.container).toBe('ok');
      expect(view.messages).toHaveLength(3);
      for (const m of view.messages) {
        expect(m.state).toBe('unopened');
        expect(m.payload).toBeUndefined();
        expect(['malformed', 'bad_key', 'aad_mismatch', 'bad_form']).toContain(m.reason);
        // ⚠️ И ПРИ ЭТОМ КАДР ПРОВЕРЕН: арбитр знает, что письма подлинные и чьи
        // они, — он лишь не может их прочитать. Ровно то различение, которого
        // требует §11 и без которого «не открылось» карается как молчание.
        expect(m.frame).toEqual({ ok: true });
      }
      // Ничего не утекло, хотя кадры на руках.
      const wire = JSON.stringify(view);
      expect(wire).not.toContain(TEXTS.a1);
      expect(wire).not.toContain(TEXTS.b1);

      // ─── ЧИСЛА: 0 + 3 + 2 + 1 = 6. «Не открылось» НЕ уменьшает «скрыто» и
      // «не подготовлено»: их считают по якорям, а не по успеху чтения ───
      expect(view.counts).toEqual({ read: 0, unopened: 3, hidden: 2, notPrepared: 1 });
      expect(sum(view.counts)).toBe(TOTAL_MESSAGES);
      // ─── и это ЕГО числа, а не перепечатанные из контейнера ───
      // ⚠️ У предъявителя ТРИ числа, а не четыре (`DeclaredCounts`, исправление
      // 7): `unopened` у него быть не может — он не арбитр. Поэтому здесь
      // сверять «его unopened с моим» нечем, и это правильно: сравнение,
      // которое раньше стояло на четвёртом числе, было сравнением с полем,
      // которого не должно существовать. Форму запирает `formLocks`.
      expect(container.counts).toEqual({ read: 3, hidden: 2, notPrepared: 1 });
      expect(Object.keys(container.counts).sort()).toEqual(['hidden', 'notPrepared', 'read']);
      expect(view.counts.read).not.toBe(container.counts.read);
      expect(view.counts.unopened).toBe(3);
      // Скрытое и неподготовленное совпали — и обязаны: их считают по якорям.
      expect(view.counts.hidden).toBe(container.counts.hidden);
      expect(chainOf(view, B).anchorSource).toBe('as_received_by_presenter');
    });
  }, 120_000);

  it('T4: подпись кадра проверяет арбитр САМ — байт подписи и байт конверта дают разные отказы', async () => {
    // ⚠️ РАСХОЖДЕНИЕ С ЗАДАНИЕМ (разъяснено у `tamperContainerFrame` и в отчёте
    // задачи 7). Порча кадра здесь — ПОСЛЕ `buildPresentation`, на уже
    // собранном и подписанном контейнере: испорти его раньше (на устройстве
    // предъявителя, до сборки) — `buildPresentation` сама поймает подделку
    // своим `verifyFrameEvidence` и уведёт кадр в `notPrepared`, до контейнера
    // (и тем более до арбитра) он не доедет вовсе. Значит `view.container`
    // здесь `'bad_signature'`, а не `'ok'` — байты кадра входят в подпись
    // контейнера, испортить один кадр и оставить подпись целой нельзя
    // технически. Измеряемое ядро T4 — «арбитр вычисляет вердикт КАЖДОГО кадра
    // сам, адресно, и это НЕ зависит от того, сошлась ли подпись контейнера» —
    // сохраняется: `readOne` (`presentationRead.ts`) считает `frame`-вердикт
    // безусловно, до и независимо от проверки `mayOpen`.
    await withStand(async (stand) => {
      const { presenter, peer, arbiter } = stand.actors;
      const honest = await present(stand);
      // Замок на саму заготовку: кадр обязан разобраться, иначе мерили бы не то.
      const rawHonest = frameBytes(honest.frames.find(f => f.seq === 1 && eq(f.sender, peer.address))!.frame);
      expect(decodeFrame(rawHonest)).not.toBeNull();

      const container = tamperContainerFrame(honest, 1, peer.address, 'signature');
      const view = await readPresentation(container, arbiter.keypair);
      // Порча байта кадра неизбежно рвёт и подпись контейнера (см. выше) —
      // названо явно, чтобы не читалось как «тест сломан».
      expect(view.container).toBe('bad_signature');
      const m = msg(view, peer.address, 1);
      expect(m.frame).toEqual({ ok: false, reason: 'bad_signature' });
      expect(m.state).toBe('unopened');
      expect(m.payload).toBeUndefined();
      // Остальные кадры — целы: отказ адресный, а не «всё плохо». Содержимого
      // не видно ни у кого (подпись контейнера не сошлась), но собственный
      // вердикт КАЖДОГО кадра арбитр всё равно посчитал сам.
      expect(msg(view, presenter.address, 1).frame).toEqual({ ok: true });
      expect(msg(view, presenter.address, 2).frame).toEqual({ ok: true });
    });

    await withStand(async (stand) => {
      const { peer, arbiter } = stand.actors;
      const honest = await present(stand);
      const container = tamperContainerFrame(honest, 1, peer.address, 'envelope');
      const view = await readPresentation(container, arbiter.keypair);
      expect(view.container).toBe('bad_signature');
      const m = msg(view, peer.address, 1);
      // Байт в шифротексте: отпечаток тела больше не сходится с байтами кадра…
      // ⚠️ Испорчены БАЙТЫ КОНВЕРТА, а не заявленное звено — и это единственная
      // сцена, дающая `body_mismatch` (исправление H): порча
      // `chains[].links[].bodyHash` разошлась бы с разобранным кадром раньше и
      // дала бы `malformed`. Разойдись Задача 4 с этим — красным станет строка
      // ниже, и разбирать надо будет её вердикт, а не мою сцену.
      expect(m.frame).toEqual({ ok: false, reason: 'body_mismatch' });
      // …и прочитать его нельзя даже верным разовым ключом — тег GCM не сойдётся
      // (и содержимого никому не показали бы всё равно: подпись контейнера не
      // сошлась).
      expect(m.state).toBe('unopened');
      expect(m.payload).toBeUndefined();
      // Соседний кадр (A#1) — цел, отказ адресный.
      expect(msg(view, stand.actors.presenter.address, 1).frame).toEqual({ ok: true });
    });
  }, 180_000);

  it('T5: битая подпись — содержимого нет, вердикты есть; мусор даёт вердикт, а не падение', async () => {
    await withStand(async (stand) => {
      const { presenter, peer, arbiter } = stand.actors;
      const A = presenter.address;
      const B = peer.address;

      const container = await present(stand);
      // Подмена дела — то, ради чего контейнер вообще подписан (§15.1):
      // без подписи предъявление можно было бы переклеить на другой спор.
      const moved: PresentationContainer = {
        ...container,
        dealId: '0x000000000000000000000000000000000000beef' as `0x${string}`,
      };
      const spoiled = await readPresentation(moved, arbiter.keypair);
      expect(spoiled.container).toBe('bad_signature');
      expect(spoiled.container).not.toBe('ok');

      // ─── ИСПРАВЛЕНИЕ 10: подпись не сошлась → КТО предъявил, неизвестно,
      // значит содержимое показывать нельзя (могло быть сочинено целиком). Но
      // вердикты по кадрам и заверениям САМОПРОВЕРЯЕМЫ и от подписи контейнера
      // не зависят — их видно. Иначе один перевёрнутый байт в пути стирал бы
      // всё предъявление стороны, и §11 («лёг, но не прочитался» ≠ «сторона
      // молчит») переставал бы держаться на самом важном случае.
      expect(spoiled.messages).toHaveLength(3);
      for (const m of spoiled.messages) {
        expect(m.state).toBe('unopened');
        expect(m.payload).toBeUndefined();
        // Кадры целы и подписаны — это проверяется подписью ЗВЕНА, а не
        // подписью контейнера, и потому остаётся правдой.
        expect(m.frame).toEqual({ ok: true });
        expect(m.legacyAttachmentExposed).toBe(false);
      }
      // Заверения — настоящие вердикты, каждый своим словом.
      expect(msg(spoiled, A, 1).attestation).toBe('ok');
      expect(msg(spoiled, A, 2).attestation).toBe('ok');
      expect(msg(spoiled, B, 1).attestation).toBe('absent');
      // Ни одного слова переписки наружу не ушло.
      const spoiledWire = JSON.stringify(spoiled);
      expect(spoiledWire).not.toContain(TEXTS.a1);
      expect(spoiledWire).not.toContain(TEXTS.a2);
      expect(spoiledWire).not.toContain(TEXTS.b1);
      // Числа арбитра: прочитанных НЕТ, все три легли непрочитанными.
      // ⚠️ `hidden`/`notPrepared` здесь числом не запираются нарочно: они
      // считаются по якорям и списку ПРЕДЪЯВИТЕЛЯ, а предъявитель неизвестен —
      // договор v2 не говорит, показывать ли их, и выдумывать за него нельзя.
      expect(spoiled.counts.read).toBe(0);
      expect(spoiled.counts.unopened).toBe(3);

      // Мусор на входе: вердикт, а не исключение и не молчаливая пустота.
      // ⚠️ И `malformed` — НЕ то же, что `bad_signature` выше: там были
      // самопроверяемые кадры и заверения, здесь нет вообще ничего, что можно
      // было бы проверить. Поэтому выдача пустая, и это не противоречие.
      for (const junk of ['не контейнер', null, 42, [], {}, { kind: 'hexseal.presentation.v1' }]) {
        const view = await readPresentation(junk, arbiter.keypair);
        expect(view.container).toBe('malformed');
        expect(view.messages).toEqual([]);
        expect(view.counts).toEqual({ read: 0, unopened: 0, hidden: 0, notPrepared: 0 });
        expect(view.perSender).toEqual([]);
      }
    });
  }, 120_000);

  it('T6: без ключа арбитра, без ключа собеседника и на пустоте — отказ с названной причиной', async () => {
    await withStand(async (stand) => {
      const { presenter, peer, arbiter } = stand.actors;
      const base = {
        dealId: DEAL_ID,
        presenter: presenter.address,
        peer: peer.address,
        arbiterBoxKey: toArbiterBoxKeyBytes(arbiter.boxKey),
        peerBoxKey: toPeerBoxKeyBytes(peer.session.keypair.publicKey),
        selected: [{ seq: 1, sender: presenter.address }],
        session: presenter.session,
        ownAttestation: await signChatKeyAttestation(presenter.wallet, presenter.session),
      };

      // Печать на нулевой ключ дала бы контейнер, который не откроет никто:
      // предъявитель видит «сдано», арбитр — пустоту (§15.7).
      expect(await buildPresentation({ ...base, arbiterBoxKey: toArbiterBoxKeyBytes(new Uint8Array(32)) }))
        .toEqual({ ok: false, reason: 'arbiter_has_no_key' });
      // ⚠️ Собеседник без ключа чата — ОТКАЗ С ИМЕНЕМ (исправление 6), а не
      // `TypeError` в консоли и не тихое предъявление без слота `forPeer`:
      // второй случай оставил бы §7 («вторая сторона видит содержимое после
      // своего хода») невыполнимым навсегда, и никто бы этого не заметил.
      expect(await buildPresentation({ ...base, peerBoxKey: toPeerBoxKeyBytes(new Uint8Array(32)) }))
        .toEqual({ ok: false, reason: 'peer_has_no_key' });
      expect(await buildPresentation({ ...base, selected: [] }))
        .toEqual({ ok: false, reason: 'nothing_selected' });
      // …а обычный случай — проходит, иначе оба отказа выше ничего не значат.
      const ok = await buildPresentation(base);
      expect(ok.ok).toBe(true);
    });
  }, 120_000);
});
