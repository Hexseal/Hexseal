import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Задача 5 (chat-transport-storage) — усыновление переписки сделкой + гейт
// на окно апелляции (гейт сам — script/check-appeal-window.sh, прогоняется
// напрямую, не отсюда). Тот же приём файла, что и test/bagStore.test.js:
// свой временный STORAGE_DIR, выставленный ДО первого импорта bagStore.js
// (живая ES-привязка на export let, а не снимок — см. заголовок
// bagStore.test.js И-2/И-3 про ту же ловушку).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bag-adoption-'));
process.env.STORAGE_DIR = TMP;

const bagStore = await import('../bagStore.js');
const {
  bagKeyFor, recordBag, bagMetaOf, bagExpiryAt, cleanupBags,
  adoptPairBags, dealDeadlineFromDispute, dealDeadlineFromCreation,
  _loadBagMeta, _pairIdFromAddresses, assertBagStoreReady,
} = bagStore;

// app.js — тем же приёмом, что test/bagStore.test.js:46 (координатор уже
// разрешил этот импорт прямо в тест склада): нужен для интеграционного
// теста runFileCleanup()/adoptDisputedPairBags(), а окружение (мокнутый
// ethers, обязательные env) уже поднято общим setupFile test/setup.js.
const { app, runFileCleanup, relayerInfo } = await import('../app.js');
const { mockContract } = await import('./mocks/ethersRegistry.js');

const ALICE = '0xa1ce00000000000000000000000000000000cafe';
const BOB   = '0xb0b1000000000000000000000000000000005eed';
const CAROL = '0xca401000000000000000000000000000000005ee';
const DAY   = 24 * 60 * 60 * 1000;
const HOUR  = 60 * 60 * 1000;

// Детерминированный, но РАЗЛИЧНЫЙ на каждый (seed, tag) валидный адрес —
// нужен для it.each по нескольким сделкам подряд: одноимённые адреса на
// каждой итерации рисковали бы делить мок/кэш между итерациями (особенно
// важно для кэша DISPUTE_WINDOW/deadlineDays_ по адресу агримента — см.
// "мелочи" отчёта Задачи 5).
function ethAddr(seed, tag) {
  const seedHex = seed.toString(16).padStart(4, '0');
  return '0x' + tag.repeat(36) + seedHex;
}

function put(recipient, sender, uploadedAt, extra = {}) {
  const key = bagKeyFor(recipient);
  fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key)), { recursive: true });
  fs.writeFileSync(path.join(bagStore.DIR_BAGS, key), Buffer.from('sealed'));
  const mtime = new Date(uploadedAt);
  fs.utimesSync(path.join(bagStore.DIR_BAGS, key), mtime, mtime);
  recordBag({ key, sender, recipient, size: 6, uploadedAt, ...extra });
  return key;
}

beforeEach(() => {
  fs.rmSync(bagStore.DIR_BAGS, { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'bag-meta.json'), { force: true });
  _loadBagMeta();
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── Шаг 3 брифа — шесть тестов буквально по именам ───────────────────────

describe('adoptPairBags — усыновление переписки сделкой', () => {
  it('усыновление продлевает мешки пары за последние 30 дней', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 20 * DAY); // внутри лукбэка (умолчание 30д)
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const deadline = now + 100 * DAY;

    const adopted = adoptPairBags(pairId, deadline, now);

    expect(adopted).toBe(1);
    expect(bagMetaOf(key).dealDeadline).toBe(deadline);
  });

  it('мешок старше 30 дней не усыновляется', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 31 * DAY); // за пределами лукбэка
    const pairId = _pairIdFromAddresses(ALICE, BOB);

    const adopted = adoptPairBags(pairId, now + 100 * DAY, now);

    expect(adopted).toBe(0);
    expect(bagMetaOf(key).dealDeadline).toBeNull();
  });

  // Не из шести буквальных, но запирает ОПЕРАТОР ("> cutoff", не ">="),
  // а не просто "где-то около 30 дней" — брифовый тест выше (31 день)
  // покраснел бы одинаково что от ">", что от ">=" на его расстоянии от
  // границы; мутация ">" → ">=" эту границу не задевает вовсе.
  it('граница лукбэка строгая: ровно на cutoff не усыновляется, на миллисекунду позже — усыновляется', () => {
    const now = Date.now();
    const cutoff = now - bagStore.BAG_ADOPTION_LOOKBACK_MS;
    const exactlyAtCutoff = put(ALICE, BOB, cutoff);
    const justAfterCutoff = put(ALICE, BOB, cutoff + 1);
    const pairId = _pairIdFromAddresses(ALICE, BOB);

    adoptPairBags(pairId, now + 100 * DAY, now);

    expect(bagMetaOf(exactlyAtCutoff).dealDeadline).toBeNull();
    expect(bagMetaOf(justAfterCutoff).dealDeadline).toBe(now + 100 * DAY);
  });

  it('мешки другой пары не трогаются', () => {
    const now = Date.now();
    const keyAB = put(ALICE, BOB, now - 10 * DAY);
    const keyBC = put(CAROL, BOB, now - 10 * DAY); // другая пара (BOB-CAROL)
    const pairAB = _pairIdFromAddresses(ALICE, BOB);

    adoptPairBags(pairAB, now + 100 * DAY, now);

    expect(bagMetaOf(keyAB).dealDeadline).toBe(now + 100 * DAY);
    expect(bagMetaOf(keyBC).dealDeadline).toBeNull();
  });

  it('усыновление НЕ сокращает срок, если сделка закрывается раньше обычного', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now); // свежий непрочитанный — обычный срок now+BAG_UNREAD_TTL_MS (30д)
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const shortDeadline = now + 1 * DAY; // короче обычного срока

    adoptPairBags(pairId, shortDeadline, now);

    // Поле выставлено ровно тем, что передали — adoptPairBags не решает,
    // "разумно" ли значение, только применяет его (Math.max с прежним).
    expect(bagMetaOf(key).dealDeadline).toBe(shortDeadline);
    // Но ЭФФЕКТИВНЫЙ срок (bagExpiryAt) не короче обычного правила —
    // Math.max(base, ...) внутри bagExpiryAt побеждает.
    const expiry = bagExpiryAt(bagMetaOf(key));
    expect(expiry).toBe(now + bagStore.BAG_UNREAD_TTL_MS);
    expect(expiry).toBeGreaterThan(shortDeadline);
  });

  it('срок считается до конца апелляции, а не до вердикта', () => {
    const disputedAtMs = 1_700_000_000_000; // произвольная фиксированная дата
    const disputeWindowMs = 4 * DAY;
    const verdictOnlyDeadline = disputedAtMs + disputeWindowMs; // если бы считали только до вердикта

    const dd = dealDeadlineFromDispute(disputedAtMs, disputeWindowMs);

    // Точная формула — заперта равенством, а не только "больше": мутация,
    // убирающая слагаемое APPEAL_REVIEW_WINDOW_DAYS*DAY_MS целиком, красит
    // это же равенство (совпало бы с verdictOnlyDeadline + GRACE, не с dd).
    expect(dd).toBe(verdictOnlyDeadline + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS);
    expect(dd).toBeGreaterThan(verdictOnlyDeadline);

    // End-to-end: мешок, прочитанный сразу (короткий базовый срок — 7д от
    // прочтения), уже истёк бы к моменту вердикта БЕЗ усыновления; с
    // усыновлением дожидается конца окна апелляции.
    const uploadedAt = disputedAtMs - 10 * DAY;
    const key = put(ALICE, BOB, uploadedAt, { firstFetchedAt: uploadedAt });
    const pairId = _pairIdFromAddresses(ALICE, BOB);

    // Без усыновления (base-правило) мешок уже мёртв на момент вердикта.
    const baseExpiry = bagExpiryAt(bagMetaOf(key));
    expect(baseExpiry).toBeLessThan(verdictOnlyDeadline);

    adoptPairBags(pairId, dd, disputedAtMs);

    const expiryAfterAdoption = bagExpiryAt(bagMetaOf(key));
    expect(expiryAfterAdoption).toBe(dd); // потолок (90д от uploadedAt) тут не ограничитель
    expect(expiryAfterAdoption).toBeGreaterThan(verdictOnlyDeadline); // пережил вердикт
  });

  it('второе усыновление той же пары не откатывает более дальний срок', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 10 * DAY);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const farDeadline = now + 100 * DAY;
    const nearDeadline = now + 5 * DAY;

    adoptPairBags(pairId, farDeadline, now);
    const adoptedSecond = adoptPairBags(pairId, nearDeadline, now);

    expect(adoptedSecond).toBe(0); // ни одна запись фактически не изменилась
    expect(bagMetaOf(key).dealDeadline).toBe(farDeadline);
  });
});

