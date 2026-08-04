// ─── Склад мешков ───────────────────────────────────────────────────────────
// Хранит непрозрачные, зашифрованные на клиенте "мешки" переписки (замена
// XMTP). Всё, чем этот модуль оперирует, — адреса, размеры и время. Ни при
// записи, ни при чистке содержимое мешка не читается и не разбирается:
// сервер не имеет ключей и не должен иметь возможности узнать, что внутри.
//
// Раскладка на диске: STORAGE_DIR/bags/<recipient>/<uploadedAt>-<uuid>.bin,
// где <recipient> — адрес в нижнем регистре.
//
// Находка ревью: listBagsFor() ниже НЕ читает каталог адресата — она
// фильтрует весь _bagMeta (метаиндекс в памяти) по полю recipient. Раньше
// здесь было написано, что список конкретного получателя — это чтение
// одного каталога; неправда про то, что реально делает код, — приведено в
// соответствие. Раскладка по каталогам всё равно не бесполезна: она нужна
// sweepOrphanFiles()/removeEmptyRecipientDirs() (обходят DIR_BAGS именно
// по подкаталогам адресатов) и служит изоляцией — обход/повреждение файлов
// одного получателя физически не задевает каталог другого. Просто это не
// то же самое свойство, что "список — O(1) чтение каталога", и listBagsFor
// от него не зависит.
//
// Метаиндекс (STORAGE_DIR/bag-meta.json, в памяти — _bagMeta) — тот же приём,
// что у _filePairs / _disputeReasons в app.js: JSON на диске, загрузка при
// старте, перезапись при каждом изменении. Не импортируется из app.js и не
// импортируется туда обратно в эту сторону — сюда (в Задаче 3 app.js станет
// вызывать функции этого модуля для маршрутов приёма/выдачи, так что обратный
// импорт отсюда в app.js завёл бы цикл).
//
// Срок жизни мешка считает bagExpiryAt() по трём правилам в заданном порядке
// (усыновление сделкой → прочитан → не прочитан) — подробности в комментарии
// над самой функцией, откуда это буквально видно по коду.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;

// Ровно то, что производит bagKeyFor(): <адрес нижним регистром>/<цифры
// эпохи>-<uuid>.bin. Не проверяет версию/вариант UUID (не граница
// безопасности, просто формат) — граница здесь одна: ровно два сегмента,
// первый — адрес, второй — этот конкретный шаблон имени файла, никаких
// '..', никаких лишних '/'.
//
// НАМЕРЕННО объявлена здесь, рядом с ETH_ADDR_RE, а не рядом с остальным
// про ключи и пути ниже по файлу (C1, четвёртый раунд ревью). _loadBagMeta()
// вызывается на уровне модуля (см. ниже, сразу после объявления _bagMeta) —
// а она, через isValidBagMetaEntry → assertBagKey, читает BAG_KEY_RE. Будь
// эта константа объявлена ПОСЛЕ той точки вызова, любой перезапуск процесса
// с непустым bag-meta.json на диске превращал бы КАЖДУЮ запись в
// ReferenceError ("Cannot access 'BAG_KEY_RE' before initialization" — const
// в temporal dead zone) — а голый catch внизу принимал бы эту ошибку
// программиста за "данные битые" и тихо ронял весь индекс на каждом
// перезапуске. Ровно так и было устроено до этой находки: воспроизведено
// вживую, весь индекс терялся на первом же перезапуске с непустыми данными.
// Мелочь: [0-9]+ без потолка принимал ключ на сто тысяч цифр вместо метки
// времени как "валидный" — {1,15} даёт запас на тысячелетия вперёд
// (Date.now() сегодня — 13 цифр, 15 цифр хватит примерно до 5138 года) и
// при этом не пропускает произвольно длинную строку.
const BAG_KEY_RE = /^0x[0-9a-f]{40}\/[0-9]{1,15}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/;

// И-3 (пятый раунд): раньше STORAGE_DIR/DIR_BAGS/BAG_META_PATH и все
// четыре срока/лимита были `const`, посчитанными РОВНО ОДИН РАЗ на
// импорте. app.js зовёт dotenv.config() В ТЕЛЕ, после того как ESM уже
// вычислил все импорты (тот же урок, что чуть не убил пропуск в Задаче 1
// про SERVER_SECRET — только с другой стороны: там не читали ДО dotenv,
// здесь заморозили и никогда не перечитывали). Собран фальшивый app.js той
// же структуры (импорт раньше dotenv) — подтверждено вживую: .env говорит
// одно, факт (то, чем реально пользуется модуль) — совсем другое, а
// assertBagStoreReady() молчала, потому что проверяла уже замороженные
// значения (и её же сообщение об ошибке читало process.env ПОСЛЕ dotenv —
// могло называть значение, которое не проверялось).
//
// Экспорт остался по тем же именам (BAG_TTL_MS и т.д.), потому что это ES
// module — именованный экспорт `let` это ЖИВАЯ ссылка на текущее значение
// переменной модуля, не снимок на момент импорта: `import { BAG_TTL_MS }
// from './bagStore.js'` или чтение `namespace.BAG_TTL_MS` всегда видит
// актуальное значение после переприсваивания внутри этого модуля.
// (Единственное исключение — деструктуризация РЕЗУЛЬТАТА динамического
// import(): `const { X } = await import(...)` копирует значение в момент
// деструктуризации, а не создаёт живую ссылку; тест ниже читает
// namespace.BAG_TTL_MS явно по этой причине.)
//
// _refreshConfig() — единственное место, где эти семь переменных
// пересчитываются из process.env; вызывается один раз при импорте (как и
// раньше) и повторно из assertBagStoreReady() — так весь остальной код
// модуля просто читает текущие module-level `let`, не заботясь о том,
// когда именно они в последний раз обновлялись.
export let DIR_BAGS;
export let BAG_TTL_MS;
export let BAG_UNREAD_TTL_MS;
export let BAG_MAX_AGE_MS;
// Четверть мегабайта: мешок — сообщение, а не вложение. Файлы по-прежнему
// едут прежним путём (/files/*), в мешок попадает только ссылка и ключ к
// ней. recordBag() ниже держит этот потолок сам, а не полагается на то, что
// маршрут приёма (Задача 3) не забудет проверить его тоже.
//
// Мелочь (шестой раунд, честность формулировки): "держит потолок сам"
// означает только то, что recordBag() отвергает meta.size > MAX_BAG_SIZE —
// но meta.size ЗАЯВЛЕН вызывающим, а не измерен этим модулем на диске. Сам
// модуль не пишет файл мешка вообще (только путь считает bagPathFor()) —
// у него физически нет реальных байт, с которыми сверить заявленный size.
// Для Задачи 3 (см. отчёт): реальная граница ставится там, где файл
// действительно попадает на диск — маршрут обязан передавать в recordBag()
// размер, измеренный fs.statSync() ПОСЛЕ записи, а не то, что клиент указал
// в Content-Length/теле запроса. Иначе заявленный size и то, что реально
// легло на диск, — два разных числа, и этот потолок ничего не гарантирует
// про фактический объём хранилища.
export let MAX_BAG_SIZE;
// Мелочь (шестой раунд): раньше module-scope `const` (см. ниже, у
// assertNotFromFuture) — единственный срок/лимит в файле, не подчинявшийся
// прямому правилу задачи "все сроки/лимиты — env-конфигурируемы с явным
// умолчанием". Технически это допуск на рассинхрон часов, а не бизнес-TTL,
// но правило не делало для таких исключения — перенесена в _refreshConfig()
// тем же приёмом, что и остальные четыре.
export let CLOCK_SKEW_ALLOWANCE_MS;
let STORAGE_DIR;
let BAG_META_PATH;

