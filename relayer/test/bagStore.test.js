import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-'));
process.env.STORAGE_DIR = TMP;

const { DIR_BAGS, BAG_TTL_MS, BAG_UNREAD_TTL_MS, BAG_MAX_AGE_MS, MAX_BAG_SIZE,
        bagKeyFor, recordBag, markFetched, listBagsFor, bagMetaOf,
        bagExpiryAt, cleanupBags, _loadBagMeta, _saveBagMeta, _pairIdFromAddresses,
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
  // C1 (ревью координатора): раньше файл всегда писался "сейчас", какой бы
  // uploadedAt ни клался в индекс — так что ни один тест не мог отличить
  // "уцелел, потому что метла сирот уважает индекс" от "уцелел, потому что
  // файл физически свежий". В реальности файл пишется ОДИН раз, его mtime
  // ≈ его настоящее время загрузки — здесь та же связь: mtime следует за
  // uploadedAt, а не за моментом вызова put() в тесте.
  const mtime = new Date(uploadedAt);
  fs.utimesSync(path.join(DIR_BAGS, key), mtime, mtime);
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

  // Находка ревью (мелочь c): фактический потолок усыновлённого мешка — это
  // BAG_MAX_AGE_MS + BAG_TTL_MS (90+7д), не просто BAG_MAX_AGE_MS (90д).
  // Прямое следствие «усыновление не обрезает» (тест выше): если мешок
  // усыновлён сделкой и прочитан за миг до 90-дневного потолка, правило 2
  // (7д от прочтения) само по себе даёт срок ДОЛЬШЕ потолка — и потолок
  // это не укорачивает, он ограничивает только вклад самой сделки, а не
  // итоговый результат Math.max. Не баг, задокументировано в комментарии
  // над bagExpiryAt(); этот тест — сам замок, а не описание сегодняшнего
  // поведения.
  it('потолок усыновления фактически 90+7 дней, если мешок прочитан у самой границы потолка', () => {
    const uploadedAt = 1000;
    const ceiling = uploadedAt + BAG_MAX_AGE_MS;      // номинальный потолок (90д)
    const readAtCeiling = ceiling - 1;                // прочитан за миллисекунду до потолка
    const m = {
      uploadedAt,
      firstFetchedAt: readAtCeiling,
      dealDeadline: uploadedAt + 900 * DAY,           // далеко за потолком — сама сделка тут не ограничитель
    };
    const expiry = bagExpiryAt(m);
    expect(expiry).toBe(readAtCeiling + BAG_TTL_MS);   // правило 2 берёт верх над потолком сделки
    expect(expiry).toBeGreaterThan(ceiling);            // и это ЗА пределами номинальных 90 дней
    expect(expiry - uploadedAt).toBeLessThanOrEqual(BAG_MAX_AGE_MS + BAG_TTL_MS); // но не больше 90+7
  });

  // Находка ревью (мелочь a): firstFetchedAt проверялся на истинность
  // (`meta.firstFetchedAt ? … : …`), а не на `!= null`. 0 (эпоха Unix, 1
  // января 1970) — валидный safe integer, тот же модуль сам его принимает
  // через assertNullableSafeInt. С проверкой на истинность firstFetchedAt: 0
  // читался как "не прочитан" — правило 3 (30д от загрузки) срабатывало
  // вместо правила 2 (7д от прочтения).
  //
  // dealDeadline та же проверка (`if (!meta.dealDeadline) …`) не тронута:
  // проверено отдельно, что dealDeadline: 0 при реалистичном uploadedAt
  // поведенчески неотличим от dealDeadline: null — Math.min(0, ceiling)
  // всегда даёт значение ≤ 0, а base (из правила 2/3) всегда положителен на
  // реалистичных временах, так что Math.max(base, ≤0) === base что с
  // "признан заданным", что с "проигнорирован как отсутствующий". Написать
  // тест, который бы отличал эти два поведения, не удалось — значит и
  // менять код нечего запирать. Требование координатора называло только
  // firstFetchedAt буквально; для dealDeadline это не бездумно сужено, а
  // проверено и оставлено осознанно.
  it('firstFetchedAt: 0 — валидное время прочтения (эпоха Unix), не "не прочитан"', () => {
    // uploadedAt тоже 0 — иначе firstFetchedAt: 0 нарушал бы отдельный
    // инвариант «прочитано не раньше загрузки» (мелочь b, ниже), а этот
    // тест проверяет другое свойство и не должен зависеть от него.
    const m = { uploadedAt: 0, firstFetchedAt: 0, dealDeadline: null };
    expect(bagExpiryAt(m)).toBe(0 + BAG_TTL_MS); // правило 2 (прочитан), не правило 3
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

  // Находка ревью (C1, четвёртый раунд): вызов _loadBagMeta() на уже живом
  // инстансе модуля — не перезапуск. Модуль к этому моменту полностью
  // инициализирован (весь верхнеуровневый код уже выполнился), так что
  // ЛЮБОЙ баг порядка объявления внутри самого модуля (например, константа
  // в temporal dead zone на момент вызова _loadBagMeta() на уровне модуля)
  // этим тестом не ловится вообще. Настоящий перезапуск — это НОВАЯ оценка
  // модуля с нуля: ровно то, что даёт withFreshBagStoreModule().
  it('метаиндекс переживает НАСТОЯЩИЙ перезапуск — новый импорт модуля, а не просто повторный вызов _loadBagMeta() на уже живом инстансе', async () => {
    const key = put(ALICE, BOB, 1000);
    markFetched(key, 5000);

    await withFreshBagStoreModule({}, async (fresh) => {
      const meta = fresh.bagMetaOf(key);
      expect(meta).toBeDefined();
      expect(meta.firstFetchedAt).toBe(5000);
    });
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

// ─── C1 — метла сирот не должна путать «файл физически свежий» с «мешок
// ещё жив по индексу» ──────────────────────────────────────────────────────
//
// Находка ревью: put() выше раньше писал файл ВСЕГДА "сейчас"
// (fs.writeFileSync без последующего fs.utimesSync), какой бы uploadedAt ни
// клался в индекс. Реальный файл пишется один раз, его mtime ≈ настоящее
// время загрузки — put() соврал об этом каждому тесту разом. Из-за этого
// НИ ОДИН тест не мог отличить «уцелел, потому что sweepOrphanFiles уважает
// индекс» от «уцелел, потому что файл физически создан только что». Сломай
// защиту индекса в sweepOrphanFiles (bagStore.js) или форму ключа при
// сверке — раньше все тесты оставались зелёными; на настоящих временах
// файла те же мутации убивают усыновлённый сделкой мешок 40 дней от роду,
// прочитанный вчера мешок 40 дней от роду и мешок под потолком на 80-й
// день. put() теперь честно выставляет mtime файла через fs.utimesSync под
// uploadedAt — тесты ниже используют именно эту честность.
describe('C1 — метла сирот уважает индекс, а не просто «файл свежий»', () => {
  it('усыновлённый 40-дневный, прочитанный-вчера 40-дневный и усыновлённый 80-дневный (под потолком) мешки не сносятся, даже когда их НАСТОЯЩИЙ mtime старше порога сирот', () => {
    const now = Date.now();
    // Усыновлённый сделкой, 40 дней от роду — без индекса mtime старше
    // BAG_UNREAD_TTL_MS (30д), метла сирот снесла бы его, если бы не
    // проверяла индекс в первую очередь.
    const adopted40 = put(ALICE, BOB, now - 40 * DAY, { dealDeadline: now + 10 * DAY });
    // Прочитан вчера, но САМ мешок 40 дней от роду — тот же риск.
    const read40 = put(ALICE, BOB, now - 40 * DAY, { firstFetchedAt: now - 1 * DAY });
    // Усыновлённый, 80 дней от роду — под потолком BAG_MAX_AGE_MS (90д), но
    // куда старше порога сирот (30д). Именно этот случай координатор назвал
    // отдельно: «мешок под потолком на 80-й день».
    const adopted80 = put(ALICE, BOB, now - 80 * DAY, { dealDeadline: now + 400 * DAY });

    cleanupBags(now);

    expect(fs.existsSync(path.join(DIR_BAGS, adopted40))).toBe(true);
    expect(fs.existsSync(path.join(DIR_BAGS, read40))).toBe(true);
    expect(fs.existsSync(path.join(DIR_BAGS, adopted80))).toBe(true);
  });

  it('порог сирот — это буквально BAG_UNREAD_TTL_MS, не какое-то другое число: неиндексированный файл чуть моложе порога выживает, чуть старше — сносится', () => {
    const now = Date.now();
    const orphanDir = path.join(DIR_BAGS, ALICE);
    fs.mkdirSync(orphanDir, { recursive: true });

    const survivor = path.join(orphanDir, 'just-under-threshold.bin');
    fs.writeFileSync(survivor, 'x');
    const justUnder = new Date(now - BAG_UNREAD_TTL_MS + 60_000); // на минуту моложе порога
    fs.utimesSync(survivor, justUnder, justUnder);

    const doomed = path.join(orphanDir, 'just-over-threshold.bin');
    fs.writeFileSync(doomed, 'x');
    const justOver = new Date(now - BAG_UNREAD_TTL_MS - 60_000); // на минуту старше порога
    fs.utimesSync(doomed, justOver, justOver);

    cleanupBags(now);

    expect(fs.existsSync(survivor)).toBe(true);
    expect(fs.existsSync(doomed)).toBe(false);
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
    // Ключ ГОДЕН по форме (проходит assertBagKeyShape), просто никогда не
    // записывался через recordBag() — эта форма теста проверяет именно
    // "unknown key", а не заодно и форму ключа (после I1 четвёртого раунда
    // 'nobody/here.bin' сам по себе не прошёл бы форму и бросал бы раньше,
    // по другой причине).
    expect(() => markFetched(bagKeyFor(ALICE), 5000)).toThrow();
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
    // Находка ревью (I1, четвёртый раунд): 'nobody/here.bin' раньше
    // считался "годным по форме, но отсутствующим" — bagMetaOf() проверяла
    // только непустую строку, не форму bagKeyFor(). Теперь это тоже
    // негодная форма (не проходит BAG_KEY_RE) и тоже бросает.
    expect(() => bagMetaOf('nobody/here.bin')).toThrow();
    // Годный ПО ФОРМЕ, но отсутствующий в индексе ключ — это не ошибка
    // формы, а undefined.
    expect(bagMetaOf(bagKeyFor(ALICE))).toBeUndefined();
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

  // Находка ревью: [0-9]+ в BAG_KEY_RE не ограничен по длине — ключ со
  // ста тысячами цифр вместо метки времени формально совпадал с формой.
  it('recordBag бросает на key с непомерно длинной "меткой времени" в имени файла', () => {
    const hugeDigits = '1'.repeat(100_000);
    const key = `${ALICE}/${hugeDigits}-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bin`;
    expect(() => recordBag({
      key, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1,
    })).toThrow();
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

// ─── I1 — одна кривая запись не убивает загрузку/чистку целиком ───────────
//
// Находка ревью: bag-meta.json с записью uploadedAt: 'oops' — структурно
// валидный JSON, но семантически отравленный. cleanupBags() раньше бросал
// НА СЕРЕДИНЕ прохода по _bagMeta (bagExpiryAt → assertSafeInt бросает на
// 'oops'), файл предыдущего просроченного мешка уже был удалён, а сохранение
// индекса в конце — нет: на диске индекс продолжает перечислять снесённое,
// listBagsFor отдаёт мешки без файлов, каждая следующая чистка бросает
// снова, ядовитая запись не вычищается никогда. Фикс — на границе загрузки:
// каждая запись проверяется той же формой, что recordBag() требует на
// записи; негодные отбрасываются с явным логом, не блокируя ни загрузку
// остальных, ни последующую чистку.
function validRawMeta(overrides = {}) {
  return {
    sender: BOB,
    recipient: ALICE,
    pairId: [BOB, ALICE].sort().join('-'),
    size: 6,
    uploadedAt: 1000,
    firstFetchedAt: null,
    dealDeadline: null,
    ...overrides,
  };
}

function writeRawBagMeta(raw) {
  fs.writeFileSync(path.join(TMP, 'bag-meta.json'), JSON.stringify(raw), 'utf8');
}

describe('I1 — кривая запись в индексе отбраковывается при загрузке, не роняет всё остальное', () => {
  it('_loadBagMeta отбрасывает запись с нечисловым uploadedAt, оставляет годные соседние записи', () => {
    const goodKey1 = bagKeyFor(ALICE);
    const poisonedKey = bagKeyFor(ALICE);
    const goodKey2 = bagKeyFor(ALICE);
    writeRawBagMeta({
      [goodKey1]: validRawMeta({ uploadedAt: 1000 }),
      [poisonedKey]: validRawMeta({ uploadedAt: 'oops' }),
      [goodKey2]: validRawMeta({ uploadedAt: 2000 }),
    });

    _loadBagMeta();

    expect(bagMetaOf(goodKey1)).toBeDefined();
    expect(bagMetaOf(goodKey2)).toBeDefined();
    expect(bagMetaOf(poisonedKey)).toBeUndefined();
  });

  it('отбраковка отбитой записи громко логируется (console.error), а не тихо', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const poisonedKey = bagKeyFor(ALICE);
      writeRawBagMeta({ [poisonedKey]: validRawMeta({ uploadedAt: 'oops' }) });
      _loadBagMeta();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('после отбраковки cleanupBags не бросает и нормально дочищает остальное — ядовитая запись больше не блокирует весь проход', () => {
    const now = Date.now();
    const expiredGoodKey = bagKeyFor(ALICE);
    const poisonedKey = bagKeyFor(ALICE);
    writeRawBagMeta({
      [expiredGoodKey]: validRawMeta({ uploadedAt: now - 40 * DAY }), // непрочитан, просрочен
      [poisonedKey]: validRawMeta({ uploadedAt: 'oops' }),
    });
    _loadBagMeta();

    expect(() => cleanupBags(now)).not.toThrow();
    expect(bagMetaOf(expiredGoodKey)).toBeUndefined(); // нормально дочищен
  });

  it('негодный по форме sender/recipient/pairId/size/firstFetchedAt/dealDeadline тоже отбраковывается', () => {
    const badSenderKey     = bagKeyFor(ALICE);
    const badPairIdKey     = bagKeyFor(ALICE);
    const badSizeKey       = bagKeyFor(ALICE);
    const badFetchedAtKey  = bagKeyFor(ALICE);
    const badDeadlineKey   = bagKeyFor(ALICE);
    const mismatchedRecipientKey = bagKeyFor(ALICE); // ключ ДЛЯ ALICE...
    writeRawBagMeta({
      [badSenderKey]:    validRawMeta({ sender: 'not-an-address' }),
      [badPairIdKey]:    validRawMeta({ pairId: '' }),
      [badSizeKey]:      validRawMeta({ size: 'six' }),
      [badFetchedAtKey]: validRawMeta({ firstFetchedAt: 'soon' }),
      [badDeadlineKey]:  validRawMeta({ dealDeadline: 'later' }),
      // ...но запись внутри утверждает, что получатель — БОБ: та же сверка
      // ключ/recipient, что и в C2, повторно проверяется на границе загрузки
      // (файл на диске мог быть отредактирован руками между перезапусками).
      [mismatchedRecipientKey]: validRawMeta({ recipient: BOB }),
    });

    _loadBagMeta();

    for (const key of [badSenderKey, badPairIdKey, badSizeKey, badFetchedAtKey, badDeadlineKey, mismatchedRecipientKey]) {
      expect(bagMetaOf(key)).toBeUndefined();
    }
  });

  it('файл отбракованного мешка не удаляется — только запись уходит из индекса, чистка файла остаётся заботой обычной метлы сирот по mtime', () => {
    const poisonedKey = bagKeyFor(ALICE);
    fs.mkdirSync(path.dirname(path.join(DIR_BAGS, poisonedKey)), { recursive: true });
    fs.writeFileSync(path.join(DIR_BAGS, poisonedKey), 'sealed');
    writeRawBagMeta({ [poisonedKey]: validRawMeta({ uploadedAt: 'oops' }) });

    _loadBagMeta();

    expect(bagMetaOf(poisonedKey)).toBeUndefined();
    expect(fs.existsSync(path.join(DIR_BAGS, poisonedKey))).toBe(true);
  });

  it('целиком нечитаемый bag-meta.json по-прежнему даёт пустой индекс, не бросает (поведение до I1 не тронуто)', () => {
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), '{not valid json', 'utf8');
    expect(() => _loadBagMeta()).not.toThrow();
  });
});

// ─── C1 (четвёртый раунд) — ошибка программиста не маскируется под битые
// данные ───────────────────────────────────────────────────────────────────
//
// Находка ревью: голый `catch { return false; }` в isValidBagMetaEntry
// ловил ЛЮБОЙ throw — включая ReferenceError из temporal dead zone
// (константа BAG_KEY_RE читалась до собственного объявления, см. фикс
// выше в этом же коммите) — и тихо засчитывал его как «запись битая»,
// уменьшая счётчик. Ошибка ПРОГРАММИСТА (наш код сломан) и ошибка ДАННЫХ
// (uploadedAt: 'oops') — разного калибра: первая обязана быть громкой,
// вторая может тихо отбраковываться. Ниже — тест на САМ ПРИНЦИП различения,
// не привязанный к конкретной причине (TDZ уже не воспроизвести
// напрямую после фикса выше — симулируем тот же КЛАСС ошибки подменой
// Number.isSafeInteger, встроенного примитива, которым assertSafeInt
// пользуется внутри isValidBagMetaEntry на каждой записи).
describe('C1 (четвёртый раунд) — ошибка программиста внутри проверки записи не маскируется под "битые данные"', () => {
  it('TypeError из нашего же кода при загрузке пробрасывается наружу, а не тихо считается отбракованной записью', () => {
    const key = bagKeyFor(ALICE);
    writeRawBagMeta({ [key]: validRawMeta() }); // структурно и семантически валидная запись

    const spy = vi.spyOn(Number, 'isSafeInteger').mockImplementation(() => {
      throw new TypeError('симулированная ошибка программиста');
    });
    try {
      expect(() => _loadBagMeta()).toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });

  it('ReferenceError из нашего же кода при загрузке пробрасывается наружу — тот же класс, что реальный баг TDZ', () => {
    const key = bagKeyFor(ALICE);
    writeRawBagMeta({ [key]: validRawMeta() });

    const spy = vi.spyOn(Number, 'isSafeInteger').mockImplementation(() => {
      throw new ReferenceError('симулированная ошибка программиста');
    });
    try {
      expect(() => _loadBagMeta()).toThrow(ReferenceError);
    } finally {
      spy.mockRestore();
    }
  });

  it('настоящая порча данных (Error от fail()) по-прежнему тихо отбраковывается, не пробрасывается', () => {
    // Контрольный случай — без него первые два теста могли бы означать
    // "загрузка теперь ВСЕГДА бросает на любой невалидной записи", что
    // сломало бы I1 целиком (одна кривая запись снова роняла бы всё).
    const key = bagKeyFor(ALICE);
    writeRawBagMeta({ [key]: validRawMeta({ uploadedAt: 'oops' }) });
    expect(() => _loadBagMeta()).not.toThrow();
    expect(bagMetaOf(key)).toBeUndefined();
  });
});

// ─── И-2 (пятый раунд) — bag-meta.json = "null" роняет загрузку целиком ───
//
// Находка ревью: JSON.parse('null') УСПЕШНО возвращает null — try/catch
// вокруг разбора этого не ловит (разбор не бросил). Дальше по коду —
// Object.entries(null) — а это бросает TypeError, СНАРУЖИ try/catch
// isValidBagMetaEntry (сам except этой функции тут вообще не участвует —
// падение происходит до первого вызова isValidBagMetaEntry, в цикле
// _loadBagMeta() над Object.entries(raw)). Воспроизведено вживую отдельным
// скриптом: `await import('bagStore.js')` с bag-meta.json="null" на диске
// бросает TypeError прямо на импорте — в Задаче 3 это падение импорта в
// теле app.js, весь релеер не стартует целиком (ни мета-транзакции, ни
// файловый сервер, ни бот). Асимметрия: модуль уже переживает '{not valid
// json' (JSON.parse сам бросает, ловится) — но не переживает валидный
// JSON, который парсится в null.
describe('И-2 (пятый раунд) — bag-meta.json = "null" не роняет загрузку', () => {
  it('bag-meta.json = "null" не бросает — считается пустым индексом, как нечитаемый JSON', () => {
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');
    expect(() => _loadBagMeta()).not.toThrow();
    expect(listBagsFor(ALICE)).toEqual([]);
  });

  // Координатор проверил и эти формы отдельно — переживались и раньше
  // (Object.entries на них не бросает), но не были заперты явным тестом.
  it.each(['123', '"hello"', '[1,2,3]', 'true'])(
    'bag-meta.json = %s тоже не бросает',
    (jsonLiteral) => {
      fs.writeFileSync(path.join(TMP, 'bag-meta.json'), jsonLiteral, 'utf8');
      expect(() => _loadBagMeta()).not.toThrow();
    },
  );
});

// ─── I1 (четвёртый раунд) — markFetched/bagMetaOf травят Object.prototype ──
//
// Находка ревью: C2 поставил assertBagKey на recordBag(), но markFetched()
// и bagMetaOf() всё ещё проверяли key только как непустую строку и лезли в
// _bagMeta[key] напрямую. Обе функции получат key ОТ КЛИЕНТА в Задаче 3.
// _bagMeta — обычный `{}`, а не Object.create(null), так что
// _bagMeta['__proto__'] возвращает Object.prototype (истинный объект) —
// не undefined. bagMetaOf('__proto__') отдавала {} (истинно! проходит
// любую проверку "существует ли"), а markFetched('__proto__', ts) писала
// firstFetchedAt ПРЯМО в Object.prototype — травила прототип для всего
// процесса релеера, не только для этого модуля. Воспроизведено вживую.
describe('I1 (четвёртый раунд) — markFetched/bagMetaOf проверяют форму ключа, __proto__ не проходит', () => {
  // На плоском {} только '__proto__' и 'constructor' резолвятся во что-то
  // общее для всего процесса ({}['__proto__'] === Object.prototype,
  // {}['constructor'] === Object) — проверено отдельно (node -e). 'prototype'
  // и составные строки вроде 'constructor.prototype' на плоском объекте не
  // резолвятся ни во что особое (bagMeta['prototype'] === undefined) — не
  // включены как отдельные case'ы, чтобы не запирать тест, который на самом
  // деле ничего не проверяет (прошёл бы одинаково и до, и после фикса).
  //
  // Cleanup в finally — не косметика: если бы фикс отсутствовал, сам факт
  // прогона этого теста заразил бы Object.prototype/Object для ВСЕХ
  // остальных тестов в этом файле до конца прогона. Чистим независимо от
  // того, прошёл тест или упал.
  afterEach(() => {
    delete Object.prototype.firstFetchedAt;
    delete Object.firstFetchedAt;
  });

  it('bagMetaOf("__proto__") бросает, а не возвращает {} — не должен проходить проверку "существует ли"', () => {
    expect(() => bagMetaOf('__proto__')).toThrow();
  });

  it('bagMetaOf("constructor") бросает — тот же класс ключа, другая цель заражения', () => {
    expect(() => bagMetaOf('constructor')).toThrow();
  });

  it.each(['__proto__', 'constructor'])(
    'markFetched(%s, …) бросает, а не пишет в общий для процесса объект',
    (poison) => {
      expect(() => markFetched(poison, Date.now())).toThrow();
      // Прямая проверка последствия, не только факта throw — если бы
      // запись всё-таки прошла, у ЛЮБОГО {} в процессе завёлся бы
      // firstFetchedAt (через Object.prototype) или у самого Object.
      expect(Object.prototype.firstFetchedAt).toBeUndefined();
      expect({}.firstFetchedAt).toBeUndefined();
      expect(Object.firstFetchedAt).toBeUndefined();
    },
  );
});

// ─── I2 — сохранение индекса: атомарно и не глотая ошибку ─────────────────
//
// Находка ревью: _saveBagMeta писала напрямую, без временного файла и
// переименования, оба catch были немые. Обрезанный файл (крах посреди
// записи) → следующая загрузка молча ставит пустой индекс: список
// переписки человека исчезает, хотя файлы целы на диске. Ошибка записи
// глоталась — проверено подменой fs.writeFileSync: отметка о прочтении
// есть в памяти, на диске нет ничего, вызывающий не узнаёт об этом никак.
describe('I2 — сохранение индекса атомарно, ошибка записи не глотается', () => {
  it('_saveBagMeta реально пишет во временный путь, а не напрямую в основной индекс', () => {
    // Находка ревью (I2, четвёртый раунд): прежняя версия этого теста
    // проверяла только "нет мусора после успеха" — тривиально верное
    // утверждение, даже если временный файл вообще никогда не создаётся
    // (нечему было бы остаться). spyOn БЕЗ mockImplementation продолжает
    // звать настоящую fs.writeFileSync (наблюдает, не подменяет) — прямое
    // доказательство, что путь записи отличается от основного, а не
    // косвенный вывод из отсутствия мусора.
    const mainPath = path.join(TMP, 'bag-meta.json');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    put(ALICE, BOB, 1000);
    expect(writeSpy).toHaveBeenCalled();
    const writtenPaths = writeSpy.mock.calls.map(call => call[0]);
    expect(writtenPaths.length).toBeGreaterThan(0);
    expect(writtenPaths.every(p => p !== mainPath)).toBe(true);
    writeSpy.mockRestore();

    // И после успешной записи временного файла не остаётся (rename его убрал).
    const leftovers = fs.readdirSync(TMP).filter(f => f.startsWith('bag-meta.json.tmp'));
    expect(leftovers).toEqual([]);
    const onDisk = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
    expect(Object.keys(onDisk).length).toBeGreaterThan(0);
  });

  it('_saveBagMeta бросает, если запись падает — не глотает ошибку', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      expect(() => _saveBagMeta()).toThrow(/ENOSPC/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('бросок ДО того, как записан хоть байт, не портит уже лежащий на диске индекс (простой случай)', () => {
    const key = put(ALICE, BOB, 1000); // на диске уже лежит корректный индекс
    const before = fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8');

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    try {
      expect(() => markFetched(key, 9999)).toThrow();
    } finally {
      writeSpy.mockRestore();
    }

    const after = fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8');
    expect(after).toBe(before);
  });

  // Находка ревью (I2, четвёртый раунд): тест выше подменяет запись броском
  // ДО ТОГО, как что-либо записано — файл основного индекса не тронут в
  // ОБОИХ случаях (что с temp+rename, что с наивной прямой записью), так
  // что он не различает эти два устройства вообще. Настоящий отказ, ради
  // которого атомарность и заведена, — ЧАСТИЧНАЯ запись (крах ровно
  // посреди flush) — этим тестом не моделируется никак. Честная версия:
  // подмена реально пишет обрезанное содержимое туда, куда её попросили, и
  // только ПОСЛЕ этого бросает — симулируя обрыв между записью и rename.
  // С temp+rename обрезанные байты попадают во временный файл, основной
  // остаётся целиком старым. С наивной прямой записью (мутация ниже) те же
  // обрезанные байты попали бы прямо в основной файл — тест это ловит.
  it('честная атомарность: временный файл реально получает ОБРЕЗАННОЕ содержимое перед крахом, основной индекс всё равно остаётся старым и валидным', () => {
    const key = put(ALICE, BOB, 1000);
    const mainPath = path.join(TMP, 'bag-meta.json');
    const before = fs.readFileSync(mainPath, 'utf8');

    const realWriteFileSync = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath, data, ...rest) => {
      const str = String(data);
      realWriteFileSync(filePath, str.slice(0, Math.floor(str.length / 2)), ...rest);
      throw new Error('симулированный обрыв записи после частичного flush');
    });
    try {
      expect(() => markFetched(key, 9999)).toThrow();
    } finally {
      writeSpy.mockRestore();
    }

    const after = fs.readFileSync(mainPath, 'utf8');
    expect(after).toBe(before);            // не подменён обрезанным содержимым
    expect(() => JSON.parse(after)).not.toThrow(); // и остаётся валидным JSON
  });

  it('recordBag откатывает in-memory запись, если персист не удался — bagMetaOf не видит запись, которой нет на диске', () => {
    const key = bagKeyFor(ALICE);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    try {
      expect(() => recordBag({ key, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1 })).toThrow();
    } finally {
      writeSpy.mockRestore();
    }
    expect(bagMetaOf(key)).toBeUndefined();
  });

  it('markFetched откатывает firstFetchedAt в null, если персист не удался — память не обгоняет диск', () => {
    const key = put(ALICE, BOB, 1000);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    try {
      expect(() => markFetched(key, 5000)).toThrow();
    } finally {
      writeSpy.mockRestore();
    }
    expect(bagMetaOf(key).firstFetchedAt).toBeNull();
  });
});

// ─── I5 — повторный recordBag на том же ключе отвергается ─────────────────
//
// Находка ревью: recordBag() раньше перезаписывал запись целиком —
// firstFetchedAt обнулялся в null, uploadedAt сдвигался на новое значение,
// а потолок BAG_MAX_AGE_MS считается ОТ uploadedAt. Повторной записью того
// же ключа с новым uploadedAt потолок в 90 дней пробивался и продлевался
// бесконечно. Ключи уникальны по построению (bagKeyFor: временная метка +
// uuid) — значит легитимного повторного recordBag() с тем же key не
// бывает никогда, и повтор — это ошибка вызывающего, которую надо отвергать
// вслух, а не тихо принимать как "обновление".
describe('I5 — recordBag отвергает повтор на уже существующем key', () => {
  it('второй recordBag с тем же key бросает, первая запись не тронута', () => {
    const key = put(ALICE, BOB, 1000);
    expect(() => recordBag({ key, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 99999 }))
      .toThrow();
    expect(bagMetaOf(key).uploadedAt).toBe(1000);
  });

  it('без отказа повтор пробивал бы 90-дневный потолок — тест на сам сценарий атаки, не только на факт throw', () => {
    // До фикса: recordBag(key, uploadedAt=1000, dealDeadline=+900д) →
    // recordBag(key, uploadedAt=Date.now(), dealDeadline=+900д) снова —
    // потолок пересчитывается от НОВОГО uploadedAt, эффективно откладывая
    // "смерть" мешка на ещё 90 дней от текущего момента, и так можно
    // повторять сколько угодно раз подряд.
    const now = Date.now();
    const key = put(ALICE, BOB, now - 89 * DAY, { dealDeadline: now + 900 * DAY });
    const before = bagExpiryAt(bagMetaOf(key));

    expect(() => recordBag({
      key, sender: BOB, recipient: ALICE, size: 1, uploadedAt: now, dealDeadline: now + 900 * DAY,
    })).toThrow();

    // Запись — и, следовательно, её срок истечения — не сдвинулась.
    expect(bagExpiryAt(bagMetaOf(key))).toBe(before);
  });
});

// ─── I3 — bagMetaOf() отдаёт копию, не живую ссылку ────────────────────────
//
// Находка ревью: bagMetaOf() возвращала `_bagMeta[key]` напрямую — тот же
// объект, что живёт в индексе. `m = bagMetaOf(key); m.recipient = БОБ`
// мгновенно "переезжал" мешок к Бобу в listBagsFor(), без единого вызова
// recordBag()/markFetched(). Само по себе — непоследовательность (listBagsFor
// и markFetched уже возвращают копии через спред), но в связке с I1 это
// цепь: если Задача 3 когда-нибудь передаст объект от bagMetaOf() дальше и
// кто-то допишет в него поле строкой вместо числа, index окажется отравлен
// прямо в памяти, без прохода через recordBag()'s проверки формы.
describe('I3 — bagMetaOf отдаёт копию, а не живую ссылку на запись в индексе', () => {
  it('мутация объекта, возвращённого bagMetaOf, не меняет запись в индексе', () => {
    const key = put(ALICE, BOB, 1000);
    const meta = bagMetaOf(key);
    meta.recipient = BOB; // мутируем то, что вернула bagMetaOf
    meta.firstFetchedAt = 12345;

    expect(bagMetaOf(key).recipient).toBe(ALICE);       // индекс не тронут
    expect(bagMetaOf(key).firstFetchedAt).toBeNull();
    expect(listBagsFor(ALICE)).toHaveLength(1);          // мешок остался у Алисы
    expect(listBagsFor(BOB)).toHaveLength(0);
  });

  it('два последовательных вызова bagMetaOf(key) возвращают РАЗНЫЕ объекты с одинаковым содержимым', () => {
    const key = put(ALICE, BOB, 1000);
    expect(bagMetaOf(key)).not.toBe(bagMetaOf(key));     // не тот же объект
    expect(bagMetaOf(key)).toEqual(bagMetaOf(key));      // но то же содержимое
  });
});

// ─── Мелочь (b) — инвариант «прочитано не раньше загрузки» ─────────────────
//
// Находка ревью: firstFetchedAt на сто дней раньше uploadedAt даёт срок
// смерти раньше рождения — мешок сносится в тот же миг, в который
// появился (правило 2 считает firstFetchedAt + BAG_TTL_MS, и если
// firstFetchedAt глубоко в прошлом относительно uploadedAt, эта сумма
// может оказаться МЕНЬШЕ момента загрузки). Заперто на всех входах, где
// firstFetchedAt вообще может появиться: markFetched (реальный путь —
// nowMs становится firstFetchedAt), recordBag (firstFetchedAt как прямое
// поле meta, которым пользуется put() в этом же файле), bagExpiryAt
// (защита в глубину на сырой meta) и _loadBagMeta (та же защита при
// восстановлении с диска, что и для остальных полей в I1).
describe('Мелочь (b) — прочитано не раньше загрузки', () => {
  it('markFetched бросает, если nowMs раньше uploadedAt мешка', () => {
    const key = put(ALICE, BOB, 1000);
    expect(() => markFetched(key, 999)).toThrow();
    expect(bagMetaOf(key).firstFetchedAt).toBeNull(); // не записалось
  });

  it('markFetched на РОВНО uploadedAt — годно, это не строгая граница', () => {
    const key = put(ALICE, BOB, 1000);
    expect(() => markFetched(key, 1000)).not.toThrow();
    expect(bagMetaOf(key).firstFetchedAt).toBe(1000);
  });

  it('recordBag бросает, если firstFetchedAt в meta раньше uploadedAt', () => {
    const key = bagKeyFor(ALICE);
    expect(() => recordBag({
      key, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1000, firstFetchedAt: 999,
    })).toThrow();
  });

  it('bagExpiryAt бросает на сырой meta с firstFetchedAt раньше uploadedAt — защита в глубину', () => {
    expect(() => bagExpiryAt({ uploadedAt: 1000, firstFetchedAt: 900, dealDeadline: null }))
      .toThrow();
  });

  it('_loadBagMeta отбраковывает запись с firstFetchedAt раньше uploadedAt — тот же класс порчи, что I1', () => {
    const key = bagKeyFor(ALICE);
    writeRawBagMeta({ [key]: validRawMeta({ uploadedAt: 1000, firstFetchedAt: 900 }) });
    _loadBagMeta();
    expect(bagMetaOf(key)).toBeUndefined();
  });
});

// ─── Мелочь (d) — два ранее незапертых места ───────────────────────────────
//
// Находка ревью: граница чистки (`<=` в cleanupBags) и порядок сортировки
// listBagsFor были верны по коду, но ничем не заперты — тот же приём, что и
// «мелочь c» и register-тест listBagsFor из основной Задачи 2: поведение
// уже правильное, замка не было. (Третий пункт находки — порог сирот — уже
// заперт под C1; четвёртый — mkdirSync при импорте — уже убран под I4.)
describe('Мелочь (d) — граница чистки и порядок сортировки listBagsFor', () => {
  it('чистка сносит мешок РОВНО в момент истечения — граница "<=", не "<"', () => {
    // bagExpiryAt(m) === now должен означать "уже истёк", а не "ещё жив на
    // эту миллисекунду" — брифом Задачи 2 прямо требуется "<=".
    const now = Date.now();
    const uploadedAt = now - BAG_UNREAD_TTL_MS; // bagExpiryAt(m) === uploadedAt + BAG_UNREAD_TTL_MS === now
    const key = put(ALICE, BOB, uploadedAt);
    expect(bagExpiryAt(bagMetaOf(key))).toBe(now); // предусловие: граница ровно на now

    cleanupBags(now);
    expect(fs.existsSync(path.join(DIR_BAGS, key))).toBe(false);
    expect(bagMetaOf(key)).toBeUndefined();
  });

  it('listBagsFor отдаёт мешки в хронологическом порядке (по uploadedAt), даже если записаны вразнобой', () => {
    const now = Date.now();
    const third  = put(ALICE, BOB, now - 1 * DAY);
    const first  = put(ALICE, BOB, now - 3 * DAY);
    const second = put(ALICE, BOB, now - 2 * DAY);

    expect(listBagsFor(ALICE).map(b => b.key)).toEqual([first, second, third]);
  });
});

// ─── Мелочь (e) — пустые каталоги адресатов не остаются навсегда ──────────
//
// Находка ревью: после чистки bags/<адрес>/ оставался на диске даже без
// единого мешка внутри — то есть на диске лежал список всех, кто когда-либо
// получал мешок, дольше самих мешков. Для проекта, обещающего не быть
// архивом, это лишнее.
describe('Мелочь (e) — пустые каталоги адресатов сносятся чисткой', () => {
  it('каталог адресата исчезает, когда чистка сносит его последний мешок', () => {
    const now = Date.now();
    put(ALICE, BOB, now - 40 * DAY); // непрочитан, просрочен — единственный мешок Алисы

    cleanupBags(now);

    expect(fs.existsSync(path.join(DIR_BAGS, ALICE))).toBe(false);
  });

  it('каталог адресата остаётся, пока в нём есть хоть один живой мешок', () => {
    const now = Date.now();
    put(ALICE, BOB, now - 40 * DAY);                      // просрочен
    put(ALICE, BOB, now, { firstFetchedAt: now });         // жив

    cleanupBags(now);

    expect(fs.existsSync(path.join(DIR_BAGS, ALICE))).toBe(true);
  });
});

// ─── Мелочь (f) — removed не считает снесённых сирот ───────────────────────
//
// Находка ревью: removed считал только записи, вычищенные из _bagMeta
// (основной цикл), а не файлы-сироты, снесённые sweepOrphanFiles — снёс
// файл, вернул {removed: 0}. Вызывающий (Задача 3, например, лог/метрика
// после ночной чистки) видел бы "ничего не сделано" при реально удалённых
// файлах.
describe('Мелочь (f) — removed считает и снесённых сирот', () => {
  it('удалённый файл-сирота увеличивает removed, даже если в _bagMeta ничего не менялось', () => {
    const now = Date.now();
    const orphanDir = path.join(DIR_BAGS, ALICE);
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphan = path.join(orphanDir, 'stale-orphan.bin');
    fs.writeFileSync(orphan, 'x');
    const old = new Date(now - 40 * DAY);
    fs.utimesSync(orphan, old, old);

    expect(cleanupBags(now)).toEqual({ removed: 1, kept: 0 });
  });

  it('removed складывает записи из индекса и сирот с диска вместе', () => {
    const now = Date.now();
    put(ALICE, BOB, now - 40 * DAY);                      // просрочен, из индекса

    const orphanDir = path.join(DIR_BAGS, BOB);
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphan = path.join(orphanDir, 'stale-orphan.bin');
    fs.writeFileSync(orphan, 'x');
    const old = new Date(now - 40 * DAY);
    fs.utimesSync(orphan, old, old);

    expect(cleanupBags(now)).toEqual({ removed: 2, kept: 0 });
  });
});

// ─── Мелочь (g) — запись в индексе не переживает пропавший файл ───────────
//
// Находка ревью: если файл мешка пропал с диска (ручное вмешательство,
// сбой ФС), а запись в индексе формально ещё "жива" (bagExpiryAt > now),
// чистка считала такой мешок живым: listBagsFor() продолжал его отдавать,
// а Задача 3 получила бы ошибку чтения на попытке выдачи. Индекс не должен
// утверждать существование того, чего нет на диске.
describe('Мелочь (g) — запись без файла отбрасывается чисткой, а не остаётся "живой"', () => {
  it('живая по сроку запись без файла на диске уходит из индекса, считается removed', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now, { firstFetchedAt: now }); // жив ещё 7 дней
    fs.unlinkSync(path.join(DIR_BAGS, key)); // файл пропал, запись в индексе осталась

    expect(cleanupBags(now)).toEqual({ removed: 1, kept: 0 });
    expect(bagMetaOf(key)).toBeUndefined();
    expect(listBagsFor(ALICE)).toHaveLength(0);
  });

  it('живая запись С файлом на диске остаётся — не задета этой проверкой', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now, { firstFetchedAt: now });

    expect(cleanupBags(now)).toEqual({ removed: 0, kept: 1 });
    expect(bagMetaOf(key)).toBeDefined();
  });
});

// ─── Мелочь — _saveBagMeta создаёт свой каталог сама ───────────────────────
//
// Находка ревью: в отличие от образца в app.js:65 (savePushSubs делает
// fs.mkdirSync(path.dirname(PUSH_SUBS_FILE)) сама, не полагаясь на то, что
// каталог уже создан где-то ещё), _saveBagMeta ничего подобного не делала.
// На чистой установке, пока assertBagStoreReady() ещё не позвана (порядок
// вызова на старте — забота Задачи 3, а не гарантия этого модуля), первый
// же recordBag() падал с ENOENT — воспроизведено вживую.
describe('Мелочь — _saveBagMeta создаёт свой каталог сама, не полагаясь на assertBagStoreReady()', () => {
  it('recordBag не падает на чистой установке (STORAGE_DIR ещё не существует), даже если assertBagStoreReady() не звали', async () => {
    const freshStorageDir = path.join(os.tmpdir(), `hexseal-bags-nodir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    expect(fs.existsSync(freshStorageDir)).toBe(false); // предусловие: каталога действительно нет
    try {
      await withFreshBagStoreModule({ STORAGE_DIR: freshStorageDir }, async (fresh) => {
        const key = fresh.bagKeyFor(ALICE);
        // Файл самого мешка (DIR_BAGS/...) в этом сценарии намеренно не
        // создаём — recordBag() не трогает файловую систему мешков, только
        // метаиндекс, и именно на его пути лежал ENOENT.
        expect(() => fresh.recordBag({
          key, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1,
        })).not.toThrow();
        expect(fresh.bagMetaOf(key)).toBeDefined();
      });
    } finally {
      fs.rmSync(freshStorageDir, { recursive: true, force: true });
    }
  });
});

// ─── Мелочи — порядок в cleanupBags и независимость метлы/уборки от
// падения сохранения индекса ─────────────────────────────────────────────
//
// Находки ревью (две, объединены в один коммит — обе меняют одну и ту же
// функцию и один и тот же кусок управления ошибками):
// 1. Раньше файл удалялся ДО того, как удаление записи сохранялось в
//    индексе. Худший случай при падении между этими шагами — индекс,
//    обещающий файл, которого уже нет. Поменяли порядок: сохранить индекс
//    (запись уже убрана из него), потом удалить файл — худший случай
//    становится осиротевшим файлом, который подберёт обычная метла сирот
//    по mtime, а не индексом, врущим про существование.
// 2. sweepOrphanFiles/removeEmptyRecipientDirs стояли ПОСЛЕ сохранения
//    индекса и не выполнялись вовсе, если сохранение бросало (I2) — хотя
//    обе операции работают с файловой системой напрямую, не зависят от
//    успеха сохранения индекса.
describe('Мелочи — cleanupBags: индекс сохраняется до удаления файла, метла/уборка не зависят от падения сохранения', () => {
  it('индекс сохраняется на диск ДО удаления файла мешка — порядок операций подтверждён напрямую', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 40 * DAY); // просрочен

    const order = [];
    const realWriteFileSync = fs.writeFileSync;
    const realUnlinkSync = fs.unlinkSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      order.push('write-index');
      return realWriteFileSync(...args);
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((...args) => {
      order.push('unlink-file');
      return realUnlinkSync(...args);
    });
    try {
      cleanupBags(now);
    } finally {
      writeSpy.mockRestore();
      unlinkSpy.mockRestore();
    }

    const writeIdx = order.indexOf('write-index');
    const unlinkIdx = order.indexOf('unlink-file');
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(unlinkIdx).toBeGreaterThan(writeIdx);
  });

  // Находка ревью (И-1, пятый раунд): предыдущая версия этого теста
  // утверждала, что метла сирот отрабатывает НЕЗАВИСИМО от судьбы
  // сохранения индекса — верно для НАСТОЯЩИХ сирот, но не для файлов,
  // которые сам этот проход cleanupBags только что убрал из _bagMeta В
  // ПАМЯТИ ради ожидающегося удаления. Если сохранение падает, эти ключи
  // пропадают из _bagMeta немедленно (до самого падения), но НА ДИСКЕ
  // индекс их всё ещё обещает — с точки зрения sweepOrphanFiles (она смотрит
  // только на текущий _bagMeta в памяти) такой файл неотличим от настоящего
  // неиндексированного сироты. Воспроизведено: файл удалён — да; индекс на
  // диске продолжает его обещать — да. Ровно то состояние, которое
  // предыдущий реордер (сохранить индекс до удаления файла) обещал
  // исключить. sweepOrphanFiles() теперь принимает protectedKeys — ключи
  // этого самого прохода, чьё удаление из _bagMeta ещё не подтверждено
  // диском — и не трогает их, но всё ещё метёт НЕСВЯЗАННЫЕ настоящие
  // сироты в том же проходе.
  it('метла сирот не сносит файл, чьё удаление из индекса не сохранилось на диск', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 40 * DAY); // непрочитан, просрочен — попадёт в keysToDeleteFiles

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC (симулировано)');
    });
    try {
      expect(() => cleanupBags(now)).toThrow();
    } finally {
      writeSpy.mockRestore();
    }

    // Сохранение не удалось — на диске индекс всё ещё обещает этот файл.
    // Метла НЕ ДОЛЖНА была его тронуть, несмотря на то, что mtime файла
    // (40 дней) старше её порога (30 дней).
    expect(fs.existsSync(path.join(DIR_BAGS, key))).toBe(true);
  });

  it('упавшее сохранение индекса НЕ отменяет метлу сирот и уборку пустых каталогов для НЕСВЯЗАННЫХ настоящих сирот', () => {
    const now = Date.now();
    put(ALICE, BOB, now - 40 * DAY); // просроченная индексированная запись — её сохранение ниже упадёт

    // Настоящий, независимый от индекса файл-сирота — метла обязана снести
    // его независимо от того, удалось ли сохранить индекс: он никогда не
    // был частью _bagMeta в этом проходе (или в каком-либо другом), так что
    // рассинхрон память/диск его не касается вообще.
    const orphanDir = path.join(DIR_BAGS, BOB);
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphan = path.join(orphanDir, 'stale-orphan.bin');
    fs.writeFileSync(orphan, 'x');
    const old = new Date(now - 40 * DAY);
    fs.utimesSync(orphan, old, old);

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC (симулировано)');
    });
    try {
      expect(() => cleanupBags(now)).toThrow(); // сохранение по-прежнему бросает (I2) — это не глотаем
    } finally {
      writeSpy.mockRestore();
    }

    // Метла сирот и уборка пустых каталогов всё равно отработали — но
    // только над файлами, не связанными с провалившимся сохранением.
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(orphanDir)).toBe(false); // опустевший каталог Боба тоже убран
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

  // ─── И-3 (пятый раунд) — окружение читается заново в assertBagStoreReady,
  // не заморожено на импорте ────────────────────────────────────────────
  //
  // Находка ревью: app.js зовёт dotenv.config() В ТЕЛЕ, после того как ESM
  // уже вычислил все импорты (тот же урок, что убил пропуск в Задаче 1,
  // только с другой стороны). BAG_TTL_MS/BAG_UNREAD_TTL_MS/BAG_MAX_AGE_MS/
  // MAX_BAG_SIZE/DIR_BAGS раньше замораживались НА ИМПОРТЕ — assertBagStoreReady()
  // проверяла уже замороженные значения, а не то, что реально лежит в
  // process.env к моменту её вызова. Собран фальшивый app.js той же
  // структуры (import раньше dotenv) и подтверждено вживую: все четыре
  // ручки, задокументированные в .env.vps.example, ни на что не влияли, а
  // DIR_BAGS указывал не в тот корень, что files/, logs/ и public/ —
  // assertBagStoreReady() молчала, потому что проверяла замороженные
  // значения.
  //
  // ВАЖНО про сам тест: `const { X } = await import(...)` — это СНИМОК
  // значения на момент деструктуризации, а не живая ссылка (в отличие от
  // статического `import { X } from '...'`). Чтобы увидеть эффект
  // assertBagStoreReady(), нужно читать fresh.BAG_TTL_MS как свойство
  // объекта модуля КАЖДЫЙ РАЗ заново, не один раз деструктурировать.
  it('поменять окружение ПОСЛЕ импорта модуля, позвать assertBagStoreReady() — все пять ручек подхватывают новое значение', async () => {
    const savedEnv = {
      BAG_TTL_MS: process.env.BAG_TTL_MS,
      BAG_UNREAD_TTL_MS: process.env.BAG_UNREAD_TTL_MS,
      BAG_MAX_AGE_MS: process.env.BAG_MAX_AGE_MS,
      MAX_BAG_SIZE: process.env.MAX_BAG_SIZE,
      STORAGE_DIR: process.env.STORAGE_DIR,
    };
    const { vi } = await import('vitest');

    const storageDirAtImport = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-i3-import-'));
    const storageDirAfterDotenv = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-i3-dotenv-'));

    process.env.STORAGE_DIR = storageDirAtImport; // "до dotenv.config()"
    vi.resetModules();
    const fresh = await import('../bagStore.js'); // импорт — как в app.js, раньше dotenv

    try {
      // "dotenv.config() в теле app.js" — окружение меняется ПОСЛЕ импорта.
      process.env.BAG_TTL_MS        = '86400000'; // 1 день вместо 7
      process.env.BAG_UNREAD_TTL_MS = '3600000';  // 1 час вместо 30 дней
      process.env.BAG_MAX_AGE_MS    = '7200000';  // 2 часа вместо 90 дней
      process.env.MAX_BAG_SIZE      = '1024';     // 1 КБ вместо 256 КБ
      process.env.STORAGE_DIR       = storageDirAfterDotenv;

      fresh.assertBagStoreReady();

      expect(fresh.BAG_TTL_MS).toBe(86400000);
      expect(fresh.BAG_UNREAD_TTL_MS).toBe(3600000);
      expect(fresh.BAG_MAX_AGE_MS).toBe(7200000);
      expect(fresh.MAX_BAG_SIZE).toBe(1024);
      expect(fresh.DIR_BAGS).toBe(path.join(storageDirAfterDotenv, 'bags'));
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(storageDirAtImport, { recursive: true, force: true });
      fs.rmSync(storageDirAfterDotenv, { recursive: true, force: true });
      vi.resetModules();
      // Возвращаем модульный реестр в состояние, которого ждут остальные
      // тесты этого файла (тот же STORAGE_DIR=TMP, что и на момент верхнего
      // импорта).
      await import('../bagStore.js');
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

  // Находка ревью (мелочь h): на нестроковом входе (null/undefined/число)
  // appPairIdFromAddresses бросает (несёт .toLowerCase() на не-строке), а
  // _pairIdFromAddresses раньше молча делала String(null).toLowerCase() ===
  // 'null' и возвращала мусорный, но "успешный" pairId вроде
  // '0xb0b1…-null'. Сверочный набор CASES выше этого не покрывал — сверял
  // только валидные адреса. Теперь обе стороны бросают на одном и том же
  // не-адресном входе.
  it.each([
    [null, BOB],
    [ALICE, undefined],
    [42, BOB],
    [ALICE, {}],
  ])('на не-адресном входе (%s, %s) обе версии бросают, ни одна не выдаёт мусор молча', (a, b) => {
    expect(() => _pairIdFromAddresses(a, b)).toThrow();
    expect(() => appPairIdFromAddresses(a, b)).toThrow();
  });

  // Осознанное расхождение, не находка: app.js вообще не проверяет форму
  // адреса (только .toLowerCase(), без ETH_ADDR_RE) — 'not-an-address' там
  // не бросает, просто участвует в сортировке как обычная строка.
  // _pairIdFromAddresses теперь строже (валидирует через assertAddress,
  // как и остальные функции этого модуля) и бросает там, где app.js — нет.
  // Это не сверяется на равенство специально: у app.js для этого входа нет
  // "правильного" значения, с которым можно было бы сверяться.
  it('на мусорной, но строковой форме адреса bagStore-версия строже app.js — осознанно, не находка', () => {
    expect(() => _pairIdFromAddresses('not-an-address', BOB)).toThrow();
    expect(() => appPairIdFromAddresses('not-an-address', BOB)).not.toThrow();
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

  // Находка ревью: комментарий над модулем раньше утверждал, что список
  // мешков адресата — это чтение одного каталога на диске. Неправда: код
  // фильтрует метаиндекс в памяти, а не читает DIR_BAGS/<recipient>/.
  // Комментарий приведён в соответствие; этот тест — сам замок на
  // выбранное устройство, а не описание сегодняшнего поведения: если бы
  // listBagsFor() когда-нибудь стала читать каталог, эта запись (в
  // индексе, но без файла на диске) пропала бы из выдачи.
  it('listBagsFor отдаёт запись из индекса, даже если физического файла на диске никогда не было — источник правды это индекс, не каталог', () => {
    const key = bagKeyFor(ALICE);
    recordBag({ key, sender: BOB, recipient: ALICE, size: 1, uploadedAt: 1000 });
    const list = listBagsFor(ALICE);
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe(key);
  });
});
