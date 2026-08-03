import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { app } from '../app.js';
import { bagPassChallenge } from '../bagPass.js';
// Static import — namespace or named, never `const { X } = await import(...)`.
// DIR_BAGS is `export let` in bagStore.js (see that module's own header
// comment, and test/bagStore.test.js's, for why a dynamic-import
// destructure would silently freeze on a snapshot).
import { DIR_BAGS, bagMetaOf } from '../bagStore.js';

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
    // Тот же класс бага, что нашли в /push/subscribe (docs/OPEN-ITEMS.md п.27,
    // подпункт 3): Math.abs(nowSec - Number('never')) даёт NaN, а
    // `NaN > 300` — всегда false, так что голая проверка окна молча
    // пропускает всё подряд.
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
  });

  it('отсутствие x-ts или x-sig — 401', async () => {
    const { address } = await newWalletAndAddress();
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .send({ address });
    expect(res.status).toBe(401);
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

  it('не верит адресу отправителя, подсунутому в теле', async () => {
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const { address: mallory } = await newWalletAndAddress();
    const pass = await issuePassFor(alice, freshIp());

    // Тело — произвольные байты по контракту (сервер их не разбирает), но
    // если бы реализация ОШИБОЧНО парсила JSON и доверяла полю sender, вот
    // этот payload бы её поймал.
    const payload = Buffer.from(JSON.stringify({ sender: mallory, text: 'lies' }));
    const res = await putBag({ pass, recipient: bobAddr, body: payload });
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

    const recipientDir = path.join(DIR_BAGS, bobAddr);
    const leftovers = fs.existsSync(recipientDir) ? fs.readdirSync(recipientDir) : [];
    expect(leftovers).toHaveLength(0);
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
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /bags — список
// ─────────────────────────────────────────────────────────────────────────

describe('GET /bags', () => {
  it('отдаёт только мешки адреса из пропуска, форма — {key, sender, size, uploadedAt}', async () => {
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());
    const bobPass = await issuePassFor(bob, freshIp());

    const toBob = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('to-bob') });
    await putBag({ pass: bobPass, recipient: aliceAddr, body: Buffer.from('to-alice') });

    const res = await getBagsList({ pass: bobPass, ip: freshIp() });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual({
      key: toBob.body.key,
      sender: aliceAddr,
      size: 6,
      uploadedAt: expect.any(Number),
    });
  });

  it('требует годный пропуск', async () => {
    const res = await getBagsList({ pass: 'v1.garbage.garbage' });
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
    const cutoff = bagMetaOf(first.body.key).uploadedAt;
    await new Promise((r) => setTimeout(r, 5));
    const second = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('two') });

    const res = await getBagsList({ pass: bobPass, since: cutoff, ip: freshIp() });
    expect(res.status).toBe(200);
    expect(res.body.map((b) => b.key)).toEqual([second.body.key]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /bags/:key — скачивание
// ─────────────────────────────────────────────────────────────────────────

describe('GET /bags/:key', () => {
  it('пропуск на Алису не открывает мешок Боба', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());

    const put = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('secret-for-bob') });
    expect(put.status).toBe(200);

    // Алиса пытается прочитать мешок, адресованный Бобу, своим же пропуском.
    const res = await getBag({ pass: alicePass, key: put.body.key, ip: freshIp() });
    expect(res.status).toBe(404);
    expect(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : '').not.toContain('secret-for-bob');
  });

  it('чужой пропуск и несуществующий ключ отвечают ОДИНАКОВО', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice, freshIp());

    const put = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('x') });
    const realKey = put.body.key;
    const fakeKey = `${bobAddr}/1700000000000-00000000-0000-0000-0000-000000000000.bin`;

    const wrongOwner = await getBag({ pass: alicePass, key: realKey, ip: freshIp() });
    const notFound   = await getBag({ pass: alicePass, key: fakeKey, ip: freshIp() });

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

  it('лимитер срабатывает по адресу даже при разных IP', async () => {
    const { wallet: bob } = await newWalletAndAddress();
    // Выпуск пропуска сам расходует одну единицу общего бюджета адреса
    // (лимитер по адресу общий на все четыре маршрута — POST /bags/pass
    // тоже его проверяет). RATE_MAX=10, значит после выпуска пропуска
    // остаётся ровно 9 разрешённых запросов до 429, не 10.
    const pass = await issuePassFor(bob, freshIp());

    let last;
    for (let i = 0; i < 9; i++) {
      last = await getBagsList({ pass, ip: freshIp() });
      expect(last.status).toBe(200);
    }
    // 11-й учтённый запрос под этим адресом (1 — выпуск пропуска + 9 выше +
    // этот) — заблокирован, несмотря на то что IP каждый раз новый.
    last = await getBagsList({ pass, ip: freshIp() });
    expect(last.status).toBe(429);
  });
});
