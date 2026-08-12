/**
 * presentToArbiter.ts — что решает кнопка стороны и что она отправляет
 * (план 4в-2, Задача 6).
 *
 * ⚠️ БЕЗ REACT НАМЕРЕННО. У фронта нет ни jsdom, ни @testing-library: нажатие
 * замком не проверяется вовсе. Поэтому всё, что решает, живёт здесь обычными
 * функциями и зовётся тестами напрямую, а компонент остаётся разметкой над
 * ними. Правило проекта: «обработчик выносится отдельной функцией».
 *
 * ⚠️ ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: кнопки «замазать лишнее» (§2.8 замысла).
 * Отпечаток сообщения считается по ЗАШИФРОВАННЫМ байтам — любая правка убивает
 * доказательство, а выглядеть замазанное будет как обычное. Контейнер уходит
 * на склад ровно тем, что вернула сборка.
 */
import type { Abi, PublicClient } from 'viem';
import { AGREEMENT_ABI } from '@/config/contracts';
import type { ChatSession } from './chatSession';
import type { ChatKeyAttestation } from './chatKeyAttestation';
import type { PeerChatKeys } from './chatDirectoryTypes';
import type { ArbiterTurn } from './arbiterTurn';
import {
  comparePresentedWith,
  type ArbiterChangeReason, type DisputeArbiterKey, type PresentedTo,
} from './disputeArbiter';
// ⚠️ `arbiterBoxKeyBytes` ЗДЕСЬ НЕ ИМПОРТИРУЕТСЯ. Переход «ключ из цепи →
// байты печати» ровно один, и он в Задаче 5 (`readDisputeArbiterKey` отдаёт
// готовые `boxKeyBytes`). Импорт вернул бы этому переходу второе место.
import {
  buildPresentation, toPeerBoxKeyBytes,
  type ArbiterBoxKeyBytes, type BuildFailure, type PresentationContainer,
} from './presentation';
import { presentationWireBytes, sealPresentation, type FitVerdict } from './presentationBag';
import {
  draftFromContainer, markPresentationSent, readPresentationDrafts, savePresentationDraft,
  type DraftMarkVerdict, type DraftSaveVerdict, type PresentationDraft,
} from './presentationDraft';
import { BagBudgetError, BagPassError, BagRateLimitError, BagTransportError } from './chatTransport';
import type { DisputeBoxList } from './disputeBox';

/** Agreement.Status.DISPUTED. ⚠️ У реестра DISPUTED = 3 — это ДРУГОЙ enum. */
export const AGREEMENT_STATUS_DISPUTED = 4;

/** Такт опроса описи: «забрал ли арбитр». ДВА обращения в минуту против
 *  серверных ста — и оба по общему адресному бюджету, своего счёта нет. */
export const BOX_POLL_MS = 30_000;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * ⚠️ ИМЕНА СМЕНЫ БЕРУТСЯ ТИПОМ ЗАДАЧИ 5, А НЕ ПЕРЕПИСЫВАЮТСЯ РУКАМИ.
 * Сигнал слежения и отказ отправки — про одно и то же событие; два словаря
 * для одного факта разошлись бы молча, и разошлись бы **тихо**: переписанные
 * три строки продолжали бы собираться, а четвёртый повод, заведённый
 * Задачей 5, просто не имел бы текста. С `ArbiterChangeReason` в союзе
 * четвёртый повод ломает `Record<PresentRefusal, string>` ниже — то есть
 * `npm run type-check` краснеет у нас, а не человек получает пустой тост.
 * Перевод один и показывается в двух местах: в отказе после нажатия и в
 * живом уведомлении о смене арбитра в чате.
 */
export type PresentRefusal =
  | BuildFailure
  | ArbiterChangeReason
  | 'not_disputed'
  | 'no_consent' | 'already_sending'
  | 'chain_unavailable' | 'not_a_party' | 'no_such_deal' | 'rate_limited'
  | 'box_refused' | 'offline' | 'pass_refused'
  /**
   * ⚠️ НАША ПОЛОМКА ДО СКЛАДА, и она приехала ревью (круг 1, I-5). Докстринг
   * `sendPresentation` обещал «НЕ БРОСАЕТ», а в `try` были завёрнуты только
   * чтения цепи и блок «пропуск + склад»: `buildPresentation` бросает
   * `TypeError` на чужой форме входа, черновик — на негодном. Бросок уходил
   * мимо `doSend` (там `try/finally` без `catch`) в `void doSend()` —
   * необработанный отказ промиса: ни тоста, ни причины, окно открыто, кнопка
   * снова живая. Теперь у этого случая есть имя и текст.
   *
   * ⚠️ Это имя достаётся ТОЛЬКО тому, что случилось ДО склада: текст говорит
   * «ничего не отправлено», и после успешного `put` он был бы враньём. Отказ
   * пометки черновика после успешной отправки сюда не попадает — он едет
   * `draftKeepNotice` ниже.
   */
  | 'internal_error';

/**
 * Причина → ключ локали. ⚠️ ЭТО ЗАМОК НА ШОВ С ЗАДАЧЕЙ 4, А НЕ СПРАВОЧНИК.
 * `Record<PresentRefusal, string>` обязан быть полным: добавит Задача 4
 * девятое имя `BuildFailure` — карта перестанет собираться, и
 * `npm run type-check` покраснеет здесь, а не у человека со сломанной
 * кнопкой. Живёт в НЕ-тестовом файле именно поэтому: `*.test.ts` исключены
 * из программы tsc.
 *
 * ⚠️ У ТРЁХ БЕД ЗАВЕРЕНИЯ ЛЕЧЕНИЕ РАЗНОЕ, и в этом весь пункт 49: «нажать
 * заверить ключи», «заверение устарело — переподписать», «переподпись НЕ
 * поможет, нужна сеть». Один текст на троих вернул бы человека к лечению не
 * того.
 * ⚠️ `box_full` ЗДЕСЬ НЕТ: сервер не отдаёт ни 507, ни `disk_full` (перечень
 * Задачи 1), кончившееся место приходит как `internal_error`. Ключ для
 * несуществующего отказа — мёртвый текст в четырнадцати файлах.
 */
