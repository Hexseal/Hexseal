/**
 * arbiterRemovalCause.ts — расшифровка `lastRemovalCause` из карточки положения
 * арбитра (`getArbiterStanding`, поле 13).
 *
 * ⚠️ ГЛАВНОЕ, РАДИ ЧЕГО ЭТОТ ФАЙЛ СУЩЕСТВУЕТ — НЕ ИМЯ ПОВОДА, А ПРИЗНАК
 * `verifiedByChain`. Половина поводов проверяема самой цепью
 * (`OverturnedVerdicts`/`Timeouts`/`Silence` — счётчик судейских ошибок и запись
 * «просил переписку, ответа нет»), половина — заявление обвинителя, заверенное
 * только отпечатком доказательства, которого цепь не читала вовсе
 * (`Collusion`/`Leak`/`Other`). Контракт различает их сам
 * (`ArbiterAccountabilityFacet._isChainVerifiable`) и кладёт ответ в поле
 * `verifiedByChain` события `ArbiterRemovedForCause` — «без метки читало бы
 * одинаково для обеих половин, а для второй половины это было бы враньём»
 * (докстринг события). Карточка обязана нести то же различие: показать
 * недоказанное как доказанное — это ровно тот обман, который метка и отменяет.
 *
 * ⚠️ ПОЧЕМУ ЗДЕСЬ КОПИЯ КОДИРОВКИ, ХОТЯ ПРАВИЛО ПРОЕКТА ЭТОГО НЕ ЛЮБИТ.
 * Хозяин кодировки один — библиотека `ArbiterRegistryStorage`
 * (`REMOVAL_CAUSE_SHIFT`, `AUTO_REMOVAL_BASE`), и спросить её значения у цепи
 * НЕЧЕМ: обе константы `internal`, геттера нет ни у одного фасета. Значит копия
 * во фронте неизбежна, и единственное, что держит её от расхождения, — замок
 * `arbiterRemovalCause.test.ts`, который читает ИСХОДНИК обоих фасетов и
 * краснеет на любой правке там: сдвиг, база, состав перечисления `Cause`, состав
 * перечисления `DemotionPath`, набор проверяемых цепью поводов. Появится
 * геттер — копию отсюда убрать, а замок переписать на чтение цепи (как это
 * сделано в `useNoResponseFloor`, где геттер есть).
 *
 * ⚠️ НЕЗНАКОМЫЙ КОД НЕ СЧИТАЕТСЯ НИ ПРОВЕРЕННЫМ, НИ НЕПРОВЕРЕННЫМ. Появись в
 * контракте седьмой повод, а здесь о нём ещё не знают — `decodeRemovalCause`
 * отвечает `kind: 'unknown'` и `verifiedByChain: null`, а не «нет, не
 * проверялось» и уж тем более не «да». Умолчание в любую из двух сторон было бы
 * утверждением о том, чего мы не знаем; `null` заставляет экран сказать
 * «непонятный код», а не соврать.
 */

/** Перечисление `ArbiterAccountabilityFacet.Cause`, В ТОМ ЖЕ ПОРЯДКЕ. */
export const CAUSE_NAMES = [
  'OverturnedVerdicts',
  'Timeouts',
  'Silence',
  'Collusion',
  'Leak',
  'Other',
] as const;

export type RemovalCauseName = (typeof CAUSE_NAMES)[number];

/**
 * Поводы, которые цепь проверяет СВОИМ состоянием — зеркало
 * `ArbiterAccountabilityFacet._isChainVerifiable`.
 *
 * ⚠️ Честная оговорка контракта, которую нельзя потерять по дороге на экран:
 * `OverturnedVerdicts` и `Timeouts` упираются в ОДИН счётчик
 * `arbiterMistakeStreak`, и цепь различить их постфактум не может. Проверен
 * факт СЕРИИ, а выбор между двумя именами — заявление обвинителя. То есть
 * `verifiedByChain: true` здесь означает «признак, на который ссылается повод, в
 * цепи есть», а не «цепь подтвердила формулировку дословно».
 */
