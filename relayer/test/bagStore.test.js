import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-'));
process.env.STORAGE_DIR = TMP;

const { DIR_BAGS, BAG_TTL_MS, BAG_UNREAD_TTL_MS, BAG_MAX_AGE_MS, MAX_BAG_SIZE,
        bagKeyFor, recordBag, markFetched, listBagsFor, bagMetaOf,
        bagExpiryAt, cleanupBags, _loadBagMeta, _pairIdFromAddresses,
        assertBagStoreReady, bagPathFor } = await import('../bagStore.js');

// app.js — да, импортируется прямо в тест склада. По указанию координатора:
// соседние тесты (test/disputeReasonAndLog.test.js и другие) уже делают
// то же самое, окружение (мокнутый ethers/web-push, обязательные env) уже
// поднято test/setup.js как общий setupFile. Нужен только один чистый
// экспорт — pairIdFromAddresses — чтобы свериться с продублированной
// версией в bagStore.js и запереть их от расхождения.
const { pairIdFromAddresses: appPairIdFromAddresses } = await import('../app.js');

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
    // "Призрак" — запись в индексе без файла на диске. В брифе этот тест
    // использовал буквальный `${ALICE}/призрак.bin` как ключ; после C2
    // (проверка формы ключа против регэкспа bagKeyFor, находка ревью
    // координатора) recordBag() такой ключ больше не примет. Тот же сценарий
    // (запись есть, файла нет) собран честным ключом от bagKeyFor(), файл
    // для которого просто никогда не создаётся — свойство теста не
    // изменилось, изменилась только форма ключа, которым его собирают.
    const ghostKey = bagKeyFor(ALICE);
    recordBag({ key: ghostKey, sender: BOB, recipient: ALICE,
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
    expect(() => recordBag({ key: bagKeyFor(ALICE), sender: 'not-an-address', recipient: ALICE, size: 1, uploadedAt: 1 }))
      .toThrow();
    expect(() => recordBag({ key: bagKeyFor(ALICE), sender: BOB, recipient: 'not-an-address', size: 1, uploadedAt: 1 }))
      .toThrow();
  });

  it('recordBag бросает на нечисловом/дробном/отрицательном size — та же дыра I1/I3, что и в bagPass', () => {
    expect(() => recordBag({ key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: '6', uploadedAt: 1 }))
      .toThrow();
    expect(() => recordBag({ key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: 1.5, uploadedAt: 1 }))
      .toThrow();
    expect(() => recordBag({ key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: -1, uploadedAt: 1 }))
      .toThrow();
  });

  it('recordBag бросает, если size больше MAX_BAG_SIZE — мешок это сообщение, не вложение', () => {
    expect(() => recordBag({
      key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: MAX_BAG_SIZE + 1, uploadedAt: 1,
    })).toThrow();
    // Ровно на границе — ещё годно.
    expect(() => recordBag({
      key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: MAX_BAG_SIZE, uploadedAt: 1,
    })).not.toThrow();
  });

  it('recordBag бросает на нечисловом/дробном/огромном uploadedAt', () => {
    expect(() => recordBag({ key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: 1, uploadedAt: '1000' }))
      .toThrow();
    expect(() => recordBag({ key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1.5 }))
      .toThrow();
    expect(() => recordBag({ key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1e21 }))
      .toThrow();
  });

  it('recordBag бросает на негодных firstFetchedAt/dealDeadline, но принимает null/undefined', () => {
    expect(() => recordBag({
      key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1, firstFetchedAt: 'soon',
    })).toThrow();
    expect(() => recordBag({
      key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1, dealDeadline: 'later',
    })).toThrow();
    expect(() => recordBag({
      key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1,
      firstFetchedAt: null, dealDeadline: undefined,
    })).not.toThrow();
  });

  it('recordBag хранит sender/recipient в нижнем регистре и считает pairId — сортировка+lower, как pairIdFromAddresses в app.js', () => {
    const upperSender    = BOB.toUpperCase().replace('0X', '0x');
    const upperRecipient = ALICE.toUpperCase().replace('0X', '0x');
    const key = bagKeyFor(upperRecipient); // bagKeyFor лоуэркейсит само, ключ уже будет под ALICE
    recordBag({ key, sender: upperSender, recipient: upperRecipient, size: 1, uploadedAt: 1 });
    const meta = bagMetaOf(key);
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

// ─── C2 — форма ключа: единственный вход, который до этого не проверялся ──
//
// Находка ревью: key раньше проверялся только как "непустая строка" и шёл
// прямо в fs.unlinkSync(path.join(DIR_BAGS, key)). '../not-a-bag.txt' как
// key удалял файл ЗА ПРЕДЕЛАМИ DIR_BAGS; '<боб>/x.bin' с recipient=alice
// проходил молча — мешок Алисы физически лежал бы в каталоге Боба. Обе дыры
// закрыты одной проверкой формы (bagKeyFor()-формат буквально: <адрес в
// нижнем регистре>/<цифры>-<uuid>.bin) плюс сверкой сегмента-адресата в
// ключе с полем recipient.
describe('C2 — форма ключа в recordBag и bagPathFor', () => {
  it('recordBag бросает на попытке обхода каталога через key', () => {
    expect(() => recordBag({
      key: '../not-a-bag.txt', sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1,
    })).toThrow();
    expect(() => recordBag({
      key: `${ALICE}/../../etc/passwd`, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1,
    })).toThrow();
  });

  it('recordBag бросает, если сегмент-адресат в key не совпадает с полем recipient — мешок не может лежать у чужого', () => {
    const key = bagKeyFor(BOB); // ключ, честно сгенерированный ДЛЯ БОБА
    expect(() => recordBag({
      key, sender: ALICE, recipient: ALICE, size: 1, uploadedAt: 1, // но записываем как мешок Алисы
    })).toThrow();
  });

  it('recordBag бросает на key с лишними вложенными каталогами или без ожидаемого имени файла', () => {
    expect(() => recordBag({
      key: `${ALICE}/sub/dir.bin`, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1,
    })).toThrow();
    expect(() => recordBag({
      key: `${ALICE}/not-a-uuid.bin`, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1,
    })).toThrow();
    expect(() => recordBag({
      key: `${ALICE}/`, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1,
    })).toThrow();
  });

  it('recordBag принимает key именно того вида, что производит bagKeyFor', () => {
    const key = bagKeyFor(ALICE);
    expect(() => recordBag({
      key, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1,
    })).not.toThrow();
  });

  it('bagPathFor отдаёт путь внутри DIR_BAGS для годного ключа', () => {
    const key = bagKeyFor(ALICE);
    const p = bagPathFor(key);
    expect(p).toBe(path.join(DIR_BAGS, key));
    expect(path.resolve(p).startsWith(path.resolve(DIR_BAGS) + path.sep)).toBe(true);
  });

  it('bagPathFor бросает на форме, которую подсунул бы клиент маршруту GET /bags/:key (Задача 3) — обход каталога, мусор, пустая строка', () => {
    // Предусловие — без него каждый case ниже зелёный по неверной причине
    // ДО того, как bagPathFor вообще реализована: TypeError «not a
    // function» тоже толкуется как «бросает».
    expect(typeof bagPathFor).toBe('function');
    for (const bad of [
      '../../../etc/passwd',
      `${ALICE}/../../../etc/passwd`,
      `${ALICE}/..%2f..%2fetc%2fpasswd`,
      `${ALICE}//x.bin`,
      `${ALICE}/x.bin/../../../y`,
      'not-an-address/123-x.bin',
      '',
      null,
      undefined,
      42,
      `${ALICE}/${ALICE}/123-${'a'.repeat(8)}-${'a'.repeat(4)}-4${'a'.repeat(3)}-${'a'.repeat(4)}-${'a'.repeat(12)}.bin`,
    ]) {
      expect(() => bagPathFor(bad)).toThrow();
    }
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

// Хелпер: свежий импорт bagStore.js под временно подменённым окружением, с
// гарантированным восстановлением и env, и общего модульного состояния,
// которого ждут все остальные тесты файла (тот же STORAGE_DIR=TMP, что и на
// момент самого первого импорта наверху файла).
async function withFreshBagStoreModule(envOverrides, fn) {
  const saved = Object.fromEntries(Object.keys(envOverrides).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { vi } = await import('vitest');
  vi.resetModules();
  try {
    const fresh = await import('../bagStore.js');
    return await fn(fresh);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    await import('../bagStore.js');
  }
}

describe('assertBagStoreReady — проверка окружения НЕ на уровне модуля', () => {
  it('молчит на годных значениях по умолчанию', () => {
    expect(() => assertBagStoreReady()).not.toThrow();
  });

  it('импорт модуля с мусорным BAG_TTL_MS не бросает сам по себе — модуль вычисляется раньше, чем читаются настройки (тот же урок, что C1 из Задачи 1 про SERVER_SECRET)', async () => {
    await withFreshBagStoreModule({ BAG_TTL_MS: 'seven-days' }, async () => {
      // Дошли до этой строки — значит await import(...) не бросил.
    });
  });

  it.each([
    ['BAG_TTL_MS', 'seven-days'],
    ['BAG_UNREAD_TTL_MS', 'thirty-days'],
    ['BAG_MAX_AGE_MS', 'ninety-days'],
    ['MAX_BAG_SIZE', 'big'],
    ['BAG_TTL_MS', '0'],
    ['BAG_TTL_MS', '-1'],
    ['BAG_TTL_MS', 'Infinity'],
    ['BAG_TTL_MS', 'NaN'],
  ])('assertBagStoreReady бросает, когда %s=%s, называя виновную переменную', async (name, value) => {
    await withFreshBagStoreModule({ [name]: value }, async (fresh) => {
      // Не просто .toThrow() — иначе тест зелёный и до реализации функции
      // (TypeError: assertBagStoreReady is not a function тоже «бросает»,
      // просто по совершенно другой причине). Сообщение обязано называть
      // переменную-виновника, не просто «что-то не так».
      expect(() => fresh.assertBagStoreReady()).toThrow(new RegExp(name));
    });
  });

  it('создаёт DIR_BAGS, если каталога нет', () => {
    fs.rmSync(DIR_BAGS, { recursive: true, force: true });
    expect(fs.existsSync(DIR_BAGS)).toBe(false);
    assertBagStoreReady();
    expect(fs.existsSync(DIR_BAGS)).toBe(true);
  });

  it('свежий импорт модуля САМ ПО СЕБЕ не создаёт DIR_BAGS — каталог больше не побочный эффект загрузки', async () => {
    const freshStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-freshimport-'));
    try {
      await withFreshBagStoreModule({ STORAGE_DIR: freshStorageDir }, async (fresh) => {
        expect(fs.existsSync(fresh.DIR_BAGS)).toBe(false);
      });
    } finally {
      fs.rmSync(freshStorageDir, { recursive: true, force: true });
    }
  });
});

// ─── pairIdFromAddresses продублирован из app.js — держим обе версии в узде ─
//
// bagStore.js не импортирует pairIdFromAddresses из app.js (импорт назад
// завёл бы цикл, когда Задача 3 подключит bagStore.js к app.js), а
// повторяет тот же чистый алгоритм у себя. Дублирование чистой функции —
// не баг само по себе, но тихая мина: если однажды в app.js поменяют
// алгоритм (например, добавят чек-сумму или сменят разделитель), эта копия
// разойдётся молча — мешки будут ключеваться по одной паре, а споры (через
// _filePairs/getDisputedPairIds) искаться по другой. Ниже — тест, который
// обязан покраснеть в этот момент, а не тест, описывающий сегодняшнее
// поведение.
describe('_pairIdFromAddresses (bagStore) обязан совпадать с pairIdFromAddresses (app.js)', () => {
  const ZERO = '0x0000000000000000000000000000000000000000'.slice(0, 42);
  const MAX  = '0xffffffffffffffffffffffffffffffffffffffff';

  const CASES = [
    // пара в порядке (a, b)
    [ALICE, BOB],
    // та же пара в обратном порядке — сортировка обязана дать тот же id
    [BOB, ALICE],
    // разный регистр входа с обеих сторон
    [ALICE.toUpperCase().replace('0X', '0x'), BOB],
    [ALICE, BOB.toUpperCase().replace('0X', '0x')],
    [ALICE.toUpperCase().replace('0X', '0x'), BOB.toUpperCase().replace('0X', '0x')],
    // одинаковые адреса с обеих сторон (сделка/чат "с самим собой" — не
    // запрещено на этом уровне, оба алгоритма обязаны сходиться и здесь)
    [ALICE, ALICE],
    [ALICE.toUpperCase().replace('0X', '0x'), ALICE],
    // крайние значения — минимальный и максимальный по значению адрес
    [ZERO, MAX],
    [MAX, ZERO],
    [ZERO, ZERO],
    [MAX, MAX],
  ];

  it.each(CASES)('bagStore и app.js сходятся на (%s, %s)', (a, b) => {
    expect(_pairIdFromAddresses(a, b)).toBe(appPairIdFromAddresses(a, b));
  });

  it('обе версии сортируют одинаково независимо от порядка аргументов', () => {
    expect(_pairIdFromAddresses(ALICE, BOB)).toBe(_pairIdFromAddresses(BOB, ALICE));
    expect(appPairIdFromAddresses(ALICE, BOB)).toBe(appPairIdFromAddresses(BOB, ALICE));
  });

  it('золотое значение — если оба алгоритма ОДИНАКОВО уедут в сторону, сверка друг с другом это не поймает', () => {
    // Сверка bagStore-версии с app.js-версией защищает от расхождения ДРУГ
    // С ДРУГОМ, но не от того, что обе стороны когда-нибудь одинаково
    // изменятся (например, кто-то решит, что сортировка не нужна, и
    // применит правку сразу в обоих местах — сверка друг с другом такое не
    // ловит, ей нечем отличить "оба правильные" от "оба одинаково сломаны").
    // Один буквальный литерал, вычисленный от руки (нижний регистр,
    // лексикографическая сортировка строк, склейка через '-'), — сторонний
    // якорь для обеих версий разом.
    expect(_pairIdFromAddresses(ALICE, BOB)).toBe(`${ALICE}-${BOB}`);
    expect(appPairIdFromAddresses(ALICE, BOB)).toBe(`${ALICE}-${BOB}`);
  });
});

describe('listBagsFor — регистр адресата', () => {
  it('регистр адреса на входе не влияет на выдачу — верхний/нижний/смешанный видят один и тот же мешок', () => {
    // put() всегда пишет recipient в _bagMeta уже нижним регистром (через
    // recordBag → assertAddress), поэтому этот тест специально не трогает
    // put() — он проверяет именно listBagsFor(), а не запись.
    const key = put(ALICE, BOB, Date.now());

    const mixedCase = '0xA1cE00000000000000000000000000000000CAfe'; // тот же адрес, что ALICE
    expect(mixedCase.toLowerCase()).toBe(ALICE); // предусловие: это правда тот же адрес

    const byLower = listBagsFor(ALICE);
    const byUpper = listBagsFor(ALICE.toUpperCase().replace('0X', '0x'));
    const byMixed = listBagsFor(mixedCase);

    for (const list of [byLower, byUpper, byMixed]) {
      expect(list).toHaveLength(1);
      expect(list[0].key).toBe(key);
      expect(list[0].sender).toBe(BOB);
    }
  });
});
