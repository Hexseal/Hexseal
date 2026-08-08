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
const { bagKeyFor, recordBag, DIR_BAGS, _loadBagMeta, bagMetaOf } = bagStoreNs;

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

  // Находка ревью (координатор, мутационное тестирование): «присутствие
  // собеседника = Date.now()» (взять текущий момент запроса вместо
  // настоящей улики) выживала на всех тестах выше — округление до минуты
  // (тест ниже) на живом Date.now() почти всегда даёт то же самое, что и
  // честное значение, если проверять сразу после события. Здесь момент
  // события — заведомо ДАЛЁКОЕ прошлое (два часа назад), вставленное прямо
  // в склад в обход HTTP (PUT/GET сами штампуют Date.now(), другого способа
  // получить заведомо НЕ "сейчас" время нет) — если бы lastActivityWithMeAt брался из
  // текущего момента запроса, а не из настоящей метки события, разница была
  // бы кратна секундам, не часам.
  it('lastActivityWithMeAt — настоящий момент события (firstFetchedAt), а не момент запроса — мутация "presence = Date.now()" красит именно этот тест', async () => {
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const key = bagKeyFor(bobAddr);
    fs.mkdirSync(path.dirname(path.join(DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(DIR_BAGS, key), 'sealed');
    recordBag({
      sender: aliceAddr, recipient: bobAddr, key, size: 6,
      uploadedAt: twoHoursAgo, firstFetchedAt: twoHoursAgo,
    });

    const res = await getBags({ pass: alicePass });
    const bobPeer = res.body.peers.find((p) => p.address === bobAddr);
    expect(bobPeer).toBeDefined();
    expect(bobPeer.lastActivityWithMeAt).toBe(Math.floor(twoHoursAgo / 60000) * 60000);
    // Явный замок против "сейчас": момент запроса (Date.now() в эту самую
    // секунду) заведомо намного позже twoHoursAgo — при "presence = Date.now()"
    // разница была бы меньше минуты, а не больше часа.
    expect(Date.now() - bobPeer.lastActivityWithMeAt).toBeGreaterThan(60 * 60 * 1000);
  });

  // Находка ревью (координатор, мутационное тестирование): «входящий мешок
  // вообще не признак присутствия» — то есть удаление ветки, которая берёт
  // uploadedAt чужого ВХОДЯЩЕГО мешка как доказательство присутствия
  // отправителя, — тоже выживала на всех тестах выше. Все прежние тесты на
  // lastActivityWithMeAt так или иначе включали ЗАБОР (fetch) стороной, чьё присутствие
  // проверяется, — эта ветка (просто написал, ничего не забирал) не была
  // затронута НИ РАЗУ.
  it('входящий мешок (собеседник написал МНЕ, ничего не забирал) тоже доказывает присутствие — мутация "считать только своё исходящее" красит именно этот тест', async () => {
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);
    const bobPass = await issuePassFor(bob);

    // Только Боб пишет Алисе — Алиса Бобу ничего не отправляла и ничего не
    // забирала, единственная улика присутствия Боба — то, что он сам
    // написал (uploadedAt его исходящего, он же для Алисы — входящего).
    const bobToAlice = await putBag({ pass: bobPass, recipient: aliceAddr, body: Buffer.from('hi') });
    expect(bobToAlice.status).toBe(200);

    const res = await getBags({ pass: alicePass });
    const bobPeer = res.body.peers.find((p) => p.address === bobAddr);
    expect(bobPeer).toBeDefined();
    expect(bobPeer.lastActivityWithMeAt).not.toBeNull(); // сам факт написанного мешка — доказательство присутствия
    expect(bobPeer.lastActivityWithMeAt).toBe(Math.floor(bagMetaOf(bobToAlice.body.key).uploadedAt / 60000) * 60000);
  });

  // Живой замер (не строгая проверка направления округления — та ниже,
  // отдельным тестом): реальный забор через настоящий HTTP-путь всё ещё
  // обязан дать кратную минуте, недалёкую от настоящего момента метку.
  it('lastActivityWithMeAt (живой забор) кратен минуте и не дальше минуты от настоящего момента', async () => {
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
    expect(bobPeer.lastActivityWithMeAt).not.toBeNull();
    expect(bobPeer.lastActivityWithMeAt % 60000).toBe(0);

    const realFetchedAt = bagMetaOf(put1.body.key).firstFetchedAt;
    expect(Math.abs(realFetchedAt - bobPeer.lastActivityWithMeAt)).toBeLessThan(60000);
  });

  // Находка ревью (координатор): версия ВЫШЕ проверяла "не дальше минуты",
  // а не саму сторону округления — на Date.now() это совпадает с floor()
  // ТОЛЬКО когда тест выполняется в первые ~30 секунд минуты (round() вниз
  // при секундах <30, вверх — при >=30). Мутация floor -> round выживала
  // или ловилась в зависимости от того, В КАКУЮ СЕКУНДУ ПРОШЁЛ ПРОГОН —
  // измерено вживую: 8 запусков подряд с интервалом 6с дали 5 красных, 3
  // зелёных, ровно по границе секунды 30. Тест, красящийся от времени
  // суток, хуже отсутствующего — здесь фиксированное время (recordBag()
  // напрямую, в обход HTTP), секунды заведомо ЗА границей округления,
  // независимо от того, когда реально выполняется прогон.
  it('lastActivityWithMeAt округляется ВНИЗ до минуты, не к ближайшей — фиксированное время, не Date.now() (мутация Math.floor → Math.round красит именно этот тест)', async () => {
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);

    // 12:30:45 — заведомо за границей .5 минуты: Math.round дал бы 12:31:00
    // (следующую минуту), Math.floor — 12:30:00 (эту же). В прошлом
    // относительно "сегодня" любого разумного прогона (assertNotFromFuture).
    const fixedMoment = Date.UTC(2026, 0, 1, 12, 30, 45);
    const expectedFloor = Date.UTC(2026, 0, 1, 12, 30, 0);
    const wrongRound = Date.UTC(2026, 0, 1, 12, 31, 0);

    const key = bagKeyFor(bobAddr);
    fs.mkdirSync(path.dirname(path.join(DIR_BAGS, key)), { recursive: true });
    fs.writeFileSync(path.join(DIR_BAGS, key), 'sealed');
    recordBag({
      sender: aliceAddr, recipient: bobAddr, key, size: 6,
      uploadedAt: fixedMoment, firstFetchedAt: fixedMoment,
    });

    const res = await getBags({ pass: alicePass });
    const bobPeer = res.body.peers.find((p) => p.address === bobAddr);
    expect(bobPeer).toBeDefined();
    expect(bobPeer.lastActivityWithMeAt).toBe(expectedFloor);
    expect(bobPeer.lastActivityWithMeAt).not.toBe(wrongRound);
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

  // Находка ревью (координатор): `since` фильтровал только inbox — sent
  // ехал целиком на КАЖДОМ тике, включая те, где ничего нового нет.
  // Замерено честно (JSON.stringify реальной формы записи, ~207 байт на
  // элемент): ~243КБ у адреса с 1 200 СОБСТВЕННЫХ отправленных, ~12,16МБ
  // у адреса с 60 000 — каждые пять секунд, каждому пользователю.
  it('?since применяется и к sent — старый, без изменений, отправленный мешок не пересылается заново', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);

    const put1 = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('old') });
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = bagMetaOf(put1.body.key).uploadedAt + 1; // строго ПОСЛЕ загрузки, ничего не изменилось с тех пор

    const res = await getBags({ pass: alicePass, since: cutoff });
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([]);
  });

  // Если фильтровать sent ТОЛЬКО по uploadedAt (зеркалом inbox буквально),
  // мешок, отправленный ДО cutoff, но забранный ПОСЛЕ него, навсегда
  // выпадает из ответа — отправитель никогда не узнал бы о galочке,
  // появившейся уже после того, как мешок стал "старым" по её собственным
  // часам. since обязан учитывать ОБА события: новый мешок (uploadedAt) И
  // изменившийся fetched (firstFetchedAt).
  it('?since не прячет sent-мешок, у которого изменился fetched (галочка), даже если сам мешок старше cutoff', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);
    const bobPass = await issuePassFor(bob);

    const put1 = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('old') });
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = bagMetaOf(put1.body.key).uploadedAt + 1; // мешок теперь строго СТАРШЕ cutoff
    await new Promise((r) => setTimeout(r, 5));

    // Забор — уже ПОСЛЕ cutoff: свежая, ещё не увиденная клиентом информация.
    const download = await getBag({ pass: bobPass, key: put1.body.key });
    expect(download.status).toBe(200);

    const res = await getBags({ pass: alicePass, since: cutoff });
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([
      { key: put1.body.key, recipient: bobAddr, uploadedAt: expect.any(Number), fetched: true },
    ]);
  });

  // Находка ревью (координатор): peers обязан отражать ВСЮ историю, не
  // окно since — мутация "считать peers из отфильтрованных по since
  // списков" выживала на 608 зелёных. Следствие: на каждом обычном "тихом"
  // тике (ничего нового ни во входящих, ни в исходящих) собеседник исчезал
  // бы из peers вместе со статусом присутствия — а он не должен, since
  // касается только "что нового показать", не "с кем вообще есть переписка".
  it('peers отражает всю историю, а не окно ?since — на тихом тике собеседник и его lastActivityWithMeAt не пропадают', async () => {
    const { wallet: alice } = await newWalletAndAddress();
    const { wallet: bob, address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);
    const bobPass = await issuePassFor(bob);

    const put1 = await putBag({ pass: alicePass, recipient: bobAddr, body: Buffer.from('hi') });
    const download = await getBag({ pass: bobPass, key: put1.body.key });
    expect(download.status).toBe(200);

    // Курсор строго ПОСЛЕ всех событий выше — типичный "тихий" тик опроса,
    // где во входящих/исходящих действительно ничего нового.
    const since = Date.now() + 1000;

    const res = await getBags({ pass: alicePass, since });
    expect(res.status).toBe(200);
    expect(res.body.inbox).toEqual([]); // тихий тик — ожидаемо пусто
    expect(res.body.sent).toEqual([]);  // тихий тик — ожидаемо пусто (правка 4)
    // НО peers/статус остаются — since не должен их касаться вовсе.
    expect(res.body.peers).toEqual([
      { address: bobAddr, lastActivityWithMeAt: expect.any(Number) },
    ]);
    expect(res.body.peers[0].lastActivityWithMeAt).not.toBeNull();
  });

  // Находка ревью (координатор): нестрогое сравнение на sent не заперто —
  // зеркало уже купленной находки И-3 (bagRoutes.test.js) для inbox, там же
  // причина в докстринге: два события в ОДНУ и ту же миллисекунду — не
  // теоретический случай, а измеренная координатором гонка. `>` вместо `>=`
  // навсегда прячет от отправителя мешок, чьё время СОВПАДАЕТ с курсором
  // клиента.
  it('?since на sent нестрогое — мешок с uploadedAt РОВНО равным cutoff не теряется (зеркало И-3 для отправленных)', async () => {
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);

    const sameMs = Date.now();
    const key1 = bagKeyFor(bobAddr);
    const key2 = bagKeyFor(bobAddr);
    fs.mkdirSync(path.join(DIR_BAGS, bobAddr), { recursive: true });
    fs.writeFileSync(path.join(DIR_BAGS, key1), Buffer.from('one'));
    fs.writeFileSync(path.join(DIR_BAGS, key2), Buffer.from('two'));
    recordBag({ sender: aliceAddr, recipient: bobAddr, key: key1, size: 3, uploadedAt: sameMs });
    recordBag({ sender: aliceAddr, recipient: bobAddr, key: key2, size: 3, uploadedAt: sameMs });

    const res = await getBags({ pass: alicePass, since: sameMs });
    expect(res.status).toBe(200);
    expect(res.body.sent.map((b) => b.key)).toEqual(expect.arrayContaining([key1, key2]));
  });

  // Тот же класс нестрогости, но по ВТОРОМУ событию (firstFetchedAt) —
  // галочка, появившаяся РОВНО в момент cutoff, не должна теряться так же,
  // как и новый мешок с uploadedAt ровно на cutoff выше.
  it('?since на sent нестрогое и по firstFetchedAt — галочка, появившаяся РОВНО в момент cutoff, не теряется', async () => {
    const { wallet: alice, address: aliceAddr } = await newWalletAndAddress();
    const { address: bobAddr } = await newWalletAndAddress();
    const alicePass = await issuePassFor(alice);

    const sameMs = Date.now();
    const key = bagKeyFor(bobAddr);
    fs.mkdirSync(path.join(DIR_BAGS, bobAddr), { recursive: true });
    fs.writeFileSync(path.join(DIR_BAGS, key), Buffer.from('old'));
    recordBag({
      sender: aliceAddr, recipient: bobAddr, key, size: 3,
      uploadedAt: sameMs - 60000, firstFetchedAt: sameMs,
    });

    const res = await getBags({ pass: alicePass, since: sameMs });
    expect(res.status).toBe(200);
    expect(res.body.sent.map((b) => b.key)).toContain(key);
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
