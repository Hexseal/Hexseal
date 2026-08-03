// ─── Склад мешков ───────────────────────────────────────────────────────────
// Хранит непрозрачные, зашифрованные на клиенте "мешки" переписки (замена
// XMTP). Всё, чем этот модуль оперирует, — адреса, размеры и время. Ни при
// записи, ни при чистке содержимое мешка не читается и не разбирается:
// сервер не имеет ключей и не должен иметь возможности узнать, что внутри.
//
// Раскладка на диске: STORAGE_DIR/bags/<recipient>/<uploadedAt>-<uuid>.bin,
// где <recipient> — адрес в нижнем регистре. Индекс по адресату не нужен —
// список мешков конкретного получателя это чтение одного каталога.
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

const STORAGE_DIR   = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
export const DIR_BAGS = path.join(STORAGE_DIR, 'bags');
const BAG_META_PATH = path.join(STORAGE_DIR, 'bag-meta.json');

export const BAG_TTL_MS        = Number(process.env.BAG_TTL_MS        ||  7 * 24 * 60 * 60 * 1000);
export const BAG_UNREAD_TTL_MS = Number(process.env.BAG_UNREAD_TTL_MS || 30 * 24 * 60 * 60 * 1000);
export const BAG_MAX_AGE_MS    = Number(process.env.BAG_MAX_AGE_MS    || 90 * 24 * 60 * 60 * 1000);
// Четверть мегабайта: мешок — сообщение, а не вложение. Файлы по-прежнему
// едут прежним путём (/files/*), в мешок попадает только ссылка и ключ к
// ней. recordBag() ниже держит этот потолок сам, а не полагается на то, что
// маршрут приёма (Задача 3) не забудет проверить его тоже.
export const MAX_BAG_SIZE      = Number(process.env.MAX_BAG_SIZE      || 256 * 1024);

function fail(fn, detail) {
  throw new Error(`${fn}: ${detail}`);
}

function assertPositiveFiniteNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    fail('assertBagStoreReady', `${name}=${JSON.stringify(process.env[name])} is not a positive finite number (parsed as ${value})`);
  }
}

// Call once at boot, after dotenv has run (Задача 3's job) — same reason as
// assertBagPassReady() in bagPass.js. BAG_TTL_MS/BAG_UNREAD_TTL_MS/
// BAG_MAX_AGE_MS/MAX_BAG_SIZE above are `export const`, computed ONCE at
// import time (as specified by the brief) — a garbage value already sitting
// in process.env at that moment silently becomes NaN/Infinity/0 forever for
// the life of the process, and every check downstream that compares against
// it (bagExpiryAt, recordBag's size ceiling) goes quietly wrong: NaN <= now
// is always false, so nothing ever expires; 'big' → NaN → 50MB "meshki"
// sail straight through the size ceiling. Checking here, not at module
// level, matters for the exact reason it mattered for SERVER_SECRET in
// bagPass.js: app.js calls dotenv.config() in its own body, AFTER ESM has
// already evaluated every import — a check at module scope could fire
// before the real value has even been read from .env.
//
// Also creates DIR_BAGS (moved here from module scope, for the same
// ordering reason plus one more: a plain import of this module — e.g. from
// a test — should never have the side effect of creating a directory on
// disk before anything has decided the store is actually going to be used).
export function assertBagStoreReady() {
  assertPositiveFiniteNumber('BAG_TTL_MS', BAG_TTL_MS);
  assertPositiveFiniteNumber('BAG_UNREAD_TTL_MS', BAG_UNREAD_TTL_MS);
  assertPositiveFiniteNumber('BAG_MAX_AGE_MS', BAG_MAX_AGE_MS);
  assertPositiveFiniteNumber('MAX_BAG_SIZE', MAX_BAG_SIZE);
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
  const [x, y] = [String(a).toLowerCase(), String(b).toLowerCase()].sort();
  return `${x}-${y}`;
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
    assertAddress('_loadBagMeta', meta.sender);
    assertBagKey('_loadBagMeta', key, recipient);
    assertNonEmptyString('_loadBagMeta', 'pairId', meta.pairId);
    if (assertSafeInt('_loadBagMeta', 'size', meta.size) < 0) return false;
    assertSafeInt('_loadBagMeta', 'uploadedAt', meta.uploadedAt);
    if (meta.firstFetchedAt != null) assertSafeInt('_loadBagMeta', 'firstFetchedAt', meta.firstFetchedAt);
    if (meta.dealDeadline != null) assertSafeInt('_loadBagMeta', 'dealDeadline', meta.dealDeadline);
    return true;
  } catch {
    return false;
  }
}

