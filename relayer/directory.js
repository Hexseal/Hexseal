// ─── Справочник открытых ключей чата ───────────────────────────────────────
//
// Хранит ТОЛЬКО открытую половину ключа чата на адрес — X25519 public key,
// 32 байта, hex, ровно то, что `deriveChatKeypair()` (frontend/src/lib/
// chatCrypto.ts) отдаёт как keypair.publicKey. Ничего секретного здесь нет
// и быть не может: открытый ключ на то и открытый, его знание не даёт
// ничего, кроме возможности запечатать сообщение ДЛЯ этого адреса — не
// прочитать чужое (см. sealForRecipient() в chatCrypto.ts).
//
// Хранение — по образцу _profileNonces в app.js (JSON на диске, загрузка
// при старте, перезапись при изменении), но с двумя уроками, на которые
// прямо указывает бриф Задачи 2 (bagStore.js прошёл шесть раундов правок
// именно на этой теме):
//
//   1. Потеря/порча ВСЕГО файла обязана быть громкой, не тихим "начнём с
//      пустого". В отличие от bagStore.js, здесь НЕТ независимого источника
//      для восстановления — нет per-адрес файлов на диске, которые можно
//      было бы пересканировать и собрать индекс заново; JSON-файл — это и
//      есть данные, не индекс НАД данными. Поэтому при обнаруженной порче
//      ВСЕГО файла справочник входит в режим недоверия — putKey()/
//      getKeyRecord() бросают ошибку с кодом 'directory_unavailable', а не
//      ведут себя так, будто никто никогда не регистрировался (что было бы
//      неотличимо от адреса, который просто не заходил — ровно то смешение,
//      против которого поставлено правило 5 брифа). Порча ОДНОЙ записи —
//      другое дело: остальные адреса читаются нормально, теряется только
//      битая запись (тот же приём, что и в bagStore.js).
//
//   2. Порядок «переменные окружения — до импорта»: пути и потолок истории
//      считаются лениво, через _refreshConfig()/assertDirectoryReady(), а
//      не один раз на уровне модуля константой — app.js обязан звать
//      assertDirectoryReady() ПОСЛЕ dotenv.config(), тем же порядком, что и
//      assertBagStoreReady()/assertBagPassReady() уже делают для своих
//      модулей (см. комментарий над их импортом в app.js).
//
// Запись — целиком СИНХРОННАЯ (fs.writeFileSync/renameSync), не async: то
// же рассуждение, что и в bagStore.js — событийный цикл Node.js гарантирует,
// что один синхронный вызов putKey() отрабатывает от начала до конца,
// прежде чем управление может перейти ко второму. Два запроса, "прилетевших
// разом" на один и тот же адрес (два маршрута /keys одного процесса), не
// дерутся за общее состояние — они просто исполняются один за другим, в
// том порядке, в котором Node забрал их с сокета, и оба честно остаются в
// истории (см. putKey ниже). Настоящую параллельность (два ОТДЕЛЬНЫХ
// процесса релеера поверх одного STORAGE_DIR) это не решает — та же
// оговорка, что и у остальных writer'ов этого файла-хранилища в проекте
// (_profileNonces, _pushSubs, bagStore.js): последний записавший процесс
// побеждает, гонки между процессами эта конструкция не разрешает.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Нижний регистр — единственный источник адреса для putKey()/getKeyRecord()
// это уже нормализованный адрес: putKey() получает адрес пропуска
// (verifyBagPass() возвращает его ровно в том виде, в каком issueBagPass()
// туда положил — см. bagPass.js:58, всегда lower-case), а GET /keys/:address
// в app.js лоуэркейсит сырой URL-параметр САМ, до вызова getKeyRecord() —
// тем же приёмом, что и PUT /bags/:recipient уже делает для req.params.recipient.
// Этот модуль лоуэркейс не делает и не обязан — ему приходят уже нормализованные значения.
const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;

