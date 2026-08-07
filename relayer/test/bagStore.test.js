import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-'));
process.env.STORAGE_DIR = TMP;

// И-2 (шестой раунд ревью) — ЛОВУШКА ДЛЯ ЗАДАЧИ 3, читай перед тем, как
// копировать этот импорт куда-то ещё. Проверено живьём:
//   const { MAX_BAG_SIZE } = await import('./bagStore.js');
//   // 262144 — СНИМОК на момент этой строки, не поедет никогда, даже
//   // после assertBagStoreReady() с другим окружением.
//   bagStore.MAX_BAG_SIZE
//   // живая связка — актуальное значение сразу после переприсваивания
//   // внутри bagStore.js.
// DIR_BAGS/BAG_TTL_MS/BAG_UNREAD_TTL_MS/BAG_MAX_AGE_MS/MAX_BAG_SIZE в
// bagStore.js — `export let` (И-3, пятый раунд), обновляемые
// assertBagStoreReady(). Именованный ES-экспорт `let`, взятый через
// СТАТИЧЕСКИЙ `import { X } from '...'` (или через свойство объекта
// модуля, как здесь), — живая связка. Но `const { X } = await import(...)`
// — деструктуризация РЕЗУЛЬТАТА динамического импорта — копирует значение
// НА МОМЕНТ ЭТОЙ СТРОКИ и ничего больше не отслеживает; JS в этом не
// делает разницы между "будет меняться" и "не будет" — снимок одинаково
// незаметно неверен что для мутируемых полей, что для констант. Поэтому
// пять полей ниже НЕ деструктурированы — читаются как bagStore.DIR_BAGS и
// т.д. по всему файлу. Функции (bagKeyFor, recordBag, …) не
// переприсваиваются никогда — деструктурировать их безопасно.
//
// Задаче 3: то же правило для app.js — всё, что нужно ПОСЛЕ вызова
// assertBagStoreReady(), обязано читаться через пространство имён модуля
// (или через статический import), а не через переменную, деструктуриро-
// ванную из динамического import() до этого вызова.
const bagStore = await import('../bagStore.js');
const { bagKeyFor, recordBag, markFetched, listBagsFor, listBagsBySender, bagMetaOf,
        bagExpiryAt, cleanupBags, _loadBagMeta, _saveBagMeta, _pairIdFromAddresses,
        assertBagStoreReady, bagPathFor } = bagStore;

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
  fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key)), { recursive: true });
  fs.writeFileSync(path.join(bagStore.DIR_BAGS, key), Buffer.from('sealed'));
  // C1 (ревью координатора): раньше файл всегда писался "сейчас", какой бы
  // uploadedAt ни клался в индекс — так что ни один тест не мог отличить
  // "уцелел, потому что метла сирот уважает индекс" от "уцелел, потому что
  // файл физически свежий". В реальности файл пишется ОДИН раз, его mtime
  // ≈ его настоящее время загрузки — здесь та же связь: mtime следует за
  // uploadedAt, а не за моментом вызова put() в тесте.
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

// Находка ревью (мелочь, пятый раунд): этот хелпер раньше был объявлен на
// 1080+ строк ниже своего первого использования — работало только за счёт
// всплытия объявления function (function declaration), тот же паттерн
// class ошибок, что чинился в самом модуле этим же раундом (C1, четвёртый
// раунд — BAG_KEY_RE в temporal dead zone). Перенесён сюда, к остальной
// инфраструктуре теста, до первого использования.
//
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