export const PRESENT_REFUSAL_KEYS: Record<PresentRefusal, string> = {
  arbiter_has_no_key:    'chat.present_err_arbiter_has_no_key',
  peer_has_no_key:       'chat.present_err_peer_has_no_key',
  nothing_selected:      'chat.present_err_nothing_selected',
  too_large:             'chat.present_err_too_large',
  no_session:            'chat.present_err_no_session',
  attestation_missing:   'chat.present_err_attestation_missing',
  attestation_expired:   'chat.present_err_attestation_expired',
  attestation_unproven:  'chat.present_err_attestation_unproven',
  not_disputed:          'chat.present_err_not_disputed',
  arbiter_changed:       'chat.present_err_arbiter_changed',
  key_changed:           'chat.present_err_key_changed',
  arbiter_left:          'chat.present_err_arbiter_left',
  no_consent:            'chat.present_err_no_consent',
  already_sending:       'chat.present_err_busy',
  chain_unavailable:     'chat.present_err_chain_unavailable',
  not_a_party:           'chat.present_err_not_a_party',
  no_such_deal:          'chat.present_err_no_such_deal',
  rate_limited:          'chat.present_err_rate_limited',
  box_refused:           'chat.present_err_box_refused',
  offline:               'chat.present_err_offline',
  pass_refused:          'chat.present_err_pass_refused',
  internal_error:        'chat.present_err_internal_error',
};

/* ─────────────────────────── выбор сообщений ─────────────────────────── */

/** Структурная форма, а не импорт `PairChatMessage`: выбору нужны четыре
 *  поля, и привязка к полному типу хука заставила бы тест собирать вложения. */
export interface PresentableMessage {
  from: string;
  seq: number;
  text: string;
  timestamp: number;
  isFromMe: boolean;
}

export interface SelectableMessage {
  seq: number;
  sender: `0x${string}`;
  text: string;
  at: number;
  mine: boolean;
}

/**
 * Сообщения, годные для выбора, и число выброшенных.
 *
 * ⚠️ ЗАЧЕМ ЧИСЛО ВЫБРОШЕННЫХ. `PairChatMessage.from` — просто `string`
 * (`usePairChat.ts:89`), и сборщику нужен адрес нижним регистром. Тихо
 * пропустить негодное — значит показать человеку список короче переписки и
 * не сказать об этом; число уезжает на экран рядом со списком.
 */
export function selectableMessages(
  messages: readonly PresentableMessage[],
): { rows: SelectableMessage[]; dropped: number } {
  const rows: SelectableMessage[] = [];
  let dropped = 0;
  for (const m of messages) {
    if (typeof m?.from !== 'string' || !ADDR_RE.test(m.from) || !Number.isSafeInteger(m?.seq) || m.seq < 0) {
      dropped++;
      continue;
    }
    rows.push({
      seq: m.seq,
      sender: m.from.toLowerCase() as `0x${string}`,
      text: typeof m.text === 'string' ? m.text : '',
      at: Number.isFinite(m.timestamp) ? m.timestamp : 0,
      mine: m.isFromMe === true,
    });
  }
  return { rows, dropped };
}

/* ──────────────────────────── что показывать ─────────────────────────── */

/** Кнопка живёт вместе со спором (§2.2 замысла): собрать можно когда угодно,
 *  ОТПРАВИТЬ — только при живом споре, потому что до спора читать некому. */
export function presentButtonVisible(
  input: { status: number | undefined; isParty: boolean },
): boolean {
  return input.isParty === true && input.status === AGREEMENT_STATUS_DISPUTED;
}

/** Четыре запрета, и каждый сам по себе. Согласие спрашивается ЗАНОВО на
 *  каждое предъявление — функция ничего не помнит намеренно. */
export function canSend(
  input: { consent: boolean; selected: number; busy: boolean; status: number | undefined },
): boolean {
  if (input.consent !== true) return false;
  if (!(input.selected > 0)) return false;
  if (input.busy) return false;
  return input.status === AGREEMENT_STATUS_DISPUTED;
}

export type FitNotice =
  | { kind: 'all'; fits: number }
  | { kind: 'partial'; fits: number; total: number }
  | { kind: 'unknown' }
  /**
   * ⚠️ `PresentRefusal`, А НЕ `BuildFailure`. Сюда попадает не только отказ
   * сборщика, но и отказ ДЕШЁВОГО снимка (`chain_unavailable`,
   * `arbiter_left`, `arbiter_has_no_key`, `offline`, `attestation_missing`):
   * прикидка без снимка невозможна, и человеку надо сказать почему, а не
   * оставить пустую строку и запертую кнопку. Печатается всё той же картой
   * `PRESENT_REFUSAL_KEYS` — второго словаря для этого не заводится.
   */
  | { kind: 'refused'; reason: PresentRefusal };

/**
 * Что сказать про «сколько влезает».
 *
 * ⚠️ ПУНКТ 50.1 НЕ ЧИНИТСЯ ЗДЕСЬ, И ЭТО ВИДНО ПО ФОРМЕ. `fits` считает
 * сборщик В СВОЁМ ПОРЯДКЕ, а `fittingMessageCount` режет выбор в порядке
 * вызывающего (`presentationBag.ts:250`) — наборы могут разойтись, и тогда
 * второй сбор отказывает `too_large` БЕЗ числа. Наш ответ на этот случай —
 * `{ kind: 'unknown' }`: честное «столько не влезает, а сколько влезет —
 * посчитать не удалось». Ни «влезает 0», ни молчания.
 *
 * ⚠️ И НИЧЕГО НЕ РЕЖЕМ САМИ. `slice` в этой задаче не встречается ни разу:
 * убирает отметки человек. Резать за него значило бы решить за него, ЧТО
 * именно арбитр не увидит.
 */
export function fitNotice(verdict: FitVerdict, total: number): FitNotice {
  if (verdict.ok) {
    return verdict.fit.fits >= total
      ? { kind: 'all', fits: verdict.fit.fits }
      : { kind: 'partial', fits: verdict.fit.fits, total };
  }
  if (verdict.reason === 'too_large') return { kind: 'unknown' };
  return { kind: 'refused', reason: verdict.reason };
}

export interface WarnLine { key: string; params?: Record<string, string | number> }

/**
 * Предупреждение В МОМЕНТ отправки (§2.8 замысла) — ДАННЫМИ, а не разметкой.
 *
 * ⚠️ ПОЧЕМУ ДАННЫМИ. Замок на текст страницы сторожит текст, а не работу:
 * владелец уже замерял, что удаление блока дисклеймера целиком даёт НОЛЬ
 * красных. Здесь строки называет функция, компонент печатает по строке на
 * элемент, а тест сверяет РАЗМЕТКУ С ТЕМ, ЧТО НАЗВАЛА ФУНКЦИЯ — и число
 * строк, и текст. Краснеет и снятие строки из функции, и снятие её из
 * разметки при живой функции.
 *
 * ⚠️ `known: false` — не то же, что `turn: 0`. Сторона решает по этому числу,
 * показывать ли переписку; не узнали — так и пишем, а согласие спрашиваем всё
 * равно (§2.4 замысла).
 */
