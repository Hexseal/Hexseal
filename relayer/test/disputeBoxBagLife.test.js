import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

// Задача 2 (4в-2): жизнь мешков ЯЩИКА СПОРА. Тот же приём файла, что в
// test/bagAdoption.test.js: свой временный STORAGE_DIR, выставленный ДО
// первого импорта bagStore.js (живая ES-привязка на `export let`, а не
// снимок — см. заголовок test/bagStore.test.js, И-2/И-3 про ту же ловушку).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-box-life-'));
process.env.STORAGE_DIR = TMP;

const bagStore = await import('../bagStore.js');
const {
  bagKeyFor, recordBag, markFetched, bagMetaOf, bagExpiryAt,
  adoptPairBags, adoptDealBags, disputeBoxBagDeadline, dealDeadlineFromDispute,
  _loadBagMeta, _pairIdFromAddresses,
} = bagStore;

const { app, runFileCleanup } = await import('../app.js');
const { mockContract } = await import('./mocks/ethersRegistry.js');
const { issueBagPass } = await import('../bagPass.js');

const DAY  = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const CLIENT   = '0x' + 'c1'.repeat(20);
const EXECUTOR = '0x' + 'e2'.repeat(20);
const ARBITER  = '0x' + 'ab'.repeat(20);

// Каждый запрос со своим CF-Connecting-IP (TRUST_PROXY=true в test/setup.js) —
// иначе тесты делят IP-половину бюджета и краснеют по чужой причине. Тот же
// приём, что в test/bagRoutes.test.js.
let _ipCounter = 0;
function freshIp() {
  _ipCounter++;
  return `10.${(_ipCounter >> 16) & 255}.${(_ipCounter >> 8) & 255}.${_ipCounter & 255}`;
}

// ⚠️ Кэш DISPUTE_WINDOW в app.js живёт ПО АДРЕСУ АГРИМЕНТА и переживает
// runFileCleanup() (заперто соседним файлом: «DISPUTE_WINDOW() читается один
// раз на агримент, не на каждый ночной прогон заново»). Значит два теста с
// разным окном спора ОБЯЗАНЫ брать разные адреса сделки — иначе второй
// получит окно первого и позеленеет/покраснеет по чужой причине. Буквы в
// адресе — намеренно: тест регистра (Т7) требует, чтобы toUpperCase() менял
// строку.
let _dealSeq = 0;
function freshDeal() {
  _dealSeq++;
  return '0x' + 'd'.repeat(8) + _dealSeq.toString(16).padStart(32, '0');
}

/**
 * Мешок ЯЩИКА на складе, минуя маршрут: ключ ящика — «<адрес сделки>/…»,
 * получатель тот же адрес сделки (ящик опознаётся сделкой, а не человеком).
 * Ровно так это делает маршрут Задачи 1: `bagKeyFor(agreement)` и
 * `recordBag({ …, recipient: agreement, deal: agreement, sealedFor })`.
 * ⚠️ Если её код разошёлся с этим — поправить ЗДЕСЬ и только здесь: весь
 * отбор ниже идёт по meta.deal, а не по получателю.
 */
function putBoxBag(deal, sender, uploadedAt, extra = {}) {
  const key = bagKeyFor(deal);
  const fp = path.join(bagStore.DIR_BAGS, key);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, Buffer.from('sealed-presentation'));
  const t = new Date(uploadedAt);
  fs.utimesSync(fp, t, t);
  recordBag({ key, sender, recipient: deal, size: 19, uploadedAt, deal, ...extra }, uploadedAt);
  return { key, fp };
}

/** Обычный мешок переписки — без сделки. Контроль «отбор не хватает лишнего». */
function putPairBag(recipient, sender, uploadedAt) {
  const key = bagKeyFor(recipient);
  const fp = path.join(bagStore.DIR_BAGS, key);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, Buffer.from('chat'));
  recordBag({ key, sender, recipient, size: 4, uploadedAt }, uploadedAt);
  return key;
}

