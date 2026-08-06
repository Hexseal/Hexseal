/**
 * chatRecovery.test.ts — показ кода восстановления и проверка, что его
 * ЗАПИСАЛИ (Задача 8).
 *
 * Замер, с которого задача началась: `useChatSession.ts` отдавал наружу
 * `recoveryCode`, и НИ ОДИН компонент его не читал — `grep -rn recoveryCode
 * src/` давал только сам хук и `chatSession.ts`. То есть владелец кошелька-
 * контракта получал код и никогда его не видел.
 *
 * Здесь заперта вся логика, которую можно ошибиться: разбор кода, выбор
 * номеров слов для проверки, сама сверка и отметка «записал». Отображение
 * (`components/RecoveryCodeModal.tsx`) проверяется разметкой отдельно —
 * `components/recoveryCode.test.tsx`.
 *
 * ⚠️ ЧТО КРАСИТ КАЖДЫЙ ТЕСТ — сказано у теста прямо. В этом проекте уже
 * ловили десять слепых заготовок: тест, который не краснеет ни от одной
 * правки своей же цели, хуже отсутствующего.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { RECOVERY_WORD_COUNT, type ChatSession } from './chatSession';
import {
  RECOVERY_CHECK_WORDS,
  RECOVERY_CONFIRMED_PREFIX,
  inspectRecoveryCode,
  pickCheckPositions,
  checkRecoveryAnswers,
  hasRecoveryCode,
  readRecoveryCode,
  recoveryConfirmedKey,
  isRecoveryConfirmed,
  markRecoveryConfirmed,
  recoveryReminderVisible,
} from './chatRecovery';

/** Золотой вектор BIP-39 (энтропия 0x7f×16) — тот же, что в
 *  `chatSession.test.ts`: детерминированный, не зависит от случайности. */
const GOLD = entropyToMnemonic(new Uint8Array(16).fill(0x7f), wordlist);
const GOLD_WORDS = GOLD.split(' ');

const ADDR = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';

/* ────────────────────────── разбор кода ───────────────────────────────── */

describe('разбор кода: вердикт, а не падение', () => {
  it('годный код разбирается на двенадцать слов', () => {
    const seen = inspectRecoveryCode(GOLD);
    expect(seen.ok).toBe(true);
    expect(seen.ok && seen.words).toEqual(GOLD_WORDS);
    expect(GOLD_WORDS).toHaveLength(RECOVERY_WORD_COUNT);
  });

  it('регистр и лишние пробелы прощаются — человек перепечатывает с бумажки', () => {
    // Красит: разбор, который делит строку по одному пробелу без свёртки
    // (`code.split(' ')`), — «ALPHA  BRAVO» даст пустое слово посередине.
    const messy = `  ${GOLD.toUpperCase().replace(/ /g, '   ')}  `;
    const seen = inspectRecoveryCode(messy);
    expect(seen.ok && seen.words).toEqual(GOLD_WORDS);
  });

  it.each([
    ['пусто', ''],
    ['одни пробелы', '   '],
    ['не строка', 42],
    ['ничего', null],
    ['ничего вовсе', undefined],
  ])('мусор «%s» — вердикт `empty`, а не исключение', (_name, junk) => {
    // Красит: разбор, который зовёт `.split` на чём попало — упадёт
    // TypeError'ом вместо вердикта.
    const seen = inspectRecoveryCode(junk);
    expect(seen).toEqual({ ok: false, reason: 'empty' });
  });

  it.each([
    ['одиннадцать слов', GOLD_WORDS.slice(0, 11).join(' ')],
    ['тринадцать слов', `${GOLD} extra`],
    ['одно слово', 'legal'],
  ])('не двенадцать слов («%s») — вердикт `word_count`', (_name, bad) => {
    // Красит: разбор без счёта слов — вернёт `ok: true` и окно попросит
    // «слово 11» у кода, где его нет.
    const seen = inspectRecoveryCode(bad);
    expect(seen).toEqual({ ok: false, reason: 'word_count' });
  });
});

/* ─────────────────────── выбор номеров слов ───────────────────────────── */

