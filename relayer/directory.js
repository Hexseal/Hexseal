// ─── Справочник открытых ключей чата ───────────────────────────────────────
//
// Хранит открытые ключи чата на адрес. Сегодня это только `boxKey` — X25519
// ключ ЗАПЕЧАТЫВАНИЯ (то, что `deriveChatKeypair()`, frontend/src/lib/
// chatCrypto.ts, отдаёт как keypair.publicKey; `sealForRecipient()` шифрует
// на него). `signKey` — ключ ПРОВЕРКИ ПОДПИСИ звеньев `chatChain.ts` —
// поле заведено рядом, но пока всегда пусто: пары для подписи в проекте
// ЕЩЁ НЕТ (docs/superpowers/specs/2026-08-02-e2e-chat-design.md:257),
// появится и станет заполняться в Задаче 5. Ничего секретного здесь нет и
// быть не может ни для одного из двух: открытый ключ на то и открытый.
//
// ⚠️ РЕВЬЮ КООРДИНАТОРА (И-1, после первой версии этого файла): поле
// называлось просто `key` — неправда по умолчанию наводила на мысль, что
// в справочнике достаточно данных, чтобы проверить подпись. Не наводила бы,
// если бы поле называлось честно. Переименовано; `signKey` заведено
// заранее пустым местом, а не задним числом, когда понадобится.
//
// Хранение — по образцу _profileNonces в app.js (JSON на диске, загрузка
// при старте, перезапись при изменении), но с уроками, на которые прямо
// указывает бриф Задачи 2 и ревью координатора (bagStore.js прошёл шесть
// раундов правок именно на этой теме):
//
//   1. Потеря/порча ВСЕГО файла обязана быть громкой, не тихим "начнём с
//      пустого". В отличие от bagStore.js, здесь НЕТ независимого источника
//      для восстановления — нет per-адрес файлов на диске, которые можно
//      было бы пересканировать и собрать индекс заново; JSON-файл — это и
//      есть данные, не индекс НАД данными. Поэтому при обнаруженной порче
//      ВСЕГО файла справочник входит в режим недоверия — putKey()/
//      getKeyRecord() бросают ошибку с кодом 'directory_unavailable', а не
//      ведут себя так, будто никто никогда не регистрировался. Порча ОДНОЙ
//      записи — другое дело: остальные адреса читаются нормально, теряется
//      только битая запись (тот же приём, что и в bagStore.js). Оговорка
//      (найдена ревью, см. комментарий над _loadDirectory ниже): это
//      защищает только порчу, случившуюся ДО загрузки — порча ПОСЛЕ
//      успешного старта процесса не перечитывается заново до рестарта, и
//      следующая успешная запись честно перезапишет испорченный файл своим
//      in-memory состоянием, как и любой другой JSON-стор в этом проекте.
//
//   2. Порядок «переменные окружения — до импорта»: пути и потолок истории
//      считаются лениво, через _refreshConfig()/assertDirectoryReady(), а
//      не один раз на уровне модуля константой — app.js обязан звать
//      assertDirectoryReady() ПОСЛЕ dotenv.config(), тем же порядком, что и
//      assertBagStoreReady()/assertBagPassReady() уже делают для своих
//      модулей (см. комментарий над их импортом в app.js).
//
//   3. Форма записи ВПЕРЁД-СОВМЕСТИМА (И-1, вторая половина находки,
//      целиком моя): раньше _loadDirectory() пересобирала запись, явно
//      перечисляя только известные поля (key/updatedAt/history) — любое
//      постороннее поле стиралось молча на КАЖДОЙ загрузке. Это значит, что
//      любое будущее расширение формы записи (например, `signKey`,
//      реально заполненный Задачей 5) было бы ломающей миграцией,
//      обнаруживаемой не сразу, а после первого перезапуска процесса на
//      промежуточной версии кода. Починено: _loadDirectory() и putKey()
//      теперь СОХРАНЯЮТ любое незнакомое поле через spread, проверяя форму
//      только известных полей. Поле версии (`v`) заведено на будущее — не
//      гейтится строго (readerа новее писавшего это не смущает), только
//      фиксирует, каким писателем запись была создана.
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
// отдаёт для X25519-ключа chatCrypto.ts. Строго нижний регистр (не
// case-insensitive) — см. _isValidKeyHex ниже, почему это НЕ то же самое,
// что адрес кошелька с чексуммой.
const KEY_HEX_RE = /^0x[0-9a-f]{64}$/;
// Мелочь (ревью координатора, round 2): всенулевой ключ — один из
// известных вырожденных low-order-точек кривой X25519 (RFC 7748 §5) —
// проходит по форме (32 байта, hex), но запечатать на него содержательно
// нельзя: shared secret вырождается. Чаще всего это признак
// неинициализированного буфера на клиенте, а не настоящего ключа —
// отклоняем по форме, не пытаясь угадать намерение.
const ALL_ZERO_KEY_RE = /^0x0{64}$/;

