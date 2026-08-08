/**
 * bagOwnHalf.test.js — К-1: своя половина переписки достижима владельцу
 * пропуска.
 *
 * ЧТО БЫЛО СЛОМАНО. Мешок лежит в каталоге ПОЛУЧАТЕЛЯ, и выдача проверяла
 * ровно `meta.recipient === address`. Значит собственных отправленных
 * сообщений человек не мог забрать НИКОГДА — ни после перезагрузки вкладки,
 * ни на новом устройстве. Конверт при этом запечатан ДВУМЯ слотами (второй —
 * на себя, ровно ради собственного архива, Задача 3): слот есть, достать
 * нечем. Обещание общей спеки §4 «потеря устройства перестаёт быть потерей
 * истории» было сломано наполовину, причём терялась половина не при потере
 * устройства, а при обычной перезагрузке.
 *
 * ЧТО СТАЛО. Читать мешок вправе тот, кто в нём назван — получатель ИЛИ
 * отправитель. Оба поля берутся из ОПИСИ, а опись пишет сервер: отправителя
 * он берёт из пропуска на `PUT`, а не из тела (заперто ниже отдельно —
 * иначе B пометил бы мешок «от A» и подсунул его в список A).
 *
 * ⚠️ ГЛАВНОЕ, ЧТО ЛЕГКО СЛОМАТЬ ЗАОДНО: галочка «дошло». Она поднимается на
 * первом скачивании мешка. Если скачивание ОТПРАВИТЕЛЕМ тоже её поднимает,
 * то человек, открывший свою же переписку, сам себе зажигает «доставлено» —
 * галочка начинает врать, и врать в ту сторону, которую невозможно заметить.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { ethers } from 'ethers';

let app;
let bagStore;
let bagPassChallenge;

/** Свой IP на каждый запрос — лимитер склада ключуется по IP, и соседние
 *  тесты не должны делить с этим файлом одно ведро (тот же приём, что
 *  test/bagRoutes.test.js). */
let _ip = 0;
function freshIp() {
  _ip++;
  return `10.77.${(_ip >> 8) & 255}.${_ip & 255}`;
}

const WALLET_A = ethers.Wallet.createRandom();
const WALLET_B = ethers.Wallet.createRandom();
const WALLET_C = ethers.Wallet.createRandom();

/** Пропуск склада для кошелька — тем же путём, что и настоящий клиент. */
async function passFor(wallet) {
  const address = wallet.address.toLowerCase();
  const ts = Math.floor(Date.now() / 1000);
  const sig = await wallet.signMessage(bagPassChallenge(address, ts));
  const res = await request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', freshIp())
    .set('x-ts', String(ts))
    .set('x-sig', sig)
    .send({ address });
  expect(res.status).toBe(200);
  return res.body.pass;
}

/** Кладёт мешок от `fromPass` для `toWallet`, возвращает его ключ. */
async function putBag(fromPass, toWallet, bytes, extraBody = {}) {
  const res = await request(app)
    .put(`/bags/${toWallet.address.toLowerCase()}`)
    .set('CF-Connecting-IP', freshIp())
    .set('x-bag-pass', fromPass)
    .set('content-type', 'application/octet-stream')
    .query(extraBody)
    .send(Buffer.from(bytes));
  expect(res.status).toBe(200);
  return res.body.key;
}

beforeAll(async () => {
  ({ app } = await import('../app.js'));
  bagStore = await import('../bagStore.js');
  ({ bagPassChallenge } = await import('../bagPass.js'));
});

