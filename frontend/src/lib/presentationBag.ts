/**
 * presentationBag.ts — предъявление на проводе: байты, потолок, разбор ящика.
 *
 * Три вещи, которых нет ни у кого больше:
 *
 * 1. СКОЛЬКО БАЙТ УЙДЁТ. Мешок склада — 256 КиБ (`relayer/bagStore.js:244`,
 *    константа — `PRESENTATION_MAX_BYTES` задачи 5, здесь только реэкспорт), и
 *    предъявление, не влезающее в него, обязано отказать С ЧИСЛОМ влезающих
 *    кадров, а не обрезаться молча. Само число называет сборщик в отказе; здесь
 *    оно только пересказывается вместе с байтами (см. `fittingMessageCount`).
 *    ⚠️ После договора v3 отказ несёт и СВОЙ потолок (`limitBytes`) — то есть
 *    у одного числа стало два носителя. `BagFit.limit` считается из константы,
 *    а не из поля отказа (один источник, без «когда есть отказ — так, когда нет
 *    — иначе»), и согласие двух носителей заперто замером с числом, записанным
 *    руками (шаг 2, мутация 19).
 * 2. КАК АРБИТР НАЙДЁТ ПРЕДЪЯВЛЕНИЕ. Признака рода на проводе нет вовсе
 *    (справочник транспорта §8.2), а в ящике арбитра лежат его же переписки с
 *    теми же людьми. Род и `dealId` — внутри контейнера, значит найти можно
 *    только попыткой открыть.
 * 3. ЧЕЙ ПОРЯДОК СЧИТАЕТСЯ СВЕЖЕСТЬЮ. `uploadedAt` — свидетельство склада,
 *    которому мы не верим (замысел §10). Порядок берётся из `issuedAt`
 *    ПОДПИСАННОГО контейнера. Это заявление предъявителя, а не истина — но
 *    заявление, накрытое его подписью, а не словом сервера. Ничего при этом не
 *    выбрасывается: два предъявления по одному делу — норма (§15.7), список
 *    показывает оба.
 *
 * ⚠️ ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ НИ ОДНА ПОДПИСЬ. Доверие — дело `readPresentation`
 * (задача 6). Этот модуль отвечает на «наш ли это род и наше ли дело», и
 * смешивать два ответа нельзя: «форма не та» и «подпись не сходится» — разные
 * новости для человека.
 */
import { sealForRecipient, openSealed, type ChatKeypair } from '@/lib/chatCrypto';
import type { IncomingBag } from '@/lib/chatConversation';
import {
  buildPresentation, PRESENTATION_KIND, PRESENTATION_MAX_BYTES, PRESENTATION_SEAL_OVERHEAD,
  type BuildFailure, type PresentationContainer,
} from '@/lib/presentation';

/**
 * ⚠️ СВОИХ КОНСТАНТ ЗДЕСЬ НЕТ — только реэкспорт задачи 5 (исправление 11).
 * Первая редакция объявляла свои `MAX_PRESENTATION_BAG_BYTES`,
 * `SEAL_OVERHEAD_BYTES` и `PRESENTATION_KIND` — то есть второй источник истины на
 * то, что уже объявлено в `presentation.ts`. Два источника расходятся молча:
 * сборщик отказывал бы по одному потолку, а мой счёт мерил бы другой.
 *
 * ⚠️ ТИПЫ ОТКАЗА (`PresentationRefusal`, `BuildFailure`) НЕ реэкспортируются, хотя
 * `BuildFailure` здесь и импортируется для `FitVerdict`. После договора v3 отказ —
 * размеченный союз, и второе имя на него из моего модуля означало бы, что
 * потребитель (задача 7) может сузить не тот союз, а разницу увидеть только на
 * исполнении. За формой отказа ходят в `presentation.ts`, к одному объявлению.
 */
