import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  REMOVAL_CAUSE_OPTIONS, causeByValue, causeOption,
  checkExecution, checkProposal, formatSecondsLeft, mistakeOutlook,
  reasonByteLength, reasonBytesLeft, removalStage,
  type RemovalProposalRecord,
} from './arbiterRemovalFlow';
import { decodeRemovalCause } from './arbiterRemovalCause';

/**
 * Замок на решения потока сноса.
 *
 * Сторожатся четыре свойства, и каждое ломается молча:
 *
 *  1. СЧЁТ СЛОВ В БАЙТАХ. Контракт меряет `bytes(reason).length`, форма обязана
 *     мерить то же. Считай она символы — на кириллице соврала бы ВДВОЕ, и
 *     ошибку увидел бы только человек, написавший обвинение по-русски и
 *     получивший `ReasonTooLong` после подписи. Английская сцена этого не ловит
 *     вовсе: там байт и символ — одно и то же, и обе реализации зелёные.
 *  2. НОМЕР ПОВОДА. `proposeRemoval` принимает перечисление С НУЛЯ, а поле
 *     `lastRemovalCause` хранит его СО СДВИГОМ. Перепутать — предложить снос по
 *     соседнему поводу, и цепь примет.
 *  3. ДВЕРЬ ИСПОЛНЕНИЯ. Обвинение цепи (`by == 0`) исполняется другой функцией;
 *     перепутать значит дать кнопку, которая не сработает ни разу.
 *  4. ПОРОГ И ПОТОЛОК СУДЕЙСКИХ ОШИБОК — разные числа.
 *
 * ⚠️ ЧИСЛА ЦЕПИ ЗДЕСЬ НАРОЧНО НЕ БОЕВЫЕ (не 512, не 48 часов, не 14 дней).
 * Подставь настоящие — и проверка прошла бы одинаково на честном чтении цепи и
 * на зашитом во фронт литерале: ровно та «пустая мутация», где красное ничего
 * не значит. Совпасть с 700 и 999 можно только одним способом — действительно
 * взяв переданное значение.
 */

/* ── 1. слова считаются в БАЙТАХ ── */

/** 256 кириллических букв. В UTF-8 это ровно 512 байт — и 256 символов. */
const CYRILLIC_256 = 'я'.repeat(256);

describe('слова меряются байтами, а не символами', () => {
  it('кириллическая буква стоит два байта', () => {
    expect(reasonByteLength('я')).toBe(2);
    expect(reasonByteLength(CYRILLIC_256)).toBe(512);
    // Символов при этом вдвое меньше — именно на этой разнице врал бы счётчик.
    expect(CYRILLIC_256.length).toBe(256);
  });

  it('эмодзи стоит четыре байта', () => {
    expect(reasonByteLength('🙂')).toBe(4);
  });

  it('на латинице байт и символ совпадают — и потому эта сцена ничего не ловит', () => {
    expect(reasonByteLength('abc')).toBe(3);
  });

  it('остаток считается в байтах: 256 кириллических букв выбирают потолок 512 ПОЛНОСТЬЮ', () => {
    expect(reasonBytesLeft(CYRILLIC_256, 512)).toBe(0);
    // Счётчик по символам показал бы здесь «осталось 256».
  });

  it('перебор виден отрицательным остатком, а не нулём', () => {
    expect(reasonBytesLeft('я'.repeat(300), 512)).toBe(-88);
  });

  it('форма отвергает 257 кириллических букв при потолке 512', () => {
    const check = checkProposal({
      arbiter: '0x00000000000000000000000000000000000000a1',
      cause: 'Collusion',
      evidenceDigest: `0x${'11'.repeat(32)}`,
      reason: 'я'.repeat(257),          // 514 байт, но всего 257 символов
      maxReasonBytes: 512,
      hasLiveProposal: false,
    });
    expect(check.problems).toContain('reasonTooLong');
    // ⚠️ Считай форма символы — 257 ≤ 512, и здесь было бы пусто.
  });
});

/* ── 2. номер повода ── */

const ARBITER = '0x00000000000000000000000000000000000000a1';