function _refreshConfig() {
  STORAGE_DIR   = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
  DIR_BAGS      = path.join(STORAGE_DIR, 'bags');
  BAG_META_PATH = path.join(STORAGE_DIR, 'bag-meta.json');

  BAG_TTL_MS        = Number(process.env.BAG_TTL_MS        ||  7 * 24 * 60 * 60 * 1000);
  BAG_UNREAD_TTL_MS = Number(process.env.BAG_UNREAD_TTL_MS || 30 * 24 * 60 * 60 * 1000);
  BAG_MAX_AGE_MS    = Number(process.env.BAG_MAX_AGE_MS    || 90 * 24 * 60 * 60 * 1000);
  MAX_BAG_SIZE      = Number(process.env.MAX_BAG_SIZE      || 256 * 1024);
  // 0 — легитимное значение (запрет ЛЮБОГО будущего, без допуска вообще),
  // так что || здесь тоже верен: process.env.CLOCK_SKEW_ALLOWANCE_MS = '0'
  // как СТРОКА непустая и truthy — || берёт её, а не умолчание, ровно как и
  // для остальных четырёх ручек выше.
  CLOCK_SKEW_ALLOWANCE_MS = Number(process.env.CLOCK_SKEW_ALLOWANCE_MS || 5 * 60 * 1000);
}
_refreshConfig(); // начальные значения при импорте — то же, что раньше делали `const`-инициализаторы

function fail(fn, detail) {
  throw new Error(`${fn}: ${detail}`);
}

function assertPositiveFiniteNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    fail('assertBagStoreReady', `${name}=${JSON.stringify(process.env[name])} is not a positive finite number (parsed as ${value})`);
  }
}

// CLOCK_SKEW_ALLOWANCE_MS=0 — легитимное значение (запрет любого будущего
// вообще, без допуска), в отличие от четырёх TTL/размера выше, для которых
// 0 всегда бессмысленен (мешок с нулевым сроком жизни/нулевым потолком
// размера — не настройка, а фактическое выключение функции). Тот же
// diagnostic-message стиль, отдельная функция вместо <= 0 → < 0.
function assertNonNegativeFiniteNumber(name, value) {
  if (!Number.isFinite(value) || value < 0) {
    fail('assertBagStoreReady', `${name}=${JSON.stringify(process.env[name])} is not a non-negative finite number (parsed as ${value})`);
  }
}

// Call once at boot, after dotenv has run (Задача 3's job) — same reason as
// assertBagPassReady() in bagPass.js. Refreshes config from process.env
// FIRST (И-3, пятый раунд) — so a value that only became correct after
// dotenv.config() ran in app.js's body is picked up here, not stuck at
// whatever process.env happened to hold when this module was first
// imported. Only after that does it validate: a garbage value would
// otherwise silently become NaN/Infinity/0 and every check downstream that
// compares against it (bagExpiryAt, recordBag's size ceiling) goes quietly
// wrong — NaN <= now is always false, so nothing ever expires; 'big' → NaN
// → 50MB "meshki" sail straight through the size ceiling.
//
// Also creates DIR_BAGS (moved here from module scope, for the same
// ordering reason plus one more: a plain import of this module — e.g. from
// a test — should never have the side effect of creating a directory on
// disk before anything has decided the store is actually going to be used).
export function assertBagStoreReady() {
  // C1 (шестой раунд): _loadBagMeta() зовётся на уровне модуля — то есть ДО
  // dotenv.config() — из "импортного" STORAGE_DIR. _refreshConfig() ниже
  // переставляет BAG_META_PATH на боевой корень, но сама по себе НЕ
  // перечитывает индекс оттуда — без этой проверки в памяти оставалось бы
  // то, что было загружено (обычно пусто) из старого пути, и первая же
  // запись сохранила бы этот почти-пустой in-memory индекс ПОВЕРХ настоящего
  // боевого файла, стирая реальные переписки. Перечитываем ТОЛЬКО если путь
  // реально изменился — иначе повторный вызов assertBagStoreReady() с тем
  // же STORAGE_DIR не по делу перечитывал бы диск и рисковал бы затереть
  // память, если бы (гипотетически) на диске лежало что-то более старое,
  // чем уже накопленное в этом процессе состояние.
  const previousBagMetaPath = BAG_META_PATH;
  _refreshConfig();
  if (BAG_META_PATH !== previousBagMetaPath) {
    _loadBagMeta();
  }
  assertPositiveFiniteNumber('BAG_TTL_MS', BAG_TTL_MS);
  assertPositiveFiniteNumber('BAG_UNREAD_TTL_MS', BAG_UNREAD_TTL_MS);
  assertPositiveFiniteNumber('BAG_MAX_AGE_MS', BAG_MAX_AGE_MS);
  assertPositiveFiniteNumber('MAX_BAG_SIZE', MAX_BAG_SIZE);
  assertNonNegativeFiniteNumber('CLOCK_SKEW_ALLOWANCE_MS', CLOCK_SKEW_ALLOWANCE_MS);
  fs.mkdirSync(DIR_BAGS, { recursive: true });
}

// Форма адреса — та же проверка, что ETH_ADDR_RE в bagPass.js: нижний
// регистр, затем строгий /^0x[0-9a-f]{40}$/. Не проверяет чек-сумму EIP-55 —
// это не подтверждение владения ключом (то делает подпись/пропуск на слое
// выше), а просто защита от мусора в поле.
function assertAddress(fn, value) {
  const addr = typeof value === 'string' ? value.toLowerCase() : null;
  if (!addr || !ETH_ADDR_RE.test(addr)) fail(fn, `invalid address: ${JSON.stringify(value)}`);
  return addr;
}

