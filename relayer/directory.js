// ─── Справочник открытых ключей чата ───────────────────────────────────────
//
// Хранит открытые ключи чата на адрес — ДВА, и оба заполняются сегодня.
// `boxKey` — X25519 ключ ЗАПЕЧАТЫВАНИЯ (то, что `deriveChatKeypair()`,
// frontend/src/lib/chatCrypto.ts, отдаёт как keypair.publicKey;
// `sealForRecipient()` шифрует на него). `signKey` — Ed25519 ключ ПРОВЕРКИ
// ПОДПИСИ звеньев: его выводит `deriveLinkSigningKeypair()`
// (frontend/src/lib/chatConversation.ts) отдельным под-ключом, клиент
// публикует его вместе с `boxKey` и ПИНУЕТ им подписи собеседника. Ничего
// секретного здесь нет и быть не может ни для одного из двух: открытый ключ
// на то и открытый.
//
// ⚠️ До финальной проверки ветки здесь (и ещё в двух местах) было написано
// «пока всегда пусто, пары для подписи в проекте ещё нет, появится в Задаче
// 5». Задача 5 прошла: пара есть, ключ публикуется и пинуется. Написанное
// разошлось с делом ровно в том месте, где по нему судят, достаточно ли в
// справочнике данных, чтобы проверить подпись.
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

// `changed` — И-2 (ревью координатора, round 3): необязательное на ЗАГРУЗКЕ
// (не гейтится строго) — записи, созданные ДО этого поля (та же ветвь
// разработки, до этого самого раунда), не отбрасываются как повреждённые
// только за его отсутствие; то же вперёд/назад-совместимое чтение, что
// И-1 уже устанавливает для формы записи в целом. Если поле присутствует,
// форма проверяется: массив из известных имён, не что попало.
const HISTORY_CHANGED_VALUES = new Set(['boxKey', 'signKey']);

function _isValidHistoryEntry(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
  if (!_isValidKeyHex(h.boxKey)) return false;
  if (typeof h.replacedAt !== 'number' || !Number.isFinite(h.replacedAt)) return false;
  if (h.signKey !== undefined && !_isValidKeyHex(h.signKey)) return false;
  if (h.changed !== undefined) {
    if (!Array.isArray(h.changed)) return false;
    if (!h.changed.every((c) => HISTORY_CHANGED_VALUES.has(c))) return false;
  }
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

  const totalCount = Object.keys(parsed).length;
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
      // В-5 (аудит устойчивости, 6 августа): потолок здесь БОЛЬШЕ НЕ
      // ПРИМЕНЯЕТСЯ. Раньше стоял `.slice(0, MAX_KEY_HISTORY)` (И-2), и это
      // была ошибка того самого класса, против которого история заведена.
      //
      // Замер: 30 честных смен ключа, затем законная опечатка в окружении
      // (хотели MAX_KEY_HISTORY=200, набрали 2) — 29 звеньев на диске
      // превращались в 2 при первой же обычной смене ключа, и исправление
      // опечатки их НЕ ВОЗВРАЩАЛО. Ключ, которым подписано неудобное
      // сообщение, исчезал, и проверить подпись под ним становилось нечем.
      //
      // Потолок ограничивает РОСТ (см. putKey ниже), а не задним числом уже
      // записанное. Прочитанное с диска отдаётся как есть.
      clean[addr] = {
        ...rec,
        history: rec.history.map((h) => ({ ...h })),
      };
    } else {
      dropped++;
      console.error(`[directory] _loadDirectory: dropping corrupt entry ${JSON.stringify(addr)} from ${DIRECTORY_FILE} — the rest of the directory is unaffected`);
    }
  }
  // C1 (ревью координатора, round 3, КРИТИЧЕСКАЯ): "отбросили ВСЕ записи" —
  // не то же самое, что "отбросили несколько кривых, остальное здоровое".
  // Если записей было больше нуля и КАЖДАЯ провалила форму, это неотличимо
  // от "формат целиком незнаком этому коду" (откат релеера на ревизию,
  // не знающую boxKey — рассинхрон, который эта же задача и создала
  // переименованием поля; накат обратно после отката; будущий signKey
  // другого размера) — а не от "каждый адрес одновременно испортился
  // случайно по отдельности". Без этой ветки: справочник объявлял бы себя
  // здоровым и пустым, GET отвечал бы 404 key_not_found (= "вы никогда не
  // регистрировались") КАЖДОМУ адресу, что реально был на диске, а первая
  // же запись ЛЮБОГО постороннего адреса переписала бы файл ровно этой
  // одной записью — навсегда. Тот же класс, ради которого шапка модуля
  // обещает громкость при полной потере; ветка "не парсится" его уже
  // держала, эта — нет.
  if (totalCount > 0 && dropped === totalCount) {
    console.error(
      `[directory] _loadDirectory: ENTERING DISTRUST MODE — index at ${DIRECTORY_FILE} has ${totalCount} ` +
      `${totalCount === 1 ? 'entry' : 'entries'}, and EVERY ONE failed the shape check (see the ` +
      `"dropping corrupt entry" line(s) above for which and why). Treating this as "a few bad entries, ` +
      `otherwise healthy and empty" would answer every read with 404 'key_not_found' — indistinguishable ` +
      `from "this address never registered" — and let the very next successful write from ANY unrelated ` +
      `address overwrite this file with just that one record, permanently. The most likely cause is not ` +
      `simultaneous per-address corruption but a format this reader does not understand at all (a rollback ` +
      `to code predating a field rename, for example). Both POST /keys and GET /keys/:address will answer ` +
      `with code 'directory_unavailable' until a human restores this file from backup and restarts the ` +
      `process. The file is left EXACTLY as it is. No automatic recovery.`
    );
    _directory = Object.create(null);
    _directoryLoadOk = false;
    return _directory;
  }
  if (dropped) {
    console.error(`[directory] _loadDirectory: dropped ${dropped} corrupt ${dropped === 1 ? 'entry' : 'entries'} out of ${totalCount} from ${DIRECTORY_FILE}`);
  }

  _directory = clean;
  _directoryLoadOk = true;
  return _directory;
}
_loadDirectory(); // начальная загрузка при импорте — перечитывается assertDirectoryReady(), если путь реально сменился