// ─── Этап 1 (находка координатора): срок сделки ПРЕДВАРИТЕЛЬНО, в момент
// создания — формула этапа 2 (dealDeadlineFromDispute) физически не
// применима до того, как случился спор (disputedAt == 0). У соглашения
// собственный срок известен сразу (deadlineDays_, читается с getDetails()
// при регистрации), так что предварительная оценка — от МОМЕНТА СОЗДАНИЯ,
// а не от момента спора, которого ещё нет.

// Хелпер: то же умолчание "деньги/грейс" на каждый вызов, чтобы не повторять
// эти два поля в каждом тесте буквально — они не в фокусе этого блока
// (у них свой блок ниже, "мелочи — DEADLINE_GRACE/AUTO_APPROVE_WINDOW").
function ddFromCreation(overrides) {
  return dealDeadlineFromCreation({
    deadlineGraceMs: 0, autoApproveWindowMs: 0,
    ...overrides,
  });
}

describe('dealDeadlineFromCreation — этап 1: предварительный срок при создании сделки', () => {
  it('не активирована, самая первая ночь (nowMs === createdAtMs) — якорь = createdAtMs', () => {
    const createdAtMs = 1_700_000_000_000;
    const ownDeadlineMs = 40 * DAY;
    const disputeWindowMs = 4 * DAY;

    const dd = ddFromCreation({ createdAtMs, activatedAtMs: 0, ownDeadlineMs, disputeWindowMs, nowMs: createdAtMs });

    // Точная формула — то же самое равенство, что и у dealDeadlineFromDispute,
    // только якорь другой (createdAtMs вместо disputedAtMs). Мутация,
    // убирающая любое слагаемое, красит это равенство.
    expect(dd).toBe(createdAtMs + ownDeadlineMs + disputeWindowMs
      + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS);
  });

  // I-B (третий закрывающий раунд ревью, находка координатора): пока сделка
  // НЕ активирована, якорь — nowMs (момент ЭТОГО прогона), не застывший
  // createdAtMs. Без этого предварительный срок навсегда остаётся тем же
  // числом, посчитанным в день регистрации, а лукбэк рано или поздно
  // перестаёт пускать его переякорение — короткая сделка с задержкой оплаты
  // умирает раньше активации. Мутация "взять просто createdAtMs" красит
  // это равенство: на 20-й неактивированной ночи dd обязан сдвинуться на
  // 20 дней вперёд относительно первой.
  it('не активирована, 20-я ночь без оплаты — якорь сдвигается на nowMs, срок растёт вместе с "сегодня"', () => {
    const createdAtMs = 1_700_000_000_000;
    const nowMs = createdAtMs + 20 * DAY;
    const ownDeadlineMs = 10 * DAY;
    const disputeWindowMs = 4 * DAY;

    const dd = ddFromCreation({ createdAtMs, activatedAtMs: 0, ownDeadlineMs, disputeWindowMs, nowMs });

    expect(dd).toBe(nowMs + ownDeadlineMs + disputeWindowMs
      + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS);
  });

  // C1 (находка координатора): якорь — max(createdAtMs, activatedAtMs) КОГДА
  // activatedAtMs известен (> 0) — и, что важно для I-B, ПЕРЕСТАЁТ зависеть
  // от nowMs, как только сделка активирована: значение стабильно, не растёт
  // дальше вместе с "сегодня", даже если прогон случится намного позже.
  it('активирована ПОЗЖЕ создания (задержка оплаты) — якорь переключается на activatedAtMs и БОЛЬШЕ НЕ растёт вместе с nowMs', () => {
    const createdAtMs = 1_700_000_000_000;
    const paymentDelayMs = 8 * DAY;
    const activatedAtMs = createdAtMs + paymentDelayMs;
    const ownDeadlineMs = 30 * DAY;
    const disputeWindowMs = 4 * DAY;

    const ddNotActivated = ddFromCreation({ createdAtMs, activatedAtMs: 0, ownDeadlineMs, disputeWindowMs, nowMs: createdAtMs });
    const ddActivatedLate = ddFromCreation({ createdAtMs, activatedAtMs, ownDeadlineMs, disputeWindowMs, nowMs: activatedAtMs });
    // Прогон СИЛЬНО позже активации (месяц спустя) — значение то же самое,
    // не растёт вместе с nowMs, раз activatedAtMs уже известен.
    const ddActivatedMuchLater = ddFromCreation({ createdAtMs, activatedAtMs, ownDeadlineMs, disputeWindowMs, nowMs: activatedAtMs + 30 * DAY });

    expect(ddActivatedLate).toBe(ddNotActivated + paymentDelayMs); // сдвиг равен ровно задержке
    expect(ddActivatedLate).toBe(activatedAtMs + ownDeadlineMs + disputeWindowMs
      + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS);
    expect(ddActivatedMuchLater).toBe(ddActivatedLate); // стабильно, не уехало вместе с nowMs
  });

  it('активирована РАНЬШЕ создания — невозможно по контракту, но если бы: якорь не откатывается назад (Math.max, не последнее значение)', () => {
    const createdAtMs = 1_700_000_000_000;
    const dd = ddFromCreation({ createdAtMs, activatedAtMs: createdAtMs - DAY, ownDeadlineMs: 30 * DAY, disputeWindowMs: 4 * DAY, nowMs: createdAtMs });
    expect(dd).toBe(createdAtMs + 30 * DAY + 4 * DAY
      + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS);
  });

  it('нечисло на входе — бросает (тот же принцип, что у dealDeadlineFromDispute)', () => {
    const base = { createdAtMs: 1000, activatedAtMs: 0, ownDeadlineMs: DAY, disputeWindowMs: DAY, deadlineGraceMs: 0, autoApproveWindowMs: 0, nowMs: 1000 };
    expect(() => dealDeadlineFromCreation({ ...base, createdAtMs: 'x' })).toThrow();
    expect(() => dealDeadlineFromCreation({ ...base, activatedAtMs: NaN })).toThrow();
    expect(() => dealDeadlineFromCreation({ ...base, ownDeadlineMs: NaN })).toThrow();
    expect(() => dealDeadlineFromCreation({ ...base, disputeWindowMs: Infinity })).toThrow();
    expect(() => dealDeadlineFromCreation({ ...base, deadlineGraceMs: NaN })).toThrow();
    expect(() => dealDeadlineFromCreation({ ...base, autoApproveWindowMs: Infinity })).toThrow();
    expect(() => dealDeadlineFromCreation({ ...base, nowMs: 'never' })).toThrow();
  });

  // Мелочь (закрывающий раунд ревью, находка координатора): собственный
  // худший случай сделки БЕЗ спора длиннее одного deadlineDays_ —
  // Agreement.DEADLINE_GRACE (запас перед автовозвратом) и
  // AUTO_APPROVE_WINDOW (окно клиента среагировать после markDone) тоже
  // сдвигают момент, до которого спор в принципе возможен. Раньше этап 1
  // отставал от истинного худшего случая на сумму этих двух окон.
  describe('мелочь — DEADLINE_GRACE/AUTO_APPROVE_WINDOW учтены в предварительном сроке', () => {
    it('добавляют ровно себя к сроку (1 день + 2 дня — контрактные значения)', () => {
      const createdAtMs = 1_700_000_000_000;
      const ownDeadlineMs = 30 * DAY;
      const disputeWindowMs = 4 * DAY;
      const deadlineGraceMs = 1 * DAY;
      const autoApproveWindowMs = 2 * DAY;

      const withoutGraceEtc = dealDeadlineFromCreation({
        createdAtMs, activatedAtMs: 0, ownDeadlineMs, disputeWindowMs,
        deadlineGraceMs: 0, autoApproveWindowMs: 0, nowMs: createdAtMs,
      });
      const withGraceEtc = dealDeadlineFromCreation({
        createdAtMs, activatedAtMs: 0, ownDeadlineMs, disputeWindowMs,
        deadlineGraceMs, autoApproveWindowMs, nowMs: createdAtMs,
      });

      expect(withGraceEtc).toBe(withoutGraceEtc + deadlineGraceMs + autoApproveWindowMs);
    });
  });
});