/** Запись без файла — только для замера цены отбора (Т24): отбор файлов не читает. */
function recordOnly(recipient, sender, uploadedAt, extra = {}) {
  const key = bagKeyFor(recipient);
  recordBag({ key, sender, recipient, size: 1, uploadedAt, ...extra }, uploadedAt);
  return key;
}

/**
 * Цепь: сделка в споре (или уже нет). Поля getDetails() — объектом с
 * именованными полями, ровно как в test/bagAdoption.test.js.
 * ⚠️ Набор полей обязан удовлетворять замок Задачи 1 (она читает getRecord и
 * status_). Если PUT ниже отвечает не 200 — чинить ЭТОТ мок под её замок, а
 * не ожидание в тесте.
 */
function mockChain({
  deal, disputedAtMs, disputed = true, disputeWindowSec = 4 * 24 * 60 * 60,
  fundedAtMs = null, client = CLIENT, executor = EXECUTOR,
}) {
  const funded = fundedAtMs === null ? disputedAtMs - DAY : fundedAtMs;
  const record = {
    agreement: deal, client, executor, amount: 0n,
    status: 3, createdAt: 0n, resolvedAt: 0n,
  };
  mockContract(process.env.DIAMOND_ADDRESS, {
    getActive: [],
    getDisputed: disputed ? [record] : [],
    getRecord: async () => record,
    getDisputeClaimer: async () => ARBITER,
  });
  mockContract(deal, {
    getDetails: async () => ({
      client_: client, executor_: executor, arbiter_: process.env.DIAMOND_ADDRESS,
      amount_: 0n, terms_: '', deadlineDays_: 0n,
      fundedAt_: BigInt(Math.max(0, Math.floor(funded / 1000))),
      activatedAt_: 0n, markedDoneAt_: 0n,
      disputedAt_: BigInt(Math.floor(disputedAtMs / 1000)),
      resolvedAt_: 0n, status_: 4,
    }),
    status: async () => 4,
    DISPUTE_WINDOW: async () => BigInt(disputeWindowSec),
    DEADLINE_GRACE: async () => 0n,
    AUTO_APPROVE_WINDOW: async () => 0n,
  });
}

function putIntoBox({ deal, sender, body = Buffer.from('sealed-presentation'), ip }) {
  const pass = issueBagPass(sender, Math.floor(Date.now() / 1000)).token;
  return request(app)
    .put(`/disputes/${deal}/bags`)
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-bag-pass', pass)
    .set('x-sealed-for', ARBITER)
    .set('Content-Type', 'application/octet-stream')
    .send(body);
}

/** Ночь: гасим болтовню уборки, чтобы вывод теста читался. */
async function night() {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await runFileCleanup();
  } finally {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  }
}