// Мелочь (ревью координатора, round 2, "51 крах — 51 файл, уборки нет"):
// крах ровно между writeFileSync и renameSync (кончилось место, процесс
// убит) оставляет `.tmp-*` осколок в STORAGE_DIR навсегда — ни один
// штатный путь этого модуля его не видит (_loadDirectory читает только
// DIRECTORY_FILE по точному имени). Тот же приём, что sweepStaleTmpFiles()
// в bagStore.js: подчищаем осколки СТАРШЕ часа (заведомо дольше, чем может
// идти одна запись+переименование в норме, миллисекунды) — свежие не
// трогаем, чтобы не забежать вперёд ещё идущей записи ДРУГОГО процесса,
// который в этот самый момент пишет свой временный файл. Опортунистично,
// при следующей УСПЕШНОЙ записи (не отдельным расписанием — в отличие от
// bagStore.js, у directory.js нет собственного ночного cron-цикла).
function _sweepStaleTmpFiles(nowMs) {
  const cutoffMs = nowMs - 60 * 60 * 1000;
  const dir = path.dirname(DIRECTORY_FILE);
  const prefix = `${path.basename(DIRECTORY_FILE)}.tmp-`;
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const fp = path.join(dir, entry);
    try {
      // lstat, не stat — осколок не обязан физически быть обычным файлом
      // (символьная ссылка по предсказуемому имени и т.п.), не следуем за ней.
      const st = fs.lstatSync(fp);
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoffMs) fs.unlinkSync(fp);
    } catch { /* лучшая попытка — не мешает основной записи */ }
  }
}