export function presentWarning(
  input: { count: number; arbiter: `0x${string}`; turn: ArbiterTurn },
): { lines: WarnLine[] } {
  return {
    lines: [
      { key: 'chat.present_warn_who', params: { n: input.count, arbiter: input.arbiter } },
      input.turn.known
        ? { key: 'chat.present_warn_turn', params: { n: input.turn.turn } }
        : { key: 'chat.present_warn_turn_unknown' },
      // Третьи лица: в переписке двоих почти всегда есть третий — адрес
      // клиента, чей-то телефон, имя человека, к спору не причастного.
      { key: 'chat.present_warn_everything' },
      // §2.10: обещать «арбитр не сможет скачать» НЕЛЬЗЯ.
      { key: 'chat.present_warn_files' },
      { key: 'chat.present_warn_final' },
    ],
  };
}

/* ───────────────────────────── факты цепи ────────────────────────────── */

/**
 * Статус сделки — из ЦЕПИ, в момент вопроса. ⚠️ И это ЕДИНСТВЕННОЕ своё
 * чтение цепи в этом файле.
 *
 * Кто ведёт спор и чем его печатать — `readDisputeArbiterKey` Задачи 5, и
 * второго правила здесь нет намеренно. Правило это составное: сначала
 * `getDisputeClaimer`, при нуле — `getPendingVerdict(...).arbiter` с
 * проверкой `submittedAt != 0` (клейм стирается, запись о вердикте
 * остаётся). Возьми кнопка один `getDisputeClaimer` — после финализации она
 * говорила бы «арбитра нет», пока релеер на том же сервере отдаёт ящик
 * подавшему вердикт: два ответа на один вопрос, и оба «из цепи».
 */
export async function readAgreementStatus(
  publicClient: PublicClient, agreement: `0x${string}`,
): Promise<number> {
  return Number(await publicClient.readContract({
    address: agreement, abi: AGREEMENT_ABI as Abi, functionName: 'status',
  }));
}

/** Готовый снимок Задачи 5 — тот исход `readDisputeArbiterKey`, у которого
 *  есть и адрес, и ключ, и байты печати. */
export type ReadyArbiterKey = Extract<DisputeArbiterKey, { state: 'ready' }>;

/**
 * Разложить снимок на «что показали человеку» и «чем печатать».
 *
 * ⚠️ ЗДЕСЬ НЕТ НИ ОДНОГО ПРЕОБРАЗОВАНИЯ, И ЭТО ГЛАВНОЕ. Байты печати
 * приезжают из Задачи 5 уже клеймёными (`boxKeyBytes: ArbiterBoxKeyBytes`),
 * и отдаются ТЕМ ЖЕ объектом. Посчитать их здесь заново
 * (`arbiterBoxKeyBytes(key.boxKey)`) значило бы завести переходу, сделанному
 * ради единственности, второе место — при побайтно одинаковом результате,
 * то есть молча. Ловится это тождеством в T28 (`toBe`), а не равенством.
 */
export function presentedFromKey(
  key: ReadyArbiterKey,
): { presented: PresentedTo; arbiterBoxKey: ArbiterBoxKeyBytes } {
  return {
    presented: { arbiter: key.arbiter, boxKey: key.boxKey },
    arbiterBoxKey: key.boxKeyBytes,
  };
}

/* ────────────────── заверения, черновик, состояние мешка ─────────────── */

/**
 * Заверения ДРУГИХ пар ключей — списком (пункт 48).
 *
 * ⚠️ ОДНО НЫНЕШНЕЕ ЗАВЕРЕНИЕ — ЭТО ОБВИНЕНИЕ ЧЕСТНОГО ЧЕЛОВЕКА. Собеседник,
 * вошедший по коду восстановления, подписал часть сообщений ПРЕЖНИМ ключом;
 * читалка возьмёт нынешнее заверение, `verifyFrameEvidence` сверит ключ
 * побайтово и раньше подписи — арбитр увидит `frame: malformed` и
 * `attestation: wrong_keys`, то есть ровно то, что он увидел бы на
 * сочинённой цепочке.
 *
 * ⚠️ ПОЧЕМУ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ ВЫРАЖЕНИЕ В КОМПОНЕНТЕ. Нажатие в этом
 * проекте не проверяется ничем: всё, что осталось внутри обработчика, не
 * сторожится. Здесь у наполнения один хозяин и вызываемый замок (T20), а
 * состав контейнера меряется отдельно (T21).
 */
export function otherAttestationsOf(
  keys: Pick<PeerChatKeys, 'attestation' | 'attestationHistory'>,
): ChatKeyAttestation[] {
  return [keys.attestation, ...(keys.attestationHistory ?? [])]
    .filter((a): a is ChatKeyAttestation => Boolean(a));
}

/* ───────────── дешёвый снимок для прикидки «сколько влезает» ──────────── */

/**
 * Три источника прикидки — и ни одного лишнего.
 *
 * ⚠️ СЧЁТА АРБИТРОВ ЗДЕСЬ НЕТ НАМЕРЕННО. `arbiterTurnOf` обходит логи: один
 * `eth_getLogs` при удаче и до `TURN_MAX_CHUNKS` = 64 кусков у провайдера,
 * режущего диапазон (Задача 5). Нужен он ОДНОЙ строке предупреждения, а не
 * прикидке, и живёт в `takeSnapshot` компонента — то есть в `toWarning`, один
 * раз на предъявление.
 */
export interface PrepDeps {
  /** Кто ведёт спор и чем печатать — `readDisputeArbiterKey` Задачи 5. */
  readArbiterKey: () => Promise<DisputeArbiterKey>;
  /** Ключи собеседника из справочника. */
  readPeerKeys: () => Promise<Pick<PeerChatKeys, 'boxKey' | 'attestation' | 'attestationHistory'>>;
  /**
   * ⚠️ КОШЕЛЁК. Докстринг `ensureChatKeyAttestation` разрешает вызов ТОЛЬКО
   * по человеческому действию «предъявить арбитру»; здесь он случается не
   * более одного раза за открытие выбора — это держит `pickingPrep`.
   */
  ensureAttestation: () => Promise<ChatKeyAttestation>;
}

/** То, чем считается прикидка. ⚠️ Пять полей, и `turn` среди них нет. */
export interface PresentPrep {
  presented: PresentedTo;
  arbiterBoxKey: ArbiterBoxKeyBytes;
  peerBoxKey: Uint8Array;
  ownAttestation: ChatKeyAttestation;
  otherAttestations: ChatKeyAttestation[];
}

export type PrepVerdict =
  | { ok: true; prep: PresentPrep }
  | { ok: false; reason: PresentRefusal };

/**
 * Снять дешёвый снимок. ⚠️ НЕ БРОСАЕТ: у прикидки та же дисциплина, что у
 * отправки — вердикт с именем, а не поломка модалки.
 */
