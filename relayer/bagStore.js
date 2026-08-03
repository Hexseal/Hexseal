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

// Гарантирует существование каталога мешков сразу при импорте — тот же приём,
// что у DIR_LOGS в app.js (fs.mkdirSync без try/catch: если склад недоступен,
// сервер должен упасть при старте, а не притвориться рабочим).
fs.mkdirSync(DIR_BAGS, { recursive: true });

function fail(fn, detail) {
  throw new Error(`${fn}: ${detail}`);
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

export function _loadBagMeta() {
  try {
    _bagMeta = fs.existsSync(BAG_META_PATH)
      ? JSON.parse(fs.readFileSync(BAG_META_PATH, 'utf8'))
      : {};
  } catch {
    _bagMeta = {};
  }
  return _bagMeta;
}

export function _saveBagMeta() {
  try { fs.writeFileSync(BAG_META_PATH, JSON.stringify(_bagMeta), 'utf8'); } catch {}
}

let _bagMeta = {};
_loadBagMeta();

// ─── Ключи и пути ───────────────────────────────────────────────────────────

export function bagKeyFor(recipient) {
  const addr = assertAddress('bagKeyFor', recipient);
  return `${addr}/${Date.now()}-${randomUUID()}.bin`;
}

// ─── Запись / чтение метаданных ─────────────────────────────────────────────

export function recordBag(meta) {
  if (!meta || typeof meta !== 'object') fail('recordBag', 'invalid meta');

  const key       = assertNonEmptyString('recordBag', 'key', meta.key);
  const sender    = assertAddress('recordBag', meta.sender);
  const recipient = assertAddress('recordBag', meta.recipient);
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
  _saveBagMeta();
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
    _saveBagMeta();
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
      try { fs.unlinkSync(path.join(DIR_BAGS, key)); } catch {}
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