describe('bagExpiryAt — три правила в заданном порядке', () => {
  it('непрочитанный живёт 30 дней от загрузки', () => {
    const m = { uploadedAt: 1000, firstFetchedAt: null, dealDeadline: null };
    expect(bagExpiryAt(m)).toBe(1000 + bagStore.BAG_UNREAD_TTL_MS);
  });

  it('прочитанный живёт 7 дней ОТ ПРОЧТЕНИЯ, а не от загрузки', () => {
    const m = { uploadedAt: 1000, firstFetchedAt: 1000 + 20 * DAY, dealDeadline: null };
    expect(bagExpiryAt(m)).toBe(1000 + 20 * DAY + bagStore.BAG_TTL_MS);
  });

  it('сделка перебивает оба срока', () => {
    const deadline = 1000 + 50 * DAY;
    const m = { uploadedAt: 1000, firstFetchedAt: 1000 + DAY, dealDeadline: deadline };
    expect(bagExpiryAt(m)).toBe(deadline);
  });

  // C1 (координатор, критическая находка): потолок BAG_MAX_AGE_MS больше НЕ
  // применяется здесь, внутри bagExpiryAt() — раньше он был Math.min(dealDeadline,
  // ceiling) прямо в этой функции, и это оказалось дырой: потолок мог быть
  // снят навсегда флагом НА ЗАПИСИ (meta.dealFunded), не зависящим от того,
  // какая именно сделка сейчас продлевает срок. Потолок переехал в
  // adoptPairBags() — решение "резать или нет" принимается НА КАЖДОЕ
  // продление отдельно, ДО того как кандидат попадает в meta.dealDeadline
  // (см. test/bagAdoption.test.js, describe "C1" — там же настоящий замер
  // "храповик 1000 дней неоплаченной сделкой не двигает срок"). bagExpiryAt()
  // теперь ДОВЕРЯЕТ meta.dealDeadline как уже готовому, правильно обрезанному
  // (или намеренно безлимитному) значению — её единственная работа —
  // Math.max(base, dealDeadline), без какого-либо потолка внутри.
  it('bagExpiryAt() берёт dealDeadline КАК ЕСТЬ, без внутреннего потолка — потолок теперь целиком в adoptPairBags()', () => {
    const m = { uploadedAt: 1000, firstFetchedAt: null, dealDeadline: 1000 + 900 * DAY };
    // Сырое, ничем не обрезанное значение — ровно то, что дал бы вызов
    // adoptPairBags(..., funded=true) (оплаченная сделка законно даёт срок
    // дальше потолка). bagExpiryAt() не должен и не может знать, была ли
    // сделка, выдавшая ИМЕННО ЭТО значение, оплачена — это знание уже
    // применено ДО того, как значение попало в meta.dealDeadline.
    expect(bagExpiryAt(m)).toBe(1000 + 900 * DAY);
  });

  it('срок сделки короче обычного не сокращает жизнь мешку', () => {
    // Усыновление продлевает, а не обрезает: сделка, закрывшаяся завтра, не
    // должна стирать переписку, которой по обычному правилу жить ещё месяц.
    const m = { uploadedAt: 1000, firstFetchedAt: null, dealDeadline: 1000 + DAY };
    expect(bagExpiryAt(m)).toBe(1000 + bagStore.BAG_UNREAD_TTL_MS);
  });

  // Находка ревью (мелочь c): фактический потолок усыновлённого мешка — это
  // bagStore.BAG_MAX_AGE_MS + bagStore.BAG_TTL_MS (90+7д), не просто bagStore.BAG_MAX_AGE_MS (90д).
  // Прямое следствие «усыновление не обрезает» (тест выше): если мешок
  // усыновлён сделкой и прочитан за миг до 90-дневного потолка, правило 2
  // (7д от прочтения) само по себе даёт срок ДОЛЬШЕ потолка — и потолок
  // это не укорачивает, он ограничивает только вклад самой сделки, а не
  // итоговый результат Math.max. Не баг, задокументировано в комментарии
  // над bagExpiryAt(); этот тест — сам замок, а не описание сегодняшнего
  // поведения.
  //
  // C1 (координатор, критическая находка): потолок теперь применяется в
  // adoptPairBags(), ДО того, как значение попадает в meta.dealDeadline —
  // здесь, в bagExpiryAt(), dealDeadline подаётся УЖЕ ОБРЕЗАННЫМ (ровно
  // тем, что дал бы adoptPairBags() неоплаченной сделке), не сырым
  // "далеко за потолком" значением — тест теперь про то, что base
  // (правило 2) может ПЕРЕБИТЬ уже обрезанный dealDeadline через
  // Math.max, не про capping внутри самой bagExpiryAt() (её там больше
  // нет).
  it('мешок с уже обрезанным потолком dealDeadline (типичный результат adoptPairBags для неоплаченной сделки), прочитанный у самой границы, живёт фактически 90+7 дней', () => {
    const uploadedAt = 1000;
    const ceiling = uploadedAt + bagStore.BAG_MAX_AGE_MS;      // номинальный потолок (90д)
    const readAtCeiling = ceiling - 1;                // прочитан за миллисекунду до потолка
    const m = {
      uploadedAt,
      firstFetchedAt: readAtCeiling,
      dealDeadline: ceiling,           // уже обрезан потолком — ровно то, что даёт adoptPairBags() неоплаченной сделке
    };
    const expiry = bagExpiryAt(m);
    expect(expiry).toBe(readAtCeiling + bagStore.BAG_TTL_MS);   // правило 2 берёт верх над уже обрезанным dealDeadline
    expect(expiry).toBeGreaterThan(ceiling);            // и это ЗА пределами номинальных 90 дней
    expect(expiry - uploadedAt).toBeLessThanOrEqual(bagStore.BAG_MAX_AGE_MS + bagStore.BAG_TTL_MS); // но не больше 90+7
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
    expect(bagExpiryAt(m)).toBe(0 + bagStore.BAG_TTL_MS); // правило 2 (прочитан), не правило 3
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
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, old))).toBe(false);
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, read))).toBe(true);
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, deal))).toBe(true);
    expect(bagMetaOf(old)).toBeUndefined();   // запись из индекса тоже ушла
  });

  it('чистка не спотыкается о файл, которого нет в индексе, и наоборот', () => {
    fs.mkdirSync(path.join(bagStore.DIR_BAGS, ALICE), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, ALICE, 'осиротевший.bin'), 'x');
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

// ─── listBagsBySender — Задача 1 плана «Клиент чата» ──────────────────────
//
// Зеркало listBagsFor() выше: та же самая живая _bagMeta, тот же O(n) обход
// без единого обращения к диску, но фильтр по meta.sender вместо
// meta.recipient. Понадобилась, потому что GET /bags до сих пор отвечал
// только про то, что адресовано владельцу пропуска, — отправитель не мог
// узнать судьбу собственных мешков (docs/superpowers/specs/2026-08-06-chat-
// client-design.md, §3.3/3.4). app.js строит на ней поля `sent` и `peers`.
describe('listBagsBySender — зеркало listBagsFor, взгляд отправителя (Задача 1 плана «Клиент чата»)', () => {
  it('отдаёт только мешки, отправленные ЭТИМ адресом', () => {
    put(ALICE, BOB, Date.now());   // BOB -> ALICE
    put(BOB, ALICE, Date.now());   // ALICE -> BOB
    expect(listBagsBySender(BOB)).toHaveLength(1);
    expect(listBagsBySender(BOB)[0].recipient).toBe(ALICE);
    expect(listBagsBySender(ALICE)).toHaveLength(1);
    expect(listBagsBySender(ALICE)[0].recipient).toBe(BOB);
  });

  it('бросает на негодном по форме адресе — тот же контракт, что у listBagsFor', () => {
    expect(() => listBagsBySender('not-an-address')).toThrow();
    expect(() => listBagsBySender(null)).toThrow();
    expect(() => listBagsBySender(42)).toThrow();
  });

  it('отдаёт в хронологическом порядке (по uploadedAt), даже если записаны вразнобой', () => {
    const second = put(ALICE, BOB, 2000);
    const first  = put(ALICE, BOB, 1000);
    const third  = put(ALICE, BOB, 3000);
    expect(listBagsBySender(BOB).map((b) => b.key)).toEqual([first, second, third]);
  });

  it('пуст, если этот адрес ничего не отправлял', () => {
    put(ALICE, BOB, Date.now());
    expect(listBagsBySender(ALICE)).toEqual([]);
  });
});

// ─── listBagsBySender и режим недоверия ────────────────────────────────────
//
// Подводный камень координатора (найден при ревью замысла, до реализации):
// у записи, реконструированной _scanDiskBags() из одного только имени файла
// (см. её докстринг и candidate.sender === '' там же), отправитель не
// восстановим — recipient и uploadedAt несёт само имя файла
// ("<recipient>/<uploadedAt>-<uuid>.bin"), а вот кто прислал мешок, знает
// только сам сервер в момент PUT (bagPass), и это знание живёт исключительно
// в описи. Опись потеряна — значит и знание потеряно, не приблизительно, а
// совсем: подставить НИЧЕГО не значит "предположить самый вероятный
// вариант", это значит соврать.
//
// listBagsBySender(addr) фильтрует meta.sender === addr, а addr всегда —
// настоящий, проверенный ETH_ADDR_RE адрес (assertAddress бросает на любом
// другом виде входа) — значит meta.sender === '' НИКОГДА ни с одним таким
// addr не совпадёт. Реконструированная запись остаётся невидимой для
// listBagsBySender автоматически, без отдельной ветки "а если недоверие" —
// это следствие формы данных, а не отдельная проверка режима, которую
// можно забыть обновить at the next refactor.
describe('listBagsBySender в режиме недоверия — отправитель реконструированной записи неизвестен, значит не приписывается никому', () => {
  it('реконструированный (из одного имени файла) мешок не числится отправленным ни за одним настоящим адресом', () => {
    const oldKey = manualKey(ALICE, Date.now() - DAY);
    const fp = path.join(bagStore.DIR_BAGS, oldKey);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');

    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8'); // индекса нет, склад не пуст
    _loadBagMeta(); // режим недоверия — реконструкция

    expect(listBagsFor(ALICE)).toHaveLength(1); // получатель виден — он был в имени файла
    expect(listBagsBySender(BOB)).toEqual([]);   // отправитель — нет, ни для кого
    expect(listBagsBySender(ALICE)).toEqual([]); // включая саму получательницу
  });

  it('недоверие не отключает функцию целиком — мешок, честно записанный ЖИВЫМ recordBag() ПОСЛЕ входа в режим недоверия (сервер сам проверил пропуск, sender не реконструирован), виден немедленно', () => {
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');
    _loadBagMeta(); // режим недоверия, склад пуст на этот момент

    const key = bagKeyFor(ALICE);
    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, key), 'sealed');
    recordBag({ sender: BOB, recipient: ALICE, key, size: 6, uploadedAt: Date.now() });

    // Не персистировано на диск (см. "выход из режима" ниже и существующий
    // тест на recordBag() в недоверии выше в файле) — но в ПАМЯТИ отправитель
    // настоящий, не выдуманный, так что listBagsBySender обязана его видеть.
    expect(listBagsBySender(BOB)).toHaveLength(1);
  });

  it('доверие восстанавливается честной загрузкой описи — listBagsBySender сразу видит настоящего отправителя, без перезапуска процесса или какого-либо ручного шага сверх самой _loadBagMeta()', () => {
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');
    _loadBagMeta(); // режим недоверия
    expect(listBagsBySender(BOB)).toEqual([]);

    // Человек чинит индекс руками — валидная запись с НАСТОЯЩИМ отправителем
    // (не тем, что мог бы придумать сам сервер).
    const key = bagKeyFor(ALICE);
    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, key), 'sealed');
    writeRawBagMeta({ [key]: validRawMeta({ sender: BOB, recipient: ALICE, uploadedAt: 1000 }) });

    _loadBagMeta(); // единственное действие для выхода — честная загрузка

    expect(listBagsBySender(BOB)).toHaveLength(1);
    expect(listBagsBySender(BOB)[0].key).toBe(key);
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
    const orphanDir = path.join(bagStore.DIR_BAGS, ALICE);
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphan = path.join(orphanDir, 'stale-orphan.bin');
    fs.writeFileSync(orphan, 'x');
    const old = new Date(now - 40 * DAY);
    fs.utimesSync(orphan, old, old);   // старше bagStore.BAG_UNREAD_TTL_MS и не в индексе

    cleanupBags(now);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('свежий файл-сирота, которого ещё нет в индексе, чистка не трогает', () => {
    const now = Date.now();
    const orphanDir = path.join(bagStore.DIR_BAGS, ALICE);
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
    // bagStore.BAG_UNREAD_TTL_MS (30д), метла сирот снесла бы его, если бы не
    // проверяла индекс в первую очередь.
    const adopted40 = put(ALICE, BOB, now - 40 * DAY, { dealDeadline: now + 10 * DAY });
    // Прочитан вчера, но САМ мешок 40 дней от роду — тот же риск.
    const read40 = put(ALICE, BOB, now - 40 * DAY, { firstFetchedAt: now - 1 * DAY });
    // Усыновлённый, 80 дней от роду — под потолком bagStore.BAG_MAX_AGE_MS (90д), но
    // куда старше порога сирот (30д). Именно этот случай координатор назвал
    // отдельно: «мешок под потолком на 80-й день».
    const adopted80 = put(ALICE, BOB, now - 80 * DAY, { dealDeadline: now + 400 * DAY });

    cleanupBags(now);

    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, adopted40))).toBe(true);
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, read40))).toBe(true);
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, adopted80))).toBe(true);
  });

  it('порог сирот — это буквально bagStore.BAG_UNREAD_TTL_MS, не какое-то другое число: неиндексированный файл чуть моложе порога выживает, чуть старше — сносится', () => {
    const now = Date.now();
    const orphanDir = path.join(bagStore.DIR_BAGS, ALICE);
    fs.mkdirSync(orphanDir, { recursive: true });

    const survivor = path.join(orphanDir, 'just-under-threshold.bin');
    fs.writeFileSync(survivor, 'x');
    const justUnder = new Date(now - bagStore.BAG_UNREAD_TTL_MS + 60_000); // на минуту моложе порога
    fs.utimesSync(survivor, justUnder, justUnder);

    const doomed = path.join(orphanDir, 'just-over-threshold.bin');
    fs.writeFileSync(doomed, 'x');
    const justOver = new Date(now - bagStore.BAG_UNREAD_TTL_MS - 60_000); // на минуту старше порога
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

  it('recordBag бросает, если size больше bagStore.MAX_BAG_SIZE — мешок это сообщение, не вложение', () => {
    expect(() => recordBag({
      key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: bagStore.MAX_BAG_SIZE + 1, uploadedAt: 1,
    })).toThrow();
    // Ровно на границе — ещё годно.
    expect(() => recordBag({
      key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: bagStore.MAX_BAG_SIZE, uploadedAt: 1,
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

  // Находка ревью (И-3, шестой раунд), воспроизведена вживую отдельным
  // скриптом: мешок с uploadedAt = сейчас+100 лет переживает любую чистку
  // и истечёт только через сто лет. Потолок BAG_MAX_AGE_MS ограничивает
  // только вклад ВЕТКИ УСЫНОВЛЕНИЯ (min(dealDeadline, uploadedAt +
  // BAG_MAX_AGE_MS)) — а base (правило 2/3) считается ПРЯМО от uploadedAt,
  // так что произвольно далёкое будущее в uploadedAt отодвигает срок
  // истечения на то же произвольно далёкое время, потолок тут вообще не
  // участвует. Если Задача 3 возьмёт uploadedAt из тела запроса, срок
  // хранения обходится НАВСЕГДА — прямое нарушение обещания "сервер
  // физически не может стать архивом".
  it('recordBag отвергает uploadedAt из будущего — иначе срок хранения обходится навсегда', () => {
    const now = Date.now();
    const farFuture = now + 100 * 365 * DAY;
    expect(() => recordBag({
      key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: 1, uploadedAt: farFuture,
    }, now)).toThrow();
  });

  it('recordBag принимает uploadedAt в пределах небольшого допуска на расхождение часов', () => {
    const now = Date.now();
    const key = bagKeyFor(ALICE);
    // Чуть в будущем — в пределах допуска на рассинхрон часов клиента и
    // сервера, это не то же самое, что "выдумать" произвольную дату.
    expect(() => recordBag({
      key, sender: BOB, recipient: ALICE, size: 1, uploadedAt: now + 60_000,
    }, now)).not.toThrow();
  });

  it('recordBag принимает uploadedAt в прошлом без ограничений (никогда не было проблемой)', () => {
    const now = Date.now();
    expect(() => recordBag({
      key: bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: 1, uploadedAt: now - 40 * DAY,
    }, now)).not.toThrow();
  });

  // Мелочь (шестой раунд): допуск на рассинхрон часов — тоже "лимит" по
  // прямому правилу задачи ("все сроки/лимиты — env-конфигурируемы с явным
  // умолчанием"), не только четыре TTL/размер. Тест поведенческий (не
  // просто "экспортированное значение изменилось") — с CLOCK_SKEW_ALLOWANCE_MS,
  // выставленным окружением в 0, тот же +60с uploadedAt, что выше принимался
  // штатным 5-минутным допуском, теперь отвергается.
  it('CLOCK_SKEW_ALLOWANCE_MS настраивается окружением — с допуском 0 то же +60с из прошлого теста уже отвергается', async () => {
    await withFreshBagStoreModule({ CLOCK_SKEW_ALLOWANCE_MS: '0' }, async (fresh) => {
      const now = Date.now();
      expect(() => fresh.recordBag({
        key: fresh.bagKeyFor(ALICE), sender: BOB, recipient: ALICE, size: 1, uploadedAt: now + 60_000,
      }, now)).toThrow();
    });
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
// прямо в fs.unlinkSync(path.join(bagStore.DIR_BAGS, key)). '../not-a-bag.txt' как
// key удалял файл ЗА ПРЕДЕЛАМИ bagStore.DIR_BAGS; '<боб>/x.bin' с recipient=alice
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

  it('bagPathFor отдаёт путь внутри bagStore.DIR_BAGS для годного ключа', () => {
    const key = bagKeyFor(ALICE);
    const p = bagPathFor(key);
    expect(p).toBe(path.join(bagStore.DIR_BAGS, key));
    expect(path.resolve(p).startsWith(path.resolve(bagStore.DIR_BAGS) + path.sep)).toBe(true);
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

  // Находка ревью (шестой раунд, мелочь): toHaveBeenCalled() без разбора,
  // ЧЕМ вызван spy, — тест зелёный, даже если убрать ОДИН из двух
  // console.error в _loadBagMeta() (построчный — "какой именно ключ" — и
  // итоговый — "сколько всего отброшено"), пока жив другой. Оба несут разную
  // информацию (какая запись битая vs. сколько их) и оба реально нужны для
  // разбора инцидента — тест обязан ловить пропажу любого из двух, а не
  // просто факт, что console.error хоть раз да вызвался.
  it('отбраковка отбитых записей логируется и построчно (какой ключ), и сводкой (сколько всего) — не тихо и не только одним из двух', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const goodKey = bagKeyFor(ALICE);
      const poisonedKey1 = bagKeyFor(ALICE);
      const poisonedKey2 = bagKeyFor(ALICE);
      writeRawBagMeta({
        [goodKey]: validRawMeta({ uploadedAt: 1000 }),
        [poisonedKey1]: validRawMeta({ uploadedAt: 'oops' }),
        [poisonedKey2]: validRawMeta({ sender: 'not-an-address' }),
      });
      _loadBagMeta();

      const messages = spy.mock.calls.map((call) => call.join(' '));
      expect(messages.some((m) => m.includes(poisonedKey1))).toBe(true);
      expect(messages.some((m) => m.includes(poisonedKey2))).toBe(true);
      expect(messages.some((m) => m.includes('dropped 2 corrupt entries out of 3'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // Находка ревью (пятый раунд): фикстура клала uploadedAt: now - 40 дней,
  // но writeRawBagMeta файла на диске не создавала — с реальным (после
  // мелочи g, четвёртый раунд) кодом такая запись уходит веткой «файла
  // нет», а не по сроку, независимо от того, работает ли вообще проверка
  // срока. Отключение удаления по сроку целиком краснит 7 других тестов, а
  // этот — нет: он проверял не то, что заявлено в названии. Тот же класс,
  // что уже ловили дважды. Теперь фикстура создаёт настоящий файл на
  // диске, так что удаление возможно только веткой «просрочен».
  it('после отбраковки cleanupBags не бросает и нормально дочищает остальное — ядовитая запись больше не блокирует весь проход', () => {
    const now = Date.now();
    const expiredGoodKey = bagKeyFor(ALICE);
    const poisonedKey = bagKeyFor(ALICE);

    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, expiredGoodKey)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, expiredGoodKey), 'sealed');
    const old = new Date(now - 40 * DAY);
    fs.utimesSync(path.join(bagStore.DIR_BAGS, expiredGoodKey), old, old);

    writeRawBagMeta({
      [expiredGoodKey]: validRawMeta({ uploadedAt: now - 40 * DAY }), // непрочитан, просрочен
      [poisonedKey]: validRawMeta({ uploadedAt: 'oops' }),
    });
    _loadBagMeta();

    expect(() => cleanupBags(now)).not.toThrow();
    expect(bagMetaOf(expiredGoodKey)).toBeUndefined(); // нормально дочищен
    // Файл реально удалён — доказательство, что сработала ветка "просрочен",
    // а не "файла нет" (файл-то как раз есть).
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, expiredGoodKey))).toBe(false);
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
    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, poisonedKey)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, poisonedKey), 'sealed');
    writeRawBagMeta({ [poisonedKey]: validRawMeta({ uploadedAt: 'oops' }) });

    _loadBagMeta();

    expect(bagMetaOf(poisonedKey)).toBeUndefined();
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, poisonedKey))).toBe(true);
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

// ─── Третий тур закрывающего ревью Задачи 4 (chat-transport-storage) —
// «режим недоверия» ─────────────────────────────────────────────────────────
//
// Заменяет оба предыдущих раунда целиком (карантин + немедленный персист
// реконструкции) — координатор воспроизвёл живыми процессами четыре входа, в
// каждом 0 из 3 настоящих мешков выжило: обрыв в окне «карантин →
// сохранение» (~840мс на 100 000 мешков, ~3,6с на суточном объёме заливки из
// п. 28.2, замерено), кончившееся место ИМЕННО при сохранении (та же
// причина, от которой опись и бьётся — две громкие строки в лог, процесс
// жив, опись исчезла навсегда), второй процесс, поднявшийся внутри окна
// обхода первого, и нечитаемый DIR_BAGS в момент восстановления (глухой
// catch отдавал пустую реконструкцию, которая сохранялась как достоверная —
// том не примонтирован → следующей ночью снесено всё). И заявление
// «восстановленный живёт дольше, а не меньше» тоже было неверным: гейт стоял
// только на метле сирот, а основной цикл истечения срока в cleanupBags()
// был открыт всегда — мешок с полусотней оставшихся дней удалялся
// немедленно в том же прогоне, где лог печатал «описи нельзя верить».
//
// Новый режим не пишет на диск вообще, пока недоверие не снято честной
// загрузкой: битый файл описи остаётся на месте (он и есть признак, не
// мусор для уборки), реконструкция — только в памяти, новые мешки во время
// недоверия тоже не персистятся (recordBag/markFetched — см. там же), не
// удаляется ничего ни метлой сирот, ни основным циклом (единый гейт в
// начале cleanupBags()). Выход из режима — только когда _loadBagMeta()
// честно, штатно прочитала индекс; никакой автоматики через время или
// счётчик попыток.

function manualKey(recipient, uploadedAtMs) {
  return `${recipient}/${uploadedAtMs}-${randomUUID()}.bin`;
}

describe('третий тур закрывающего ревью Задачи 4 — режим недоверия: ничего не пишем и не удаляем, пока индекс не заслужил доверие заново', () => {
  it('склад (DIR_BAGS) нечитаем — не то же самое, что пуст — режим недоверия даже при штатно прочитанной описи', () => {
    const now = Date.now();
    const key = bagKeyFor(ALICE);
    // Опись валидна и содержит просроченную запись — но диск с самими
    // мешками "не примонтирован" в момент загрузки. DIR_BAGS обязан
    // физически существовать для этого сценария (beforeEach его сносит) —
    // иначе _isDiskReadable() коротким замыканием на "каталога нет вовсе"
    // читает это как легитимную пустоту и мок ниже никогда не вызывается.
    fs.mkdirSync(bagStore.DIR_BAGS, { recursive: true });
    writeRawBagMeta({ [key]: validRawMeta({ uploadedAt: now - 40 * DAY }) });

    const realReaddirSync = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(bagStore.DIR_BAGS)) {
        throw new Error('EIO (симулировано): том не примонтирован');
      }
      return realReaddirSync(p, ...rest);
    });
    try {
      _loadBagMeta();
    } finally {
      spy.mockRestore();
    }

    const res = cleanupBags(now);
    expect(res.removed).toBe(0); // ничего не удалено, несмотря на явно просроченную запись в валидной описи

    const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8'));
    expect(Object.keys(onDisk)).toEqual([key]); // опись на диске не тронута — ни записана, ни изменена
  });

  it('обрыв в любой момент — битая опись остаётся на месте нетронутой; второй запуск (или второй процесс) снова видит тот же признак', () => {
    const garbage = '{ not valid json';
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), garbage, 'utf8');

    _loadBagMeta(); // "запуск" 1
    expect(fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8')).toBe(garbage);

    _loadBagMeta(); // "перезапуск"/второй процесс — тот же файл, тот же результат
    expect(fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8')).toBe(garbage);

    expect(cleanupBags(Date.now()).removed).toBe(0);
  });

  it('основной цикл удаления тоже под гейтом — реконструированный мешок, "просроченный" по своему uploadedAt, всё равно не удаляется в режиме недоверия', () => {
    const now = Date.now();
    const oldUploadedAt = now - 40 * DAY; // за пределами BAG_UNREAD_TTL_MS (30д) — "выглядит просроченным"
    const key = manualKey(ALICE, oldUploadedAt);
    const fp = path.join(bagStore.DIR_BAGS, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');

    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');
    _loadBagMeta(); // реконструкция видит запись, "просроченную" по её же uploadedAt

    cleanupBags(now);

    expect(fs.existsSync(fp)).toBe(true);
  });

  it('выход из режима — только после честной загрузки описи, не после первой записи', () => {
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');
    _loadBagMeta();

    // "Кладём один новый мешок" во время недоверия — ровно шаг из отчёта
    // координатора, который раньше "чинил" файл валидным JSON с одной
    // записью и тем самым молча снимал недоверие на следующем перезапуске.
    const key = bagKeyFor(ALICE);
    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, key), 'sealed');
    recordBag({ sender: BOB, recipient: ALICE, key, size: 6, uploadedAt: Date.now() });

    // Опись на диске остаётся ИМЕННО тем, чем была ('null') — запись не
    // персистируется и не "чинит" режим недоверия.
    expect(fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8')).toBe('null');
    expect(cleanupBags(Date.now()).removed).toBe(0); // гейт всё ещё держит

    // Только теперь человек чинит файл руками — валидный (пустой) индекс.
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), '{}', 'utf8');
    _loadBagMeta(); // честная загрузка — выход из режима

    // Доказательство выхода: новая запись ТЕПЕРЬ персистится нормально.
    const key2 = bagKeyFor(BOB);
    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key2)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, key2), 'sealed');
    recordBag({ sender: ALICE, recipient: BOB, key: key2, size: 6, uploadedAt: Date.now() });
    const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8'));
    expect(Object.keys(onDisk)).toEqual([key2]);
  });

  it('сквозной сценарий целиком (сценарий координатора): битая опись → запуск → новый мешок → перезапуск → ночная чистка → все мешки живы', () => {
    const now = Date.now();

    // Мешок, принятый ДО того, как индекс потерялся.
    const key1 = bagKeyFor(ALICE);
    const fp1 = path.join(bagStore.DIR_BAGS, key1);
    fs.mkdirSync(path.dirname(fp1), { recursive: true });
    fs.writeFileSync(fp1, 'sealed-1');

    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), '{ not valid json', 'utf8');

    _loadBagMeta(); // "запуск"
    cleanupBags(now); // ночная чистка №1 — ничего не удаляет

    expect(fs.existsSync(fp1)).toBe(true);

    // "Новый мешок" — во время недоверия.
    const key2 = bagKeyFor(BOB);
    const fp2 = path.join(bagStore.DIR_BAGS, key2);
    fs.mkdirSync(path.dirname(fp2), { recursive: true });
    fs.writeFileSync(fp2, 'sealed-2');
    recordBag({ sender: ALICE, recipient: BOB, key: key2, size: 8, uploadedAt: now });

    // "Перезапуск" — тот же битый файл на месте, недоверие снова.
    _loadBagMeta();
    cleanupBags(now); // ночная чистка №2

    expect(fs.existsSync(fp1)).toBe(true);
    expect(fs.existsSync(fp2)).toBe(true);
    // Битая опись всё ещё на месте — ничего не подменено на протяжении сценария.
    expect(fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8')).toBe('{ not valid json');
  });

  // ─── Мелочи ревью — числом, не рассуждением ────────────────────────────

  it('метка времени восстановленного мешка берётся из имени файла, не из "сейчас" (мутация "подменить источник времени" красит именно этот тест)', () => {
    const specificUploadedAt = Date.now() - 17 * DAY; // произвольное, заведомо не "сейчас"
    const key = manualKey(ALICE, specificUploadedAt);
    const fp = path.join(bagStore.DIR_BAGS, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');

    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');
    _loadBagMeta();

    expect(bagMetaOf(key).uploadedAt).toBe(specificUploadedAt);
  });

  // Защита в глубину, проверено мутациями по отдельности: снятие ЛИБО
  // явной проверки `BAG_KEY_RE.test(key)` в цикле реконструкции, ЛИБО
  // повторного прогона через isValidBagMetaEntry() (который сам зовёт
  // assertBagKey → ту же форму) поодиночке НЕ красят этот тест — вторая
  // линия защиты подстраховывает первую (для "not-a-bag-key.txt" разбор
  // метки времени даёт NaN, и assertSafeInt его отбраковывает уже внутри
  // isValidBagMetaEntry). Снятие ОБЕИХ проверок разом — красит: мусорный
  // файл входит в индекс с uploadedAt: NaN.
  it('файл с именем, не совпадающим с формой bagKeyFor(), не попадает в реконструкцию', () => {
    const garbageDir = path.join(bagStore.DIR_BAGS, ALICE);
    fs.mkdirSync(garbageDir, { recursive: true });
    fs.writeFileSync(path.join(garbageDir, 'not-a-bag-key.txt'), 'x');

    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');
    _loadBagMeta();

    expect(listBagsFor(ALICE)).toEqual([]);
  });

  // Не тавтология "мешок теперь в описи, поэтому жив" (координатор отметил
  // именно эту слабость прошлого теста): каталог получателя временно
  // нечитаем ИМЕННО в момент реконструкции, поэтому его настоящий мешок
  // сознательно НЕ попадает в индекс — и всё равно переживает чистку, потому
  // что гейт cleanupBags() не смотрит на индекс вообще, пока режим
  // недоверия активен.
  it('гейт защищает и там, где реконструкция неполна — каталог БОБа временно нечитаем при реконструкции, его мешок не индексируется, но чистка его не трогает', () => {
    const now = Date.now();
    const key = bagKeyFor(BOB);
    const fp = path.join(bagStore.DIR_BAGS, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');
    const old = new Date(now - 40 * DAY); // старше порога сирот — обычная метла снесла бы, будь она разрешена
    fs.utimesSync(fp, old, old);

    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');

    const bobDir = path.join(bagStore.DIR_BAGS, BOB);
    const realReaddirSync = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(bobDir)) {
        throw new Error('EACCES (симулировано): каталог получателя временно нечитаем');
      }
      return realReaddirSync(p, ...rest);
    });
    try {
      _loadBagMeta(); // реконструкция видит DIR_BAGS, но не каталог БОБа конкретно — мешок пропущен
    } finally {
      spy.mockRestore();
    }

    // Проверка предпосылки — иначе тест снова стал бы тавтологией.
    expect(bagMetaOf(key)).toBeUndefined();

    cleanupBags(now); // без гейта sweepOrphanFiles() снёс бы этот файл как сироту

    expect(fs.existsSync(fp)).toBe(true);
  });

  it('консервативность сверяется с исходным сроком ДО потери описи, а не с формулой заново (иначе смена источника времени осталась бы незамеченной)', () => {
    const now = Date.now();
    const originalUploadedAt = now - 5 * DAY; // мешку 5 дней, ещё 25 дней жизни по правилу 3
    const originalExpiry = originalUploadedAt + bagStore.BAG_UNREAD_TTL_MS; // посчитан ДО восстановления, из истинного uploadedAt

    const key = manualKey(ALICE, originalUploadedAt);
    const fp = path.join(bagStore.DIR_BAGS, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');

    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');
    _loadBagMeta();

    const meta = bagMetaOf(key);
    expect(meta).toBeDefined();
    // Не короче и не длиннее — точно тот же срок, что был бы без потери описи.
    expect(bagExpiryAt(meta)).toBe(originalExpiry);
  });

  it('реконструкция прогоняет кандидатов через те же проверки, что recordBag(): симлинк наружу склада, каталог, файл сверх MAX_BAG_SIZE и метка времени из будущего — все четыре исключены', () => {
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');
    const now = Date.now();

    // 1) Симлинк, цель которого — файл СНАРУЖИ DIR_BAGS. lstat (не stat) не
    // должен следовать за ним — иначе через GET /bags/:key стало бы можно
    // скачать что угодно, до чего дотягивается процесс релеера.
    const outsideTarget = path.join(TMP, 'outside-secret.txt');
    fs.writeFileSync(outsideTarget, 'not a bag, must never be reachable through /bags/*');
    const symlinkKey = manualKey(ALICE, now);
    const symlinkPath = path.join(bagStore.DIR_BAGS, symlinkKey);
    fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
    fs.symlinkSync(outsideTarget, symlinkPath);

    // 2) Каталог там, где должен быть файл мешка.
    const dirKey = manualKey(ALICE, now);
    fs.mkdirSync(path.join(bagStore.DIR_BAGS, dirKey), { recursive: true });

    // 3) Файл больше MAX_BAG_SIZE — не мог быть легитимно записан через recordBag().
    const oversizedKey = manualKey(ALICE, now);
    const oversizedPath = path.join(bagStore.DIR_BAGS, oversizedKey);
    fs.mkdirSync(path.dirname(oversizedPath), { recursive: true });
    fs.writeFileSync(oversizedPath, Buffer.alloc(bagStore.MAX_BAG_SIZE + 1));

    // 4) Метка времени на самом верху 15-значного потолка BAG_KEY_RE —
    // буквально "33658 год" из отчёта координатора.
    const farFutureMs = Number('9'.repeat(15));
    const futureKey = manualKey(ALICE, farFutureMs);
    const futurePath = path.join(bagStore.DIR_BAGS, futureKey);
    fs.mkdirSync(path.dirname(futurePath), { recursive: true });
    fs.writeFileSync(futurePath, 'sealed');

    _loadBagMeta();

    for (const key of [symlinkKey, dirKey, oversizedKey, futureKey]) {
      expect(bagMetaOf(key)).toBeUndefined();
    }
  });
});