// Number.isSafeInteger, не Number.isInteger — тот же класс бага, что в
// issueBagPass (Задача 1): Number.isInteger(1e21) === true, а
// '1000' + 5 склеивается в строку вместо сложения. isSafeInteger отсекает и
// строки (не число вовсе), и дробные, и огромные значения разом.
function assertSafeInt(fn, label, value) {
  if (!Number.isSafeInteger(value)) fail(fn, `invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

// null/undefined — легитимное "ещё не наступило" (мешок не прочитан / не
// усыновлён сделкой). Всё остальное обязано быть тем же safe integer, что и
// обязательные временные поля.
function assertNullableSafeInt(fn, label, value) {
  if (value === null || value === undefined) return null;
  return assertSafeInt(fn, label, value);
}

function assertNonEmptyString(fn, label, value) {
  if (typeof value !== 'string' || value.length === 0) fail(fn, `invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

// Мелочь (b): firstFetchedAt на сто дней раньше uploadedAt даёт срок
// смерти раньше рождения — правило 2 (firstFetchedAt + BAG_TTL_MS) может
// оказаться меньше момента, когда мешок вообще появился, и мешок сносится
// в тот же миг, в который был загружен. Прочитано не раньше загрузки — не
// строгое неравенство: firstFetchedAt === uploadedAt (прочитан в ту же
// миллисекунду) годен.
function assertFetchNotBeforeUpload(fn, uploadedAt, firstFetchedAt) {
  if (firstFetchedAt != null && firstFetchedAt < uploadedAt) {
    fail(fn, `firstFetchedAt (${firstFetchedAt}) is before uploadedAt (${uploadedAt})`);
  }
}

// И-3 (шестой раунд): мешок с uploadedAt = сейчас+100 лет переживал бы
// любую чистку и истёк бы только через сто лет — потолок BAG_MAX_AGE_MS
// ограничивает только вклад ВЕТКИ УСЫНОВЛЕНИЯ (min(dealDeadline,
// uploadedAt + BAG_MAX_AGE_MS) в bagExpiryAt), а base правил 2/3 считается
// ПРЯМО от uploadedAt — потолок туда не заглядывает вообще. Если Задача 3
// возьмёт uploadedAt из тела запроса, срок хранения обходится НАВСЕГДА —
// прямое нарушение обещания "сервер физически не может стать архивом".
// Небольшой допуск (не полноценная политика — просто технический зазор на
// рассинхрон часов клиента и сервера, а не способ легитимно принять
// будущее); в прошлом uploadedAt ничем не ограничен — это никогда не было
// проблемой (мешок просто живёт с момента, который заявлен).
//
// Мелочь (шестой раунд): величина допуска сама по себе теперь
// env-конфигурируема (CLOCK_SKEW_ALLOWANCE_MS — export let, объявлена и
// вычисляется в _refreshConfig() выше, у остальных четырёх сроков/лимитов)
// — раньше была захардкожена прямо здесь module-scope константой, ЕДИНСТВЕННЫЙ
// срок/лимит в файле, нарушавший правило задачи "все сроки/лимиты —
// env-конфигурируемы с явным умолчанием".

function assertNotFromFuture(fn, label, value, nowMs) {
  if (value > nowMs + CLOCK_SKEW_ALLOWANCE_MS) {
    fail(fn, `${label} (${value}) is too far in the future relative to now (${nowMs})`);
  }
}

// Тот же алгоритм, что у pairIdFromAddresses в app.js (сортировка нижних
// регистров, склейка через '-'), продублирован здесь намеренно, а не
// импортирован: обе стороны — чистые функции только от двух адресов, без
// разделяемого состояния — а импорт из app.js завёл бы цикл (см. заголовок
// файла). Дублирование чистой функции не безопасно само по себе: если
// однажды алгоритм в app.js поменяют, эта копия разойдётся молча, и мешки
// начнут ключеваться по одной паре, а споры — искаться по другой. Экспорт
// с подчёркиванием — не часть публичного интерфейса склада (bagKeyFor уже
// зовёт её напрямую и наружу этого не выставляет), а точка входа для
// test/bagStore.test.js, который сверяет её на входах с
// pairIdFromAddresses из app.js и обязан покраснеть при расхождении.
export function _pairIdFromAddresses(a, b) {
  // Мелочь (h): раньше делала String(a).toLowerCase() без проверки формы —
  // pairIdFromAddresses(null, BOB) в app.js бросает (null.toLowerCase()
  // несёт TypeError), а эта версия молча превращала null в строку 'null' и
  // возвращала "успешный", но мусорный pairId вроде '0xb0b1…-null'.
  // assertAddress — та же проверка, что используют все остальные функции
  // этого модуля; для уже провалидированных lowercase-адресов (обычный
  // внутренний вызов из recordBag) это no-op.
  const x = assertAddress('_pairIdFromAddresses', a);
  const y = assertAddress('_pairIdFromAddresses', b);
  return [x, y].sort().join('-');
}

// ─── Метаиндекс: загрузка/сохранение ───────────────────────────────────────

// I1: bag-meta.json может парситься как JSON и всё равно быть отравлен —
// например uploadedAt: 'oops' (структурно валиден, семантически нет).
// cleanupBags() раньше бросал НА СЕРЕДИНЕ прохода по _bagMeta на первой же
// такой записи: файл предыдущего, уже просроченного мешка к этому моменту
// уже удалён, а сохранение индекса в конце — нет, так что на диске индекс
// продолжает перечислять снесённое, listBagsFor отдаёт мешки без файлов, и
// каждая следующая чистка бросает на том же месте снова — ядовитая запись
// не вычищается никогда. Проверяется здесь, на границе загрузки, той же
// формой, что recordBag() требует на записи (переиспользует те же
// assert*-хелперы через try/catch → bool, чтобы не задваивать правила
// валидности в двух местах).
function isValidBagMetaEntry(key, meta) {
  try {
    if (!meta || typeof meta !== 'object') return false;
    const recipient = assertAddress('_loadBagMeta', meta.recipient);
    // Второй тур закрывающего ревью Задачи 4: sender==='' И pairId==='' —
    // ВМЕСТЕ, не по отдельности — легитимный маркер "отправитель
    // неизвестен", который ставит _recoverBagMetaFromDisk() при
    // восстановлении индекса из имён файлов на диске (у имени файла нет
    // sender — только recipient и uploadedAt; pairId без настоящего
    // sender не вычислить). Без этого исключения восстановленная запись
    // переживала СВОЮ ЖЕ первую перезагрузку (файл, который
    // _recoverBagMetaFromDisk() только что честно записал на диск, валиден
    // как JSON и грузится по обычному пути), но тут же отбраковывалась
    // ЭТИМ валидатором как "битая" — а следствие куда хуже одной потерянной
    // записи: _bagMetaLoadOk встаёт в true (файл же распарсился), гейт
    // метлы снимается, а запись из индекса пропала — тот же класс дыры,
    // что чинил весь этот раунд, только с одной перезагрузки отсрочкой.
    // Воспроизведено вживую при написании теста на полную цепочку.
    //
    // Проверка ИМЕННО парой, не по отдельности: запись с настоящим
    // sender, но пустым pairId (или наоборот) — рассогласование полей,
    // такая же порча данных, как раньше, и обязана отбраковываться как
    // раньше (см. тест I1 "негодный по форме sender/recipient/pairId/...").
    // Мутация "проверять sender/pairId по отдельности" красит тот тест.
    const senderUnknown = meta.sender === '' && meta.pairId === '';
    if (!senderUnknown) {
      assertAddress('_loadBagMeta', meta.sender);
      assertNonEmptyString('_loadBagMeta', 'pairId', meta.pairId);
    }
    assertBagKey('_loadBagMeta', key, recipient);
    if (assertSafeInt('_loadBagMeta', 'size', meta.size) < 0) return false;
    assertSafeInt('_loadBagMeta', 'uploadedAt', meta.uploadedAt);
    if (meta.firstFetchedAt != null) assertSafeInt('_loadBagMeta', 'firstFetchedAt', meta.firstFetchedAt);
    if (meta.dealDeadline != null) assertSafeInt('_loadBagMeta', 'dealDeadline', meta.dealDeadline);
    assertFetchNotBeforeUpload('_loadBagMeta', meta.uploadedAt, meta.firstFetchedAt);
    return true;
  } catch (e) {
    // C1 (четвёртый раунд): ошибка ПРОГРАММИСТА (наш код сломан — TDZ,
    // null pointer, что угодно из категории "это не должно быть возможно")
    // — не то же самое, что ошибка ДАННЫХ (uploadedAt: 'oops' — fail()
    // всегда бросает плоский Error). Единственный реальный прецедент —
    // BAG_KEY_RE в temporal dead zone на момент этого самого вызова —
    // проявлялся именно так: ReferenceError, пойманный этим catch,
    // тихо засчитывался как "запись битая", и индекс терялся целиком на
    // каждом перезапуске с непустыми данными. fail() и все assert*-хелперы
    // этого файла бросают только плоский Error — если поймали что-то ещё,
    // это баг в НАШЕМ коде, а не в чужих данных, и он обязан быть громким.
    if (e instanceof ReferenceError || e instanceof TypeError) throw e;
    return false;
  }
}

// Закрывающий раунд ревью Задачи 4 (chat-transport-storage): истинность —
// «последняя загрузка индекса действительно нашла и разобрала настоящий
// индекс», а не «файла ещё не было» (свежая установка — легитимное пустое
// состояние). cleanupBags() ниже обязана свериться с этим флагом ПЕРЕД тем,
// как звать sweepOrphanFiles(): с недостоверным (то есть насильно пустым)
// _bagMeta метла сирот метёт по mtime всё, чего нет в индексе, — то есть
// считает сиротой КАЖДЫЙ настоящий мешок на складе. Пока cleanupBags() не
// была подключена ни к какому расписанию, это было безвредно; Задача 4
// подключила её к ночному крону, и один битый bag-meta.json (нечитаемый
// JSON, null, массив, обрезанный файл после краха посреди записи) теперь
// означает потерю всей непрочитанной переписки через BAG_UNREAD_TTL_MS,
// молча, ночью — если не остановить метлу здесь.
let _bagMetaLoadOk = true;

// Второй тур закрывающего ревью Задачи 4: воспроизведено координатором
// вживую — гейт _bagMetaLoadOk запирал метлу сирот НА ТОТ прогон, но
// оставлял _bagMeta пустым. Первая же следующая персистентная запись
// (recordBag/markFetched/cleanupBags) перезаписывала битый bag-meta.json
// валидным JSON, содержащим ТОЛЬКО эту новую запись — улика уничтожена,
// а на следующем перезапуске этот обеднённый файл читается штатно,
// _bagMetaLoadOk снова true, гейт снят, и метла сносит каждый настоящий
// мешок, которого нет в этом однозаписном индексе.
//
// Лечится восстановлением, не только гейтом: имя файла мешка само несёт
// адресата и время загрузки (bagKeyFor: "<recipient>/<uploadedAt>-<uuid>.
// bin") — при провале загрузки сканируем DIR_BAGS и собираем индекс заново
// оттуда, персистим НЕМЕДЛЕННО (не дожидаясь случайной следующей записи), и
// только после этого разрешаем чему-либо ещё в процессе делать новые
// записи. Битый оригинал не остаётся под старым именем (там его стёрла бы
// первая запись) — переименовывается в сторону ДО пересчёта.
function _recoverBagMetaFromDisk() {
  if (fs.existsSync(BAG_META_PATH)) {
    const quarantinePath = `${BAG_META_PATH}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(BAG_META_PATH, quarantinePath);
      console.error(`[bags] _recoverBagMetaFromDisk: moved unreadable index aside to ${quarantinePath} — original preserved, will not be overwritten by the next write`);
    } catch (e) {
      // Не смогли даже подвинуть файл (права, гонка) — не бросаем: сама
      // реконструкция с диска всё ещё возможна и важнее сохранности одной
      // улики. Но и молчать нельзя — следующая запись всё-таки может
      // перетереть оригинал, раз убрать его в сторону не вышло.
      console.error(`[bags] _recoverBagMetaFromDisk: FAILED to quarantine unreadable index at ${BAG_META_PATH}: ${e.message} — proceeding with reconstruction anyway, original file may still be overwritten by a later save`);
    }
  }

  const recovered = Object.create(null);
  let recoveredCount = 0;
  let skippedGarbage = 0;
  let recipients = [];
  try { recipients = fs.readdirSync(DIR_BAGS); } catch {}

  for (const recipient of recipients) {
    const recipientDir = path.join(DIR_BAGS, recipient);
    let files;
    try {
      if (!fs.statSync(recipientDir).isDirectory()) continue;
      files = fs.readdirSync(recipientDir);
    } catch { continue; }

    for (const file of files) {
      const key = `${recipient}/${file}`;
      // Только то, что реально соответствует форме, которую производит
      // bagKeyFor() — та же граница, что и везде в этом файле. Что-то
      // ещё, случайно оказавшееся в DIR_BAGS (мусор, чужая рука), — не
      // мешок, и sweepOrphanFiles() (в следующие прогоны, когда индексу
      // снова можно верить) с ним разберётся сама.
      if (!BAG_KEY_RE.test(key)) { skippedGarbage++; continue; }

      const filePath = path.join(recipientDir, file);
      let size;
      try {
        size = fs.statSync(filePath).size;
      } catch { skippedGarbage++; continue; }

      // recipient и метка времени — прямо из формы ключа (см. bagKeyFor):
      // "<recipient>/<uploadedAt-epoch-ms>-<uuid>.bin". BAG_KEY_RE уже
      // подтвердила форму целиком, так что первый '-' после '/' — граница
      // между цифрами времени и uuid, однозначно (цифры вида [0-9]{1,15}
      // не содержат '-' сами по себе).
      const afterSlash = key.slice(key.indexOf('/') + 1);
      const uploadedAt = Number(afterSlash.slice(0, afterSlash.indexOf('-')));

      recovered[key] = {
        sender: '',            // неизвестен — содержимое запечатано, отправитель внутри сообщения
        recipient,
        pairId: '',            // не вычислим без настоящего sender; ничем публично не читается
        size,
        uploadedAt,
        firstFetchedAt: null,  // консервативно: считается непрочитанным — длинный срок (правило 3)
        dealDeadline: null,    // консервативно: считается не усыновлённым сделкой (правило 1 не применяется)
      };
      recoveredCount++;
    }
  }

  console.error(
    `[bags] _recoverBagMetaFromDisk: reconstructed ${recoveredCount} bag(s) from disk scan of ${DIR_BAGS}` +
    (skippedGarbage ? ` (skipped ${skippedGarbage} non-bag ${skippedGarbage === 1 ? 'entry' : 'entries'})` : '') +
    ` — sender, read state and deal adoption were NOT recoverable and default to unknown/unread/unadopted (longer, not shorter, lifetime)`
  );

  _bagMeta = recovered;
  try {
    _saveBagMeta();
    console.error(`[bags] _recoverBagMetaFromDisk: reconstructed index persisted to ${BAG_META_PATH}`);
  } catch (e) {
    // _saveBagMeta() уже залогировала свою часть (FAILED TO SAVE) и
    // пробросила — не даём этому броску уйти выше: реконструкция уже
    // сделала своё дело В ПАМЯТИ для этого процесса, и это лучше, чем
    // ничего, даже если персист не удался.
    console.error(`[bags] _recoverBagMetaFromDisk: FAILED to persist reconstructed index — it exists only in memory for this process until the next successful save: ${e.message}`);
  }

  return _bagMeta;
}

export function _loadBagMeta() {
  let raw = {};
  // И-N (закрывающий раунд): раньше «файла нет» (свежая установка) и «файл
  // есть, но не читается как индекс» (потеря доверия) шли одним и тем же
  // путём — raw молча становился {} в обоих случаях, и ничего не отличало
  // первый запуск от испорченного диска. Различаем явно: файла действительно
  // нет → легитимно пусто, loadOk остаётся true; файл есть, но не JSON,
  // или JSON, но не индекс (null/массив/примитив) → потеря доверия, громко.
  let loadOk = true;
  if (fs.existsSync(BAG_META_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(BAG_META_PATH, 'utf8'));
      // И-2 (пятый раунд): JSON.parse('null') УСПЕШНО возвращает null — не
      // ловится try/catch выше (разбор не бросил). Object.entries(null)
      // чуть ниже бросил бы TypeError, ломая загрузку целиком (а на уровне
      // модуля — и весь процесс). Годен только настоящий объект вида
      // {key: meta}; null/массив/примитив — та же потеря доверия, что и
      // совсем нечитаемый JSON, не крах загрузки.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed;
      } else {
        loadOk = false;
      }
    } catch {
      // В том числе обрезанный файл после краха посреди записи — самый
      // вероятный боевой случай (кончилось место на диске, процесс убит
      // между writeFileSync и renameSync temp-файла в _saveBagMeta()).
      loadOk = false;
    }
  }
  // else: файла действительно нет — свежая установка, легитимное пустое
  // состояние, loadOk остаётся true.

  if (!loadOk) {
    // Отдельная строка, узнаваемым текстом, НЕ похожим на «dropped N
    // corrupt entries» ниже — та находка про порчу отдельных записей
    // внутри в остальном годного индекса, эта про полную потерю самого
    // индекса. Кто читает лог, обязан суметь отличить «пять записей, одна
    // битая» от «весь файл потерян» с первого взгляда, не сверяя числа.
    console.error(
      `[bags] _loadBagMeta: FAILED TO LOAD INDEX from ${BAG_META_PATH} — file exists but could not be read as ` +
      `an index (corrupt/truncated JSON, or not an object: null/array/primitive). Recovering from disk instead ` +
      `of starting empty — see _recoverBagMetaFromDisk below. cleanupBags() will refuse to run its orphan sweep ` +
      `this run regardless — the recovery is a good guess, not a fact.`
    );
    _bagMetaLoadOk = false;
    return _recoverBagMetaFromDisk();
  }

  // Бесплатное улучшение от ревьюера (пятый раунд): Object.create(null),
  // не {} — assertBagKeyShape уже запирает '__proto__'/'constructor' на
  // входе каждой публичной функции (защита по форме ключа, симптоматическая),
  // но объект без Object.prototype убирает КЛАСС травления прототипа
  // структурно: у него нет '__proto__' как унаследованного аксессора вообще,
  // независимо от того, дошёл ли до него мусорный ключ мимо проверки формы.
  const clean = Object.create(null);
  let dropped = 0;
  for (const [key, meta] of Object.entries(raw)) {
    if (isValidBagMetaEntry(key, meta)) {
      clean[key] = meta;
    } else {
      dropped++;
      // Файл на диске (если есть) НЕ трогается здесь — только запись
      // уходит из индекса. Мы не уверены, что означает отравленная запись
      // (могли отравить и uploadedAt, и recipient, и что угодно ещё), так
      // что безопасный выбор — молчать про файл и дать обычной метле
      // сирот (sweepOrphanFiles, по mtime) разобраться с ним по своему
      // независимому расписанию.
      console.error(`[bags] _loadBagMeta: dropping corrupt index entry ${JSON.stringify(key)} — file on disk, if any, is left untouched, only the index entry is removed`);
    }
  }
  if (dropped) {
    console.error(`[bags] _loadBagMeta: dropped ${dropped} corrupt ${dropped === 1 ? 'entry' : 'entries'} out of ${Object.keys(raw).length} from ${BAG_META_PATH}`);
  }

  _bagMetaLoadOk = true;
  _bagMeta = clean;
  return _bagMeta;
}

// I2: раньше писала напрямую поверх BAG_META_PATH, оба catch были немые.
// Обрезанный файл (крах ровно посреди записи — заполненный диск, убитый
// процесс) → следующая загрузка молча получает пустой индекс: список
// переписки человека исчезает из виду, хотя сами файлы целы на диске. И
// ошибка самой записи глоталась — проверено подменой: markFetched()
// отмечал прочтение в памяти, а на диске не менялось ничего, вызывающий
// (маршрут Задачи 3) узнать об этом не мог никак.
//
// Пишем во временный файл и переименовываем — та же пара примитивов, что
// защищает от обрезанного файла в любой похожей системе: fs.renameSync на
// одной файловой системе атомарен, так что BAG_META_PATH в любой момент
// времени — это либо полностью старое содержимое, либо полностью новое,
// никогда наполовину записанное. И не глотаем ошибку: если запись или
// переименование упали, это НЕ синоним "всё в порядке, продолжаем как ни
// в чём не бывало" — throw после логирования, тот же приём, что и во всех
// остальных assert*-хелперах этого файла (в отличие от более старого,
// снисходительного savePushSubs() в app.js: там цена ошибки — пережить
// рестарт без пуша, здесь — тихо потерять чужую переписку, ставки другие).
export function _saveBagMeta() {
  const tmpPath = `${BAG_META_PATH}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    // Тот же приём, что у savePushSubs() в app.js:65 — не полагаться на то,
    // что каталог уже создан где-то ещё (assertBagStoreReady() создаёт
    // DIR_BAGS на старте, но её порядок вызова относительно первого
    // recordBag() — забота вызывающего кода, не гарантия этого модуля).
    // На чистой установке без этого первый же recordBag() падал с ENOENT.
    fs.mkdirSync(path.dirname(BAG_META_PATH), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(_bagMeta), 'utf8');
    fs.renameSync(tmpPath, BAG_META_PATH);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    console.error(`[bags] FAILED TO SAVE ${BAG_META_PATH} — in-memory index and disk index have diverged: ${e.message}`);
    throw e;
  }
}

let _bagMeta = Object.create(null);
_loadBagMeta();

// ─── Ключи и пути ───────────────────────────────────────────────────────────
//
// BAG_KEY_RE объявлена выше, рядом с ETH_ADDR_RE — см. комментарий там
// (C1, четвёртый раунд): порядок объявления здесь раньше был причиной
// потери всего индекса на каждом перезапуске.

// key раньше проверялся только как «непустая строка» и шёл прямо в
// fs.unlinkSync(path.join(DIR_BAGS, key)) — находка ревью (C2):
// '../not-a-bag.txt' как key удалял файл ЗА ПРЕДЕЛАМИ DIR_BAGS, а
// '<боб>/x.bin' с recipient=alice проходил молча — мешок Алисы физически
// лежал бы в каталоге Боба. recipient здесь — уже провалидированный и
// приведённый к нижнему регистру адрес (вызывающий обязан прогнать его
// через assertAddress раньше).
// Только форма — без сверки с recipient. Используется там, где recipient
// недоступен (markFetched/bagMetaOf получают только key), но key всё равно
// идёт напрямую в _bagMeta[key] — находка ревью (I1, четвёртый раунд):
// _bagMeta — обычный {}, не Object.create(null), так что
// _bagMeta['__proto__'] возвращает Object.prototype (истинный объект, не
// undefined), а _bagMeta['constructor'] — сам Object. bagMetaOf('__proto__')
// отдавала {} (истинно — проходит любую проверку "существует ли"),
// markFetched('__proto__', ts) писала firstFetchedAt ПРЯМО в
// Object.prototype — травила его для всего процесса релеера, не только
// для этого модуля. Воспроизведено вживую. BAG_KEY_RE не совпадает ни с
// '__proto__', ни с 'constructor' — обе формы ключа заперты этой же
// проверкой формы.
function assertBagKeyShape(fn, key) {
  assertNonEmptyString(fn, 'key', key);
  if (!BAG_KEY_RE.test(key)) fail(fn, `invalid key shape: ${JSON.stringify(key)}`);
  return key;
}

function assertBagKey(fn, key, recipient) {
  assertBagKeyShape(fn, key);
  const recipientInKey = key.slice(0, key.indexOf('/'));
  if (recipientInKey !== recipient) {
    fail(fn, `key recipient (${recipientInKey}) does not match recipient field (${recipient})`);
  }
  return key;
}

// bagKeyFor() штампует имя файла временем СОЗДАНИЯ КЛЮЧА (Date.now()), а не
// uploadedAt, который вызывающий передаст в recordBag() позже отдельным
// полем — сигнатура из брифа не даёт bagKeyFor() увидеть uploadedAt
// заранее. Имя файла — не источник правды о времени; источник правды —
// meta.uploadedAt в индексе. Не чинится (см. ревью координатора) — оставлено
// как есть, здесь только явное предупреждение, чтобы никто не начал парсить
// метку времени из имени файла вместо чтения индекса.
export function bagKeyFor(recipient) {
  const addr = assertAddress('bagKeyFor', recipient);
  return `${addr}/${Date.now()}-${randomUUID()}.bin`;
}

// Единственный сертифицированный способ превратить key в путь на диске.
// Существует специально для Задачи 3: GET /bags/:key примет key ОТ КЛИЕНТА
// и обязан превратить его в путь — единственный санитайзер в репозитории,
// safeKey() (app.js:815), срезает слэш, а ключ мешка обязан его содержать,
// так что safeKey() либо сломает каждый ключ, либо (если Задача 3 решит его
// не звать) откроет обход каталога. bagPathFor() сама проверяет форму и
// бросает на негодной — так что у Задачи 3 просто нет пути сделать это
// неправильно, если она вызывает эту функцию, а не собирает путь вручную.
// Regex выше уже запрещает '..' и лишние '/', resolve+startsWith ниже — та
// же защита в глубину, что у safeLogPath (app.js:781-787), на случай
// будущего изменения регэкспа или платформенных сюрпризов path.join.
export function bagPathFor(key) {
  assertBagKeyShape('bagPathFor', key);
  const filePath = path.join(DIR_BAGS, key);
  if (!path.resolve(filePath).startsWith(path.resolve(DIR_BAGS) + path.sep)) {
    fail('bagPathFor', 'key escapes DIR_BAGS');
  }
  return filePath;
}

// ─── Запись / чтение метаданных ─────────────────────────────────────────────

export function recordBag(meta, nowMs = Date.now()) {
  if (!meta || typeof meta !== 'object') fail('recordBag', 'invalid meta');
  assertSafeInt('recordBag', 'nowMs', nowMs);

  const sender    = assertAddress('recordBag', meta.sender);
  const recipient = assertAddress('recordBag', meta.recipient);
  const key       = assertBagKey('recordBag', meta.key, recipient);
  // I5: ключи уникальны по построению (bagKeyFor — временная метка +
  // uuid), так что легитимного повторного recordBag() с тем же key не
  // бывает. Раньше повтор тихо ПЕРЕЗАПИСЫВАЛ запись целиком —
  // firstFetchedAt обнулялся в null, uploadedAt сдвигался на новое
  // значение, а потолок BAG_MAX_AGE_MS считается ОТ uploadedAt: повторной
  // записью того же ключа потолок в 90 дней пробивался и продлевался
  // бесконечно. Отвергаем как ошибку вызывающего, а не тихое "обновление".
  if (Object.prototype.hasOwnProperty.call(_bagMeta, key)) {
    fail('recordBag', `key already recorded: ${JSON.stringify(key)}`);
  }
  const size      = assertSafeInt('recordBag', 'size', meta.size);
  if (size < 0) fail('recordBag', `invalid size: ${size}`);
  if (size > MAX_BAG_SIZE) fail('recordBag', `size ${size} exceeds MAX_BAG_SIZE ${MAX_BAG_SIZE} — a bag is a message, not an attachment`);
  const uploadedAt     = assertSafeInt('recordBag', 'uploadedAt', meta.uploadedAt);
  assertNotFromFuture('recordBag', 'uploadedAt', uploadedAt, nowMs);
  const firstFetchedAt = assertNullableSafeInt('recordBag', 'firstFetchedAt', meta.firstFetchedAt ?? null);
  assertFetchNotBeforeUpload('recordBag', uploadedAt, firstFetchedAt);
  const dealDeadline   = assertNullableSafeInt('recordBag', 'dealDeadline', meta.dealDeadline ?? null);

  const stored = {
    sender,
    recipient,
    pairId: _pairIdFromAddresses(sender, recipient),
    size,
    uploadedAt,
    firstFetchedAt,
    dealDeadline,
  };
  _bagMeta[key] = stored;
  try {
    _saveBagMeta();
  } catch (e) {
    // I2: не оставлять память впереди диска — если персист не удался,
    // запись не должна продолжать "существовать" только в этом процессе.
    // Ключи уникальны по построению (I5), так что откат каждый раз просто
    // удаляет ровно ту запись, которую сами же секунду назад вставили.
    delete _bagMeta[key];
    throw e;
  }
  return { key, ...stored };
}

// Первое прочтение фиксируется один раз; каждый последующий вызов — не-оп
// (не двигает срок и не пишет на диск повторно). Незнакомый ключ — громкая
// ошибка, а не тихое создание записи: к этому моменту вызывающий (маршрут
// выдачи, Задача 3) уже обязан был подтвердить существование мешка через
// bagMetaOf()/listBagsFor().
export function markFetched(key, nowMs = Date.now()) {
  assertBagKeyShape('markFetched', key);
  assertSafeInt('markFetched', 'nowMs', nowMs);

  const meta = _bagMeta[key];
  if (!meta) fail('markFetched', `unknown key: ${JSON.stringify(key)}`);

  if (meta.firstFetchedAt == null) {
    assertFetchNotBeforeUpload('markFetched', meta.uploadedAt, nowMs);
    meta.firstFetchedAt = nowMs;
    try {
      _saveBagMeta();
    } catch (e) {
      // I2: тот же откат, что в recordBag — если запись не доехала до
      // диска, отметка о прочтении не должна продолжать жить только в
      // памяти этого процесса (findings: "отметка есть в памяти, на диске
      // нет ничего").
      meta.firstFetchedAt = null;
      throw e;
    }
  }
  return { key, ...meta };
}

export function listBagsFor(recipient) {
  const addr = assertAddress('listBagsFor', recipient);
  return Object.entries(_bagMeta)
    .filter(([, meta]) => meta.recipient === addr)
    .map(([key, meta]) => ({ key, ...meta }))
    .sort((a, b) => a.uploadedAt - b.uploadedAt);
}

// I3: раньше отдавала `_bagMeta[key]` напрямую — тот же объект, что живёт в
// индексе. Мутация возвращённого объекта (`m.recipient = кто-то-другой`)
// меняла запись в _bagMeta мгновенно, без единого вызова recordBag()/
// markFetched() и без единой проверки формы — мешок "переезжал" к другому
// адресату в listBagsFor() тем же тактом. listBagsFor()/markFetched() уже
// возвращали копии (через спред) — bagMetaOf() была единственным
// исключением из этого правила.
export function bagMetaOf(key) {
  assertBagKeyShape('bagMetaOf', key);
  const meta = _bagMeta[key];
  return meta ? { ...meta } : undefined;
}

// ─── Срок жизни ─────────────────────────────────────────────────────────────
//
// Три правила, в этом порядке:
//   1. Усыновлён сделкой (dealDeadline задан) → живёт до dealDeadline, но не
//      дольше потолка BAG_MAX_AGE_MS от загрузки. Потолок — против
//      злоупотребления: пометка сделкой, как и нынешняя пометка парой в
//      app.js, не имеет доказательства участия.
//   2. Прочитан (firstFetchedAt задан) → firstFetchedAt + BAG_TTL_MS.
//   3. Не прочитан → uploadedAt + BAG_UNREAD_TTL_MS.
//
// Усыновление ПРОДЛЕВАЕТ и никогда не обрезает: сделка, закрывшаяся завтра,
// не должна стирать переписку, которой по обычному правилу жить ещё месяц —
// иначе привязка к сделке из защиты превратилась бы в способ ускоренно
// стереть неудобное. Отсюда Math.max(base, ...): итог никогда не короче
// того, что дало бы правило 2/3 само по себе.
//
// Осознанное следствие: потолок усыновления — это BAG_MAX_AGE_MS (90д) от
// uploadedAt, но фактический предельный срок мешка может доехать до
// BAG_MAX_AGE_MS + BAG_TTL_MS (90+7д). Тот же Math.max(base, ...) выше: если
// мешок усыновлён сделкой и прочитан за миг до потолка, base (правило 2 —
// firstFetchedAt + BAG_TTL_MS) обгоняет ceiling (min(dealDeadline, потолок))
// ещё на BAG_TTL_MS, и Math.max берёт большее. Это не отдельная дыра, а то
// же самое правило "усыновление не обрезает", применённое ещё раз: коль
// скоро правило 2 само по себе дало бы срок дольше потолка, потолок его не
// укорачивает — потолок ограничивает только вклад САМОЙ сделки, а не общий
// результат. Заперто тестом ниже.
//
// nowMs в сигнатуре не используется — срок истечения абсолютный, посчитан
// целиком из полей meta. Параметр оставлен для симметрии с cleanupBags(nowMs)
// и на случай будущего использования; подчёркивание в имени — сигнал, что
// сегодня он мёртв в теле функции.
export function bagExpiryAt(meta, _nowMs = Date.now()) {
  if (!meta || typeof meta !== 'object') fail('bagExpiryAt', 'invalid meta');
  assertSafeInt('bagExpiryAt', 'meta.uploadedAt', meta.uploadedAt);
  if (meta.firstFetchedAt != null) assertSafeInt('bagExpiryAt', 'meta.firstFetchedAt', meta.firstFetchedAt);
  if (meta.dealDeadline != null) assertSafeInt('bagExpiryAt', 'meta.dealDeadline', meta.dealDeadline);
  assertFetchNotBeforeUpload('bagExpiryAt', meta.uploadedAt, meta.firstFetchedAt);

  // != null, не истинность: 0 (эпоха Unix) — валидный safe integer, тот же
  // модуль сам его принимает через assertNullableSafeInt. С проверкой на
  // истинность firstFetchedAt: 0 читался как "не прочитан", и правило 3
  // (30д от загрузки) срабатывало вместо правила 2 (7д от прочтения).
  const base = meta.firstFetchedAt != null
    ? meta.firstFetchedAt + BAG_TTL_MS
    : meta.uploadedAt + BAG_UNREAD_TTL_MS;

  if (!meta.dealDeadline) return base;

  const ceiling = meta.uploadedAt + BAG_MAX_AGE_MS;
  return Math.max(base, Math.min(meta.dealDeadline, ceiling));
}

// ─── Чистка ─────────────────────────────────────────────────────────────────

// Файлы на диске без записи в индексе — например, крах между записью файла и
// recordBag(), или потерянный/повреждённый bag-meta.json. Метётся по mtime,
// не раньше чем через BAG_UNREAD_TTL_MS (самый долгий срок "ещё не прочитан")
// — иначе потерянный индекс оставит мусор на складе навсегда, а слишком
// ранняя метла снесёт файл, для который recordBag() ещё просто не успел
// выполниться следом за записью на диск.
// Мелочь (f): возвращает число реально удалённых файлов — cleanupBags()
// складывает его со своим removed. Раньше не возвращала ничего, и снесённый
// файл-сирота не отражался в {removed, kept} вообще: вызывающий (лог/
// метрика после ночной чистки) видел бы "ничего не сделано" при реально
// удалённых файлах.
// И-1 (пятый раунд), находка снята шестым: protectedKeys когда-то был
// нужен, чтобы защитить от метлы файлы, чьё удаление из _bagMeta ещё не
// подтверждено диском. Больше не нужен — cleanupBags() (мелочь, пятый
// раунд, коммит 3592a82) теперь ОТКАТЫВАЕТ такие записи обратно в _bagMeta
// в своей catch-ветке, ДО того как finally здесь вообще позовёт эту
// функцию. К моменту, когда sweepOrphanFiles видит файл, чьё удаление не
// удалось сохранить, ключ уже снова в _bagMeta — обычный hasOwnProperty
// ниже его и защищает. Отдельный параметр protectedKeys стал мёртвым
// весом (мутация, отключающая его целиком, переставала на что-либо
// влиять) — убран, а не оставлен неиспользуемым.
function sweepOrphanFiles(nowMs) {
  const cutoff = nowMs - BAG_UNREAD_TTL_MS;
  let removed = 0;

  let recipients;
  try { recipients = fs.readdirSync(DIR_BAGS); } catch { return removed; }

  for (const recipient of recipients) {
    const recipientDir = path.join(DIR_BAGS, recipient);
    let files;
    try {
      if (!fs.statSync(recipientDir).isDirectory()) continue;
      files = fs.readdirSync(recipientDir);
    } catch { continue; }

    for (const file of files) {
      const key = `${recipient}/${file}`;
      if (Object.prototype.hasOwnProperty.call(_bagMeta, key)) continue;

      const filePath = path.join(recipientDir, file);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch {}
    }
  }
  return removed;
}

// Мелочь (e): без этого bags/<адрес>/ переживает каждый мешок, когда-либо
// в нём лежавший — на диске оседает список всех, кто когда-либо получал
// мешок, дольше самих мешков. Для проекта, обещающего не быть архивом
// (сервер не хранит то, чего не должен), это лишнее. Запускается ПОСЛЕ
// основного цикла удаления и sweepOrphanFiles — только тогда каталог,
// опустевший в этом же проходе чистки, действительно пуст.
function removeEmptyRecipientDirs() {
  let recipients;
  try { recipients = fs.readdirSync(DIR_BAGS); } catch { return; }

  for (const recipient of recipients) {
    const recipientDir = path.join(DIR_BAGS, recipient);
    try {
      if (!fs.statSync(recipientDir).isDirectory()) continue;
      if (fs.readdirSync(recipientDir).length === 0) fs.rmdirSync(recipientDir);
    } catch {}
  }
}

export function cleanupBags(nowMs = Date.now()) {
  assertSafeInt('cleanupBags', 'nowMs', nowMs);

  let removed = 0;
  let kept = 0;
  // Мелочь (порядок): файлы удаляемых мешков собираются здесь, но не
  // трогаются немедленно — см. ниже, почему удаление файла идёт ПОСЛЕ
  // сохранения индекса, а не до.
  const keysToDeleteFiles = [];
  // Мелочь (откат, пятый раунд): [key, meta] всех записей, снятых из
  // _bagMeta в ЭТОМ проходе (и просроченных, и "мелочь g" — обе
  // категории), нужны, чтобы вернуть их назад, если сохранение индекса не
  // удастся — см. catch ниже.
  const removedEntries = [];

  for (const [key, meta] of Object.entries(_bagMeta)) {
    if (bagExpiryAt(meta, nowMs) <= nowMs) {
      delete _bagMeta[key];
      removedEntries.push([key, meta]);
      keysToDeleteFiles.push(key);
      removed++;
      continue;
    }

    // Мелочь (g): формально живая по сроку запись, чей файл пропал с диска
    // (ручное вмешательство, сбой ФС) — индекс не должен утверждать
    // существование того, чего физически нет. Без этого listBagsFor()
    // продолжал бы отдавать такой мешок, и Задача 3 получила бы ошибку
    // чтения на попытке выдачи вместо честного "мешка больше нет".
    let fileExists;
    try { fileExists = fs.existsSync(bagPathFor(key)); } catch { fileExists = false; }
    if (!fileExists) {
      console.error(`[bags] cleanupBags: index entry ${JSON.stringify(key)} has no file on disk — dropping from index`);
      delete _bagMeta[key];
      removedEntries.push([key, meta]);
      removed++;
      continue;
    }

    kept++;
  }

  try {
    // Мелочь (порядок): индекс сохраняется ДО удаления файлов, не после.
    // Раньше файл удалялся первым — если сохранение индекса падало ПОСЛЕ
    // (I2 теперь бросает вместо молчаливого catch{}), на диске оставался
    // индекс, продолжающий обещать файл, которого уже нет. Если вместо
    // этого сначала сохранить индекс (запись уже убрана) и только потом
    // удалять файл, худший случай при падении на любом из шагов —
    // осиротевший файл, который подберёт обычная метла сирот по mtime, а
    // не индекс, врущий про существование.
    if (removed) _saveBagMeta();
    for (const key of keysToDeleteFiles) {
      try { fs.unlinkSync(bagPathFor(key)); } catch {}
    }
  } catch (e) {
    // Мелочь (откат, пятый раунд): та же дисциплина, что у recordBag()/
    // markFetched() (I2) — если персист не удался, память не должна
    // продолжать "видеть" удаление, которого не подтвердил диск.
    // Восстанавливаем всё, что этот проход только что убрал из _bagMeta
    // (файлы к этому моменту точно не тронуты — цикл их удаления идёт
    // ПОСЛЕ _saveBagMeta() в том же try и не успел выполниться). Это же
    // восстановление — единственная защита, которая нужна метле ниже: к
    // моменту, когда finally позовёт sweepOrphanFiles(), ключ уже снова в
    // _bagMeta, и её собственный hasOwnProperty его защищает (находка И-1,
    // пятый раунд, снята отдельным параметром protectedKeys — оказался
    // мёртвым весом именно из-за этого отката, убран).
    for (const [key, meta] of removedEntries) {
      _bagMeta[key] = meta;
    }
    throw e;
  } finally {
    // Мелочь (независимость): sweepOrphanFiles/removeEmptyRecipientDirs
    // работают с файловой системой напрямую, не зависят от успеха
    // сохранения индекса — finally гарантирует, что упавшее сохранение не
    // отменяет их молча для НЕСВЯЗАННЫХ настоящих сирот.
    //
    // Закрывающий раунд ревью Задачи 4: но НЕЗАВИСИМОСТЬ от сохранения —
    // не то же самое, что независимость от ЗАГРУЗКИ. sweepOrphanFiles()
    // метёт по mtime всё, чего нет в _bagMeta; если последняя _loadBagMeta()
    // не смогла прочитать индекс (_bagMetaLoadOk === false — см. там же),
    // _bagMeta пуст не потому, что мешков нет, а потому, что мы не знаем,
    // что наше. С пустым недостоверным индексом метла снесла бы КАЖДЫЙ
    // настоящий мешок на складе как сироту. Лучше копить мусор, чем сносить
    // живое — отказываемся мести, пока индексу нельзя верить, и говорим об
    // этом громко: removeEmptyRecipientDirs() ниже безопасен всегда (сносит
    // только каталоги, физически пустые на диске, — реальному мешку в них
    // ничего не грозит), поэтому он не гейтится.
    if (_bagMetaLoadOk) {
      removed += sweepOrphanFiles(nowMs);
    } else {
      console.error(
        '[bags] cleanupBags: SKIPPING orphan sweep — the index failed to load (see the ' +
        'FAILED TO LOAD INDEX line from _loadBagMeta) and cannot be trusted to tell real bags ' +
        'from orphans; garbage will accumulate until the index loads successfully again, on purpose.'
      );
    }
    removeEmptyRecipientDirs();
  }

  return { removed, kept };
}