// ─── I2 (находка координатора, закрывающий раунд): запас над концом
// апелляции. Реальная цепочка: submitVerdict ≤ disputedAt+DISPUTE_WINDOW,
// raiseAppeal только до submittedAt+FINALIZE_DELAY (24ч), appealDeadline —
// от МОМЕНТА АПЕЛЛЯЦИИ, не от submittedAt. Худший случай реальной цепочки —
// disputedAt + DISPUTE_WINDOW + FINALIZE_DELAY + APPEAL_REVIEW_WINDOW —
// формула обязана его достигать (запас ≥ 0) при ЛЮБОЙ легальной настройке
// BAG_DEAL_GRACE_MS, включая 0.
describe('I2 — запас над концом апелляции не уходит в минус даже при BAG_DEAL_GRACE_MS=0', () => {
  it('BAG_DEAL_GRACE_MS=0 (легальная настройка) — срок всё равно достигает истинного конца апелляции, не отстаёт на день', async () => {
    const saved = process.env.BAG_DEAL_GRACE_MS;
    process.env.BAG_DEAL_GRACE_MS = '0';
    vi.resetModules();
    try {
      const fresh = await import('../bagStore.js');
      const disputedAtMs = 1_700_000_000_000;
      const disputeWindowMs = 4 * DAY;

      const dd = fresh.dealDeadlineFromDispute(disputedAtMs, disputeWindowMs);

      // Истинный худший случай реальной цепочки контракта — ровно то, что
      // координатор выписал руками (submitVerdict в последний момент
      // DISPUTE_WINDOW, raiseAppeal в последний момент FINALIZE_DELAY,
      // APPEAL_REVIEW_WINDOW от момента апелляции).
      const trueEndOfAppeal = disputedAtMs + disputeWindowMs
        + fresh.FINALIZE_DELAY_HOURS * HOUR + fresh.APPEAL_REVIEW_WINDOW_DAYS * DAY;

      // До фикса (без FINALIZE_DELAY_MS в формуле): dd = disputedAt+4д+4д+0 =
      // +8д, trueEndOfAppeal = disputedAt+4д+1д+4д = +9д — dd МЕНЬШЕ на день
      // ("минус один день", буквально находка координатора). После фикса —
      // dd === trueEndOfAppeal, запас ровно 0 (легально, не отрицательно).
      expect(dd).toBeGreaterThanOrEqual(trueEndOfAppeal);
      expect(dd).toBe(trueEndOfAppeal); // запас ровно 0 при GRACE=0, не больше и не меньше
    } finally {
      if (saved === undefined) delete process.env.BAG_DEAL_GRACE_MS; else process.env.BAG_DEAL_GRACE_MS = saved;
      vi.resetModules();
      await import('../bagStore.js');
      await import('../app.js');
    }
  });

  it('на боевом умолчании (BAG_DEAL_GRACE_MS=1д) запас теперь реально положительный, не съеден отсутствующим FINALIZE_DELAY', () => {
    const disputedAtMs = 1_700_000_000_000;
    const disputeWindowMs = 4 * DAY;
    const dd = dealDeadlineFromDispute(disputedAtMs, disputeWindowMs);
    const trueEndOfAppeal = disputedAtMs + disputeWindowMs
      + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY;
    expect(dd - trueEndOfAppeal).toBe(bagStore.BAG_DEAL_GRACE_MS); // запас = ровно GRACE, не 0
    expect(dd - trueEndOfAppeal).toBeGreaterThan(0); // и он положительный на умолчании
  });
});

// ─── I3 (находка координатора, закрывающий раунд): копии private-констант
// контракта не должны переопределяться из окружения. Замер координатора:
// APPEAL_REVIEW_WINDOW_DAYS=1 в env давал disputedAt+6д вместо +9д — на три
// дня короче нужного — а гейт (проверяющий позитивность, не равенство
// четырём) оставался зелёным, потому что гейт статически сверяет ИСХОДНИК,
// а не то, с чем реально запущен процесс.
describe('I3 — копии private-констант контракта не переопределяются из окружения', () => {
  it('APPEAL_REVIEW_WINDOW_DAYS в process.env не имеет эффекта — значение всегда 4, как в контракте', async () => {
    const saved = process.env.APPEAL_REVIEW_WINDOW_DAYS;
    process.env.APPEAL_REVIEW_WINDOW_DAYS = '1'; // замер координатора: было бы на 3 дня короче
    vi.resetModules();
    try {
      const fresh = await import('../bagStore.js');
      expect(fresh.APPEAL_REVIEW_WINDOW_DAYS).toBe(4); // не 1 — переменная окружения проигнорирована
      fresh.assertBagStoreReady(); // и не бросает на "мусорном" (для настраиваемой ручки) значении — она больше не читается вовсе
    } finally {
      if (saved === undefined) delete process.env.APPEAL_REVIEW_WINDOW_DAYS; else process.env.APPEAL_REVIEW_WINDOW_DAYS = saved;
      vi.resetModules();
      await import('../bagStore.js');
      await import('../app.js');
    }
  });

  it('FINALIZE_DELAY_HOURS в process.env тоже не имеет эффекта (тот же класс константы)', async () => {
    const saved = process.env.FINALIZE_DELAY_HOURS;
    process.env.FINALIZE_DELAY_HOURS = '1';
    vi.resetModules();
    try {
      const fresh = await import('../bagStore.js');
      expect(fresh.FINALIZE_DELAY_HOURS).toBe(24);
    } finally {
      if (saved === undefined) delete process.env.FINALIZE_DELAY_HOURS; else process.env.FINALIZE_DELAY_HOURS = saved;
      vi.resetModules();
      await import('../bagStore.js');
      await import('../app.js');
    }
  });
});

// ─── Q4 — мусор на входе: вердикт (бросок), а не тихий проглот ────────────

describe('adoptPairBags — мусор на входе', () => {
  it.each([
    ['не адрес-пара строкой', 'not-a-pair-id'],
    ['пустая строка', ''],
    ['null', null],
    ['число вместо строки', 123],
    ['один адрес вместо пары', ALICE],
    ['не нижний регистр', `${ALICE.toUpperCase()}-${BOB}`],
  ])('негодный pairId (%s) — бросает', (_label, badPairId) => {
    expect(() => adoptPairBags(badPairId, Date.now() + DAY, Date.now())).toThrow();
  });

  it('нечисло в dealDeadline — бросает (строка/NaN/Infinity)', () => {
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    expect(() => adoptPairBags(pairId, 'soon', Date.now())).toThrow();
    expect(() => adoptPairBags(pairId, NaN, Date.now())).toThrow();
    expect(() => adoptPairBags(pairId, Infinity, Date.now())).toThrow();
  });

  it('срок сделки в прошлом — не бросает; практического эффекта нет, потому что bagExpiryAt всё равно не сокращает срок', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 5 * DAY);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const pastDeadline = now - 100 * DAY;

    expect(() => adoptPairBags(pairId, pastDeadline, now)).not.toThrow();
    expect(bagMetaOf(key).dealDeadline).toBe(pastDeadline); // поле выставлено как есть
    expect(bagExpiryAt(bagMetaOf(key))).toBe(now - 5 * DAY + bagStore.BAG_UNREAD_TTL_MS); // но не помогло и не навредило
  });

  it('срок сделки из далёкого будущего — не бросает сам по себе (потолок ограничивает РЕЗУЛЬТАТ, не вход — см. описание ниже)', () => {
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    expect(() => adoptPairBags(pairId, Number.MAX_SAFE_INTEGER, Date.now())).not.toThrow();
  });
});

// ─── Q5 — долбят нарочно: потолок BAG_MAX_AGE_MS реально ограничивает ─────