describe('К-1: отправитель достаёт собственный мешок', () => {
  it('отправитель скачивает свой мешок и получает ТЕ ЖЕ байты', async () => {
    const passA = await passFor(WALLET_A);
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const key = await putBag(passA, WALLET_B, body);

    const got = await request(app).get(`/bags/${key}`).set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA);
    expect(got.status).toBe(200);
    expect(new Uint8Array(got.body)).toEqual(body);
  });

  it('получатель по-прежнему скачивает — правило не подменено, а расширено', async () => {
    const passA = await passFor(WALLET_A);
    const passB = await passFor(WALLET_B);
    const key = await putBag(passA, WALLET_B, new Uint8Array([9, 9, 9]));

    const got = await request(app).get(`/bags/${key}`).set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passB);
    expect(got.status).toBe(200);
    expect(new Uint8Array(got.body)).toEqual(new Uint8Array([9, 9, 9]));
  });

  it('ПОСТОРОННИЙ не скачивает — ни как отправитель, ни как получатель', async () => {
    const passA = await passFor(WALLET_A);
    const passC = await passFor(WALLET_C);
    const key = await putBag(passA, WALLET_B, new Uint8Array([7, 7]));

    const got = await request(app).get(`/bags/${key}`).set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passC);
    expect(got.status).toBe(404);
    expect(got.body.code).toBe('bag_not_found');
  });

  it('БЕЗ ПРОПУСКА не скачивает никто — ключевое свойство плана 2 цело', async () => {
    const passA = await passFor(WALLET_A);
    const key = await putBag(passA, WALLET_B, new Uint8Array([5]));

    const noPass = await request(app).get(`/bags/${key}`);
    expect(noPass.status).toBe(401);

    const junkPass = await request(app).get(`/bags/${key}`).set('CF-Connecting-IP', freshIp()).set('x-bag-pass', 'v1.definitely-not-a-pass');
    expect(junkPass.status).toBe(401);
  });

  it('свой мешок виден в списке — иначе клиенту неоткуда взять ключ', async () => {
    const passA = await passFor(WALLET_A);
    const key = await putBag(passA, WALLET_B, new Uint8Array([4, 2]));

    const list = await request(app).get('/bags').set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA);
    expect(list.status).toBe(200);
    expect(list.body.inbox.map(b => b.key)).toContain(key);
    // …и он по-прежнему числится своим отправленным, с галочкой доставки.
    expect(list.body.sent.map(b => b.key)).toContain(key);
  });

  it('в `peers` СЕБЯ не появляется — список собеседников не должен обзавестись владельцем', async () => {
    const passA = await passFor(WALLET_A);
    await putBag(passA, WALLET_B, new Uint8Array([1]));

    const list = await request(app).get('/bags').set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA);
    const addrs = list.body.peers.map(p => p.address.toLowerCase());
    expect(addrs).not.toContain(WALLET_A.address.toLowerCase());
    expect(addrs).toContain(WALLET_B.address.toLowerCase());
  });
});

describe('К-1, замок 1: отправитель берётся из пропуска, а не с чужих слов', () => {
  it('B не может выдать свой мешок за «от A» — ни телом, ни строкой запроса', async () => {
    const passB = await passFor(WALLET_B);
    // Пытаемся подставить отправителя всеми путями, какие вообще есть у
    // клиента: строка запроса и заголовок. Тело — сырые байты мешка, туда
    // поле не воткнуть.
    const res = await request(app)
      .put(`/bags/${WALLET_C.address.toLowerCase()}`)
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', passB)
      .set('content-type', 'application/octet-stream')
      .set('x-sender', WALLET_A.address)
      .query({ sender: WALLET_A.address, from: WALLET_A.address })
      .send(Buffer.from([1, 1, 1]));
    expect(res.status).toBe(200);

    const meta = bagStore.bagMetaOf(res.body.key);
    expect(meta.sender).toBe(WALLET_B.address.toLowerCase());
    expect(meta.sender).not.toBe(WALLET_A.address.toLowerCase());

    // И у A такого мешка нет ни в списке, ни на скачивании.
    const passA = await passFor(WALLET_A);
    const list = await request(app).get('/bags').set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA);
    expect(list.body.inbox.map(b => b.key)).not.toContain(res.body.key);
    const got = await request(app).get(`/bags/${res.body.key}`).set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA);
    expect(got.status).toBe(404);
  });
});