// Пишет во временный файл и переименовывает — тот же приём, что
// _saveBagMeta() (bagStore.js) и savePushSubs()/saveProfileNonces() (app.js):
// fs.renameSync на одной файловой системе атомарен, так что DIRECTORY_FILE
// в любой момент — это либо полностью старое содержимое, либо полностью
// новое, никогда наполовину записанное. Ошибка не глотается: throw после
// логирования — вызывающий (putKey) обязан откатить свою in-memory мутацию,
// иначе память забежит вперёд диска.
// В-2 (аудит устойчивости, 6 августа): читает то, что СЕЙЧАС на диске, и
// подмешивает в него нашу память — вместо того чтобы затирать диск снимком
// целиком.
//
// При обычной выкатке старая и новая копии релеера какое-то время работают
// одновременно поверх одного STORAGE_DIR. Замер до правки: адрес,
// зарегистрированный старой копией в этом окне, ИСЧЕЗАЛ полностью, как
// только новая копия что-нибудь записывала, а keyChangeCount адреса —
// «вечная улика» против вытеснения неудобного ключа — недосчитывался.
//
// Правило слияния, ровно два:
//   • адрес, который есть на диске и которого нет у нас в памяти, остаётся
//     как есть (его завела другая копия — не нам его стирать);
//   • keyChangeCount адреса берётся БОЛЬШИЙ из двух: он объявлен никогда не
//     убывающим, и чужой устаревший снимок не имеет права его откатить.
// Всё остальное в записи — наше: мы именно сейчас её и меняем.
//
// Чего это НЕ делает: настоящей межпроцессной блокировки здесь по-прежнему
// нет (пункт 28.3 открытых вопросов). Две копии, записавшие в один и тот же
// миг, всё ещё могут потерять работу друг друга — окно сузилось до одного
// чтения-записи, но не закрылось. Настоящее решение — файловая блокировка
// или один-единственный писатель, и это отдельная задача.
function _mergeWithDisk(memory) {
  let onDisk;
  try {
    const parsed = JSON.parse(fs.readFileSync(DIRECTORY_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return memory;
    onDisk = parsed;
  } catch {
    return memory; // файла нет или он нечитаем — писать нашу память как есть
  }

  const merged = Object.create(null);
  for (const [addr, rec] of Object.entries(onDisk)) {
    if (ETH_ADDR_RE.test(addr) && _isValidRecord(rec)) merged[addr] = rec;
  }
  for (const [addr, rec] of Object.entries(memory)) {
    const diskRec = merged[addr];
    if (diskRec && typeof diskRec.keyChangeCount === 'number' && diskRec.keyChangeCount > rec.keyChangeCount) {
      merged[addr] = { ...rec, keyChangeCount: diskRec.keyChangeCount };
    } else {
      merged[addr] = rec;
    }
  }
  return merged;
}

function _saveDirectory() {
  const tmpPath = `${DIRECTORY_FILE}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(DIRECTORY_FILE), { recursive: true });
    // В-2: сливаем с диском ПЕРЕД записью, и результат слияния становится
    // нашей памятью — иначе следующая же запись снова затрёт чужое.
    _directory = _mergeWithDisk(_directory);
    fs.writeFileSync(tmpPath, JSON.stringify(_directory), 'utf8');
    fs.renameSync(tmpPath, DIRECTORY_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    console.error(`[directory] FAILED TO SAVE ${DIRECTORY_FILE} — in-memory directory and disk directory would have diverged, change rolled back by the caller: ${e.message}`);
    throw e;
  }
  // Только после УСПЕХА — падение самой записи не должно тащить за собой
  // ещё и отказ метлы как часть той же ошибки вызывающему.
  try { _sweepStaleTmpFiles(Date.now()); } catch { /* лучшая попытка */ }
}

function assertReady() {
  if (!_directoryLoadOk) throw new DirectoryUnavailableError();
}

// В-2: сколько смен ключа у этого адреса числится НА ДИСКЕ прямо сейчас.
// Читается по одному адресу и только на пути настоящей смены ключа —
// повторная регистрация тех же байт до сюда не доходит (ранний возврат в
// putKey), так что лишнего чтения файла на каждый заход клиента нет.
function _keyChangeCountOnDisk(address) {
  try {
    const parsed = JSON.parse(fs.readFileSync(DIRECTORY_FILE, 'utf8'));
    const rec = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed[address] : null;
    const n = rec && typeof rec.keyChangeCount === 'number' ? rec.keyChangeCount : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
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
// состояние модуля исподтишка, без единого явного putKey(). `changed`
// (И-2, round 3) — тот же класс дыры на один уровень глубже: `{...h}`
// копирует звено, но НЕ содержимое вложенного массива `changed` — без
// отдельного клонирования вызывающий код, сделавший
// `record.history[0].changed.push(...)`, менял бы массив, на который
// module по-прежнему ссылается. Самостоятельно найдено и закрыто здесь же
// (не отдельная находка ревью) — тот же приём, применённый к новому полю
// сразу, а не задним числом.
function _cloneHistoryEntry(h) {
  const clone = { ...h };
  if (Array.isArray(h.changed)) clone.changed = [...h.changed];
  return clone;
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
 * `keys.boxKey` обязателен. `keys.signKey` необязателен ПО ФОРМЕ — клиент
 * чата передаёт его всегда (см. докстринг файла), но старая запись без него
 * остаётся читаемой, и запись без него не отвергается.
 *
 * Смена ЛЮБОГО из двух ключей (новое значение отличается от текущего)
 * уносит СТАРУЮ пару в `history` (срез до MAX_KEY_HISTORY последних,
 * правило 3) и увеличивает `keyChangeCount` — этот счётчик НЕ обрезается
 * никогда, переживает любой потолок истории. И-2 (находка координатора,
 * round 3, дважды): первая версия отслеживала только boxKey — смена
 * signKey (единственного ключа, РАДИ ПРОВЕРКИ которого история вообще
 * заводится) стирала предыдущий signKey с диска бесследно: ни звена, ни
 * признака, ни намёка на обрезку — хуже, чем сама обрезка, у которой хотя
 * бы есть `historyTruncated`. Звено теперь несёт поле `changed` — массив
 * из `'boxKey'`/`'signKey'`, называющий явно, какой ключ(и) сменился
 * именно в ЭТОМ звене (оба сразу, если оба переданы одним вызовом — один
 * вызов даёт одно звено и один прирост `keyChangeCount`, не два).
 *
 * Повторная отправка байт-в-байт ТЕХ ЖЕ значений (оба ключа совпадают с
 * уже сохранёнными) — не смена вообще: ранний возврат ДО какой-либо
 * мутации `_directory` и ДО записи на диск (мелочь, найдена ревью, round
 * 3: клиент чата будет слать это при каждом запуске сеанса —
 * lib/chatSession.ts, Задача 4 — и без этой короткой цепи каждый такой
 * визит переписывал бы весь файл справочника заново, усиливая открытый
 * пункт 31 обычным пользованием, без единого нападающего). `updatedAt` НЕ
 * двигается на этом пути.
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

  const boxKeyChanged = !existing || existing.boxKey !== boxKey;
  const signKeyChanged = signKey !== undefined && (!existing || existing.signKey !== signKey);
  const isRealChange = boxKeyChanged || signKeyChanged;

  // Мелочь (ревью координатора, round 3): байт-в-байт идентичная повторная
  // регистрация — ранний возврат, ничего не трогая. `existing` здесь
  // всегда истинен на этом пути: первая регистрация делает boxKeyChanged
  // истинным через `!existing`, значит isRealChange тоже истинен, и эта
  // ветка для неё физически недостижима.
  if (existing && !isRealChange) {
    return _cloneRecordForCaller(address, existing);
  }

  let history = existing ? existing.history : [];
  // В-2: основание счётчика — БОЛЬШЕЕ из своего и того, что лежит на диске.
  // В окне выкатки другая живая копия могла увести счётчик вперёд, а наш
  // снимок в памяти застыл на моменте старта; прибавляя к своему, мы бы
  // молча списали её смены. Улика обязана только расти.
  let keyChangeCount = Math.max(
    existing ? existing.keyChangeCount : 0,
    _keyChangeCountOnDisk(address),
  );
  if (existing) {
    const changed = [];
    if (boxKeyChanged) changed.push('boxKey');
    if (signKeyChanged) changed.push('signKey');
    const histEntry = { boxKey: existing.boxKey, replacedAt: nowMs, changed };
    if (existing.signKey !== undefined) histEntry.signKey = existing.signKey;
    // В-5: режем до max(потолок, сколько уже есть) — а не до потолка.
    //
    // Смысл: потолок останавливает РОСТ истории, но НИКОГДА не отнимает
    // того, что уже сохранено. Если история уже длиннее потолка (потолок
    // понизили — намеренно или опечаткой), она перестаёт расти и живёт на
    // своей текущей длине: новое звено встаёт впереди, самое старое
    // вытесняется, длина не меняется. Если короче — растёт до потолка, как
    // и раньше.
    //
    // Так негодное значение ручки перестаёт быть НЕОБРАТИМЫМ: опечатку
    // видно (история не растёт), её можно исправить, и разом ничего не
    // теряется. Прежнее поведение срезало 29 звеньев до 2 за один
    // перезапуск, молча и навсегда.
    //
    // Честная оговорка, чтобы не обещать лишнего: «ничего не теряется» —
    // это про ЗАДНЕЕ ЧИСЛО, не вообще. Каждая следующая НАСТОЯЩАЯ смена
    // ключа по-прежнему вытесняет самое старое звено, как и положено
    // потолку. Разница в том, что теперь это одно звено за одно реальное
    // событие, а не двадцать семь разом за один перезапуск с опечаткой.
    history = [histEntry, ...history].slice(0, Math.max(MAX_KEY_HISTORY, history.length));
    keyChangeCount += 1;
  }

  // isRealChange гарантированно true в этой точке — ранний возврат выше
  // отсёк единственный случай, где это было бы не так.
  const updatedAt = nowMs;

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
    if (existing) _directory[address] = existing;
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
