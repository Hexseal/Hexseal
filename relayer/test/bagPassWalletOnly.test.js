/**
 * bagPassWalletOnly.test.js — пропуск склада выдаётся ТОЛЬКО по подписи кошелька.
 *
 * ─── ЭТО ПЕРЕВЁРНУТЫЙ ЗАМОК, А НЕ НОВЫЙ ─────────────────────────────────────
 *
 * 8 августа 2026 здесь стоял противоположный файл: он запирал вторую дорогу —
 * выдачу пропуска по подписи КЛЮЧОМ ПЕРЕПИСКИ (`x-key-sig`), чтобы окон кошелька
 * стало ноль. Дорога была построена, замерена и работала:
 *
 *   ключ объявлен в справочнике → пропуск без подписи кошелька   200
 *   тем же пропуском читать/писать мешки                         200/200/200
 *   чужим ключом за этот адрес                                   401
 *   ключа в справочнике нет                                      401 key_not_enrolled
 *   подменить ключ ключевым пропуском                             401 wallet_pass_required
 *
 * **Откачено решением владельца.** Не потому, что довод был неверен, а потому,
 * что это развилка архитектуры, а не мелочь, и решать её сейчас он не готов.
 * Дословно: «хочется и ux хороший, и не хочется дыры, тем более подобной, где раз
 * прорвался и всё читаешь».
 *
 * Разбор размена — в шапке `POST /bags/pass` в `app.js`. Там же доказательство,
 * почему одна подпись на первом заходе невозможна в принципе, — читать ПРЕЖДЕ,
 * чем идти этой дорогой снова.
 *
 * ─── ЗАЧЕМ ФАЙЛ ОСТАВЛЕН, А НЕ УДАЛЁН ───────────────────────────────────────
 *
 * Прямое указание координатора: «Замки на откаченное не выбрасывай, а переверни:
 * пусть тесты сторожат, что подпись пропуска идёт кошельком. Иначе следующий,
 * кто захочет удобства, снимет это молча — а мы весь план ловили ровно такие
 * снятия.»
 *
 * То есть здесь заперто ДВА свойства, и второе — новое:
 *   1. кошельковая дорога работает и защищает (было и раньше);
 *   2. НИКАКОЙ ДРУГОЙ дороги к пропуску нет. Появится — этот файл покраснеет.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import crypto from 'node:crypto';

process.env.BAG_PASS_RATE_MAX = '50';
process.env.BAG_READ_RATE_MAX = '50';
process.env.BAG_WRITE_RATE_MAX = '50';
process.env.BAG_IP_RATE_MAX = '300';
process.env.KEYS_WRITE_RATE_MAX = '50';
process.env.KEYS_IP_RATE_MAX = '300';

const { app } = await import('../app.js');
const { bagPassChallenge, verifyBagPass, issueBagPass } = await import('../bagPass.js');
const directory = await import('../directory.js');

let _ip = 0;
function freshIp() {
  _ip++;
  return `10.${(_ip >> 16) & 255}.${(_ip >> 8) & 255}.${_ip & 255}`;
}

function hexOf(buf) {
  return '0x' + Buffer.from(buf).toString('hex');
}

/** Пара ключа переписки в том же виде, в каком её делает клиент: Ed25519,
 *  открытая половина — ровно 32 байта. Нужна здесь ровно затем, чтобы доказать,
 *  что ею пропуск НЕ выдаётся. */
function chatSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return {
    publicKeyHex: hexOf(raw),
    sign: (message) => hexOf(crypto.sign(null, Buffer.from(message, 'utf8'), privateKey)),
  };
}

function randomBoxKeyHex() {
  return hexOf(crypto.randomBytes(32));
}

async function walletPass(wallet, ip) {
  const addr = (await wallet.getAddress()).toLowerCase();
  const ts = Math.floor(Date.now() / 1000);
  const sig = await wallet.signMessage(bagPassChallenge(addr, ts));
  return request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-ts', String(ts))
    .set('x-sig', sig)
    .send({ address: addr });
}

/** Попытка получить пропуск БЕЗ кошелька — подписью ключа переписки. */
function keyOnlyPass({ address, signer, ts, ip }) {
  const tsVal = ts ?? Math.floor(Date.now() / 1000);
  return request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-ts', String(tsVal))
    .set('x-key-sig', signer.sign(bagPassChallenge(address, tsVal)))
    .send({ address });
}

function postKeys({ pass, boxKey, signKey, ip }) {
  return request(app)
    .post('/keys')
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-bag-pass', pass)
    .send({ boxKey, ...(signKey ? { signKey } : {}) });
}

let wallet;
let addr;
let signer;
let boxKey;

beforeEach(async () => {
  wallet = ethers.Wallet.createRandom();
  addr = (await wallet.getAddress()).toLowerCase();
  signer = chatSigner();
  boxKey = randomBoxKeyHex();
});

