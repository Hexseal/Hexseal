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
  it('усыновление продлевает мешки пары (мешок ещё жив по обычному правилу)', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 20 * DAY); // непрочитан, ещё жив (правило 3: 30д от загрузки)
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const deadline = now + 100 * DAY; // за пределами потолка (90д) — funded=true, чтобы этот базовый тест не путался с C1 (см. describe "C1")

    const result = adoptPairBags(pairId, deadline, now, true);

    expect(result.adopted).toBe(1);
    expect(bagMetaOf(key).dealDeadline).toBe(deadline);
  });

  it('мешок, уже истёкший по обычному правилу к моменту вызова, не усыновляется (И-2: критерий — жив, не возраст)', () => {
    const now = Date.now();
    // Непрочитан, за пределами обычного 30-дневного срока — bagExpiryAt
    // уже в прошлом относительно now, запись физически мертва к этому вызову.
    const key = put(ALICE, BOB, now - 31 * DAY);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    expect(bagExpiryAt(bagMetaOf(key))).toBeLessThan(now); // контроль: действительно уже мёртв

    const result = adoptPairBags(pairId, now + 100 * DAY, now);

    expect(result.adopted).toBe(0);
    expect(bagMetaOf(key).dealDeadline).toBeNull();
  });

  // И-2 (пятый закрывающий раунд ревью, находка координатора): гейт первого
  // усыновления — bagExpiryAt(meta, nowMs) > nowMs, СТРОГОЕ неравенство, не
  // ">=". Запирает именно ОПЕРАТОР границы, не просто "мёртв/жив вообще" —
  // мутация ">" → ">=" его не задевала бы, будь граница проверена только
  // тестами выше.
  it('граница живости строгая: ровно на bagExpiryAt не усыновляется, на миллисекунду раньше истечения — усыновляется', () => {
    const now = Date.now();
    // Непрочитанный мешок: bagExpiryAt = uploadedAt + BAG_UNREAD_TTL_MS.
    // uploadedAt подобран так, чтобы это равнялось ровно now (граница) и
    // now+1 (на мс раньше границы, ещё жив) для двух разных записей.
    const exactlyAtExpiry = put(ALICE, BOB, now - bagStore.BAG_UNREAD_TTL_MS);
    const justAliveByOneMs = put(CAROL, BOB, now - bagStore.BAG_UNREAD_TTL_MS + 1);
    expect(bagExpiryAt(bagMetaOf(exactlyAtExpiry))).toBe(now);
    expect(bagExpiryAt(bagMetaOf(justAliveByOneMs))).toBe(now + 1);

    const pairAB = _pairIdFromAddresses(ALICE, BOB);
    const pairCB = _pairIdFromAddresses(CAROL, BOB);
    adoptPairBags(pairAB, now + 100 * DAY, now, true); // funded=true — за пределами потолка, не про C1 здесь
    adoptPairBags(pairCB, now + 100 * DAY, now, true);

    expect(bagMetaOf(exactlyAtExpiry).dealDeadline).toBeNull();       // ровно на границе — не усыновлён
    expect(bagMetaOf(justAliveByOneMs).dealDeadline).toBe(now + 100 * DAY); // на мс живее — усыновлён
  });

  it('мешки другой пары не трогаются', () => {
    const now = Date.now();
    const keyAB = put(ALICE, BOB, now - 10 * DAY);
    const keyBC = put(CAROL, BOB, now - 10 * DAY); // другая пара (BOB-CAROL)
    const pairAB = _pairIdFromAddresses(ALICE, BOB);

    adoptPairBags(pairAB, now + 100 * DAY, now, true); // funded=true — за пределами потолка, не про C1 здесь

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

    // И-2: к МОМЕНТУ СПОРА (disputedAtMs) базовое правило само по себе УЖЕ
    // истекло (baseExpiry < verdictOnlyDeadline < disputedAtMs+DISPUTE_WINDOW
    // ... собственно baseExpiry ниже disputedAtMs тоже) — гейт первого
    // усыновления ("мешок ещё жив") в этот момент НЕ пропустил бы прямой
    // одноразовый вызов adoptPairBags(pairId, dd, disputedAtMs) на НИКОГДА
    // не усыновлявшуюся запись. Реалистичный путь — тот же, что даёт
    // runFileCleanup() в проде: этап 1 усыновляет мешок РАНЬШЕ, пока он ещё
    // жив (сразу после загрузки, любым предварительным сроком) — после
    // этого запись уже "усыновлена", и гейт живости её больше не проверяет
    // (см. докстринг adoptPairBags(), правило "только продлевать").
    adoptPairBags(pairId, uploadedAt + 1 * DAY, uploadedAt);

    adoptPairBags(pairId, dd, disputedAtMs);

    const expiryAfterAdoption = bagExpiryAt(bagMetaOf(key));
    expect(expiryAfterAdoption).toBe(dd); // потолок (90д от uploadedAt) тут не ограничитель
    expect(expiryAfterAdoption).toBeGreaterThan(verdictOnlyDeadline); // пережил вердикт
  });

  it('второе усыновление той же пары не откатывает более дальний срок', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 10 * DAY);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const farDeadline = now + 100 * DAY; // за пределами потолка (90д) — funded=true, не про C1 здесь
    const nearDeadline = now + 5 * DAY;

    adoptPairBags(pairId, farDeadline, now, true);
    const resultSecond = adoptPairBags(pairId, nearDeadline, now);

    expect(resultSecond.adopted).toBe(0); // ни одна запись фактически не изменилась
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

  // Мелочи (координатор, пятый закрывающий раунд ревью): два вида мусора с
  // цепи молча проходили и раньше не проверялись отдельно — отрицательный
  // deadlineDays_ (складывается со знаком минус, УКОРАЧИВАЯ формулу без
  // единой строки в логе) и activatedAt_ из будущего (абсурдный срок на
  // годы вперёд, спасаемый только потолком BAG_MAX_AGE_MS). Оба теперь
  // бросают вместо тихого прохода — see assertNonNegativeSafeInt/
  // assertNotFromFuture в bagStore.js.
  describe('мелочи (координатор) — мусор с цепи: отрицательная длительность и метка времени из будущего', () => {
    const base = { createdAtMs: 1_700_000_000_000, activatedAtMs: 0, ownDeadlineMs: 10 * DAY, disputeWindowMs: 4 * DAY, deadlineGraceMs: DAY, autoApproveWindowMs: 2 * DAY, nowMs: 1_700_000_000_000 };

    it('отрицательный ownDeadlineMs — бросает, не укорачивает срок молча', () => {
      expect(() => dealDeadlineFromCreation({ ...base, ownDeadlineMs: -5 * DAY })).toThrow(/negative/);
    });

    it('отрицательный disputeWindowMs/deadlineGraceMs/autoApproveWindowMs — тот же класс, тоже бросает (не только названный координатором deadlineDays_)', () => {
      expect(() => dealDeadlineFromCreation({ ...base, disputeWindowMs: -1 })).toThrow(/negative/);
      expect(() => dealDeadlineFromCreation({ ...base, deadlineGraceMs: -1 })).toThrow(/negative/);
      expect(() => dealDeadlineFromCreation({ ...base, autoApproveWindowMs: -1 })).toThrow(/negative/);
    });

    it('отрицательный disputeWindowMs в dealDeadlineFromDispute (этап 2) — тот же класс, тоже бросает', () => {
      expect(() => dealDeadlineFromDispute(1_700_000_000_000, -1)).toThrow(/negative/);
    });

    it('activatedAtMs из будущего относительно nowMs — бросает, не даёт абсурдный срок на годы вперёд', () => {
      const nowMs = base.createdAtMs;
      expect(() => dealDeadlineFromCreation({ ...base, nowMs, activatedAtMs: nowMs + 365 * DAY })).toThrow(/future/);
    });

    it('activatedAtMs в пределах допуска на рассинхрон часов (CLOCK_SKEW_ALLOWANCE_MS) — НЕ бросает', () => {
      const nowMs = base.createdAtMs;
      expect(() => dealDeadlineFromCreation({ ...base, nowMs, activatedAtMs: nowMs + 1000 })).not.toThrow();
    });

    it('createdAtMs из будущего относительно nowMs — тот же класс входа (то же getActive()), тоже бросает', () => {
      const nowMs = base.createdAtMs;
      expect(() => dealDeadlineFromCreation({ ...base, nowMs, createdAtMs: nowMs + 365 * DAY })).toThrow(/future/);
    });

    // Интеграция: мусорный вход по ОДНОЙ спорной/активной записи не должен
    // валить весь ночной прогон — тот же принцип изоляции по записям, что
    // уже заперт для staticcall-отказов (describe "runFileCleanup" выше).
    // Свежий, не тронутый ГАРБАЖ-агримент рядом с ХОРОШИМ — усыновление
    // ХОРОШЕГО обязано состояться, несмотря на бросок в СОСЕДНЕЙ записи.
    it('интеграция: отрицательный deadlineDays_ у ОДНОЙ активной записи не мешает усыновить ДРУГУЮ (изоляция по записям)', async () => {
      const garbageAgreement = ethAddr(901, '1');
      const goodAgreement = ethAddr(901, '2');
      const goodClient = ethAddr(901, '3');
      const goodExecutor = ethAddr(901, '4');
      const now = Date.now();
      const createdAtSec = Math.floor(now / 1000);

      mockContract(process.env.DIAMOND_ADDRESS, {
        getActive: [
          { agreement: garbageAgreement, client: CAROL, executor: ALICE, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n },
          { agreement: goodAgreement, client: goodClient, executor: goodExecutor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n },
        ],
        getDisputed: [],
      });
      mockContract(garbageAgreement, {
        getDetails: async () => ({ deadlineDays_: -5n, activatedAt_: 0n, disputedAt_: 0n }), // отрицательный — мусор
        DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
        DEADLINE_GRACE: async () => 0n,
        AUTO_APPROVE_WINDOW: async () => 0n,
      });
      mockContract(goodAgreement, {
        getDetails: async () => ({ deadlineDays_: 30n, activatedAt_: 0n, disputedAt_: 0n }),
        DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
        DEADLINE_GRACE: async () => 0n,
        AUTO_APPROVE_WINDOW: async () => 0n,
      });

      const goodKey = put(goodClient, goodExecutor, now - 10 * DAY);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(runFileCleanup()).resolves.toBeUndefined();

      expect(bagMetaOf(goodKey).dealDeadline).not.toBeNull(); // хорошая запись усыновлена, несмотря на мусор в соседней
      const call = errSpy.mock.calls.find(args => String(args[0]).includes('[bags] adoption') && String(args[0]).includes(garbageAgreement));
      expect(call).toBeDefined(); // и мусор не проглочен молча — залогирован
    });

    // Мелочь (координатор, критический раунд): fundedAt_ — единственное
    // поле ответа getDetails(), оставшееся без проверки "не из будущего".
    // Метка из 5138 года молча даёт бессрочное освобождение от потолка
    // (funded вычисляется только через > 0, любая положительная метка
    // проходит одинаково, реальная или абсурдная). Тот же класс изоляции
    // по записям, что и у остальных мелочей этого блока.
    it('интеграция: fundedAt_ из будущего у ОДНОЙ активной записи не мешает усыновить ДРУГУЮ, и не даёт бессрочное освобождение мусорной записи', async () => {
      const garbageAgreement = ethAddr(902, '1');
      const goodAgreement = ethAddr(902, '2');
      const goodClient = ethAddr(902, '3');
      const goodExecutor = ethAddr(902, '4');
      const now = Date.now();
      const createdAtSec = Math.floor(now / 1000);
      const farFutureSec = Math.floor((now + 365 * DAY) / 1000); // "год 5138" — тот же класс, взят ближе для точных чисел в тесте

      mockContract(process.env.DIAMOND_ADDRESS, {
        getActive: [
          { agreement: garbageAgreement, client: CAROL, executor: ALICE, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n },
          { agreement: goodAgreement, client: goodClient, executor: goodExecutor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n },
        ],
        getDisputed: [],
      });
      mockContract(garbageAgreement, {
        // fundedAt_ из будущего — мусор, если бы прошёл без проверки, дал
        // бы funded=true (fundedAtMs > 0 истинно для ЛЮБОЙ положительной
        // метки) и бессрочное освобождение от потолка мусорной записи.
        getDetails: async () => ({ deadlineDays_: 30n, fundedAt_: BigInt(farFutureSec), activatedAt_: 0n, disputedAt_: 0n }),
        DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
        DEADLINE_GRACE: async () => 0n,
        AUTO_APPROVE_WINDOW: async () => 0n,
      });
      mockContract(goodAgreement, {
        getDetails: async () => ({ deadlineDays_: 30n, fundedAt_: 0n, activatedAt_: 0n, disputedAt_: 0n }),
        DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
        DEADLINE_GRACE: async () => 0n,
        AUTO_APPROVE_WINDOW: async () => 0n,
      });

      const garbageKey = put(CAROL, ALICE, now - 10 * DAY);
      const goodKey = put(goodClient, goodExecutor, now - 10 * DAY);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(runFileCleanup()).resolves.toBeUndefined();

      expect(bagMetaOf(goodKey).dealDeadline).not.toBeNull(); // хорошая запись усыновлена, несмотря на мусор в соседней
      expect(bagMetaOf(garbageKey).dealDeadline).toBeNull(); // мусорная НЕ усыновлена вовсе — бросок остановил её ДО adoptPairBags
      const call = errSpy.mock.calls.find(args => String(args[0]).includes('[bags] adoption') && String(args[0]).includes(garbageAgreement));
      expect(call).toBeDefined(); // и мусор не проглочен молча — залогирован
    });
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

// ─── Решение владельца (раунд, следующий за И-1/C-1/И-2): потолок BAG_MAX_AGE_MS
// не применяется к мешкам, усыновлённым ОПЛАЧЕННОЙ сделкой (fundedAt_ > 0 —
// деньги реально вошли в эскроу, src/Agreement.sol:fund()/fundFromFactory()).
// Ко всему остальному (не зарегистрирована, зарегистрирована но не оплачена,
// отменена/брошена неоплаченной, мешки без всякой сделки) потолок остаётся
// как был. Обоснование владельца: потолок стоял единственной защитой от
// злоупотребления пометкой чужой перепиской "сделкой" — но завести сделку и
// не заплатить стоит только газа, а заморозить деньги в эскроро — уже
// реальное участие. Защита не исчезает, она переезжает с диска на капитал.
//
// fundedAt_ ≠ activatedAt_ — НЕ то же самое поле, что уже используется
// якорем dealDeadlineFromCreation(). Разведано явно (иначе легко перепутать
// с уже существующим C1-анкором): src/Agreement.sol — fund()/fundFromFactory()
// (строки 557/581) ставят ТОЛЬКО fundedAt = block.timestamp; activate()
// (строка 596, вызывает ИСПОЛНИТЕЛЬ, требует fundedAt != 0) — отдельный,
// более поздний вызов, ставит activatedAt. Между ними реальный разрыв —
// ACTIVATION_WINDOW = 2 дня (строка 276): деньги уже в эскроу
// (status() == FUNDED), а деадлайн работы ещё не начал тикать
// (activatedAt всё ещё 0). Оба поля МОНОТОННЫ (грep по всему файлу — ни
// одного `= 0` после установки), значит "усыновление только продлевает"
// работает и здесь без изменений: разрешено ставить dealFunded только в
// true, никогда обратно.
describe('bagExpiryAt/adoptPairBags — оплаченная сделка: потолок BAG_MAX_AGE_MS не применяется', () => {
  it('dealFunded=true — потолок НЕ ограничивает, эффективный срок равен запрошенному, сколько угодно дней вперёд', () => {
    const now = Date.now();
    const uploadedAt = now - 5 * DAY;
    const key = put(ALICE, BOB, uploadedAt);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const farDeadline = uploadedAt + 200 * DAY; // далеко за потолком (90д)

    adoptPairBags(pairId, farDeadline, now, true); // funded=true

    const expiry = bagExpiryAt(bagMetaOf(key));
    expect(expiry).toBe(farDeadline); // потолок не сработал вообще
    expect(expiry).toBeGreaterThan(uploadedAt + bagStore.BAG_MAX_AGE_MS); // и правда дальше потолка
  });

  it('dealFunded не передан (или false) — потолок работает как раньше (контроль регрессии)', () => {
    const now = Date.now();
    const uploadedAt = now - 5 * DAY;
    const key = put(ALICE, BOB, uploadedAt);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const farDeadline = uploadedAt + 200 * DAY;

    adoptPairBags(pairId, farDeadline, now); // funded не передан — по умолчанию false

    const expiry = bagExpiryAt(bagMetaOf(key));
    expect(expiry).toBe(uploadedAt + bagStore.BAG_MAX_AGE_MS); // потолок по-прежнему победил
  });

  it('adoptPairBags() возвращает funded=true, когда хотя бы одна затронутая запись стала оплаченной этим вызовом', () => {
    const now = Date.now();
    put(ALICE, BOB, now - 5 * DAY);
    const pairId = _pairIdFromAddresses(ALICE, BOB);

    const result = adoptPairBags(pairId, now + 200 * DAY, now, true);

    expect(result.funded).toBe(true);
  });

  it('adoptPairBags() возвращает funded=false, когда усыновление было неоплаченным', () => {
    const now = Date.now();
    put(ALICE, BOB, now - 5 * DAY);
    const pairId = _pairIdFromAddresses(ALICE, BOB);

    const result = adoptPairBags(pairId, now + 200 * DAY, now, false);

    expect(result.funded).toBe(false);
  });

  it('переход только вперёд: неоплаченная запись (уже усыновлена, потолок применяется) получает fundedAt_ позже — на следующем прогоне становится безлимитной', () => {
    const now = Date.now();
    const uploadedAt = now - 5 * DAY;
    const key = put(ALICE, BOB, uploadedAt);
    const pairId = _pairIdFromAddresses(ALICE, BOB);

    // Ночь 1: сделка зарегистрирована, ещё не оплачена — короткий
    // предварительный срок, потолок применяется.
    adoptPairBags(pairId, uploadedAt + 300 * DAY, now, false);
    const expiryUnfunded = bagExpiryAt(bagMetaOf(key));
    expect(expiryUnfunded).toBe(uploadedAt + bagStore.BAG_MAX_AGE_MS); // потолок ограничил

    // Ночь 2: пришла оплата (fundedAt_ теперь > 0) — тот же вызов, funded=true.
    adoptPairBags(pairId, uploadedAt + 300 * DAY, now, true);
    const expiryFunded = bagExpiryAt(bagMetaOf(key));
    expect(expiryFunded).toBe(uploadedAt + 300 * DAY); // потолок больше не ограничивает
    expect(expiryFunded).toBeGreaterThan(expiryUnfunded); // и это продление, не откат
  });

  it('переход НЕ идёт назад: однажды оплаченная запись остаётся безлимитной, даже если её снова "усыновляют" без флага оплаты (мусор/на всякий случай)', () => {
    const now = Date.now();
    const uploadedAt = now - 5 * DAY;
    const key = put(ALICE, BOB, uploadedAt);
    const pairId = _pairIdFromAddresses(ALICE, BOB);

    adoptPairBags(pairId, uploadedAt + 300 * DAY, now, true); // оплачена
    adoptPairBags(pairId, uploadedAt + 300 * DAY, now, false); // повторный вызов без флага — не должен откатывать

    const expiry = bagExpiryAt(bagMetaOf(key));
    expect(expiry).toBe(uploadedAt + 300 * DAY); // всё ещё безлимитный — статус оплаты не откатился
  });

  it('несколько мешков одной пары — потолок каждого свой (uploadedAt разный), но с оплатой ни один не режется', () => {
    const now = Date.now();
    const uploadedOld = now - 80 * DAY;
    const keyOld = put(ALICE, BOB, uploadedOld); // почти у потолка сейчас
    const keyNew = put(ALICE, BOB, now - 1 * DAY);  // совсем свежий
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const farDeadline = now + 200 * DAY;

    // И-2: гейт первого усыновления смотрит "жив ли мешок ПРЯМО СЕЙЧАС" —
    // keyOld непрочитан и загружен 80 дней назад, его собственный 30-дневный
    // срок (правило 3) уже истёк к моменту now, независимо от оплаты. В
    // реальном потоке это никогда бы не возникло (этап 1 трогает каждую
    // активную сделку КАЖДУЮ ночь с самого начала), так что здесь моделируем
    // то же самое: более раннее усыновление, пока keyOld ещё жив.
    adoptPairBags(pairId, uploadedOld + 1 * DAY, uploadedOld);

    adoptPairBags(pairId, farDeadline, now, true);

    expect(bagExpiryAt(bagMetaOf(keyOld))).toBe(farDeadline);
    expect(bagExpiryAt(bagMetaOf(keyNew))).toBe(farDeadline);
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
  // тест специально ловит перестановку блоков местами. И-2 (пятый
  // закрывающий раунд ревью) заменил гейт ПЕРВОГО усыновления с "моложе 30
  // дней" на "ещё жив" — запись, которая к моменту вызова УЖЕ мертва по
  // своему базовому правилу, первым усыновлением больше не спасается (это
  // и есть смысл находки: "продлеваем то, что есть, а не то, что молодое").
  // Значит, чтобы порядок "усыновление до чистки" всё ещё имел значение,
  // сценарий обязан быть про УЖЕ УСЫНОВЛЁННУЮ запись (гейт живости для неё
  // не действует вовсе, см. докстринг adoptPairBags(), "только продлевать")
  // — реалистичный путь: более раннее усыновление (этап 1, тем же приёмом,
  // каким это происходит в проде) дало короткий предварительный срок, этот
  // срок сам успел истечь к моменту спора, а точный срок этапа 2 успевает
  // переякорить запись РАНЬШЕ, чем до неё в этом же прогоне доберётся
  // cleanupBags().
  it('усыновление успевает спасти в ТОМ ЖЕ прогоне УЖЕ усыновлённый мешок, чей прежний срок истёк ровно к этому прогону (порядок внутри runFileCleanup значим)', async () => {
    const client   = '0x' + '7'.repeat(40);
    const executor = '0x' + '8'.repeat(40);
    const agreement = '0x' + '9'.repeat(40);
    const now = Date.now();
    const disputedAtSec = Math.floor((now - 1 * DAY) / 1000);
    const uploadedAt = now - 25 * DAY;

    const key = put(client, executor, uploadedAt, { firstFetchedAt: uploadedAt });
    const pairId = _pairIdFromAddresses(client, executor);

    // Более раннее усыновление (представляет этап 1 на какую-то из прошлых
    // ночей, пока мешок ещё жив) — намеренно КОРОТКИМ сроком, который сам
    // истекает ДО этого прогона.
    adoptPairBags(pairId, now - 1, uploadedAt);
    // Контроль: прежний срок уже истёк к началу ЭТОГО прогона.
    expect(bagExpiryAt(bagMetaOf(key))).toBeLessThan(now);

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [], // сделка уже спорная — вне getActive(), только getDisputed() ниже
      getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: 0n, resolvedAt: 0n }],
    });
    mockContract(agreement, {
      getDetails: async () => ({ disputedAt_: BigInt(disputedAtSec) }),
      DISPUTE_WINDOW: async () => BigInt(4 * 24 * 60 * 60),
    });

    await runFileCleanup();

    expect(bagMetaOf(key)).toBeDefined(); // пережил ЭТОТ ЖЕ прогон
    expect(bagMetaOf(key).dealDeadline).toBeGreaterThan(now); // переякорен точным сроком этапа 2
  });

  // И-2 (пятый закрывающий раунд ревью, находка координатора, замер): мешок
  // вне СТАРОГО 30-дневного возрастного окна, но ПРОЧИТАННЫЙ недавно —
  // правило 2 (7д от прочтения) само по себе держит его живым дольше 30
  // дней. Старый гейт (по возрасту) отвергал такую запись; новый (по
  // живости) — усыновляет, потому что она физически ещё существует.
  it('спор по паре: мешок вне старого 30-дневного окна, но ещё живой (прочитан недавно) — теперь усыновляется (И-2)', async () => {
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

    // uploadedAt 40 дней назад (за пределами СТАРОГО возрастного окна), но
    // прочитан 5 дней назад — bagExpiryAt = firstFetchedAt+7д = now+2д > now,
    // мешок физически ещё жив на момент вызова.
    const key = put(client, executor, now - 40 * DAY, { firstFetchedAt: now - 5 * DAY });
    expect(bagExpiryAt(bagMetaOf(key))).toBeGreaterThan(now); // контроль: действительно ещё жив

    await runFileCleanup();

    expect(bagMetaOf(key)).toBeDefined();
    expect(bagMetaOf(key).dealDeadline).not.toBeNull(); // усыновлён — раньше не усыновлялся бы
  });

  // Companion-тест: мешок, который И вне старого окна, И уже ДЕЙСТВИТЕЛЬНО
  // мёртв (не просто старый) — по-прежнему не усыновляется, но теперь по
  // ПРАВИЛЬНОЙ причине ("мёртв", а не "старый"). Различие важно: без этого
  // теста мутация, откатывающая И-2 обратно на возрастной гейт, могла бы
  // остаться незамеченной, если бы единственный "не усыновлён" тест этого
  // блока (выше) был просто удалён вместе с находкой.
  it('спор по паре: мешок вне старого 30-дневного окна И уже мёртв по обычному правилу (не прочитан) — не усыновляется, потому что мёртв', async () => {
    const client   = '0x' + '4'.repeat(40);
    const executor = '0x' + '5'.repeat(40);
    const agreement = '0x' + '6'.repeat(40);
    const now = Date.now();
    const disputedAtSec = Math.floor(now / 1000);

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [],
      getDisputed: [{ agreement, client, executor, amount: 0n, status: 3, createdAt: 0n, resolvedAt: 0n }],
    });
    mockContract(agreement, {
      getDetails: async () => ({ disputedAt_: BigInt(disputedAtSec) }),
      DISPUTE_WINDOW: async () => BigInt(4 * 24 * 60 * 60),
    });

    // Непрочитан, 40 дней от загрузки — правило 3 (30д) само по себе уже
    // истекло 10 дней назад, независимо от усыновления.
    const key = put(client, executor, now - 40 * DAY);
    expect(bagExpiryAt(bagMetaOf(key))).toBeLessThan(now); // контроль: действительно уже мёртв

    await runFileCleanup();

    // Не усыновлена (гейт живости отверг её верно) И, раз уж она
    // действительно мертва, а не только "не продлена", обычная cleanupBags()
    // в этом же прогоне сметает её как любую другую просроченную запись —
    // усыновление её не спасает и не обязано спасать.
    expect(bagMetaOf(key)).toBeUndefined();
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

  // Мелочь (третий закрывающий раунд ревью, находка координатора):
  // "падение усыновления не мешает ДРУГИМ вещам" уже заперто (тест выше),
  // но НИЧЕГО не запирало изоляцию МЕЖДУ ЗАПИСЯМИ ОДНОГО И ТОГО ЖЕ
  // getDisputed()/getActive() — снятие внутреннего try в цикле по разным
  // причинам может остановить весь цикл на первой же бракованной записи,
  // и ни один существующий тест этого не поймает (проверено координатором:
  // обе такие мутации выживали при 489 зелёных).
  it('одна бракованная спорная запись не мешает усыновить ДРУГУЮ спорную запись в том же прогоне', async () => {
    const brokenAgreement = '0x' + '1'.repeat(40);
    const goodAgreement = ethAddr(555, '2');
    const goodClient = ethAddr(555, '3');
    const goodExecutor = ethAddr(555, '4');
    const now = Date.now();
    const disputedAtSec = Math.floor((now - 1 * DAY) / 1000);

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [],
      getDisputed: [
        { agreement: brokenAgreement, client: CAROL, executor: ALICE, amount: 0n, status: 3, createdAt: 0n, resolvedAt: 0n },
        { agreement: goodAgreement, client: goodClient, executor: goodExecutor, amount: 0n, status: 3, createdAt: 0n, resolvedAt: BigInt(disputedAtSec) },
      ],
    });
    mockContract(brokenAgreement, {
      getDetails: async () => { throw new Error('execution reverted (симулировано, битый агримент)'); },
      DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
    });
    mockContract(goodAgreement, {
      getDetails: async () => ({ disputedAt_: BigInt(disputedAtSec) }),
      DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
    });

    const goodKey = put(goodClient, goodExecutor, now - 10 * DAY);

    await expect(runFileCleanup()).resolves.toBeUndefined();

    expect(bagMetaOf(goodKey).dealDeadline).not.toBeNull(); // хорошая запись усыновлена, несмотря на битую соседнюю
  });

  it('одна бракованная активная запись не мешает усыновить ДРУГУЮ активную запись в том же прогоне', async () => {
    const brokenAgreement = '0x' + '8'.repeat(40);
    const goodAgreement = ethAddr(556, '2');
    const goodClient = ethAddr(556, '3');
    const goodExecutor = ethAddr(556, '4');
    const now = Date.now();
    const createdAtSec = Math.floor(now / 1000);

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [
        { agreement: brokenAgreement, client: CAROL, executor: ALICE, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n },
        { agreement: goodAgreement, client: goodClient, executor: goodExecutor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n },
      ],
      getDisputed: [],
    });
    mockContract(brokenAgreement, {
      getDetails: async () => { throw new Error('execution reverted (симулировано, битый агримент)'); },
      DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
      DEADLINE_GRACE: async () => 0n,
      AUTO_APPROVE_WINDOW: async () => 0n,
    });
    mockContract(goodAgreement, {
      getDetails: async () => ({ deadlineDays_: 30n, activatedAt_: 0n, disputedAt_: 0n }),
      DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
      DEADLINE_GRACE: async () => 0n,
      AUTO_APPROVE_WINDOW: async () => 0n,
    });

    const goodKey = put(goodClient, goodExecutor, now - 10 * DAY);

    await expect(runFileCleanup()).resolves.toBeUndefined();

    expect(bagMetaOf(goodKey).dealDeadline).not.toBeNull(); // хорошая запись усыновлена, несмотря на битую соседнюю
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