describe('повод едет в цепь тем номером, который цепь ждёт', () => {
  it('перечисление начинается с нуля', () => {
    expect(causeOption('OverturnedVerdicts').value).toBe(0);
    expect(causeOption('Other').value).toBe(5);
  });

  it('признак «проверяет ли цепь» тот же, что у расшифровки', () => {
    expect(causeOption('Silence').verifiedByChain).toBe(true);
    expect(causeOption('Leak').verifiedByChain).toBe(false);
  });

  /**
   * ⚠️ САМАЯ ДОРОГАЯ ПУТАНИЦА ЭТОГО ФАЙЛА. `decodeRemovalCause` расшифровывает
   * поле `lastRemovalCause`, где к номеру ПРИБАВЛЕН сдвиг; запись обвинения
   * хранит перечисление как есть. Пропусти запись через тот декодер — каждое
   * обвинение читалось бы поводом на единицу младше.
   */
  it('номер из записи обвинения и номер из поля «последний снос» — РАЗНЫЕ вещи', () => {
    expect(causeByValue(0)!.name).toBe('OverturnedVerdicts');
    expect(decodeRemovalCause(0)).toMatchObject({ kind: 'never' });
    expect(decodeRemovalCause(1)).toMatchObject({ kind: 'declared', cause: 'OverturnedVerdicts' });
  });

  it('незнакомый номер не домысливается', () => {
    expect(causeByValue(99)).toBeNull();
  });

  it('поводов ровно шесть', () => {
    expect(REMOVAL_CAUSE_OPTIONS.length).toBe(6);
  });
});

/* ── 3. проверки формы повторяют ворота контракта ── */

describe('форма отказывает там же, где откажет цепь', () => {
  const base = {
    arbiter: ARBITER,
    evidenceDigest: null,
    reason: '',
    maxReasonBytes: 700,
    hasLiveProposal: false,
  } as const;

  it('непроверяемый повод без доказательства и слов — два отказа', () => {
    const c = checkProposal({ ...base, cause: 'Collusion' });
    expect(c.ok).toBe(false);
    expect(c.problems).toContain('evidenceRequired');
    expect(c.problems).toContain('reasonRequired');
    expect(c.verifiedByChain).toBe(false);
  });

  it('проверяемый повод проходит и без доказательства, и без слов', () => {
    const c = checkProposal({ ...base, cause: 'Timeouts' });
    expect(c.ok).toBe(true);
    expect(c.verifiedByChain).toBe(true);
  });

  it('живое обвинение закрывает форму — цепь ответит ProposalAlreadyLive', () => {
    const c = checkProposal({ ...base, cause: 'Timeouts', hasLiveProposal: true });
    expect(c.problems).toContain('proposalAlreadyLive');
  });

  it('пока потолок не приехал из цепи, ничего не отправляется', () => {
    const c = checkProposal({ ...base, cause: 'Timeouts', maxReasonBytes: null });
    expect(c.problems).toContain('capUnknown');
    // ⚠️ Не ноль: ноль запретил бы любые слова и выглядел бы как «потолок 0».
  });

  it('пустой адрес арбитра ловится до подписи', () => {
    const c = checkProposal({ ...base, arbiter: '', cause: 'Timeouts' });
    expect(c.problems).toContain('arbiterMissing');
  });
});

/* ── 4. состояние обвинения во времени ── */

const HUMAN = '0x00000000000000000000000000000000000000b2' as `0x${string}`;
const CHAIN = '0x0000000000000000000000000000000000000000' as `0x${string}`;

function record(over: Partial<RemovalProposalRecord> = {}): RemovalProposalRecord {
  return {
    cause: 3,
    evidenceDigest: `0x${'11'.repeat(32)}`,
    proposedAt: 1_000_000,
    by: HUMAN,
    live: true,
    ...over,
  };
}

/** Пауза и срок годности — НЕ боевые числа, см. шапку. */
const DELAY = 700;
const TTL = 9_000;

