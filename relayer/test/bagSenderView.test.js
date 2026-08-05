import { describe, it, expect, afterEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

// Задача 1 плана «Клиент чата» (docs/superpowers/plans/2026-08-06-chat-
// client.md): GET /bags теперь отдаёт {inbox, sent, peers} вместо голого
// массива. Решение координатора при сверке плана — тот же самый опрос, что
// и раньше (раз в 5с), несёт теперь и то, что нужно отправителю про его
// исходящие ("забрали ли"), и список собеседников с их последним появлением
// — вместо отдельного запроса на каждое.
//
// bagStore.js/bagPass.js и сами маршруты /bags/* этой задачей не трогаются
// — они закончены (588 тестов, 6 раундов правок до этой). Единственная
// новая логика — сборка sent/peers ИЗ уже существующих данных прямо внутри
// GET /bags (app.js) поверх новой bagStore.listBagsBySender() (зеркало
// listBagsFor(), заперта отдельно в test/bagStore.test.js). Этот файл
// запирает форму и правила ИМЕННО этого ответа — не механику приёма/выдачи/
// лимитеров, которую уже запирает test/bagRoutes.test.js.
const { app } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');
const bagStoreNs = await import('../bagStore.js');
const { bagKeyFor, DIR_BAGS, _loadBagMeta, bagMetaOf } = bagStoreNs;

let _ipCounter = 0;
function freshIp() {
  _ipCounter++;
  return `10.${(_ipCounter >> 16) & 255}.${(_ipCounter >> 8) & 255}.${_ipCounter & 255}`;
}

async function signBagPassChallenge(wallet, address, ts) {
  return wallet.signMessage(bagPassChallenge(address, ts));
}

async function newWalletAndAddress() {
  const wallet = ethers.Wallet.createRandom();
  const address = (await wallet.getAddress()).toLowerCase();
  return { wallet, address };
}

async function issuePassFor(wallet, ip = freshIp()) {
  const address = (await wallet.getAddress()).toLowerCase();
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signBagPassChallenge(wallet, address, ts);
  const res = await request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', ip)
    .set('x-ts', String(ts))
    .set('x-sig', sig)
    .send({ address });
  if (res.status !== 200) {
    throw new Error(`issuePassFor precondition failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.pass;
}

function putBag({ pass, recipient, body, ip = freshIp() }) {
  return request(app)
    .put(`/bags/${recipient}`)
    .set('CF-Connecting-IP', ip)
    .set('x-bag-pass', pass)
    .set('Content-Type', 'application/octet-stream')
    .send(body);
}

function getBags({ pass, since, ip = freshIp() }) {
  const req = request(app).get('/bags').set('CF-Connecting-IP', ip);
  if (pass !== undefined) req.set('x-bag-pass', pass);
  if (since !== undefined) req.query({ since });
  return req;
}

function getBag({ pass, key, ip = freshIp() }) {
  return request(app).get(`/bags/${key}`).set('CF-Connecting-IP', ip).set('x-bag-pass', pass);
}

describe('GET /bags — sent/peers (Задача 1, взгляд отправителя на собственные мешки)', () => {
  it('sent содержит только свои отправленные, с булевым fetched', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);

    const put1 = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('hello') });
    expect(put1.status).toBe(200);

    const res = await getBags({ pass: alicePass });
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([
      { key: put1.body.key, recipient: bobAddr, uploadedAt: expect.any(Number), fetched: false },
    ]);
  });

  it('sent НЕ содержит чужих мешков даже при совпадающем получателе', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob } = await newWalletAndAddress();
    const { address: carolAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);
    const bobPass = await issuePassFor(bob);

    // Оба шлют ОДНОЙ И ТОЙ ЖЕ Кэрол — единственное, что вправе отличать
    // ответы двух отправителей, это САМ отправитель, не получатель.
    const aliceToCarol = await putBag({ pass: alicePass, recipient: carolAddr, body: Buffer.from('from-alice') });
    const bobToCarol = await putBag({ pass: bobPass, recipient: carolAddr, body: Buffer.from('from-bob') });
    expect(aliceToCarol.status).toBe(200);
    expect(bobToCarol.status).toBe(200);

    const aliceView = await getBags({ pass: alicePass });
    expect(aliceView.body.sent).toHaveLength(1);
    expect(aliceView.body.sent[0].key).toBe(aliceToCarol.body.key);
    expect(aliceView.body.sent.map((b) => b.key)).not.toContain(bobToCarol.body.key);
  });

  it('fetched становится true после скачивания получателем, и это булево, не отметка времени', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);
    const bobPass = await issuePassFor(bob);

    const put1 = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('hi') });

    const before = await getBags({ pass: alicePass });
    expect(before.body.sent[0].fetched).toBe(false);

    const download = await getBag({ pass: bobPass, key: put1.body.key });
    expect(download.status).toBe(200);

    const after = await getBags({ pass: alicePass });
    expect(after.body.sent[0].fetched).toBe(true);
    expect(typeof after.body.sent[0].fetched).toBe('boolean');
    // Ни точного времени забора, ни его следа под другим именем — оно
    // принадлежит собеседнику, отправителю нужно только "да/нет".
    expect(after.body.sent[0]).not.toHaveProperty('fetchedAt');
    expect(after.body.sent[0]).not.toHaveProperty('firstFetchedAt');
    expect(Object.keys(after.body.sent[0]).sort()).toEqual(['fetched', 'key', 'recipient', 'uploadedAt']);
  });

  it('peers содержит только тех, с кем есть переписка (в любую сторону)', async () => {
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);
    const bobPass = await issuePassFor(bob);

    // Алиса пишет Бобу — переписка есть, даже если Боб ей ни разу не ответил.
    await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('hi') });

    const aliceView = await getBags({ pass: alicePass });
    expect(aliceView.body.peers.map((p) => p.address)).toEqual([bobAddr]);

    const bobView = await getBags({ pass: bobPass });
    expect(bobView.body.peers.map((p) => p.address)).toEqual([aliceAddr]);
  });

  it('peers НЕ содержит адрес, с которым переписки не было — публичный адрес сам по себе слежку не открывает', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { address: strangerAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);
    void strangerAddr; // существует на цепи, но никогда не писал и не получал от Алисы

    const res = await getBags({ pass: alicePass });
    expect(res.body.peers).toEqual([]);
  });

  it('lastSeenAt округлён до минуты', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);
    const bobPass = await issuePassFor(bob);

    const put1 = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('hi') });
    const download = await getBag({ pass: bobPass, key: put1.body.key });
    expect(download.status).toBe(200);

    const aliceView = await getBags({ pass: alicePass });
    const bobPeer = aliceView.body.peers.find((p) => p.address === bobAddr);
    expect(bobPeer).toBeDefined();
    expect(bobPeer.lastSeenAt).not.toBeNull();
    expect(bobPeer.lastSeenAt % 60000).toBe(0);

    // Не "случайно кратно минуте" — обязано быть НЕ ПОЗЖЕ настоящего момента
    // скачивания и не дальше минуты в прошлое от него (округление ВНИЗ, не
    // "к ближайшей" — не рисуем присутствие раньше, чем оно случилось).
    const realFetchedAt = bagMetaOf(put1.body.key).firstFetchedAt;
    expect(bobPeer.lastSeenAt).toBeLessThanOrEqual(realFetchedAt);
    expect(realFetchedAt - bobPeer.lastSeenAt).toBeLessThan(60000);
  });

  it('ни одно поле не требует чтения содержимого мешка', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);
    const bobPass = await issuePassFor(bob);

    // Не настоящий запечатанный мешок (IV + тег AES-256-GCM), а один
    // случайный байт — если бы sent/peers/inbox хоть что-то в нём читали
    // или парсили, маршрут упал бы или выдал мусор вместо честных метаданных.
    const put1 = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from([0x2a]) });
    expect(put1.status).toBe(200);
    const download = await getBag({ pass: bobPass, key: put1.body.key });
    expect(download.status).toBe(200);

    const res = await getBags({ pass: alicePass });
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([
      { key: put1.body.key, recipient: bobAddr, uploadedAt: expect.any(Number), fetched: true },
    ]);
    expect(res.body.peers.map((p) => p.address)).toEqual([bobAddr]);
  });
});

// ─── Режим недоверия склада — на уровне маршрута ──────────────────────────
//
// Подводный камень координатора (найден при ревью замысла, ДО реализации):
// у мешка, реконструированного bagStore.js из одного только имени файла
// (описи нет, склад не пуст), отправитель неизвестен в принципе — имя файла
// несёт только получателя и время. Юнит-тест на listBagsBySender() уже
// запирает это на уровне склада (test/bagStore.test.js) — здесь то же самое
// проверяется на уровне ЭТОГО маршрута, где peers/sent реально собираются.
//
// Единственный describe-блок файла, входящий в режим недоверия — намеренно
// изолирован своим afterEach: реконструкция стирает sender у ВСЕХ уже
// существующих в памяти записей этого файла (не только у новой), так что
// доверие обязано быть восстановлено после каждого теста здесь, а не только
// в конце файла — иначе порядок тестов внутри файла стал бы значимым.
describe('GET /bags в режиме недоверия склада — предсказуемо пусто, не мусор и не падение', () => {
  const bagMetaPath = path.join(path.dirname(DIR_BAGS), 'bag-meta.json');

  afterEach(() => {
    fs.writeFileSync(bagMetaPath, '{}', 'utf8');
    _loadBagMeta(); // честная загрузка — возвращает доверие для следующего теста
  });

  it('реконструированный мешок не даёт ни ложного sent, ни ложного peer — маршрут отвечает 200, не 500', async () => {
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);

    const key = bagKeyFor(aliceAddr);
    fs.mkdirSync(path.dirname(path.join(DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(DIR_BAGS, key), 'sealed');
    fs.rmSync(bagMetaPath, { force: true });
    _loadBagMeta(); // индекса нет, склад не пуст → режим недоверия, реконструкция

    const res = await getBags({ pass: alicePass });
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([]);
    expect(res.body.peers).toEqual([]);
    // inbox — другое свойство (получатель виден из имени файла, это уже
    // существующее поведение плана 2, не предмет этой задачи) — здесь только
    // подтверждаем, что маршрут остаётся честным 200 целиком, а не падает.
    expect(Array.isArray(res.body.inbox)).toBe(true);
  });
});