// ─── Решение владельца (раунд после И-1/C-1/И-2): интеграционные тесты
// через настоящий runFileCleanup(), не голый adoptPairBags() — три
// сценария из требования владельца, которые обязательно нужно запереть
// на уровне полного ночного прогона, а не только на уровне функции.
describe('Решение владельца — интеграция через runFileCleanup()', () => {
  // Реальный разрыв, найденный при чтении Agreement.sol: fund() и
  // activate() — разные, неатомарные вызовы (activate() зовёт
  // ИСПОЛНИТЕЛЬ, требует fundedAt != 0). Между ними — status() == FUNDED,
  // деньги уже заперты в эскроу, но деадлайн работы ещё не тикает
  // (activatedAt всё ещё 0). Потолок обязан сняться уже В ЭТОМ ОКНЕ, не
  // дожидаясь activate().
  it('деньги внесены (fundedAt_ > 0), но исполнитель ещё не подтвердил старт (activatedAt_ == 0) — потолок уже не действует', async () => {
    const client    = ethAddr(950, '1');
    const executor  = ethAddr(950, '2');
    const agreement = ethAddr(950, '3');
    const now = Date.now();
    const createdAtSec = Math.floor(now / 1000);

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n }],
      getDisputed: [],
    });
    mockContract(agreement, {
      // FUNDED, не ACTIVE: fundedAt_ > 0, activatedAt_ == 0 — окно
      // ACTIVATION_WINDOW (2 дня в контракте), моделируется здесь как
      // "прямо сейчас", до какой-либо активации.
      getDetails: async () => ({ deadlineDays_: 300n, fundedAt_: BigInt(createdAtSec), activatedAt_: 0n, disputedAt_: 0n }),
      DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
      DEADLINE_GRACE: async () => 0n,
      AUTO_APPROVE_WINDOW: async () => 0n,
    });

    const uploadedAt = now - 5 * DAY;
    const key = put(client, executor, uploadedAt);

    await runFileCleanup();

    const expiry = bagExpiryAt(bagMetaOf(key));
    expect(expiry).toBeGreaterThan(uploadedAt + bagStore.BAG_MAX_AGE_MS); // потолок уже не участвует
  });

  // Требование владельца, п.4: "переход считается только вперёд: сделку
  // оплатили — срок продлевается на следующем же прогоне". Ночь 1:
  // зарегистрирована, НЕ оплачена, короткий срок работы — предварительный
  // срок капается потолком. Ночь 2: пришла оплата — тот же прогон обязан
  // снять потолок и не быть заблокирован ранее выданным коротким сроком.
  it('оплата пришла позже — на следующем прогоне срок продлевается за потолок, ранее выданный короткий срок не мешает', async () => {
    const client    = ethAddr(951, '1');
    const executor  = ethAddr(951, '2');
    const agreement = ethAddr(951, '3');
    const T0 = Date.UTC(2031, 0, 1);
    const createdAtSec = Math.floor(T0 / 1000);

    try {
      vi.setSystemTime(T0);
      mockContract(process.env.DIAMOND_ADDRESS, {
        getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n }],
        getDisputed: [],
      });
      // Ночь 1: НЕ оплачена, срок работы длинный (300д) — потолок реально
      // режет предварительный срок.
      mockContract(agreement, {
        getDetails: async () => ({ deadlineDays_: 300n, fundedAt_: 0n, activatedAt_: 0n, disputedAt_: 0n }),
        DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
        DEADLINE_GRACE: async () => 0n,
        AUTO_APPROVE_WINDOW: async () => 0n,
      });

      const uploadedAt = T0 - 1 * DAY;
      const key = put(client, executor, uploadedAt);

      await runFileCleanup();
      const expiryBeforePayment = bagExpiryAt(bagMetaOf(key));
      expect(expiryBeforePayment).toBe(uploadedAt + bagStore.BAG_MAX_AGE_MS); // потолок реально сработал

      // Ночь 2: оплата пришла.
      vi.setSystemTime(T0 + 1 * DAY);
      mockContract(agreement, {
        getDetails: async () => ({ deadlineDays_: 300n, fundedAt_: BigInt(createdAtSec), activatedAt_: 0n, disputedAt_: 0n }),
        DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
        DEADLINE_GRACE: async () => 0n,
        AUTO_APPROVE_WINDOW: async () => 0n,
      });

      await runFileCleanup();
      const expiryAfterPayment = bagExpiryAt(bagMetaOf(key));
      expect(expiryAfterPayment).toBeGreaterThan(uploadedAt + bagStore.BAG_MAX_AGE_MS); // потолок больше не режет
      expect(expiryAfterPayment).toBeGreaterThan(expiryBeforePayment); // и это продление, не откат
    } finally {
      vi.useRealTimers();
    }
  });

  // Требование владельца, п.4 (пункт про отменённую сделку — решение моё,
  // с обоснованием, см. отчёт): деньги были заморожены — значит участие
  // состоялось, переписку стоит сохранить до конца окна спора. Ночь 1:
  // сделка оплачена и усыновлена (безлимитный срок выставлен). Ночь 2:
  // сделка выпала из registry.getActive() (тем же способом, каким это
  // происходит в реальности — triggerActivationTimeout()/любой другой
  // forward-only путь завершения переводит её в REFUNDED и она
  // ПЕРЕСТАЁТ приходить оттуда навсегда, RegistryFacet.getActive()
  // фильтрует строго по ACTIVE). adoptPairBags() физически не может
  // узнать об отмене (нет вызова, нечего передать) — ранее выданный
  // безлимитный срок должен остаться как есть, не откатиться на потолок.
  it('сделка отменена/выпала из реестра ПОСЛЕ того, как была оплачена — уже выданный безлимитный срок не отзывается (решение: деньги были заморожены — участие состоялось)', async () => {
    const client    = ethAddr(952, '1');
    const executor  = ethAddr(952, '2');
    const agreement = ethAddr(952, '3');
    const T0 = Date.UTC(2031, 2, 1);
    const createdAtSec = Math.floor(T0 / 1000);

    try {
      vi.setSystemTime(T0);
      mockContract(process.env.DIAMOND_ADDRESS, {
        getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n }],
        getDisputed: [],
      });
      mockContract(agreement, {
        getDetails: async () => ({ deadlineDays_: 300n, fundedAt_: BigInt(createdAtSec), activatedAt_: 0n, disputedAt_: 0n }),
        DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
        DEADLINE_GRACE: async () => 0n,
        AUTO_APPROVE_WINDOW: async () => 0n,
      });

      const uploadedAt = T0 - 1 * DAY;
      const key = put(client, executor, uploadedAt);

      await runFileCleanup(); // оплачена, усыновлена безлимитно
      const expiryWhileFunded = bagExpiryAt(bagMetaOf(key));
      expect(expiryWhileFunded).toBeGreaterThan(uploadedAt + bagStore.BAG_MAX_AGE_MS); // потолок снят

      // "Отмена": сделка выпадает из getActive() навсегда (тот же эффект,
      // что и REFUNDED в реестре) — ни getActive(), ни getDisputed() её
      // больше не отдают. Никакого специального кода для этого не нужно —
      // adoptPairBags() просто больше не вызывается для этой пары.
      vi.setSystemTime(T0 + 5 * DAY);
      mockContract(process.env.DIAMOND_ADDRESS, { getActive: [], getDisputed: [] });

      await runFileCleanup();
      const expiryAfterCancel = bagExpiryAt(bagMetaOf(key));
      expect(expiryAfterCancel).toBe(expiryWhileFunded); // не изменился — ни отозван, ни урезан
      expect(expiryAfterCancel).toBeGreaterThan(uploadedAt + bagStore.BAG_MAX_AGE_MS); // потолок по-прежнему не участвует
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── C1 (координатор, критическая находка): освобождение от потолка не
// свойство МЕШКА, а свойство КАЖДОГО ПРОДЛЕНИЯ отдельно. Пара платит ОДИН
// раз — и раньше это освобождало мешок от потолка НАВСЕГДА, даже когда
// продление дальше выдаёт СОВЕРШЕННО ДРУГАЯ, никогда не оплаченная сделка
// той же пары. У зарегистрированной неоплаченной сделки нет выхода из
// активных без оплаты или запуска (все девять путей завершения требуют
// одного из двух) — а taймаут активации возвращает клиенту ВСЮ сумму,
// то есть капитал, "купивший" освобождение, возвращается, остаётся один
// газ. Обоснование решения владельца ("хранение оплачивается чужим
// капиталом") перестаёт быть правдой ровно в момент, когда капитал вернули.
//
// Чинится так: `bagExpiryAt()` больше НЕ хранит и не читает никакого
// per-мешок "оплачен ли когда-либо" флага — решение "резать потолком или
// нет" принимается в adoptPairBags() НА КАЖДОЕ продление отдельно, ДО
// сравнения с текущим значением: кандидат от неоплаченной сделки обрезается
// потолком (Math.min(dealDeadline, ceiling)) ПРЕЖДЕ, чем идёт в Math.max с
// текущим — кандидат от оплаченной идёт в Math.max как есть, без обрезки.
// Правило "только продлевать" остаётся ровно тем же Math.max, просто
// теперь сравнивает УЖЕ ОБРЕЗАННОГО (если нужно) кандидата, а не сырой.
describe('C1 (координатор, критическая находка) — освобождение от потолка не переживает сделку, которая его выдала', () => {
  it('пара оплатила короткую сделку, сделка отменена/завершилась, заведена НИКОГДА не оплаченная — срок не растёт дальше потолка (замер: день 400 и день 1000, координатор)', () => {
    const now = Date.now();
    const uploadedAt = now - 1 * DAY;
    const key = put(ALICE, BOB, uploadedAt);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const ceiling = uploadedAt + bagStore.BAG_MAX_AGE_MS;

    // Сделка A: короткая (условный "конец дела" — 40 дней от загрузки, ЗАВЕДОМО
    // больше обычного 30-дневного правила 3 (непрочитан), чтобы Math.max(base, ...)
    // не маскировал результат — правило "усыновление не сокращает" не при чём
    // в ЭТОМ тесте), ОПЛАЧЕНА. Много меньше потолка (90д) — освобождение здесь
    // пока не заметно само по себе, ключевой момент впереди.
    const dealADeadline = uploadedAt + 40 * DAY;
    adoptPairBags(pairId, dealADeadline, uploadedAt, true); // funded=true
    expect(bagExpiryAt(bagMetaOf(key))).toBe(dealADeadline);

    // Сделка A отменена/завершилась (в проде — выпала из getActive()).
    // Сделка B той же пары: НИКОГДА не оплачена, ежедневный храповик
    // предлагает предварительный срок, растущий вместе с nowMs (тот же
    // класс, что реальная dealDeadlineFromCreation() для неактивированной
    // сделки) — замер на день 400 и день 1000, координаторские точки.
    for (const day of [400, 1000]) {
      const nowMsDay = uploadedAt + day * DAY;
      const candidateB = nowMsDay + 300 * DAY; // "далеко в будущем" — растущий preliminary
      adoptPairBags(pairId, candidateB, nowMsDay, false); // funded=false
      const expiry = bagExpiryAt(bagMetaOf(key));
      expect(expiry).toBe(ceiling); // ровно потолок — НЕ "день 443"/"день 1043"
    }

    // Контроль координатора: тот же мешок БЕЗ первой оплаты вообще — то же
    // самое значение потолка, никакой разницы с историей "была оплата,
    // потом отменили". Первое касание — рано (пока мешок ещё жив по
    // обычному правилу, И-2 иначе отверг бы САМО первое усыновление как
    // мёртвой записи — не то, что здесь проверяется, см. докстринг И-2),
    // тем же приёмом, что уже применяется во всех остальных тестах этого
    // файла с "долгой историей".
    const controlKey = put(ALICE, CAROL, uploadedAt);
    const controlPairId = _pairIdFromAddresses(ALICE, CAROL);
    adoptPairBags(controlPairId, uploadedAt + 2 * DAY, uploadedAt + 1 * DAY, false); // первое (живое) касание
    adoptPairBags(controlPairId, uploadedAt + 1300 * DAY, uploadedAt + 1000 * DAY, false); // много позже, тот же ratchet
    expect(bagExpiryAt(bagMetaOf(controlKey))).toBe(ceiling);
  });

  // Тот же сценарий, но настоящий "храповик" — много последовательных
  // ночей подряд (не только две координаторские точки), доказывает, что
  // срок не ползёт ни на день ни на одной из промежуточных ночей, не
  // только на выбранных контрольных датах.
  it('храповик КАЖДУЮ ночь на протяжении 1000 дней неоплаченной сделкой той же пары — срок стоит на месте с момента первого касания потолка', () => {
    const now = Date.now();
    const uploadedAt = now - 1 * DAY;
    const key = put(ALICE, BOB, uploadedAt);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const ceiling = uploadedAt + bagStore.BAG_MAX_AGE_MS;

    adoptPairBags(pairId, uploadedAt + 14 * DAY, uploadedAt, true); // сделка A, оплачена, отменена дальше

    let touchedCeilingOnDay = null;
    for (let day = 2; day <= 1000; day += 7) { // каждую "неделю" — 1000/7 ≈ 143 реальных вызова, не 1000 ради скорости, поведение идентично: adoptPairBags не хранит состояния кроме meta
      const nowMsDay = uploadedAt + day * DAY;
      adoptPairBags(pairId, nowMsDay + 300 * DAY, nowMsDay, false);
      const expiry = bagExpiryAt(bagMetaOf(key));
      if (expiry === ceiling && touchedCeilingOnDay === null) touchedCeilingOnDay = day;
      // С момента первого касания потолка — НИ ОДНА последующая ночь не
      // должна сдвинуть срок дальше него.
      expect(expiry).toBeLessThanOrEqual(ceiling);
    }
    expect(touchedCeilingOnDay).not.toBeNull(); // потолок реально был достигнут, не просто "случайно не превышен"
    expect(bagExpiryAt(bagMetaOf(key))).toBe(ceiling); // и остался ровно на нём к концу тысячи дней
  });

  it('срок, выданный ОПЛАЧЕННОЙ сделкой, НЕ сокращается последующими неоплаченными попытками — даже когда сама оплаченная сделка была длинной (её dealDeadline больше потолка)', () => {
    const now = Date.now();
    const uploadedAt = now - 1 * DAY;
    const key = put(ALICE, BOB, uploadedAt);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const ceiling = uploadedAt + bagStore.BAG_MAX_AGE_MS;

    // Сделка A: ДЛИННАЯ (200 дней от загрузки — больше потолка в 90),
    // ОПЛАЧЕНА — законно даёт безлимитный срок дальше потолка.
    const dealADeadline = uploadedAt + 200 * DAY;
    adoptPairBags(pairId, dealADeadline, uploadedAt, true);
    expect(bagExpiryAt(bagMetaOf(key))).toBe(dealADeadline);
    expect(dealADeadline).toBeGreaterThan(ceiling); // контроль: действительно больше потолка

    // Сделка B той же пары, НИКОГДА не оплачена, пытается продлить —
    // кандидат обрезается потолком (много меньше уже выданных 200 дней),
    // Math.max с уже выданным dealADeadline его сохраняет как есть.
    adoptPairBags(pairId, uploadedAt + 500 * DAY, uploadedAt + 300 * DAY, false);

    expect(bagExpiryAt(bagMetaOf(key))).toBe(dealADeadline); // не урезан до потолка, не изменился вообще
  });

  it('новая ОПЛАЧЕННАЯ сделка после отменённой/неоплаченной истории — продлевает нормально, без обрезки', () => {
    const now = Date.now();
    const uploadedAt = now - 1 * DAY;
    const key = put(ALICE, BOB, uploadedAt);
    const pairId = _pairIdFromAddresses(ALICE, BOB);
    const ceiling = uploadedAt + bagStore.BAG_MAX_AGE_MS;

    adoptPairBags(pairId, uploadedAt + 14 * DAY, uploadedAt, true); // сделка A, оплачена, отменена
    adoptPairBags(pairId, uploadedAt + 500 * DAY, uploadedAt + 100 * DAY, false); // сделка B, никогда не оплачена
    expect(bagExpiryAt(bagMetaOf(key))).toBe(ceiling); // капнуто потолком, как и должно быть

    // Сделка C той же пары — НОВАЯ, ОПЛАЧЕНА, законно длинная (за потолком).
    const dealCDeadline = uploadedAt + 400 * DAY;
    adoptPairBags(pairId, dealCDeadline, uploadedAt + 150 * DAY, true);

    expect(bagExpiryAt(bagMetaOf(key))).toBe(dealCDeadline); // продлилось нормально, потолок больше не участвует
    expect(dealCDeadline).toBeGreaterThan(ceiling);
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

// ─── C-1 (координатор, четвёртый закрывающий раунд ревью): лог обязан
// называть РЕАЛЬНЫЙ, обрезанный потолком BAG_MAX_AGE_MS срок — не
// запрошенный. Замер координатора: сделка на срок работы вплоть до 365
// дней (контракт/фронт это разрешают) давала лог "extended 1 bag(s) ... to
// 2030-01-23 (preliminary)" (378 дней вперёд), хотя мешок реально жил 90
// дней — и ни слова о расхождении. adoptPairBags() теперь возвращает
// { adopted, requested, minEffectiveExpiry, cappedCount } вместо голого
// числа именно ради этого (bagStore.js), а logAdoptionResult() в app.js
// обязана логировать minEffectiveExpiry, не requested, и явно
// предупреждать при cappedCount > 0.
describe('C-1 — лог сообщает РЕАЛЬНЫЙ (обрезанный потолком) срок, а не запрошенный', () => {
  it('потолок НЕ режет (короткая сделка) — лог называет РАВНЫЙ запрошенному срок, предупреждения нет', async () => {
    const client    = ethAddr(910, 'a');
    const executor  = ethAddr(910, 'b');
    const agreement = ethAddr(910, 'c');
    const now = Date.now();
    const createdAtSec = Math.floor(now / 1000);

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n }],
      getDisputed: [],
    });
    mockContract(agreement, {
      // 60 дней — достаточно длинная сделка, чтобы запрошенный срок (60д +
      // хвост ≈ 70д) ПЕРЕКРЫВАЛ обычный необсуждённый srok (30д, правило 3
      // bagExpiryAt) — иначе Math.max(base, ...) внутри bagExpiryAt взял бы
      // BASE, а не dealDeadline, и тест путал бы это правило ("усыновление
      // не сокращает") с проверкой потолка, которая здесь не в фокусе.
      // При этом 70д всё ещё далеко от потолка BAG_MAX_AGE_MS (90д).
      getDetails: async () => ({ deadlineDays_: 60n, activatedAt_: 0n, disputedAt_: 0n }),
      DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
      DEADLINE_GRACE: async () => 0n,
      AUTO_APPROVE_WINDOW: async () => 0n,
    });

    const key = put(client, executor, now);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runFileCleanup();

    const requested = bagMetaOf(key).dealDeadline;
    const successLine = logSpy.mock.calls.find(args => String(args[0]).includes('[bags] adoption (creation)') && String(args[0]).includes('extended'));
    expect(successLine).toBeDefined();
    expect(String(successLine[0])).toContain(new Date(requested).toISOString()); // лог называет РЕАЛЬНЫЙ срок — здесь он равен запрошенному
    const capWarning = warnSpy.mock.calls.find(args => String(args[0]).includes('ceiling cut'));
    expect(capWarning).toBeUndefined(); // потолок ничего не резал — предупреждения быть не должно
  });

  it('потолок РЕЖЕТ (длинная сделка, до 365 дней разрешено контрактом/фронтом) — лог называет ОБРЕЗАННЫЙ срок и печатает предупреждение с обоими числами', async () => {
    const client    = ethAddr(911, 'a');
    const executor  = ethAddr(911, 'b');
    const agreement = ethAddr(911, 'c');
    const now = Date.now();
    const createdAtSec = Math.floor(now / 1000);

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(createdAtSec), resolvedAt: 0n }],
      getDisputed: [],
    });
    mockContract(agreement, {
      // 365 дней — контрактный/фронтовый максимум (JobBoardFacet.sol:213,
      // ServiceBoardFacet.sol:218, frontend/src/config/constants.ts:30);
      // предварительный срок этапа 1 (365д+хвост) намного больше потолка
      // BAG_MAX_AGE_MS (90д от загрузки).
      getDetails: async () => ({ deadlineDays_: 365n, activatedAt_: 0n, disputedAt_: 0n }),
      DISPUTE_WINDOW: async () => 4n * 24n * 60n * 60n,
      DEADLINE_GRACE: async () => 0n,
      AUTO_APPROVE_WINDOW: async () => 0n,
    });

    const uploadedAt = now;
    const key = put(client, executor, uploadedAt);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runFileCleanup();

    // C1 (координатор, критическая находка): meta.dealDeadline теперь САМ
    // уже обрезан потолком (капается в adoptPairBags(), ДО записи в meta —
    // см. её докстринг) — читать "requested" оттуда больше нельзя, это
    // теперь то же самое число, что и realExpiry. Источник правды на
    // "что было запрошено" — сама предупреждающая строка лога (она несёт
    // "wanted X" отдельно, извлечённая из ВОЗВРАЩЁННОГО adoptPairBags()
    // requested, который остаётся сырым — см. её докстринг).
    const realExpiry = bagExpiryAt(bagMetaOf(key));
    expect(realExpiry).toBe(uploadedAt + bagStore.BAG_MAX_AGE_MS); // потолок реально сработал

    const successLine = logSpy.mock.calls.find(args => String(args[0]).includes('[bags] adoption (creation)') && String(args[0]).includes('extended'));
    expect(successLine).toBeDefined();
    expect(String(successLine[0])).toContain(new Date(realExpiry).toISOString()); // лог называет РЕАЛЬНЫЙ (обрезанный) срок

    const capWarning = warnSpy.mock.calls.find(args => String(args[0]).includes('ceiling cut'));
    expect(capWarning).toBeDefined(); // и явное предупреждение о том, что потолок обрезал
    const wantedMatch = String(capWarning[0]).match(/wanted (\S+), gave (\S+) instead/);
    expect(wantedMatch).toBeDefined();
    const wantedIso = wantedMatch[1];
    const gaveIso = wantedMatch[2];
    expect(gaveIso).toBe(new Date(realExpiry).toISOString()); // "дали" совпадает с реальным сроком
    expect(new Date(wantedIso).getTime()).toBeGreaterThan(realExpiry); // "хотели" — больше реального (иначе не было бы обрезки)
    expect(String(successLine[0])).not.toContain(wantedIso); // строка успеха не называет ЗАПРОШЕННЫЙ срок (координатор: было наоборот)
    expect(String(capWarning[0])).toContain(new Date(realExpiry).toISOString()); // дали — со своим числом
  });
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

  // Мелочь (третий закрывающий раунд ревью, находка координатора):
  // "ревертнувший вызов не отравляет кэш" раньше проверялась только чтением
  // кода (cache.set() стоит ПОСЛЕ await, не до) — без теста мутация,
  // кладущая значение в кэш ДО ожидания (а не после), выживала бы молча.
  // Первый вызов DISPUTE_WINDOW() ревертит (симулирует старый несовместимый
  // клон/временный сбой RPC), второй — тем же агриментом — успевает и
  // отдаёт настоящее число: усыновление обязано состояться на ВТОРОМ
  // прогоне с правильным значением, не остаться отравленным первым отказом.
  it('ревертнувший вызов DISPUTE_WINDOW() не отравляет кэш — следующий прогон честно перечитывает с цепи', async () => {
    const client    = ethAddr(3, '7');
    const executor  = ethAddr(3, '8');
    const agreement = ethAddr(3, '9');
    const now = Date.now();
    let disputeWindowCalls = 0;
    const realDisputeWindowSec = 4 * 24 * 60 * 60;

    mockContract(process.env.DIAMOND_ADDRESS, {
      getActive: [{ agreement, client, executor, amount: 0n, status: 0, createdAt: BigInt(Math.floor(now / 1000)), resolvedAt: 0n }],
      getDisputed: [],
    });
    mockContract(agreement, {
      getDetails: async () => ({ deadlineDays_: 30n, activatedAt_: 0n, disputedAt_: 0n }),
      DEADLINE_GRACE: async () => 0n,
      AUTO_APPROVE_WINDOW: async () => 0n,
      DISPUTE_WINDOW: () => {
        disputeWindowCalls++;
        throw new Error('execution reverted (симулированный первый отказ)');
      },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const key = put(client, executor, now - 5 * DAY);

    await runFileCleanup(); // первый прогон — DISPUTE_WINDOW() ревертит, усыновления нет

    expect(bagMetaOf(key).dealDeadline).toBeNull(); // не усыновлён — первая попытка провалилась
    expect(disputeWindowCalls).toBe(1);

    // Второй прогон — тот же агримент, но теперь DISPUTE_WINDOW() успевает.
    mockContract(agreement, {
      getDetails: async () => ({ deadlineDays_: 30n, activatedAt_: 0n, disputedAt_: 0n }),
      DEADLINE_GRACE: async () => 0n,
      AUTO_APPROVE_WINDOW: async () => 0n,
      DISPUTE_WINDOW: () => {
        disputeWindowCalls++;
        return BigInt(realDisputeWindowSec);
      },
    });

    await runFileCleanup();

    // Если бы отказ отравил кэш (значение положено ДО await, а не после),
    // здесь либо усыновления бы не случилось вовсе, либо оно случилось бы
    // с "отравленным" (не настоящим) значением — dealDeadline остался бы
    // null или неправильным числом.
    expect(bagMetaOf(key).dealDeadline).not.toBeNull();
    expect(disputeWindowCalls).toBe(2); // честно перечитал с цепи, не взял отравленное значение из кэша
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
  uploadedAt, firstFetchedAt, disputeAfterDays, funded = false,
}) {
  const disputeWindowSec = 4 * 24 * 60 * 60;
  const deadlineGraceSec = 24 * 60 * 60;       // Agreement.DEADLINE_GRACE — 1 день
  const autoApproveWindowSec = 2 * 24 * 60 * 60; // Agreement.AUTO_APPROVE_WINDOW — 2 дня
  const createdAtSec = Math.floor(T0 / 1000);
  // Решение владельца: funded управляет ТОЛЬКО fundedAt_ (деньги в эскроу,
  // с T0 — оплата пришла сразу при регистрации, реалистичный частый случай)
  // — НЕЗАВИСИМО от paymentDelayDays, который по-прежнему двигает ТОЛЬКО
  // activatedAt_ (исполнитель подтверждает старт отдельным вызовом, может
  // задержаться). Это как раз и воспроизводит реальный разрыв
  // FUNDED-но-не-ACTIVE, который нашёлся при чтении Agreement.sol:
  // деньги уже заперты (funded=true с первого дня), а якорь предварительного
  // срока всё ещё растёт вместе с nowMs, пока activatedAt_ не наступит.
  const fundedAtSec = funded ? createdAtSec : 0;

  // Мок агримента ставится ОДИН раз для "неактивированного" состояния и
  // переиспользуется на каждом "скучном" дне — DEADLINE_GRACE/AUTO_APPROVE_WINDOW
  // обязаны быть замоканы (app.js читает их теперь тоже), иначе adoptActivePairBags()
  // молча падает в catch на каждую ночь, и усыновление не срабатывает вовсе
  // (проверено вживую при первой версии этого хелпера — без этих двух моков
  // и unread-, и read-сценарии откатывались к голым базовым правилам
  // bagExpiryAt, маскируя вообще всякий эффект фикса I-B).
  const notActivatedGetDetails = async () => ({ deadlineDays_: BigInt(ownDeadlineDays), fundedAt_: BigInt(fundedAtSec), activatedAt_: 0n, disputedAt_: 0n });
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
      getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), fundedAt_: BigInt(fundedAtSec), activatedAt_: BigInt(activatedAtSec), disputedAt_: 0n }),
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
    getDetails: async () => ({ deadlineDays_: BigInt(ownDeadlineDays), fundedAt_: BigInt(fundedAtSec), activatedAt_: BigInt(activatedAtSec), disputedAt_: BigInt(disputedAtSec) }),
    DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
  });
  await runFileCleanup();

  if (!bagMetaOf(key)) return { survived: false, diedOnDay: disputeDayOffset };

  // И-1 (координатор, четвёртый закрывающий раунд ревью, замер): критерий
  // приёмки раньше был "запись существует в момент ОБНАРУЖЕНИЯ спора" — а
  // требование задачи (§6 спеки, формула этапа 2 с FINALIZE_DELAY, И2) это
  // "доживает до КОНЦА ОКНА АПЕЛЛЯЦИИ", не до самого спора. Координатор дал
  // три конкретных контрпримера на боевых умолчаниях (own=10/delay=71,
  // own=10/delay=79, own=30/delay=55+прочитан), где мешок переживает
  // ОБНАРУЖЕНИЕ спора, но умирает ДО истинного конца апелляции — старый
  // критерий эти дыры не видел вообще. dealDeadline записи после этого
  // прогона — уже фиксированное число (дальше в этом хелпере больше нет
  // прогонов, которые могли бы его снова подвинуть), так что сравнить
  // ИТОГОВЫЙ bagExpiryAt с истинным концом апелляции достаточно один раз,
  // без досимуляции дней до самого конца.
  //
  // Мелочь (найдено при перемере под "решением владельца"): считать
  // expectedEndOfAppealMs от disputedAtMs (полная миллисекундная точность
  // JS-числа) — не то же самое, что реально прошло через систему.
  // Настоящий Agreement.getDetails().disputedAt_ — block.timestamp, ЦЕЛЫЕ
  // СЕКУНДЫ; adoptDisputedPairBags() (app.js) восстанавливает disputedAtMs
  // как Number(details.disputedAt_) * 1000 — то есть ОБРЕЗАННЫЙ до секунды.
  // T0 в этих тестах намеренно содержит миллисекундный джиттер
  // (T0 = Date.UTC(...) + paymentDelayDays — ради уникальности каждой
  // it.each-итерации), и этот джиттер протекает в disputedAtMs. Сравнение
  // "в лоб" с необрезанным disputedAtMs искусственно давало на
  // paymentDelayDays миллисекунд БОЛЬШЕ, чем система реально способна
  // посчитать (у настоящей цепи miллисекунд не существует вообще) —
  // ложная, тестовая "дыра" на пару миллисекунд, а не настоящая. Обрезаем
  // здесь тем же способом, каким это делает app.js, чтобы сравнивать
  // сравнимое.
  const disputedAtMsFromChain = disputedAtSec * 1000;
  const expectedEndOfAppealMs = bagStore.dealDeadlineFromDispute(disputedAtMsFromChain, disputeWindowSec * 1000);
  const actualExpiry = bagExpiryAt(bagMetaOf(key));
  if (actualExpiry < expectedEndOfAppealMs) {
    return {
      survived: false,
      diedOnDay: null,
      diesBeforeAppealEnd: true,
      shortfallDays: (expectedEndOfAppealMs - actualExpiry) / DAY,
    };
  }
  return { survived: true, diedOnDay: null };
}