export { PRESENTATION_KIND, PRESENTATION_MAX_BYTES, PRESENTATION_SEAL_OVERHEAD };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * ⚠️ `TextEncoder`, не `String.length` — и честно про то, что это ФОРМА, а не
 * заперто замером. После исправления 2 договора все байтовые поля контейнера —
 * base64, то есть JSON целиком ASCII и `length` численно равен `byteLength`;
 * мутация «взять `.length`» была бы зелёной по построению, и её в списке нет.
 * `TextEncoder` стоит здесь на случай непустого человеческого поля в контейнере:
 * тогда счёт по символам занизил бы мешок вдвое и предъявление обрезалось бы
 * молча уже на складе.
 */
export function presentationJson(container: PresentationContainer): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(container));
}

export function presentationWireBytes(container: PresentationContainer): number {
  return PRESENTATION_SEAL_OVERHEAD + presentationJson(container).byteLength;
}

export async function sealPresentation(
  container: PresentationContainer, recipientBoxKey: Uint8Array,
): Promise<Uint8Array> {
  return sealForRecipient(recipientBoxKey, presentationJson(container));
}

export type BagLook =
  | {
      kind: 'presentation';
      container: PresentationContainer;
      dealId: `0x${string}`;
      presenter: `0x${string}`;
      issuedAt: number;
      messages: number;
    }
  /** Наша пара печать не открыла: чужой мешок, обычный кадр переписки, мусор. */
  | { kind: 'sealed_for_other' }
  /** Открылось, но внутри не текст/не JSON. */
  | { kind: 'not_json' }
  /** JSON, но не наш род или не той формы. */
  | { kind: 'not_presentation' };

function looksLikeContainer(x: unknown): x is PresentationContainer {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return (
    o.kind === PRESENTATION_KIND &&
    typeof o.dealId === 'string' && ADDRESS_RE.test(o.dealId) &&
    typeof o.presenter === 'string' && ADDRESS_RE.test(o.presenter) &&
    Number.isSafeInteger(o.issuedAt) && (o.issuedAt as number) > 0 &&
    Array.isArray(o.frames)
  );
}

export async function lookIntoBag(body: Uint8Array, own: ChatKeypair): Promise<BagLook> {
  let opened: Uint8Array | null;
  try {
    // ⚠️ `openSealed` БРОСАЕТ на мешке короче 48 байт (libsodium, проброшено
    // `chatCrypto.ts:212`) и возвращает `null` на «не наше». В ящике бывает и
    // то и другое, и ни то ни другое не поломка.
    opened = await openSealed(own, body);
  } catch {
    return { kind: 'sealed_for_other' };
  }
  if (!opened) return { kind: 'sealed_for_other' };

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(opened);
  } catch {
    return { kind: 'not_json' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'not_json' };
  }
  if (!looksLikeContainer(parsed)) return { kind: 'not_presentation' };
  return {
    kind: 'presentation',
    container: parsed,
    dealId: parsed.dealId,
    presenter: parsed.presenter,
    issuedAt: parsed.issuedAt,
    messages: parsed.frames.length,
  };
}

export type SkipReason = 'sealed_for_other' | 'not_json' | 'not_presentation' | 'other_deal';

export interface FoundPresentation {
  bagKey: string;
  /** Свидетельство склада. Для ПОРЯДКА не используется — см. шапку. */
  uploadedAt: number;
  uploadedBy: `0x${string}`;
  container: PresentationContainer;
  issuedAt: number;
  messages: number;
}

export interface InboxTriage {
  /** Свежее первым, по подписанному `issuedAt`; при равенстве — по ключу мешка. */
  presentations: FoundPresentation[];
  skipped: { bagKey: string; why: SkipReason }[];
}

export async function findPresentations(
  bags: readonly IncomingBag[], own: ChatKeypair, dealId: `0x${string}`,
): Promise<InboxTriage> {
  const presentations: FoundPresentation[] = [];
  const skipped: { bagKey: string; why: SkipReason }[] = [];
  for (const bag of bags) {
    const look = await lookIntoBag(bag.body, own);
    if (look.kind !== 'presentation') {
      skipped.push({ bagKey: bag.key, why: look.kind });
      continue;
    }
    if (look.dealId.toLowerCase() !== dealId.toLowerCase()) {
      skipped.push({ bagKey: bag.key, why: 'other_deal' });
      continue;
    }
    presentations.push({
      bagKey: bag.key,
      uploadedAt: bag.uploadedAt,
      uploadedBy: bag.sender,
      container: look.container,
      issuedAt: look.issuedAt,
      messages: look.messages,
    });
  }
  presentations.sort(
    (a, b) => b.issuedAt - a.issuedAt || (a.bagKey < b.bagKey ? -1 : a.bagKey > b.bagKey ? 1 : 0),
  );
  return { presentations, skipped };
}