describe('номера слов для проверки', () => {
  it('три разных номера из двенадцати, по возрастанию', () => {
    for (let i = 0; i < 200; i++) {
      const picked = pickCheckPositions();
      expect(picked).toHaveLength(RECOVERY_CHECK_WORDS);
      expect(new Set(picked).size).toBe(RECOVERY_CHECK_WORDS);
      expect([...picked].sort((a, b) => a - b)).toEqual(picked);
      for (const n of picked) {
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(RECOVERY_WORD_COUNT);
      }
    }
  });

  it('номера СЛУЧАЙНЫ — двести показов дают много разных наборов, а не один', () => {
    // Красит: прибитый набор («всегда 1, 6, 12») или набор, выведенный из
    // самого кода, — здесь он даст одно значение вместо десятков.
    // Порог с запасом: сочетаний C(12,3)=220, у двухсот честных розыгрышей
    // ожидание различных наборов ~140. Двадцать — это заведомо ниже любой
    // случайности и заведомо выше единицы.
    const sets = new Set<string>();
    for (let i = 0; i < 200; i++) sets.add(pickCheckPositions().join(','));
    expect(sets.size).toBeGreaterThan(20);
  });

  it('за двести показов спрошено каждое из двенадцати слов', () => {
    // Красит: выбор, который никогда не берёт крайние номера (частая
    // ошибка на `Math.floor(random()*n)+1` с неверными границами).
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) for (const n of pickCheckPositions()) seen.add(n);
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: RECOVERY_WORD_COUNT }, (_, i) => i + 1),
    );
  });

  it('на подставленной случайности набор предсказуем — выбор не «примерно», а определён', () => {
    // Частичное перемешивание Фишера — Йетса по мешку [1..12]. Арифметика
    // выписана здесь целиком, чтобы ожидание было ВЫВЕДЕНО, а не подогнано
    // под то, что вернула реализация:
    //   шаг 0: j = 0 + ⌊0.000 · 12⌋ = 0  → мешок[0] ↔ мешок[0]  → 1
    //   шаг 1: j = 1 + ⌊0.500 · 11⌋ = 6  → мешок[1] ↔ мешок[6]  → 7
    //   шаг 2: j = 2 + ⌊0.999 · 10⌋ = 11 → мешок[2] ↔ мешок[11] → 12
    const draws = [0, 0.5, 0.999];
    let i = 0;
    const picked = pickCheckPositions({ random: () => draws[i++ % draws.length] });
    expect(picked).toEqual([1, 7, 12]);
  });

  it('повтор случайности не даёт повтора номера — набор всегда из трёх разных', () => {
    // Красит: наивное «три раза взять случайный» без отбрасывания повторов —
    // здесь оно вернуло бы [1, 1, 1] и длину 1 после `new Set`.
    const picked = pickCheckPositions({ random: () => 0 });
    expect(new Set(picked).size).toBe(RECOVERY_CHECK_WORDS);
  });
});

/* ──────────────────────── сама сверка слов ────────────────────────────── */