// И-1 (координатор, четвёртый закрывающий раунд ревью): обе таблицы ниже
// раньше проверяли "запись существует В МОМЕНТ ОБНАРУЖЕНИЯ спора" — а
// требование задачи (формула этапа 2 с FINALIZE_DELAY, находка I2) это
// "доживает до КОНЦА ОКНА АПЕЛЛЯЦИИ". simulateDailyProtection() выше уже
// исправлена (сравнивает bagExpiryAt после дня спора с реальным концом
// апелляции, dealDeadlineFromDispute()). Перемер под новым критерием на
// боевых умолчаниях (DISPUTE_WINDOW=4д, FINALIZE_DELAY=1д,
// APPEAL_REVIEW_WINDOW=4д, BAG_DEAL_GRACE_MS=1д, BAG_MAX_AGE_MS=90д)
// подтвердил РОВНО то, что дал координатор: own=10/delay=71 и
// own=30/delay=55(прочитан) действительно красные — настоящие, ранее не
// увиденные дыры, не новые регрессии. Причина в ОБОИХ случаях одна и та
// же — потолок BAG_MAX_AGE_MS (90 дней от ЗАГРУЗКИ мешка, не от начала
// сделки): чем позже активация/спор относительно даты загрузки мешка с
// брифом, тем меньше запаса у потолка остаётся на само окно апелляции.
// Ниже — ДВЕ группы it.each на каждую таблицу: "живёт" (сценарии, где
// потолка хватает — были в старой таблице и остаются зелёными) и "дыра"
// (новые строки, показывающие ИМЕННО находку И-1 — сценарии, где мешок
// переживает ОБНАРУЖЕНИЕ спора, но не доживает до конца апелляции; замер
// честный, "дыра" здесь означает не баг в этом раунде, а ПРЕДСУЩЕСТВОВАВШЕЕ
// ограничение потолка, которое старый, неверный критерий просто не видел).
// Решение про сам потолок (двигать ли BAG_MAX_AGE_MS) — отдельно у
// владельца, не в этой задаче; C-1 (см. app.js/bagStore.js) делает это
// ограничение ВИДИМЫМ в логе, а не устраняет его.

