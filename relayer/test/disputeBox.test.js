import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

/**
 * Ящик спора: три маршрута, замок по цепи, различимые отказы.
 *
 * Все чтения цепи идут через мок ethers.Contract (test/setup.js): по адресу
 * диамонда отвечают getRecord/getDisputeClaimer/getPendingVerdict, по адресу
 * сделки — getDetails. Настоящий узел не дёргается ни разу.
 */

// Обёртка над настоящим bagStore.js — тот же приём, что в test/bagRoutes.test.js:
// нужен ровно один тест, где запись описи РЕАЛЬНО бросает («кончилось место»).
const bagStoreThrows = vi.hoisted(() => ({ recordBag: false }));

vi.mock('../bagStore.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recordBag: (...args) => {
      if (bagStoreThrows.recordBag) throw new Error('simulated ENOSPC (test)');
      return actual.recordBag(...args);
    },
  };
});

// Бюджеты — маленькие, ДО динамического импорта app.js (он читает process.env
// на уровне модуля, а статический import поднялся бы выше этих присваиваний).
// Восемь на запись — не круглое число: ровно столько же запросов помещается в
// бюджет /relay (RATE_MAX = 10), и на этом совпадении стоит тест префикса T25.
// Тридцать на чтение — чтобы замер кэша (T16, 26 запросов подряд) не упирался
// в бюджет вместо кэша; границу самого бюджета меряет отдельный T18b.
process.env.DISPUTE_BOX_WRITE_RATE_MAX = '8';
process.env.DISPUTE_BOX_READ_RATE_MAX  = '30';
process.env.DISPUTE_BOX_CHAIN_MAX      = '6';

const { app, _resetDisputeBoxCache } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');
const bagStoreNs = await import('../bagStore.js');
const { bagKeyFor, recordBag, bagMetaOf, bagPathFor, listDisputeBags, _loadBagMeta } = bagStoreNs;
const { mockContract } = await import('./mocks/ethersRegistry.js');

const DIAMOND = '0x2222222222222222222222222222222222222222';   // test/setup.js
const ZERO    = '0x0000000000000000000000000000000000000000';

// ─── Заготовки ──────────────────────────────────────────────────────────────

let _ipCounter = 0;
function freshIp() {
  _ipCounter++;
  return `10.77.${(_ipCounter >> 8) & 255}.${_ipCounter & 255}`;
}

let _agrCounter = 0;
/** Уникальный адрес сделки на тест — чтобы кэш фактов не тёк между тестами. */
function freshAgreement() {
  _agrCounter++;
  return `0x${_agrCounter.toString(16).padStart(40, '0')}`;
}

/**
 * Каталог ящика на диске — через bagPathFor(), а не склейкой с DIR_BAGS:
 * DIR_BAGS это `export let`, а vi.mock над bagStore.js замораживает такие
 * значения снимком (ловушка, названная в test/cleanup.test.js). Путь,
 * посчитанный сертифицированной функцией, этой ловушке не подвержен.
 */
function boxDir(agreement) {
  return path.dirname(bagPathFor(`${agreement}/0-00000000-0000-0000-0000-000000000000.bin`));
}

async function issuePassFor(wallet) {
  const address = (await wallet.getAddress()).toLowerCase();
  const ts = Math.floor(Date.now() / 1000);
  const sig = await wallet.signMessage(bagPassChallenge(address, ts));
  const res = await request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', freshIp())
    .set('x-ts', String(ts))
    .set('x-sig', sig)
    .send({ address });
  if (res.status !== 200) {
    throw new Error(`issuePassFor precondition failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { pass: res.body.pass, address };
}

/**
 * Счётчик обращений к цепи. Считает ИМЕННО getRecord — первое из трёх чтений
 * на промах кэша: если его не было, не было и остальных. (Задача 2 добавит на
 * пути записи четвёртое, DISPUTE_WINDOW; счётчик от этого не меняется, но
 * поддельная сделка обязана будет на него отвечать — см. ⚠ в шапке файла.)
 */
let chainReads = 0;

/**
 * Одна сделка на цепи. `status` — enum САМОЙ СДЕЛКИ (4 = DISPUTED), не реестра.
 * `arbiter` — живая заявка; `verdictArbiter` — арбитр уже поданного вердикта
 * (заявка стёрта clearDisputeClaim).
 */
function mockDeal({ agreement, client, executor, status = 4, arbiter = null, verdictArbiter = null }) {
  mockContract(DIAMOND, {
    getRecord: async (addr) => {
      chainReads++;
      return String(addr).toLowerCase() === agreement
        ? { agreement, client, executor, amount: 0n, status: 3, createdAt: 0n, resolvedAt: 0n }
        // Незнакомый адрес: НУЛИ и status = 0, что в enum РЕЕСТРА значит ACTIVE.
        : { agreement: ZERO, client: ZERO, executor: ZERO, amount: 0n, status: 0, createdAt: 0n, resolvedAt: 0n };
    },
    getDisputeClaimer: async () => arbiter ?? ZERO,
    getPendingVerdict: async () => (verdictArbiter
      ? { arbiter: verdictArbiter, submittedAt: 1n }
      : { arbiter: ZERO, submittedAt: 0n }),
  });
  mockContract(agreement, { getDetails: async () => ({ status_: BigInt(status) }) });
}

/** Узел молчит: любое чтение реестра бросает. */
function mockSilentChain(agreement) {
  mockContract(DIAMOND, {
    getRecord: async () => { chainReads++; throw new Error('node is silent (test)'); },
    getDisputeClaimer: async () => ZERO,
    getPendingVerdict: async () => ({ arbiter: ZERO, submittedAt: 0n }),
  });
  mockContract(agreement, { getDetails: async () => ({ status_: 4n }) });
}

function putBox({ pass, agreement, body, sealedFor, ip, contentType = 'application/octet-stream' }) {
  const req = request(app)
    .put(`/disputes/${agreement}/bags`)
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-bag-pass', pass)
    .set('Content-Type', contentType);
  if (sealedFor !== undefined) req.set('x-sealed-for', sealedFor);
  return req.send(body);
}

function listBox({ pass, agreement, ip }) {
  return request(app)
    .get(`/disputes/${agreement}/bags`)
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-bag-pass', pass);
}

function getBox({ pass, agreement, name, ip, method = 'get' }) {
  return request(app)[method](`/disputes/${agreement}/bags/${name}`)
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-bag-pass', pass);
}

/**
 * Кладёт мешок в опись НАПРЯМУЮ, минуя маршрут. Тесты чтения обязаны не
 * зависеть от замка записи: иначе одна мутация в PUT красила бы половину
 * файла и число переставало бы что-либо означать.
 */
function seedBoxBag({ agreement, sender, sealedFor = null, bytes = Buffer.from('мешок') }) {
  const key = bagKeyFor(agreement);
  fs.mkdirSync(path.dirname(bagPathFor(key)), { recursive: true });
  fs.writeFileSync(bagPathFor(key), bytes);
  recordBag({
    sender, recipient: agreement, key, size: bytes.length,
    uploadedAt: Date.now(), deal: agreement, sealedFor,
  });
  return key;
}

/**
 * Настоящий обрыв соединения посреди тела — supertest так не умеет, он всегда
 * шлёт целиком. Форма скопирована с abortedPut() в test/bagRoutes.test.js.
 */
async function abortedPut({ agreement, pass, declaredLength, actualBytes }) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    await new Promise((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        socket.write([
          `PUT /disputes/${agreement}/bags HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Content-Type: application/octet-stream`,
          `x-bag-pass: ${pass}`,
          `cf-connecting-ip: ${freshIp()}`,
          `Content-Length: ${declaredLength}`,
          `Connection: close`,
          '', '',
        ].join('\r\n'));
        socket.write(Buffer.alloc(actualBytes, 1));
        setTimeout(() => { socket.destroy(); resolve(); }, 100);
      });
      socket.on('error', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Ровно предельный законный мешок. Число написано руками, а не взято из модуля. */
const MAX_BAG_BYTES = 256 * 1024;

/**
 * PUT через НАСТОЯЩИЙ сокет и настоящим `fetch` — тем самым клиентом, которым
 * ходит фронт (Задача 6). Нужен ровно для одного вопроса: доезжает ли КОД
 * отказа, когда сервер отвечает, НЕ ПРОЧИТАВ большого тела. supertest на этот
 * вопрос не отвечает: он всегда дожидается своего ответа сам и обрыв соединения
 * показал бы иначе.
 */
async function bigPutOverSocket({ agreement, pass, bytes }) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/disputes/${agreement}/bags`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-bag-pass': pass,
        'cf-connecting-ip': freshIp(),
      },
      body: new Uint8Array(bytes),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  chainReads = 0;
  bagStoreThrows.recordBag = false;
  _resetDisputeBoxCache();
});