/** Первый вход: подпись кошелька за пропуском, затем публикация ключей. */
async function firstVisit() {
  const res = await walletPass(wallet);
  expect(res.status).toBe(200);
  const published = await postKeys({ pass: res.body.pass, boxKey, signKey: signer.publicKeyHex });
  expect(published.status).toBe(200);
  return res.body.pass;
}

/* ───── 1. Другой дороги к пропуску НЕТ, и это главный замок файла ───── */

describe('к пропуску ведёт РОВНО ОДНА дорога — подпись кошелька', () => {
  it('ЗАМЕР: подпись ключом переписки не выдаёт пропуск, даже когда ключ объявлен', async () => {
    // Что красит: возврат второй дороги (`x-key-sig`). Замер прямой — код
    // ответа: 401 `missing_credentials` означает «сервер не знает такой
    // дороги», а не «подпись не сошлась».
    await firstVisit();

    const res = await keyOnlyPass({ address: addr, signer });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_credentials');
    expect(res.body.pass).toBeUndefined();
  });

  it('заголовок ключевой подписи не помогает и вместе с негодным кошельковым', async () => {
    // Отдельный случай: «дорога вернулась чёрным ходом» — сервер, который
    // сначала пробует ключ, а на кошелёк смотрит потом.
    await firstVisit();
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .set('x-ts', String(ts))
      .set('x-sig', '0xdeadbeef')
      .set('x-key-sig', signer.sign(bagPassChallenge(addr, ts)))
      .send({ address: addr });
    expect(res.status).toBe(401);
    expect(res.body.pass).toBeUndefined();
  });

  it('в пропуске НЕТ сорта: у сорта с одним возможным значением нет смысла', async () => {
    // Замок на полноту откатa. Сорт ('wallet'/'key') существовал ровно затем,
    // чтобы `POST /keys` мог отличить пропуск, добытый ключом, от добытого
    // кошельком. Дорог снова одна — значит сорт всегда один, а поле, у которого
    // одно значение, не различает ничего и только выглядит защитой. Ровно тот
    // класс, который в этом проекте называют «замок, что ничего не сторожит».
    const res = await walletPass(wallet);
    expect(res.status).toBe(200);
    expect(verifyBagPass(res.body.pass)).toEqual({ address: addr });
  });
});

/* ───── 2. Кошельковая дорога работает и защищает — как и до правки ───── */

describe('кошельковая дорога цела', () => {
  it('подпись кошелька выдаёт пропуск на тот самый адрес', async () => {
    const res = await walletPass(wallet);
    expect(res.status).toBe(200);
    expect(verifyBagPass(res.body.pass).address).toBe(addr);
  });

  it('им можно читать и писать мешки', async () => {
    const pass = await firstVisit();

    const listed = await request(app).get('/bags')
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', pass);
    expect(listed.status).toBe(200);

    const put = await request(app).put(`/bags/${addr}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', pass)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('мешок'));
    expect(put.status).toBe(200);

    const got = await request(app).get(`/bags/${put.body.key}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', pass);
    expect(got.status).toBe(200);
  });

  it('чужой мешок не выдаётся', async () => {
    const mine = await firstVisit();

    const other = ethers.Wallet.createRandom();
    const otherAddr = (await other.getAddress()).toLowerCase();
    const otherPass = (await walletPass(other)).body.pass;
    const put = await request(app).put(`/bags/${otherAddr}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', otherPass)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('чужое'));
    expect(put.status).toBe(200);

    const stolen = await request(app).get(`/bags/${put.body.key}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', mine);
    expect(stolen.status).toBe(404);
    expect(stolen.body.code).toBe('bag_not_found');
  });

  it('просроченная отметка времени не проходит', async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const sig = await wallet.signMessage(bagPassChallenge(addr, stale));
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .set('x-ts', String(stale))
      .set('x-sig', sig)
      .send({ address: addr });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ts_out_of_window');
  });

  it('ключ в справочнике меняется — потерял устройство, завёл новый', async () => {
    await firstVisit();
    const fresh = chatSigner();
    const freshBox = randomBoxKeyHex();
    const pass = (await walletPass(wallet)).body.pass;
    const res = await postKeys({ pass, boxKey: freshBox, signKey: fresh.publicKeyHex });
    expect(res.status).toBe(200);

    const record = directory.getKeyRecord(addr);
    expect(record.signKey).toBe(fresh.publicKeyHex);
    expect(record.keyChangeCount).toBe(1);
    // Прежний ключ сохранён в истории — иначе переписка, запечатанная на него,
    // стала бы нечитаемой молча (правило 3 Задачи 2).
    expect(record.history[0].signKey).toBe(signer.publicKeyHex);
  });

  it('пропуск, выпущенный напрямую, проверяется — золотая форма не тронута', async () => {
    // Форма токена — ровно та, что была до 8 августа: тело из двух полей.
    const { token } = issueBagPass(addr);
    expect(token.split('.')).toHaveLength(3);
    const body = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
    expect(body.split('.')).toHaveLength(2);
  });
});