describe('adoptPairBags — злоупотребление усыновлением', () => {
  it('сколько ни усыновляй (в т.ч. Number.MAX_SAFE_INTEGER), мешок не переживает потолок BAG_MAX_AGE_MS от своей загрузки', () => {
    const now = Date.now();
    const uploadedAt = now - 5 * DAY;
    const key = put(ALICE, BOB, uploadedAt);
    const pairId = _pairIdFromAddresses(ALICE, BOB);

    adoptPairBags(pairId, Number.MAX_SAFE_INTEGER, now);

    const expiry = bagExpiryAt(bagMetaOf(key));
    expect(expiry).toBe(uploadedAt + bagStore.BAG_MAX_AGE_MS); // потолок реально победил
    expect(expiry).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

// ─── Q1/Q2 — перезапуск / диск кончился посреди усыновления ───────────────

describe('adoptPairBags — устойчивость к сбоям', () => {
  it('диск кончился во время усыновления — бросает (не проглатывает), в памяти откат, на диске индекс не тронут', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 5 * DAY);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const before = fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8');

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      expect(() => adoptPairBags(pairId, now + 50 * DAY, now)).toThrow(/ENOSPC/);
    } finally {
      writeSpy.mockRestore();
    }

    expect(bagMetaOf(key).dealDeadline).toBeNull(); // откат в памяти
    expect(fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8')).toBe(before); // диск не тронут
  });

  it('перезапустили ПОСРЕДИ ОДНОГО вызова adoptPairBags (несколько мешков той же пары): персист один на весь вызов — либо все, либо ни одного, не "часть"', () => {
    const now = Date.now();
    const key1 = put(ALICE, BOB, now - 5 * DAY);
    const key2 = put(ALICE, BOB, now - 6 * DAY);
    const key3 = put(ALICE, BOB, now - 7 * DAY);
    const pairId = _pairIdFromAddresses(ALICE, BOB);

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('симулированный обрыв записи (ENOSPC)');
    });
    try {
      expect(() => adoptPairBags(pairId, now + 50 * DAY, now)).toThrow();
    } finally {
      writeSpy.mockRestore();
    }

    // Ровно 0 из 3 — не "1 из 3" и не "2 из 3": единый персист на весь вызов.
    expect(bagMetaOf(key1).dealDeadline).toBeNull();
    expect(bagMetaOf(key2).dealDeadline).toBeNull();
    expect(bagMetaOf(key3).dealDeadline).toBeNull();
  });

  it('перезапустили МЕЖДУ усыновлениями двух РАЗНЫХ пар: раньше вызванное усыновление пережило процесс, ещё не вызванное — просто не начато (не испорчено)', async () => {
    const now = Date.now();
    const keyAB = put(ALICE, BOB, now - 5 * DAY);
    const keyBC = put(CAROL, BOB, now - 5 * DAY);
    const pairAB = _pairIdFromAddresses(ALICE, BOB);

    // "Обработали" пару AB — типичный шаг цикла app.js (по одному вызову
    // adoptPairBags на спорную пару). Процесс "убит" ДО того, как дошла
    // очередь до пары BC — adoptPairBags для неё просто не вызывается.
    adoptPairBags(pairAB, now + 50 * DAY, now);

    // Настоящий перезапуск — новый импорт модуля с нуля, не повторный вызов
    // _loadBagMeta() на уже живом инстансе (та же граница, что и в
    // bagStore.test.js — см. "метаиндекс переживает НАСТОЯЩИЙ перезапуск").
    const savedStorageDir = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = TMP;
    vi.resetModules();
    try {
      const fresh = await import('../bagStore.js');
      expect(fresh.bagMetaOf(keyAB).dealDeadline).toBe(now + 50 * DAY); // уцелело
      expect(fresh.bagMetaOf(keyBC).dealDeadline).toBeNull();           // просто не начато
    } finally {
      process.env.STORAGE_DIR = savedStorageDir;
      vi.resetModules();
      await import('../bagStore.js'); // вернуть модульный реестр файла в рабочее состояние
      await import('../app.js');
    }
  });
});

// ─── Q3 — два "процесса" разом ─────────────────────────────────────────────

describe('adoptPairBags — конкурентность', () => {
  it('несколько усыновлений одной пары в ОДНОМ процессе (JS синхронен, гонки внутри процесса нет)', async () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 5 * DAY);
    const pairId = _pairIdFromAddresses(ALICE, BOB);

    await Promise.all([
      Promise.resolve().then(() => adoptPairBags(pairId, now + 30 * DAY, now)),
      Promise.resolve().then(() => adoptPairBags(pairId, now + 60 * DAY, now)),
    ]);

    expect(bagMetaOf(key).dealDeadline).toBe(now + 60 * DAY); // больший срок победил, ничего не потеряно
  });

  // Известное ограничение, общее для ВСЕГО bagStore.js (тот же класс, что у
  // recordBag()/cleanupBags() — см. отчёт Задачи 4, "два процесса разом" /
  // docs/OPEN-ITEMS.md п. 28.3), не новая дыра, которую заводит усыновление:
  // персист — это "загрузить весь _bagMeta → записать весь _bagMeta", без
  // блокировки и без слияния. Два процесса с независимыми снимками в памяти
  // могут потерять запись друг друга при сохранении. Замер, не рассуждение:
  // воспроизведено ниже вручную (без реального fork — второй "процесс"
  // смоделирован прямой записью его собственного снимка на диск, минуя
  // текущий инстанс модуля, ровно то же самое, что видит настоящий второй
  // процесс со своим отдельным _bagMeta в памяти).
  it('два процесса разом усыновляют РАЗНЫЕ пары — более раннее усыновление может быть молча потеряно (известное ограничение, не новое)', () => {
    const now = Date.now();
    const keyA = put(ALICE, BOB, now - 5 * DAY);
    const keyC = put(CAROL, BOB, now - 5 * DAY);
    const pairAB = _pairIdFromAddresses(ALICE, BOB);

    // Снимок диска, с которым стартовал бы независимый "процесс B" — ДО
    // того, как "процесс A" (этот инстанс) вообще усыновил что-либо.
    const snapshotBeforeB = fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8');

    // "Процесс A" усыновляет пару AB и персистит нормально.
    adoptPairBags(pairAB, now + 40 * DAY, now);
    expect(JSON.parse(fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8'))[keyA].dealDeadline)
      .toBe(now + 40 * DAY);

    // "Процесс B" — независимый снимок _bagMeta, загруженный ДО записи A
    // (snapshotBeforeB), усыновляет ДРУГУЮ пару (BOB-CAROL) и сохраняет
    // СВОЙ снимок целиком, как и сделала бы настоящая _saveBagMeta() из
    // другого процесса: весь _bagMeta целиком, не diff.
    const rawB = JSON.parse(snapshotBeforeB);
    rawB[keyC].dealDeadline = now + 40 * DAY;
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), JSON.stringify(rawB), 'utf8');

    // Третий "процесс" (или перезапуск) читает то, что реально осталось.
    _loadBagMeta();

    expect(bagMetaOf(keyC).dealDeadline).toBe(now + 40 * DAY); // усыновление B выжило
    expect(bagMetaOf(keyA).dealDeadline).toBeNull(); // а усыновление A — потеряно: B переписал файл своим снимком
  });
});

// ─── Интеграция: runFileCleanup() усыновляет спорную пару тем же путём,
//     каким уже узнаёт о спорах getDisputedPairIds() ─────────────────────

