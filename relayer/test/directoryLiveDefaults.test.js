// ─── Справочник ключей — боевые умолчания, не тестовые переопределения ────
//
// Ревью координатора (round 2): "числа работают, но следующая правка
// сломает их бесшумно" — test/directory.test.js намеренно занижает
// MAX_KEY_HISTORY/KEYS_WRITE_RATE_MAX/KEYS_IP_RATE_MAX до 4/5/10 (дешёвые
// границы), а ни один тест не смотрел на настоящее число. Замена
// боевого умолчания истории 20→миллион или лимитера→миллион проходила
// весь набор целиком. Тот же приём, что test/bagRoutesLiveDefaults.test.js
// уже применяет к BAG_*_RATE_MAX: этот файл НИЧЕГО не переопределяет —
// читает ровно то, что прочитал бы боевой процесс без единой строки в
// .env про MAX_KEY_HISTORY/KEYS_WRITE_RATE_MAX/KEYS_IP_RATE_MAX.
//
// Числа брифа/ревью, зашитые здесь буквально (не читаются из модуля —
// иначе "умолчание тихо поменяли" и "тест это заметил" стали бы одним и
// тем же событием, а не независимой проверкой):
//   MAX_KEY_HISTORY   = 200 (round 2: 20 позволяло 21 сменой ключа за
//                            минуты вытолкнуть любой конкретный старый)
//   KEYS_WRITE_RATE_MAX = 20 (app.js)
//   KEYS_IP_RATE_MAX    = 120 (app.js)

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';

const { app } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');
const directory = await import('../directory.js');

const LIVE_IP = '203.0.113.77';

let _ipCounter = 0;
function freshIp() {
  _ipCounter++;
  return `203.0.114.${_ipCounter & 255}`;
}

async function issuePassFor(wallet, ip = freshIp()) {
  const address = (await wallet.getAddress()).toLowerCase();
  const ts = Math.floor(Date.now() / 1000);
  const sig = await wallet.signMessage(bagPassChallenge(address, ts));
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

describe('MAX_KEY_HISTORY — боевое умолчание (200), не тестовое (4)', () => {
  it('putKey() напрямую (не через HTTP — потолок истории не зависит от лимитера маршрута): 200 смен умещаются целиком, 201-я вытесняет самую старую', () => {
    // Прямой вызов модуля, не HTTP — KEYS_WRITE_RATE_MAX (боевое умолчание
    // 20/мин на адрес) иначе заблокировал бы 21-ю же попытку задолго до
    // 200-й, смешивая ДВА разных боевых умолчания в одном замере.
    const address = '0x' + 'ab'.repeat(20);
    const firstKey = '0x' + '01'.repeat(32);
    directory.putKey(address, { boxKey: firstKey }, 0);

    // Ровно 200 НАСТОЯЩИХ смен после первой регистрации (i=1..200).
    for (let i = 1; i <= 200; i++) {
      const boxKey = '0x' + (i % 256).toString(16).padStart(2, '0') + '00'.repeat(31);
      directory.putKey(address, { boxKey }, i);
    }

    // Граница снизу: если бы боевое умолчание было тихо ЗАНИЖЕНО (например,
    // осталось тестовым 4, или прежним 20), history.length здесь было бы
    // меньше 200, а firstKey уже выпал бы.
    const midRec = directory.getKeyRecord(address);
    expect(midRec.keyChangeCount).toBe(200);
    expect(midRec.history.length).toBe(200); // ровно потолок, ничего ещё не потеряно
    expect(midRec.historyTruncated).toBe(false);
    expect(midRec.history.some((h) => h.boxKey === firstKey)).toBe(true);

    // Граница сверху: 201-я настоящая смена. Если бы боевое умолчание было
    // тихо ЗАВЫШЕНО (например, миллион), firstKey остался бы в истории и
    // historyTruncated не поднялся бы — этот шаг единственный, что отличает
    // "потолок ровно 200" от "потолка практически нет".
    directory.putKey(address, { boxKey: '0x' + 'ff'.repeat(32) }, 201);
    const rec = directory.getKeyRecord(address);
    expect(rec.keyChangeCount).toBe(201);
    expect(rec.history.length).toBe(200); // потолок держит форму
    expect(rec.historyTruncated).toBe(true);
    expect(rec.history.some((h) => h.boxKey === firstKey)).toBe(false); // самая старая вытолкнута
  });
});

describe('KEYS_WRITE_RATE_MAX — боевое умолчание (20/мин на адрес), не тестовое (5)', () => {
  it('POST /keys — 20 успехов на один адрес, 21-й 429 rate_limited_write', async () => {
    const wallet = ethers.Wallet.createRandom();
    const pass = await issuePassFor(wallet, LIVE_IP);

    for (let i = 0; i < 20; i++) {
      const boxKey = '0x' + (i % 256).toString(16).padStart(2, '0') + '11'.repeat(31);
      const res = await request(app)
        .post('/keys')
        .set('CF-Connecting-IP', freshIp())
        .set('x-bag-pass', pass)
        .send({ boxKey });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app)
      .post('/keys')
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass)
      .send({ boxKey: '0x' + 'ff'.repeat(32) });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited_write');
  });
});

describe('KEYS_IP_RATE_MAX — боевое умолчание (120/мин на IP), не тестовое (10)', () => {
  it('GET /keys/:address — 120 успехов с одного IP, 121-й 429 rate_limited_ip', async () => {
    for (let i = 0; i < 120; i++) {
      const wallet = ethers.Wallet.createRandom();
      const address = (await wallet.getAddress()).toLowerCase();
      const res = await request(app).get(`/keys/${address}`).set('CF-Connecting-IP', LIVE_IP);
      // Случайные кошельки здесь никогда не регистрировали ключ — честные
      // 404. Лимитеру это "прошёл", не "заблокирован" — граница ниже проверяется отдельно.
      expect(res.status).toBe(404);
    }

    const walletLast = ethers.Wallet.createRandom();
    const addressLast = (await walletLast.getAddress()).toLowerCase();
    const blocked = await request(app).get(`/keys/${addressLast}`).set('CF-Connecting-IP', LIVE_IP);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited_ip');
  });
});
