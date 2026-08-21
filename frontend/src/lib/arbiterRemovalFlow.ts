/**
 * arbiterRemovalFlow.ts — решения потока сноса арбитра, БЕЗ разметки и без цепи.
 *
 * ⚠️ ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Снос перестал быть кнопкой и стал процессом из
 * четырёх шагов (замысел `2026-08-21-arbiter-screens-design.md`, раздел 4):
 * предложить → ждать 48 часов → исполнить или отозвать. Каждый шаг цепь
 * проверяет своими воротами, и форма обязана знать те же правила ЗАРАНЕЕ —
 * иначе человек узнаёт их отказом транзакции, уже подписав.
 *
 * Всё, что здесь есть, — чистые функции: их можно позвать из теста и получить
 * ответ, а не смотреть на разметку и гадать. Разметка потом сверяется отдельно.
 *
 * ⚠️ СВОИХ ЧИСЕЛ ЗДЕСЬ НЕТ НИ ОДНОГО. Ни 512 байт, ни 48 часов, ни 14 дней:
 * все три живут в цепи (`getMaxReasonBytes`, `getRemovalDelay`,
 * `getProposalTTL`) и приезжают сюда аргументами. Копия во фронте разошлась бы
 * молча и показала кнопку исполнения за час до того, как та заработает, —
 * ровно тот класс, из-за которого `useNoResponseFloor` спрашивает пол у цепи.
 * Единственная копия, которая здесь неизбежна, — кодировка поводов, и она уже
 * заведена в `arbiterRemovalCause.ts` с собственным замком на исходник
 * контракта. Второй копии не заводим: повод берём оттуда.
 */

import {
  CAUSE_NAMES,
  CHAIN_VERIFIABLE_CAUSES,
  type RemovalCauseName,
} from '@/lib/arbiterRemovalCause';

/* ─────────────────────────── повод ─────────────────────────── */

/**
 * Повод как его видит форма: имя, номер для цепи и признак «проверяет ли цепь
 * сама».
 *
 * ⚠️ НОМЕР — ЭТО ИНДЕКС В `CAUSE_NAMES`, А НЕ СДВИНУТЫЙ КОД ХРАНИЛИЩА.
 * `proposeRemoval(arbiter, cause, ...)` принимает перечисление
 * `ArbiterAccountabilityFacet.Cause` как есть, с нуля. Сдвиг
 * `REMOVAL_CAUSE_SHIFT` живёт ТОЛЬКО в поле `lastRemovalCause`, где ноль обязан
 * означать «не снимали». Перепутать их — значит предложить снос по соседнему
 * поводу: цепь примет, обвиняемый прочитает не то, в чём его обвиняют, а
 * `removeArbiterForCause` потом откажет `CauseDiffersFromProposal`.
 */
export interface RemovalCauseOption {
  name: RemovalCauseName;
  /** Значение перечисления для калдаты. */
  value: number;
  /** Проверит ли цепь этот повод своим состоянием. */
  verifiedByChain: boolean;
}

export const REMOVAL_CAUSE_OPTIONS: readonly RemovalCauseOption[] = CAUSE_NAMES.map(
  (name, value) => ({ name, value, verifiedByChain: CHAIN_VERIFIABLE_CAUSES.has(name) }),
);

/**
 * Повод по номеру ИЗ ЗАПИСИ ОБВИНЕНИЯ.
 *
 * ⚠️ ЭТО НЕ `decodeRemovalCause`, И ПУТАТЬ ИХ НЕЛЬЗЯ. Тот расшифровывает поле
 * `lastRemovalCause`, где к номеру прибавлен `REMOVAL_CAUSE_SHIFT`, чтобы ноль
 * означал «не снимали». В записи обвинения (`getRemovalProposal().cause`)
 * лежит перечисление КАК ЕСТЬ, с нуля: контракт кладёт туда `uint8(cause)` из
 * калдаты. Пропусти запись через тот декодер — и каждое обвинение читалось бы
 * поводом на единицу младше, то есть чужим.
 *
 * `null` — номер из контракта, которого этот фронт ещё не знает. Домысливать
 * тут нечем: «непонятный код» честнее любого из шести имён.
 */