describe('runFileCleanup — усыновление спорной пары', () => {
  it('runFileCleanup() усыновляет мешки пары со спорной сделкой сроком до конца окна апелляции (disputedAt + DISPUTE_WINDOW + APPEAL_REVIEW_WINDOW + GRACE)', async () => {
    const client   = '0x' + 'a'.repeat(40);
    const executor = '0x' + 'b'.repeat(40);
    const agreement = '0x' + 'c'.repeat(40);
    const now = Date.now();
    const disputedAtSec = Math.floor((now - 2 * DAY) / 1000);
    const disputeWindowSec = 4 * 24 * 60 * 60;

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [], // сделка уже спорная — вне getActive(), только getDisputed() ниже
      getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: 0n, resolvedAt: 0n }],
    });
    mockContract(agreement, {
      getDetails: async () => ({ disputedAt_: BigInt(disputedAtSec) }),
      DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
    });

    // Мешок брифа: загружен до сделки, в пределах лукбэка на момент прогона.
    const key = put(client, executor, now - 10 * DAY);

    await runFileCleanup();

    const expectedDeadline =
      disputedAtSec * 1000 + disputeWindowSec * 1000
      + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS;
    expect(bagMetaOf(key).dealDeadline).toBe(expectedDeadline);
  });

  // Порядок внутри runFileCleanup() значим (см. комментарий в app.js) — этот
  // тест специально ловит перестановку блоков местами: мешок прочитан давно
  // и по обычному правилу 2 (7д от прочтения) уже истёк бы САМ ПО СЕБЕ, до
  // этого самого прогона, но остаётся в пределах лукбэка усыновления (25д).
  // Если бы cleanupBags() успела отработать раньше усыновления в ЭТОМ ЖЕ
  // прогоне, мешок был бы снесён до того, как усыновление успело бы его
  // продлить — рассчитано на следующую ночь, которой уже не будет.
  it('усыновление успевает спасти в ТОМ ЖЕ прогоне мешок, который иначе снесла бы cleanupBags() этим же прогоном (порядок внутри runFileCleanup значим)', async () => {
    const client   = '0x' + '7'.repeat(40);
    const executor = '0x' + '8'.repeat(40);
    const agreement = '0x' + '9'.repeat(40);
    const now = Date.now();
    const disputedAtSec = Math.floor((now - 1 * DAY) / 1000);

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [], // сделка уже спорная — вне getActive(), только getDisputed() ниже
      getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: 0n, resolvedAt: 0n }],
    });
    mockContract(agreement, {
      getDetails: async () => ({ disputedAt_: BigInt(disputedAtSec) }),
      DISPUTE_WINDOW: async () => BigInt(4 * 24 * 60 * 60),
    });

    const uploadedAt = now - 25 * DAY; // в пределах лукбэка (30д)
    const key = put(client, executor, uploadedAt, { firstFetchedAt: uploadedAt });
    // Контроль: без усыновления мешок уже мёртв по обычному правилу 2.
    expect(bagExpiryAt(bagMetaOf(key))).toBeLessThan(now);

    await runFileCleanup();

    expect(bagMetaOf(key)).toBeDefined(); // пережил ЭТОТ ЖЕ прогон
    expect(bagMetaOf(key).dealDeadline).not.toBeNull();
  });

  it('спор по паре из-за пределов лукбэка (мешок отправлен >30д назад) не усыновляется', async () => {
    const client   = '0x' + '1'.repeat(40);
    const executor = '0x' + '2'.repeat(40);
    const agreement = '0x' + '3'.repeat(40);
    const now = Date.now();
    const disputedAtSec = Math.floor(now / 1000);

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [], // сделка уже спорная — вне getActive(), только getDisputed() ниже
      getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: 0n, resolvedAt: 0n }],
    });
    mockContract(agreement, {
      getDetails: async () => ({ disputedAt_: BigInt(disputedAtSec) }),
      DISPUTE_WINDOW: async () => BigInt(4 * 24 * 60 * 60),
    });

    // uploadedAt за пределами лукбэка (40д), но прочитан недавно (5д назад)
    // — обычное правило 2 (7д от прочтения) держит мешок живым САМ ПО СЕБЕ,
    // независимо от усыновления, так что тест проверяет именно "не
    // усыновлён", а не путает это с "снесён по любой другой причине".
    const key = put(client, executor, now - 40 * DAY, { firstFetchedAt: now - 5 * DAY });

    await runFileCleanup();

    expect(bagMetaOf(key)).toBeDefined();
    expect(bagMetaOf(key).dealDeadline).toBeNull();
  });

  it('падение усыновления (например, staticcall до несовместимого клона) не мешает ни чистке мешков, ни вложениям, и наружу не улетает', async () => {
    const client   = '0x' + '4'.repeat(40);
    const executor = '0x' + '5'.repeat(40);
    const agreement = '0x' + '6'.repeat(40);

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [], // сделка уже спорная — вне getActive(), только getDisputed() ниже
      getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: 0n, resolvedAt: 0n }],
    });
    mockContract(agreement, {
      getDetails: async () => { throw new Error('execution reverted (симулировано)'); },
      DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Обычный просроченный мешок (никак не связанный со спорной парой) —
    // должен быть вычищен как обычно, несмотря на бросок в усыновлении.
    const now = Date.now();
    const unrelatedKey = put(CAROL, ALICE, now - 31 * DAY);

    await expect(runFileCleanup()).resolves.toBeUndefined();

    expect(bagMetaOf(unrelatedKey)).toBeUndefined(); // обычная чистка отработала
    const call = errSpy.mock.calls.find(args => String(args[0]).includes('[bags] adoption'));
    expect(call).toBeDefined(); // ошибка залогирована, а не проглочена молча
  });
});

// ─── Дыра, найденная координатором на ревью: усыновление ТОЛЬКО по спору не
// защищает бриф, если спор наступает через много дней после создания сделки.
// Мешок с брифом, отправленный ДО создания сделки, могут вымести обычной
// ночной чисткой ЗАДОЛГО до того, как возникнет спор и появится шанс его
// усыновить — ровно тот случай, ради которого §6 спеки требует усыновления
// "при создании сделки", а не только при споре. Решающий замер — см.
// task-5-report.md, раздел "Замер: дыра закрыта".
describe('усыновление в два этапа — при создании сделки, и точнее при споре', () => {
  it('мешок за 20 дней ДО создания сделки, сделка "живёт" 40 дней, спор на 40-й день — мешок обязан дожить до конца окна апелляции', async () => {
    const client    = '0x' + 'e'.repeat(40);
    const executor  = '0x' + 'f'.repeat(40);
    const agreement = '0x' + 'd'.repeat(40);

    const T0 = Date.UTC(2026, 0, 1); // фиксированная точка отсчёта — "создание сделки"
    const ownDeadlineDays = 40;      // "сделка живёт сорок дней"
    const disputeWindowSec = 4 * 24 * 60 * 60;
    const uploadedAt = T0 - 20 * DAY;      // "мешок за двадцать дней до создания сделки"
    const disputedAtMs = T0 + 40 * DAY;    // "спор на сороковой день"
    const disputedAtSec = Math.floor(disputedAtMs / 1000);
    const createdAtSec = Math.floor(T0 / 1000);

    try {
      vi.setSystemTime(T0);

      // "Создание сделки": сделка ACTIVE, ещё не спорная.
      mockContract(process.env.DIAMOND_ADDRESS, {
        getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n }],
        getDisputed: [],
      });
      mockContract(agreement, {
        getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), activatedAt_: 0n, disputedAt_: 0n }),
        DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
        DEADLINE_GRACE: async () => 0n,
        AUTO_APPROVE_WINDOW: async () => 0n,
      });

      const key = put(client, executor, uploadedAt); // мешок брифа уже лежит на складе к моменту создания сделки

      await runFileCleanup(); // прогон в день создания сделки

      // Замер 1 (для отчёта): без усыновления мешок умер бы естественным
      // путём здесь — ровно то число, которое координатор просил показать
      // как "сегодня он умирает".
      const naturalDeathAt = uploadedAt + bagStore.BAG_UNREAD_TTL_MS;
      expect(naturalDeathAt).toBeLessThan(disputedAtMs); // естественная смерть раньше спора — в этом и дыра

      // Ночной прогон ПОСЛЕ естественной смерти по старому правилу, но ЗАДОЛГО
      // до спора — решающий момент: без усыновления при создании мешка тут
      // уже не будет.
      vi.setSystemTime(naturalDeathAt + 5 * DAY);
      await runFileCleanup();

      expect(bagMetaOf(key)).toBeDefined(); // пережил обычную смерть — усыновление при создании сработало

      // Спор — на 40-й день.
      vi.setSystemTime(disputedAtMs);
      mockContract(process.env.DIAMOND_ADDRESS, {
        getActive: [],
        getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: BigInt(createdAtSec), resolvedAt: BigInt(disputedAtSec) }],
      });
      mockContract(agreement, {
        getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), disputedAt_: BigInt(disputedAtSec) }),
        DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
      });
      await runFileCleanup();

      // Замер 2 (для отчёта): срок дожил как минимум до конца окна апелляции
      // от спора. Не точное равенство (было им до I-B): промежуточный
      // прогон "5 дней после естественной смерти", пока сделка ещё не
      // активирована, теперь САМ переякоривается на nowMs (см. докстринг
      // dealDeadlineFromCreation) и может дать вклад БОЛЬШЕ, чем точная
      // disputedAt-формула этапа 2 — Math.max берёт больший, это и есть
      // "усыновление только продлевает", а не откат к меньшему числу.
      const endOfAppealWindow = disputedAtMs + disputeWindowSec * 1000
        + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS;
      expect(bagMetaOf(key).dealDeadline).toBeGreaterThanOrEqual(endOfAppealWindow);
      expect(bagExpiryAt(bagMetaOf(key))).toBeGreaterThanOrEqual(endOfAppealWindow);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runFileCleanup() усыновляет мешки пары при создании сделки (getActive()), сроком по формуле dealDeadlineFromCreation', async () => {
    const client    = '0x' + '2'.repeat(40);
    const executor  = '0x' + '3'.repeat(40);
    const agreement = '0x' + '4'.repeat(40);
    // I-B: якорь этапа 1, пока сделка не активирована, — nowMs (см.
    // dealDeadlineFromCreation) — время обязано быть заморожено
    // vi.setSystemTime(), иначе между "now" здесь и Date.now() внутри
    // adoptActivePairBags() пройдут настоящие миллисекунды реального
    // времени, и точное равенство ниже станет хрупким флейком.
    const now = Date.UTC(2026, 8, 1);
    const createdAtSec = Math.floor(now / 1000);
    const ownDeadlineDays = 21;
    const disputeWindowSec = 4 * 24 * 60 * 60;

    try {
      vi.setSystemTime(now);

      mockContract(process.env.DIAMOND_ADDRESS, {
        getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n }],
        getDisputed: [],
      });
      mockContract(agreement, {
        getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), activatedAt_: 0n, disputedAt_: 0n }),
        DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
        DEADLINE_GRACE: async () => 0n,
        AUTO_APPROVE_WINDOW: async () => 0n,
      });

      const key = put(client, executor, now - 15 * DAY); // бриф до сделки, в пределах лукбэка

      await runFileCleanup();

      const expectedDeadline = createdAtSec * 1000 + ownDeadlineDays * DAY + disputeWindowSec * 1000
        + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS;
      expect(bagMetaOf(key).dealDeadline).toBe(expectedDeadline);
    } finally {
      vi.useRealTimers();
    }
  });

  // Явное требование координатора: "убедись, что второй этап не обрезает то,
  // что поставил первый, если сделка закрывается раньше ожидаемого".
  it('спор наступает РАНЬШЕ предварительного срока (сделка закрылась быстрее ожидаемого) — этап 2 не сокращает то, что дал этап 1', async () => {
    const client    = '0x' + '5'.repeat(40);
    const executor  = '0x' + '6'.repeat(40);
    const agreement = '0x' + '7'.repeat(40);
    const T0 = Date.UTC(2026, 3, 1);
    const ownDeadlineDays = 60; // предварительная оценка предполагала долгую сделку
    const disputeWindowSec = 4 * 24 * 60 * 60;
    const createdAtSec = Math.floor(T0 / 1000);

    try {
      vi.setSystemTime(T0);

      mockContract(process.env.DIAMOND_ADDRESS, {
        getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n }],
        getDisputed: [],
      });
      mockContract(agreement, {
        getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), activatedAt_: 0n, disputedAt_: 0n }),
        DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
        DEADLINE_GRACE: async () => 0n,
        AUTO_APPROVE_WINDOW: async () => 0n,
      });

      const key = put(client, executor, T0 - 5 * DAY);
      await runFileCleanup(); // этап 1: предварительный срок на 60+4+4+1 = 69 дней от T0

      const stage1Deadline = bagMetaOf(key).dealDeadline;
      expect(stage1Deadline).toBe(createdAtSec * 1000 + ownDeadlineDays * DAY + disputeWindowSec * 1000
        + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS);

      // Спор — уже на 5-й день, СИЛЬНО раньше 60-дневной предварительной
      // оценки. Точный срок этапа 2 (5+4+4+1 = 14 дней от T0) короче того,
      // что уже дал этап 1 (69 дней).
      const disputedAtMs = T0 + 5 * DAY;
      const disputedAtSec = Math.floor(disputedAtMs / 1000);
      const stage2Deadline = disputedAtMs + disputeWindowSec * 1000
        + bagStore.FINALIZE_DELAY_HOURS * HOUR + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS;
      expect(stage2Deadline).toBeLessThan(stage1Deadline); // контроль: этап 2 в этом сценарии и правда короче

      vi.setSystemTime(disputedAtMs);
      mockContract(process.env.DIAMOND_ADDRESS, {
        getActive: [],
        getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: BigInt(createdAtSec), resolvedAt: BigInt(disputedAtSec) }],
      });
      mockContract(agreement, {
        getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), disputedAt_: BigInt(disputedAtSec) }),
        DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
      });
      await runFileCleanup();

      // Срок НЕ сократился — остался тем, что дал этап 1.
      expect(bagMetaOf(key).dealDeadline).toBe(stage1Deadline);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── C1 (находка координатора, закрывающий раунд): главный путь доски