export interface BagFit {
  /** Сколько первых сообщений выбора влезает в мешок. */
  fits: number;
  limit: number;
  /** Байты предъявления при `fits`; `null`, когда не влезает даже одно. */
  bytesAtFits: number | null;
}

export type FitVerdict = { ok: true; fit: BagFit } | { ok: false; reason: BuildFailure };

/**
 * Сколько сообщений влезет в мешок — ЧИСЛОМ, до отправки.
 *
 * ⚠️ СВОЕГО СЧЁТА ЗДЕСЬ НЕТ ВОВСЕ (договор v2, исправление 11). Число влезающих
 * называет сам сборщик в отказе `too_large`; эта функция только спрашивает его и
 * один раз собирает на названном числе, чтобы узнать байты. Первая редакция
 * искала границу двоичным поиском — это работало, но было ВТОРЫМ счётом, а два
 * счёта в этом проекте расходятся молча (задача 5 печатала base64, задача 6
 * читала hex — обе зелёные, стык мёртв). Ни модели размера («кадр в base64 это
 * 4/3, плюс запись ключа, плюс звено…»), ни поиска: спрашиваем того, кто решает.
 *
 * ⚠️ ЧТО ВСЁ РАВНО ЗАПЕРТО ЗАМЕРОМ. Форма держит только то, что поле `fits` есть
 * и что оно число. Правдивость числа формой не держится, поэтому замер собирает
 * на `fits` (влезает) и на `fits + 1` (не влезает). Если сборщик назовёт число,
 * которого сам не собирает, отказ возвращается наружу с его же причиной, а не
 * заминается.
 *
 * ⚠️ `limit` СЧИТАЕТСЯ ИЗ КОНСТАНТЫ, а не из `limitBytes` отказа (договор v3 дал
 * отказу своё поле с тем же числом). Иначе у `limit` было бы два происхождения —
 * одно, когда отказ есть, другое, когда всё влезло, — и разойтись они могли бы
 * молча. Согласие константы с полем отказа заперто замером (мутация 19).
 */
export async function fittingMessageCount(
  input: Parameters<typeof buildPresentation>[0],
): Promise<FitVerdict> {
  const total = input.selected.length;
  if (total === 0) return { ok: false, reason: 'nothing_selected' };

  const whole = await buildPresentation(input);
  if (whole.ok) {
    return {
      ok: true,
      fit: {
        fits: total,
        limit: PRESENTATION_MAX_BYTES,
        bytesAtFits: presentationWireBytes(whole.container),
      },
    };
  }
  // ⚠️ СУЖЕНИЕ ПО ЛИТЕРАЛУ, а не `whole.fits!`. Отказ — размеченный союз (договор
  // v3), поэтому после этой строки `fits` есть у типа сам. Восклицательный знак был
  // бы ровно способом собраться при ОТСУТСТВУЮЩЕМ поле — то есть тем, от чего этот
  // стык и держат формой (мутации 17 и 18).
  if (whole.reason !== 'too_large') return { ok: false, reason: whole.reason };

  // Число — ЧУЖОЕ, из отказа сборщика. Своего здесь не появляется.
  const fits = whole.fits;
  if (fits <= 0) {
    return { ok: true, fit: { fits: 0, limit: PRESENTATION_MAX_BYTES, bytesAtFits: null } };
  }
  const atFits = await buildPresentation({ ...input, selected: input.selected.slice(0, fits) });
  if (!atFits.ok) {
    // Сборщик назвал число, которого сам не собирает. Наружу — его причина, а не
    // тихое «столько-то влезет».
    return { ok: false, reason: atFits.reason };
  }
  return {
    ok: true,
    fit: {
      fits,
      limit: PRESENTATION_MAX_BYTES,
      bytesAtFits: presentationWireBytes(atFits.container),
    },
  };
}