export function causeByValue(value: number): RemovalCauseOption | null {
  return REMOVAL_CAUSE_OPTIONS.find((o) => o.value === value) ?? null;
}

export function causeOption(name: RemovalCauseName): RemovalCauseOption {
  const found = REMOVAL_CAUSE_OPTIONS.find((o) => o.name === name);
  // Недостижимо по типам, но молчаливый `undefined` отсюда уехал бы в калдату
  // нулём, то есть чужим поводом.
  if (!found) throw new Error(`неизвестный повод сноса: ${name}`);
  return found;
}

/* ─────────────────────── слова: счёт В БАЙТАХ ─────────────────────── */

/**
 * Длина слов В БАЙТАХ UTF-8 — так же, как её считает цепь.
 *
 * ⚠️ ЭТО НЕ `text.length`, И РАЗНИЦА НЕ КОСМЕТИЧЕСКАЯ. Контракт меряет
 * `bytes(reason).length` — то есть БАЙТЫ (`_requireWithinCap`,
 * `MAX_REASON_BYTES = 512`). В UTF-8 кириллическая буква занимает два байта,
 * эмодзи — четыре. Считай форма символы, и на кириллице счётчик соврал бы
 * ВДВОЕ: показал «осталось 256» там, где у цепи не осталось ни одного, а
 * транзакция вернула бы `ReasonTooLong` после подписи.
 *
 * Хозяин счёта здесь один, и он один нарочно: два места, считающие длину
 * по-разному, — это ровно тот класс, ради которого весь этот файл без своих
 * чисел. Замок — `arbiterRemovalFlow.test.ts`, сцена на кириллице.
 */
export function reasonByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Сколько байт ещё влезет. Отрицательное значение — перебор, и это видно. */
export function reasonBytesLeft(text: string, maxBytes: number): number {
  return maxBytes - reasonByteLength(text);
}

/* ────────────────────── проверки формы предложения ────────────────────── */

/**
 * Причины отказа — теми же именами, что у ворот контракта. Названия не
 * выдуманы: каждое имя ниже — это `revert` из `ArbiterAccountabilityFacet`,
 * который форма обязана не допустить до подписи.
 */
export type ProposalProblem =
  /** `ArbiterZeroAddress` — либо просто пустое поле. */
  | 'arbiterMissing'
  /** `EvidenceRequired`: непроверяемый повод без отпечатка. */
  | 'evidenceRequired'
  /** `ReasonRequired`: непроверяемый повод без слов. */
  | 'reasonRequired'
  /** `ReasonTooLong`. */
  | 'reasonTooLong'
  /** `ProposalAlreadyLive`: против этого арбитра уже стоит обвинение. */
  | 'proposalAlreadyLive'
  /** Потолок слов ещё не приехал из цепи — спрашивать нечем, значит и не пускаем. */
  | 'capUnknown';

export interface ProposalDraft {
  arbiter: string;
  cause: RemovalCauseName;
  /** `null` — файла не приложили. */
  evidenceDigest: `0x${string}` | null;
  reason: string;
  /** `null` — цепь ещё не ответила. НЕ ноль: ноль запретил бы любые слова. */
  maxReasonBytes: number | null;
  hasLiveProposal: boolean;
}

export interface ProposalCheck {
  ok: boolean;
  problems: ProposalProblem[];
  /** Проверит ли цепь выбранный повод сама — форма обязана сказать это вслух. */
  verifiedByChain: boolean;
}