// 32 байта, hex, с 0x — ровно то, что `bytesToHex(keypair.publicKey)` (viem)
// отдаёт для X25519-ключа chatCrypto.ts. Регистр не диктуется формой (это
// не адрес кошелька с чексуммой, обычные байты) — принимаем оба варианта на
// входе, но храним нормализованным к нижнему, чтобы сравнение "ключ не
// поменялся" (putKey ниже, дедуп повторной идентичной регистрации) не
// зависело от регистра, которым конкретный вызов его прислал.
const KEY_HEX_RE = /^0x[0-9a-fA-F]{64}$/;

export let STORAGE_DIR;
export let DIRECTORY_FILE;
// Сколько последних СМЕНЁННЫХ ключей адрес хранит в истории (правило 3
// брифа Задачи 2). Не "без ограничения": история растёт от каждой НАСТОЯЩЕЙ
// смены ключа (повторная отправка того же значения — не смена, putKey ниже
// это различает и не пишет дубль), но putKey не проверяет, что новое
// значение — реальный X25519 public key чьей-то настоящей пары: это 32
// произвольных байта по форме, авторизованных только фактом владения
// пропуском. Без потолка авторизованный, но недобросовестный вызывающий
// (свой собственный адрес, свой собственный пропуск) мог бы разогнать
// историю СВОЕГО же адреса до произвольного размера чистым перебором
// случайных 32 байт — заперто числом здесь (ограничивает ИТОГ) вместе со
// скоростью (KEYS_WRITE_RATE_MAX в app.js ограничивает, как быстро можно
// писать — см. отчёт задачи, вопрос 5). 20 — на порядок больше, чем реально
// нужно человеку за всю жизнь чата (потеря устройства — редкое событие), с
// запасом.
export let MAX_KEY_HISTORY;

function _refreshConfig() {
  STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
  DIRECTORY_FILE = path.join(STORAGE_DIR, 'chat-key-directory.json');
  MAX_KEY_HISTORY = Number(process.env.MAX_KEY_HISTORY || 20);
}
_refreshConfig();

function fail(fn, detail) {
  throw new Error(`${fn}: ${detail}`);
}

// Вызывать один раз при старте, ПОСЛЕ dotenv.config() — тот же контракт,
// что assertBagStoreReady()/assertBagPassReady() (bagStore.js/bagPass.js).
// Перечитывает конфиг из process.env и перезагружает файл, ЕСЛИ путь
// реально изменился (тот же приём C1 из bagStore.js: повторный вызов с тем
// же STORAGE_DIR не должен перечитывать диск и рисковать затереть память
// чем-то более старым, чем уже накопленное в этом процессе состояние).
export function assertDirectoryReady() {
  const previous = DIRECTORY_FILE;
  _refreshConfig();
  if (!Number.isFinite(MAX_KEY_HISTORY) || MAX_KEY_HISTORY <= 0) {
    fail('assertDirectoryReady', `MAX_KEY_HISTORY=${JSON.stringify(process.env.MAX_KEY_HISTORY)} is not a positive finite number (parsed as ${MAX_KEY_HISTORY})`);
  }
  if (DIRECTORY_FILE !== previous) _loadDirectory();
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

class DirectoryUnavailableError extends Error {
  constructor() {
    super(
      'key directory is unavailable — its index file was lost or corrupted, and unlike bagStore.js ' +
      'there is no independent per-address data on disk to reconstruct it from. Refusing to serve ' +
      'reads or writes (rather than silently acting as if nobody has ever registered) until a human ' +
      'restores the file from backup and restarts the process. No automatic recovery.'
    );
    this.code = 'directory_unavailable';
  }
}

function _isValidRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (typeof rec.key !== 'string' || !KEY_HEX_RE.test(rec.key)) return false;
  if (typeof rec.updatedAt !== 'number' || !Number.isFinite(rec.updatedAt)) return false;
  if (!Array.isArray(rec.history)) return false;
  for (const h of rec.history) {
    if (!h || typeof h !== 'object') return false;
    if (typeof h.key !== 'string' || !KEY_HEX_RE.test(h.key)) return false;
    if (typeof h.replacedAt !== 'number' || !Number.isFinite(h.replacedAt)) return false;
  }
  return true;
}