describe('К-1, замок 2: галочка «дошло» не зажигается от собственного чтения', () => {
  it('ЗАМЕР: отправитель скачал свой мешок — fetched по-прежнему false', async () => {
    const passA = await passFor(WALLET_A);
    const key = await putBag(passA, WALLET_B, new Uint8Array([3, 3, 3]));

    const before = await request(app).get('/bags').set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA);
    expect(before.body.sent.find(b => b.key === key).fetched).toBe(false);

    const got = await request(app).get(`/bags/${key}`).set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA);
    expect(got.status).toBe(200);

    const after = await request(app).get('/bags').set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA);
    expect(after.body.sent.find(b => b.key === key).fetched).toBe(false);
    // Отметка времени первого чтения тоже не поставлена — иначе поехал бы
    // срок жизни мешка (7 дней «прочитан» вместо 30 «не прочитан»).
    // `null`, а не число: опись хранит «ещё не читан» явным null.
    expect(bagStore.bagMetaOf(key).firstFetchedAt ?? null).toBeNull();
  });

  it('а получатель — зажигает, и ровно один раз', async () => {
    const passA = await passFor(WALLET_A);
    const passB = await passFor(WALLET_B);
    const key = await putBag(passA, WALLET_B, new Uint8Array([8, 8]));

    await request(app).get(`/bags/${key}`).set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA); // своё чтение — не в счёт
    await request(app).get(`/bags/${key}`).set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passB); // чужое — в счёт
    const first = bagStore.bagMetaOf(key).firstFetchedAt;
    expect(typeof first).toBe('number');

    await new Promise(r => setTimeout(r, 5));
    await request(app).get(`/bags/${key}`).set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passB);
    expect(bagStore.bagMetaOf(key).firstFetchedAt).toBe(first);

    const after = await request(app).get('/bags').set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA);
    expect(after.body.sent.find(b => b.key === key).fetched).toBe(true);
  });
});

describe('К-1, замок 3: срок жизни и уборка считают мешок ОДИН раз', () => {
  it('мешок один: файл один, запись в описи одна, копий не появилось', async () => {
    const passA = await passFor(WALLET_A);
    const key = await putBag(passA, WALLET_B, new Uint8Array([6, 6, 6]));

    // Опись: ровно одна запись с этим ключом.
    const forB = bagStore.listBagsFor(WALLET_B.address.toLowerCase()).filter(b => b.key === key);
    const fromA = bagStore.listBagsBySender(WALLET_A.address.toLowerCase()).filter(b => b.key === key);
    expect(forB).toHaveLength(1);
    expect(fromA).toHaveLength(1);
    // Это ОДНА И ТА ЖЕ запись, а не две копии: тот же ключ, тот же путь.
    expect(fromA[0].uploadedAt).toBe(forB[0].uploadedAt);
    expect(bagStore.bagPathFor(key)).toBe(bagStore.bagPathFor(key));

    // Срок считается один раз и не зависит от того, с чьей стороны смотреть.
    const meta = bagStore.bagMetaOf(key);
    expect(bagStore.bagExpiryAt(meta)).toBe(bagStore.bagExpiryAt(meta));
  });

  it('список владельца не задваивает мешок, где он и отправитель, и получатель', async () => {
    // Переписка с самим собой — единственный случай, где адрес стоит в обоих
    // полях. Без дедупликации по ключу такой мешок приехал бы в списке
    // дважды и дал бы `duplicate_seq` на разборе.
    const passA = await passFor(WALLET_A);
    const key = await putBag(passA, WALLET_A, new Uint8Array([1, 2]));

    const list = await request(app).get('/bags').set('CF-Connecting-IP', freshIp()).set('x-bag-pass', passA);
    const hits = list.body.inbox.filter(b => b.key === key);
    expect(hits).toHaveLength(1);
  });
});
