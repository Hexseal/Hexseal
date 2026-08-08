/**
 * bagPassChatKey.test.js — пропуск склада БЕЗ окна кошелька, и цена этого.
 *
 * Живая выкатка 8 августа (пункт 35 `docs/OPEN-ITEMS.md`). Подписей две, и одна
 * лишняя:
 *   - первая выводит ключ переписки — необходима, из неё восстановление истории;
 *   - вторая берёт пропуск к складу, то есть доказывает серверу, что адрес твой.
 *
 * Вторую можно не спрашивать у кошелька: как только адрес объявил `signKey` в
 * справочнике, сервер знает связку «адрес → ключ подписи», и пропуск можно
 * подписать САМИМ ключом переписки, молча. В установленном приложении каждое
 * окно кошелька — круг на минуты, и человек уходит.
 *
 * ⚠️ ПРОПУСК — ЕДИНСТВЕННОЕ НАСТОЯЩЕЕ МЕСТО ЗАЩИТЫ В СИСТЕМЕ (спека
 * `docs/superpowers/specs/2026-08-02-e2e-chat-design.md` §4: «защита стоит на
 * выдаче мешков, а не на подписи»). Поэтому здесь не один замок, а два ряда:
 *
 *  РЯД 1 — что стало можно (одна подпись в жизни адреса, дальше ноль).
 *  РЯД 2 — что по-прежнему НЕЛЬЗЯ, и это главное:
 *     - подписать чужим ключом — отказ;
 *     - выдать пропуск, когда ключа в справочнике НЕТ, — отказ (иначе
 *       кто угодно занял бы чужой адрес в справочнике: `POST /keys` берёт адрес
 *       из пропуска, и пропуск, выдаваемый без доказательства, открыл бы
 *       подмену открытого ключа любому человеку в цепи);
 *     - СМЕНИТЬ ключ в справочнике пропуском, добытым ключом, — отказ. Это и
 *       есть замкнутый круг, если его не запретить: украденный на 12 часов
 *       пропуск позволил бы записать СВОЙ `signKey` и выдавать себе пропуска
 *       вечно. Корень доверия обязан остаться в кошельке.
 *     - взять чужой мешок — отказ, как и раньше.
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
const { bagPassChallenge, verifyBagPass } = await import('../bagPass.js');
const directory = await import('../directory.js');

let _ip = 0;
function freshIp() {
  _ip++;
  return `10.${(_ip >> 16) & 255}.${(_ip >> 8) & 255}.${_ip & 255}`;
}

function hexOf(buf) {
  return '0x' + Buffer.from(buf).toString('hex');
}

/** Пара ключа переписки в том же виде, в каком её делает `deriveLinkSigningKeypair`
 *  на клиенте: Ed25519, открытая половина — ровно 32 байта. */
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

/** Пропуск ПО ПОДПИСИ КОШЕЛЬКА — то, как это работает сегодня. */
async function walletPass(wallet, ip) {
  const addr = (await wallet.getAddress()).toLowerCase();
  const ts = Math.floor(Date.now() / 1000);
  const sig = await wallet.signMessage(bagPassChallenge(addr, ts));
  const res = await request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-ts', String(ts))
    .set('x-sig', sig)
    .send({ address: addr });
  return res;
}

