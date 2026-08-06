// ─── Коды отказа склада: 400, 413 и 500 (Задача 6, план «Клиент чата») ────
//
// ЗАЧЕМ. Хук чата обязан отличать «слишком большой файл» от «негодный
// адрес» — и делать это МАШИННО. Сегодня различить их можно только разбором
// английского текста (`/too large/i` против `/recipient/i`), а это запрещено
// прямым требованием плана (OPEN-ITEMS 29.2): текст меняется от первой же
// правки формулировки на сервере, и молча — тест на сервере остаётся
// зелёным, клиент перестаёт понимать отказ.
//
// У 401, 404 и 429 код есть с самого начала (`pass_invalid`, `bag_not_found`,
// `rate_limited_*`). У 400, 413 и 500 — нет ни одного. Этот файл запирает
// шесть недостающих.
//
// ⚠️ ЧТО ИМЕННО КРАСИТ КАЖДЫЙ ТЕСТ (правило проекта — «слепая заготовка,
// восемь случаев»): каждый смотрит на `res.body.code`, которого у этих
// веток СЕГОДНЯ НЕТ ВОВСЕ. До правки app.js все они падают на
// `expect(undefined).toBe('...')`. Снятие ЛЮБОГО одного добавленного `code:`
// в app.js красит ровно свой тест и никакой соседний — проверено снятием по
// одному, числа в отчёте задачи.
//
// ⚠️ ОТДЕЛЬНЫЙ ФАЙЛ от test/bagRoutes.test.js намеренно, и не из вкусовых
// соображений: тот файл переопределяет BAG_*_RATE_MAX маленькими числами
// (5/5/5/10) ДО импорта app.js, чтобы дёшево гонять границы лимитера. Тест
// «ровно MAX_BAG_SIZE проходит, +1 отвергается» обязан идти на БОЕВОМ
// умолчании (262144), а он требует нескольких PUT подряд — в том файле они
// упёрлись бы в чужой урезанный бюджет записи и получили бы 429 вместо
// измеряемого 413/200. Здесь ни одна переменная лимитера не трогается:
// боевые умолчания (300 на IP, 60 на запись) заведомо больше, чем нужно
// этому файлу.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';

// Тот же приём, что test/bagRoutes.test.js и test/keysInternalError.test.js:
// оборачиваем настоящий модуль и включаем бросок точечно. Без этого ветки
// 500 не достижимы настоящим HTTP-входом вовсе, и «код у 500» проверить
// нечем.
const bagStoreThrows = vi.hoisted(() => ({ recordBag: false, listBagsFor: false }));

vi.mock('../bagStore.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recordBag: (...args) => {
      if (bagStoreThrows.recordBag) throw new Error('simulated bagStore failure (test)');
      return actual.recordBag(...args);
    },
    listBagsFor: (...args) => {
      if (bagStoreThrows.listBagsFor) throw new Error('simulated bagStore failure (test)');
      return actual.listBagsFor(...args);
    },
  };
});

const { app } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');
const bagStoreNs = await import('../bagStore.js');

/** Боевое умолчание потолка мешка. Записано РУКАМИ, а не взято из
 *  `bagStoreNs.MAX_BAG_SIZE`: тест, берущий величину из проверяемого модуля,
 *  доказывает только «какая-то есть». Совпадение с модулем сверяется
 *  отдельным замком ниже — если умолчание однажды сдвинут, красным станет
 *  именно он, а не граничные тесты с непонятной причиной. */
const MAX_BAG_BYTES = 262144;

let _ipCounter = 0;
function freshIp() {
  _ipCounter++;
  return `10.77.${(_ipCounter >> 8) & 255}.${_ipCounter & 255}`;
}

