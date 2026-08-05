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
  bagKeyFor, recordBag, bagMetaOf, bagExpiryAt,
  adoptPairBags, dealDeadlineFromDispute,
  _loadBagMeta, _pairIdFromAddresses,
} = bagStore;

// app.js — тем же приёмом, что test/bagStore.test.js:46 (координатор уже
// разрешил этот импорт прямо в тест склада): нужен для интеграционного
// теста runFileCleanup()/adoptDisputedPairBags(), а окружение (мокнутый
// ethers, обязательные env) уже поднято общим setupFile test/setup.js.
const { app, runFileCleanup } = await import('../app.js');
const { mockContract } = await import('./mocks/ethersRegistry.js');

const ALICE = '0xa1ce00000000000000000000000000000000cafe';
const BOB   = '0xb0b1000000000000000000000000000000005eed';
const CAROL = '0xca401000000000000000000000000000000005ee';
const DAY   = 24 * 60 * 60 * 1000;

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
    expect(dd).toBe(verdictOnlyDeadline + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS);
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
      + bagStore.APPEAL_REVIEW_WINDOW_DAYS * DAY + bagStore.BAG_DEAL_GRACE_MS;
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