// ─── Продолжение третьего тура — отсутствие описи не всегда легитимная
// пустота ───────────────────────────────────────────────────────────────
//
// Найдено координатором сразу после третьего тура (собственная проверка
// отчёта, не новое ревью): «человек убрал или починил файл» — формулировка
// самого координатора для выхода из режима недоверия — на практике
// означает «человек, скорее всего, выберет убрать: это естественнее
// починки». Но отсутствие описи неотличимо от свежей установки, если
// смотреть только на сам файл — а свежая установка ЕЩЁ и склад пустой.
// Воспроизведено с числами (см. коммит): 35-дневный мешок переживал режим
// недоверия, а на первой же чистке ПОСЛЕ удаления битого файла и
// перезапуска — умирал немедленно, потому что "описи нет" читалось как
// "доверие", доверие снимало гейт, а метла сирот мела по mtime как обычно.
//
// Правило: описи нет и склад пуст (или отсутствует) → свежая установка,
// доверие. Описи нет, а склад не пуст → несогласованность, не установка —
// режим недоверия так же, как и остальные три причины.
describe('продолжение третьего тура — отсутствие описи легитимно пусто только вместе с пустым складом', () => {
  it('описи нет + склад физически пуст (каталог существует, но в нём ничего) → доверие, обычная работа, удаление разрешено', () => {
    fs.mkdirSync(bagStore.DIR_BAGS, { recursive: true }); // каталог есть, но пуст
    _loadBagMeta();

    const now = Date.now();
    const key = bagKeyFor(ALICE);
    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, key), 'sealed');
    recordBag({ sender: BOB, recipient: ALICE, key, size: 6, uploadedAt: now - 40 * DAY }); // сразу просрочен

    const res = cleanupBags(now);
    expect(res.removed).toBe(1); // удаление РАЗРЕШЕНО — доверие есть, не режим недоверия
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, key))).toBe(false);
  });

  it('каталога склада нет вовсе → доверие (это действительно чистая установка)', () => {
    fs.rmSync(bagStore.DIR_BAGS, { recursive: true, force: true }); // не просто пуст — отсутствует
    _loadBagMeta();

    expect(cleanupBags(Date.now()).removed).toBe(0); // нечего удалять, но это НЕ недоверие

    // Доказательство доверия, не просто "нечего делать": новая запись
    // персистится нормально, а не остаётся только в памяти.
    const key = bagKeyFor(ALICE);
    fs.mkdirSync(path.dirname(path.join(bagStore.DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(bagStore.DIR_BAGS, key), 'sealed');
    recordBag({ sender: BOB, recipient: ALICE, key, size: 6, uploadedAt: Date.now() });
    const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'bag-meta.json'), 'utf8'));
    expect(Object.keys(onDisk)).toEqual([key]);
  });

  it('описи нет, а мешки на диске лежат → режим недоверия, мешок старше тридцати дней НЕ удалён', () => {
    const now = Date.now();
    const uploadedAt = now - 40 * DAY;
    const key = manualKey(ALICE, uploadedAt);
    const fp = path.join(bagStore.DIR_BAGS, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');
    // C1 (напоминание из предыдущих раундов): mtime файла должен ЧЕСТНО
    // отражать uploadedAt, а не остаться "сейчас" — иначе тест проходит по
    // случайности (файл слишком молод для sweepOrphanFiles() по mtime), а
    // не потому, что режим недоверия действительно защищает. Найдено этим
    // же прогоном (мутация "снять проверку непустого склада" не красила
    // тест до этого фикса).
    const old = new Date(uploadedAt);
    fs.utimesSync(fp, old, old);
    // bag-meta.json НЕ существует вовсе — beforeEach это уже гарантировал.

    _loadBagMeta();
    cleanupBags(now);

    expect(fs.existsSync(fp)).toBe(true);
  });

  it('строка в лог для "описи нет, мешки есть" — отдельная и внятная: число найденных файлов, что убрать для чистого листа, что вернуть для восстановления', () => {
    const key = manualKey(ALICE, Date.now() - 5 * DAY);
    const fp = path.join(bagStore.DIR_BAGS, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      _loadBagMeta();
      const messages = spy.mock.calls.map((call) => call.join(' '));
      expect(messages.some((m) => m.includes('MISSING') && m.includes('1 file(s) found'))).toBe(true);
      expect(messages.some((m) => m.toLowerCase().includes('remove the bag files'))).toBe(true);
      expect(messages.some((m) => m.toLowerCase().includes('restore the index file'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // Главный тест координатора — тот самый сценарий из отчёта, теперь с
  // требованием "обязан остаться жив" вместо прежнего "сегодня умирает".
  it('сценарий координатора целиком: 35-дневный мешок переживает недоверие, человек удаляет опись, ночная чистка — мешок ОБЯЗАН остаться жив', () => {
    const now = Date.now();
    const uploadedAt = now - 35 * DAY;
    const key = manualKey(ALICE, uploadedAt);
    const fp = path.join(bagStore.DIR_BAGS, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');
    // Честный mtime — та же причина, что в тесте выше: без этого файл
    // пережил бы обе чистки просто по молодости, а не благодаря режиму
    // недоверия, и тест не ловил бы регресс на втором (главном) шаге.
    const old = new Date(uploadedAt);
    fs.utimesSync(fp, old, old);

    // Индекс бьётся — режим недоверия, мешок не удалён (уже проверено
    // третьим туром, но нужно для полноты сценария целиком).
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), '{ not valid json', 'utf8');
    _loadBagMeta();
    cleanupBags(now);
    expect(fs.existsSync(fp)).toBe(true);

    // Человек "чинит" удалением файла — самый естественный, но неверный шаг.
    fs.rmSync(path.join(TMP, 'bag-meta.json'), { force: true });

    // Перезапуск + ночная чистка.
    _loadBagMeta();
    cleanupBags(now);

    expect(fs.existsSync(fp)).toBe(true); // раньше снесён этим же шагом — теперь обязан выжить
  });

  // Координатор явно попросил проверить мутацией, что новая ветка не
  // разлочила старые две.
  it('регресс-гейт: "склад не прочитался" (бросок, не пустой список) по-прежнему даёт недоверие', () => {
    fs.mkdirSync(bagStore.DIR_BAGS, { recursive: true }); // должен физически существовать для мока ниже
    const now = Date.now();
    const key = bagKeyFor(ALICE);
    writeRawBagMeta({ [key]: validRawMeta({ uploadedAt: now - 40 * DAY }) }); // валидная опись сама по себе

    const realReaddirSync = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(bagStore.DIR_BAGS)) {
        throw new Error('EIO (симулировано): том не примонтирован');
      }
      return realReaddirSync(p, ...rest);
    });
    try {
      _loadBagMeta();
    } finally {
      spy.mockRestore();
    }

    expect(cleanupBags(now).removed).toBe(0); // всё ещё недоверие
  });

  it('регресс-гейт: "опись не парсится" по-прежнему даёт недоверие', () => {
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8');
    const now = Date.now();
    const key = manualKey(ALICE, now - 40 * DAY);
    const fp = path.join(bagStore.DIR_BAGS, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');

    _loadBagMeta();
    cleanupBags(now);

    expect(fs.existsSync(fp)).toBe(true); // недоверие держит, как и раньше
  });
});

// ─── Закрывающий раунд (после режима недоверия) — метла ходит по симлинкам,
// а самодельная опись убивает молча ────────────────────────────────────────
//
// Две находки координатора поверх режима недоверия, обе не про сам режим:
//
// 1. sweepOrphanFiles()/removeEmptyRecipientDirs() обходили каталоги
//    получателей через fs.statSync() — СЛЕДУЕТ за симлинком. Каталог
//    получателя, вынесенный симлинком на другой том (обычное действие
//    администратора при нехватке места, не атака), проходил isDirectory()
//    как настоящий каталог — обход уходил по ссылке НАСКВОЗЬ и удалял файлы
//    ФИЗИЧЕСКИ СНАРУЖИ DIR_BAGS. Не зависит от режима недоверия — тот же
//    побег в обычном, доверенном режиме с честной пустой описью. Заменено
//    на lstatSync (тот же приём, что уже был в реконструкции) — симлинк не
//    проходит isDirectory(), обход внутрь не спускается.
//
// 2. "echo '{}' > bag-meta.json" — синтаксически валидная, но пустая опись
//    — неотличима от настоящей персистированной пустоты. Режим недоверия
//    (прошлый коммит) закрыл случай "человек удалил файл"; эта находка —
//    случай "человек сделал, чтобы парсилось", то есть буквально то, что
//    подсказывает лог "restore the index file". Кода-фикса нет и не будет
//    — легитимный конец жизни ("все мешки истекли, индекс честно пуст")
//    неотличим от подделки по содержимому файла, а завязываться на разницу
//    в таймингах между записью файла на диск и обновлением описи означало
//    бы сломать саму идею уборщика (нормальная гонка "файл уже есть, опись
//    ещё не успела" при обычной загрузке стала бы неотличима от подделки).
//    Задокументировано текстом (громкое предупреждение в логе режима
//    недоверия) и заперто тестом ГРАНИЦЫ — чтобы поведение было известным,
//    а не забытым.
describe('закрывающий раунд — метла не ходит по симлинкам; самодельная опись — задокументированная граница, не баг', () => {
  it('каталог получателя-симлинк не даёт метле выйти за пределы DIR_BAGS и удалить чужие файлы (обычный доверенный режим, без связи с режимом недоверия)', () => {
    const now = Date.now();
    const outsideDir = fs.mkdtempSync(path.join(TMP, 'outside-volume-'));
    const outsideFiles = ['a.bin', 'b.bin', 'c.bin'].map((name) => {
      const fp = path.join(outsideDir, name);
      fs.writeFileSync(fp, 'not a bag, must never be reachable through DIR_BAGS');
      const old = new Date(now - 40 * DAY); // старше порога сирот — метла снесла бы, если бы добралась
      fs.utimesSync(fp, old, old);
      return fp;
    });

    // Каталог получателя ВЫНЕСЕН симлинком на другой том — обычное
    // администраторское действие, не атака. DIR_BAGS обязан физически
    // существовать (beforeEach его сносит) — иначе symlinkSync падает на
    // отсутствующем родителе, и это была бы ошибка теста, не находка.
    fs.mkdirSync(bagStore.DIR_BAGS, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(bagStore.DIR_BAGS, ALICE));

    // Опись валидна и пуста — обычный, доверенный режим; ничего не связано
    // с режимом недоверия (та часть уже заперта отдельными тестами).
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), '{}', 'utf8');
    _loadBagMeta();

    cleanupBags(now);

    for (const fp of outsideFiles) {
      expect(fs.existsSync(fp)).toBe(true);
    }

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('контроль того же измерения: та же раскладка (симлинк с реальными файлами), но опись битая → режим недоверия, ноль снесено', () => {
    const now = Date.now();
    const outsideDir = fs.mkdtempSync(path.join(TMP, 'outside-volume-'));
    const outsideFiles = ['a.bin', 'b.bin', 'c.bin'].map((name) => {
      const fp = path.join(outsideDir, name);
      fs.writeFileSync(fp, 'not a bag');
      const old = new Date(now - 40 * DAY);
      fs.utimesSync(fp, old, old);
      return fp;
    });
    fs.mkdirSync(bagStore.DIR_BAGS, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(bagStore.DIR_BAGS, ALICE));

    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), '{ not valid json', 'utf8');
    _loadBagMeta(); // режим недоверия — единый гейт в cleanupBags() ниже даже не дойдёт до sweepOrphanFiles()

    cleanupBags(now);

    for (const fp of outsideFiles) {
      expect(fs.existsSync(fp)).toBe(true);
    }

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  // Задокументированная граница, не цель для фикса — координатор явно
  // отказался придумывать код-фикс без ломки идеи уборщика. Название теста
  // сформулировано так, чтобы следующий человек, наткнувшись на него, понял:
  // это известное поведение, а не пропущенный баг.
  it('ГРАНИЦА (не баг): валидная самодельная опись ("echo \'{}\' > bag-meta.json") при непустом складе неотличима от настоящей пустоты — мешки становятся сиротами и умирают по mtime независимо от прочтения или усыновления сделкой', () => {
    const now = Date.now();

    function put(recipient, uploadedAt, extra = {}) {
      const key = manualKey(recipient, uploadedAt);
      const fp = path.join(bagStore.DIR_BAGS, key);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, 'sealed');
      const mtime = new Date(uploadedAt);
      fs.utimesSync(fp, mtime, mtime); // честный mtime — файл пишется один раз, при загрузке
      recordBag({ sender: BOB, recipient, key, size: 6, uploadedAt, ...extra });
      return { key, fp };
    }

    // Все трое загружены 35 дней назад (mtime уже за порогом метлы сирот,
    // BAG_UNREAD_TTL_MS = 30д) — но под ЧЕСТНЫМ индексом у двух из трёх
    // было бы намного больше жизни впереди.
    const uploadedAt = now - 35 * DAY;
    const wouldHaveExpiredAnyway = put(ALICE, uploadedAt); // ничем не защищён — умер бы и по-честному
    const recentlyRead = put(ALICE, uploadedAt, { firstFetchedAt: now }); // правило 2: ещё BAG_TTL_MS от СЕГОДНЯ
    const dealAdopted = put(ALICE, uploadedAt, { dealDeadline: now + 60 * DAY }); // правило 1: ещё ~55д

    // Проверка не голословна: под настоящим индексом оба защищены далеко
    // вперёд от "сейчас" — bagExpiryAt считает именно так.
    expect(bagExpiryAt(bagMetaOf(recentlyRead.key))).toBeGreaterThan(now);
    expect(bagExpiryAt(bagMetaOf(dealAdopted.key))).toBeGreaterThan(now + 50 * DAY);

    // Человек "чинит" опись самой естественной командой — валидный, но
    // пустой JSON. Лог теперь явно предупреждает не делать так (см. текст
    // ниже) — но именно это легко набрать не читая.
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), '{}', 'utf8');
    _loadBagMeta(); // индекс парсится штатно — ДОВЕРИЕ восстановлено, тихо, без единой строки лога

    cleanupBags(now);

    // Задокументированная граница: ВСЕ трое сочтены сиротами и снесены —
    // не только тот, что истёк бы и без потери индекса.
    expect(fs.existsSync(wouldHaveExpiredAnyway.fp)).toBe(false);
    expect(fs.existsSync(recentlyRead.fp)).toBe(false);
    expect(fs.existsSync(dealAdopted.fp)).toBe(false);
  });

  it('предупреждение в логе режима недоверия прямо называет опасность самодельной описи и безопасные действия', () => {
    const key = manualKey(ALICE, Date.now() - 5 * DAY);
    const fp = path.join(bagStore.DIR_BAGS, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');
    fs.writeFileSync(path.join(TMP, 'bag-meta.json'), 'null', 'utf8'); // любая из четырёх причин недоверия подходит

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      _loadBagMeta();
      const messages = spy.mock.calls.map((call) => call.join(' '));
      const warning = messages.find((m) => m.includes('ENTERING DISTRUST MODE'));
      expect(warning).toBeDefined();
      expect(warning.toLowerCase()).toContain('do not');
      expect(warning.toLowerCase()).toContain('empty');
      expect(warning.toLowerCase()).toContain('just as destructive');
      expect(warning.toLowerCase()).toContain('restore the real index from a backup');
      expect(warning.toLowerCase()).toContain('remove both the index file and every bag file');
    } finally {
      spy.mockRestore();
    }
  });

  // Мелочь координатора: осколки bag-meta.json.tmp-* после обрыва (диск
  // кончился/процесс убит между writeFileSync и renameSync в _saveBagMeta())
  // раньше не подметались НИКЕМ — копятся именно тогда, когда обрывы и
  // случаются чаще всего.
  it('осколки bag-meta.json.tmp-* после обрыва подметаются обычной чисткой', () => {
    const stale = `${path.join(TMP, 'bag-meta.json')}.tmp-99999-${Date.now()}-deadbeef-0000-4000-8000-000000000000`;
    fs.writeFileSync(stale, 'partial write, process died here');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 часа — заведомо дольше одной записи+переименования
    fs.utimesSync(stale, old, old);

    cleanupBags(Date.now());

    expect(fs.existsSync(stale)).toBe(false);
  });

  it('свежий .tmp-* файл (только что созданный) не трогается — не забегать вперёд активной записи', () => {
    const fresh = `${path.join(TMP, 'bag-meta.json')}.tmp-99999-${Date.now()}-deadbeef-0000-4000-8000-000000000001`;
    fs.writeFileSync(fresh, 'partial write, still in progress');
    // mtime = сейчас (fs.writeFileSync уже это гарантирует, без utimesSync).

    cleanupBags(Date.now());

    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(fresh, { force: true });
  });

  // Мелочь координатора (замер): ветка "описи нет" была дороже ветки
  // "опись битая" — 445мс против 411мс на 60 000 мешков — потому что склад
  // обходился дважды (счёт, потом реконструкция). Слито в _scanDiskBags() —
  // один обход. Считаем реальные вызовы fs.readdirSync() на КОНКРЕТНОМ
  // каталоге получателя, а не полагаемся на общее время (шумно на малых
  // объёмах, которые уместны в юнит-тесте).
  it('мелочь координатора: ветка "описи нет, склад не пуст" обходит каталог получателя ОДИН раз, не дважды', () => {
    const key = manualKey(ALICE, Date.now() - 5 * DAY);
    const fp = path.join(bagStore.DIR_BAGS, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'sealed');

    const aliceDir = path.join(bagStore.DIR_BAGS, ALICE);
    const realReaddirSync = fs.readdirSync;
    let aliceDirScans = 0;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(aliceDir)) aliceDirScans++;
      return realReaddirSync(p, ...rest);
    });
    try {
      _loadBagMeta();
    } finally {
      spy.mockRestore();
    }

    expect(aliceDirScans).toBe(1);
  });
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

  // Бесплатное улучшение от ревьюера (пятый раунд): assertBagKeyShape уже
  // запирает '__proto__'/'constructor' на входе каждой публичной функции —
  // но это защита по форме КЛЮЧА, симптоматическая. _bagMeta =
  // Object.create(null) убирает КЛАСС травления прототипа структурно: у
  // такого объекта нет '__proto__' как унаследованного аксессора вообще,
  // независимо от того, дошёл ли до него мусорный ключ мимо проверки формы
  // (например, из будущего кода, который забудет её позвать).
  it('_bagMeta не наследует Object.prototype — структурная защита, не только проверка формы ключа', () => {
    const meta = _loadBagMeta();
    expect(Object.getPrototypeOf(meta)).toBeNull();
  });
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

  // Находка ревью (И-4, пятый раунд): предыдущие тесты запирают «запись
  // идёт через временный путь» и «обрыв во время записи в temp не портит
  // основной», но сам АТОМАРНЫЙ ШАГ ПУБЛИКАЦИИ — замена временного файла
  // основным — не заперт ничем. Замена fs.renameSync(tmp, BAG_META_PATH)
  // на fs.copyFileSync(tmp, BAG_META_PATH) + fs.unlinkSync(tmp) — НЕ
  // атомарная публикация (между copy и unlink возможно прерывание,
  // оставляющее либо неполный BAG_META_PATH, либо дубль на диске) —
  // проверено: проходит весь набор теста целиком. Замок — впрямую на
  // fs.renameSync: и на сам факт вызова, и на то, что переименовывается
  // именно временный путь во ФАЙЛ ОСНОВНОГО ИНДЕКСА, а не что-то ещё.
  it('публикация индекса идёт через настоящий fs.renameSync(temp, основной) — атомарный шаг заперт напрямую', () => {
    const mainPath = path.join(TMP, 'bag-meta.json');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    try {
      put(ALICE, BOB, 1000);
    } finally {
      expect(renameSpy).toHaveBeenCalledTimes(1);
      const [src, dest] = renameSpy.mock.calls[0];
      expect(dest).toBe(mainPath);
      expect(src).not.toBe(dest);
      expect(String(src)).toContain('bag-meta.json.tmp-');
      renameSpy.mockRestore();
    }
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

  // Находка ревью (мелочь, пятый раунд): уборка временного файла при
  // отказе (try { fs.unlinkSync(tmpPath); } catch {} в catch-ветке
  // _saveBagMeta) в коде была, но ничем не заперта — .tmp-* мог копиться в
  // корне STORAGE_DIR, где его не подберёт ни метла сирот (метёт только
  // bagStore.DIR_BAGS/<recipient>/, не корень), ни ежедневная чистка файлов, именно
  // на исчерпании места, когда отказы и случаются. Реально создаём
  // временный файл (не бросаем ДО записи), потом валим публикацию
  // (renameSync) — и проверяем, что временный файл всё равно исчез.
  it('_saveBagMeta подчищает временный файл, если публикация (rename) не удалась — не копится мусором в STORAGE_DIR', () => {
    put(ALICE, BOB, 1000);

    let capturedTmpPath;
    const realWriteFileSync = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath, data, ...rest) => {
      capturedTmpPath = filePath;
      return realWriteFileSync(filePath, data, ...rest); // реально пишем — временный файл появляется на диске
    });
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EXDEV (симулировано) — публикация не удалась уже после записи временного файла');
    });

    try {
      expect(() => _saveBagMeta()).toThrow();
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }

    expect(capturedTmpPath).toBeDefined();
    expect(fs.existsSync(capturedTmpPath)).toBe(false);
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
// а потолок bagStore.BAG_MAX_AGE_MS считается ОТ uploadedAt. Повторной записью того
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
// появился (правило 2 считает firstFetchedAt + bagStore.BAG_TTL_MS, и если
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
    const uploadedAt = now - bagStore.BAG_UNREAD_TTL_MS; // bagExpiryAt(m) === uploadedAt + bagStore.BAG_UNREAD_TTL_MS === now
    const key = put(ALICE, BOB, uploadedAt);
    expect(bagExpiryAt(bagMetaOf(key))).toBe(now); // предусловие: граница ровно на now

    cleanupBags(now);
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, key))).toBe(false);
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

    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, ALICE))).toBe(false);
  });

  it('каталог адресата остаётся, пока в нём есть хоть один живой мешок', () => {
    const now = Date.now();
    put(ALICE, BOB, now - 40 * DAY);                      // просрочен
    put(ALICE, BOB, now, { firstFetchedAt: now });         // жив

    cleanupBags(now);

    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, ALICE))).toBe(true);
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
    const orphanDir = path.join(bagStore.DIR_BAGS, ALICE);
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

    const orphanDir = path.join(bagStore.DIR_BAGS, BOB);
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
    fs.unlinkSync(path.join(bagStore.DIR_BAGS, key)); // файл пропал, запись в индексе осталась

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
        // Файл самого мешка (bagStore.DIR_BAGS/...) в этом сценарии намеренно не
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