let _directory = Object.create(null);
let _directoryLoadOk = true;

export function isDirectoryHealthy() {
  return _directoryLoadOk;
}

// Загружает справочник с диска. Различает ТРИ случая, как и bagStore.js
// (_loadBagMeta) — но здесь только два ведут к недоверию, не три, потому
// что "диск не читается вообще" (третий случай bagStore.js, _isDiskReadable)
// не имеет аналога: этот модуль не обходит каталог, он читает один файл, и
// fs.readFileSync() либо отдаёт содержимое, либо бросает — оба случая уже
// покрыты try/catch ниже.
//   - файла нет → легитимная пустота (свежая установка);
//   - файл есть, но не парсится как JSON, или парсится не в объект
//     (null/массив/примитив) → ПОТЕРЯ ВСЕГО справочника, громко, режим
//     недоверия;
//   - файл есть, парсится в объект, но ОТДЕЛЬНЫЕ записи в нём не проходят
//     форму (isValidRecord) → эти записи отбрасываются поодиночке, громко,
//     но справочник В ЦЕЛОМ остаётся здоров — соседние адреса не задеты.
export function _loadDirectory() {
  if (!fs.existsSync(DIRECTORY_FILE)) {
    _directory = Object.create(null);
    _directoryLoadOk = true;
    return _directory;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DIRECTORY_FILE, 'utf8'));
  } catch (e) {
    console.error(
      `[directory] _loadDirectory: ENTERING DISTRUST MODE — index at ${DIRECTORY_FILE} exists but could ` +
      `not be parsed as JSON (${e.message}). Unlike bagStore.js there is no per-address file on disk to ` +
      `reconstruct from — this file IS the data, not an index over it. Both POST /keys and ` +
      `GET /keys/:address will answer with code 'directory_unavailable' until a human restores this file ` +
      `from backup and restarts the process. The broken file is left EXACTLY as it is — it is evidence, ` +
      `not something to clean up. No automatic recovery.`
    );
    _directory = Object.create(null);
    _directoryLoadOk = false;
    return _directory;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(
      `[directory] _loadDirectory: ENTERING DISTRUST MODE — index at ${DIRECTORY_FILE} parsed but is not ` +
      `an object (null/array/primitive). Same handling and same warning as unparseable JSON above.`
    );
    _directory = Object.create(null);
    _directoryLoadOk = false;
    return _directory;
  }

  const clean = Object.create(null);
  let dropped = 0;
  for (const [addr, rec] of Object.entries(parsed)) {
    if (ETH_ADDR_RE.test(addr) && _isValidRecord(rec)) {
      clean[addr] = {
        key: rec.key.toLowerCase(),
        updatedAt: rec.updatedAt,
        history: rec.history.map((h) => ({ key: h.key.toLowerCase(), replacedAt: h.replacedAt })),
      };
    } else {
      dropped++;
      console.error(`[directory] _loadDirectory: dropping corrupt entry ${JSON.stringify(addr)} from ${DIRECTORY_FILE} — the rest of the directory is unaffected`);
    }
  }
  if (dropped) {
    console.error(`[directory] _loadDirectory: dropped ${dropped} corrupt ${dropped === 1 ? 'entry' : 'entries'} out of ${Object.keys(parsed).length} from ${DIRECTORY_FILE}`);
  }

  _directory = clean;
  _directoryLoadOk = true;
  return _directory;
}
_loadDirectory(); // начальная загрузка при импорте — перечитывается assertDirectoryReady(), если путь реально сменился