async function newWallet() {
  const wallet = ethers.Wallet.createRandom();
  return { wallet, address: (await wallet.getAddress()).toLowerCase() };
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

function putBag({ pass, recipient, body, contentType = 'application/octet-stream' }) {
  return request(app)
    .put(`/bags/${recipient}`)
    .set('CF-Connecting-IP', freshIp())
    .set('x-bag-pass', pass)
    .set('Content-Type', contentType)
    .send(body);
}

afterEach(() => {
  bagStoreThrows.recordBag = false;
  bagStoreThrows.listBagsFor = false;
});

describe('коды отказа склада — 400', () => {
  it('POST /bags/pass с негодным адресом: 400 + code invalid_address', async () => {
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .send({ address: 'definitely-not-an-address' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_address');
  });

  it('PUT /bags/:recipient с негодным получателем: 400 + code invalid_recipient', async () => {
    const { wallet } = await newWallet();
    const pass = await issuePassFor(wallet);

    const res = await putBag({ pass, recipient: 'not-an-address', body: Buffer.from('x') });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_recipient');
  });

  it('PUT с Content-Type: application/json: 400 + code bag_content_type', async () => {
    // Тело съедает express.json() до маршрута — статус тот же 400, что и у
    // «пустого мешка» ниже, и различить их можно ТОЛЬКО кодом. Ровно тот
    // случай, ради которого вся эта задача: два разных отказа, один статус.
    const { wallet } = await newWallet();
    const { address: bob } = await newWallet();
    const pass = await issuePassFor(wallet);

    const res = await putBag({
      pass, recipient: bob,
      contentType: 'application/json',
      body: JSON.stringify({ not: 'a bag' }),
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bag_content_type');
  });

  it('PUT с пустым телом: 400 + code empty_bag (и это НЕ bag_content_type)', async () => {
    const { wallet } = await newWallet();
    const { address: bob } = await newWallet();
    const pass = await issuePassFor(wallet);

    const res = await putBag({ pass, recipient: bob, body: Buffer.alloc(0) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('empty_bag');
    // Замок против «поставили один код на обе ветки, статус совпадает —
    // никто не заметил».
    expect(res.body.code).not.toBe('bag_content_type');
  });

  it('GET /bags?since=мусор: 400 + code invalid_since', async () => {
    const { wallet } = await newWallet();
    const pass = await issuePassFor(wallet);

    const res = await request(app)
      .get('/bags')
      .query({ since: 'вчера' })
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_since');
  });
});

describe('коды отказа склада — 413 и его граница', () => {
  it('боевое умолчание потолка — ровно 262144 байта', () => {
    // Записанное руками число выше обязано совпадать с настоящим
    // умолчанием. Отдельный замок: сдвинули умолчание — красный именно
    // здесь, с понятной причиной, а не в граничных тестах ниже.
    expect(bagStoreNs.MAX_BAG_SIZE).toBe(MAX_BAG_BYTES);
  });

  it('мешок ровно в потолок (262144) принимается — граница минус ничего', async () => {
    const { wallet } = await newWallet();
    const { address: bob } = await newWallet();
    const pass = await issuePassFor(wallet);

    const res = await putBag({ pass, recipient: bob, body: Buffer.alloc(MAX_BAG_BYTES, 7) });

    expect(res.status).toBe(200);
    expect(typeof res.body.key).toBe('string');
  });

  it('мешок в потолок + 1 байт: 413 + code payload_too_large', async () => {
    const { wallet } = await newWallet();
    const { address: bob } = await newWallet();
    const pass = await issuePassFor(wallet);

    const res = await putBag({ pass, recipient: bob, body: Buffer.alloc(MAX_BAG_BYTES + 1, 7) });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('payload_too_large');
  });
});

describe('коды отказа склада — 500', () => {
  it('PUT, склад бросил на записи в индекс: 500 + code internal_error', async () => {
    const { wallet } = await newWallet();
    const { address: bob } = await newWallet();
    const pass = await issuePassFor(wallet);
    bagStoreThrows.recordBag = true;

    const res = await putBag({ pass, recipient: bob, body: Buffer.from('a real bag') });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
  });

  it('GET /bags, склад бросил на перечислении: 500 + code internal_error', async () => {
    const { wallet } = await newWallet();
    const pass = await issuePassFor(wallet);
    bagStoreThrows.listBagsFor = true;

    const res = await request(app)
      .get('/bags')
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
  });
});

describe('битый JSON не должен приезжать HTML-страницей Express', () => {
  // Дыра, найденная при сверке (не в исходном списке плана): express.json()
  // бросает `entity.parse.failed` ДО тела маршрута, обработчика на /bags нет
  // вовсе, и запрос уезжает в дефолтный обработчик Express — 400 с HTML и
  // стеком. Для клиента это «сервер ответил, но не тем» — `parseErrorBody`
  // в chatTransport.ts не найдёт ни `error`, ни `code`, и отказ станет
  // безымянным. Ровно вопрос «пришёл мусор — вердикт или падение».
  it('POST /bags/pass с битым JSON: 400 JSON + code malformed_json', async () => {
    const res = await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', freshIp())
      .set('Content-Type', 'application/json')
      .send('{"address": ');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('malformed_json');
  });

  it('POST /keys с битым JSON: 400 JSON + code malformed_json', async () => {
    const { wallet } = await newWallet();
    const pass = await issuePassFor(wallet);

    const res = await request(app)
      .post('/keys')
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass)
      .set('Content-Type', 'application/json')
      .send('{"boxKey": ');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('malformed_json');
  });
});

describe('замер: шесть отказов различимы кодом, не английским текстом', () => {
  it('шесть разных причин дают шесть разных кодов', async () => {
    const { wallet } = await newWallet();
    const { address: bob } = await newWallet();
    const pass = await issuePassFor(wallet);

    const collected = [];

    const badAddr = await request(app)
      .post('/bags/pass').set('CF-Connecting-IP', freshIp()).send({ address: 'nope' });
    collected.push(badAddr.body.code);

    const badRecipient = await putBag({ pass, recipient: 'nope', body: Buffer.from('x') });
    collected.push(badRecipient.body.code);

    const empty = await putBag({ pass, recipient: bob, body: Buffer.alloc(0) });
    collected.push(empty.body.code);

    const badSince = await request(app)
      .get('/bags').query({ since: 'вчера' })
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', pass);
    collected.push(badSince.body.code);

    const tooBig = await putBag({ pass, recipient: bob, body: Buffer.alloc(MAX_BAG_BYTES + 1, 7) });
    collected.push(tooBig.body.code);

    bagStoreThrows.recordBag = true;
    const broken = await putBag({ pass, recipient: bob, body: Buffer.from('a real bag') });
    collected.push(broken.body.code);
    bagStoreThrows.recordBag = false;

    // Ни одного `undefined` и ни одного повтора — иначе клиенту пришлось бы
    // разбирать текст хотя бы для одной пары.
    expect(collected.filter(c => typeof c === 'string')).toHaveLength(6);
    expect(new Set(collected).size).toBe(6);

    // И сверх того: статусы у трёх из них совпадают (400, 400, 400) —
    // значит статус причины НЕ называет, а код называет.
    expect([badRecipient.status, empty.status, badSince.status]).toEqual([400, 400, 400]);
  });
});