describe('часы обвинения', () => {
  it('записи нет — можно предлагать', () => {
    expect(removalStage(null, 1_000_000, DELAY, TTL).kind).toBe('none');
    expect(removalStage(record({ proposedAt: 0 }), 1_000_000, DELAY, TTL).kind).toBe('none');
  });

  it('пауза идёт — исполнить нельзя, и видно сколько ждать', () => {
    const s = removalStage(record(), 1_000_100, DELAY, TTL);
    expect(s.kind).toBe('waiting');
    expect(s.secondsLeft).toBe(600);
    expect(s.readyAt).toBe(1_000_700);
    expect(s.expiresAt).toBe(1_009_000);
  });

  it('ровно в момент открытия окно уже открыто — граница включающая, как в контракте', () => {
    expect(removalStage(record(), 1_000_700, DELAY, TTL).kind).toBe('ready');
  });

  it('«живо ли» решает ответ цепи, а не наш пересчёт', () => {
    // Часы показывают «давно пора», но цепь сказала `live: false` — значит TTL
    // вышел, и исполнять нечего. Свой пересчёт здесь разошёлся бы со строгостью
    // сравнения в `hasLiveProposal`.
    const s = removalStage(record({ live: false }), 1_005_000, DELAY, TTL);
    expect(s.kind).toBe('stale');
  });

  it('нулевой автор означает обвинение самой цепи — а это ДРУГАЯ дверь', () => {
    expect(removalStage(record({ by: CHAIN }), 1_000_800, DELAY, TTL).byChain).toBe(true);
    expect(removalStage(record({ by: HUMAN }), 1_000_800, DELAY, TTL).byChain).toBe(false);
  });
});

describe('часы словами', () => {
  it('неполная минута — «меньше минуты», а не «0 мин»', () => {
    expect(formatSecondsLeft(59)).toBe('less than a minute');
  });
  it('сутки с часами', () => {
    expect(formatSecondsLeft(2 * 86400 + 3 * 3600)).toBe('2d 3h');
  });
  it('часы с минутами', () => {
    expect(formatSecondsLeft(3 * 3600 + 4 * 60)).toBe('3h 4m');
  });
  it('нечего ждать', () => {
    expect(formatSecondsLeft(0)).toBe('now');
  });
});

/* ── 5. третья ошибка не должна быть сюрпризом ── */

describe('«станет N из M» считается от чисел цепи', () => {
  it('порог и потолок — разные числа, и оба видны', () => {
    const o = mistakeOutlook(1, 3, 2);
    expect(o.next).toBe(2);
    expect(o.max).toBe(3);
    expect(o.threshold).toBe(2);
    expect(o.nextTips).toBe(false);   // 2 из 3 ещё не снимает
    expect(o.nextProves).toBe(true);  // но повод уже станет доказанным
  });

  it('следующая ошибка — последняя: цепь приостановит и обвинит сама', () => {
    const o = mistakeOutlook(2, 3, 2);
    expect(o.nextTips).toBe(true);
  });

  it('числа берутся ПЕРЕДАННЫЕ, а не боевые 3 и 2', () => {
    const o = mistakeOutlook(6, 8, 7);
    expect(o.next).toBe(7);
    expect(o.nextTips).toBe(false);
    expect(o.nextProves).toBe(true);
  });
});

/* ── 6. своих чисел в файле нет ── */

/**
 * ⚠️ ЗАМОК НА КЛАСС, А НЕ НА ТЕКСТ. Проверяется, что в исходнике нет ни 512, ни
 * 48, ни 14 как ЗНАЧЕНИЙ: любое из них, зашитое здесь, разойдётся с цепью в
 * тишине и покажет кнопку рабочей раньше времени. Комментарии сняты — они этот
 * разбор как раз и объясняют, и без снятия замок краснел бы на исправленном
 * коде.
 */