export async function takePresentPrep(deps: PrepDeps): Promise<PrepVerdict> {
  let key: DisputeArbiterKey;
  try {
    key = await deps.readArbiterKey();
  } catch {
    return { ok: false, reason: 'chain_unavailable' };
  }
  // «Не спросили», «некому», «нечем» — три разные новости, и текст у каждой свой.
  if (key.state === 'unreadable') return { ok: false, reason: 'chain_unavailable' };
  if (key.state === 'no_arbiter') return { ok: false, reason: 'arbiter_left' };
  if (key.state === 'no_key') return { ok: false, reason: 'arbiter_has_no_key' };

  let peerKeys: Pick<PeerChatKeys, 'boxKey' | 'attestation' | 'attestationHistory'>;
  try {
    peerKeys = await deps.readPeerKeys();
  } catch {
    return { ok: false, reason: 'offline' };
  }

  let ownAttestation: ChatKeyAttestation;
  try {
    ownAttestation = await deps.ensureAttestation();
  } catch {
    // Кошелёк не ответил или человек отказался подписывать. Лечение то же
    // самое, что у незаверенных ключей: подписать. `offline` тут было бы
    // враньём — сервер ни при чём.
    return { ok: false, reason: 'attestation_missing' };
  }

  return {
    ok: true,
    prep: {
      // ⚠️ Адрес, ключ и ГОТОВЫЕ байты печати — из одного чтения Задачи 5.
      ...presentedFromKey(key),
      peerBoxKey: peerKeys.boxKey,
      otherAttestations: otherAttestationsOf(peerKeys),
      ownAttestation,
    },
  };
}

/**
 * Сеанс выбора: снимок берётся ОДИН раз, сколько бы раз его ни спросили.
 *
 * ⚠️ ЗАЧЕМ ОБЪЕКТ, А НЕ ПРОСТО ФУНКЦИЯ. Пересчёт «сколько влезает» зовётся
 * на КАЖДУЮ отметку, а нажатие в этом проекте не исполняется ни одним тестом
 * — значит «зовём один раз» дисциплиной не удержать: следующая правка
 * обработчика вернёт снимок на каждый тик, и красных не будет ни одного.
 * Здесь это держит форма: помнится само ОБЕЩАНИЕ, поэтому и двадцать
 * одновременных отметок склеиваются в один поход (T30).
 *
 * ⚠️ ОТКАЗ ЗАПОМИНАЕТСЯ ТОЖЕ, и цена этого названа: чтобы попробовать снова,
 * человек закрывает и открывает выбор. Иначе двадцать отметок на молчащем
 * узле дали бы двадцать попыток — ровно ту беду, ради которой сеанс заведён.
 */
export function pickingPrep(deps: PrepDeps): { get: () => Promise<PrepVerdict> } {
  let pending: Promise<PrepVerdict> | null = null;
  return { get: () => (pending ??= takePresentPrep(deps)) };
}

/**
 * Выбор сообщений из сохранённого контейнера.
 *
 * ⚠️ ЭТО «ОДНО НАЖАТИЕ» ИЗ §2.3 ЗАМЫСЛА, И ЭТО НЕ ПЕРЕСЫЛКА. Разовые ключи
 * запечатаны на ТОГО арбитра внутри `buildPresentation` (`keys[].forArbiter`),
 * поэтому сохранённый мешок новому арбитру не годится ни при каких условиях.
 * Помнится ВЫБОР, сборка повторяется на нынешнем ключе. Написать «перешлём
 * сохранённое» было бы неправдой на уровне криптографии.
 */