// заказов — JobBoardFacet.acceptApplicant() регистрирует сделку
// НЕОПЛАЧЕННОЙ (FactoryFacet.sol:232-273), а у fund() нет дедлайна вообще
// (Agreement.sol:557). Якорь по одному только createdAt считал сделку
// "просроченной" на фиксированный день независимо от того, когда её реально
// оплатили — при задержке оплаты дольше ~8 дней (при 30-дневном сроке
// работы) дыра открывалась заново. Таблица ниже — тот же сценарий, что дал
// координатор (0/2/5/7/8/10/20 дней задержки), с фиксом: во ВСЕХ строках
// мешок обязан дожить до спора.
describe('C1 — задержка оплаты не открывает дыру повторно (замер по требованию координатора)', () => {
  it.each([0, 2, 5, 7, 8, 10, 20])(
    'задержка оплаты %d дней — мешок доживает до спора (защита работает)',
    async (paymentDelayDays) => {
      const client    = ethAddr(paymentDelayDays, 'a');
      const executor  = ethAddr(paymentDelayDays, 'b');
      const agreement = ethAddr(paymentDelayDays, 'c');
      const T0 = Date.UTC(2027, 0, 1) + paymentDelayDays; // разный T0 на кейс — изоляция друг от друга не нужна (свои адреса), просто для читаемости логов
      const ownDeadlineDays = 30; // "срок работы" — тот же порядок, что дал координатор ("умер день 39" = 30+9)
      const disputeWindowSec = 4 * 24 * 60 * 60;
      const createdAtSec = Math.floor(T0 / 1000);

      try {
        vi.setSystemTime(T0);

        // День 0: JobBoardFacet.acceptApplicant() — сделка создана,
        // НЕ оплачена (activatedAt_ = 0 на контракте в этот момент).
        mockContract(process.env.DIAMOND_ADDRESS, {
          getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n }],
          getDisputed: [],
        });
        mockContract(agreement, {
          getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), activatedAt_: 0n, disputedAt_: 0n }),
          DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
          DEADLINE_GRACE: async () => 0n,
          AUTO_APPROVE_WINDOW: async () => 0n,
        });

        const key = put(client, executor, T0); // мешок брифа, отправлен вместе с созданием
        await runFileCleanup(); // первый ночной прогон — этап 1, якорь пока createdAt (не оплачена)

        // Оплата/активация — через paymentDelayDays. Следующий ночной прогон
        // после активации подхватывает activatedAt_ (С1: якорь max(createdAt,
        // activatedAt)) — ничего специального делать не нужно, обычный
        // ежедневный цикл runFileCleanup().
        const activatedAtMs = T0 + paymentDelayDays * DAY;
        const activatedAtSec = Math.floor(activatedAtMs / 1000);
        vi.setSystemTime(activatedAtMs + DAY);
        mockContract(agreement, {
          getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), activatedAt_: BigInt(activatedAtSec), disputedAt_: 0n }),
          DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
          DEADLINE_GRACE: async () => 0n,
          AUTO_APPROVE_WINDOW: async () => 0n,
        });
        await runFileCleanup();

        // Спор — через сутки после РЕАЛЬНОГО дедлайна работы, считая от
        // activatedAt (Agreement.deadline(): activatedAt + deadlineDays*1д),
        // не от createdAt.
        const realWorkDeadlineMs = activatedAtMs + ownDeadlineDays * DAY;
        const disputedAtMs = realWorkDeadlineMs + DAY;
        const disputedAtSec = Math.floor(disputedAtMs / 1000);
        vi.setSystemTime(disputedAtMs);
        mockContract(process.env.DIAMOND_ADDRESS, {
          getActive: [],
          getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: BigInt(createdAtSec), resolvedAt: BigInt(disputedAtSec) }],
        });
        mockContract(agreement, {
          getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), activatedAt_: BigInt(activatedAtSec), disputedAt_: BigInt(disputedAtSec) }),
          DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
        });
        await runFileCleanup();

        // Замер: мешок жив на момент спора и остаётся живым как минимум до
        // момента спора (реальная защита, не просто "запись существует").
        expect(bagMetaOf(key)).toBeDefined();
        expect(bagMetaOf(key).dealDeadline).not.toBeNull();
        expect(bagExpiryAt(bagMetaOf(key))).toBeGreaterThanOrEqual(disputedAtMs);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

// ─── Мелочи эффективности (находки координатора, закрывающий раунд) ───────

