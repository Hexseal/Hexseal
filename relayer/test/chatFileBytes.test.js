/**
 * Находки сквозной проверки по файлам чата. Обе меряются В БАЙТАХ — прежний
 * тест сверял только числа между собой (константу сервера с константой
 * фронта), а такая сверка зелена и тогда, когда до байтов правило не доходит.
 *
 * 1. ПОТОЛОК НЕ ДЕЙСТВУЕТ НА МНОГОКУСОЧНОЙ ДОРОГЕ. Замерено: 250 МБ в одном
 *    файле на боевых умолчаниях при потолке 200 МБ. У кусков свой предел
 *    (50 МБ), а сложения не делал никто.
 *
 *    ⚠️ Тяжесть НИЖЕ, чем кажется, и это проверено, а не предположено:
 *    законная одиночная дорога пропускает ВДВОЕ больше байт в минуту, чем
 *    эта дыра, и запас диска её держит. Вред здесь один — обещание не
 *    исполняется. Поэтому и починка скромная: сумма при сборке.
 *
 * 2. ДВА КРУПНЫХ ВЛОЖЕНИЯ В МИНУТУ — ВТОРОЕ УМИРАЕТ НА СЕРЕДИНЕ. Обычный
 *    случай, не нападение: 200 МБ кусками по 8 МБ — это 27 запросов, а
 *    бюджет адреса был 40 в минуту на ВСЁ.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

const { app, MAX_CHAT_FILE_SIZE, relayerInfo } = await import('../app.js');
const { issueBagPass } = await import('../bagPass.js');

let _addr = 0;
const freshPass = () => issueBagPass('0x' + String(++_addr).padStart(40, '5')).token;

let _ip = 0;
const freshIp = () => { _ip++; return `10.20.${(_ip >> 8) & 255}.${_ip & 255}`; };

/** Каталог временных кусков — тот же, что видит маршрут. */
const dirTemp = () => relayerInfo.dirTemp ?? path.join(process.env.STORAGE_DIR, 'temp');

describe('Потолок файла держится и на многокусочной дороге — замер В БАЙТАХ', () => {
  it('ЗАМЕР: сумма кусков выше потолка — сборка отказывает, файла на диске НЕТ', async () => {
    const pass = freshPass();
    const ip   = freshIp();

    const create = await request(app).post('/files/multipart/create')
      .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
      .send({ chunkCount: 5 });
    expect(create.status).toBe(200);
    const { uploadId, key } = create.body;

    // Куски кладём НАСТОЯЩИМИ файлами нужного размера (разрежённая запись —
    // мгновенна на ext4 и не занимает места), потому что мерить надо байты, а
    // не намерения. Через сеть 250 МБ гонять незачем: маршрут сборки читает
    // то, что лежит на диске.
    const partBytes = Math.ceil((MAX_CHAT_FILE_SIZE * 1.25) / 5);
    for (let i = 1; i <= 5; i++) {
      const fp = path.join(dirTemp(), uploadId, String(i).padStart(6, '0'));
      const fd = fs.openSync(fp, 'w');
      fs.ftruncateSync(fd, partBytes);
      fs.closeSync(fd);
    }
    const totalBytes = partBytes * 5;

    const complete = await request(app).post('/files/multipart/complete')
      .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
      .send({ uploadId, key });

    console.log(
      `[замер] потолок ${(MAX_CHAT_FILE_SIZE / 1024 / 1024).toFixed(0)} МБ, ` +
      `предъявлено ${(totalBytes / 1024 / 1024).toFixed(0)} МБ → ${complete.status}`,
    );

    expect(complete.status).toBe(413);
    expect(complete.body.code).toBe('payload_too_large');
    // Главное — не код ответа, а байты: собранного файла быть не должно.
    expect(fs.existsSync(path.join(relayerInfo.dirFiles, key))).toBe(false);
    // И обрезки не остаются лежать.
    expect(fs.existsSync(path.join(dirTemp(), uploadId))).toBe(false);
  });

  it('ЗАМЕР: сумма кусков в пределах потолка — собирается, байты на месте', async () => {
    const pass = freshPass();
    const ip   = freshIp();

    const create = await request(app).post('/files/multipart/create')
      .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
      .send({ chunkCount: 2 });
    const { uploadId, key } = create.body;

    for (const [n, text] of [[1, 'hello-'], [2, 'world']]) {
      const res = await request(app).put(`/files/part/${uploadId}/${n}`)
        .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(text));
      expect(res.status).toBe(200);
    }

    const complete = await request(app).post('/files/multipart/complete')
      .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
      .send({ uploadId, key });
    expect(complete.status).toBe(200);

    const onDisk = fs.readFileSync(path.join(relayerInfo.dirFiles, key));
    expect(onDisk.toString('utf8')).toBe('hello-world');
    expect(onDisk.length).toBe(11);
  });

  it('ЗАМЕР: один кусок больше ПОЛНОГО потолка отбивается сразу, не на сборке', async () => {
    const pass = freshPass();
    const ip   = freshIp();

    const create = await request(app).post('/files/multipart/create')
      .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
      .send({ chunkCount: 1 });
    const { uploadId } = create.body;

    // Предел куска был 50 МБ — меньше потолка файла, поэтому этот кейс
    // проверяет не «50 МБ», а «кусок не может превысить файл целиком».
    // Гоняем не 200 МБ по сети, а ровно столько, чтобы перешагнуть меньший
    // из двух пределов и увидеть 413.
    const oversize = Buffer.alloc(Math.min(MAX_CHAT_FILE_SIZE, 50 * 1024 * 1024) + 64 * 1024, 7);
    const res = await request(app).put(`/files/part/${uploadId}/1`)
      .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
      .set('Content-Type', 'application/octet-stream')
      .send(oversize);

    expect(res.status).toBe(413);
    const fp = path.join(dirTemp(), uploadId, '000001');
    expect(fs.existsSync(fp)).toBe(false);
  });
});