export let STORAGE_DIR;
export let DIRECTORY_FILE;
// Сколько последних СМЕНЁННЫХ boxKey адрес хранит в истории (правило 3
// брифа Задачи 2). Замер координатора (round 2): на прежнем умолчании (20)
// владелец адреса может 21 сменой ключа за считанные минуты вытолкнуть из
// истории ЛЮБОЙ конкретный старый ключ — включая тот, которым подписано
// неудобное сообщение, после чего проверка этой подписи перестаёт быть
// возможной. 200 делает то же самое непрактичным (смена ключа — событие
// уровня «потерял устройство», честный человек не наберёт 20 таких событий
// за всю жизнь, не то что 200) — но НЕ делает невозможным теоретически,
// поэтому рядом заведён `keyChangeCount` (см. putKey), который НЕ обрезается
// никогда: даже если история физически не может хранить всё, число смен
// само по себе — недорогая, вечная улика для арбитра ("этот адрес менял
// ключ 47 раз").
export let MAX_KEY_HISTORY;

function _refreshConfig() {
  STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
  DIRECTORY_FILE = path.join(STORAGE_DIR, 'chat-key-directory.json');
  MAX_KEY_HISTORY = Number(process.env.MAX_KEY_HISTORY || 200);
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

// Текущая версия формата записи, которую ЭТОТ код умеет писать с нуля.
// Записи, загруженные с ДРУГИМ (в т.ч. более новым) `v`, не отвергаются —
// см. _isValidRecord/_loadDirectory: поле проверяется по типу (число), не
// по значению, и любые незнакомые соседние поля переживают загрузку и
// повторное сохранение через spread, а не стираются.
const RECORD_VERSION = 1;

function _isValidKeyHex(v) {
  return typeof v === 'string' && KEY_HEX_RE.test(v) && !ALL_ZERO_KEY_RE.test(v);
}

function _isValidHistoryEntry(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
  if (!_isValidKeyHex(h.boxKey)) return false;
  if (typeof h.replacedAt !== 'number' || !Number.isFinite(h.replacedAt)) return false;
  if (h.signKey !== undefined && !_isValidKeyHex(h.signKey)) return false;
  return true;
}

function _isValidRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (!_isValidKeyHex(rec.boxKey)) return false;
  if (typeof rec.updatedAt !== 'number' || !Number.isFinite(rec.updatedAt)) return false;
  if (!Array.isArray(rec.history) || !rec.history.every(_isValidHistoryEntry)) return false;
  if (rec.signKey !== undefined && !_isValidKeyHex(rec.signKey)) return false;
  // keyChangeCount — счётчик ВСЕХ смен boxKey за всю жизнь адреса, никогда
  // не обрезается (в отличие от history) и никогда не убывает (И-2,
  // находка координатора, round 2: без него обрезанная history даёт
  // УВЕРЕННО НЕВЕРНЫЙ ответ на "какой ключ действовал в момент T", а не
  // честное "не знаю" — этот счётчик и historyTruncated ниже дают читателю
  // способ отличить одно от другого).
  if (typeof rec.keyChangeCount !== 'number' || !Number.isFinite(rec.keyChangeCount) || rec.keyChangeCount < 0) return false;
  // v — только тип, не конкретное значение: вперёд-совместимость, не гейт версии.
  if (rec.v !== undefined && typeof rec.v !== 'number') return false;
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
//
// ⚠️ Вызывается ОДИН РАЗ при старте (и повторно из assertDirectoryReady(),
// если STORAGE_DIR реально сменился) — НЕ на каждый запрос. Порча файла
// РУКАМИ, случившаяся ПОСЛЕ того, как процесс уже успешно загрузился,
// этой функцией не замечается вообще: _directoryLoadOk остаётся true,
// GET /keys/:address продолжает честно отвечать 200 из памяти, а
// СЛЕДУЮЩАЯ успешная putKey()/_saveDirectory() молча перезапишет испорченный
// файл своим in-memory состоянием — той же участи, что и у любого другого
// JSON-стора этого проекта (_profileNonces, _pushSubs, bag-meta.json).
// Раньше комментарий здесь утверждал обратное ("файл не тронут") без этой
// оговорки — верно только для порчи, обнаруженной ПРИ загрузке, не для
// порчи, случившейся уже под живым процессом (найдено ревью).
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
      // И-1 (вторая половина, целиком моя находка при ревью): spread
      // `...rec` СНАЧАЛА — любое поле, которого эта версия кода не знает
      // (будущая находка Задачи 5, например), переживает загрузку как есть,
      // вместо того чтобы быть молча стёртым явным перечислением полей.
      // Известные поля переопределяются НАД ним. Регистр здесь уже не
      // нормализуется (мелочь, ревью координатора): _isValidRecord/
      // _isValidKeyHex гейтят на СТРОГО нижний регистр раньше, чем
      // выполнение доходит до этой строки — запись с boxKey не в нижнем
      // регистре уже отброшена как повреждённая веткой else ниже, а не
      // молча приведена. Единственная реальная нормализация здесь — потолок
      // истории (И-2: применяется и при ЗАГРУЗКЕ, не только при следующей
      // смене — иначе длинная история, унаследованная с диска при понижении
      // MAX_KEY_HISTORY окружением, жила бы до следующей смены ключа), плюс
      // свежие объекты-звенья вместо алиасов на то, что вернул JSON.parse.
      clean[addr] = {
        ...rec,
        history: rec.history.map((h) => ({ ...h })).slice(0, MAX_KEY_HISTORY),
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

function _assertKeyHexInput(fieldName, value) {
  // Единый источник истины с _isValidRecord/_loadDirectory (_isValidKeyHex)
  // — форма, которую сервер принимает НА ЗАПИСИ, обязана быть в точности
  // той же, что он считает валидной ПРИ ЗАГРУЗКЕ; две отдельные копии
  // одной и той же проверки рано или поздно разойдутся молча.
  if (!_isValidKeyHex(value)) {
    const err = new Error(`putKey: invalid ${fieldName} — expected 0x + 64 lower-case hex chars (32 bytes), not the all-zero key, got ${JSON.stringify(value)}`);
    err.code = 'invalid_key';
    throw err;
  }
  return value;
}

// Деep-копия для всего, что покидает модуль (мелочь, найдена ревью:
// getKeyRecord() раньше отдавала history.slice() — новый МАССИВ, но те же
// ОБЪЕКТЫ-звенья, что лежат в _directory. Вызывающий код, случайно
// мутировавший одно поле одного звена возвращённой записи, менял бы
// состояние модуля исподтишка, без единого явного putKey().
function _cloneHistoryEntry(h) {
  return { ...h };
}

// historyTruncated — И-2, третья часть находки: если keyChangeCount больше
// того, что физически уместилось в history (потолок сработал), запросу
// "какой ключ действовал в момент T" неоткуда взять честный ответ для
// момента раньше самой старой уцелевшей записи — читатель обязан узнать об
// этом явным признаком, а не догадываться по совпадению длины истории с
// умолчанием.
function _cloneRecordForCaller(address, rec) {
  return {
    ...rec,
    address,
    history: rec.history.map(_cloneHistoryEntry),
    historyTruncated: rec.keyChangeCount > rec.history.length,
  };
}

/**
 * Кладёт открытые ключи для адреса. `address` обязан быть уже нормализован
 * (нижний регистр, ровно 40 hex-цифр после 0x) — вызывающая сторона
 * (маршрут POST /keys в app.js) обязана брать его ИЗ ПРОПУСКА, не из тела
 * запроса (правило 1 брифа); этот модуль про пропуска ничего не знает и
 * просто доверяет форме своего аргумента, как и bagStore.js доверяет форме
 * своих.
 *
 * `keys.boxKey` обязателен. `keys.signKey` необязателен (пока всегда
 * отсутствует — см. докстринг файла) — если передан, сохраняется рядом, но
 * НЕ считается сменой сам по себе: history/keyChangeCount/updatedAt следят
 * только за `boxKey`, потому что именно он определяет, какие сообщения
 * читаются (правило 3 брифа — "переписка станет нечитаемой" относится к
 * запечатыванию, не к подписи). Если у Задачи 5 окажется, что смена
 * signKey тоже должна двигать historyу — это отдельное решение, не взятое
 * здесь по умолчанию.
 *
 * Смена boxKey (новое значение отличается от текущего) уносит СТАРЫЙ в
 * `history` (срез до MAX_KEY_HISTORY последних, правило 3) и увеличивает
 * `keyChangeCount` — этот счётчик НЕ обрезается никогда, переживает любой
 * потолок истории. Повторная отправка ТОГО ЖЕ boxKey — не смена: history и
 * keyChangeCount не растут, `updatedAt` НЕ двигается (И-2, находка
 * координатора: если бы двигался, "с какого момента ключ действует" было
 * бы невосстановимо для адреса, который вообще никогда не менял ключ, —
 * observer видел бы только "недавно", даже если это неправда).
 *
 * @throws {Error} с `.code === 'invalid_key'`, если boxKey/signKey не
 *   32-байтовый нижнерегистровый hex (правило 2) — сюда же попадает "не
 *   строка вовсе" (число, массив, объект, null/undefined) и `keys` целиком
 *   не объект: мусор на входе, не событие протокола.
 * @throws {DirectoryUnavailableError} (`.code === 'directory_unavailable'`),
 *   если справочник в режиме недоверия (см. _loadDirectory).
 */
export function putKey(address, keys, nowMs = Date.now()) {
  assertReady();
  if (typeof address !== 'string' || !ETH_ADDR_RE.test(address)) {
    fail('putKey', `invalid address ${JSON.stringify(address)} — caller must normalize (lower-case, from a verified pass) before calling`);
  }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    const err = new Error(`putKey: invalid key input — expected { boxKey, signKey? }, got ${JSON.stringify(keys)}`);
    err.code = 'invalid_key';
    throw err;
  }
  const boxKey = _assertKeyHexInput('boxKey', keys.boxKey);
  const signKey = keys.signKey !== undefined ? _assertKeyHexInput('signKey', keys.signKey) : undefined;
  if (!Number.isSafeInteger(nowMs)) {
    fail('putKey', `invalid nowMs ${JSON.stringify(nowMs)}`);
  }

  const existing = _directory[address];
  const previous = existing; // record целиком — откатываем присваиванием, не точечной мутацией полей

  const isRealChange = !existing || existing.boxKey !== boxKey;

  let history = existing ? existing.history : [];
  let keyChangeCount = existing ? existing.keyChangeCount : 0;
  if (existing && isRealChange) {
    const histEntry = { boxKey: existing.boxKey, replacedAt: nowMs };
    if (existing.signKey !== undefined) histEntry.signKey = existing.signKey;
    history = [histEntry, ...history].slice(0, MAX_KEY_HISTORY);
    keyChangeCount += 1;
  }

  const updatedAt = isRealChange ? nowMs : existing.updatedAt;

  // spread `...(existing || {})` СНАЧАЛА — то же правило И-1, что и в
  // _loadDirectory: если у existing были поля, которых ЭТА версия кода не
  // понимает (более новая запись, преодолевшая _isValidRecord благодаря
  // вперёд-совместимости), они переживают и эту перезапись, не только
  // загрузку. `v` НЕ переустанавливается на RECORD_VERSION для уже
  // существующей записи — этот писатель не обязан заявлять о ней больше,
  // чем реально знает.
  const record = {
    ...(existing || {}),
    v: existing ? (existing.v ?? RECORD_VERSION) : RECORD_VERSION,
    boxKey,
    updatedAt,
    history,
    keyChangeCount,
  };
  if (signKey !== undefined) record.signKey = signKey;
  // signKey не передан этим вызовом — ничего доп. делать не нужно: если он
  // уже был у existing, spread выше его уже сохранил как есть.

  _directory[address] = record;
  try {
    _saveDirectory();
  } catch (e) {
    if (previous) _directory[address] = previous;
    else delete _directory[address];
    throw e;
  }
  return _cloneRecordForCaller(address, record);
}

/**
 * Читает открытые ключи адреса — без пропуска, открытый ключ на то и
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
  return _cloneRecordForCaller(address, rec);
}