/**
 * Порядок проверок повторяет порядок ворот контракта, и это не аккуратность
 * ради аккуратности: сначала длина, потом обязательность
 * (`_requireReason` читает `_requireWithinCap` первой). Разойдись форма с этим
 * порядком — обвинитель, приславший 5 килобайт на проверяемом поводе, увидел
 * бы «всё в порядке».
 */
export function checkProposal(draft: ProposalDraft): ProposalCheck {
  const { verifiedByChain } = causeOption(draft.cause);
  const problems: ProposalProblem[] = [];

  if (!/^0x[0-9a-fA-F]{40}$/.test(draft.arbiter)) problems.push('arbiterMissing');
  if (draft.hasLiveProposal) problems.push('proposalAlreadyLive');

  if (draft.maxReasonBytes === null) {
    problems.push('capUnknown');
  } else if (reasonByteLength(draft.reason) > draft.maxReasonBytes) {
    problems.push('reasonTooLong');
  }

  if (!verifiedByChain) {
    if (!draft.evidenceDigest) problems.push('evidenceRequired');
    if (reasonByteLength(draft.reason) === 0) problems.push('reasonRequired');
  }

  return { ok: problems.length === 0, problems, verifiedByChain };
}

/* ───────────────────── состояние обвинения во времени ───────────────────── */

/** Запись обвинения, как её отдаёт `getRemovalProposal`. */
export interface RemovalProposalRecord {
  cause: number;
  evidenceDigest: `0x${string}`;
  /** Секунды эпохи. Ноль — записи нет вовсе. */
  proposedAt: number;
  /** Нулевой адрес — обвинение положила САМА ЦЕПЬ, автора у него нет. */
  by: `0x${string}`;
  /** Ответ цепи на «живо ли», а не наш пересчёт: у этого вопроса один хозяин. */
  live: boolean;
}

export type RemovalStageKind =
  /** Записи нет — можно предлагать. */
  | 'none'
  /** Идут 48 часов. */
  | 'waiting'
  /** Пауза вышла, TTL не вышел — исполнять можно. */
  | 'ready'
  /** TTL вышел: запись читается, но исполнить её уже нельзя. */
  | 'stale';

export interface RemovalStage {
  kind: RemovalStageKind;
  /** Момент, с которого цепь примет исполнение. Секунды эпохи. */
  readyAt: number;
  /** Момент, после которого запись протухает. Секунды эпохи. */
  expiresAt: number;
  /**
   * Обвинение положила цепь от своего имени (`by == 0`).
   *
   * ⚠️ ЭТО ДРУГАЯ ДВЕРЬ, А НЕ ДРУГОЙ ТЕКСТ. Обвинение цепи исполняется
   * `executeChainRemoval(arbiter)`, а `removeArbiterForCause` на нём ревертит
   * `ChainProposalNeedsTheChainDoor` — и наоборот. Перепутать значит дать
   * кнопку, которая не сработает ни разу.
   */
  byChain: boolean;
  /** Секунд до `readyAt`. Ноль и меньше — ждать больше нечего. */
  secondsLeft: number;
}

export function removalStage(
  record: RemovalProposalRecord | null,
  now: number,
  removalDelay: number,
  proposalTTL: number,
): RemovalStage {
  const empty: RemovalStage = {
    kind: 'none', readyAt: 0, expiresAt: 0, byChain: false, secondsLeft: 0,
  };
  if (!record || record.proposedAt === 0) return empty;

  const readyAt = record.proposedAt + removalDelay;
  const expiresAt = record.proposedAt + proposalTTL;
  const byChain = /^0x0{40}$/i.test(record.by);

  // ⚠️ ГРАНИЦЫ БЕРУТСЯ У ЦЕПИ, А НЕ У ЧАСОВ БРАУЗЕРА, ГДЕ МОЖНО.
  // «Живо ли» решает `live` — это ответ `hasLiveProposal`, единственного
  // хозяина строгости сравнения. Наш пересчёт нужен только чтобы отличить
  // «ещё ждём» от «уже можно» ВНУТРИ живого окна и показать часы.
  if (!record.live) {
    return { kind: 'stale', readyAt, expiresAt, byChain, secondsLeft: 0 };
  }

  const secondsLeft = readyAt - now;
  if (secondsLeft > 0) {
    return { kind: 'waiting', readyAt, expiresAt, byChain, secondsLeft };
  }
  return { kind: 'ready', readyAt, expiresAt, byChain, secondsLeft: 0 };
}