// ─── К-2 (аудит устойчивости, 6 августа): когда место кончилось, уборка
// обязана уметь его освободить ────────────────────────────────────────────
//
// Единственный механизм освобождения места переставал работать ровно тогда,
// когда он нужен. Замер до правки (scratchpad/measure-k2.mjs, боевые
// умолчания, ЕДИНСТВЕННАЯ подмена — writeFileSync бросает ENOSPC, как на
// настоящем полном диске; unlinkSync на полном диске работает и есть
// единственный способ освободить место):
//
//   500 просроченных мешков по 1 КиБ, диск полон
//     → освобождено 0 файлов, 0 байт.
//
// Причина — порядок: сначала писалась опись (падала на ENOSPC), и catch
// откатывал ВСЁ, так что до строчки удаления файлов управление не доходило
// НИКОГДА. Правка меняет порядок на обратный: сносим сначала, пишем потом.
// Освобождённое место — единственное, что вообще может дать записи описи
// шанс пройти в этом же прогоне.
//
// ⚠️ ВОЗРАСТ МЕШКОВ ЗДЕСЬ ВЫБРАН НАРОЧНО — не трогать, не «упрощать» до
// «просто просроченный». Первая версия этих тестов брала мешки 40-42 дней
// от загрузки, и мутация «вернуть прежний порядок» их НЕ КРАСИЛА: файл
// старше 30 дней по mtime подбирает МЕТЛА СИРОТ в finally (она работает по
// mtime и не зависит от описи вовсе), так что место освобождалось — но
// совсем другим механизмом, чем тот, который тест якобы проверяет. Тест был
// зелёным по неверной причине.
//
// Здесь мешок ПРОЧИТАН: загружен 20 дней назад, прочитан 10 дней назад,
// значит по правилу 2 (firstFetchedAt + BAG_TTL_MS = 7д) просрочен три дня
// назад. При этом его mtime — 20 дней, то есть СВЕЖЕЕ порога метлы сирот
// (30 дней): метла его не тронет НИКОГДА. Освободить это место может
// только основной цикл истечения срока — ровно тот путь, который К-2 и
// чинит.
describe('К-2 — полный диск: уборка обязана освобождать место, а не блокироваться на описи', () => {
  // Мешок, до которого метла сирот дотянуться не может: просрочен правилом
  // 2 (прочитан 10 дней назад, TTL прочитанного — 7 дней), но его файлу
  // всего 20 дней — метла сносит только то, что старше 30.
  const readAndExpired = (now) => put(ALICE, BOB, now - 20 * DAY, { firstFetchedAt: now - 10 * DAY });

  it('диск полон — файлы просроченных мешков всё равно снесены, место освобождено', () => {
    const now = Date.now();
    const keys = [readAndExpired(now), readAndExpired(now), readAndExpired(now)];
    for (const k of keys) expect(fs.existsSync(path.join(bagStore.DIR_BAGS, k))).toBe(true);

    // «Диск кончился»: ЛЮБАЯ запись нового файла падает. Удаление не
    // затронуто — именно так ведёт себя настоящая полная файловая система.
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    try {
      expect(() => cleanupBags(now)).toThrow(/ENOSPC/); // отказ описи по-прежнему громкий, не проглочен
    } finally {
      writeSpy.mockRestore();
    }

    // Главное свойство: место РЕАЛЬНО освобождено — все три файла снесены.
    for (const k of keys) {
      expect(fs.existsSync(path.join(bagStore.DIR_BAGS, k))).toBe(false);
    }
  });

  it('диск полон — память не откатывает то, что физически снесено с диска', () => {
    const now = Date.now();
    const key = readAndExpired(now);

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    try {
      expect(() => cleanupBags(now)).toThrow(/ENOSPC/);
    } finally {
      writeSpy.mockRestore();
    }

    // Откат назад в _bagMeta был бы прямым враньём: файла на диске уже нет,
    // вернуть его невозможно. Память обязана отражать то, что случилось на
    // самом деле, а не то, что успело доехать до описи.
    expect(bagMetaOf(key)).toBeUndefined();
  });
});

