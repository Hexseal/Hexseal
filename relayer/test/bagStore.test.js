import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-'));
process.env.STORAGE_DIR = TMP;

const { DIR_BAGS, BAG_TTL_MS, BAG_UNREAD_TTL_MS, BAG_MAX_AGE_MS, MAX_BAG_SIZE,
        bagKeyFor, recordBag, markFetched, listBagsFor, bagMetaOf,
        bagExpiryAt, cleanupBags, _loadBagMeta } = await import('../bagStore.js');

const ALICE = '0xa1ce00000000000000000000000000000000cafe';
const BOB   = '0xb0b1000000000000000000000000000000005eed';
const DAY   = 24 * 60 * 60 * 1000;

function put(recipient, sender, uploadedAt, extra = {}) {
  const key = bagKeyFor(recipient);
  fs.mkdirSync(path.dirname(path.join(DIR_BAGS, key)), { recursive: true });
  fs.writeFileSync(path.join(DIR_BAGS, key), Buffer.from('sealed'));
  recordBag({ key, sender, recipient, size: 6, uploadedAt, ...extra });
  return key;
}

beforeEach(() => {
  fs.rmSync(DIR_BAGS, { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'bag-meta.json'), { force: true });
  _loadBagMeta();
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('bagExpiryAt — три правила в заданном порядке', () => {
  it('непрочитанный живёт 30 дней от загрузки', () => {
    const m = { uploadedAt: 1000, firstFetchedAt: null, dealDeadline: null };
    expect(bagExpiryAt(m)).toBe(1000 + BAG_UNREAD_TTL_MS);
  });

  it('прочитанный живёт 7 дней ОТ ПРОЧТЕНИЯ, а не от загрузки', () => {
    const m = { uploadedAt: 1000, firstFetchedAt: 1000 + 20 * DAY, dealDeadline: null };
    expect(bagExpiryAt(m)).toBe(1000 + 20 * DAY + BAG_TTL_MS);
  });

  it('сделка перебивает оба срока', () => {
    const deadline = 1000 + 50 * DAY;
    const m = { uploadedAt: 1000, firstFetchedAt: 1000 + DAY, dealDeadline: deadline };
    expect(bagExpiryAt(m)).toBe(deadline);
  });

  it('но не дольше потолка от загрузки — сделкой нельзя держать вечно', () => {
    const m = { uploadedAt: 1000, firstFetchedAt: null, dealDeadline: 1000 + 900 * DAY };
    expect(bagExpiryAt(m)).toBe(1000 + BAG_MAX_AGE_MS);
  });

  it('срок сделки короче обычного не сокращает жизнь мешку', () => {
    // Усыновление продлевает, а не обрезает: сделка, закрывшаяся завтра, не
    // должна стирать переписку, которой по обычному правилу жить ещё месяц.
    const m = { uploadedAt: 1000, firstFetchedAt: null, dealDeadline: 1000 + DAY };
    expect(bagExpiryAt(m)).toBe(1000 + BAG_UNREAD_TTL_MS);
  });
});

describe('склад', () => {
  it('ключ содержит адресата и не повторяется', () => {
    const a = bagKeyFor(ALICE), b = bagKeyFor(ALICE);
    expect(a.startsWith(`${ALICE}/`)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('адресат в ключе приводится к нижнему регистру', () => {
    expect(bagKeyFor('0xA1CE00000000000000000000000000000000CAFE')
      .startsWith(`${ALICE}/`)).toBe(true);
  });

  it('список отдаёт только мешки этого адресата', () => {
    put(ALICE, BOB, Date.now());
    put(BOB, ALICE, Date.now());
    expect(listBagsFor(ALICE)).toHaveLength(1);
    expect(listBagsFor(ALICE)[0].sender).toBe(BOB);
  });

  it('первое прочтение записывается, второе не сдвигает срок', () => {
    const key = put(ALICE, BOB, 1000);
    markFetched(key, 5000);
    markFetched(key, 9000);
    expect(bagMetaOf(key).firstFetchedAt).toBe(5000);
  });

  it('метаиндекс переживает перезапуск', () => {
    const key = put(ALICE, BOB, 1000);
    markFetched(key, 5000);
    _loadBagMeta();
    expect(bagMetaOf(key).firstFetchedAt).toBe(5000);
  });

  it('чистка сносит просроченное и оставляет живое', () => {
    const now = Date.now();
    const old  = put(ALICE, BOB, now - 40 * DAY);              // непрочитан, 40 дней — просрочен
    const read = put(ALICE, BOB, now - 40 * DAY,
                     { firstFetchedAt: now - 1 * DAY });        // прочитан вчера — жив
    const deal = put(ALICE, BOB, now - 40 * DAY,
                     { dealDeadline: now + 10 * DAY });         // сделка — жив
    cleanupBags(now);
    expect(fs.existsSync(path.join(DIR_BAGS, old))).toBe(false);
    expect(fs.existsSync(path.join(DIR_BAGS, read))).toBe(true);
    expect(fs.existsSync(path.join(DIR_BAGS, deal))).toBe(true);
    expect(bagMetaOf(old)).toBeUndefined();   // запись из индекса тоже ушла
  });

  it('чистка не спотыкается о файл, которого нет в индексе, и наоборот', () => {
    fs.mkdirSync(path.join(DIR_BAGS, ALICE), { recursive: true });
    fs.writeFileSync(path.join(DIR_BAGS, ALICE, 'осиротевший.bin'), 'x');
    recordBag({ key: `${ALICE}/призрак.bin`, sender: BOB, recipient: ALICE,
                size: 1, uploadedAt: Date.now() - 40 * DAY });
    expect(() => cleanupBags(Date.now())).not.toThrow();
  });
});

// ─── Дополнительно к брифу: запирающие тесты ──────────────────────────────
//
// Ниже — не из брифа буквально, а следствие опыта Задачи 1 (issueBagPass /
// bagPassChallenge трижды ловили дыру именно на форме входа — строка вместо
// числа, дробное число, склейка вместо сложения). bagStore.js тоже принимает
// адреса и время на входе каждой публичной функции, так что то же самое надо
// запереть здесь, а не только там, где брифу показалось важным.

describe('склад — счётчики и поведение чистки за пределами буквального брифа', () => {
  it('чистка возвращает { removed, kept }', () => {
    const now = Date.now();
    put(ALICE, BOB, now - 40 * DAY);                     // просрочен
    put(ALICE, BOB, now, { firstFetchedAt: now });        // жив
    put(ALICE, BOB, now);                                 // жив (не прочитан, свежий)
    expect(cleanupBags(now)).toEqual({ removed: 1, kept: 2 });
  });

  it('чистка сносит с диска старый файл-сирота, которого нет в индексе (не просто «не падает»)', () => {
    const now = Date.now();
    const orphanDir = path.join(DIR_BAGS, ALICE);
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphan = path.join(orphanDir, 'stale-orphan.bin');
    fs.writeFileSync(orphan, 'x');
    const old = new Date(now - 40 * DAY);
    fs.utimesSync(orphan, old, old);   // старше BAG_UNREAD_TTL_MS и не в индексе

    cleanupBags(now);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('свежий файл-сирота, которого ещё нет в индексе, чистка не трогает', () => {
    const now = Date.now();
    const orphanDir = path.join(DIR_BAGS, ALICE);
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphan = path.join(orphanDir, 'fresh-orphan.bin');
    fs.writeFileSync(orphan, 'x'); // mtime = сейчас

    cleanupBags(now);
    expect(fs.existsSync(orphan)).toBe(true);
  });
});

describe('форма входа — каждая публичная функция получает мусор и не творит тихой дичи', () => {
  it('bagKeyFor бросает на негодном по форме адресе', () => {
    expect(() => bagKeyFor('not-an-address')).toThrow();
    expect(() => bagKeyFor(null)).toThrow();
    expect(() => bagKeyFor(undefined)).toThrow();
    expect(() => bagKeyFor(1234)).toThrow();
    // На один символ короче/длиннее валидного адреса — тоже мусор.
    expect(() => bagKeyFor(`${ALICE}f`)).toThrow();
    expect(() => bagKeyFor(ALICE.slice(0, -1))).toThrow();
  });

  it('recordBag бросает на негодном ключе', () => {
    expect(() => recordBag({ key: '', sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1 }))
      .toThrow();
    expect(() => recordBag({ sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1 }))
      .toThrow();
  });

  it('recordBag бросает на негодных адресах отправителя/получателя', () => {
    expect(() => recordBag({ key: 'x/y.bin', sender: 'not-an-address', recipient: ALICE, size: 1, uploadedAt: 1 }))
      .toThrow();
    expect(() => recordBag({ key: 'x/y.bin', sender: BOB, recipient: 'not-an-address', size: 1, uploadedAt: 1 }))
      .toThrow();
  });

  it('recordBag бросает на нечисловом/дробном/отрицательном size — та же дыра I1/I3, что и в bagPass', () => {
    expect(() => recordBag({ key: 'x/y.bin', sender: BOB, recipient: ALICE, size: '6', uploadedAt: 1 }))
      .toThrow();
    expect(() => recordBag({ key: 'x/y.bin', sender: BOB, recipient: ALICE, size: 1.5, uploadedAt: 1 }))
      .toThrow();
    expect(() => recordBag({ key: 'x/y.bin', sender: BOB, recipient: ALICE, size: -1, uploadedAt: 1 }))
      .toThrow();
  });

  it('recordBag бросает, если size больше MAX_BAG_SIZE — мешок это сообщение, не вложение', () => {
    expect(() => recordBag({
      key: 'x/y.bin', sender: BOB, recipient: ALICE, size: MAX_BAG_SIZE + 1, uploadedAt: 1,
    })).toThrow();
    // Ровно на границе — ещё годно.
    expect(() => recordBag({
      key: 'x/y.bin', sender: BOB, recipient: ALICE, size: MAX_BAG_SIZE, uploadedAt: 1,
    })).not.toThrow();
  });

  it('recordBag бросает на нечисловом/дробном/огромном uploadedAt', () => {
    expect(() => recordBag({ key: 'x/y.bin', sender: BOB, recipient: ALICE, size: 1, uploadedAt: '1000' }))
      .toThrow();
    expect(() => recordBag({ key: 'x/y.bin', sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1.5 }))
      .toThrow();
    expect(() => recordBag({ key: 'x/y.bin', sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1e21 }))
      .toThrow();
  });

  it('recordBag бросает на негодных firstFetchedAt/dealDeadline, но принимает null/undefined', () => {
    expect(() => recordBag({
      key: 'x/y.bin', sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1, firstFetchedAt: 'soon',
    })).toThrow();
    expect(() => recordBag({
      key: 'x/y.bin', sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1, dealDeadline: 'later',
    })).toThrow();
    expect(() => recordBag({
      key: 'x/y.bin', sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1,
      firstFetchedAt: null, dealDeadline: undefined,
    })).not.toThrow();
  });

  it('recordBag хранит sender/recipient в нижнем регистре и считает pairId — сортировка+lower, как pairIdFromAddresses в app.js', () => {
    const upperSender    = BOB.toUpperCase().replace('0X', '0x');
    const upperRecipient = ALICE.toUpperCase().replace('0X', '0x');
    recordBag({ key: 'x/case.bin', sender: upperSender, recipient: upperRecipient, size: 1, uploadedAt: 1 });
    const meta = bagMetaOf('x/case.bin');
    expect(meta.sender).toBe(BOB);
    expect(meta.recipient).toBe(ALICE);
    const [a, b] = [BOB, ALICE].sort();
    expect(meta.pairId).toBe(`${a}-${b}`);
  });

  it('markFetched бросает на негодном ключе и на негодном nowMs', () => {
    const key = put(ALICE, BOB, 1000);
    expect(() => markFetched(null, 5000)).toThrow();
    expect(() => markFetched('', 5000)).toThrow();
    expect(() => markFetched(key, '5000')).toThrow();
    expect(() => markFetched(key, 5000.5)).toThrow();
    expect(() => markFetched(key, NaN)).toThrow();
  });

  it('markFetched бросает на ключе, которого нет в индексе — не тихо создаёт запись', () => {
    expect(() => markFetched('nobody/here.bin', 5000)).toThrow();
  });

  it('listBagsFor бросает на негодном по форме адресе', () => {
    expect(() => listBagsFor('not-an-address')).toThrow();
    expect(() => listBagsFor(null)).toThrow();
    expect(() => listBagsFor(42)).toThrow();
  });

  it('bagMetaOf бросает на негодном по форме ключе', () => {
    expect(() => bagMetaOf(null)).toThrow();
    expect(() => bagMetaOf(42)).toThrow();
    expect(() => bagMetaOf('')).toThrow();
    // Годный по форме, но отсутствующий ключ — это не ошибка формы, а undefined.
    expect(bagMetaOf('nobody/here.bin')).toBeUndefined();
  });

  it('bagExpiryAt бросает на негодной meta — не объект, либо негодные uploadedAt/firstFetchedAt/dealDeadline', () => {
    expect(() => bagExpiryAt(null)).toThrow();
    expect(() => bagExpiryAt('nope')).toThrow();
    expect(() => bagExpiryAt({ uploadedAt: '1000', firstFetchedAt: null, dealDeadline: null })).toThrow();
    expect(() => bagExpiryAt({ uploadedAt: 1000, firstFetchedAt: 'soon', dealDeadline: null })).toThrow();
    expect(() => bagExpiryAt({ uploadedAt: 1000, firstFetchedAt: null, dealDeadline: 'later' })).toThrow();
    expect(() => bagExpiryAt({ uploadedAt: 1000.5, firstFetchedAt: null, dealDeadline: null })).toThrow();
  });

  it('cleanupBags бросает на негодном nowMs', () => {
    expect(() => cleanupBags('now')).toThrow();
    expect(() => cleanupBags(NaN)).toThrow();
    expect(() => cleanupBags(1.5)).toThrow();
  });
});

describe('сроки и лимиты приходят из окружения, не пришпилены в коде', () => {
  it('умолчания совпадают с задокументированными значениями буквально', () => {
    expect(BAG_TTL_MS).toBe(7 * DAY);
    expect(BAG_UNREAD_TTL_MS).toBe(30 * DAY);
    expect(BAG_MAX_AGE_MS).toBe(90 * DAY);
    expect(MAX_BAG_SIZE).toBe(256 * 1024);
  });

  it('переменные окружения переопределяют умолчания при загрузке модуля', async () => {
    const savedEnv = {
      BAG_TTL_MS: process.env.BAG_TTL_MS,
      BAG_UNREAD_TTL_MS: process.env.BAG_UNREAD_TTL_MS,
      BAG_MAX_AGE_MS: process.env.BAG_MAX_AGE_MS,
      MAX_BAG_SIZE: process.env.MAX_BAG_SIZE,
      STORAGE_DIR: process.env.STORAGE_DIR,
    };
    process.env.BAG_TTL_MS = '1111';
    process.env.BAG_UNREAD_TTL_MS = '2222';
    process.env.BAG_MAX_AGE_MS = '3333';
    process.env.MAX_BAG_SIZE = '4444';
    process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-env-'));

    const { vi } = await import('vitest');
    vi.resetModules();
    try {
      const fresh = await import('../bagStore.js');
      expect(fresh.BAG_TTL_MS).toBe(1111);
      expect(fresh.BAG_UNREAD_TTL_MS).toBe(2222);
      expect(fresh.BAG_MAX_AGE_MS).toBe(3333);
      expect(fresh.MAX_BAG_SIZE).toBe(4444);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.resetModules();
      // Возвращаем модульный реестр в состояние, которого ждут все остальные
      // тесты этого файла (тот же STORAGE_DIR=TMP, что и на момент верхнего
      // импорта) — resetModules() иначе оставил бы следующий import('../bagStore.js')
      // где-нибудь в этом файле указывающим на другое хранилище.
      await import('../bagStore.js');
    }
  });
});