/* ─────────────── третья ошибка не должна быть сюрпризом ─────────────── */

/**
 * Что станет с арбитром, если засчитать ему ещё одну судейскую ошибку.
 *
 * Замысел, раздел 3: сегодня переворот вердикта нигде не отмечен как шаг из
 * трёх, и на третьем человек внезапно оказывается приостановлен и обвинён. Обе
 * стороны обязаны знать это заранее.
 *
 * ⚠️ ПОРОГ И ПОТОЛОК — РАЗНЫЕ ЧИСЛА, И ОБА ЧИТАЮТСЯ У ЦЕПИ.
 * `getMaxArbiterMistakesMirror()` — на какой ошибке цепь снимает
 * (`MAX_ARBITER_MISTAKES`), `getMistakeThreshold()` — с какой ошибки повод
 * `OverturnedVerdicts`/`Timeouts` считается доказанным
 * (`MAX_ARBITER_MISTAKES − 1`). Сложить их в одно число значило бы обещать
 * снос на порог раньше или доказанность на ошибку позже.
 */
export interface MistakeOutlook {
  /** Серия сейчас. */
  streak: number;
  /** Станет после ещё одной ошибки. */
  next: number;
  /** На какой ошибке цепь приостанавливает и обвиняет сама. */
  max: number;
  /** С какой серии повод считается доказанным. */
  threshold: number;
  /** Следующая ошибка будет последней — цепь приостановит и обвинит. */
  nextTips: boolean;
  /** Следующая ошибка сделает повод доказанным для ручного сноса. */
  nextProves: boolean;
}

export function mistakeOutlook(
  streak: number,
  max: number,
  threshold: number,
): MistakeOutlook {
  const next = streak + 1;
  return {
    streak,
    next,
    max,
    threshold,
    nextTips: next >= max,
    nextProves: next >= threshold,
  };
}

/* ─────────────────────────── часы ─────────────────────────── */

/**
 * Сколько ещё ждать, словами.
 *
 * ⚠️ ОКРУГЛЕНИЕ ВНИЗ, И ЭТО НЕ ПРИДИРКА. «Осталось 0» показывать нельзя, пока
 * цепь ещё откажет: человек нажмёт, получит `RemovalTooEarly` и решит, что
 * сломан экран. Поэтому неполная минута — это «меньше минуты», а не «0 мин»,
 * а точный момент открытия всё равно показывается датой рядом.
 */