// ─── cleanupBags: порядок «сначала снести, потом записать» и независимость
// метлы/уборки от падения сохранения индекса ─────────────────────────────
//
// ⚠️ ПОРЯДОК ЗДЕСЬ ПЕРЕВЁРНУТ 6 августа находкой К-2 (аудит устойчивости).
// Четыре теста этого блока раньше запирали ОБРАТНОЕ правило — «сохранить
// опись, потом удалять файлы» — и откат в память при падении сохранения.
// Оба свойства были осознанным выбором пятого раунда ревью Задачи 4, и оба
// оказались куплены слишком дорого: на ПОЛНОМ ДИСКЕ запись описи падает
// первой, catch откатывает всё, и до удаления файлов управление не доходит
// никогда. Замер: 500 просроченных мешков по 1 КиБ → освобождено 0 файлов,
// 0 байт (после правки — 500 из 500, 512 000 байт). Единственный механизм
// освобождения места не работал ровно в том состоянии, ради которого он
// заведён.
//
// Что осталось верным и по-прежнему заперто здесь:
//   • отказ сохранения по-прежнему ГРОМКИЙ (бросок, не молчаливый catch) —
//     I2 не отменена;
//   • sweepOrphanFiles/removeEmptyRecipientDirs/sweepStaleTmpFiles в finally
//     работают независимо от того, упало ли сохранение — находка 2 пятого
//     раунда цела.
// Что перевёрнуто намеренно:
//   • файлы сносятся ПЕРВЫМИ (иначе см. замер выше);
//   • отката в память больше нет — файла физически нет, возвращать запись
//     означало бы обещать несуществующее (см. комментарий в cleanupBags()).
describe('cleanupBags — файлы сносятся до записи описи; метла не зависит от падения сохранения', () => {
  it('файл мешка удаляется с диска ДО записи описи — порядок операций подтверждён напрямую', () => {
    const now = Date.now();
    put(ALICE, BOB, now - 40 * DAY); // просрочен

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
    expect(unlinkIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(unlinkIdx);
  });

  // Находка ревью (И-1, пятый раунд; снята шестым): отдельный параметр
  // protectedKeys у sweepOrphanFiles() был мёртвым весом и убран. Второе
  // свойство этого теста — независимость метлы от чужого провала — от К-2
  // не зависит и остаётся: настоящая сирота сносится, даже когда сохранение
  // описи в том же проходе упало.
  it('при падении сохранения: просроченный мешок всё равно снесён, и независимая настоящая сирота — тоже', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 40 * DAY); // непрочитан, просрочен — попадёт под удаление, save упадёт

    // Настоящий, независимый от индекса файл-сирота — метла обязана снести
    // его независимо от того, удалось ли сохранить индекс: он никогда не
    // был частью _bagMeta в этом проходе (или в каком-либо другом).
    const orphanDir = path.join(bagStore.DIR_BAGS, BOB);
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

    // Свойство 1 (К-2): место освобождено, несмотря на упавшее сохранение.
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, key))).toBe(false);
    expect(bagMetaOf(key)).toBeUndefined();
    // Свойство 2: независимая настоящая сирота из ТОГО ЖЕ прохода тоже
    // снесена — метла не отключается целиком из-за чужого провала.
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(orphanDir)).toBe(false); // опустевший каталог Боба тоже убран
  });

  // Раньше этот тест запирал откат в память (дисциплина I2 из recordBag()/
  // markFetched()). К-2 его сняла — и это НЕ разнобой дисциплины, а разница
  // в обратимости: recordBag()/markFetched() при откате возвращают память к
  // состоянию, которое диск и так подтверждает; cleanupBags() к моменту
  // ошибки уже снесла файлы, и возвращать память некуда.
  it('cleanupBags НЕ откатывает удаление из памяти, если сохранение описи упало — файла всё равно уже нет', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now - 40 * DAY); // просрочен, попадёт под удаление

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC (симулировано)');
    });
    try {
      expect(() => cleanupBags(now)).toThrow();
    } finally {
      writeSpy.mockRestore();
    }

    // Память согласна с диском: мешка нет ни там, ни там. Разошлась только
    // ОПИСЬ на диске — её вылечит ветка «мелочь g» на следующем прогоне.
    expect(bagMetaOf(key)).toBeUndefined();
    expect(fs.existsSync(path.join(bagStore.DIR_BAGS, key))).toBe(false);
  });

  // «Мелочь g» — запись жива по сроку, но файла на диске нет. Удалять
  // нечего, так что К-2 здесь ничего не меняет физически; меняется только
  // то, что запись не возвращается в память при упавшем сохранении.
  it('cleanupBags не откатывает и "мелочь g" (запись без файла на диске), если сохранение упало', () => {
    const now = Date.now();
    const key = put(ALICE, BOB, now, { firstFetchedAt: now }); // формально жив ещё 7 дней
    fs.unlinkSync(path.join(bagStore.DIR_BAGS, key)); // но файл пропал — обычно это ветка "мелочь g"

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC (симулировано)');
    });
    try {
      expect(() => cleanupBags(now)).toThrow();
    } finally {
      writeSpy.mockRestore();
    }

    expect(bagMetaOf(key)).toBeUndefined(); // файла нет — память это и показывает
  });
});

