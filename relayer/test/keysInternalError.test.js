// ─── /keys — 500 несёт код (мелочь ревью координатора, round 2) ───────────
//
// "500 без кода — единственный ответ этих маршрутов без машинного признака."
// Оба маршрута /keys уже различают invalid_key/directory_unavailable кодом
// — но их ПОСЛЕДНИЙ catch-all (неожиданная ошибка модуля) отвечал голым
// {error: '...'} без code. Замок ниже мокает putKey()/getKeyRecord()
// (relayer/directory.js), тем же приёмом, что test/bagRoutes.test.js уже
// применяет к recordBag()/markFetched() (bagStore.js) — этот путь не
// достижим настоящим HTTP-входом (адрес уже проверен requireBagPass() до
// putKey(), nowMs всегда Date.now()), только внутренним сбоем модуля.
//
// ⚠️ ОТДЕЛЬНЫЙ ФАЙЛ от test/directory.test.js/directoryLiveDefaults.test.js
// намеренно — те два опираются на ЖИВЫЕ `export let` (DIRECTORY_FILE,
// MAX_KEY_HISTORY, STORAGE_DIR) через прямой (немокнутый) импорт
// directory.js: замок 4 (config-refresh, round 2) читает
// fresh.DIRECTORY_FILE ПОСЛЕ fresh.assertDirectoryReady() и ожидает, что
// оно отражает НОВОЕ значение. vi.mock(..., async (importOriginal) => ({
// ...actual, ... })) спредит `actual` ОДИН раз в момент вызова фабрики —
// для функций это не проблема (обёртки замыкаются на actual.putKey и
// зовут его настоящим), но для `export let` спред снимает СНИМОК
// значения, а не живую ссылку (тот же урок, что test/bagStore.test.js
// формулирует в шапке про `const {X} = await import(...)`, только здесь
// его создаёт сам vi.mock, а не деструктуризация в тесте). Мокая
// directory.js в ТОМ ЖЕ файле, где уже живут замок 3/4, я рисковал бы
// молча сломать их зависимостью от снимка вместо живого значения — тот же
// класс дыры, ради которой bagStore.test.js (живые `export let`,
// НЕ мокает bagStore.js) и bagRoutes.test.js (мокает bagStore.js,
// НЕ полагается на его `export let`) разведены по разным файлам в этом же
// проекте. Разведено так же.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';

const directoryThrows = vi.hoisted(() => ({ putKey: false, getKeyRecord: false }));

vi.mock('../directory.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    putKey: (...args) => {
      if (directoryThrows.putKey) throw new Error('simulated directory failure (test)');
      return actual.putKey(...args);
    },
    getKeyRecord: (...args) => {
      if (directoryThrows.getKeyRecord) throw new Error('simulated directory failure (test)');
      return actual.getKeyRecord(...args);
    },
  };
});

const { app } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');

let _ipCounter = 0;
function freshIp() {
  _ipCounter++;
  return `10.9.${(_ipCounter >> 8) & 255}.${_ipCounter & 255}`;
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

afterEach(() => {
  directoryThrows.putKey = false;
  directoryThrows.getKeyRecord = false;
});

describe('/keys — 500 несёт код, не только статус', () => {
  it('POST /keys: putKey бросает неожиданно — 500 с code internal_error', async () => {
    const wallet = ethers.Wallet.createRandom();
    const pass = await issuePassFor(wallet);
    directoryThrows.putKey = true;

    const res = await request(app)
      .post('/keys')
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass)
      .send({ boxKey: '0x' + '11'.repeat(32) });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
  });

  it('GET /keys/:address: getKeyRecord бросает неожиданно — 500 с code internal_error', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    directoryThrows.getKeyRecord = true;

    const res = await request(app).get(`/keys/${address}`).set('CF-Connecting-IP', freshIp());

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
  });
});
