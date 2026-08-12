import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { Writable } from 'node:stream';

// Требование 5 (ревью, не заперто прежде): recordBag/markFetched/listBagsFor/
// bagMetaOf/bagPathFor бросают по контракту bagStore.js — каждый вызов в
// app.js обёрнут в try/catch, но ни один тест ни разу не заставлял их
// РЕАЛЬНО бросить, так что мутация "снять try/catch" ничего не красила.
// vi.mock оборачивает настоящий модуль (тот же приём, что test/setup.js уже
// применяет к 'ethers'/'web-push') и позволяет включить бросок точечно,
// per-тест, через мутируемые флаги — реальная реализация используется во
// всех остальных случаях, включая тесты, читающие bagStoreNs.recordBag/
// markFetched напрямую (требование 3, требование 9 и т.д.) — флаги по
// умолчанию false, так что для них это прозрачно.
const bagStoreThrows = vi.hoisted(() => ({ recordBag: false, markFetched: false }));

vi.mock('../bagStore.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recordBag: (...args) => {
      if (bagStoreThrows.recordBag) throw new Error('simulated bagStore failure (test)');
      return actual.recordBag(...args);
    },
    markFetched: (...args) => {
      if (bagStoreThrows.markFetched) throw new Error('simulated bagStore failure (test)');
      return actual.markFetched(...args);
    },
  };
});

// И-4 (ревью): реальные бюджеты (BAG_PASS_RATE_MAX/BAG_READ_RATE_MAX/
// BAG_WRITE_RATE_MAX в app.js) выбраны под живой разговор, не под удобство
// тестов границы — десятки-под-сотню запросов в минуту. Гонять тест границы
// на такую величину дорого и медленно. Переопределяем их здесь, МАЛЕНЬКИМИ,
// до импорта app.js — тот же приём, что test/bagStore.test.js уже применяет
// к STORAGE_DIR. Обязательно ДИНАМИЧЕСКИЙ import(), не статический: app.js
// читает process.env.BAG_*_RATE_MAX на уровне модуля, а статический
// `import ... from '../app.js'` поднимается ВЫШЕ этих присваиваний (ESM
// вычисляет импорты раньше тела импортирующего модуля независимо от
// текстового порядка) — тот же урок, что host-комментарий у dotenv.config()
// в самом app.js.
process.env.BAG_PASS_RATE_MAX  = '5';
process.env.BAG_READ_RATE_MAX  = '5';
process.env.BAG_WRITE_RATE_MAX = '5';
// Свойство 1 (ревью, критическая): раньше все четыре маршрута шли через
// глобальный checkRateLimit(ip) — RATE_MAX=10, без второго аргумента — так
// что тесты IP-лимитера ниже (границы "10 успехов, 11-й — 429") проверяли
// именно его, случайно совпав числом. После критической правки маршруты
// используют собственный BAG_IP_RATE_MAX (боевое умолчание — 300, см.
// комментарий в app.js и test/bagRoutesLiveDefaults.test.js — тот файл
// нарочно НЕ трогает эту переменную, чтобы измерить настоящее боевое
// поведение). Здесь переопределяем её тем же числом (10), что тесты уже
// предполагали, — граница тестов не изменилась, изменился только источник.
process.env.BAG_IP_RATE_MAX    = '10';

const { app } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');
// Пространство имён, не деструктуризация — DIR_BAGS в bagStore.js это
// `export let`, деструктуризация РЕЗУЛЬТАТА динамического импорта копирует
// значение один раз и не отслеживает переприсваивания (см. заголовок
// test/bagStore.test.js). В этом файле STORAGE_DIR не переопределяется
// повторно, так что практического риска нет, но обращение через
// пространство имён снимает вопрос полностью, а не полагается на это.
const bagStoreNs = await import('../bagStore.js');
const { bagMetaOf } = bagStoreNs;

// ─── Test wiring ────────────────────────────────────────────────────────────
//
// Every request below carries its own CF-Connecting-IP (TRUST_PROXY=true in
// test/setup.js honours it) so unrelated tests never share the IP-keyed half
// of the rate limiter's bucket — same trick test/helpers.test.js already uses
// against checkRateLimit() directly. The two tests that deliberately exercise
// the limiter build their own sequence of IPs instead of calling freshIp().
let _ipCounter = 0;
function freshIp() {
  _ipCounter++;
  return `10.${(_ipCounter >> 16) & 255}.${(_ipCounter >> 8) & 255}.${_ipCounter & 255}`;
}

async function signBagPassChallenge(wallet, address, ts) {
  return wallet.signMessage(bagPassChallenge(address, ts));
}

/**
 * POST /bags/pass with full control over every input — tests that need to
 * corrupt one field (ts, address, sig) build the request by hand instead.
 */
async function postBagsPass({ wallet, address, ts, sig, ip } = {}) {
  const addr  = address ?? (await wallet.getAddress()).toLowerCase();
  const tsVal = ts ?? Math.floor(Date.now() / 1000);
  const sigVal = sig ?? await signBagPassChallenge(wallet, addr, tsVal);
  return request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-ts', String(tsVal))
    .set('x-sig', sigVal)
    .send({ address: addr });
}