// Таблица 1 координатора: непрочитанный мешок, сделка с 10-дневным сроком
// работы. Спор — через сутки после реального дедлайна работы
// (activatedAt + deadlineDays + 1д). Граница под честным критерием —
// РОВНО между задержкой 69 (живёт) и 70 (падает на день раньше конца
// апелляции) — измерено, не рассуждение.
describe('I-B, таблица 1 (координатор): непрочитанный мешок — защита при любой задержке оплаты', () => {
  it.each([0, 2, 5, 7, 8, 10, 20, 25, 28, 29, 30, 31, 40, 60, 69])(
    'задержка оплаты %d дней — мешок доживает до КОНЦА АПЕЛЛЯЦИИ (не только до спора)',
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

// И-1, таблица 1 — ДЫРА (координатор, замер): те же условия, задержка ЗА
// границей 69. own=10/delay=71 — ровно один из трёх контрпримеров
// координатора. Мешок переживает обнаружение спора (иначе тест ниже не
// отличал бы эту дыру от уже известного и отдельно проверенного потолка,
// см. describe "не отменяет потолок" ниже) — но не доживает до истинного
// конца апелляции: shortfallDays > 0 доказывает именно это, а не что
// запись пропала совсем.
describe('И-1, таблица 1 — ДЫРА (координатор): мешок переживает обнаружение спора, но не доживает до конца апелляции', () => {
  it.each([70, 71, 75])(
    'задержка оплаты %d дней — потолок BAG_MAX_AGE_MS не даёт дожить до конца апелляции (замер, не рассуждение)',
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
        expect(r.survived).toBe(false);
        expect(r.diesBeforeAppealEnd).toBe(true); // не "пропала совсем" — именно не дожила до конца апелляции
        expect(r.shortfallDays).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

// Решение владельца: ПЕРЕМЕР таблицы 1 целиком под ОПЛАЧЕННОЙ сделкой —
// объединяет ОБА списка выше (зелёные строки координатора + ДЫРА-строки
// И-1) в один it.each. Требование владельца дословно: "обе таблицы,
// которые ты только что перемерил, по оплаченным сделкам обязаны стать
// зелёными во всех строках, включая те, что сейчас красные из-за
// потолка" — это и есть доказательство, что дыра закрыта, не рассуждение.
//
// Мелочь (координатор): заголовок "задержка оплаты" здесь не описывает
// фикстуру — funded:true означает, что fundedAt_ (деньги в эскроу)
// выставлена с НУЛЕВОГО дня; paymentDelayDays двигает ТОЛЬКО activatedAt_
// (исполнитель подтверждает старт отдельным, более поздним вызовом — см.
// докстринг simulateDailyProtection()). На выводы это не влияет (обе
// модели — "оплачено сразу, активация задержана" и "оплата задержана
// вместе с активацией" — перемерены и дают тот же результат), но
// правильное название — "задержка АКТИВАЦИИ".
describe('Решение владельца — таблица 1, ОПЛАЧЕНО с нулевого дня, задержана только активация: потолок BAG_MAX_AGE_MS не режет ни одну строку, включая бывшие ДЫРА', () => {
  it.each([0, 2, 5, 7, 8, 10, 20, 25, 28, 29, 30, 31, 40, 60, 69, 70, 71, 75])(
    'задержка АКТИВАЦИИ %d дней (оплачена с нулевого дня) — мешок доживает до конца апелляции (потолок не участвует)',
    async (paymentDelayDays) => {
      const T0 = Date.UTC(2030, 0, 1) + paymentDelayDays;
      try {
        const r = await simulateDailyProtection({
          client: ethAddr(paymentDelayDays, 'a'),
          executor: ethAddr(paymentDelayDays, 'b'),
          agreement: ethAddr(paymentDelayDays, 'c'),
          T0, ownDeadlineDays: 10, paymentDelayDays,
          uploadedAt: T0, firstFetchedAt: null, disputeAfterDays: 1, funded: true,
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
// те, на которых координатор нашёл поломку ДО фикса I-B (14/18/25/30 дней
// для сроков работы 3/7/14/30), плюс запас сверху, доказывающий, что дело
// не в частном совпадении чисел. Границы под честным (И-1) критерием на
// боевых умолчаниях, измерено: own=3 → 76/77, own=7 → 72/73,
// own=14 → 65/66, own=30 → 49/50.
describe('I-B, таблица 2 (координатор): прочитанный мешок + короткая сделка — защита при задержке, на которой раньше ломалось', () => {
  it.each([
    [3, 14],  [3, 20],
    [7, 18],  [7, 25],
    [14, 25], [14, 32],
    [30, 30], [30, 40],
  ])(
    'срок работы %d дней, задержка оплаты %d дней (координатор: до фикса здесь уже не работало) — мешок доживает до КОНЦА АПЕЛЛЯЦИИ',
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

// И-1, таблица 2 — ДЫРА (координатор, замер): own=30/delay=55(прочитан) —
// второй из трёх контрпримеров координатора, воспроизведён буквально.
// Плюс по одной строке сразу за границей для остальных трёх сроков работы
// — тот же механизм, не частное совпадение чисел для одного own.
describe('И-1, таблица 2 — ДЫРА (координатор): мешок переживает обнаружение спора, но не доживает до конца апелляции', () => {
  it.each([
    [3, 77], [7, 73], [14, 66], [30, 50], [30, 55],
  ])(
    'срок работы %d дней, задержка оплаты %d дней — потолок BAG_MAX_AGE_MS не даёт дожить до конца апелляции (замер, не рассуждение)',
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
        expect(r.survived).toBe(false);
        expect(r.diesBeforeAppealEnd).toBe(true);
        expect(r.shortfallDays).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

// Решение владельца: ПЕРЕМЕР таблицы 2 целиком под ОПЛАЧЕННОЙ сделкой —
// та же логика, что у таблицы 1 выше. Мелочь (координатор) про заголовок
// "задержка оплаты" — та же, см. комментарий там: funded:true = оплачена
// с нулевого дня, задерживается только activatedAt_.
describe('Решение владельца — таблица 2, ОПЛАЧЕНО с нулевого дня, задержана только активация: потолок BAG_MAX_AGE_MS не режет ни одну строку, включая бывшие ДЫРА', () => {
  it.each([
    [3, 14],  [3, 20],  [3, 77],
    [7, 18],  [7, 25],  [7, 73],
    [14, 25], [14, 32], [14, 66],
    [30, 30], [30, 40], [30, 50], [30, 55],
  ])(
    'срок работы %d дней, задержка АКТИВАЦИИ %d дней (оплачена с нулевого дня) — мешок доживает до конца апелляции (потолок не участвует)',
    async (ownDeadlineDays, paymentDelayDays) => {
      const T0 = Date.UTC(2030, 3, 1) + ownDeadlineDays * 100 + paymentDelayDays;
      try {
        const r = await simulateDailyProtection({
          client: ethAddr(ownDeadlineDays * 1000 + paymentDelayDays, 'd'),
          executor: ethAddr(ownDeadlineDays * 1000 + paymentDelayDays, 'e'),
          agreement: ethAddr(ownDeadlineDays * 1000 + paymentDelayDays, 'f'),
          T0, ownDeadlineDays, paymentDelayDays,
          uploadedAt: T0, firstFetchedAt: T0, disputeAfterDays: 1, funded: true,
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
// равно побеждает — НО ТОЛЬКО пока сделка НЕ оплачена (решение владельца).
// Контроль, что фикс I-B не сломал эту, отдельную границу (тот же сценарий,
// что дал day90 в первой версии этого раунда — задержка 60д + срок работы
// 30д + сутки запаса = 91д, за пределами потолка).
describe('I-B не отменяет потолок BAG_MAX_AGE_MS — контроль', () => {
  it('НЕОПЛАЧЕНА: задержка + срок работы физически превышают 90 дней от загрузки — потолок всё равно побеждает, мешок не переживает его', async () => {
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

  // Требование владельца, дословно: "неоплаченная сделка на 365 дней
  // по-прежнему упирается в 90 — потолок не должен исчезнуть вместе с
  // решением". Контракт и фронт разрешают срок работы до 365 дней
  // (JobBoardFacet.sol:213/ServiceBoardFacet.sol:218/
  // frontend/src/config/constants.ts:30) — тот же пример, что дал
  // координатор в C-1, теперь явно проверенный именно как "мусор с цепи
  // vs решение про потолок" — это ДВЕ разные вещи, и правка одной не
  // должна тихо задеть другую.
  it('НЕОПЛАЧЕНА, срок работы 365 дней (легальный контрактный максимум) — потолок всё равно побеждает', async () => {
    const T0 = Date.UTC(2029, 8, 1);
    try {
      const r = await simulateDailyProtection({
        client: ethAddr(888, '1'), executor: ethAddr(888, '2'), agreement: ethAddr(888, '3'),
        T0, ownDeadlineDays: 365, paymentDelayDays: 0, uploadedAt: T0, firstFetchedAt: null, disputeAfterDays: 1,
      });
      expect(r.survived).toBe(false);
      expect(r.diedOnDay).toBe(90); // тот же потолок, тот же день — решение про оплату его не тронуло
    } finally {
      vi.useRealTimers();
    }
  });

  // Зеркальный тест той же самой геометрии (60д задержка + 30д срок
  // работы = 91д, ровно то, что убивает мешок выше), но ОПЛАЧЕНО — и
  // теперь доживает: доказывает, что ИМЕННО оплата, а не что-то ещё,
  // снимает потолок именно в этой граничной точке.
  it('ОПЛАЧЕНА: та же геометрия (91д > 90д), что убивала мешок выше — теперь доживает', async () => {
    const T0 = Date.UTC(2029, 6, 1) + 1000;
    try {
      const r = await simulateDailyProtection({
        client: ethAddr(778, '7'), executor: ethAddr(778, '8'), agreement: ethAddr(778, '9'),
        T0, ownDeadlineDays: 30, paymentDelayDays: 60, uploadedAt: T0, firstFetchedAt: null, disputeAfterDays: 1, funded: true,
      });
      expect(r).toEqual({ survived: true, diedOnDay: null });
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