// Пишет во временный файл и переименовывает — тот же приём, что
// _saveBagMeta() (bagStore.js) и savePushSubs()/saveProfileNonces() (app.js):
// fs.renameSync на одной файловой системе атомарен, так что DIRECTORY_FILE
// в любой момент — это либо полностью старое содержимое, либо полностью
// новое, никогда наполовину записанное. Ошибка не глотается: throw после
// логирования — вызывающий (putKey) обязан откатить свою in-memory мутацию,
// иначе память забежит вперёд диска.
function _saveDirectory() {
  const tmpPath = `${DIRECTORY_FILE}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(_directory), 'utf8');
    fs.renameSync(tmpPath, DIRECTORY_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    console.error(`[directory] FAILED TO SAVE ${DIRECTORY_FILE} — in-memory directory and disk directory would have diverged, change rolled back by the caller: ${e.message}`);
    throw e;
  }
}

function assertReady() {
  if (!_directoryLoadOk) throw new DirectoryUnavailableError();
}

/**
 * Кладёт открытый ключ для адреса. `address` обязан быть уже нормализован
 * (нижний регистр, ровно 40 hex-цифр после 0x) — вызывающая сторона
 * (маршрут POST /keys в app.js) обязана брать его ИЗ ПРОПУСКА, не из тела
 * запроса (правило 1 брифа); этот модуль про пропуска ничего не знает и
 * просто доверяет форме своего аргумента, как и bagStore.js доверяет форме
 * своих.
 *
 * Смена ключа (новое значение отличается от текущего) уносит СТАРЫЙ в
 * `history`, срез до MAX_KEY_HISTORY последних (правило 3). Повторная
 * отправка ТОГО ЖЕ значения — не смена: history не растёт (обычный путь
 * клиента при каждом открытии сеанса — см. lib/chatSession.ts, Задача 4 —
 * не должен раздувать историю на каждый визит).
 *
 * @throws {Error} с `.code === 'invalid_key'`, если keyHex не 32-байтовый
 *   hex (правило 2) — сюда же попадает "не строка вовсе" (число, массив,
 *   объект, null/undefined): мусор на входе, не событие протокола.
 * @throws {DirectoryUnavailableError} (`.code === 'directory_unavailable'`),
 *   если справочник в режиме недоверия (см. _loadDirectory).
 */
export function putKey(address, keyHex, nowMs = Date.now()) {
  assertReady();
  if (typeof address !== 'string' || !ETH_ADDR_RE.test(address)) {
    fail('putKey', `invalid address ${JSON.stringify(address)} — caller must normalize (lower-case, from a verified pass) before calling`);
  }
  if (typeof keyHex !== 'string' || !KEY_HEX_RE.test(keyHex)) {
    const err = new Error(`putKey: invalid chat public key — expected 0x + 64 hex chars (32 bytes), got ${JSON.stringify(keyHex)}`);
    err.code = 'invalid_key';
    throw err;
  }
  if (!Number.isSafeInteger(nowMs)) {
    fail('putKey', `invalid nowMs ${JSON.stringify(nowMs)}`);
  }

  const key = keyHex.toLowerCase();
  const existing = _directory[address];
  const previous = existing; // record целиком — откатываем присваиванием, не точечной мутацией полей

  let history = existing ? existing.history : [];
  if (existing && existing.key !== key) {
    history = [{ key: existing.key, replacedAt: nowMs }, ...history].slice(0, MAX_KEY_HISTORY);
  }

  _directory[address] = { key, updatedAt: nowMs, history };
  try {
    _saveDirectory();
  } catch (e) {
    if (previous) _directory[address] = previous;
    else delete _directory[address];
    throw e;
  }
  return { address, key, updatedAt: nowMs, history: history.slice() };
}

/**
 * Читает открытый ключ адреса — без пропуска, открытый ключ на то и
 * открытый (правило 4). `null`, если адрес никогда не регистрировал ключ
 * (правило 5: вызывающая сторона, маршрут GET /keys/:address, обязана
 * превратить это в 404 с кодом — не в пустой 200).
 *
 * @throws {DirectoryUnavailableError}, если справочник в режиме недоверия.
 */
export function getKeyRecord(address) {
  assertReady();
  if (typeof address !== 'string' || !ETH_ADDR_RE.test(address)) {
    fail('getKeyRecord', `invalid address ${JSON.stringify(address)}`);
  }
  const rec = _directory[address];
  if (!rec) return null;
  return { address, key: rec.key, updatedAt: rec.updatedAt, history: rec.history.slice() };
}