describe('мелочи эффективности — лишняя работа с цепью', () => {
  it('getDisputed() вызывается РОВНО один раз за прогон runFileCleanup(), не дважды (защита вложений + усыновление по спору делят один вызов)', async () => {
    let calls = 0;
    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [],
      getDisputed: () => { calls++; return []; },
    });

    await runFileCleanup();

    expect(calls).toBe(1);
  });

  // I-C (третий закрывающий раунд ревью, находка координатора): слив двух
  // вызовов getDisputed() в один раньше означал, что при отказе чтения
  // adoptDisputedPairBags() получает уже готовый (пустой) массив и МОЛЧА
  // ничего не усыновляет — в лог уходила только строка про защиту вложений,
  // про усыновление ни слова.
  it('отказ общего getDisputed() даёт ДВЕ строки в лог — про защиту вложений И про усыновление по спору, не только про первое', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [],
      getDisputed: () => { throw new Error('execution reverted (симулировано)'); },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runFileCleanup()).resolves.toBeUndefined();

    const filesMsg = errSpy.mock.calls.find(args => String(args[0]).includes('[files]') && String(args[0]).includes('getDisputed'));
    const bagsMsg = errSpy.mock.calls.find(args => String(args[0]).includes('[bags] adoption') && String(args[0]).includes('getDisputed'));
    expect(filesMsg).toBeDefined();
    expect(bagsMsg).toBeDefined(); // раньше этой строки не было вовсе
  });

  it('DISPUTE_WINDOW() читается один раз на агримент, не на каждый ночной прогон заново (кэш живёт между вызовами runFileCleanup())', async () => {
    const client    = ethAddr(1, '1');
    const executor  = ethAddr(1, '2');
    const agreement = ethAddr(1, '3');
    let disputeWindowCalls = 0;

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [],
      getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: 0n, resolvedAt: 0n }],
    });
    mockContract(agreement, {
      getDetails: async () => ({ disputedAt_: BigInt(Math.floor(Date.now() / 1000)) }),
      DISPUTE_WINDOW: () => { disputeWindowCalls++; return 4n * 24n * 60n * 60n; },
    });

    await runFileCleanup(); // "ночь 1"
    await runFileCleanup(); // "ночь 2" — тот же агримент всё ещё спорный

    expect(disputeWindowCalls).toBe(1); // не 2
  });

  it('кэш DISPUTE_WINDOW делит значение между этапом создания и этапом спора — один агримент, один вызов на весь процесс', async () => {
    const client    = ethAddr(2, '4');
    const executor  = ethAddr(2, '5');
    const agreement = ethAddr(2, '6');
    let disputeWindowCalls = 0;
    const now = Date.now();

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(Math.floor(now / 1000)), resolvedAt: 0n }],
      getDisputed: [],
    });
    mockContract(agreement, {
      getDetails: async () => ({ deadlineDays_: 30n, activatedAt_: 0n, disputedAt_: 0n }),
      DISPUTE_WINDOW: () => { disputeWindowCalls++; return 4n * 24n * 60n * 60n; },
    });
    await runFileCleanup(); // этап создания читает DISPUTE_WINDOW первым

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [],
      getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: 0n, resolvedAt: BigInt(Math.floor(now / 1000)) }],
    });
    mockContract(agreement, {
      getDetails: async () => ({ deadlineDays_: 30n, activatedAt_: 0n, disputedAt_: BigInt(Math.floor(now / 1000)) }),
      DISPUTE_WINDOW: () => { disputeWindowCalls++; return 4n * 24n * 60n * 60n; },
    });
    await runFileCleanup(); // этап спора — тот же агримент, кэш уже тёплый

    expect(disputeWindowCalls).toBe(1); // не 2 — второй этап переиспользовал кэш первого
  });

  it('у provider реально настроен таймаут — не 300с умолчание ethers, и значение доходит до объекта, которым пользуется библиотека', () => {
    expect(relayerInfo.rpcTimeoutMs).toBe(20_000); // умолчание
    expect(relayerInfo.rpcTimeoutMs).toBeLessThan(300_000); // строго меньше умолчания ethers — иначе "таймаут" ничего не меняет
    // _getConnection() — то же самое, что реально шлёт HTTP-запрос внутри
    // JsonRpcProvider._send(); проверяем настоящий FetchRequest, а не то,
    // что МЫ думаем, что туда положили.
    expect(relayerInfo.provider._getConnection().timeout).toBe(relayerInfo.rpcTimeoutMs);
  });

  it('RPC_TIMEOUT_MS настраивается через окружение, с явным умолчанием (20с)', async () => {
    const saved = process.env.RPC_TIMEOUT_MS;
    process.env.RPC_TIMEOUT_MS = '5000';
    vi.resetModules();
    try {
      const fresh = await import('../app.js');
      expect(fresh.relayerInfo.rpcTimeoutMs).toBe(5000);
      expect(fresh.relayerInfo.provider._getConnection().timeout).toBe(5000);
    } finally {
      if (saved === undefined) delete process.env.RPC_TIMEOUT_MS; else process.env.RPC_TIMEOUT_MS = saved;
      vi.resetModules();
      await import('../bagStore.js');
      await import('../app.js');
    }
  });
});

// ─── I-B (третий закрывающий раунд ревью): лукбэк блокировал переякорение
// уже усыновлённой записи — DIAGNOSTIC, временно, будет заменён финальными
// тестами.

/**
 * Симулирует ежедневные ночные прогоны runFileCleanup() от создания сделки
 * до спора — тем же методом, что координатор ("ежедневные прогоны", не
 * редкие контрольные точки). Между "интересными" днями (когда состояние на
 * цепи реально меняется) полный runFileCleanup() не нужен:
 * adoptActivePairBags() на "скучный" день пересчитывает РОВНО ТО ЖЕ
 * значение (на цепи ничего не изменилось) — не-оп, эквивалентный прямому
 * вызову cleanupBags() без переусыновления. Три контрольные точки: день 0
 * (создание), день paymentDelayDays (активация), день спора.
 */
async function simulateDailyProtection({
  client, executor, agreement, T0, ownDeadlineDays, paymentDelayDays,
  uploadedAt, firstFetchedAt, disputeAfterDays,
}) {
  const disputeWindowSec = 4 * 24 * 60 * 60;
  const deadlineGraceSec = 24 * 60 * 60;       // Agreement.DEADLINE_GRACE — 1 день
  const autoApproveWindowSec = 2 * 24 * 60 * 60; // Agreement.AUTO_APPROVE_WINDOW — 2 дня
  const createdAtSec = Math.floor(T0 / 1000);

  // Мок агримента ставится ОДИН раз для "неактивированного" состояния и
  // переиспользуется на каждом "скучном" дне — DEADLINE_GRACE/AUTO_APPROVE_WINDOW
  // обязаны быть замоканы (app.js читает их теперь тоже), иначе adoptActivePairBags()
  // молча падает в catch на каждую ночь, и усыновление не срабатывает вовсе
  // (проверено вживую при первой версии этого хелпера — без этих двух моков
  // и unread-, и read-сценарии откатывались к голым базовым правилам
  // bagExpiryAt, маскируя вообще всякий эффект фикса I-B).
  const notActivatedGetDetails = async () => ({ deadlineDays_: BigInt(ownDeadlineDays), activatedAt_: 0n, disputedAt_: 0n });
  const agreementMocks = () => ({
    getDetails: notActivatedGetDetails,
    DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
    DEADLINE_GRACE: async () => BigInt(deadlineGraceSec),
    AUTO_APPROVE_WINDOW: async () => BigInt(autoApproveWindowSec),
  });

  vi.setSystemTime(T0);
  mockContract(process.env.DIAMOND_ADDRESS, {
    getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n }],
    getDisputed: [],
  });
  mockContract(agreement, agreementMocks());

  const key = put(client, executor, uploadedAt, firstFetchedAt != null ? { firstFetchedAt } : {});

  await runFileCleanup(); // день 0

  const activatedAtMs = T0 + paymentDelayDays * DAY;
  const activatedAtSec = Math.floor(activatedAtMs / 1000);
  const realWorkDeadlineMs = activatedAtMs + ownDeadlineDays * DAY;
  const disputedAtMs = realWorkDeadlineMs + disputeAfterDays * DAY;
  const disputedAtSec = Math.floor(disputedAtMs / 1000);
  const disputeDayOffset = Math.round((disputedAtMs - T0) / DAY);

  // I-B: пока сделка НЕ активирована, якорь предварительного срока — nowMs
  // (см. докстринг dealDeadlineFromCreation), значит КАЖДЫЙ день до
  // активации обязан быть настоящим прогоном runFileCleanup(), не
  // "скучным" cleanupBags() без переусыновления — иначе тест сам не
  // воспроизводит механизм, который проверяет (ровно так ошиблась первая
  // версия этого хелпера: показывала "работает" там, где на самом деле не
  // работало, потому что не звала адопцию на дни, где та единственная и
  // давала эффект).
  for (let d = 1; d < paymentDelayDays; d++) {
    vi.setSystemTime(T0 + d * DAY);
    await runFileCleanup();
    if (!bagMetaOf(key)) return { survived: false, diedOnDay: d };
  }

  if (paymentDelayDays > 0) {
    vi.setSystemTime(activatedAtMs);
    mockContract(agreement, {
      getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), activatedAt_: BigInt(activatedAtSec), disputedAt_: 0n }),
      DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
      DEADLINE_GRACE: async () => BigInt(deadlineGraceSec),
      AUTO_APPROVE_WINDOW: async () => BigInt(autoApproveWindowSec),
    });
    await runFileCleanup();
    if (!bagMetaOf(key)) return { survived: false, diedOnDay: paymentDelayDays };
  }

  // После активации якорь стабилен (max(createdAt, activatedAt), не растёт
  // дальше сам по себе) — дальнейшие ночи до спора действительно "скучные",
  // прямой cleanupBags() эквивалентен полному прогону без изменений.
  for (let d = paymentDelayDays + 1; d < disputeDayOffset; d++) {
    vi.setSystemTime(T0 + d * DAY);
    cleanupBags(T0 + d * DAY);
    if (!bagMetaOf(key)) return { survived: false, diedOnDay: d };
  }

  vi.setSystemTime(disputedAtMs);
  mockContract(process.env.DIAMOND_ADDRESS, {
    getActive: [],
    getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: BigInt(createdAtSec), resolvedAt: BigInt(disputedAtSec) }],
  });
  mockContract(agreement, {
    getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), activatedAt_: BigInt(activatedAtSec), disputedAt_: BigInt(disputedAtSec) }),
    DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
  });
  await runFileCleanup();

  if (!bagMetaOf(key)) return { survived: false, diedOnDay: disputeDayOffset };
  return { survived: true, diedOnDay: null };
}