describe('сверка вписанных слов', () => {
  const POS = [2, 5, 9];
  const right = () => ({
    2: GOLD_WORDS[1], 5: GOLD_WORDS[4], 9: GOLD_WORDS[8],
  } as Record<number, string>);

  it('все три слова верны — проверка пройдена', () => {
    expect(checkRecoveryAnswers(GOLD_WORDS, POS, right())).toEqual({ ok: true });
  });

  it('регистр и пробелы вокруг прощаются', () => {
    // Та же нормализация, что у ввода кода целиком (`chatSession.ts`), а не
    // своя: человек перепечатывает с бумажки.
    const answers = right();
    answers[5] = `  ${answers[5].toUpperCase()}  `;
    expect(checkRecoveryAnswers(GOLD_WORDS, POS, answers)).toEqual({ ok: true });
  });

  it('полноширинные буквы прощаются — восточная раскладка', () => {
    // NFKD внутри той же нормализации. Красит: сверка, которая сравнивает
    // строки как есть.
    const answers = right();
    answers[9] = [...answers[9]].map(c => String.fromCodePoint(c.codePointAt(0)! + 0xfee0)).join('');
    expect(checkRecoveryAnswers(GOLD_WORDS, POS, answers)).toEqual({ ok: true });
  });

  it('НЕ ТО слово той же длины — отказ с НОМЕРОМ, а не «неверно»', () => {
    // ⚠️ ГЛАВНЫЙ ЗАМОК ПРОТИВ «сверять только длину». Подставленное слово
    // ровно той же длины, что настоящее: проверка по длине сказала бы «всё
    // сошлось». Владелец потребовал этот замок прямым текстом.
    const answers = right();
    const real = GOLD_WORDS[4];
    const fake = 'z'.repeat(real.length);
    expect(fake).not.toBe(real);
    expect(fake.length).toBe(real.length);
    answers[5] = fake;
    expect(checkRecoveryAnswers(GOLD_WORDS, POS, answers)).toEqual({ ok: false, failed: 5 });
  });

  it('ЧУЖОЕ слово из того же кода не проходит — сверяется позиция, а не «есть ли такое слово»', () => {
    // Красит: сверка вида `words.includes(answer)`.
    const answers = right();
    answers[5] = GOLD_WORDS[0]; // слово 1 вместо слова 5
    expect(checkRecoveryAnswers(GOLD_WORDS, POS, answers)).toEqual({ ok: false, failed: 5 });
  });

  it('пустой ответ не проходит — «принимаем любое» краснеет', () => {
    const answers = right();
    answers[9] = '';
    expect(checkRecoveryAnswers(GOLD_WORDS, POS, answers)).toEqual({ ok: false, failed: 9 });
  });

  it('нет ответа вовсе — отказ по этому номеру, а не молчаливое «прошло»', () => {
    expect(checkRecoveryAnswers(GOLD_WORDS, POS, { 2: GOLD_WORDS[1] }))
      .toEqual({ ok: false, failed: 5 });
  });

  it('называется ПЕРВЫЙ несошедшийся номер — их может быть несколько', () => {
    const answers = { 2: 'нет', 5: 'нет', 9: 'нет' };
    expect(checkRecoveryAnswers(GOLD_WORDS, POS, answers)).toEqual({ ok: false, failed: 2 });
  });

  it('ответ на НЕспрошенный номер не спасает и не мешает', () => {
    const answers = { ...right(), 7: 'что угодно' };
    expect(checkRecoveryAnswers(GOLD_WORDS, POS, answers)).toEqual({ ok: true });
  });

  it('номер за пределами кода — отказ, а не `undefined === undefined`', () => {
    // Красит: сверка `words[n-1] === answer` без проверки границ — на
    // отсутствующем слове обе стороны стали бы `undefined` и «сошлись».
    expect(checkRecoveryAnswers(GOLD_WORDS, [99], { 99: '' })).toEqual({ ok: false, failed: 99 });
  });
});

/* ────────────────── кому вообще положен код ───────────────────────────── */

function session(patch: Partial<ChatSession> = {}): ChatSession {
  return {
    keypair: { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) },
    address: ADDR as `0x${string}`,
    origin: 'recovery',
    walletKind: 'contract',
    restored: false,
    persisted: true,
    ...patch,
  } as ChatSession;
}

describe('кому положен код', () => {
  it('обычному кошельку — нет, ни при каком состоянии', () => {
    // Свойство 1 задачи. Перебираются ВСЕ сочетания флагов: обычный кошелёк
    // не должен увидеть код ни на одном пути.
    for (const restored of [true, false]) {
      for (const persisted of [true, false]) {
        const eoa = session({ origin: 'signature', walletKind: 'eoa', restored, persisted });
        expect(hasRecoveryCode(eoa)).toBe(false);
        expect(readRecoveryCode(eoa)).toBeNull();
        expect(recoveryReminderVisible(eoa, false)).toBe(false);
      }
    }
  });

  it('делегированному (EIP-7702) — тоже нет: он опознан как обычный', () => {
    // Род кошелька считает `chatSession.ts` по подписи; делегированный даёт
    // обычную 65-байтную и приезжает сюда как `eoa`.
    const delegated = session({ origin: 'signature', walletKind: 'eoa' });
    expect(hasRecoveryCode(delegated)).toBe(false);
  });

  it('нет сеанса — нечего показывать и не на чем падать', () => {
    expect(hasRecoveryCode(null)).toBe(false);
    expect(readRecoveryCode(null)).toBeNull();
    expect(recoveryReminderVisible(null, false)).toBe(false);
  });

  it('кошельку-контракту — да', () => {
    expect(hasRecoveryCode(session())).toBe(true);
  });

  it('несогласованная запись (origin recovery, род eoa) кода не даёт', () => {
    // Та же защита в глубину, что в `exportRecoveryCode`.
    expect(hasRecoveryCode(session({ walletKind: 'eoa' }))).toBe(false);
    expect(hasRecoveryCode(session({ origin: 'signature' }))).toBe(false);
  });

  it('код недоступен для этого объекта — `null`, а не исключение наружу', () => {
    // `exportRecoveryCode` бросает `recovery_code_unavailable`, если объект
    // сеанса собран не через `chatSession` (например, приехал из теста или
    // из состояния, пережившего перезагрузку модуля). Показ обязан это
    // пережить: окна не будет, падения тоже.
    expect(readRecoveryCode(session())).toBeNull();
  });
});