describe('Два крупных вложения в минуту доезжают оба — замер по запросам', () => {
  it('ЗАМЕР: 2 × (создание + 25 кусков + сборка) на боевых умолчаниях — ноль отказов', async () => {
    // 200 МБ кусками по 8 МБ — это 25 кусков. Байты здесь неважны (их держит
    // потолок выше), важно ЧИСЛО ЗАПРОСОВ против бюджета адреса: именно оно
    // убивало второе вложение на середине.
    const pass = freshPass();
    const ip   = freshIp();
    const statuses = [];

    for (let round = 0; round < 2; round++) {
      const create = await request(app).post('/files/multipart/create')
        .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
        .send({ chunkCount: 25 });
      statuses.push(create.status);
      if (create.status !== 200) continue;
      const { uploadId, key } = create.body;

      for (let i = 1; i <= 25; i++) {
        const res = await request(app).put(`/files/part/${uploadId}/${i}`)
          .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from('x'));
        statuses.push(res.status);
      }

      const complete = await request(app).post('/files/multipart/complete')
        .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
        .send({ uploadId, key });
      statuses.push(complete.status);
    }

    const refused = statuses.filter(s => s === 429).length;
    console.log(`[замер] два вложения по 200 МБ (${statuses.length} запросов): отказов ${refused}`);
    expect(refused).toBe(0);
    expect(statuses.every(s => s === 200)).toBe(true);
  });

  it('заливка кусков всё же не безгранична — свой бюджет, отдельный от выдач', async () => {
    const pass = freshPass();
    const ip   = freshIp();

    // Выдачи (создание сеанса) остаются скупыми: у них свой бюджет, и куски
    // его не тратят — иначе правка выше просто сняла бы ограничитель.
    const created = [];
    for (let i = 0; i < 45; i++) {
      created.push((await request(app).post('/files/multipart/create')
        .set('CF-Connecting-IP', ip).set('x-bag-pass', pass)
        .send({ chunkCount: 1 })).status);
    }
    expect(created.filter(s => s === 429).length).toBeGreaterThan(0);
  });
});