describe('сроки и лимиты приходят из окружения, не пришпилены в коде', () => {
  it('умолчания совпадают с задокументированными значениями буквально', () => {
    expect(bagStore.BAG_TTL_MS).toBe(7 * DAY);
    expect(bagStore.BAG_UNREAD_TTL_MS).toBe(30 * DAY);
    expect(bagStore.BAG_MAX_AGE_MS).toBe(90 * DAY);
    expect(bagStore.MAX_BAG_SIZE).toBe(256 * 1024);
    // Мелочь (шестой раунд): CLOCK_SKEW_ALLOWANCE_MS (И-3, шестой раунд)
    // была захардкожена module-scope константой, не пятой env-ручкой —
    // отступление от прямого правила задачи "все сроки/лимиты —
    // env-конфигурируемы с явным умолчанием". Экспортирована и вынесена в
    // _refreshConfig() тем же приёмом, что и остальные четыре.
    expect(bagStore.CLOCK_SKEW_ALLOWANCE_MS).toBe(5 * 60 * 1000);
  });

  it('переменные окружения переопределяют умолчания при загрузке модуля', async () => {
    const savedEnv = {
      BAG_TTL_MS: process.env.BAG_TTL_MS,
      BAG_UNREAD_TTL_MS: process.env.BAG_UNREAD_TTL_MS,
      BAG_MAX_AGE_MS: process.env.BAG_MAX_AGE_MS,
      MAX_BAG_SIZE: process.env.MAX_BAG_SIZE,
      CLOCK_SKEW_ALLOWANCE_MS: process.env.CLOCK_SKEW_ALLOWANCE_MS,
      STORAGE_DIR: process.env.STORAGE_DIR,
    };
    process.env.BAG_TTL_MS = '1111';
    process.env.BAG_UNREAD_TTL_MS = '2222';
    process.env.BAG_MAX_AGE_MS = '3333';
    process.env.MAX_BAG_SIZE = '4444';
    process.env.CLOCK_SKEW_ALLOWANCE_MS = '5555';
    // Находка ревью (мелочь, пятый раунд): этот каталог раньше никогда не
    // удалялся — по одному в /tmp на каждый прогон теста.
    const envStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-env-'));
    process.env.STORAGE_DIR = envStorageDir;

    vi.resetModules();
    try {
      const fresh = await import('../bagStore.js');
      expect(fresh.BAG_TTL_MS).toBe(1111);
      expect(fresh.BAG_UNREAD_TTL_MS).toBe(2222);
      expect(fresh.BAG_MAX_AGE_MS).toBe(3333);
      expect(fresh.MAX_BAG_SIZE).toBe(4444);
      expect(fresh.CLOCK_SKEW_ALLOWANCE_MS).toBe(5555);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(envStorageDir, { recursive: true, force: true });
      vi.resetModules();
      // Возвращаем модульный реестр в состояние, которого ждут все остальные
      // тесты этого файла (тот же STORAGE_DIR=TMP, что и на момент верхнего
      // импорта) — resetModules() иначе оставил бы следующий import('../bagStore.js')
      // где-нибудь в этом файле указывающим на другое хранилище.
      await import('../bagStore.js');
    }
  });
});

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
    // CLOCK_SKEW_ALLOWANCE_MS (мелочь, шестой раунд) не входит в четвёрку
    // "позитивное число" — 0 для него легитимен (см. отдельный тест ниже),
    // так что здесь только нечисловое и отрицательное, не '0'.
    ['CLOCK_SKEW_ALLOWANCE_MS', 'five-minutes'],
    ['CLOCK_SKEW_ALLOWANCE_MS', '-1'],
  ])('assertBagStoreReady бросает, когда %s=%s, называя виновную переменную', async (name, value) => {
    await withFreshBagStoreModule({ [name]: value }, async (fresh) => {
      // Не просто .toThrow() — иначе тест зелёный и до реализации функции
      // (TypeError: assertBagStoreReady is not a function тоже «бросает»,
      // просто по совершенно другой причине). Сообщение обязано называть
      // переменную-виновника, не просто «что-то не так».
      expect(() => fresh.assertBagStoreReady()).toThrow(new RegExp(name));
    });
  });

  it('создаёт bagStore.DIR_BAGS, если каталога нет', () => {
    fs.rmSync(bagStore.DIR_BAGS, { recursive: true, force: true });
    expect(fs.existsSync(bagStore.DIR_BAGS)).toBe(false);
    assertBagStoreReady();
    expect(fs.existsSync(bagStore.DIR_BAGS)).toBe(true);
  });

  it('свежий импорт модуля САМ ПО СЕБЕ не создаёт bagStore.DIR_BAGS — каталог больше не побочный эффект загрузки', async () => {
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
  // только с другой стороны). bagStore.BAG_TTL_MS/bagStore.BAG_UNREAD_TTL_MS/bagStore.BAG_MAX_AGE_MS/
  // bagStore.MAX_BAG_SIZE/bagStore.DIR_BAGS раньше замораживались НА ИМПОРТЕ — assertBagStoreReady()
  // проверяла уже замороженные значения, а не то, что реально лежит в
  // process.env к моменту её вызова. Собран фальшивый app.js той же
  // структуры (import раньше dotenv) и подтверждено вживую: все четыре
  // ручки, задокументированные в .env.vps.example, ни на что не влияли, а
  // bagStore.DIR_BAGS указывал не в тот корень, что files/, logs/ и public/ —
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

  // ─── C1 (шестой раунд) — читаем индекс из одного места, пишем в другое ──
  //
  // Находка ревью: _loadBagMeta() зовётся на уровне модуля — то есть ДО
  // dotenv.config() — из "импортного" STORAGE_DIR. _refreshConfig() внутри
  // assertBagStoreReady() (И-3, пятый раунд) переставляет BAG_META_PATH на
  // боевой корень, но НЕ перечитывает индекс оттуда — в памяти остаётся то,
  // что было загружено (обычно пусто) из старого пути. Первый же
  // recordBag() сохраняет ЭТОТ почти-пустой in-memory индекс поверх
  // настоящего боевого файла — до И-3 модуль стабильно читал и писал по
  // одному (пусть и неверному) корню, эта находка о том, что фикс И-3
  // превратил "не тот корень" в "читаю из A, пишу в B", что хуже: реальные
  // записи не просто игнорируются, они СТИРАЮТСЯ первой же записью.
  // Воспроизведено отдельным скриптом до этого теста (боевой индекс на 3
  // переписки → в памяти 0 → после recordBag() боевой файл содержит 1).
  it('assertBagStoreReady() видит записи, уже лежащие по НОВОМУ (после-dotenv) пути — не теряет их при первой же записи', async () => {
    const savedEnv = { STORAGE_DIR: process.env.STORAGE_DIR };

    const storageDirAtImport = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-c1-import-'));
    const storageDirAfterDotenv = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-bags-c1-dotenv-'));

    process.env.STORAGE_DIR = storageDirAtImport; // "до dotenv.config()"
    vi.resetModules();
    const fresh = await import('../bagStore.js'); // импорт — как в app.js, раньше dotenv

    try {
      // Боевой индекс на 3 переписки уже лежит по ПРАВИЛЬНОМУ (после
      // dotenv) пути — как если бы релеер уже поработал раньше и просто
      // перезапускается.
      const bootKeys = [
        fresh.bagKeyFor(ALICE),
        fresh.bagKeyFor(ALICE),
        fresh.bagKeyFor(ALICE),
      ];
      const bootMeta = {};
      for (const [i, key] of bootKeys.entries()) {
        bootMeta[key] = {
          sender: BOB, recipient: ALICE,
          pairId: [BOB, ALICE].sort().join('-'),
          size: 6, uploadedAt: 1000 + i, firstFetchedAt: null, dealDeadline: null,
        };
      }
      fs.mkdirSync(storageDirAfterDotenv, { recursive: true });
      fs.writeFileSync(path.join(storageDirAfterDotenv, 'bag-meta.json'), JSON.stringify(bootMeta), 'utf8');

      // "dotenv.config() в теле app.js" — окружение меняется ПОСЛЕ импорта.
      process.env.STORAGE_DIR = storageDirAfterDotenv;
      fresh.assertBagStoreReady();

      expect(fresh.listBagsFor(ALICE)).toHaveLength(3);

      // И первая же запись не должна стереть эти три — иначе реордер И-3
      // превратил "не туда" в "теряю боевые данные".
      const newKey = fresh.bagKeyFor(ALICE);
      fs.mkdirSync(path.dirname(path.join(fresh.DIR_BAGS, newKey)), { recursive: true });
      fs.writeFileSync(path.join(fresh.DIR_BAGS, newKey), 'sealed');
      fresh.recordBag({ key: newKey, sender: BOB, recipient: ALICE, size: 6, uploadedAt: 4000 });

      expect(fresh.listBagsFor(ALICE)).toHaveLength(4);
      const onDisk = JSON.parse(fs.readFileSync(path.join(storageDirAfterDotenv, 'bag-meta.json'), 'utf8'));
      expect(Object.keys(onDisk)).toHaveLength(4);
      for (const key of bootKeys) expect(onDisk[key]).toBeDefined(); // все три боевые записи целы
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(storageDirAtImport, { recursive: true, force: true });
      fs.rmSync(storageDirAfterDotenv, { recursive: true, force: true });
      vi.resetModules();
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
  // фильтрует метаиндекс в памяти, а не читает bagStore.DIR_BAGS/<recipient>/.
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