describe('в решениях потока нет своих копий чисел цепи', () => {
  it('ни 512, ни 48 hours, ни 14 days в коде', () => {
    const source = readFileSync(fileURLToPath(new URL('./arbiterRemovalFlow.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    expect(source).not.toMatch(/\b512\b/);
    expect(source).not.toMatch(/\b172800\b/);   // 48 часов секундами
    expect(source).not.toMatch(/\b1209600\b/);  // 14 суток секундами
  });
});

/* ── 7. ворота ВТОРОЙ двери ── */

/**
 * ⚠️ ИСПОЛНЕНИЕ ПРОВЕРЯЕТСЯ НЕ ТЕМ ЖЕ, ЧЕМ ПРЕДЛОЖЕНИЕ, И ЭТО НАЙДЕНО ЗАМЕРОМ
 * (круг правок 1): кнопка исполнения гейтилась только занятостью, и нажатие с
 * пустыми словами или без адреса спора уходило в цепь и ревертило там.
 *
 * Имена причин — имена ревёртов `removeArbiterForCause`.
 */
const EXEC_BASE = {
  recordedDigest: `0x${'11'.repeat(32)}` as `0x${string}`,
  reason: '',
  maxReasonBytes: 700,
  disputeRef: '',
  mistakeStreak: 5,
  mistakeThreshold: 2,
};

const CAUSE = {
  overturned: 0, timeouts: 1, silence: 2, collusion: 3, leak: 4, other: 5,
} as const;

describe('исполнение отказывает там же, где откажет цепь', () => {
  it('непроверяемый повод без слов — ReasonRequired, и до подписи', () => {
    const c = checkExecution({ ...EXEC_BASE, recordedCause: CAUSE.collusion });
    expect(c.ok).toBe(false);
    expect(c.problems).toContain('reasonRequired');
    expect(c.needsWords).toBe(true);
  });

  it('со словами тот же повод проходит', () => {
    const c = checkExecution({ ...EXEC_BASE, recordedCause: CAUSE.leak, reason: 'он слил переписку' });
    expect(c.ok).toBe(true);
  });

  it('Silence без договора — DisputeRefRequired', () => {
    const c = checkExecution({ ...EXEC_BASE, recordedCause: CAUSE.silence });
    expect(c.problems).toContain('disputeRefRequired');
    expect(c.needsDisputeRef).toBe(true);
    expect(c.needsWords).toBe(false);
  });

  it('Silence с договором проходит без слов', () => {
    const c = checkExecution({
      ...EXEC_BASE, recordedCause: CAUSE.silence,
      disputeRef: '0xdead000000000000000000000000000000000001',
    });
    expect(c.ok).toBe(true);
  });

  it('договор у чужого повода — DisputeRefNotApplicable', () => {
    const c = checkExecution({
      ...EXEC_BASE, recordedCause: CAUSE.timeouts,
      disputeRef: '0xdead000000000000000000000000000000000001',
    });
    expect(c.problems).toContain('disputeRefNotApplicable');
  });

  /**
   * ⚠️ СЕРИЯ МОГЛА ОБНУЛИТЬСЯ ЗА 48 ЧАСОВ. `finalizeVerdict` на чистом вердикте
   * гасит счётчик, и цепь в момент исполнения спросит его ЗАНОВО. Без этой
   * проверки человек получил бы `CauseNotProven` после подписи и прочитал бы
   * его как поломку интерфейса.
   */
  it('серия ниже порога — CauseNotProven названа заранее', () => {
    const c = checkExecution({ ...EXEC_BASE, recordedCause: CAUSE.overturned, mistakeStreak: 1 });
    expect(c.problems).toContain('streakBelowThreshold');
  });

  it('серии ещё не знаем — молчим, а не запрещаем', () => {
    const c = checkExecution({ ...EXEC_BASE, recordedCause: CAUSE.overturned, mistakeStreak: null });
    expect(c.ok).toBe(true);
  });

  it('слова длиннее потолка — ReasonTooLong, и на кириллице тоже', () => {
    const c = checkExecution({
      ...EXEC_BASE, recordedCause: CAUSE.other, reason: 'я'.repeat(400), maxReasonBytes: 700,
    });
    expect(c.problems).toContain('reasonTooLong');  // 800 байт при 400 символах
  });

  it('запись без отпечатка на непроверяемом поводе — EvidenceRequired', () => {
    const c = checkExecution({
      ...EXEC_BASE, recordedCause: CAUSE.collusion, reason: 'слова есть',
      recordedDigest: `0x${'00'.repeat(32)}`,
    });
    expect(c.problems).toContain('evidenceMissing');
  });

  it('незнакомый повод не исполняется вслепую', () => {
    const c = checkExecution({ ...EXEC_BASE, recordedCause: 99 });
    expect(c.problems).toEqual(['causeUnknown']);
  });
});