/** Пропуск ПО КЛЮЧУ ПЕРЕПИСКИ — ноль окон кошелька. */
function keyPass({ address, signer, ts, sig, ip }) {
  const tsVal = ts ?? Math.floor(Date.now() / 1000);
  const req = request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-ts', String(tsVal));
  return req
    .set('x-key-sig', sig ?? signer.sign(bagPassChallenge(address, tsVal)))
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

/** Первый вход в жизни адреса: подпись кошелька + публикация ключей. */
async function firstVisit() {
  const res = await walletPass(wallet);
  expect(res.status).toBe(200);
  const published = await postKeys({ pass: res.body.pass, boxKey, signKey: signer.publicKeyHex });
  expect(published.status).toBe(200);
  return res.body.pass;
}

/* ─────────── РЯД 1: одна подпись в жизни адреса, дальше ноль ─────────── */

describe('пропуск по ключу переписки: окон кошелька ноль', () => {
  it('ЗАМЕР: ключ объявлен — пропуск выдаётся без подписи кошелька', async () => {
    // Что красит: сервер снова требует `x-sig`. Тогда каждые 12 часов человек
    // получает окно кошелька при ОТКРЫТИИ чата, без единого своего действия, и
    // в установленном приложении это круг на минуты.
    await firstVisit();

    const res = await keyPass({ address: addr, signer });
    expect(res.status).toBe(200);
    expect(typeof res.body.pass).toBe('string');

    // Пропуск настоящий и на тот самый адрес.
    const verdict = verifyBagPass(res.body.pass);
    expect(verdict.address).toBe(addr);
  });

  it('пропуск по ключу помечен своим сортом — «ключевой», не «кошельковый»', async () => {
    await firstVisit();
    const byKey = await keyPass({ address: addr, signer });
    const byWallet = await walletPass(wallet);
    expect(verifyBagPass(byKey.body.pass).grade).toBe('key');
    expect(verifyBagPass(byWallet.body.pass).grade).toBe('wallet');
  });

  it('им можно читать и писать мешки — иначе он ничего не стоит', async () => {
    await firstVisit();
    const pass = (await keyPass({ address: addr, signer })).body.pass;

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
});

/* ─────────── РЯД 2: чего по-прежнему нельзя ─────────── */

describe('защита выдачи мешков не ослабла', () => {
  it('чужой ключ переписки за этот адрес не подписывает', async () => {
    // Что красит: сервер перестал сверять открытый ключ со справочником и
    // просто верит любой Ed25519-подписи. Тогда пропуск на любой адрес
    // выдаётся любому — адреса в цепи публичны.
    await firstVisit();
    const stranger = chatSigner();
    const res = await keyPass({ address: addr, signer: stranger });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_signature');
  });

  it('ключа в справочнике нет — пропуск по ключу не выдаётся вовсе', async () => {
    // Корень доверия. `POST /keys` берёт адрес ИЗ ПРОПУСКА, значит пропуск,
    // выданный без доказательства владения адресом, дал бы кому угодно занять
    // чужую строку в справочнике и подменить открытый ключ шифрования — то
    // есть читать всё, что этому человеку напишут.
    const res = await keyPass({ address: addr, signer });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('key_not_enrolled');
  });

  it('мусор вместо подписи — вердикт, а не падение', async () => {
    await firstVisit();
    // ASCII-only: заголовок с не-ASCII байтами HTTP-клиент отвергает сам, и
    // замок мерил бы свою же подделку, а не сервер.
    for (const bad of ['0x', 'not-a-signature', '0x' + 'ff'.repeat(63), '0x' + 'ff'.repeat(65), '0xzz' + 'f'.repeat(126)]) {
      const res = await keyPass({ address: addr, signer, sig: bad });
      expect(res.status).toBe(401);
      expect(typeof res.body.code).toBe('string');
    }
  });

  it('просроченная отметка времени не проходит — окно то же, что у кошелька', async () => {
    await firstVisit();
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const res = await keyPass({ address: addr, signer, ts: stale });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ts_out_of_window');
  });

  it('чужой мешок по-прежнему не выдаётся — пропуск по ключу тут ничего не меняет', async () => {
    // Требование «докажи замером, что чужой мешок по-прежнему не выдаётся».
    await firstVisit();
    const mine = (await keyPass({ address: addr, signer })).body.pass;

    // Второй человек, всё по-честному: свой кошелёк, свой ключ.
    const other = ethers.Wallet.createRandom();
    const otherAddr = (await other.getAddress()).toLowerCase();
    const otherSigner = chatSigner();
    const otherWalletPass = (await walletPass(other)).body.pass;
    await postKeys({ pass: otherWalletPass, boxKey: randomBoxKeyHex(), signKey: otherSigner.publicKeyHex });
    const otherPass = (await keyPass({ address: otherAddr, signer: otherSigner })).body.pass;

    // Ему в ящик кладут мешок.
    const put = await request(app).put(`/bags/${otherAddr}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', otherPass)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('чужое'));
    expect(put.status).toBe(200);

    // Мой пропуск его не открывает — и отвечает так же, как на несуществующий.
    const stolen = await request(app).get(`/bags/${put.body.key}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', mine);
    expect(stolen.status).toBe(404);
    expect(stolen.body.code).toBe('bag_not_found');
  });
});

describe('замкнутый круг закрыт: ключ меняется только кошельком', () => {
  it('пропуск по ключу НЕ может подменить ключ в справочнике', async () => {
    // ⚠️ ГЛАВНЫЙ ЗАМОК ЭТОЙ ЗАДАЧИ. Без него украденный на 12 часов пропуск
    // превращался бы в вечный доступ: записал свой `signKey` — выдаёшь себе
    // пропуска сам, кошелёк жертвы больше не нужен НИКОГДА.
    await firstVisit();
    const pass = (await keyPass({ address: addr, signer })).body.pass;

    const intruder = chatSigner();
    const res = await postKeys({ pass, boxKey: randomBoxKeyHex(), signKey: intruder.publicKeyHex });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('wallet_pass_required');

    // И справочник не сдвинулся.
    const record = directory.getKeyRecord(addr);
    expect(record.signKey).toBe(signer.publicKeyHex);
    expect(record.boxKey).toBe(boxKey);
  });

  it('повтор БАЙТ-В-БАЙТ пропуском по ключу проходит — иначе круг не разомкнуть', async () => {
    // Клиент зовёт `POST /keys` на каждом открытии сеанса (устройство, где ключ
    // уже лежал, обязано убедиться, что справочник о нём знает). Если запретить
    // это ключевому пропуску целиком, каждый заход требовал бы кошелька — то
    // есть правка отменила бы саму себя.
    await firstVisit();
    const pass = (await keyPass({ address: addr, signer })).body.pass;
    const res = await postKeys({ pass, boxKey, signKey: signer.publicKeyHex });
    expect(res.status).toBe(200);
  });

  it('кошельком ключ меняется по-прежнему — потерял устройство, завёл новый', async () => {
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

  it('старый пропуск без сорта считается кошельковым — уже выданные не ломаются', async () => {
    // Совместимость: пропуска́ на 12 часов лежат у людей в браузере прямо
    // сейчас. Токен старой формы (тело из двух полей) обязан по-прежнему
    // работать, и обязан считаться кошельковым — иначе выкатка отняла бы у
    // живых людей право сменить ключ до истечения их пропуска.
    const { issueBagPass } = await import('../bagPass.js');
    const legacy = issueBagPass(addr);
    expect(verifyBagPass(legacy.token).grade).toBe('wallet');
  });
});