export function formatSecondsLeft(seconds: number): string {
  if (seconds <= 0) return 'now';
  if (seconds < 60) return 'less than a minute';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/* ───────────────── проверки формы исполнения ───────────────── */

/**
 * ⚠️ ИСПОЛНЕНИЕ ПРОВЕРЯЕТСЯ ОТДЕЛЬНО ОТ ПРЕДЛОЖЕНИЯ, И ЭТО НЕ ДУБЛИРОВАНИЕ.
 * Ворота у второй двери ДРУГИЕ: `removeArbiterForCause` требует слова заново
 * (они не хранятся в цепи — только в журнале), спрашивает договор у повода
 * `Silence` и запрещает его всем остальным, а для двух счётчиковых поводов
 * сверяет серию с порогом. Форма предложения ничего этого не знает.
 *
 * ⚠️ И БЕЗ ЭТОГО КНОПКА ГЕЙТИЛАСЬ ТОЛЬКО ЗАНЯТОСТЬЮ (найдено в круге правок 1):
 * нажатие с пустыми словами или без адреса спора уходило в цепь и ревертило
 * там — за деньги подписавшего и без объяснения.
 */
export type ExecutionProblem =
  /** Повод записи — номер, которого этот фронт не знает. */
  | 'causeUnknown'
  /** `ReasonRequired`: непроверяемый повод, слова обязательны и на исполнении. */
  | 'reasonRequired'
  /** `ReasonTooLong`. */
  | 'reasonTooLong'
  /** Потолок слов ещё не приехал из цепи. */
  | 'capUnknown'
  /** `DisputeRefRequired`: повод `Silence` без договора. */
  | 'disputeRefRequired'
  /** `DisputeRefNotApplicable`: договор указан там, где его быть не должно. */
  | 'disputeRefNotApplicable'
  /** `EvidenceRequired`: в записи нет отпечатка, а повод непроверяемый. */
  | 'evidenceMissing'
  /** `CauseNotProven`: серия судейских ошибок ещё не дотянула до порога. */
  | 'streakBelowThreshold';

export interface ExecutionDraft {
  /** Повод ИЗ ЗАПИСИ — исполнение повторяет его, своего выбора здесь нет. */
  recordedCause: number;
  /** Отпечаток ИЗ ЗАПИСИ. */
  recordedDigest: `0x${string}`;
  reason: string;
  maxReasonBytes: number | null;
  /** Что человек ввёл в поле договора. Пустая строка — не вводил. */
  disputeRef: string;
  /** Серия судейских ошибок арбитра. `null` — ещё не знаем. */
  mistakeStreak: number | null;
  /** Порог доказанности из цепи. `null` — ещё не знаем. */
  mistakeThreshold: number | null;
}

export interface ExecutionCheck {
  ok: boolean;
  problems: ExecutionProblem[];
  /** Нужен ли договор спора — только поводу `Silence`. */
  needsDisputeRef: boolean;
  /** Нужны ли слова — только непроверяемым поводам. */
  needsWords: boolean;
}

const ZERO_DIGEST_HEX = `0x${'00'.repeat(32)}`;

export function checkExecution(draft: ExecutionDraft): ExecutionCheck {
  const option = causeByValue(draft.recordedCause);
  if (!option) {
    return { ok: false, problems: ['causeUnknown'], needsDisputeRef: false, needsWords: false };
  }

  const verified = option.verifiedByChain;
  const needsDisputeRef = option.name === 'Silence';
  const needsWords = !verified;
  const problems: ExecutionProblem[] = [];
  const ref = draft.disputeRef.trim();

  // Порядок тот же, что у контракта: сперва повод и договор, потом слова.
  if (verified) {
    if (needsDisputeRef) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(ref)) problems.push('disputeRefRequired');
    } else {
      if (ref.length > 0) problems.push('disputeRefNotApplicable');
      // Два счётчиковых повода упираются в одну серию, и цепь сверит её заново
      // в момент исполнения — а серия за 48 часов могла ОБНУЛИТЬСЯ чистым
      // вердиктом. Отказ `CauseNotProven` после подписи выглядел бы как поломка.
      if (draft.mistakeStreak !== null && draft.mistakeThreshold !== null
        && draft.mistakeStreak < draft.mistakeThreshold) {
        problems.push('streakBelowThreshold');
      }
    }
  } else {
    if (ref.length > 0) problems.push('disputeRefNotApplicable');
    if (draft.recordedDigest.toLowerCase() === ZERO_DIGEST_HEX) problems.push('evidenceMissing');
  }

  if (draft.maxReasonBytes === null) {
    problems.push('capUnknown');
  } else if (reasonByteLength(draft.reason) > draft.maxReasonBytes) {
    problems.push('reasonTooLong');
  }
  if (needsWords && reasonByteLength(draft.reason) === 0) problems.push('reasonRequired');

  return { ok: problems.length === 0, problems, needsDisputeRef, needsWords };
}