/* ─────────────────── отметка «записал» и напоминание ───────────────────── */

describe('отметка «записал» — и код в неё не попадает', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('до отметки — не подтверждено, после — подтверждено', () => {
    expect(isRecoveryConfirmed(ADDR)).toBe(false);
    markRecoveryConfirmed(ADDR);
    expect(isRecoveryConfirmed(ADDR)).toBe(true);
  });

  it('отметка привязана к адресу — сосед по браузеру её не наследует', () => {
    markRecoveryConfirmed(ADDR);
    expect(isRecoveryConfirmed('0x1111111111111111111111111111111111111111')).toBe(false);
  });

  it('регистр адреса не важен — wagmi отдаёт с контрольной суммой, а ключ один', () => {
    markRecoveryConfirmed(ADDR.toLowerCase());
    expect(isRecoveryConfirmed(ADDR)).toBe(true);
  });

  it('⚠️ В localStorage ЛЕЖИТ ЕДИНИЦА, а не код — прямым осмотром всего склада', () => {
    // Свойство 4 задачи. Проверяется не верой в реализацию, а обходом ВСЕГО
    // содержимого: ни ключ, ни значение не содержат ни одного слова кода.
    markRecoveryConfirmed(ADDR);
    const dump = [...store.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
    expect(dump).toContain(RECOVERY_CONFIRMED_PREFIX);
    for (const word of GOLD_WORDS) {
      expect(dump.split(/[^a-z]+/).includes(word)).toBe(false);
    }
    expect([...store.values()]).toEqual(['1']);
  });

  it('хранилище отказало — отметка не роняет приложение', () => {
    // Приватный режим, кончившаяся квота: `setItem` бросает. Человек уже
    // сделал своё дело, ронять его на записи флага нельзя.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('заблокировано'); },
      setItem: () => { throw new Error('квота'); },
      removeItem: () => {},
    });
    expect(() => markRecoveryConfirmed(ADDR)).not.toThrow();
    expect(isRecoveryConfirmed(ADDR)).toBe(false);
  });

  it('нет адреса — нечего отмечать и не на чем падать', () => {
    expect(() => markRecoveryConfirmed(undefined)).not.toThrow();
    expect(isRecoveryConfirmed(undefined)).toBe(false);
  });

  it('ключ отметки построен из адреса и общей приставки', () => {
    expect(recoveryConfirmedKey(ADDR)).toBe(`${RECOVERY_CONFIRMED_PREFIX}-${ADDR.toLowerCase()}`);
  });
});

describe('плашка-напоминание', () => {
  it('видна кошельку-контракту, пока не подтвердил', () => {
    expect(recoveryReminderVisible(session({ restored: true }), false)).toBe(true);
  });

  it('уходит ровно после подтверждения и не возвращается на повторном заходе', () => {
    // Свойство «напоминание уходит ровно после успешной проверки». Второй
    // заход — тот же сеанс с `restored: true`: плашки нет.
    expect(recoveryReminderVisible(session(), true)).toBe(false);
    expect(recoveryReminderVisible(session({ restored: true }), true)).toBe(false);
  });

  it('обычному кошельку не видна никогда', () => {
    expect(recoveryReminderVisible(session({ origin: 'signature', walletKind: 'eoa' }), false)).toBe(false);
  });
});