export function selectionFromContainer(
  container: Pick<PresentationContainer, 'frames'>,
): { seq: number; sender: `0x${string}` }[] {
  const seen = new Set<string>();
  const out: { seq: number; sender: `0x${string}` }[] = [];
  for (const f of container.frames ?? []) {
    const sender = String(f.sender).toLowerCase() as `0x${string}`;
    const id = `${sender}|${f.seq}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ seq: f.seq, sender });
  }
  return out;
}

export type SentBagState =
  | { kind: 'unknown' }
  | { kind: 'placed';  uploadedAt: number }
  | { kind: 'fetched'; uploadedAt: number; fetchedAt: number };

/**
 * Что стало с ЭТИМ мешком — по описи, а не по надежде.
 *
 * ⚠️ «НЕ ЗНАЮ» И «НЕ ЗАБИРАЛИ» — РАЗНЫЕ ВЕЩИ. Описи нет (не прочиталась, нет
 * пропуска) или мешка в ней нет — это `unknown`, и человеку так и говорится.
 * Сказать «не забрали» там, где мы просто не спросили, значит соврать ровно в
 * том месте, ради которого надпись и заводилась.
 * ⚠️ И «забрали» — про БАЙТЫ, не про глаза, и без имени: опись имени не
 * хранит (см. `DisputeBoxBag.fetchedAt`).
 */
export function sentBagState(list: DisputeBoxList | null, key: string): SentBagState {
  const bag = list?.bags.find(b => b.key === key);
  if (!bag) return { kind: 'unknown' };
  return bag.fetchedAt === null
    ? { kind: 'placed', uploadedAt: bag.uploadedAt }
    : { kind: 'fetched', uploadedAt: bag.uploadedAt, fetchedAt: bag.fetchedAt };
}

/** Что уже положено в ящик по ЭТОЙ сделке — ключ мешка и серверное время. */
export interface SentBagRecord { key: string; uploadedAt: number }

/**
 * Последнее ОТПРАВЛЕННОЕ предъявление этой сделки — из черновиков.
 *
 * ⚠️ ЗАЧЕМ ОНО ВООБЩЕ. «Положено в ящик» и «забрали» — единственное, что
 * сторона получает взамен отправленной переписки (§4 замысла). Держать их в
 * состоянии React значит показать пустоту всякому, кто закрыл вкладку: мешок
 * лежит, возможно уже забран, а человек об этом не узнает и, скорее всего,
 * предъявит второй раз. Черновик это уже помнит — `markPresentationSent`
 * пишет `bagKey` и СЕРВЕРНЫЙ `sentAt`, и до этой задачи их не читал никто.
 *
 * ⚠️ ПОРЯДОК БЕРЁТСЯ У ХОЗЯИНА: `readPresentationDrafts` отдаёт список
 * отсортированным по `issuedAt` убыванию (`presentationDraft.ts:295`),
 * поэтому «первый подходящий» и есть «самый свежий». Своей сортировки здесь
 * нет намеренно — это был бы второй хозяин порядка.
 * ⚠️ Записи без `bagKey`/`sentAt` пропускаются, а не подставляются нулями:
 * «положено неизвестно когда» — это не свидетельство.
 */
export function lastSentBag(
  drafts: readonly PresentationDraft[], dealId: string,
): SentBagRecord | null {
  const deal = String(dealId).toLowerCase();
  for (const d of drafts) {
    if (d.state !== 'sent') continue;
    if (String(d.dealId).toLowerCase() !== deal) continue;
    if (typeof d.bagKey !== 'string' || d.bagKey.length === 0) continue;
    if (typeof d.sentAt !== 'number' || !Number.isFinite(d.sentAt)) continue;
    return { key: d.bagKey, uploadedAt: d.sentAt };
  }
  return null;
}

/**
 * Последний черновик ЭТОЙ сделки — ОТПРАВЛЕННЫЙ ИЛИ НЕТ.
 *
 * ⚠️ ПОРЯДОК БЕРЁТСЯ У ХОЗЯИНА, И «ПОСЛЕДНИЙ» ЗДЕСЬ — ЭТО `[0]`.
 * `readPresentationDrafts` отдаёт список по `issuedAt` УБЫВАНИЮ
 * (`presentationDraft.ts:295`), значит первый подходящий и есть самый свежий,
 * а `[длина − 1]` — самый СТАРЫЙ. Своей сортировки здесь нет намеренно: это
 * был бы второй хозяин порядка. Сцена не редкая: `sendPresentation` кладёт
 * черновик ДО отправки, поэтому каждый отказ `arbiter_changed`/`key_changed`
 * оставляет ещё один собранный черновик (T31).
 *
 * ⚠️ ОТПРАВЛЕННЫЕ БЕРУТСЯ ТОЖЕ, И БЕЗ ЭТОГО §2.3 НЕ СУЩЕСТВУЕТ. «С
 * сохранённого черновика это одно нажатие» — про сцену «предъявили арбитру
 * №1, арбитра сменили, просят предъявить заново»: там черновик уже помечен
 * `sent`, и отбор по `state === 'built'` не предложил бы НИЧЕГО (T32).
 * Пересылки при этом нет и быть не может — возвращается ВЫБОР, сборка
 * повторяется на нынешнем ключе (раздел 6 договора шапки), и текст модалки
 * говорит про это отдельными словами (`present_draft_sent`).
 */
export function lastDraftOfDeal(
  drafts: readonly PresentationDraft[], dealId: string,
): PresentationDraft | null {
  const deal = String(dealId).toLowerCase();
  for (const d of drafts) {
    if (String(d.dealId).toLowerCase() !== deal) continue;
    return d;
  }
  return null;
}

/**
 * То же самое, но с диском. ⚠️ НЕ БРОСАЕТ: не прочитались черновики — значит
 * «нечего восстанавливать», а не поломка кнопки при открытии чата.
 */
export async function restoreSentBag(
  presenter: `0x${string}`,
  dealId: `0x${string}`,
  read: (p: `0x${string}`) => Promise<PresentationDraft[]> = readPresentationDrafts,
): Promise<SentBagRecord | null> {
  try {
    return lastSentBag(await read(presenter), dealId);
  } catch {
    return null;
  }
}

/* ───── монтирование и такт описи: РЕШЕНИЯ ВЫНЕСЕНЫ, эффект остаётся тонким ─────
 *
 * ⚠️ ЗАЧЕМ ЭТОТ РАЗДЕЛ СУЩЕСТВУЕТ (ревью, круг 1, I-1). Прежде здесь было
 * написано, что замка на эту работу «нет и БЫТЬ НЕ МОЖЕТ до появления окружения
 * отрисовки», и это было шире правды: приём есть, и он в этом же репозитории —
 * Задача 5 вынесла тело хука в `handleChainLogsImpl(logs, deps)`, а обычный
 * node-тест зовёт её напрямую и меряет РАБОТУ (`chainEventBus.test.ts`).
 *
 * Отдача здесь больше, чем «замок на вызов»: в эффектах лежали ДВА правила,
 * которых не сторожило ничто, — «восстановленное СТАРОЕ не затирает свежее» и
 * «отказ описи не стирает уже известное». Оба названы несущими в докстрингах и
 * оба портились без единого красного.
 *
 * Непроверяемым остаётся ровно одно — НАЖАТИЕ. Проводка (что эти функции
 * действительно отданы эффектам) сторожится вторым слоем — сверкой ТЕКСТА
 * исходника, и природа того слоя названа там вслух.
 */

/** Ссылка на положенный мешок в состоянии экрана. */
export interface SentBagRef { key: string }

/**
 * ⚠️ ВОССТАНОВЛЕННОЕ СТАРОЕ НЕ ЗАТИРАЕТ СВЕЖЕЕ. Чтение диска асинхронное: если
 * человек успел отправить заново раньше, чем оно вернулось, поднятый из
 * черновика ключ обязан уступить. Правило жило функциональным обновлением
 * внутри эффекта — то есть не меряется ничем; здесь у него есть вызывающий.
 */
export function keepFirstSent(prev: SentBagRef | null, back: SentBagRecord): SentBagRef | null {
  return prev ?? { key: back.key };
}

/** То же правило для «положено»: известное не понижаем до восстановленного. */
export function keepKnownBox(prev: SentBagState, back: SentBagRecord): SentBagState {
  return prev.kind === 'unknown' ? { kind: 'placed', uploadedAt: back.uploadedAt } : prev;
}

/** Тождество состояний. ⚠️ Нужно не ради красоты: без него каждый такт описи
 *  отдавал бы новый объект, экран перерисовывался бы, а эффект такта (он
 *  зависит от состояния) перезапускался бы — опрос вместо раз в тридцать секунд
 *  шёл бы со скоростью перерисовки. */
export function sameBoxState(a: SentBagState, b: SentBagState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'unknown' || b.kind === 'unknown') return true;
  if (a.uploadedAt !== b.uploadedAt) return false;
  return a.kind !== 'fetched' || b.kind !== 'fetched' || a.fetchedAt === b.fetchedAt;
}

/**
 * Что показывать после ответа описи.
 *
 * ⚠️ ЗДЕСЬ ЖИВЁТ ЕДИНСТВЕННЫЙ ПОТРЕБИТЕЛЬ `indexTrusted` НА СТОРОНЕ СТОРОНЫ
 * (ревью, круг 1, I-3). Сцена: опись релеера терялась и восстанавливалась с
 * диска, у восстановленных записей нет `deal`, они выпадают из выдачи — и
 * мешка, который лежит, в ответе нет. Без этой ветки строка «Положено в ящик
 * спора · 14:02» ИСЧЕЗАЛА бы, сменившись на «узнать не удалось», при том что
 * сервер прямым текстом сказал «моей описи не верь», а у стороны есть и ответ
 * склада, и черновик. Понижать известное по недоверенной описи нельзя.
 *
 * ⚠️ А при ДОВЕРЕННОЙ описи `unknown` выставляется честно: мешка в ней больше
 * нет (например, вышел срок хранения, Задача 2) — это ответ сервера, а не наша
 * немота.
 */
export function boxStateFromList(
  prev: SentBagState, list: DisputeBoxList, key: string,
): SentBagState {
  const next = sentBagState(list, key);
  if (next.kind === 'unknown' && !list.indexTrusted && prev.kind !== 'unknown') return prev;
  return sameBoxState(prev, next) ? prev : next;
}

/** Опрашивать ли опись дальше. ⚠️ «Забрали» — состояние конечное: узнавать
 *  больше нечего, а бюджет чтения общий со складом. */
export function shouldPollBox(state: SentBagState): boolean {
  return state.kind !== 'fetched';
}

export interface MountRestoreIO {
  presenter: `0x${string}`;
  agreement: `0x${string}`;
  /** Жив ли ещё вызывающий (вкладку закрыли, чат переключили). */
  alive: () => boolean;
  applySent: (fn: (prev: SentBagRef | null) => SentBagRef | null) => void;
  applyBox: (fn: (prev: SentBagState) => SentBagState) => void;
  read?: (p: `0x${string}`) => Promise<PresentationDraft[]>;
}

/**
 * Тело эффекта монтирования, вынесенное целиком. ⚠️ НЕ БРОСАЕТ (через
 * `restoreSentBag`): не прочитались черновики — значит «восстанавливать
 * нечего», а не поломка кнопки при открытии чата.
 */
export async function restoreMountImpl(io: MountRestoreIO): Promise<void> {
  const back = await restoreSentBag(io.presenter, io.agreement, io.read);
  if (!io.alive() || !back) return;
  io.applySent(prev => keepFirstSent(prev, back));
  io.applyBox(prev => keepKnownBox(prev, back));
}

export interface BoxTickIO {
  presenter: `0x${string}`;
  agreement: `0x${string}`;
  bagKey: string;
  alive: () => boolean;
  /** ⚠️ Пропуск ИЗ КЭША: такт описи кошелёк не будит. Нет пропуска — не идём. */
  peekPass: (presenter: `0x${string}`) => string | null;
  list: (pass: string, agreement: `0x${string}`) => Promise<DisputeBoxList>;
  applyBox: (fn: (prev: SentBagState) => SentBagState) => void;
}

/**
 * Один такт опроса описи, вынесенный целиком.
 *
 * ⚠️ ТРИ ПРАВИЛА, И КАЖДОЕ ТЕПЕРЬ МЕРЯЕТСЯ. Нет пропуска — в сеть не идём
 * вовсе (кошелёк не будим); опись не ответила — оставляем известное как есть
 * («положено» подтвердил склад, и сбой сети этого не отменяет); ответила —
 * решает `boxStateFromList`, у которой своя оговорка про `indexTrusted`.
 */
export async function tickBoxImpl(io: BoxTickIO): Promise<void> {
  const pass = io.peekPass(io.presenter);
  if (!pass) return;
  let list: DisputeBoxList;
  try {
    list = await io.list(pass, io.agreement);
  } catch {
    return;   // опись не ответила — известное не трогаем
  }
  if (!io.alive()) return;
  io.applyBox(prev => boxStateFromList(prev, list, io.bagKey));
}

/* ──────────────────────────────── отправка ───────────────────────────── */

export interface SendPresentationDeps {
  agreement: `0x${string}`;
  presenter: `0x${string}`;
  peer: `0x${string}`;
  /**
   * ⚠️ СНИМОК, ПОКАЗАННЫЙ ЧЕЛОВЕКУ: тот арбитр и тот ключ, про которых его
   * спросили и на которых он согласился. Не «свежее чтение»: величина, на
   * которую дано согласие, обязана участвовать в проверке — иначе сверяются
   * два свежих чтения между собой и не ловят ничего.
   */
  presented: PresentedTo;
  /**
   * ⚠️ БАЙТЫ ПЕЧАТИ ИЗ ТОГО ЖЕ СНИМКА, УЖЕ КЛЕЙМЁНЫЕ. Приезжают из Задачи 5
   * (`readDisputeArbiterKey(...).boxKeyBytes`) через `presentedFromKey` —
   * своего перехода `arbiterBoxKeyBytes` на этом пути нет ни одного. Клеймо
   * на ЭТОМ входе держит `npm run type-check`: `peerBoxKey` (голый
   * `Uint8Array`) сюда не подставить.
   */
  arbiterBoxKey: ArbiterBoxKeyBytes;
  /** Ключ печати второй стороны — из справочника, уже байтами. */
  peerBoxKey: Uint8Array;
  selected: { seq: number; sender: `0x${string}` }[];
  session: ChatSession;
  ownAttestation: ChatKeyAttestation;
  /** ⚠️ СПИСКОМ (пункт 48). Наполняется `otherAttestationsOf`, и только ею. */
  otherAttestations?: readonly ChatKeyAttestation[];
  /** Согласие ЭТОГО предъявления. Прошлое согласие сюда не доезжает. */
  consent: boolean;
  publicClient?: PublicClient;
  readStatus: () => Promise<number>;
  /** Свежее чтение Задачи 5 — сверяется со СНИМКОМ, не с другим чтением. */
  readArbiterNow: () => Promise<DisputeArbiterKey>;
  getPass: () => Promise<string>;
  put: (
    pass: string, agreement: `0x${string}`, sealed: Uint8Array,
    sealedFor: `0x${string}` | null,
  ) => Promise<{ key: string; uploadedAt: number }>;
  /**
   * ⚠️ ЧЕРНОВИК И ПОМЕТКА — ЗАВИСИМОСТИ, И ЭТО НЕ УКРАШЕНИЕ. Без следа в
   * замере мутации «пометить раньше склада» и «черновик не ложится»
   * отличаются от честного порядка НИЧЕМ: конечное состояние на успешной
   * сцене одинаково, и число красных было бы враньём. Умолчания — боевые.
   */
  saveDraft?: (draft: PresentationDraft) => Promise<DraftSaveVerdict>;
  markSent?: (
    presenter: `0x${string}`, dealId: `0x${string}`, issuedAt: number,
    bagKey: string, sentAt: number,
  ) => Promise<DraftMarkVerdict>;
  now?: () => number;
}

export type PresentVerdict =
  | { ok: true; bagKey: string; uploadedAt: number;
      draftSaved: DraftSaveVerdict; draftMarked: DraftMarkVerdict }
  | { ok: false; reason: PresentRefusal };

/**
 * Что сказать человеку про ЗАПИСЬ НА ЭТОМ УСТРОЙСТВЕ. `null` — говорить нечего.
 *
 * ⚠️ ПРИЕХАЛО РЕВЬЮ (круг 1, I-4): `draftSaved`/`draftMarked` возвращались и не
 * читались никем. `savePresentationDraft` честно отдаёт `disk_unavailable` /
 * `lock_timeout` (частный режим, кончившаяся квота, занятый замок), отправка
 * при этом продолжается — и это правильно, мешок важнее записи. Но человеку не
 * говорилось НИЧЕГО, а последствие у него заметное: после перезагрузки
 * «Положено в ящик спора» пропадёт (восстанавливать нечего), вход «вернуть
 * отметки» окажется пустым, — при том что мешок в ящике лежит. То есть пятый
 * вопрос обстоятельств («если сломается — узнает ли?») был отвечен «нет».
 *
 * ⚠️ Это НЕ отказ отправки: `ok` остаётся `true`, мешок уехал. Строка говорит
 * ровно про устройство и прямо называет, что мешок в ящике — ответ сервера, а
 * не наша запись.
 */
export function draftKeepNotice(verdict: PresentVerdict): string | null {
  if (!verdict.ok) return null;
  if (verdict.draftSaved === 'saved' && verdict.draftMarked === 'saved') return null;
  return 'chat.present_draft_not_saved';
}

/**
 * Отправки, идущие ПРЯМО СЕЙЧАС, по ящику.
 *
 * ⚠️ ЭТО ЗАМОК ОДНОЙ ВКЛАДКИ, И БОЛЬШЕ НИЧЕГО. Две настоящие вкладки — два
 * экземпляра модуля, и он их не связывает: два мешка лягут в ящик. Число
 * названо замером (T12), а не спрятано; общая память вкладок закрыла бы и
 * это, но цена — ещё один замок на пути отправки, и в объём Выкатки 1 он не
 * входит.
 */
const _sending = new Set<string>();

/** Только тесты. */
export function _resetSendingForTest(): void { _sending.clear(); }

/**
 * Отказ ящика → имя. ⚠️ РАЗБОР ПО `code`, А НЕ ПО КЛАССУ СТАТУСА.
 *
 * Задача 1 сознательно отступила от «правила 2» склада (единый 404 на все
 * беды) и завела различимые коды — именно затем, чтобы экран объяснил
 * человеку, что не так. Схлопнуть их в один «ящик не принял» значит выбросить
 * всю её работу на подходе к глазам: «вы не сторона этой сделки», «спор
 * закрылся», «цепь не ответила» и «слишком часто» — четыре разные беды с
 * четырьмя разными лечениями, а первая вообще означает, что человек не туда
 * пришёл.
 *
 * ⚠️ Подклассы проверяются РАНЬШЕ базового: все три наследуют
 * `BagTransportError`, и обратный порядок съел бы их молча.
 * ⚠️ `not_the_arbiter` в этот разбор не попадает намеренно: он бывает только
 * на чтении описи, а туда человек не нажимал — там отказ превращается в
 * «узнать не удалось», а не в текст про отправку.
 */
export function refusalOfBoxError(err: unknown): PresentRefusal {
  if (err instanceof BagPassError) return 'pass_refused';
  if (err instanceof BagRateLimitError) return 'rate_limited';
  if (err instanceof BagBudgetError) return 'rate_limited';   // наш местный бюджет чтения
  if (err instanceof BagTransportError) {
    switch (err.code) {
      case 'not_a_party':        return 'not_a_party';
      case 'not_disputed':       return 'not_disputed';
      case 'no_such_deal':       return 'no_such_deal';
      case 'chain_unavailable':  return 'chain_unavailable';
      // 429 обычно приходит классом выше; сюда попадёт, только если сервер
      // отдаст код без своего статуса — тогда лечение то же самое.
      case 'rate_limited_ip':
      case 'rate_limited_write':
      case 'rate_limited_read':
      case 'rate_limited_box_chain': return 'rate_limited';
      default: break;
    }
    // Ответа не было вовсе (обрыв до статуса) — это про сеть, а не про ящик.
    if (err.status === undefined) return 'offline';
    // Всё остальное из перечня Задачи 1 (`invalid_*`, `empty_bag`,
    // `bag_content_type`, `payload_too_large`, `internal_error`,
    // `write_failed`, `bag_not_found`, `not_the_arbiter`) — общая дверь:
    // чинить человеку нечего, это наш мусор или беда сервера.
    return 'box_refused';
  }
  // Сеть отвалилась: `fetch` бросает TypeError, а не отдаёт ответ.
  return 'offline';
}

/**
 * Снимок против свежего чтения. ⚠️ АВТОРИТЕТ — `comparePresentedWith` Задачи
 * 5, а не сравнение адресов здесь: у правила «что считать сменой» обязан
 * быть один хозяин, и он умеет то, чего адресная сверка не умеет вовсе —
 * отличить `key_changed` (тот же арбитр повернул ключ чата).
 */
function changeRefusal(
  presented: PresentedTo, now: DisputeArbiterKey,
): { ok: false; reason: PresentRefusal } | null {
  // «Не спросили» — не «сменился», и склеивать их нельзя: человеку надо
  // повторить попытку, а не пересобирать предъявление.
  if (now.state === 'unreadable') return { ok: false, reason: 'chain_unavailable' };
  const signal = comparePresentedWith(presented, now);
  if (signal) return { ok: false, reason: signal.reason };
  // ⚠️ Достижимо только если Задача 5 промолчала на состоянии, где
  // предъявлять уже некому (её договор этого не допускает, T23 это и
  // сторожит). Молча отправлять в таком случае мы не будем.
  if (now.state !== 'ready') return { ok: false, reason: 'arbiter_left' };
  return null;
}

/**
 * Собрать, сохранить черновик, запечатать на арбитра, положить в ящик,
 * пометить черновик отправленным.
 *
 * ⚠️ ПОРЯДОК НЕСУЩИЙ, и одна ступень в договоре шапки пропущена. Договор
 * называет «сборка → печать → PUT → пометка», но `markPresentationSent` ищет
 * черновик по `(presenter, dealId, issuedAt)` и возвращает `'not_found'`,
 * если его нет (`presentationDraft.ts:325`) — то есть без сохранения ПЕРЕД
 * отправкой последний шаг не делает ничего и всегда. Черновик ложится сразу
 * после сборки: это и делает пометку осмысленной, и оставляет собранное
 * предъявление на диске, если склад откажет или вкладку закроют.
 *
 * ⚠️ СНИМОК СВЕРЯЕТСЯ С ЦЕПЬЮ ДВАЖДЫ, И ЭТО РАЗНЫЕ ДВЕРИ. Дешёвая — до
 * сборки: не жечь пять секунд крипто, если спор уже закрыт или арбитр уже
 * другой. Авторитетная — ПЕРЕД записью в ящик: между сборкой и складом
 * проходит всё время печати, и именно там арбитра успевают сменить. Сверяется
 * оба раза СНИМОК (`deps.presented`) — то, что человек видел и на что
 * соглашался, а не два свежих чтения между собой: те сходятся всегда.
 *
 * ⚠️ НЕ БРОСАЕТ, И ТЕПЕРЬ ЭТО ПРАВДА ПРО ВЕСЬ ПУТЬ, А НЕ ПРО ЕГО ПОЛОВИНУ
 * (ревью, круг 1, I-5). Обёрнуты все четыре рода броска: чтения цепи
 * (`chain_unavailable`), сборка/черновик/печать (`internal_error`, до склада),
 * пропуск и склад (`refusalOfBoxError`) и пометка черновика после успешной
 * отправки (не отказ вовсе — `draftKeepNotice`). Голый бросок отсюда уходил бы
 * мимо `doSend` в необработанный отказ промиса: человек посреди спора получал
 * бы молчащую кнопку вместо причины.
 */
export async function sendPresentation(deps: SendPresentationDeps): Promise<PresentVerdict> {
  if (deps.consent !== true) return { ok: false, reason: 'no_consent' };

  const box = deps.agreement.toLowerCase();
  if (_sending.has(box)) return { ok: false, reason: 'already_sending' };
  _sending.add(box);
  try {
    let status: number;
    try {
      status = await deps.readStatus();
    } catch {
      return { ok: false, reason: 'chain_unavailable' };
    }
    if (status !== AGREEMENT_STATUS_DISPUTED) return { ok: false, reason: 'not_disputed' };

    // Дешёвая дверь: сменился — не собираем вовсе.
    let before: DisputeArbiterKey;
    try {
      before = await deps.readArbiterNow();
    } catch {
      return { ok: false, reason: 'chain_unavailable' };
    }
    const changedEarly = changeRefusal(deps.presented, before);
    if (changedEarly) return changedEarly;

    // ⚠️ СБОРКА, ЧЕРНОВИК И ПЕЧАТЬ — ПОД ОДНИМ `try` (ревью, круг 1, I-5).
    // Все три БРОСАЮТ: сборщик — `TypeError` на чужой форме входа, черновик —
    // на негодной записи. Голыми они уводили бросок мимо `doSend` (там
    // `try/finally` без `catch`) в `void doSend()`, то есть в необработанный
    // отказ промиса: человек не получал ни тоста, ни причины, окно оставалось
    // открытым, а кнопка — живой. Здесь у этого случая есть имя, и текст у
    // него честный: до склада дело не дошло, значит «ничего не отправлено» —
    // правда.
    let container: PresentationContainer;
    let sealed: Uint8Array;
    let draftSaved: DraftSaveVerdict;
    try {
      const built = await buildPresentation({
        dealId: deps.agreement.toLowerCase() as `0x${string}`,
        presenter: deps.presenter,
        peer: deps.peer,
        // ⚠️ БАЙТЫ ИЗ СНИМКА, ГОТОВЫМИ: печатаем на того, про кого спросили, и
        // переход «ключ → байты» здесь не делается вовсе (он в Задаче 5).
        arbiterBoxKey: deps.arbiterBoxKey,
        peerBoxKey: toPeerBoxKeyBytes(deps.peerBoxKey),
        selected: deps.selected,
        session: deps.session,
        ownAttestation: deps.ownAttestation,
        // ⚠️ СПИСОК, а не одно заверение (пункт 48).
        otherAttestations: deps.otherAttestations,
        publicClient: deps.publicClient,
        now: deps.now,
      });
      if (!built.ok) return { ok: false, reason: built.reason };

      container = built.container;
      const wireBytes = presentationWireBytes(container);
      // Черновик — ДО отправки. См. ⚠️ про порядок выше.
      draftSaved = await (deps.saveDraft ?? savePresentationDraft)(
        draftFromContainer(container, wireBytes),
      );

      // ⚠️ Клеймо теряется ровно здесь и только здесь: `sealPresentation`
      // принимает голый Uint8Array (`presentationBag.ts:73`). Второго такого
      // стыка не заводить. Уходит ТО ЖЕ значение, что и в сборку, — одно поле
      // снимка, а не два вычисления.
      sealed = await sealPresentation(container, deps.arbiterBoxKey);
    } catch (err) {
      console.error('[present] сборка/черновик/печать сломались:', err);
      return { ok: false, reason: 'internal_error' };
    }

    // ⚠️ АВТОРИТЕТНАЯ СВЕРКА — ЗДЕСЬ, между печатью и складом.
    let after: DisputeArbiterKey;
    try {
      after = await deps.readArbiterNow();
    } catch {
      return { ok: false, reason: 'chain_unavailable' };
    }
    const changed = changeRefusal(deps.presented, after);
    if (changed) return changed;

    let bagKey: string;
    let uploadedAt: number;
    try {
      const pass = await deps.getPass();
      const stored = await deps.put(pass, deps.agreement, sealed, deps.presented.arbiter);
      bagKey = stored.key;
      // ⚠️ ВРЕМЯ СКЛАДА, А НЕ СВОИ ЧАСЫ: у «положено» и «забрал» обязан быть
      // один хозяин времени, иначе на телефоне со сбитыми часами порядок
      // событий у стороны и у арбитра разойдётся.
      uploadedAt = stored.uploadedAt;
    } catch (err) {
      return { ok: false, reason: refusalOfBoxError(err) };
    }

    // ⚠️ ПОМЕТКА ТОЖЕ МОЖЕТ БРОСИТЬ, И ЗДЕСЬ ЭТО НЕ ОТКАЗ ОТПРАВКИ. Мешок уже
    // в ящике: сказать «ничего не отправлено» было бы враньём с уверенным
    // лицом. Бросок приравнивается к честному вердикту черновика, и человек
    // узнаёт об этом отдельной строкой (`draftKeepNotice`), а не отказом.
    let draftMarked: DraftMarkVerdict;
    try {
      draftMarked = await (deps.markSent ?? markPresentationSent)(
        deps.presenter, deps.agreement.toLowerCase() as `0x${string}`,
        container.issuedAt, bagKey, uploadedAt,
      );
    } catch (err) {
      console.error('[present] пометка черновика сломалась (мешок УЖЕ в ящике):', err);
      draftMarked = 'disk_unavailable';
    }
    return { ok: true, bagKey, uploadedAt, draftSaved, draftMarked };
  } finally {
    _sending.delete(box);
  }
}