// ═══════════════════════════════════════════════════════════════════════════
// Кто вправе класть
// ═══════════════════════════════════════════════════════════════════════════

describe('замок записи: только две стороны спора', () => {
  it('T1: посторонний с ЖИВЫМ пропуском — 403 not_a_party, на диске ноль байт', async () => {
    const agreement = freshAgreement();
    const client   = ethers.Wallet.createRandom();
    const executor = ethers.Wallet.createRandom();
    const stranger = ethers.Wallet.createRandom();
    mockDeal({
      agreement,
      client: (await client.getAddress()).toLowerCase(),
      executor: (await executor.getAddress()).toLowerCase(),
    });
    const { pass } = await issuePassFor(stranger);

    const res = await putBox({ pass, agreement, body: Buffer.from('мешок') });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_a_party');
    // Замок стоит ДО первого байта: каталога ящика не появилось вовсе.
    expect(listDisputeBags(agreement)).toEqual([]);
    expect(fs.existsSync(boxDir(agreement))).toBe(false);
  });

  it('T27: отказ с телом в 256 КиБ доезжает КОДОМ, а не обрывом соединения', async () => {
    // Замок отвечает 403, НЕ прочитав тела, — в этом его смысл (мешок
    // постороннего не занимает места ни на миг). Вопрос теста другой: видит ли
    // человек причину. Если сервер закроет сокет с недочитанным телом, `fetch`
    // на той стороне бросит TypeError, клиент Задачи 6 разберёт это как
    // «не удалось достучаться до сервера», и различимый отказ пропадёт ровно
    // там, ради чего заводился. Все остальные отказные тесты этого файла шлют
    // единицы байт и такого случая не касаются вовсе.
    const agreement = freshAgreement();
    const stranger = ethers.Wallet.createRandom();
    const { pass } = await issuePassFor(stranger);
    mockDeal({
      agreement, client: '0x' + '11'.repeat(20), executor: '0x' + '22'.repeat(20),
      status: 4, arbiter: '0x' + '44'.repeat(20),
    });
    // Сцена вырождена, если предельный мешок стал другого размера: тогда 256 КиБ
    // перестанут быть «настоящим предъявлением» и тест померит что-то помельче.
    expect(bagStoreNs.MAX_BAG_SIZE, 'сцена вырождена: потолок мешка изменился')
      .toBe(MAX_BAG_BYTES);

    const res = await bigPutOverSocket({ agreement, pass, bytes: MAX_BAG_BYTES });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_a_party');
    // И на диск не легло ни байта — дочитанное ушло в никуда.
    expect(listDisputeBags(agreement)).toEqual([]);
    expect(fs.existsSync(boxDir(agreement))).toBe(false);
  });

  it('T2: сторона, но спора ещё нет (status_ = 2, ACTIVE) — 409 not_disputed', async () => {
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO, status: 2 });

    const res = await putBox({ pass, agreement, body: Buffer.from('мешок') });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_disputed');
    expect(listDisputeBags(agreement)).toEqual([]);
  });

  it('T2b: status_ = 3 — это COMPLETED У СДЕЛКИ (а DISPUTED у РЕЕСТРА) — 409', async () => {
    // Ловушка двух enum. Спутав их, замок принял бы завершённую сделку за
    // спорную и отверг настоящий спор.
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO, status: 3 });

    const res = await putBox({ pass, agreement, body: Buffer.from('мешок') });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_disputed');
  });

  it('T3: сторона в споре — 200, ключ из адреса сделки, файл и запись описи', async () => {
    const agreement = freshAgreement();
    const arbiter = '0x' + 'ab'.repeat(20);
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO, status: 4, arbiter });

    const body = Buffer.from('запечатанное предъявление');
    const res = await putBox({ pass, agreement, body, sealedFor: arbiter });

    expect(res.status).toBe(200);
    expect(res.body.key.startsWith(`${agreement}/`)).toBe(true);
    expect(fs.readFileSync(bagPathFor(res.body.key))).toEqual(body);

    // Форма ответа PUT — ровно два поля, список написан РУКАМИ (мутация 20).
    // Задача 6 зеркалит именно её: `Promise<{ key: string; uploadedAt: number }>`.
    // Без этой строчки «сервер вернул время приёмки» держалось бы на одном
    // typeof, и молчаливая потеря поля прошла бы незамеченной — клиент просто
    // подставил бы часы устройства.
    expect(Object.keys(res.body).sort()).toEqual(['key', 'uploadedAt']);
    expect(typeof res.body.uploadedAt).toBe('number');

    const meta = bagMetaOf(res.body.key);
    // И это ровно то время, которое лежит в описи: наружу уходят ЧАСЫ СЕРВЕРА,
    // а не что-то посчитанное отдельно для ответа.
    expect(res.body.uploadedAt).toBe(meta.uploadedAt);
    expect(meta.deal).toBe(agreement);          // мутация 7
    expect(meta.sealedFor).toBe(arbiter);       // мутация 9
    expect(meta.sender).toBe(address);
    expect(meta.size).toBe(body.length);
    expect(listDisputeBags(agreement).map((b) => b.key)).toEqual([res.body.key]);
  });

  it('T4: незнакомая сделка — 404 no_such_deal (нули со status = 0 = ACTIVE у реестра)', async () => {
    const agreement = freshAgreement();
    const known = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement: known, client: address, executor: ZERO });   // спрашиваем ДРУГОЙ

    const res = await putBox({ pass, agreement, body: Buffer.from('мешок') });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('no_such_deal');
  });

  it('T5: узел молчит — 503 chain_unavailable, а НЕ «пускаем на всякий случай»', async () => {
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass } = await issuePassFor(client);
    mockSilentChain(agreement);

    const res = await putBox({ pass, agreement, body: Buffer.from('мешок') });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('chain_unavailable');
    expect(res.headers['retry-after']).toBe('5');
    expect(listDisputeBags(agreement)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Кто вправе читать
// ═══════════════════════════════════════════════════════════════════════════

describe('замок чтения: тот, кто ведёт спор СЕЙЧАС', () => {
  it('T6: арбитр видит опись целиком — оба мешка обеих сторон', async () => {
    const agreement = freshAgreement();
    const arbWallet = ethers.Wallet.createRandom();
    const { pass, address: arb } = await issuePassFor(arbWallet);
    const client   = '0x' + '11'.repeat(20);
    const executor = '0x' + '22'.repeat(20);
    mockDeal({ agreement, client, executor, arbiter: arb });
    const k1 = seedBoxBag({ agreement, sender: client,   sealedFor: arb });
    const k2 = seedBoxBag({ agreement, sender: executor, sealedFor: arb });

    const res = await listBox({ pass, agreement });

    expect(res.status).toBe(200);
    expect(res.body.arbiter).toBe(arb);
    expect(res.body.sealedForOthers).toBe(0);
    expect(res.body.bags.map((b) => b.key).sort()).toEqual([k1, k2].sort());
    // Форма ОПИСИ (DisputeBoxList) — ровно четыре поля верхнего уровня
    // (ревью, круг 2: добавлен indexTrusted). Список написан руками, а не
    // собран из ответа — Задача 6 зеркалит именно его.
    expect(Object.keys(res.body).sort())
      .toEqual(['arbiter', 'bags', 'indexTrusted', 'sealedForOthers']);
    // Индекс цел — опись не восстанавливалась с диска, bags можно
    // показывать как факт. Контрольная пара к T30 (там же, но false).
    expect(res.body.indexTrusted).toBe(true);
    // Форма записи описи — ровно шесть полей, ни больше ни меньше (Задача 6
    // зеркалит именно её). Список написан руками, а не собран из ответа.
    expect(Object.keys(res.body.bags[0]).sort())
      .toEqual(['fetchedAt', 'key', 'sealedFor', 'sender', 'size', 'uploadedAt']);
    // Не забирали — честный null, а НЕ false и не отсутствующее поле
    // (мутация 21): булево не даёт стороне сказать, КОГДА забрали.
    expect(res.body.bags[0].fetchedAt).toBe(null);
  });

  it('T6b: посторонний с живым пропуском — 403 not_the_arbiter, описи не видит', async () => {
    const agreement = freshAgreement();
    const stranger = ethers.Wallet.createRandom();
    const { pass } = await issuePassFor(stranger);
    mockDeal({
      agreement, client: '0x' + '11'.repeat(20), executor: '0x' + '22'.repeat(20),
      arbiter: '0x' + '33'.repeat(20),
    });
    seedBoxBag({ agreement, sender: '0x' + '11'.repeat(20) });

    const res = await listBox({ pass, agreement });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_the_arbiter');
    expect(res.body.bags).toBeUndefined();
  });

  it('T7: ПРЕЖНИЙ арбитр читать не может — ни опись, ни мешок', async () => {
    const agreement = freshAgreement();
    const oldArb = ethers.Wallet.createRandom();
    const { pass, address: oldAddr } = await issuePassFor(oldArb);
    const newArb = '0x' + '44'.repeat(20);
    const key = seedBoxBag({ agreement, sender: '0x' + '11'.repeat(20), sealedFor: oldAddr });

    // Спор перезаявлен: getDisputeClaimer отдаёт уже другого.
    mockDeal({ agreement, client: '0x' + '11'.repeat(20), executor: '0x' + '22'.repeat(20), arbiter: newArb });

    const list = await listBox({ pass, agreement });
    expect(list.status).toBe(403);
    expect(list.body.code).toBe('not_the_arbiter');

    const one = await getBox({ pass, agreement, name: key.split('/')[1] });
    expect(one.status).toBe(403);
    expect(one.body.code).toBe('not_the_arbiter');
    // И главное: галочка «забрал» не поднялась.
    expect(bagMetaOf(key).firstFetchedAt).toBe(null);
  });

  it('T8: арбитр забирает мешок — те же байты, «забрал» поднимается', async () => {
    const agreement = freshAgreement();
    const arbWallet = ethers.Wallet.createRandom();
    const { pass, address: arb } = await issuePassFor(arbWallet);
    mockDeal({ agreement, client: '0x' + '11'.repeat(20), executor: '0x' + '22'.repeat(20), arbiter: arb });
    const bytes = Buffer.from([1, 2, 3, 250, 251, 0, 255]);
    const key = seedBoxBag({ agreement, sender: '0x' + '11'.repeat(20), sealedFor: arb, bytes });

    const res = await getBox({ pass, agreement, name: key.split('/')[1] })
      .buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.from(res.body)).toEqual(bytes);
    const marked = bagMetaOf(key).firstFetchedAt;
    expect(marked).not.toBe(null);

    // Наружу уходит МОМЕНТ, а не галочка, и это тот же момент, что в описи:
    // сторона печатает «забрал 14:07» по часам СЕРВЕРА (мутация 21).
    const list = await listBox({ pass, agreement });
    expect(list.body.bags[0].fetchedAt).toBe(marked);
    expect(typeof list.body.bags[0].fetchedAt).toBe('number');
  });

  it('T8b: арбитр ФИНАЛИЗИРОВАННОГО вердикта читает — заявка стёрта, вердикт помнит', async () => {
    // Вторая половина disputeArbiterOf. Без неё арбитр теряет доступ ровно в
    // тот момент, когда спор разбирают по апелляции.
    const agreement = freshAgreement();
    const arbWallet = ethers.Wallet.createRandom();
    const { pass, address: arb } = await issuePassFor(arbWallet);
    mockDeal({
      agreement, client: '0x' + '11'.repeat(20), executor: '0x' + '22'.repeat(20),
      status: 5,                 // RESOLVED — читать по-прежнему можно
      arbiter: null,             // getDisputeClaimer вернул ноль
      verdictArbiter: arb,       // а вердикт помнит человека
    });
    const key = seedBoxBag({ agreement, sender: '0x' + '11'.repeat(20), sealedFor: arb });

    const list = await listBox({ pass, agreement });
    expect(list.status).toBe(200);
    expect(list.body.arbiter).toBe(arb);
    expect(list.body.bags.map((b) => b.key)).toEqual([key]);
  });

  it('T9: отправитель забирает СВОЙ мешок — 200, но «забрал» НЕ поднимается', async () => {
    const agreement = freshAgreement();
    const sender = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(sender);
    mockDeal({ agreement, client: address, executor: '0x' + '22'.repeat(20), arbiter: '0x' + '44'.repeat(20) });
    const key = seedBoxBag({ agreement, sender: address, sealedFor: '0x' + '44'.repeat(20) });

    const res = await getBox({ pass, agreement, name: key.split('/')[1] });

    expect(res.status).toBe(200);
    // Галочка «забрал» — про арбитра. Своё чтение её не зажигает, иначе она
    // врала бы в сторону, которую невозможно заметить.
    expect(bagMetaOf(key).firstFetchedAt).toBe(null);
  });

  it('T10: сторона видит ТОЛЬКО свои мешки; чужой — 404 bag_not_found', async () => {
    const agreement = freshAgreement();
    const me = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(me);
    const peer = '0x' + '22'.repeat(20);
    mockDeal({ agreement, client: address, executor: peer, arbiter: '0x' + '44'.repeat(20) });
    const mine  = seedBoxBag({ agreement, sender: address });
    const alien = seedBoxBag({ agreement, sender: peer });

    const list = await listBox({ pass, agreement });
    expect(list.status).toBe(200);
    expect(list.body.bags.map((b) => b.key)).toEqual([mine]);   // мутация 17

    const res = await getBox({ pass, agreement, name: alien.split('/')[1] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('bag_not_found');
  });

  it('T11: sealedForOthers — только по ВИДИМЫМ мешкам, и ноль, когда арбитра нет', async () => {
    const agreement = freshAgreement();
    const me = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(me);
    const peer = '0x' + '22'.repeat(20);
    const arb  = '0x' + '44'.repeat(20);
    const gone = '0x' + '55'.repeat(20);
    mockDeal({ agreement, client: address, executor: peer, arbiter: arb });
    seedBoxBag({ agreement, sender: address, sealedFor: gone });  // мой, прежнему арбитру
    seedBoxBag({ agreement, sender: address, sealedFor: arb });   // мой, нынешнему
    seedBoxBag({ agreement, sender: address, sealedFor: null });  // мой, без заявления
    seedBoxBag({ agreement, sender: peer,    sealedFor: gone });  // ЧУЖОЙ — считаться не должен

    const mineView = await listBox({ pass, agreement });
    expect(mineView.body.bags).toHaveLength(3);
    expect(mineView.body.sealedForOthers).toBe(1);   // мутации 9, 18

    // Арбитра нет вовсе — сравнивать не с кем, и мы не выдумываем.
    _resetDisputeBoxCache();
    mockDeal({ agreement, client: address, executor: peer, arbiter: null });
    const noArb = await listBox({ pass, agreement });
    expect(noArb.body.arbiter).toBe(null);
    expect(noArb.body.sealedForOthers).toBe(0);
  });

  it('T26: HEAD отдаёт заголовки и НЕ поднимает «забрал»', async () => {
    const agreement = freshAgreement();
    const arbWallet = ethers.Wallet.createRandom();
    const { pass, address: arb } = await issuePassFor(arbWallet);
    mockDeal({ agreement, client: '0x' + '11'.repeat(20), executor: '0x' + '22'.repeat(20), arbiter: arb });
    const key = seedBoxBag({ agreement, sender: '0x' + '11'.repeat(20), sealedFor: arb });

    const res = await getBox({ pass, agreement, name: key.split('/')[1], method: 'head' });

    expect(res.status).toBe(200);
    expect(bagMetaOf(key).firstFetchedAt).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Пришёл мусор
// ═══════════════════════════════════════════════════════════════════════════

describe('мусор на входе — вердикт, а не падение', () => {
  it('T12: кривой x-sealed-for — 400 invalid_sealed_for, НОЛЬ обращений к цепи', async () => {
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO });

    // ⚠️ ОТКЛОНЕНИЕ ОТ ПЛАНА, замерено на этом дереве 11 августа: план требовал
    // здесь 'не адрес' (кириллица) первым значением. Node v24.12.0 отвергает
    // такое значение ДО отправки запроса — `req.set('x-sealed-for', 'не
    // адрес')` бросает `TypeError: Invalid character in header content`
    // (http.OutgoingMessage.setHeader принимает только Latin-1: коды 0x09,
    // 0x20-0x7E, 0x80-0xFF; кириллица — за пределами). Тест как написан не
    // проходит ни при какой реализации маршрута: строка не может уехать по
    // проводу вообще. Заменено на ASCII-мусор с тем же смыслом («точно не
    // адрес»), проверка остаётся той же — форма, а не эта конкретная строка.
    for (const bad of ['not-an-address', '0x123', '0x' + 'z'.repeat(40), '', '0x' + 'a'.repeat(41)]) {
      const res = await putBox({ pass, agreement, body: Buffer.from('мешок'), sealedFor: bad });
      expect({ bad, status: res.status, code: res.body.code })
        .toEqual({ bad, status: 400, code: 'invalid_sealed_for' });
    }
    // Форма проверяется РАНЬШЕ цепи: мусор не стоит нам ни одного eth_call.
    expect(chainReads).toBe(0);
    expect(listDisputeBags(agreement)).toEqual([]);
  });

  it('T12b: заголовка нет вовсе — 200 и честное sealedFor: null', async () => {
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO, arbiter: '0x' + '44'.repeat(20) });

    const res = await putBox({ pass, agreement, body: Buffer.from('мешок') });
    expect(res.status).toBe(200);

    // ⚠️ Проверяем ВЫДАЧУ, а не запись описи. В описи поля при `null` просто
    // НЕТ (так запись чат-мешка остаётся байт в байт прежней), а наружу
    // маршрут обязан отдать честный `null`: `undefined` исчез бы из JSON
    // целиком, и клиент Задачи 6 не отличил бы «не заявлено» от «поля нет в
    // ответе вообще».
    const list = await listBox({ pass, agreement });
    expect(list.body.bags[0].sealedFor).toBe(null);
    expect('sealedFor' in list.body.bags[0]).toBe(true);
  });

  it('T13: пустое тело — 400 empty_bag, файла на диске не остаётся', async () => {
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO });

    const res = await putBox({ pass, agreement, body: Buffer.alloc(0) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('empty_bag');
    expect(listDisputeBags(agreement)).toEqual([]);
    expect(fs.readdirSync(boxDir(agreement))).toEqual([]);
  });

  it('T14: content-type: application/json — 400 bag_content_type, НОЛЬ обращений к цепи', async () => {
    // Глобальный express.json() уже съел бы тело выше по цепочке, и мешок лёг
    // бы нулевого размера с ответом 200. Отказ явный, до всего остального.
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO });

    const res = await putBox({
      pass, agreement, body: JSON.stringify({ a: 1 }), contentType: 'application/json',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bag_content_type');
    expect(chainReads).toBe(0);
  });

  it('T28: битый JSON — 400 malformed_json ТЕЛОМ, а не HTML-страница express', async () => {
    // Глобальный express.json() бросает `entity.parse.failed` ДО маршрута, то
    // есть проверка content-type внутри маршрута до этого случая не доживает.
    // Без строки `app.use('/disputes', bodyParserErrorHandler)` (шаг 5.1)
    // ответ придёт от дефолтного обработчика express: 400 с HTML и стеком, без
    // `error` и без `code` — клиент Задачи 6 получит безымянный отказ. Тот же
    // класс дыры, что уже закрыт на /bags и /keys (test/bagErrorCodes.test.js).
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass } = await issuePassFor(client);

    const res = await request(app)
      .put(`/disputes/${agreement}/bags`)
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass)
      .set('Content-Type', 'application/json')
      .send('{"мешок": ');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('malformed_json');
    expect(chainReads).toBe(0);
  });

  it('T15: кривой :agreement и попытка обхода каталога — 400/404, НОЛЬ обращений к цепи', async () => {
    const client = ethers.Wallet.createRandom();
    const { pass } = await issuePassFor(client);

    // `..` в чистом виде не проверяем: superagent нормализует такой путь ещё
    // до отправки, и тест мерил бы клиента, а не сервер.
    //
    // ⚠️ ОТКЛОНЕНИЕ ОТ ПЛАНА, замерено на этом дереве 11 августа: план ожидал,
    // что `%2e%2e` «доезжает как есть и декодируется уже в express». Неверно
    // для этого стека: и `fetch`, и superagent строят URL по WHATWG URL —
    // спецификация явно относит одиночный `%2e%2e` к «double-dot path
    // segment» (наравне с буквальным `..`) и схлопывает его ДО отправки, ещё
    // на клиенте. Замерено напрямую: `GET /disputes/%2e%2e/bags` уходит со
    // стороны как `GET /bags` — другой существующий маршрут — и до
    // `boxAgreementParam` не доходит вовсе (200 вместо 400, `req.params`
    // никогда не видит агримента). Заменено на `%252e%252e` (двойное
    // кодирование): под то же определение WHATWG не попадает, уходит по
    // проводу без изменений, `decodeURIComponent` на сервере разворачивает
    // его РОВНО ОДИН РАЗ (так делает Express) в `%2e%2e` — не в `..` — и это
    // по-прежнему не адрес, проверка бьёт по той же ветке `LOWER_ADDR_RE`.
    // Замерено: `req.params.agreement === '%2e%2e'`, ответ 200 при живом
    // маршруте без проверки, 400 invalid_agreement при ней — то есть подмена
    // сохраняет то самое поведение, которое тест проверяет.
    for (const bad of ['не-адрес', '0x123', '0x' + 'a'.repeat(41), '0x' + 'g'.repeat(40), '%252e%252e']) {
      const res = await listBox({ pass, agreement: bad });
      expect({ bad, status: res.status, code: res.body.code })
        .toEqual({ bad, status: 400, code: 'invalid_agreement' });
    }
    expect(chainReads).toBe(0);

    // Имя мешка от клиента — тоже чужие данные. bagPathFor() бросает на любой
    // форме, кроме своей собственной; наружу это ровно bag_not_found.
    const agreement = freshAgreement();
    const wallet = ethers.Wallet.createRandom();
    const { pass: p2, address } = await issuePassFor(wallet);
    mockDeal({ agreement, client: address, executor: ZERO, arbiter: address });
    for (const name of ['..%2F..%2Fetc%2Fpasswd', 'нет-такого.bin', 'x'.repeat(300)]) {
      const res = await getBox({ pass: p2, agreement, name });
      expect({ name, status: res.status, code: res.body.code })
        .toEqual({ name, status: 404, code: 'bag_not_found' });
    }

    // И обратное: адрес с контрольной суммой (так его отдаёт кошелёк) —
    // законный вход. На проводе вид один, приводит к нему сервер.
    const upper = `0x${agreement.slice(2).toUpperCase()}`;
    const ok = await listBox({ pass: p2, agreement: upper });
    expect(ok.status).toBe(200);
    expect(ok.body.arbiter).toBe(address);
  });

  it('T21: диск кончился (опись бросает) — 500 internal_error, обрезка нет, процесс жив', async () => {
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO });
    bagStoreThrows.recordBag = true;

    const res = await putBox({ pass, agreement, body: Buffer.from('мешок') });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
    expect(fs.readdirSync(boxDir(agreement))).toEqual([]);

    // Процесс жив: следующий запрос обслуживается как ни в чём не бывало.
    bagStoreThrows.recordBag = false;
    const again = await putBox({ pass, agreement, body: Buffer.from('мешок') });
    expect(again.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Цена цепи: кэш, придержка, бюджет
// ═══════════════════════════════════════════════════════════════════════════

describe('обращения к цепи считаются числом', () => {
  it('T16: ЗАМЕР — 26 запросов в одном окне TTL стоят ОДНО обращение к цепи', async () => {
    const agreement = freshAgreement();
    const arbWallet = ethers.Wallet.createRandom();
    const { pass, address: arb } = await issuePassFor(arbWallet);
    mockDeal({ agreement, client: '0x' + '11'.repeat(20), executor: '0x' + '22'.repeat(20), arbiter: arb });

    for (let i = 0; i < 26; i++) {
      const res = await listBox({ pass, agreement });
      expect(res.status).toBe(200);
    }

    console.info(`[замер] ящик спора: 26 запросов в окне TTL → ${chainReads} обращение(й) к цепи; `
      + `при TTL 15 c это ≤4 обращения на ящик в минуту`);
    expect(chainReads).toBe(1);
  });

  it('T17: узел молчит — придержка держит: три запроса, ОДНО обращение, три 503', async () => {
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass } = await issuePassFor(client);
    mockSilentChain(agreement);

    const codes = [];
    for (let i = 0; i < 3; i++) {
      const res = await listBox({ pass, agreement });
      codes.push([res.status, res.body.code]);
    }

    expect(codes).toEqual([[503, 'chain_unavailable'], [503, 'chain_unavailable'], [503, 'chain_unavailable']]);
    // Неудача НЕ кэшируется как ответ — кэшируется только частота повторов.
    expect(chainReads).toBe(1);
  });

  it('T18: бюджет обращений к цепи исчерпан — 429 rate_limited_box_chain', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(wallet);
    const statuses = [];
    for (let i = 0; i < 7; i++) {            // DISPUTE_BOX_CHAIN_MAX = 6 в этом файле
      const agreement = freshAgreement();
      mockDeal({ agreement, client: address, executor: ZERO, arbiter: address });
      const res = await listBox({ pass, agreement });
      statuses.push([res.status, res.body.code ?? null]);
    }

    expect(statuses.slice(0, 6).map((s) => s[0])).toEqual([200, 200, 200, 200, 200, 200]);
    expect(statuses[6]).toEqual([429, 'rate_limited_box_chain']);
  });

  it('T18b: бюджет чтения исчерпан — 429 rate_limited_read (свой ключ, не чужой)', async () => {
    const agreement = freshAgreement();
    const arbWallet = ethers.Wallet.createRandom();
    const { pass, address: arb } = await issuePassFor(arbWallet);
    mockDeal({ agreement, client: '0x' + '11'.repeat(20), executor: '0x' + '22'.repeat(20), arbiter: arb });

    const statuses = [];
    for (let i = 0; i < 31; i++) {          // DISPUTE_BOX_READ_RATE_MAX = 30
      const res = await listBox({ pass, agreement });
      statuses.push([res.status, res.body.code ?? null]);
    }

    expect(statuses.slice(0, 30).every(([s]) => s === 200)).toBe(true);
    expect(statuses[30]).toEqual([429, 'rate_limited_read']);
    // Тридцать один запрос — по-прежнему ОДНО обращение к цепи.
    expect(chainReads).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Обстоятельства
// ═══════════════════════════════════════════════════════════════════════════

describe('обстоятельства числом', () => {
  it('T19: перезапуск — запись описи с deal/sealedFor переживает перечитывание с диска', async () => {
    // ⚠️ Это перечитывание описи ЖИВЫМ модулем, а не настоящий перезапуск
    // процесса (граница названа в test/bagStore.test.js:270). Настоящий
    // перезапуск заперт там же, отдельным тестом с новым импортом модуля.
    const agreement = freshAgreement();
    const arb = '0x' + '44'.repeat(20);
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO, arbiter: arb });

    const put = await putBox({ pass, agreement, body: Buffer.from('мешок'), sealedFor: arb });
    expect(put.status).toBe(200);

    _loadBagMeta();

    const meta = bagMetaOf(put.body.key);
    expect(meta.deal).toBe(agreement);
    expect(meta.sealedFor).toBe(arb);
    expect(listDisputeBags(agreement).map((b) => b.key)).toEqual([put.body.key]);
  });

  it('T19b: обрыв ПОСРЕДИ тела — ноль записей в описи, ноль обрезков на диске', async () => {
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO });

    await abortedPut({ agreement, pass, declaredLength: 200_000, actualBytes: 40_000 });

    expect(listDisputeBags(agreement)).toEqual([]);
    const dir = boxDir(agreement);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('T20: восемь запросов разом — восемь РАЗНЫХ ключей, восемь файлов, опись из восьми', async () => {
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO });

    // ⚠️ Восемь запросов разом стоят ОДНО обращение к цепи, а не восемь:
    // supertest успевает довести первый запрос до записи кэша фактов раньше,
    // чем начнётся второй (замерено зондом той же формы на этом дереве: три
    // прогона подряд — 1 обращение, восемь 200). Кэш одновременные промахи НЕ
    // дедуплицирует — просто в ЭТОЙ сцене их не возникает; так же честно
    // сказано в шаге 7, обстоятельство 3.
    //
    // Если в базовом прогоне вдруг придут 429 `rate_limited_box_chain` — это не
    // мигание, а другое расписание: восемь промахов не уместились в
    // DISPUTE_BOX_CHAIN_MAX (6 в этом файле). Лечение — подогреть кэш одним
    // listBox перед пачкой; тогда мутация 11 даёт ТРИ 429 вместо двух, и это
    // число надо поправить там же, а не подогнать.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => putBox({ pass, agreement, body: Buffer.from(`мешок ${i}`) })),
    );

    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    const keys = results.map((r) => r.body.key);
    expect(new Set(keys).size).toBe(8);
    expect(listDisputeBags(agreement)).toHaveLength(8);
    for (const key of keys) expect(fs.existsSync(bagPathFor(key))).toBe(true);
  });

  it('T24: долбят нарочно — больно ЕМУ, не стороне спора', async () => {
    const agreement = freshAgreement();
    const party    = ethers.Wallet.createRandom();
    const stranger = ethers.Wallet.createRandom();
    const { pass: partyPass, address } = await issuePassFor(party);
    const { pass: strangerPass } = await issuePassFor(stranger);
    mockDeal({ agreement, client: address, executor: ZERO, arbiter: '0x' + '44'.repeat(20) });

    const codes = [];
    for (let i = 0; i < 9; i++) {   // DISPUTE_BOX_WRITE_RATE_MAX = 8 в этом файле
      const res = await putBox({ pass: strangerPass, agreement, body: Buffer.from('мусор') });
      codes.push(res.body.code);
    }

    expect(codes).toEqual([...Array(8).fill('not_a_party'), 'rate_limited_write']);
    // Бюджет стороны цел — ключ бюджета свой, и ни один мусорный мешок не лёг.
    const mine = await putBox({ pass: partyPass, agreement, body: Buffer.from('предъявление') });
    expect(mine.status).toBe(200);
    expect(listDisputeBags(agreement)).toHaveLength(1);
    // Девять мусорных запросов стоили ОДНО обращение к цепи (кэш).
    expect(chainReads).toBe(1);
  });

  it('T25: заголовок с чужим адресом НЕ разряжает бюджет стороны (префикс ключа)', async () => {
    // Ключи /relay — сырая строка clientIp() БЕЗ префикса (app.js:1920), а
    // TRUST_PROXY=true берёт CF-Connecting-IP дословно, форму не проверяя.
    // Без префикса `box-write:` восемь таких запросов разрядили бы бюджет
    // записи жертвы, ни разу к ней не притронувшись.
    const agreement = freshAgreement();
    const victim = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(victim);
    mockDeal({ agreement, client: address, executor: ZERO });

    for (let i = 0; i < 8; i++) {
      await request(app).post('/relay').set('CF-Connecting-IP', address).send({});
    }

    const res = await putBox({ pass, agreement, body: Buffer.from('предъявление') });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ящик и чат — разные вещи
// ═══════════════════════════════════════════════════════════════════════════

describe('ящик спора не протекает в чат', () => {
  it('T22: мешок ящика не виден ни в sent, ни в peers у GET /bags', async () => {
    // Иначе адрес контракта сделки стал бы «собеседником», а собственное
    // предъявление приехало бы в разбор кадров и дало человеку беду о самом
    // себе.
    const agreement = freshAgreement();
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO, arbiter: '0x' + '44'.repeat(20) });

    const put = await putBox({ pass, agreement, body: Buffer.from('предъявление') });
    expect(put.status).toBe(200);

    const chat = await request(app).get('/bags')
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', pass);

    expect(chat.status).toBe(200);
    expect(chat.body.sent.map((b) => b.key)).not.toContain(put.body.key);
    expect(chat.body.inbox.map((b) => b.key)).not.toContain(put.body.key);
    expect(chat.body.peers.map((p) => p.address)).not.toContain(agreement);
  });

  it('T23: обычный чат-мешок (без deal) в опись ящика не попадает', async () => {
    const agreement = freshAgreement();
    const sender    = '0x' + '11'.repeat(20);
    // Запись СТАРОЙ формы: ни deal, ни sealedFor — так выглядят все записи,
    // сделанные до этой задачи.
    const key = bagKeyFor(agreement);
    const bytes = Buffer.from('кадр переписки');
    fs.mkdirSync(path.dirname(bagPathFor(key)), { recursive: true });
    fs.writeFileSync(bagPathFor(key), bytes);
    recordBag({ sender, recipient: agreement, key, size: bytes.length, uploadedAt: Date.now() });

    expect(bagMetaOf(key).deal).toBeUndefined();
    expect(listDisputeBags(agreement)).toEqual([]);

    // И читается он по-прежнему старым маршрутом — отправителем.
    _loadBagMeta();
    expect(bagMetaOf(key)).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ревью, круг 1 (Important) — находка 2: пропуск заперт на всех трёх маршрутах
// ═══════════════════════════════════════════════════════════════════════════
//
// До этого раунда ни один из 34 тестов не ходил на /disputes/* без
// x-bag-pass или с негодным, и ни одна из 22 мутаций не трогала
// requireBagPass — единственный замок аутентификации на этих маршрутах.
// Замер, доказавший дыру (до этого теста): подмени requireBagPass так,
// чтобы при отсутствии пропуска он не отвечал 401, а придумывал адрес, —
// ноль красных, потому что пропуск шлют все тесты без исключения. Не
// требует mockDeal(): пропуск проверяется РАНЬШЕ параметра :agreement и
// любого чтения цепи на всех трёх маршрутах (см. порядок в самих
// обработчиках).

describe('ревью круг 1 (Important) — находка 2: пропуск заперт на всех трёх маршрутах', () => {
  it('T29: без x-bag-pass — 401 pass_invalid на PUT, описи и мешке', async () => {
    const agreement = freshAgreement();

    const put = await request(app)
      .put(`/disputes/${agreement}/bags`)
      .set('CF-Connecting-IP', freshIp())
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('мешок'));
    expect(put.status).toBe(401);
    expect(put.body.code).toBe('pass_invalid');

    const list = await request(app)
      .get(`/disputes/${agreement}/bags`)
      .set('CF-Connecting-IP', freshIp());
    expect(list.status).toBe(401);
    expect(list.body.code).toBe('pass_invalid');

    // Имя мешка произвольное (ключ несуществующего мешка) — пропуск проверяется
    // раньше, чем сервер вообще посмотрит на :name, так что маршрут обязан
    // отказать 401 прежде, чем дойдёт до вопроса «есть ли такой мешок».
    const one = await request(app)
      .get(`/disputes/${agreement}/bags/0-00000000-0000-0000-0000-000000000000.bin`)
      .set('CF-Connecting-IP', freshIp());
    expect(one.status).toBe(401);
    expect(one.body.code).toBe('pass_invalid');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ревью, круг 1 (Important) — находка 1: режим недоверия опустошает ящик
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ ЭТОТ ТЕСТ ЗАВИСИТ ОТ ПОРЯДКА: он переводит модуль bagStore.js в режим
// недоверия (_bagMetaLoadOk = false) на весь остаток жизни процесса этого
// файла — восстановления не делает, потому что после него в этом файле
// больше ничего не выполняется. Держать ПОСЛЕДНИМ describe-блоком файла.
//
// План обосновывал общую опись (а не отдельное хранилище ящика) тем, что
// «метла сирот и режим недоверия достаются даром». Даром достаётся МЕТЛА, а
// не недоверие: запись, восстановленная _scanDiskBags() из одного лишь
// имени файла, несёт recipient/uploadedAt/size — и НИКОГДА deal/sealedFor,
// их неоткуда взять (bagKeyFor кодирует только получателя и время). Значит
// после потери индекса КАЖДЫЙ мешок ящика выпадает из listDisputeBags()
// НАВСЕГДА (до починки индекса руками) — условие meta.deal === addr не
// совпадёт ни разу — и арбитр видит пустой ящик, неотличимый от «сторона
// ничего не предъявляла»: ровно та беда §2.3 замысла, ради которой ящик
// заводился. Задача 7 обязана уметь сказать «опись перестраивалась,
// возможна потеря» (например, по isBagStoreHealthy() === false) — НЕ
// показывать пустой ящик как факт.
describe('ревью круг 1 (Important) — находка 1: режим недоверия опустошает ящик', () => {
  it('T30: после потери индекса и реконструкции с диска listDisputeBags(deal) пуст — измеренная потеря, не сюрприз', async () => {
    const agreement = freshAgreement();
    const arb = '0x' + '44'.repeat(20);
    const client = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(client);
    mockDeal({ agreement, client: address, executor: ZERO, arbiter: arb });

    const put = await putBox({ pass, agreement, body: Buffer.from('мешок'), sealedFor: arb });
    expect(put.status).toBe(200);
    expect(listDisputeBags(agreement)).toHaveLength(1);

    // Тот же приём, что test/bagStore.test.js использует для листалок
    // переписки («реконструированный мешок не числится ни за одним
    // отправителем»): снимок описи существует, но не разбирается как объект
    // (JSON.parse('null') === null) — а склад НЕ пуст (мешок только что
    // положен) — значит это не свежая установка, а потеря доверия.
    // BAG_META_PATH не экспортирован (умышленно, см. test/bagStore.test.js —
    // export let ловится vi.mock снимком); путь вычислен той же формулой,
    // что и в самом bagStore.js (STORAGE_DIR/bag-meta.json), а
    // process.env.STORAGE_DIR выставлен один раз для всего файла test/setup.js
    // и здесь не переопределялся ни разу.
    const metaPath = path.join(process.env.STORAGE_DIR, 'bag-meta.json');
    fs.writeFileSync(metaPath, 'null', 'utf8');
    _loadBagMeta();

    // Измерено, а не предположено. Реконструированная запись жива (в неё
    // попал бы старый маршрут по recipient), но ящика для неё больше нет.
    const meta = bagMetaOf(put.body.key);
    expect(meta).toBeDefined();
    expect(meta.deal).toBeUndefined();
    expect(meta.sender).toBe('');           // тот же провал, что у чат-мешков
    expect(listDisputeBags(agreement)).toEqual([]);

    // Ревью, круг 2 (решение координатора по следу этой же находки): признак
    // едет В ОТВЕТЕ маршрута, а не только комментарием в релеере — иначе
    // ничто не обязывает экран узнать об этом. Самое ценное здесь — именно
    // ЭТА ПАРА: bags пуст И indexTrusted === false ОДНОВРЕМЕННО, в одном
    // ответе. Порознь оба факта уже видны (T6 — cache-контроль на true,
    // bags выше — на []); вместе они и есть то, что отличает «сторона
    // молчала» от «опись перестраивалась» — ради чего заводился весь этот
    // признак. Пропуск клиента годится: клиент — сторона сделки, читает
    // СВОИ мешки (isParty), а не только арбитр.
    const list = await listBox({ pass, agreement });
    expect(list.status).toBe(200);
    expect(list.body.indexTrusted).toBe(false);
    expect(list.body.bags).toEqual([]);
  });
});