// Таблица 1 координатора: непрочитанный мешок, сделка с 10-дневным сроком
// работы (короткий, чтобы задержки до 60 дней не упирались в ПОТОЛОК
// BAG_MAX_AGE_MS — 90 дней от загрузки, отдельный, уже существующий и
// заведомо корректный анти-абьюз механизм, не имеющий отношения к I-B —
// см. отдельный тест на потолок в конце этого describe). Спор — через
// сутки после реального дедлайна работы (activatedAt + deadlineDays + 1д).
describe('I-B, таблица 1 (координатор): непрочитанный мешок — защита при любой задержке оплаты', () => {
  it.each([0, 2, 5, 7, 8, 10, 20, 25, 28, 29, 30, 31, 40, 60])(
    'задержка оплаты %d дней — мешок доживает до спора',
    async (paymentDelayDays) => {
      const T0 = Date.UTC(2029, 0, 1) + paymentDelayDays;
      try {
        const r = await simulateDailyProtection({
          client: ethAddr(paymentDelayDays, '1'),
          executor: ethAddr(paymentDelayDays, '2'),
          agreement: ethAddr(paymentDelayDays, '3'),
          T0, ownDeadlineDays: 10, paymentDelayDays,
          uploadedAt: T0, firstFetchedAt: null, disputeAfterDays: 1,
        });
        expect(r).toEqual({ survived: true, diedOnDay: null });
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

// Таблица 2 координатора: ПРОЧИТАННЫЙ мешок (контрагент открыл бриф — база
// bagExpiryAt в этом случае короче, 7д от прочтения вместо 30д от загрузки,
// см. правило 2 в bagStore.js) + КОРОТКАЯ сделка — граница раньше, чем в
// таблице 1, потому что слабая база больше не маскирует то, что до фикса
// I-B давал сам предварительный срок этапа 1. Значения задержек — ровно
// те, на которых координатор нашёл поломку ДО фикса (14/18/25/30 дней для
// сроков работы 3/7/14/30), плюс запас сверху, доказывающий, что дело не в
// частном совпадении чисел.
describe('I-B, таблица 2 (координатор): прочитанный мешок + короткая сделка — защита при задержке, на которой раньше ломалось', () => {
  it.each([
    [3, 14],  [3, 20],
    [7, 18],  [7, 25],
    [14, 25], [14, 32],
    [30, 30], [30, 40],
  ])(
    'срок работы %d дней, задержка оплаты %d дней (координатор: до фикса здесь уже не работало) — мешок доживает до спора',
    async (ownDeadlineDays, paymentDelayDays) => {
      const T0 = Date.UTC(2029, 3, 1) + ownDeadlineDays * 100 + paymentDelayDays;
      try {
        const r = await simulateDailyProtection({
          client: ethAddr(ownDeadlineDays * 100 + paymentDelayDays, '4'),
          executor: ethAddr(ownDeadlineDays * 100 + paymentDelayDays, '5'),
          agreement: ethAddr(ownDeadlineDays * 100 + paymentDelayDays, '6'),
          T0, ownDeadlineDays, paymentDelayDays,
          uploadedAt: T0, firstFetchedAt: T0, disputeAfterDays: 1,
        });
        expect(r).toEqual({ survived: true, diedOnDay: null });
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

// Потолок BAG_MAX_AGE_MS — отдельный, уже существующий анти-абьюз механизм
// (Q5 отчёта по этапу 2/3) — I-B на него НЕ ПОСЯГАЕТ: если задержка + срок
// работы физически не укладываются в 90 дней от загрузки, потолок всё
// равно побеждает. Контроль, что фикс I-B не сломал эту, отдельную границу
// (тот же сценарий, что дал day90 в первой версии этого раунда — задержка
// 60д + срок работы 30д + сутки запаса = 91д, за пределами потолка).
describe('I-B не отменяет потолок BAG_MAX_AGE_MS — контроль', () => {
  it('задержка + срок работы физически превышают 90 дней от загрузки — потолок всё равно побеждает, мешок не переживает его', async () => {
    const T0 = Date.UTC(2029, 6, 1);
    try {
      const r = await simulateDailyProtection({
        client: ethAddr(777, '7'), executor: ethAddr(777, '8'), agreement: ethAddr(777, '9'),
        T0, ownDeadlineDays: 30, paymentDelayDays: 60, uploadedAt: T0, firstFetchedAt: null, disputeAfterDays: 1,
      });
      // 60 (задержка) + 30 (срок работы) + 1 (запас) = 91д > 90д (BAG_MAX_AGE_MS) —
      // потолок останавливает рост срока раньше, чем наступает спор.
      expect(r.survived).toBe(false);
      expect(r.diedOnDay).toBe(90);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── I-D (третий закрывающий раунд ревью, находка координатора): BAG_MAX_AGE_MS
// режет уже усыновлённый срок молча — предупреждение при старте, если
// потолок физически не даёт дожить до конца апелляции.
describe('I-D — предупреждение при старте, если BAG_MAX_AGE_MS не даёт дожить до конца апелляции', () => {
  it('на боевом умолчании (90д) предупреждения нет — потолок с запасом больше нужного', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      assertBagStoreReady();
      const call = warnSpy.mock.calls.find(args => String(args[0]).includes('BAG_MAX_AGE_MS'));
      expect(call).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Замер координатора: BAG_MAX_AGE_MS=6д — потолок явно недостаточен
  // (окно спора+финализации+апелляции+запас — минимум ~14д при боевых
  // умолчаниях: 4+1+4+1 = 10д плюс оценка окна спора ~4д = ~14д).
  it('BAG_MAX_AGE_MS=6 дней (замер координатора) — предупреждение при старте, называющее BAG_MAX_AGE_MS и апелляцию', async () => {
    const saved = process.env.BAG_MAX_AGE_MS;
    process.env.BAG_MAX_AGE_MS = String(6 * DAY);
    vi.resetModules();
    try {
      const fresh = await import('../bagStore.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fresh.assertBagStoreReady();
        const call = warnSpy.mock.calls.find(args => String(args[0]).includes('BAG_MAX_AGE_MS'));
        expect(call).toBeDefined();
        expect(String(call[0])).toMatch(/апелляции/);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      if (saved === undefined) delete process.env.BAG_MAX_AGE_MS; else process.env.BAG_MAX_AGE_MS = saved;
      vi.resetModules();
      await import('../bagStore.js');
      await import('../app.js');
    }
  });

  it('не бросает — предупреждение, не ошибка (маленький потолок может быть намеренным)', async () => {
    const saved = process.env.BAG_MAX_AGE_MS;
    process.env.BAG_MAX_AGE_MS = String(1 * DAY);
    vi.resetModules();
    try {
      const fresh = await import('../bagStore.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(() => fresh.assertBagStoreReady()).not.toThrow();
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      if (saved === undefined) delete process.env.BAG_MAX_AGE_MS; else process.env.BAG_MAX_AGE_MS = saved;
      vi.resetModules();
      await import('../bagStore.js');
      await import('../app.js');
    }
  });
});