beforeEach(() => {
  fs.rmSync(bagStore.DIR_BAGS, { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'bag-meta.json'), { force: true });
  fs.rmSync(path.join(TMP, 'bag-meta.log'), { force: true });
  _loadBagMeta();
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── А. Формула срока ───────────────────────────────────────────────────────

describe('срок мешка ящика — формула', () => {
  it('Т1 считает от МОМЕНТА ВЫЗОВА и даёт ровно десять суток хвоста на боевых умолчаниях', () => {
    const anchor = 1_700_000_000_000;
    // Ожидаемое написано РУКАМИ, не взято из проверяемого модуля:
    // 4д окно спора + 24ч до апелляции + 4д апелляция + 24ч запас = 10 суток.
    expect(disputeBoxBagDeadline(anchor, 4 * DAY) - anchor).toBe(10 * DAY);
    // Контроль умолчания, на котором держится число выше: если запас
    // перенастроен окружением, число другое — и тест обязан сказать это
    // вслух, а не молча сойтись.
    expect(bagStore.BAG_DEAL_GRACE_MS).toBe(24 * HOUR);
  });

  it('Т2 никогда не короче срока по паре для того же спора', () => {
    const disputedAt = 1_700_000_000_000;
    const win = 4 * DAY;
    expect(disputeBoxBagDeadline(disputedAt + 3 * DAY, win))
      .toBeGreaterThan(dealDeadlineFromDispute(disputedAt, win));
    // На нулевой задержке — ровно то же число: это одна формула, а не две.
    expect(disputeBoxBagDeadline(disputedAt, win))
      .toBe(dealDeadlineFromDispute(disputedAt, win));
  });

  it('Т3 отрицательное окно спора — громкий отказ, а не молча укороченный срок', () => {
    expect(() => disputeBoxBagDeadline(1_700_000_000_000, -1)).toThrow(/disputeBoxBagDeadline/);
  });

  it('Т4 нечисло в момент вызова — громкий отказ', () => {
    expect(() => disputeBoxBagDeadline('вчера', 4 * DAY)).toThrow(/disputeBoxBagDeadline/);
    expect(() => disputeBoxBagDeadline(NaN, 4 * DAY)).toThrow(/disputeBoxBagDeadline/);
    expect(() => disputeBoxBagDeadline(Infinity, 4 * DAY)).toThrow(/disputeBoxBagDeadline/);
  });
});

// ─── Б. Отбор по сделке, а не по паре ───────────────────────────────────────

describe('отбор по СДЕЛКЕ, а не по паре', () => {
  it('Т5 усыновление по паре клиент↔исполнитель не трогает мешок ящика — это и есть беда, ради которой задача заведена', () => {
    const deal = freshDeal();
    const now = Date.now();
    const { key } = putBoxBag(deal, CLIENT, now - DAY);

    const byPair = adoptPairBags(_pairIdFromAddresses(CLIENT, EXECUTOR), now + 50 * DAY, now, true);
    expect(byPair.adopted).toBe(0);
    expect(bagMetaOf(key).dealDeadline).toBeNull();

    const byDeal = adoptDealBags(deal, now + 50 * DAY, now, true);
    expect(byDeal.adopted).toBe(1);
    expect(bagMetaOf(key).dealDeadline).toBe(now + 50 * DAY);
  });

  it('Т6 adoptDealBags продлевает мешки только своей сделки — ни чужой ящик, ни обычная переписка не тронуты', () => {
    const now = Date.now();
    const mine = freshDeal();
    const other = freshDeal();
    const { key: mineKey } = putBoxBag(mine, CLIENT, now - DAY);
    const { key: otherKey } = putBoxBag(other, CLIENT, now - DAY);
    const chatKey = putPairBag(EXECUTOR, CLIENT, now - DAY);

    const res = adoptDealBags(mine, now + 20 * DAY, now, true);

    expect(res.adopted).toBe(1);
    expect(bagMetaOf(mineKey).dealDeadline).toBe(now + 20 * DAY);
    expect(bagMetaOf(otherKey).dealDeadline).toBeNull();
    expect(bagMetaOf(chatKey).dealDeadline).toBeNull();
  });

  it('Т7 регистр адреса сделки не решает ничего: отбор находит мешок, как бы сделку ни назвали', () => {
    const deal = freshDeal();
    const now = Date.now();
    const { key } = putBoxBag(deal, CLIENT, now - DAY);
    const shouty = '0x' + deal.slice(2).toUpperCase();
    expect(shouty).not.toBe(deal); // контроль самой заготовки

    expect(adoptDealBags(shouty, now + 20 * DAY, now, true).adopted).toBe(1);
    expect(bagMetaOf(key).dealDeadline).toBe(now + 20 * DAY);
  });

  it('Т8 recordBag хранит адрес сделки в каноническом виде, каким бы он ни пришёл', () => {
    const deal = freshDeal();
    const now = Date.now();
    const key = bagKeyFor(deal);
    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, key), Buffer.from('x'));

    recordBag({
      key, sender: CLIENT, recipient: deal, size: 1, uploadedAt: now,
      deal: '0x' + deal.slice(2).toUpperCase(),
    }, now);

    expect(bagMetaOf(key).deal).toBe(deal);
  });

  it('Т9 мусор вместо адреса сделки — громкий отказ и на записи, и на отборе', () => {
    const deal = freshDeal();
    const now = Date.now();
    const key = bagKeyFor(deal);
    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, key), Buffer.from('x'));

    expect(() => recordBag({
      key, sender: CLIENT, recipient: deal, size: 1, uploadedAt: now, deal: 'javascript:',
    }, now)).toThrow(/recordBag/);
    expect(bagMetaOf(key)).toBeUndefined(); // половины записи не осталось

    expect(() => adoptDealBags('javascript:', now + DAY, now, true)).toThrow(/adoptDealBags/);
  });

  it('Т10 запись с мусорным адресом сделки в описи на диске не грузится — та же форма, что требует recordBag', () => {
    const deal = freshDeal();
    const now = Date.now();
    const { key: goodKey } = putBoxBag(deal, CLIENT, now - DAY);
    const badKey = bagKeyFor(deal);
    // Такую строку не может оставить recordBag (Т9) — только человек с
    // редактором. Дописываем прямо в журнал: разбор при загрузке обязан
    // отбраковать её той же проверкой, что и мусорный uploadedAt.
    fs.appendFileSync(path.join(TMP, 'bag-meta.log'), JSON.stringify({
      k: badKey,
      m: {
        sender: CLIENT, recipient: deal, pairId: _pairIdFromAddresses(CLIENT, deal),
        size: 1, uploadedAt: now - DAY, firstFetchedAt: null, dealDeadline: null,
        deal: 'не адрес',
      },
    }) + '\n');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    _loadBagMeta();
    logSpy.mockRestore();

    expect(bagMetaOf(goodKey)).toBeDefined();
    expect(bagMetaOf(badKey)).toBeUndefined();
  });
});