/** Happy-path pass issuance; throws loudly if the precondition itself fails. */
async function issuePassFor(wallet, ip) {
  const res = await postBagsPass({ wallet, ip });
  if (res.status !== 200) {
    throw new Error(`issuePassFor precondition failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.pass;
}

function putBag({ pass, recipient, body, ip, contentType = 'application/octet-stream' }) {
  return request(app)
    .put(`/bags/${recipient}`)
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-bag-pass', pass)
    .set('Content-Type', contentType)
    .send(body);
}

/**
 * И-2 (ревью): реального дропа TCP-соединения посреди тела запроса
 * supertest не даёт — он всегда отправляет целиком в памяти. Открывает
 * настоящий сокет к временно поднятому `app.listen(0)`, объявляет в
 * Content-Length больше, чем реально пишет, и рвёт соединение — та же форма,
 * что измерил координатор ("заявлено 262134, послано 60000, сокет
 * разорван"). Используется только тестом на обрезок; весь остальной файл
 * идёт через supertest.
 */
async function abortedPut({ recipient, pass, declaredLength, actualBytes }) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    await new Promise((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        const headers = [
          `PUT /bags/${recipient} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Content-Type: application/octet-stream`,
          `x-bag-pass: ${pass}`,
          `cf-connecting-ip: ${freshIp()}`,
          `Content-Length: ${declaredLength}`,
          `Connection: close`,
          '', '',
        ].join('\r\n');
        socket.write(headers);
        socket.write(Buffer.alloc(actualBytes, 1));
        setTimeout(() => { socket.destroy(); resolve(); }, 100);
      });
      // ECONNRESET on our own end once the server also tears down its side
      // is expected here, not a test failure — resolve either way.
      socket.on('error', () => resolve());
    });
    // Give the server a beat to run its req 'error'/'aborted' handling
    // before the test inspects the filesystem.
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Находка ревью ("размер берётся из заявленного, а не из записанного"):
 * подмена fs.statSync(filePath).size на Number(req.headers['content-length'])
 * не красила ни один тест, потому что во ВСЕХ остальных тестах заявленная
 * длина совпадает с настоящей (supertest сам считает Content-Length от
 * Buffer-тела). Единственный способ по-настоящему различить "сервер мерит
 * реальные байты на диске" от "сервер верит заявленной длине" — запрос,
 * где заявленной длины нет ВООБЩЕ: chunked-кодирование без Content-Length.
 * Настоящему TCP-парсеру Node всё равно нельзя солгать меньшим
 * Content-Length и протащить больше байт (проверено отдельно — лишнее
 * просто не попадёт в текущий запрос), так что chunked — единственный
 * реалистичный способ добраться до этого различия, не полагаясь на
 * заявленное число вообще.
 */
async function chunkedPut({ recipient, pass, body }) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        const headers = [
          `PUT /bags/${recipient} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Content-Type: application/octet-stream`,
          `x-bag-pass: ${pass}`,
          `cf-connecting-ip: ${freshIp()}`,
          `Transfer-Encoding: chunked`,
          `Connection: close`,
          '', '',
        ].join('\r\n');
        socket.write(headers);
        socket.write(`${body.length.toString(16)}\r\n`);
        socket.write(body);
        socket.write('\r\n0\r\n\r\n');
      });
      let raw = Buffer.alloc(0);
      socket.on('data', (chunk) => { raw = Buffer.concat([raw, chunk]); });
      socket.on('end', () => {
        const text = raw.toString('utf8');
        const splitAt = text.indexOf('\r\n\r\n');
        const headerText = splitAt === -1 ? text : text.slice(0, splitAt);
        const bodyText = splitAt === -1 ? '' : text.slice(splitAt + 4);
        const statusMatch = headerText.match(/^HTTP\/1\.\d (\d+)/);
        let json = null;
        try { json = JSON.parse(bodyText); } catch { /* leave null */ }
        resolve({ status: statusMatch ? Number(statusMatch[1]) : null, body: json });
      });
      socket.on('error', reject);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Находка ревью (четвёртая ветка сироты): ws.on('error') в
 * streamWithSizeLimit — отказ самой ЗАПИСИ посреди приёма (буквально
 * "кончилось место на диске"), не оборванное соединение (то — req.on
 * ('error'), уже заперто И-2) и не превышение размера. Подделывает
 * fs.createWriteStream() для любого файла ВНУТРИ каталога адресата под
 * наблюдением (точное имя файла — Date.now()+uuid, генерируется внутри
 * маршрута, заранее неизвестно) — настоящая запись нескольких байт на диск
 * (чтобы было что искать как сироту), затем 'error' вместо 'finish', как
 * настоящий ENOSPC. Реальная реализация — для всех остальных путей.
 */
function spyFailingWriteStream(recipientDir, bytesBeforeFail = 4) {
  const realCreateWriteStream = fs.createWriteStream;
  return vi.spyOn(fs, 'createWriteStream').mockImplementation((p, ...rest) => {
    if (typeof p !== 'string' || !p.startsWith(recipientDir)) return realCreateWriteStream(p, ...rest);
    let written = 0;
    const chunks = [];
    const ws = new Writable({
      write(chunk, _enc, cb) {
        written += chunk.length;
        chunks.push(chunk);
        if (written >= bytesBeforeFail) {
          fs.mkdirSync(recipientDir, { recursive: true });
          fs.writeFileSync(p, Buffer.concat(chunks));
          cb(new Error('ENOSPC: no space left on device (simulated)'));
        } else {
          cb();
        }
      },
    });
    return ws;
  });
}

function getBagsList({ pass, since, ip }) {
  const req = request(app).get('/bags').set('CF-Connecting-IP', ip ?? freshIp());
  if (pass !== undefined) req.set('x-bag-pass', pass);
  if (since !== undefined) req.query({ since });
  return req;
}

function getBag({ pass, key, ip }) {
  const req = request(app).get(`/bags/${key}`).set('CF-Connecting-IP', ip ?? freshIp());
  if (pass !== undefined) req.set('x-bag-pass', pass);
  return req;
}

async function newWalletAndAddress() {
  const wallet = ethers.Wallet.createRandom();
  const address = (await wallet.getAddress()).toLowerCase();
  return { wallet, address };
}

// ─────────────────────────────────────────────────────────────────────────
// POST /bags/pass
// ─────────────────────────────────────────────────────────────────────────

describe('POST /bags/pass', () => {
  it('выдаёт пропуск владельцу подписи, адрес совпадает с заявленным', async () => {
    const { wallet } = await newWalletAndAddress();
    const res = await postBagsPass({ wallet });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pass');
    expect(res.body).toHaveProperty('expiresAt');
    // Пропуск действительно работает — не просто похож на токен.
    const listRes = await getBagsList({ pass: res.body.pass, ip: freshIp() });
    expect(listRes.status).toBe(200);
  });

  it('подпись старше пяти минут отвергается', async () => {
    const { wallet } = await newWalletAndAddress();
    const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 минут назад
    const res = await postBagsPass({ wallet, ts: staleTs });
    expect(res.status).toBe(401);
    // Не просто 401 — конкретно из-за окна, а не по какой-то другой причине
    // (например, случайно провалившейся сверки подписи).
    expect(res.body.code).toBe('ts_out_of_window');
  });

  it('нечисловой x-ts не проходит окно — регрессия на Number(NaN) > 300 === false', async () => {
    // Регрессия на класс «проверка окна перестаёт быть проверкой на входе,
    // который она не предусматривала, и делает это молча». Класс заведён
    // отдельным открытым пунктом (docs/OPEN-ITEMS.md, 27) — механизм там
    // намеренно не публикуется до починки, и здесь его пересказывать тоже не
    // надо: тест ниже меряет поведение, а не объясняет приём.
    //
    // Проверяем именно код ts_out_of_window, а не просто статус 401: у этого
    // маршрута есть НЕЗАВИСИМЫЙ второй слой защиты — bagPassChallenge() сама
    // бросает на NaN (Number.isSafeInteger, контракт Задачи 1), так что даже
    // без Number.isFinite здесь запрос всё равно получит 401 — просто с
    // кодом invalid_signature вместо ts_out_of_window. Проверка одного
    // статуса не различает "поймано на окне" от "поймано на сборке
    // сообщения" и не поймала бы регрессию в этой конкретной строке —
    // проверено мутацией (см. отчёт).
    const { wallet, address } = await newWalletAndAddress();
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signBagPassChallenge(wallet, address, ts);
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .set('x-ts', 'never')
      .set('x-sig', sig)
      .send({ address });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ts_out_of_window');
  });

  it('негодная форма адреса в теле — 400, а не 500 (bagPassChallenge иначе бросает)', async () => {
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .set('x-ts', String(Math.floor(Date.now() / 1000)))
      .set('x-sig', '0xdeadbeef')
      .send({ address: 'not-an-address' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/address/i);
  });

  it('находка ревью: адрес массивом ["0x…40hex"] — 400, не 500', async () => {
    // typeof address !== 'string' идёт ПЕРВЫМ (короткое замыкание ||) —
    // массив никогда не доходит до ETH_ADDR_RE.test()/toLowerCase(). Важно
    // именно потому, что RegExp.prototype.test() САМ приводит аргумент к
    // строке (спецификация ECMA), и String(['0x…40hex']) для ОДНОэлементного
    // массива даёт ту же строку без скобок и запятых — тест регэкспа прошёл
    // бы, а array.toLowerCase() ниже бросил бы (у массивов нет такого
    // метода), необработанно — Express ловит синхронный throw в теле
    // обработчика сам, но ответ — HTML-страница по умолчанию, 500, не наш
    // JSON 400. Проверено мутацией: снятие typeof-проверки воспроизводит
    // это ровно так (см. отчёт).
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .set('x-ts', String(Math.floor(Date.now() / 1000)))
      .set('x-sig', '0xdeadbeef')
      .send({ address: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/address/i);
  });

  it('отсутствие x-ts или x-sig — 401 с кодом missing_credentials', async () => {
    // Голого статуса недостаточно: убери саму проверку присутствия
    // заголовков целиком — запрос всё равно упадёт на 401, только уже из
    // проверки окна (Number(undefined) === NaN, !Number.isFinite(NaN) ===
    // true, код ts_out_of_window) — тот же статус, другая причина. Код
    // отличает одно от другого.
    const { address } = await newWalletAndAddress();
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .send({ address });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_credentials');
  });

  it('заявленный адрес не совпадает с восстановленным подписантом — 401, код отличается от pass_expired/invalid_signature', async () => {
    const { wallet, address: realAddress } = await newWalletAndAddress();
    const { address: claimedAddress } = await newWalletAndAddress(); // чужой адрес
    const ts = Math.floor(Date.now() / 1000);
    // Подписывает СВОЙ настоящий вызов, но в теле заявляет чужой адрес —
    // самая естественная форма этой атаки (нет способа подписать ЧУЖОЙ
    // адрес, не владея его ключом).
    const sig = await signBagPassChallenge(wallet, realAddress, ts);
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .set('x-ts', String(ts))
      .set('x-sig', sig)
      .send({ address: claimedAddress });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('address_mismatch');
    expect(res.body.code).not.toBe('pass_expired');
  });

  it('невалидная подпись (не тот формат) — код invalid_signature, отличный от address_mismatch', async () => {
    const { address } = await newWalletAndAddress();
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .set('x-ts', String(ts))
      .set('x-sig', '0xnotasignature')
      .send({ address });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_signature');
    expect(res.body.code).not.toBe('address_mismatch');
  });

  it('С1 (ревью, критическая): чужие мусорные попытки под ЗАЯВЛЕННЫМ адресом жертвы не трогают её реальный бюджет', async () => {
    // Было ровно наоборот: бюджет по адресу тратился ДО восстановления
    // подписи, ключом был заявленный (непроверенный) адрес — тело запроса.
    // Значит нападающий, ни разу не подписавшись как жертва, мог разрядить
    // её бюджет чужими 401-ответами и держать её отрезанной от собственного
    // чата постоянно, повторяя раз в минуту. Адреса публичны в цепи — цель
    // выбирается свободно, кошелёк жертвы не нужен вообще.
    const { wallet: victim, address: victimAddr } = await newWalletAndAddress();

    // Жертва уже держит настоящий пропуск — ровно сценарий из отчёта
    // ревью: атака не должна отобрать доступ у уже вошедшего человека.
    const victimPass = await issuePassFor(victim, freshIp());

    // Нападающий: 9-10 мусорных попыток с ОДНОГО IP, заявляя адрес жертвы,
    // подпись негодная. Каждая — законный 401 (заявленный адрес не
    // совпадает с реальным подписантом мусорной подписи), но ни одна не
    // должна списываться с бюджета САМОЙ ЖЕРТВЫ — она тут ни при чём, её
    // ключ ни разу не использовался.
    const attackerIp = freshIp();
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/bags/pass')
        .set('CF-Connecting-IP', attackerIp)
        .set('x-ts', String(Math.floor(Date.now() / 1000)))
        .set('x-sig', '0xnotasignature')
        .send({ address: victimAddr });
      expect(res.status).toBe(401);
    }

    // Теперь жертва — с другого IP, с уже имеющимся настоящим пропуском.
    // Атака не должна была ничего списать с её бюджета.
    const listRes = await getBagsList({ pass: victimPass, ip: freshIp() });
    expect(listRes.status).toBe(200);

    // И попытка выпустить НОВЫЙ пропуск настоящей подписью тоже обязана
    // пройти — атака не должна закрыть жертве и эту дверь.
    const newPassRes = await postBagsPass({ wallet: victim, ip: freshIp() });
    expect(newPassRes.status).toBe(200);
  });

  it('лимитер по адресу на POST /bags/pass тратится только ПРОВЕРЕННЫМ (восстановленным) адресом, не заявленным', async () => {
    // Прямая проверка чинимого правила: бюджет адреса ни разу не трогается
    // до успешного восстановления подписи. Пре-верификационная защита от
    // нагрузки — только по IP (тест ниже, «лимитер по IP» в этом же
    // describe), не по адресу.
    const { address } = await newWalletAndAddress();
    const ts = Math.floor(Date.now() / 1000);
    // Много мусорных попыток с ОДНОГО IP хватит, чтобы упереться в IP-лимит
    // (10/мин) раньше, чем в гипотетический адресный — так что каждая
    // отдельная попытка идёт со своим IP, чтобы именно адресный бюджет
    // остался единственной переменной под наблюдением.
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post('/bags/pass')
        .set('CF-Connecting-IP', freshIp())
        .set('x-ts', String(ts))
        .set('x-sig', '0xnotasignature')
        .send({ address });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_signature');
    }
  });

  it('находка ревью: проверенный адрес ДЕЙСТВИТЕЛЬНО тратит собственный бюджет выпуска пропуска', async () => {
    // Дополняет тест выше: тот доказывает, что НЕПРОВЕРЕННЫЕ попытки не
    // трогают бюджет, но не проверяет обратное — что бюджет вообще
    // расходуется при настоящих, успешных выпусках. Без этого теста мутация
    // "вообще не звать checkRateLimit(bagPassRateKey(...))" не поймана бы
    // ничем: 429 просто никогда не наступил бы, и ни один существующий тест
    // этого не заметил бы — предыдущая версия этого теста в файле
    // (переименованном "лимитер по адресу срабатывает ДО подписи") была
    // удалена по С1 и заменена только тестом на НЕ-срабатывание.
    // BAG_PASS_RATE_MAX (тестовое умолчание — 5): пять настоящих, успешных
    // выпусков подряд, шестой обязан упереться.
    const { wallet } = await newWalletAndAddress();
    const address = (await wallet.getAddress()).toLowerCase();

    for (let i = 0; i < 5; i++) {
      const res = await postBagsPass({ wallet, address, ip: freshIp() });
      expect(res.status).toBe(200);
    }
    const blocked = await postBagsPass({ wallet, address, ip: freshIp() });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited_pass');
  });

  it('лимитер по IP срабатывает на POST /bags/pass даже с разными заявленными адресами', async () => {
    const sameIp = freshIp();
    const ts = Math.floor(Date.now() / 1000);
    let last;
    for (let i = 0; i < 10; i++) {
      const { address } = await newWalletAndAddress();
      last = await request(app)
        .post('/bags/pass')
        .set('CF-Connecting-IP', sameIp)
        .set('x-ts', String(ts))
        .set('x-sig', '0xnotasignature')
        .send({ address });
      expect(last.status).toBe(401);
    }
    const { address: eleventh } = await newWalletAndAddress();
    last = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', sameIp)
      .set('x-ts', String(ts))
      .set('x-sig', '0xnotasignature')
      .send({ address: eleventh });
    expect(last.status).toBe(429);
    // Свойство 3 (ревью): не просто 429 — конкретно IP-бюджет, а не
    // случайно совпавший с ним по числу адресный/pass-бюджет.
    expect(last.body.code).toBe('rate_limited_ip');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /bags/:recipient
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /bags/:recipient', () => {
  it('принимает мешок, отправитель и адресат берутся из пропуска/URL, не из тела', async () => {
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    const payload = Buffer.from('sealed-bag-bytes');
    const res = await putBag({ pass, recipient: bobAddr, body: payload });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('key');

    const meta = bagMetaOf(res.body.key);
    expect(meta).toBeTruthy();
    expect(meta.sender).toBe(aliceAddr);
    expect(meta.recipient).toBe(bobAddr);
    expect(meta.size).toBe(payload.length);
  });

  it('находка ревью: чек-суммированный (EIP-55, смешанный регистр) адрес работает сквозным путём — приём и пропуск', async () => {
    // Ни один тест во всём наборе не посылал адрес в чек-суммированном
    // виде — фронт (Задача 6) будет слать именно такой (ethers/viem
    // возвращают адреса в форме EIP-55 по умолчанию). Обе нормализации
    // (в приёме — PUT :recipient, и в пропуске — POST /bags/pass address)
    // работают уже сегодня, но тихая регрессия в любой из них молча
    // потеряла бы сообщения, а не дала бы явную ошибку.
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob } = await newWalletAndAddress();
    const bobLower = (await bob.getAddress()).toLowerCase();
    const bobChecksummed = ethers.getAddress(bobLower); // EIP-55, смешанный регистр
    expect(bobChecksummed).not.toBe(bobLower); // предпосылка: реально смешанный регистр, не совпадение

    const alicePass = await issuePassFor(alice, freshIp());
    const put = await putBag({ pass: alicePass, recipient: bobChecksummed, body: Buffer.from('checksummed-recipient') });
    expect(put.status).toBe(200);
    expect(bagMetaOf(put.body.key).recipient).toBe(bobLower);

    // Пропуск Боба — тоже через чек-суммированный адрес в теле запроса.
    const ts = Math.floor(Date.now() / 1000);
    const sig = await bob.signMessage(bagPassChallenge(bobLower, ts));
    const passRes = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .set('x-ts', String(ts))
      .set('x-sig', sig)
      .send({ address: bobChecksummed });
    expect(passRes.status).toBe(200);
    const bobPass = passRes.body.pass;

    const listRes = await getBagsList({ pass: bobPass, ip: freshIp() });
    expect(listRes.status).toBe(200);
    expect(listRes.body.inbox.map((b) => b.key)).toContain(put.body.key);

    const getRes = await getBag({ pass: bobPass, key: put.body.key, ip: freshIp() });
    expect(getRes.status).toBe(200);
    expect(getRes.body.toString('utf8')).toBe('checksummed-recipient');
  });

  it('не верит адресу отправителя ни из какого канала запроса — тело, заголовок и query разом', async () => {
    // Находка ревью («слепота статуса»): прежняя версия этого теста красила
    // только буквальный разбор JSON-тела — подмена ЛЮБЫМ ДРУГИМ каналом
    // (заголовок, query-параметр) была невидима для набора. Отправитель
    // обязан быть ТОЛЬКО адресом из пропуска, независимо от того, сколько
    // разных полей одновременно пытаются его перебить.
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const { address: mallory } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    const payload = Buffer.from(JSON.stringify({ sender: mallory, text: 'lies' }));
    const res = await request(app)
      .put(`/bags/${bobAddr}`)
      .query({ sender: mallory })
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass)
      .set('x-sender', mallory)
      .set('sender', mallory)
      .set('Content-Type', 'application/octet-stream')
      .send(payload);
    expect(res.status).toBe(200);

    const meta = bagMetaOf(res.body.key);
    expect(meta.sender).toBe(aliceAddr);
    expect(meta.sender).not.toBe(mallory);
  });

  it('мешок больше MAX_BAG_SIZE отвергается, и обрезок не остаётся на диске', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    // MAX_BAG_SIZE по умолчанию — четверть мегабайта (262144 байт).
    const oversized = Buffer.alloc(300_000, 7);
    const res = await putBag({ pass, recipient: bobAddr, body: oversized });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);

    const recipientDir = path.join(bagStoreNs.DIR_BAGS, bobAddr);
    const leftovers = fs.existsSync(recipientDir) ? fs.readdirSync(recipientDir) : [];
    expect(leftovers).toHaveLength(0);
  });

  it('находка ревью: удаление обрезка синхронное, не гонка "выстрелил и забыл" с ответом', async () => {
    // Побочная находка этого раунда (не из отчёта ревью изначально —
    // вскрыта повторными прогонами набора): fs.unlink(path, () => {}) не
    // ждёт завершения удаления перед ответом, из-за чего тест "обрезок не
    // остаётся на диске" выше был флаки (красный на части прогонов).
    // Заменено на unlinkQuietSync() — fs.unlinkSync внутри. Проверка на
    // отсутствие файла сразу после ответа (без искусственной паузы) уже
    // была в тесте выше, но проверка через таймингово-зависимое чтение
    // каталога недостаточно надёжна как ЗАМОК сама по себе — координатор
    // откатил на асинхронное удаление и получил 6 зелёных прогонов подряд.
    // Проверка через трекинг вызова детерминирована независимо от скорости
    // диска/ОС.
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    const unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync');
    const unlinkAsyncSpy = vi.spyOn(fs, 'unlink');
    try {
      const oversized = Buffer.alloc(300_000, 7);
      const res = await putBag({ pass, recipient: bobAddr, body: oversized });
      expect(res.status).toBe(413);
      expect(unlinkSyncSpy).toHaveBeenCalled();
      expect(unlinkAsyncSpy).not.toHaveBeenCalled();
    } finally {
      unlinkSyncSpy.mockRestore();
      unlinkAsyncSpy.mockRestore();
    }
  });

  it('требует годный пропуск — негодный отвечает 401 с кодом', async () => {
    const { address: bobAddr } = await newWalletAndAddress();
    const res = await putBag({ pass: 'v1.garbage.garbage', recipient: bobAddr, body: Buffer.from('x') });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('pass_invalid');
  });

  it('отвергает адресата с некорректной формой', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());
    const res = await putBag({ pass, recipient: 'not-an-address', body: Buffer.from('x') });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recipient/i);
  });

  it('И-1 (ревью): Content-Type: application/json отвергается явно, а не съедается express.json() молча', async () => {
    // express.json({limit:'64kb'}) (app.js, до любого маршрута) разбирает
    // ЛЮБОЕ тело с этим Content-Type до того, как запрос доедет сюда — к
    // моменту, когда streamWithSizeLimit начал бы читать поток, оно уже
    // пусто. Раньше: 200 {key}, на диске 0 байт, отправитель уверен, что
    // доставил, получатель скачивает пустоту. Проверяем ОБА конца: сам ответ
    // и то, что запись в индекс вообще не попала (не молчаливый 400 после
    // того, как файл уже испорчен).
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    const res = await putBag({
      pass,
      recipient: bobAddr,
      contentType: 'application/json',
      body: JSON.stringify({ not: 'a real bag, but valid json' }),
    });
    expect(res.status).toBe(400);
    // Свойство 3 (ревью): находка координатора буквально про ЭТОТ тест —
    // после появления отдельной проверки на пустое тело (тоже 400) снятие
    // ИМЕННО проверки Content-Type больше не даёт 200: тело съедено
    // express.json() до нуля байт, и ВТОРАЯ, более поздняя проверка
    // (пустое тело) перехватывает тот же случай своим собственным 400.
    // Статус совпадает, причина — нет; текст ошибки обязан называть
    // Content-Type, а не молчаливо совпасть с сообщением про пустое тело.
    expect(res.body.error).toMatch(/content-type/i);
    expect(res.body).not.toHaveProperty('key');

    const recipientDir = path.join(bagStoreNs.DIR_BAGS, bobAddr);
    const leftovers = fs.existsSync(recipientDir) ? fs.readdirSync(recipientDir) : [];
    expect(leftovers).toHaveLength(0);
  });

  it('находка ревью: нормализация Content-Type — с параметром, в верхнем регистре, и НЕ срабатывает на +json-суффиксе', async () => {
    // Поведение УЖЕ верно реализовано (contentType.split(';')[0].trim()
    // .toLowerCase() === 'application/json') — просто ни разу не запирался
    // тестом. Три случая разом:
    //   1. 'application/json; charset=utf-8' — express.json() съедает и
    //      это, значит наша проверка тоже обязана отвергнуть;
    //   2. 'APPLICATION/JSON' — express.json() матчит без учёта регистра
    //      (сверено отдельно через сам матчер type-is), наша проверка
    //      обязана тоже;
    //   3. 'application/vnd.api+json' — суффикс +json НЕ матчится
    //      express.json() по умолчанию (сверено отдельно тем же способом:
    //      typeis.is('application/vnd.api+json', ['application/json']) ===
    //      false) — то есть тело такого запроса НЕ съедается заранее, и
    //      наша проверка обязана его ПРОПУСТИТЬ, а не отвергать вслепую
    //      всё, что содержит "json".
    const { wallet: alice } = await newWalletAndAddress();

    const withCharset = await newWalletAndAddress();
    const resCharset = await putBag({
      pass: await issuePassFor(alice, freshIp()),
      recipient: withCharset.address,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ x: 1 }),
    });
    expect(resCharset.status).toBe(400);
    expect(resCharset.body.error).toMatch(/content-type/i);

    const upperCase = await newWalletAndAddress();
    const resUpper = await putBag({
      pass: await issuePassFor(alice, freshIp()),
      recipient: upperCase.address,
      contentType: 'APPLICATION/JSON',
      body: JSON.stringify({ x: 1 }),
    });
    expect(resUpper.status).toBe(400);
    expect(resUpper.body.error).toMatch(/content-type/i);

    // Не сверяем точный размер здесь: supertest/superagent сам умеет
    // "помогать" с Content-Type, оканчивающимся на +json, — пере-
    // сериализует переданный Buffer в JSON-представление вида
    // {"type":"Buffer","data":[...]} ДО того, как байты вообще уходят на
    // сокет (проверено отдельно: реальная длина на проводе для этого теста
    // — 227 байт, не длина исходной строки). Это особенность самого
    // тестового клиента, не app.js — сервер честно принимает и хранит
    // ровно то, что реально пришло. Здесь важен только факт: непустое
    // тело с этим Content-Type не отвергается и не обнуляется express.json().
    const suffixJson = await newWalletAndAddress();
    const resSuffix = await putBag({
      pass: await issuePassFor(alice, freshIp()),
      recipient: suffixJson.address,
      contentType: 'application/vnd.api+json',
      body: Buffer.from('opaque-bytes-not-actually-json-but-suffix-content-type'),
    });
    expect(resSuffix.status).toBe(200);
    expect(bagMetaOf(resSuffix.body.key).size).toBeGreaterThan(0);
  });

  it('И-2 (ревью): оборванная посреди загрузка не оставляет обрезок на диске', async () => {
    // req.on('error', () => ws.destroy()) раньше только останавливал запись,
    // не удалял уже написанные байты — обрезок не попадал в метаиндекс
    // (recordBag() ни разу не вызывался), значит его подберёт только метла
    // сирот по mtime не раньше BAG_UNREAD_TTL_MS (30 дней по умолчанию), а
    // Задача 4 её ещё не подключила к расписанию вообще.
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    // Меньше MAX_BAG_SIZE (256 КиБ) — так что это не путь по превышению
    // размера (уже заперт отдельным тестом), а именно оборванное соединение.
    await abortedPut({ recipient: bobAddr, pass, declaredLength: 262134, actualBytes: 60000 });

    const recipientDir = path.join(bagStoreNs.DIR_BAGS, bobAddr);
    const leftovers = fs.existsSync(recipientDir) ? fs.readdirSync(recipientDir) : [];
    expect(leftovers).toHaveLength(0);
  });

  it('мелочь (ревью): пустое тело отвергается, а не принимается и не хранится', async () => {
    // Настоящий запечатанный мешок от chatCrypto — это как минимум IV +
    // тег аутентификации AES-256-GCM, никогда не ноль байт. Нулевой мешок —
    // не легитимное состояние ни при каком реальном клиенте, только шум,
    // который до сих пор молча принимался и хранился до истечения TTL.
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    const res = await putBag({ pass, recipient: bobAddr, body: Buffer.alloc(0) });
    expect(res.status).toBe(400);
    // Свойство 3 (ревью): отличает эту ветку от соседней (Content-Type:
    // application/json — тоже 400, тоже про пустое содержимое на диске).
    expect(res.body.error).toMatch(/empty/i);

    const recipientDir = path.join(bagStoreNs.DIR_BAGS, bobAddr);
    const leftovers = fs.existsSync(recipientDir) ? fs.readdirSync(recipientDir) : [];
    expect(leftovers).toHaveLength(0);
  });

  it('находка ревью (не заперто прежде): размер меряется по факту записанного на диск, не по заявленной длине', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    const body = Buffer.from('chunked-transfer-no-content-length-header-at-all');
    const res = await chunkedPut({ recipient: bobAddr, pass, body });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('key');

    const meta = bagMetaOf(res.body.key);
    expect(meta.size).toBe(body.length);
  });

  it('требование 9 (ревью, не заперто прежде): uploadedAt — только серверный Date.now(), ни один канал запроса не пробивает', async () => {
    // Координатор: "можно взять из заголовка или сдвинуть на 60 дней назад,
    // никто не заметит" — не было ни одного теста, различающего "сервер сам
    // проставил время" от "сервер поверил тому, что прислали". Пробуем
    // протащить чужой uploadedAt сразу двумя каналами (заголовок и query) —
    // оба обязаны быть проигнорированы одинаково молча.
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const before = Date.now();
    const res = await request(app)
      .put(`/bags/${bobAddr}`)
      .query({ uploadedAt: sixtyDaysAgo })
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass)
      .set('x-uploaded-at', String(sixtyDaysAgo))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    const after = Date.now();

    expect(res.status).toBe(200);
    const meta = bagMetaOf(res.body.key);
    expect(meta.uploadedAt).toBeGreaterThanOrEqual(before);
    expect(meta.uploadedAt).toBeLessThanOrEqual(after);
  });

  it('лимитер по адресу срабатывает на САМОМ PUT даже при разных IP', async () => {
    // Находка ревью: адресный лимитер прежде был заперт только на
    // POST /bags/pass и GET /bags — снять его именно с PUT было бы
    // невидимо. BAG_WRITE_RATE_MAX (тестовое умолчание — 5).
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    for (let i = 0; i < 5; i++) {
      const res = await putBag({ pass, recipient: bobAddr, ip: freshIp(), body: Buffer.from(`w${i}`) });
      expect(res.status).toBe(200);
    }
    const blocked = await putBag({ pass, recipient: bobAddr, ip: freshIp(), body: Buffer.from('w5') });
    expect(blocked.status).toBe(429);
    // Свойство 3 (ревью): конкретно бюджет записи, не совпавший числом
    // IP-бюджет (тестовое умолчание того и другого — не одно и то же
    // умолчание, но подстраховка не помешает).
    expect(blocked.body.code).toBe('rate_limited_write');
  });

  it('находка ревью: окно лимитера (60с) действительно истекает и снимает блокировку', async () => {
    // Ни один тест файла до сих пор не проверял, что 429 вообще
    // ЗАКАНЧИВАЕТСЯ — только что он наступает. checkRateLimit() (app.js)
    // читает Date.now() напрямую; vi.setSystemTime() двигает системное
    // время вперёд без настоящего ожидания 60 секунд.
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());
    const ip = freshIp();

    try {
      for (let i = 0; i < 5; i++) {
        const res = await putBag({ pass, recipient: bobAddr, ip, body: Buffer.from(`w${i}`) });
        expect(res.status).toBe(200);
      }
      const blocked = await putBag({ pass, recipient: bobAddr, ip, body: Buffer.from('w5') });
      expect(blocked.status).toBe(429);

      // RATE_WINDOW_MS в app.js — 60_000, не экспортирована (та же
      // конвенция, что test/helpers.test.js уже применяет к RATE_MAX:
      // читает число буквально, не импортирует константу). +1с запаса.
      vi.setSystemTime(Date.now() + 61_000);

      const afterWindow = await putBag({ pass, recipient: bobAddr, ip, body: Buffer.from('w6') });
      expect(afterWindow.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('лимитер по IP срабатывает на PUT даже с разными адресами и годным пропуском', async () => {
    const sameIp = freshIp();
    let last;
    for (let i = 0; i < 10; i++) {
      const { wallet } = await newWalletAndAddress();
      const { address: recipientAddr } = await newWalletAndAddress();
      const pass = await issuePassFor(wallet, freshIp());
      last = await putBag({ pass, recipient: recipientAddr, ip: sameIp, body: Buffer.from('x') });
      expect(last.status).toBe(200);
    }
    const { wallet: eleventh } = await newWalletAndAddress();
    const { address: recipient11Addr } = await newWalletAndAddress();
    const pass11 = await issuePassFor(eleventh, freshIp());
    last = await putBag({ pass: pass11, recipient: recipient11Addr, ip: sameIp, body: Buffer.from('x') });
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('rate_limited_ip');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /bags — список
// ─────────────────────────────────────────────────────────────────────────

describe('GET /bags', () => {
  it('отдаёт ОБЕ половины переписки владельца пропуска и ни одного чужого мешка', async () => {
    // Задача 1 (chat-client): ответ стал объектом {inbox, sent, peers} —
    // этот тест остаётся про inbox конкретно; sent и peers заперты отдельно,
    // test/bagSenderView.test.js.
    //
    // ⚠️ ПРАВИЛО ЗДЕСЬ ИЗМЕНИЛОСЬ НАМЕРЕННО (К-1, задача 7). Раньше тест
    // назывался «отдаёт только мешки адреса из пропуска» и запирал
    // `meta.recipient === address`. Под этим правилом человек не мог забрать
    // СВОИ ЖЕ отправленные сообщения никогда — ни после перезагрузки
    // вкладки, ни на новом устройстве, — хотя конверт запечатан вторым
    // слотом ровно ради собственного архива. Теперь inbox — это «всё, что
    // владелец пропуска вправе прочитать»: обе половины его переписки.
    //
    // Зубы теста при этом не выпали, а переставлены: он по-прежнему ловит
    // главное — ЧУЖОЙ мешок не появляется. Для этого в раскладке появился
    // третий кошелёк, которого раньше не было вовсе.
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const { wallet: carol, address: carolAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());
    const bobPass = await issuePassFor(bob, freshIp());
    const carolPass = await issuePassFor(carol, freshIp());

    const toBob = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('to-bob') });
    const fromBob = await putBag({ pass: bobPass, recipient: aliceAddr, body: Buffer.from('to-alice') });
    // Переписка двух посторонних — Боба в ней нет ни с какой стороны.
    const strangers = await putBag({ pass: carolPass, recipient: aliceAddr, body: Buffer.from('carol->alice') });

    const res = await getBagsList({ pass: bobPass, ip: freshIp() });
    expect(res.status).toBe(200);

    const keys = res.body.inbox.map(b => b.key).sort();
    expect(keys).toEqual([toBob.body.key, fromBob.body.key].sort());
    expect(keys).not.toContain(strangers.body.key);

    // Форма записи не менялась — и у принятого, и у своего отправленного.
    expect(res.body.inbox.find(b => b.key === toBob.body.key)).toEqual({
      key: toBob.body.key,
      sender: aliceAddr,
      size: 6,
      uploadedAt: expect.any(Number),
    });
    expect(res.body.inbox.find(b => b.key === fromBob.body.key)).toEqual({
      key: fromBob.body.key,
      sender: bobAddr,          // своё отправленное — отправитель это я сам
      size: 8,
      uploadedAt: expect.any(Number),
    });
    expect(carolAddr).toBeTruthy();
  });

  it('требует годный пропуск', async () => {
    const res = await getBagsList({ pass: 'v1.garbage.garbage' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('pass_invalid');
  });

  it('находка ревью: пропуск принимается только из заголовка x-bag-pass, не из строки запроса', async () => {
    // Vary: x-bag-pass (И-5) утверждает, что ответ зависит от значения
    // ИМЕННО этого заголовка — если бы пропуск ТАКЖЕ принимался через
    // query, это утверждение стало бы неполным (кэш, уважающий Vary, не
    // знал бы, что ответ зависит ещё и от query-параметра). Без заголовка,
    // только с валидным пропуском в строке запроса — тот же 401, что и
    // вообще без пропуска.
    const { wallet: alice } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    const res = await request(app)
      .get('/bags')
      .query({ 'x-bag-pass': pass, pass })
      .set('CF-Connecting-IP', freshIp());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('pass_invalid');
  });

  it('?since фильтрует по времени загрузки', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());
    const bobPass = await issuePassFor(bob, freshIp());

    const first = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('one') });
    await new Promise((r) => setTimeout(r, 5)); // гарантирует различный uploadedAt
    // +1, не сам uploadedAt первого мешка: since нестрогое (И-3, ревью) —
    // ?since=<uploadedAt первого> вернул бы ОБА (первый снова, второй
    // впервые), это отдельно проверено своим тестом. Здесь под наблюдением
    // именно фильтрация по времени как таковая — строго ПОСЛЕ первого.
    const cutoff = bagMetaOf(first.body.key).uploadedAt + 1;
    await new Promise((r) => setTimeout(r, 5));
    const second = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('two') });

    const res = await getBagsList({ pass: bobPass, since: cutoff, ip: freshIp() });
    expect(res.status).toBe(200);
    expect(res.body.inbox.map((b) => b.key)).toEqual([second.body.key]);
  });

  it('?since=abc (не число) — 400, а не молчаливый пустой список', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());
    const res = await getBagsList({ pass, since: 'abc', ip: freshIp() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since/i);
  });

  it('И-3 (ревью): ?since нестрогое — мешок из ТОЙ ЖЕ миллисекунды, что запомненный максимум, не теряется навсегда', async () => {
    // Измерено координатором на настоящей гонке: два мешка легли в одну и ту
    // же миллисекунду. Клиент, запомнивший эту миллисекунду максимумом (из
    // предыдущего опроса, увидевшего первый мешок), спрашивает ?since=<та же
    // миллисекунда> — со строгим `>` второй мешок исключается НАВСЕГДА: его
    // uploadedAt никогда не станет больше того since, который клиент уже
    // видел. Нестрогое `>=` возвращает оба — первый повторно, но клиент
    // отбрасывает уже виденное по ключу, это не потеря.
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const bobPass = await issuePassFor(bob, freshIp());

    const { bagKeyFor, recordBag } = bagStoreNs;
    const sameMs = Date.now();
    const key1 = bagKeyFor(bobAddr);
    const key2 = bagKeyFor(bobAddr);
    const dir = path.join(bagStoreNs.DIR_BAGS, bobAddr);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(bagStoreNs.DIR_BAGS, key1), Buffer.from('one'));
    fs.writeFileSync(path.join(bagStoreNs.DIR_BAGS, key2), Buffer.from('two'));
    recordBag({ sender: aliceAddr, recipient: bobAddr, key: key1, size: 3, uploadedAt: sameMs });
    recordBag({ sender: aliceAddr, recipient: bobAddr, key: key2, size: 3, uploadedAt: sameMs });

    const res = await getBagsList({ pass: bobPass, since: sameMs, ip: freshIp() });
    expect(res.status).toBe(200);
    expect(res.body.inbox.map((b) => b.key)).toEqual(expect.arrayContaining([key1, key2]));
  });

  it('лимитер по IP срабатывает даже с валидным пропуском и разными адресами', async () => {
    // Прежде ни один из четырёх маршрутов не имел теста, ловящего именно
    // IP-половину лимитера — во всех остальных тестах файла IP намеренно
    // меняется на каждый запрос (чтобы не мешать друг другу), так что
    // мутация "убрать checkRateLimit(ip)" нигде не даёт красного. Общий
    // RATE_MAX = 10 (app.js), делится вообще всеми четырьмя маршрутами по
    // одному IP — тестовые BAG_*_RATE_MAX (по адресу) сюда не относятся.
    // Разные кошельки на каждой итерации — чтобы адресный бюджет чтения
    // (тестовое умолчание 5) не сработал раньше IP-бюджета (10) по ДРУГОЙ
    // причине; пропуск выпускается с ОТДЕЛЬНОГО IP, чтобы не тратить
    // бюджет `sameIp` на сам выпуск — под наблюдением только GET /bags.
    const sameIp = freshIp();
    let last;
    for (let i = 0; i < 10; i++) {
      const { wallet } = await newWalletAndAddress();
      const pass = await issuePassFor(wallet, freshIp());
      last = await getBagsList({ pass, ip: sameIp });
      expect(last.status).toBe(200);
    }
    const { wallet: eleventh } = await newWalletAndAddress();
    const pass11 = await issuePassFor(eleventh, freshIp());
    last = await getBagsList({ pass: pass11, ip: sameIp });
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('rate_limited_ip');
  });

  it('И-4: чтение и запись — разные бюджеты, отправка не голодает своё же чтение', async () => {
    // Ровно сценарий из отчёта ревью: пропуск + BAG_WRITE_RATE_MAX отправок
    // (тестовое умолчание — 5, см. заголовок файла) — и собственное чтение
    // всё ещё проходит, потому что запись и чтение не делят один счётчик.
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    for (let i = 0; i < 5; i++) {
      const res = await putBag({ pass, recipient: bobAddr, body: Buffer.from(`msg-${i}`) });
      expect(res.status).toBe(200);
    }

    const readRes = await getBagsList({ pass, ip: freshIp() });
    expect(readRes.status).toBe(200);
  });

  it('лимитер по адресу срабатывает на САМОМ GET /bags (список) даже при разных IP', async () => {
    // Находка ревью: два незапертых места лимитера из восьми (адресный на
    // POST /bags/pass — заперт отдельным тестом выше; читательский на
    // GET /bags — этот тест). Прежний тест с адресом в имени этого describe
    // на самом деле бил в GET /bags/:key (скачивание) — bagReadRateKey
    // делит бюджет с GET /bags, но снять checkRateLimit ИМЕННО с этого
    // маршрута было бы невидимо: список читался бы сколько угодно, пока
    // скачивание за него расплачивалось бы своим собственным тестом.
    const { wallet: alice } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    // BAG_READ_RATE_MAX (тестовое умолчание — 5): пять успешных опросов
    // списка, шестой обязан упереться.
    for (let i = 0; i < 5; i++) {
      const res = await getBagsList({ pass, ip: freshIp() });
      expect(res.status).toBe(200);
    }
    const blocked = await getBagsList({ pass, ip: freshIp() });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited_read');
  });

  it('находка ревью: заголовок вида "bag-read:<адрес жертвы>" не коллизирует с её реальным адресным бюджетом', async () => {
    // Свойство: пространства имён счётчиков не пересекаются, даже если в
    // ключ IP-бюджета попадёт строка, выбранная не нами (при TRUST_PROXY=true
    // значение берётся из заголовка впереди стоящего прокси дословно). До
    // префикса `ip:` такое пересечение было возможно — сцена ниже
    // воспроизводит именно его и требует, чтобы бюджет жертвы остался цел.
    // Замер и разбор остатка — открытый пункт 28.1 docs/OPEN-ITEMS.md, там
    // подробности намеренно не публикуются до починки.
    const { wallet: victim } = await newWalletAndAddress();
    const victimAddr = (await victim.getAddress()).toLowerCase();
    const victimPass = await issuePassFor(victim, freshIp());

    const forgedIp = `bag-read:${victimAddr}`;
    // Пропуск не нужен вообще — проверка IP идёт ДО проверки пропуска на
    // каждом из четырёх маршрутов, так что и негодный пропуск сгодится:
    // если коллизия существует, она сработает ещё до того, как пропуск
    // вообще будет прочитан.
    for (let i = 0; i < 20; i++) {
      await request(app).get('/bags').set('CF-Connecting-IP', forgedIp).set('x-bag-pass', 'v1.garbage.garbage');
    }

    const res = await getBagsList({ pass: victimPass, ip: freshIp() });
    expect(res.status).toBe(200);
  });

  it('находка ревью: список читается только по адресу из пропуска — ?who= (или любой другой канал) не подменяет его', async () => {
    // Находка координатора: замок "адресат только из пропуска" был
    // расширен для PUT (тело/заголовок/query — тест выше в этом файле), но
    // для GET /bags никто такой альтернативный канал не подавал. Код и
    // сегодня верный (address = requireBagPass(...), больше ниоткуда), но
    // ничто не запирало это явно — мутация "взять адрес из ?who=" прошла
    // бы все 405 тестов.
    const { address: aliceAddr } = await newWalletAndAddress();
    const { wallet: mallory } = await newWalletAndAddress();
    const malloryPass = await issuePassFor(mallory, freshIp());

    // Мешок в ящик Алисы — malloryPass не имеет к нему отношения вообще.
    const { wallet: sender } = await newWalletAndAddress();
    const senderPass = await issuePassFor(sender, freshIp());
    await putBag({ pass: senderPass, recipient: aliceAddr, body: Buffer.from('alices-secret') });

    const res = await request(app)
      .get('/bags')
      .query({ who: aliceAddr })
      .set('CF-Connecting-IP', freshIp())
      .set('x-address', aliceAddr)
      .set('x-bag-pass', malloryPass);
    expect(res.status).toBe(200);
    // Пропуск Мэллори не открывает ничего в её собственном (пустом) ящике,
    // даже когда запрос всеми доступными каналами пытается заявить, что
    // на самом деле читает Алиса.
    expect(res.body.inbox).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /bags/:key — скачивание
// ─────────────────────────────────────────────────────────────────────────

describe('GET /bags/:key', () => {
  it('пропуск ПОСТОРОННЕГО не открывает чужой мешок (а отправителя — открывает, К-1)', async () => {
    // ⚠️ РАСКЛАДКА ИСПРАВЛЕНА (К-1, задача 7). Раньше здесь Алиса САМА
    // клала мешок Бобу и потом «пыталась прочитать чужое» — но она не
    // посторонняя, она автор этих байтов: запрет ей читать собственное
    // отправленное и был тем дефектом, из-за которого своя половина
    // переписки терялась при каждой перезагрузке. Тест в прежнем виде
    // запирал именно дефект.
    //
    // Настоящий посторонний — третий кошелёк, не участвующий в переписке.
    // Обе стороны проверяются в одном тесте: посторонний получает 404,
    // отправитель — свои байты. Замок, который запирает всех, — не замок.
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const { wallet: carol } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());
    const carolPass = await issuePassFor(carol, freshIp());

    const put = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('secret-for-bob') });
    expect(put.status).toBe(200);

    // Отправитель читает своё — это и есть починка К-1.
    const mine = await getBag({ pass: alicePass, key: put.body.key, ip: freshIp() });
    expect(mine.status).toBe(200);

    // Посторонний не читает ничего.
    const res = await getBag({ pass: carolPass, key: put.body.key, ip: freshIp() });
    expect(res.status).toBe(404);
    // Находка ревью («слепота статуса»): 404 отвечает JSON — res.body уже
    // разобранный объект, не Buffer, так что `Buffer.isBuffer(res.body) ? …
    // : ''` раньше ВСЕГДА давал '' и сравнение с самой собой всегда
    // проходило, что бы ни лежало в ответе. res.body напрямую (объект) +
    // res.text (сырой текст, если supertest почему-то не распарсил) —
    // реальная проверка вне зависимости от формы тела.
    expect(JSON.stringify(res.body)).not.toContain('secret-for-bob');
    expect(res.text ?? '').not.toContain('secret-for-bob');
  });

  it('чужой пропуск и несуществующий ключ отвечают ОДИНАКОВО', async () => {
    // «Чужой» — третий кошелёк (К-1, задача 7): Алиса, положившая мешок,
    // больше не чужая ему, она его автор. Свойство теста прежнее и важное —
    // «нет прав» и «нет такого ключа» обязаны быть неразличимы, иначе по
    // коду ответа перебирается чужой список мешков.
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const { wallet: carol } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());
    const carolPass = await issuePassFor(carol, freshIp());

    const put = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('x') });
    const realKey = put.body.key;
    const fakeKey = `${bobAddr}/1700000000000-00000000-0000-0000-0000-000000000000.bin`;

    const wrongOwner = await getBag({ pass: carolPass, key: realKey, ip: freshIp() });
    const notFound   = await getBag({ pass: carolPass, key: fakeKey, ip: freshIp() });

    expect(wrongOwner.status).toBe(notFound.status);
    expect(wrongOwner.status).toBe(404);
    expect(wrongOwner.body).toEqual(notFound.body);
  });

  it('негодный пропуск по-прежнему 401 с кодом, не 404', async () => {
    const { address: bobAddr } = await newWalletAndAddress();
    const fakeKey = `${bobAddr}/1700000000000-00000000-0000-0000-0000-000000000000.bin`;
    const res = await getBag({ pass: 'v1.garbage.garbage', key: fakeKey, ip: freshIp() });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('pass_invalid');
  });

  it('владелец получает байты и помечается первое прочтение', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob } = await newWalletAndAddress();
    const bobAddr = (await bob.getAddress()).toLowerCase();
    const alicePass = await issuePassFor(alice, freshIp());
    const bobPass = await issuePassFor(bob, freshIp());

    const payload = Buffer.from('real-sealed-content');
    const put = await putBag({ pass: alicePass, recipient: bobAddr, body: payload });
    const key = put.body.key;
    expect(bagMetaOf(key).firstFetchedAt).toBeNull();

    const res = await getBag({ pass: bobPass, key, ip: freshIp() });
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe('real-sealed-content');
    expect(bagMetaOf(key).firstFetchedAt).not.toBeNull();

    // Второе чтение не двигает отметку (поведение самого bagStore уже
    // заперто test/bagStore.test.js — здесь только убеждаемся, что маршрут
    // действительно проходит через markFetched, а не мимо).
    const firstMark = bagMetaOf(key).firstFetchedAt;
    await new Promise((r) => setTimeout(r, 5));
    const res2 = await getBag({ pass: bobPass, key, ip: freshIp() });
    expect(res2.status).toBe(200);
    expect(bagMetaOf(key).firstFetchedAt).toBe(firstMark);
  });

  it('И-5 (ревью): скачивание отвечает Cache-Control: private, no-store и Vary: x-bag-pass', async () => {
    // Право читать этот ответ живёт ЦЕЛИКОМ в заголовке пропуска — тело
    // ответа само по себе не несёт никакого доказательства авторизации.
    // Посредник, кэширующий по URL (а ключ — часть URL, значит стабильный
    // адрес кэширования), без Cache-Control: no-store вполне может отдать
    // сохранённый ответ следующему запросу к тому же URL БЕЗ пропуска —
    // Vary: x-bag-pass дополнительно говорит любому кэшу, уважающему
    // заголовки, что ответ зависит от значения именно этого заголовка, не
    // только от URL.
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());
    const bobPass = await issuePassFor(bob, freshIp());

    const put = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('cache-me-not') });
    // ALLOWED_ORIGINS (test/setup.js) включает этот Origin — запрос с ним
    // проходит через app.use(cors(...)) (app.js, выше по цепочке
    // middleware), которая сама ставит Vary: Origin. Без этого заголовка
    // в запросе CORS не добавляет ничего в Vary, и тест не отличил бы
    // res.append() от res.setHeader() — ровно так эта находка и осталась
    // незапертой раньше.
    const res = await request(app)
      .get(`/bags/${put.body.key}`)
      .set('CF-Connecting-IP', freshIp())
      .set('Origin', 'http://localhost:3000')
      .set('x-bag-pass', bobPass);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    // Находка ревью (короткий список): CORS уже ставит Vary: Origin —
    // res.setHeader('Vary', 'x-bag-pass') ЗАМЕНЯЛ бы это значение целиком,
    // стирая Origin. res.append() добавляет к нему через запятую.
    // "Содержит", а не "равен ровно этой строке" — иначе тест сам стал бы
    // преградой для более полной формулировки заголовка в будущем.
    const varyValues = String(res.headers['vary'] || '').split(',').map((v) => v.trim().toLowerCase());
    expect(varyValues).toContain('x-bag-pass');
    expect(varyValues).toContain('origin');
  });

  it('мешки не отдаются статикой — прямой запрос без пропуска не получает байты', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());

    const payload = Buffer.from('should-never-leak-unauthenticated');
    const put = await putBag({ pass: alicePass, recipient: bobAddr, body: payload });
    expect(put.status).toBe(200);

    // Тот же самый URL, каким его отдал сервер, но без x-bag-pass вообще —
    // если бы мешки лежали под express.static, этот запрос вернул бы 200
    // и сырые байты независимо от заголовков.
    const res = await request(app).get(`/bags/${put.body.key}`).set('CF-Connecting-IP', freshIp());
    expect(res.status).toBe(401);
    const bodyText = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : JSON.stringify(res.body);
    expect(bodyText).not.toContain('should-never-leak-unauthenticated');
  });

  it('требование 7 (ревью, не заперто прежде): обход каталога через :filename не читает файл за пределами склада', async () => {
    // Координатор: "ручной path.join проходит все 22 теста" — не было ни
    // одного теста, реально пытающегося сбежать из DIR_BAGS через URL.
    // %2f — закодированный слэш: Express 4 не расщепляет по нему сегмент,
    // так что req.params.filename может содержать буквальный '/' после
    // декодирования, который сам маршрут никогда не порождает сам.
    const { wallet: bob } = await newWalletAndAddress();
    const bobAddr = (await bob.getAddress()).toLowerCase();
    const bobPass = await issuePassFor(bob, freshIp());

    const traversal = '..%2f..%2f..%2f..%2fpackage.json';
    const res = await request(app)
      .get(`/bags/${bobAddr}/${traversal}`)
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', bobPass);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Bag not found', code: 'bag_not_found' });
    const bodyText = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : JSON.stringify(res.body);
    expect(bodyText).not.toMatch(/"name"\s*:\s*"hexseal-relayer"/); // содержимое package.json, если бы утекло
  });

  it('лимитер по адресу срабатывает на САМОМ GET /bags/:key даже при разных IP', async () => {
    // Находка ревью: прежний тест с этим названием жил в этом describe, но
    // звал getBagsList() — то есть GET /bags (список), а не этот маршрут.
    // Снять адресный лимитер именно с GET /bags/:key было бы невидимо. Этот
    // тест реально скачивает — bagReadRateKey шарит бюджет с GET /bags, но
    // здесь под наблюдением именно скачивание как таковое: если бы у ЭТОГО
    // маршрута не было своего checkRateLimit(bagReadRateKey(...)), запрос
    // всё равно прошёл бы, читай сколько угодно.
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const bobPass = await issuePassFor(bob, freshIp());

    // BAG_READ_RATE_MAX (тестовое умолчание — 5) мешков + один сверху,
    // каждый от СВОЕГО отправителя — иначе один отправитель, зовущий PUT
    // шесть раз подряд, упёрся бы в свой же (тоже тестовый = 5) бюджет
    // ЗАПИСИ раньше, чем Боб успеет упереться в бюджет ЧТЕНИЯ, и шестой PUT
    // молча вернул бы 429 без поля key — ровно так тест и падал до правки.
    const keys = [];
    for (let i = 0; i < 6; i++) {
      const { wallet: sender } = await newWalletAndAddress();
      const senderPass = await issuePassFor(sender, freshIp());
      const put = await putBag({ pass: senderPass, recipient: bobAddr, ip: freshIp(), body: Buffer.from(`k${i}`) });
      expect(put.status).toBe(200);
      keys.push(put.body.key);
    }
    for (const key of keys.slice(0, 5)) {
      const res = await getBag({ pass: bobPass, key, ip: freshIp() });
      expect(res.status).toBe(200);
    }
    const blocked = await getBag({ pass: bobPass, key: keys[5], ip: freshIp() });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited_read');
  });

  it('лимитер по IP срабатывает на GET /bags/:key даже с разными адресами и годным пропуском', async () => {
    const sameIp = freshIp();
    let last;
    for (let i = 0; i < 10; i++) {
      const { wallet: sender } = await newWalletAndAddress();
      const { wallet: recipientWallet, address: recipientAddr } = await newWalletAndAddress();
      const senderPass = await issuePassFor(sender, freshIp());
      const recipientPass = await issuePassFor(recipientWallet, freshIp());
      const put = await putBag({ pass: senderPass, recipient: recipientAddr, body: Buffer.from('x') });
      last = await getBag({ pass: recipientPass, key: put.body.key, ip: sameIp });
      expect(last.status).toBe(200);
    }
    const { wallet: sender11 } = await newWalletAndAddress();
    const { wallet: recipient11, address: recipient11Addr } = await newWalletAndAddress();
    const senderPass11 = await issuePassFor(sender11, freshIp());
    const recipientPass11 = await issuePassFor(recipient11, freshIp());
    const put11 = await putBag({ pass: senderPass11, recipient: recipient11Addr, body: Buffer.from('x') });
    last = await getBag({ pass: recipientPass11, key: put11.body.key, ip: sameIp });
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('rate_limited_ip');
  });

  it('протухший (но структурно годный) пропуск — 401 с кодом pass_expired, отдельным от pass_invalid', async () => {
    // Правило 3 брифа называет ОБА случая («негодный или протухший пропуск
    // — 401 с кодом»), но до сих пор тестировался только структурно мусорный
    // токен ('v1.garbage.garbage', код pass_invalid). Настоящий протухший —
    // валидный по форме и MAC-у, просто nowSec >= expiresAt — отдельная
    // ветка verifyBagPass(), непроверенная на уровне маршрута.
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const longAgo = Math.floor(Date.now() / 1000) - 13 * 60 * 60; // BAG_PASS_TTL_SEC = 12ч
    const { issueBagPass } = await import('../bagPass.js');
    const { token } = issueBagPass(aliceAddr, longAgo);
    void alice;

    const fakeKey = `${aliceAddr}/1700000000000-00000000-0000-0000-0000-000000000000.bin`;
    const res = await getBag({ pass: token, key: fakeKey, ip: freshIp() });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('pass_expired');
    expect(res.body.code).not.toBe('pass_invalid');
  });

  it('запись в индексе есть, а файла на диске нет — 404, не 500', async () => {
    // Снятие проверки fs.existsSync(filePath) не поймано было ничем: без
    // неё маршрут дошёл бы до markFetched()/чтения потока и упал бы на
    // отсутствующем файле как 500, а не ответил честным "нет такого".
    // Строим ИМЕННО этот рассинхрон напрямую через recordBag() — обычный
    // путь (PUT) всегда пишет файл, так рассинхрон получить нельзя.
    const { address: aliceAddr } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const bobPass = await issuePassFor(bob, freshIp());

    const { bagKeyFor, recordBag } = bagStoreNs;
    const key = bagKeyFor(bobAddr);
    recordBag({ sender: aliceAddr, recipient: bobAddr, key, size: 3, uploadedAt: Date.now() });
    // Файл на диске сознательно не создаётся — только запись в индексе.

    const res = await getBag({ pass: bobPass, key, ip: freshIp() });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Bag not found', code: 'bag_not_found' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Требование 5 (ревью): бросающие вызовы склада пойманы, не валят процесс
// ─────────────────────────────────────────────────────────────────────────

describe('устойчивость к сбоям склада', () => {
  it('recordBag() бросает — PUT отвечает 500 с JSON-телом, не роняет процесс и не виснет, обрезок удалён', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    bagStoreThrows.recordBag = true;
    try {
      const res = await putBag({ pass, recipient: bobAddr, body: Buffer.from('x') });
      expect(res.status).toBe(500);
      // Не просто статус — JSON-тело с полем error отличает НАШ try/catch
      // (res.status(500).json({error: ...})) от того, что дал бы дефолтный
      // обработчик ошибок Express (HTML-страница, res.body — пустой объект,
      // не распарсенный JSON).
      expect(res.body).toHaveProperty('error');

      // Находка ревью («тот же класс сироты, ради которого делалась И-2»):
      // байты уже написаны на диск (streamWithSizeLimit успел завершиться)
      // до того, как recordBag() бросил — если бы файл не удалялся на этой
      // ветке отказа, он остался бы сиротой без записи в индексе.
      const recipientDir = path.join(bagStoreNs.DIR_BAGS, bobAddr);
      const leftovers = fs.existsSync(recipientDir) ? fs.readdirSync(recipientDir) : [];
      expect(leftovers).toHaveLength(0);
    } finally {
      bagStoreThrows.recordBag = false;
    }
  });

  it('находка ревью: не удалось измерить размер после записи — обрезок тоже удаляется, не только записи-в-индекс', async () => {
    // Тот же класс сироты, что и recordBag()-ветка выше, но на строку раньше
    // — fs.statSync(filePath) после успешной записи может отказать
    // (например, файл удалили гонкой сразу после дозаписи) даже когда
    // recordBag() сам никогда не был вызван. vi.spyOn с проверкой ПУТИ —
    // настоящая реализация используется для абсолютно всех остальных
    // вызовов statSync в процессе (fs используется по всему app.js), сбоит
    // только вызов с ИМЕННО этим путём.
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    const realStatSync = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation((p, ...rest) => {
      const recipientDir = path.join(bagStoreNs.DIR_BAGS, bobAddr);
      if (typeof p === 'string' && p.startsWith(recipientDir)) {
        throw new Error('simulated stat failure (test)');
      }
      return realStatSync(p, ...rest);
    });
    try {
      const res = await putBag({ pass, recipient: bobAddr, body: Buffer.from('x') });
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');

      const recipientDir = path.join(bagStoreNs.DIR_BAGS, bobAddr);
      const leftovers = fs.existsSync(recipientDir) ? fs.readdirSync(recipientDir) : [];
      expect(leftovers).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('находка ревью: четвёртая ветка сироты — отказ самой записи посреди приёма (ws.on(\'error\'), не только req.on(\'error\'))', async () => {
    // И-2 запирала обрыв СОЕДИНЕНИЯ (req.on('error')) и превышение размера
    // (received > maxBytes) — но не отказ самой ЗАПИСИ (ws.on('error'),
    // буквально "кончилось место на диске"). Раньше эта ветка не выставляла
    // aborted и не удаляла файл вообще — обрезок оставался сиротой, тем же
    // классом, ради которого делалась И-2, просто по другой причине.
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());
    const recipientDir = path.join(bagStoreNs.DIR_BAGS, bobAddr);

    const spy = spyFailingWriteStream(recipientDir, 4);
    try {
      const res = await putBag({ pass, recipient: bobAddr, body: Buffer.from('this-body-is-longer-than-four-bytes') });
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');

      const leftovers = fs.existsSync(recipientDir) ? fs.readdirSync(recipientDir) : [];
      expect(leftovers).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('markFetched() бросает — не роняет процесс; байты уже ушли, поэтому отметка теряется молча, а не 500', async () => {
    // Мелочь (ревью): markFetched() теперь зовётся на res 'finish' — ПОСЛЕ
    // того, как байты реально ушли клиенту (правка на брошенное скачивание,
    // см. соседний тест ниже), так что бросок здесь больше не может
    // превратиться в 500 — отвечать нечем, ответ уже отправлен. Раньше этот
    // же тест ожидал 500 (отметка ставилась до потока) — поведение
    // изменилось осознанно, не регрессия.
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());
    const bobPass = await issuePassFor(bob, freshIp());
    const put = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('real-bytes') });
    const key = put.body.key;

    bagStoreThrows.markFetched = true;
    try {
      const res = await getBag({ pass: bobPass, key, ip: freshIp() });
      expect(res.status).toBe(200);
      expect(res.body.toString('utf8')).toBe('real-bytes');
      // Бросок реален (не проглочен раньше срока) — отметка не встала.
      expect(bagMetaOf(key).firstFetchedAt).toBeNull();
    } finally {
      bagStoreThrows.markFetched = false;
    }
  });

  it('свойство 2 (ревью): бросок markFetched() внутри res.on(\'finish\') не улетает как uncaughtException', async () => {
    // Находка ревью: тест выше проверяет ответ и bagMetaOf — оба этих
    // пространства ОДИНАКОВЫ независимо от того, поймано ли исключение
    // внутри колбэка res.on('finish') или нет (throw происходит уже ПОСЛЕ
    // того, как supertest получил свой ответ). Значит тест выше в принципе
    // не может отличить "поймано и залогировано" от "утекло наружу" — а
    // именно второе в бою означает падение всего процесса: обработчика
    // process.on('uncaughtException') нет нигде в релеере (index.js/app.js/
    // notifier.js — проверено отдельно, docs/scripts/verify-disk-failure-*).
    // Этот тест слушает событие НАПРЯМУЮ и проверяет факт: исключение не
    // должно долетать до уровня процесса вообще, поймано оно должно быть
    // ВНУТРИ маршрута.
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());
    const bobPass = await issuePassFor(bob, freshIp());
    const put = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('real-bytes-2') });
    const key = put.body.key;

    const uncaught = [];
    const onUncaughtException = (err) => uncaught.push(err);
    process.on('uncaughtException', onUncaughtException);

    bagStoreThrows.markFetched = true;
    try {
      const res = await getBag({ pass: bobPass, key, ip: freshIp() });
      expect(res.status).toBe(200);
      // res.on('finish') на клиентской и серверной стороне — разные
      // колбэки; ждём явно, чтобы серверный успел (не) бросить прежде,
      // чем мы проверим uncaught.
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toHaveLength(0);
    } finally {
      bagStoreThrows.markFetched = false;
      process.removeListener('uncaughtException', onUncaughtException);
    }
  });

  it('мелочь (ревью): HEAD не помечает мешок прочитанным', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());
    const bobPass = await issuePassFor(bob, freshIp());
    const put = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('x') });
    const key = put.body.key;

    const res = await request(app)
      .head(`/bags/${key}`)
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', bobPass);
    expect(res.status).toBe(200);
    expect(bagMetaOf(key).firstFetchedAt).toBeNull();
  });

  // Мелочь (ревью), намеренно БЕЗ теста на "брошенное посреди скачивание не
  // помечает прочитанным": попытка построить его через настоящий сокет
  // (тем же приёмом, что и И-2 выше, только в обратную сторону — не читать
  // ответ и порвать соединение) оказалась ненадёжной не из-за слабости
  // теста, а по факту устройства ОС/Node. Проверено отдельным скриптом на
  // голом http+net (не vitest): для ответа размером с потолок мешка
  // (256 КБ) событие 'finish' на сервере срабатывает практически мгновенно
  // — ядро принимает весь ответ в свой буфер сокета за один системный
  // вызов ДО того, как клиент вообще получает шанс что-либо прочитать, не
  // говоря уже про socket.destroy() на любой разумной задержке. Тот же
  // результат при socket.pause() (клиент никогда не вычитывает данные) —
  // буфер ядра на loopback для такого объёма всё равно не переполняется
  // достаточно, чтобы упереться в backpressure. Это следствие того, что
  // мешок — сообщение, а не вложение (MAX_BAG_SIZE — четверть мегабайта),
  // не изъян в правке ниже: markFetched() всё равно перенесён на res
  // 'finish' (что для НАСТОЯЩЕГО оборванного соединения по-прежнему верно
  // — 'finish' в принципе не то же самое, что "клиент получил байты", но
  // для payload'ов такого размера различить эти два случая тестом,
  // управляющим одним лишь TCP-сокетом без глубокого вмешательства в
  // рантайм, средствами, доступными снаружи процесса, практически
  // невозможно). HEAD-тест выше и markFetched-throws-тест — реальные,
  // детерминированные замки того же семейства правок; этот случай
  // сознательно оставлен незапертым, а не имитирован ложно-зелёным тестом.
});