export function _loadBagMeta() {
  let raw = {};
  try {
    raw = fs.existsSync(BAG_META_PATH) ? JSON.parse(fs.readFileSync(BAG_META_PATH, 'utf8')) : {};
  } catch {
    raw = {};
  }

  const clean = {};
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
    fs.writeFileSync(tmpPath, JSON.stringify(_bagMeta), 'utf8');
    fs.renameSync(tmpPath, BAG_META_PATH);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    console.error(`[bags] FAILED TO SAVE ${BAG_META_PATH} — in-memory index and disk index have diverged: ${e.message}`);
    throw e;
  }
}

let _bagMeta = {};
_loadBagMeta();

// ─── Ключи и пути ───────────────────────────────────────────────────────────

// Ровно то, что производит bagKeyFor(): <адрес нижним регистром>/<цифры
// эпохи>-<uuid>.bin. Не проверяет версию/вариант UUID (не граница
// безопасности, просто формат) — граница здесь одна: ровно два сегмента,
// первый — адрес, второй — этот конкретный шаблон имени файла, никаких
// '..', никаких лишних '/'.
const BAG_KEY_RE = /^0x[0-9a-f]{40}\/[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/;

// key раньше проверялся только как «непустая строка» и шёл прямо в
// fs.unlinkSync(path.join(DIR_BAGS, key)) — находка ревью (C2):
// '../not-a-bag.txt' как key удалял файл ЗА ПРЕДЕЛАМИ DIR_BAGS, а
// '<боб>/x.bin' с recipient=alice проходил молча — мешок Алисы физически
// лежал бы в каталоге Боба. recipient здесь — уже провалидированный и
// приведённый к нижнему регистру адрес (вызывающий обязан прогнать его
// через assertAddress раньше).
function assertBagKey(fn, key, recipient) {
  assertNonEmptyString(fn, 'key', key);
  if (!BAG_KEY_RE.test(key)) fail(fn, `invalid key shape: ${JSON.stringify(key)}`);
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
  assertNonEmptyString('bagPathFor', 'key', key);
  if (!BAG_KEY_RE.test(key)) fail('bagPathFor', `invalid key shape: ${JSON.stringify(key)}`);
  const filePath = path.join(DIR_BAGS, key);
  if (!path.resolve(filePath).startsWith(path.resolve(DIR_BAGS) + path.sep)) {
    fail('bagPathFor', 'key escapes DIR_BAGS');
  }
  return filePath;
}

// ─── Запись / чтение метаданных ─────────────────────────────────────────────

export function recordBag(meta) {
  if (!meta || typeof meta !== 'object') fail('recordBag', 'invalid meta');

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
  const firstFetchedAt = assertNullableSafeInt('recordBag', 'firstFetchedAt', meta.firstFetchedAt ?? null);
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
  assertNonEmptyString('markFetched', 'key', key);
  assertSafeInt('markFetched', 'nowMs', nowMs);

  const meta = _bagMeta[key];
  if (!meta) fail('markFetched', `unknown key: ${JSON.stringify(key)}`);

  if (meta.firstFetchedAt == null) {
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

export function bagMetaOf(key) {
  assertNonEmptyString('bagMetaOf', 'key', key);
  return _bagMeta[key];
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
// nowMs в сигнатуре не используется — срок истечения абсолютный, посчитан
// целиком из полей meta. Параметр оставлен для симметрии с cleanupBags(nowMs)
// и на случай будущего использования; подчёркивание в имени — сигнал, что
// сегодня он мёртв в теле функции.
export function bagExpiryAt(meta, _nowMs = Date.now()) {
  if (!meta || typeof meta !== 'object') fail('bagExpiryAt', 'invalid meta');
  assertSafeInt('bagExpiryAt', 'meta.uploadedAt', meta.uploadedAt);
  if (meta.firstFetchedAt != null) assertSafeInt('bagExpiryAt', 'meta.firstFetchedAt', meta.firstFetchedAt);
  if (meta.dealDeadline != null) assertSafeInt('bagExpiryAt', 'meta.dealDeadline', meta.dealDeadline);

  const base = meta.firstFetchedAt
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
function sweepOrphanFiles(nowMs) {
  const cutoff = nowMs - BAG_UNREAD_TTL_MS;

  let recipients;
  try { recipients = fs.readdirSync(DIR_BAGS); } catch { return; }

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
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch {}
    }
  }
}

export function cleanupBags(nowMs = Date.now()) {
  assertSafeInt('cleanupBags', 'nowMs', nowMs);

  let removed = 0;
  let kept = 0;

  for (const [key, meta] of Object.entries(_bagMeta)) {
    if (bagExpiryAt(meta, nowMs) <= nowMs) {
      try { fs.unlinkSync(bagPathFor(key)); } catch {}
      delete _bagMeta[key];
      removed++;
    } else {
      kept++;
    }
  }
  if (removed) _saveBagMeta();

  sweepOrphanFiles(nowMs);

  return { removed, kept };
}