export const CHAIN_VERIFIABLE_CAUSES: ReadonlySet<RemovalCauseName> = new Set<RemovalCauseName>([
  'OverturnedVerdicts',
  'Timeouts',
  'Silence',
]);

/** Перечисление `ArbiterRegistryFacet.DemotionPath`, В ТОМ ЖЕ ПОРЯДКЕ. */
export const DEMOTION_PATHS = [
  'Unspecified',
  'OwnerOverturn',
  'AgreementTimeout',
  'AppealVote',
] as const;

export type DemotionPathName = (typeof DEMOTION_PATHS)[number];

/** `ArbiterRegistryStorage.REMOVAL_CAUSE_SHIFT` — ноль обязан означать «не снимали». */
export const REMOVAL_CAUSE_SHIFT = 1;

/** `ArbiterRegistryStorage.AUTO_REMOVAL_BASE` — начало диапазона автодемоушена. */
export const AUTO_REMOVAL_BASE = 252;

/**
 * Расшифрованный повод последнего снятия.
 *
 * `raw` есть у каждой ветки намеренно: это значение цепи как есть, и без него
 * читающему коду пришлось бы держать вторую копию сырого числа рядом с
 * расшифровкой (а две копии одного числа расходятся — весь этот файл про то же).
 */
export type RemovalCause =
  /** Не снимали ни разу. Не путать с «сняли по неизвестному поводу». */
  | { kind: 'never';     raw: number; verifiedByChain: null }
  /** Снос по поводу: обвинитель назвал код, цепь проверила его или не проверила. */
  | { kind: 'declared';  raw: number; cause: RemovalCauseName; verifiedByChain: boolean }
  /** Автодемоушен: повода нет вовсе, сняла сама цепь по серии ошибок. */
  | { kind: 'automatic'; raw: number; path: DemotionPathName; verifiedByChain: true }
  /** Код из будущего контракта, которого этот фронт ещё не знает. */
  | { kind: 'unknown';   raw: number; verifiedByChain: null };

/**
 * ⚠️ ПОЧЕМУ АВТОДЕМОУШЕН — ЭТО `verifiedByChain: true`, И ЭТО НЕ НАТЯЖКА.
 * Обвинителя у него нет вообще: статус снял сам контракт, досчитав свой
 * собственный счётчик судейских ошибок до порога
 * (`_recordArbiterMistake` → `MAX_ARBITER_MISTAKES`). Это строго сильнее, чем
 * заверяемый повод `OverturnedVerdicts`, где цепь смотрит тот же счётчик по
 * чужому указанию. Путь (`OwnerOverturn`/`AgreementTimeout`/`AppealVote`)
 * говорит, ЧЕМ засчитана последняя ошибка серии, и на проверяемость не влияет:
 * решение о снятии в каждом из трёх случаев приняла цепь, а не человек.
 */
export function decodeRemovalCause(raw: number): RemovalCause {
  if (raw === 0) return { kind: 'never', raw, verifiedByChain: null };

  if (raw >= AUTO_REMOVAL_BASE) {
    const path = DEMOTION_PATHS[raw - AUTO_REMOVAL_BASE];
    // Диапазон 252..255 шире перечисления ровно настолько, насколько uint8
    // позволяет: пятый путь в контракте придётся сажать НИЖЕ базы, и до тех пор
    // «в диапазоне, но не в перечислении» — невозможное значение, а не автомат.
    if (path === undefined) return { kind: 'unknown', raw, verifiedByChain: null };
    return { kind: 'automatic', raw, path, verifiedByChain: true };
  }

  const cause = CAUSE_NAMES[raw - REMOVAL_CAUSE_SHIFT];
  if (cause === undefined) return { kind: 'unknown', raw, verifiedByChain: null };

  return { kind: 'declared', raw, cause, verifiedByChain: CHAIN_VERIFIABLE_CAUSES.has(cause) };
}
