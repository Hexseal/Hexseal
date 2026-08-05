import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';

// Свойство 1 (ревью): доказательство ЗАМЕРОМ на боевых умолчаниях, не на
// тестовых переопределениях. relayer/test/bagRoutes.test.js намеренно
// занижает BAG_PASS_RATE_MAX/BAG_READ_RATE_MAX/BAG_WRITE_RATE_MAX до 5 —
// удобно для быстрых тестов границы, но означает, что НИ ОДИН тест в этом
// файле не мог бы заметить, что настоящие боевые умолчания (30/120/60)
// вообще не участвуют, потому что перед всеми четырьмя маршрутами всё ещё
// стоял старый checkRateLimit(ip) с общим RATE_MAX=10, рассчитанным на
// мета-транзакции (/relay) — и он жёстче любого нового бюджета. Этот файл
// НИЧЕГО не переопределяет — читает ровно то, что прочитал бы боевой
// процесс без единой строки в .env про BAG_*_RATE_MAX.
const { app } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');

// Один живой человек — один IP на весь сценарий, как в реальности.
const LIVE_IP = '203.0.113.99';

async function signBagPassChallenge(wallet, address, ts) {
  return wallet.signMessage(bagPassChallenge(address, ts));
}

async function issuePass(wallet, address) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signBagPassChallenge(wallet, address, ts);
  const res = await request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', LIVE_IP)
    .set('x-ts', String(ts))
    .set('x-sig', sig)
    .send({ address });
  if (res.status !== 200) {
    throw new Error(`issuePass precondition failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.pass;
}

describe('живой разговор на боевых умолчаниях лимитера (свойство 1, ревью)', () => {
  it('пропуск + опрос списка раз в 1-2с в течение минуты + десяток отправок + десяток скачиваний — ни одного 429', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const counterpartyWallet = ethers.Wallet.createRandom();
    const counterpartyAddr = (await counterpartyWallet.getAddress()).toLowerCase();

    let total = 0;
    let blocked = 0;
    function record(res) {
      total++;
      if (res.status === 429) blocked++;
      return res;
    }

    // 1. Оба собеседника выпускают пропуск — с ОДНОГО IP (два устройства
    // за одним роутером/NAT — тоже "один живой IP" в смысле лимитера).
    // issuePass() сам делает запрос и бросает, если он не 200 — успешный
    // случай не нуждается в record(), а 429 здесь и так провалил бы тест
    // (500/401 — тем более, через явный throw внутри самого помощника).
    total += 2;
    const myPass = await issuePass(wallet, address);
    const counterpartyPass = await issuePass(counterpartyWallet, counterpartyAddr);

    // 2. Десяток отправок собеседнику.
    for (let i = 0; i < 10; i++) {
      const res = record(await request(app)
        .put(`/bags/${counterpartyAddr}`)
        .set('CF-Connecting-IP', LIVE_IP)
        .set('x-bag-pass', myPass)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(`message number ${i}`)));
      expect(res.status).toBe(200);
    }

    // 3. Опрос списка раз в 1-2 секунды в течение минуты — 40 опросов.
    // Огонь без реальных пауз — то же самое количество запросов в ТО ЖЕ
    // фиксированное окно лимитера (60с), что и растянутое по настоящему
    // времени; фиксированное окно не становится мягче, если растянуть
    // нагрузку — оно либо вмещает эти 40+10+10+2 запроса в 60-секундное
    // окно, либо нет, реальные секунды между вызовами тут не помогают.
    // Задача 1 (chat-client): GET /bags теперь отдаёт {inbox, sent, peers} —
    // здесь под наблюдением именно inbox (что собеседник реально получил).
    let lastInbox = [];
    for (let i = 0; i < 40; i++) {
      const res = record(await request(app)
        .get('/bags')
        .set('CF-Connecting-IP', LIVE_IP)
        .set('x-bag-pass', counterpartyPass));
      expect(res.status).not.toBe(429);
      if (res.status === 200) lastInbox = res.body.inbox;
    }

    // 4. Десяток скачиваний — собеседник читает то, что ему прислали.
    const keysToRead = lastInbox.slice(0, 10).map((b) => b.key);
    expect(keysToRead.length).toBeGreaterThan(0);
    for (const key of keysToRead) {
      const res = record(await request(app)
        .get(`/bags/${key}`)
        .set('CF-Connecting-IP', LIVE_IP)
        .set('x-bag-pass', counterpartyPass));
      expect(res.status).not.toBe(429);
    }

    // 5. Находка ревью: сценарий до этой строки просит РОВНО один пропуск
    // на КАЖДЫЙ из двух разных адресов — снижение потолка выпуска пропуска
    // с 30 до 1 осталось бы незамеченным (у каждого адреса и так только
    // одна попытка). Второй пропуск для ТОГО ЖЕ адреса — реалистичный
    // повод (вкладка перезагрузилась, кэш пропуска потерян, посреди того
    // же разговора нужен новый) — делает замер чувствительным к самому
    // бюджету выпуска, а не только к тому, что выпуск вообще возможен.
    const myTs2 = Math.floor(Date.now() / 1000);
    const mySig2 = await signBagPassChallenge(wallet, address, myTs2);
    const secondPassRes = record(await request(app)
      .post('/bags/pass')
      .set('CF-Connecting-IP', LIVE_IP)
      .set('x-ts', String(myTs2))
      .set('x-sig', mySig2)
      .send({ address }));
    expect(secondPassRes.status).toBe(200);

    // eslint-disable-next-line no-console
    console.log(`[свойство 1] боевые умолчания: всего запросов = ${total}, заблокировано 429 = ${blocked}`);
    expect(blocked).toBe(0);
  });
});