// ─── В. Срок ставится в момент записи ───────────────────────────────────────

describe('срок ставится в момент записи, а не ночной уборкой', () => {
  it('Т11 PUT в ящик кладёт мешок с уже проставленным сроком до конца спора', async () => {
    const deal = freshDeal();
    const now = Date.now();
    mockChain({ deal, disputedAtMs: now - 2 * DAY });

    const res = await putIntoBox({ deal, sender: CLIENT });
    // ⚠️ Не 200 — чинить МОКИ цепи под замок Задачи 1, а не это ожидание.
    expect(res.status).toBe(200);

    const meta = bagMetaOf(res.body.key);
    expect(meta.deal).toBe(deal);
    expect(meta.dealDeadline).not.toBeNull();
    // Хвост — от МОМЕНТА ЗАПИСИ, а не от disputedAt (тот был два дня назад).
    expect(meta.dealDeadline).toBeGreaterThanOrEqual(now + 10 * DAY - 5_000);
    expect(meta.dealDeadline).toBeLessThanOrEqual(Date.now() + 10 * DAY);
  });

  it('Т12 мешок, залитый в 03:05 и забранный в тот же день, живёт дольше семи суток — без единой ночной уборки', async () => {
    const deal = freshDeal();
    const now = Date.now();
    mockChain({ deal, disputedAtMs: now - HOUR });

    const res = await putIntoBox({ deal, sender: EXECUTOR });
    expect(res.status).toBe(200);
    markFetched(res.body.key, Date.now()); // арбитр забрал мешок в тот же час

    const meta = bagMetaOf(res.body.key);
    // Правило 2 склада само по себе дало бы ровно это — семь суток:
    expect(meta.firstFetchedAt + bagStore.BAG_TTL_MS).toBeLessThan(now + 8 * DAY);
    // А мешок живёт до конца спора. Ни одной ночной уборки при этом не было.
    expect(bagExpiryAt(meta, Date.now())).toBeGreaterThan(now + 9 * DAY);
  });

  it('Т13 цепь не отдала окно спора — 503, и ни мешка, ни записи', async () => {
    const deal = freshDeal();
    const now = Date.now();
    mockChain({ deal, disputedAtMs: now - HOUR });
    // Замок Задачи 1 проходит (getRecord/getDetails живы), а окно спора
    // прочитать нечем — записать мешок с неизвестным сроком нельзя.
    mockContract(deal, {
      getDetails: async () => ({
        client_: CLIENT, executor_: EXECUTOR, arbiter_: process.env.DIAMOND_ADDRESS,
        amount_: 0n, terms_: '', deadlineDays_: 0n,
        fundedAt_: BigInt(Math.floor((now - DAY) / 1000)), activatedAt_: 0n, markedDoneAt_: 0n,
        disputedAt_: BigInt(Math.floor((now - HOUR) / 1000)), resolvedAt_: 0n, status_: 4,
      }),
      status: async () => 4,
      DISPUTE_WINDOW: () => { throw new Error('network error (simulated node outage)'); },
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await putIntoBox({ deal, sender: CLIENT });
    errSpy.mockRestore();

    expect(res.status).toBe(503);
    // ⚠️ Ответ — тот же, которым замок Задачи 1 отвечает на молчащий узел:
    // код И заголовок. Проверяются оба, иначе «второго словаря не заводим»
    // осталось бы обещанием в комментарии: разойдись Retry-After — клиент
    // повёл бы себя иначе на двух отказах, которые человек видит одинаково.
    // Назвала иначе — взять её имя и её число, а не завести своё.
    expect(res.body.code).toBe('chain_unavailable');
    expect(res.headers['retry-after']).toBe('5');
    const dir = path.join(bagStore.DIR_BAGS, deal);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });
});

// ─── Г. Ночная уборка ───────────────────────────────────────────────────────

describe('ночная уборка — ящик спора', () => {
  it('Т14 runFileCleanup продлевает мешки ящика по сделке из getDisputed(), считая от сегодняшней ночи', async () => {
    const deal = freshDeal();
    const T0 = Date.UTC(2026, 7, 11);
    try {
      vi.setSystemTime(T0);
      const { key } = putBoxBag(deal, CLIENT, T0 - 2 * DAY);
      mockChain({ deal, disputedAtMs: T0 - 2 * DAY });

      await night();

      // От НОЧИ, не от disputedAt: тот был двое суток назад.
      expect(bagMetaOf(key).dealDeadline).toBe(T0 + 10 * DAY);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Т15 спор длиннее недели: мешок забран в первый день и жив на двадцатый', async () => {
    const deal = freshDeal();
    const T0 = Date.UTC(2026, 7, 11);
    try {
      vi.setSystemTime(T0);
      const { key, fp } = putBoxBag(deal, CLIENT, T0);
      markFetched(key, T0); // арбитр забрал сразу — по старому правилу жить неделю
      mockChain({ deal, disputedAtMs: T0 });

      for (const day of [0, 8, 16, 20]) {
        vi.setSystemTime(T0 + day * DAY);
        await night();
      }

      expect(bagMetaOf(key)).toBeDefined();
      expect(fs.existsSync(fp)).toBe(true);
      // Точное число, а не «жив»: последняя ночь была на 20-й день.
      expect(bagMetaOf(key).dealDeadline).toBe(T0 + 30 * DAY);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Т16 спор кончился — мешок уходит через десять суток после последней ночи, когда цепь ещё говорила DISPUTED', async () => {
    const deal = freshDeal();
    const T0 = Date.UTC(2026, 7, 11);
    try {
      vi.setSystemTime(T0);
      const { key, fp } = putBoxBag(deal, CLIENT, T0);
      markFetched(key, T0);
      mockChain({ deal, disputedAtMs: T0 });

      await night();
      expect(bagMetaOf(key).dealDeadline).toBe(T0 + 10 * DAY); // ночь спора продлила

      // Спор закрыт: сделка ушла из getDisputed().
      mockChain({ deal, disputedAtMs: T0, disputed: false });

      vi.setSystemTime(T0 + 9 * DAY);
      await night();
      expect(bagMetaOf(key)).toBeDefined(); // ещё внутри последнего хвоста

      vi.setSystemTime(T0 + 11 * DAY);
      await night();
      expect(bagMetaOf(key)).toBeUndefined();
      expect(fs.existsSync(fp)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Т17 вердикт заморожен, спор идёт сто двадцать суток — мешок жив: эскроу заперт, потолок не применяется', async () => {
    const deal = freshDeal();
    const T0 = Date.UTC(2026, 7, 11);
    try {
      vi.setSystemTime(T0);
      const { key } = putBoxBag(deal, CLIENT, T0);
      markFetched(key, T0);
      mockChain({ deal, disputedAtMs: T0, fundedAtMs: T0 - DAY }); // эскроу заперт

      for (let d = 0; d <= 120; d += 8) {
        vi.setSystemTime(T0 + d * DAY);
        await night();
      }

      // 90-дневный потолок от загрузки НЕ применён — сделка оплачена.
      expect(bagMetaOf(key)).toBeDefined();
      expect(bagMetaOf(key).dealDeadline).toBe(T0 + 130 * DAY);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Т18 цепь говорит DISPUTED, но эскроу пуст (fundedAt_=0) — 90-дневный потолок держит', async () => {
    const deal = freshDeal();
    const T0 = Date.UTC(2026, 7, 11);
    try {
      vi.setSystemTime(T0);
      const { key } = putBoxBag(deal, CLIENT, T0);
      markFetched(key, T0);
      mockChain({ deal, disputedAtMs: T0, fundedAtMs: 0 }); // денег в эскроу нет

      for (let d = 0; d <= 85; d += 8) {
        vi.setSystemTime(T0 + d * DAY);
        await night();
      }
      expect(bagMetaOf(key)).toBeDefined();                       // до потолка ещё жив
      expect(bagMetaOf(key).dealDeadline).toBe(T0 + 90 * DAY);    // но уже упёрся в потолок

      vi.setSystemTime(T0 + 91 * DAY);
      await night();
      expect(bagMetaOf(key)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Т19 узел молчит — просроченный мешок ящика НЕ снесён («не знаем» ≠ «спора нет»)', async () => {
    const deal = freshDeal();
    const now = Date.now();
    const { key, fp } = putBoxBag(deal, CLIENT, now - 20 * DAY);
    markFetched(key, now - 10 * DAY); // просрочен правилом 2 (7 суток от прочтения)

    mockContract(process.env.DIAMOND_ADDRESS, {
      getDisputed: () => { throw new Error('network error (simulated node outage)'); },
      getActive: () => { throw new Error('network error (simulated node outage)'); },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await night();
    errSpy.mockRestore();

    expect(bagMetaOf(key)).toBeDefined();
    expect(fs.existsSync(fp)).toBe(true);
  });

  it('Т20 узел ответил — тот же мешок ящика снесён: отсрочка не залипает', async () => {
    const deal = freshDeal();
    const now = Date.now();
    const { key, fp } = putBoxBag(deal, CLIENT, now - 20 * DAY);
    markFetched(key, now - 10 * DAY);

    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [], getActive: [] });
    await night();

    expect(bagMetaOf(key)).toBeUndefined();
    expect(fs.existsSync(fp)).toBe(false);
  });
});

// ─── Д. Обстоятельства — числом ─────────────────────────────────────────────

describe('обстоятельства — числом', () => {
  it('Т21 перезапустили посреди работы: срок ящика переживает перезагрузку описи', () => {
    const deal = freshDeal();
    const now = Date.now();
    const { key } = putBoxBag(deal, CLIENT, now - HOUR, {
      dealDeadline: disputeBoxBagDeadline(now - HOUR, 4 * DAY),
    });
    const before = bagMetaOf(key);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    _loadBagMeta(); // «перезапуск»: индекс перечитан со снимка + журнала
    logSpy.mockRestore();

    const after = bagMetaOf(key);
    expect(after.dealDeadline).toBe(before.dealDeadline);
    expect(after.deal).toBe(deal);
  });

  it('Т22 диск кончился на записи мешка ящика: recordBag бросает, в памяти не остаётся половины', () => {
    const deal = freshDeal();
    const now = Date.now();
    const key = bagKeyFor(deal);
    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, key), Buffer.from('x'));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      const e = new Error('ENOSPC: no space left on device');
      e.code = 'ENOSPC';
      throw e;
    });
    try {
      expect(() => recordBag({
        key, sender: CLIENT, recipient: deal, size: 1, uploadedAt: now,
        deal, dealDeadline: now + 10 * DAY,
      }, now)).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }

    expect(bagMetaOf(key)).toBeUndefined();
  });

  it('Т23 два прогона уборки разом: срок не откатывается назад, побеждает больший', async () => {
    const deal = freshDeal();
    const T0 = Date.UTC(2026, 7, 11);
    try {
      vi.setSystemTime(T0);
      const { key } = putBoxBag(deal, CLIENT, T0 - DAY);
      mockChain({ deal, disputedAtMs: T0 - DAY });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await Promise.all([runFileCleanup(), runFileCleanup()]);
      logSpy.mockRestore();
      warnSpy.mockRestore();

      expect(bagMetaOf(key).dealDeadline).toBe(T0 + 10 * DAY);
      expect(bagStore.isBagStoreHealthy()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Т24 ЗАМЕР: 5000 записей в описи, десять из них — ящик одной сделки', () => {
    const deal = freshDeal();
    const now = Date.now();
    // Файлы не нужны: отбор ходит по описи, а не по диску (cleanupBags —
    // отдельный проход, он в этом замере не участвует).
    for (let i = 0; i < 4990; i++) recordOnly(EXECUTOR, CLIENT, now - DAY);
    for (let i = 0; i < 10; i++) recordOnly(deal, CLIENT, now - DAY, { deal });

    const t0 = performance.now();
    const res = adoptDealBags(deal, now + 10 * DAY, now, true);
    const ms = performance.now() - t0;

    console.info(`[замер] отбор по сделке среди 5000 записей: ${ms.toFixed(1)} мс, продлено ${res.adopted}`);
    expect(res.adopted).toBe(10);
    expect(ms).toBeLessThan(1000);
  });
});

// ─── Е. Отметка «забрал» ────────────────────────────────────────────────────

describe('отметка «забрал» больше не решает судьбу мешка ящика', () => {
  it('Т25 отметка, поставленная в тот же миг, не укорачивает мешок ящика ниже конца спора', () => {
    const deal = freshDeal();
    const now = Date.now();
    const { key } = putBoxBag(deal, CLIENT, now, {
      dealDeadline: disputeBoxBagDeadline(now, 4 * DAY),
    });

    expect(bagExpiryAt(bagMetaOf(key), now)).toBe(now + 30 * DAY); // правило 3, пока не забрали
    markFetched(key, now);
    expect(bagExpiryAt(bagMetaOf(key), now)).toBe(now + 10 * DAY); // конец спора, а не 7 суток
    expect(bagExpiryAt(bagMetaOf(key), now)).toBeGreaterThan(now + bagStore.BAG_TTL_MS);
  });

  it('Т26 пока цепь говорит DISPUTED, ночная уборка возвращает срок вперёд, что бы ни сделала отметка', async () => {
    const deal = freshDeal();
    const T0 = Date.UTC(2026, 7, 11);
    try {
      vi.setSystemTime(T0);
      const { key } = putBoxBag(deal, CLIENT, T0, {
        dealDeadline: disputeBoxBagDeadline(T0, 4 * DAY),
      });
      markFetched(key, T0); // ложная отметка: ядро приняло ответ, человек ничего не получил
      mockChain({ deal, disputedAtMs: T0 });

      vi.setSystemTime(T0 + 9 * DAY);
      await night();

      expect(bagMetaOf(key).dealDeadline).toBe(T0 + 19 * DAY);
      expect(bagExpiryAt(bagMetaOf(key), T0 + 9 * DAY)).toBe(T0 + 19 * DAY);
    } finally {
      vi.useRealTimers();
    }
  });
});
