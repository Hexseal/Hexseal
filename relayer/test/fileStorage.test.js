import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { issueBagPass } from '../bagPass.js';
import { jsonBody } from './helpers/httpBody.js';

// К-4: чат-семья файловых маршрутов (`/files/presign`, `/files/upload-put`,
// вся многокусочная дорога, `/files/refresh-url`) живёт за тем же пропуском,
// что и мешки. Публичная семья (`/files/public/*` — профили и аватары) — НЕТ:
// её зовёт серверный маршрут фронта, у которого кошелька нет. Разница между
// этими двумя семьями и есть предмет половины тестов ниже.
//
// Свежий адрес на каждый вызов: у чат-файлов свой бюджет (CHAT_FILE_RATE_MAX),
// и общий адрес на весь файл означал бы, что поздние кейсы падают от
// исчерпания, устроенного ранними.
let _addr = 0;
const chatPass = () => issueBagPass('0x' + String(++_addr).padStart(40, '7')).token;

/** `request(app).post(url)` с пропуском чат-файлов. */
function withPass(req, pass = chatPass()) {
  return req.set('x-bag-pass', pass);
}

describe('POST /files/presign', () => {
  it('returns an upload/download URL pair with a 7-day expiry', async () => {
    const res = await withPass(request(app).post('/files/presign')).send({});
    expect(res.status).toBe(200);
    const body = jsonBody(res);
    expect(body).toHaveProperty('uploadUrl');
    expect(body).toHaveProperty('downloadUrl');
    expect(body).toHaveProperty('key');
    expect(body.expiresIn).toBe('7 days');
  });

  it('accepts an optional peerB without erroring (peerA now comes from the pass — К-4)', async () => {
    const res = await withPass(request(app).post('/files/presign')).send({
      peerB: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    });
    expect(res.status).toBe(200);
  });

  it('silently ignores a malformed peerB (best-effort tagging, never blocks upload)', async () => {
    const res = await withPass(request(app).post('/files/presign')).send({ peerB: 'also-not' });
    expect(res.status).toBe(200);
    expect(jsonBody(res)).toHaveProperty('uploadUrl');
  });
});

describe('PUT /files/upload-put/:key then GET /files/:key', () => {
  it('round-trips a small encrypted file — скачивание ТРЕБУЕТ пропуск (§5, 10.08.2026)', async () => {
    // ⚠️ ПРОПУСК ОДИН НА ВСЕ ТРИ ЗАПРОСА (`p`), а не `withPass(...)` без
    // аргумента на каждом вызове: без этого метка пары/владельца на
    // скачивании не сверится с тем же адресом, что заливал, и (отдельно)
    // адресный бюджет разъедется на три разных адреса вместо одного.
    const p = chatPass();
    const presign = await withPass(request(app).post('/files/presign'), p).send({});
    const { key } = jsonBody(presign);

    const payload = Buffer.from('encrypted-bytes-here');
    const putRes = await withPass(request(app)
      .put(`/files/upload-put/${key}`), p)
      .set('Content-Type', 'application/octet-stream')
      .send(payload);
    expect(putRes.status).toBe(200);

    // ⚠️ ПЕРЕВЁРНУТО: было `GET` БЕЗ пропуска с ожиданием 200. Ключ больше не
    // «и есть пропуск» — см. relayer/test/chatFilesPass.test.js.
    const getRes = await withPass(request(app).get(`/files/${key}`), p);
    expect(getRes.status).toBe(200);
    expect(getRes.headers['content-disposition']).toMatch(/attachment/);
    expect(getRes.headers['x-content-type-options']).toBe('nosniff');
    // Same Content-Type-mislabeling quirk applies to served bytes: res.text is left
    // undefined, the raw bytes land in res.body as a Buffer instead.
    expect(getRes.body.toString('utf8')).toBe('encrypted-bytes-here');
  });

  it('без пропуска байты не отдаются вовсе', async () => {
    const p = chatPass();
    const presign = await withPass(request(app).post('/files/presign'), p).send({});
    const { key } = jsonBody(presign);
    await withPass(request(app).put(`/files/upload-put/${key}`), p)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('secret-ciphertext'));

    const getRes = await request(app).get(`/files/${key}`);
    expect(getRes.status).toBe(401);
    expect(getRes.body.code).toBe('pass_invalid');
  });
});

describe('POST /files/refresh-url', () => {
  it('returns 404 for a key that does not exist', async () => {
    const res = await withPass(request(app).post('/files/refresh-url')).send({ key: 'nonexistent-key.bin' });
    expect(res.status).toBe(404);
  });

  it('returns a download URL for an existing key', async () => {
    const presign = await withPass(request(app).post('/files/presign')).send({});
    const { key } = jsonBody(presign);
    await withPass(request(app).put(`/files/upload-put/${key}`)).set('Content-Type', 'application/octet-stream').send(Buffer.from('x'));

    const res = await withPass(request(app).post('/files/refresh-url')).send({ key });
    expect(res.status).toBe(200);
    expect(jsonBody(res)).toHaveProperty('downloadUrl');
  });
});

describe('POST /files/public/presign', () => {
  it('accepts an allowed extension', async () => {
    const res = await request(app).post('/files/public/presign').send({ ext: '.png' });
    expect(res.status).toBe(200);
    const body = jsonBody(res);
    expect(body).toHaveProperty('uploadUrl');
    expect(body).toHaveProperty('publicUrl');
  });

  it('rejects a disallowed extension', async () => {
    const res = await request(app).post('/files/public/presign').send({ ext: '.html' });
    expect(res.status).toBe(400);
  });

  it('accepts no extension at all', async () => {
    const res = await request(app).post('/files/public/presign').send({});
    expect(res.status).toBe(200);
  });
});

describe('upload size limit', () => {
  it('rejects an oversized public upload with 413', async () => {
    // MAX_PUBLIC_SIZE is 5 MB; streamWithSizeLimit aborts as soon as the running
    // total crosses it, so this never buffers the whole payload server-side.
    const payload = Buffer.alloc(6 * 1024 * 1024, 1); // 6 MB > 5 MB cap
    const res = await request(app)
      .put('/files/public-put/oversized-avatar.png')
      .set('Content-Type', 'application/octet-stream')
      .send(payload);
    expect(res.status).toBe(413);
    expect(jsonBody(res).error).toMatch(/too large/i);
  });
});

describe('multipart upload (create → part → complete)', () => {
  it('rejects an invalid chunkCount', async () => {
    const res = await withPass(request(app).post('/files/multipart/create')).send({ chunkCount: 0 });
    expect(res.status).toBe(400);
  });

  it('completes a 2-part upload and serves the concatenated result', async () => {
    const create = await withPass(request(app).post('/files/multipart/create')).send({ chunkCount: 2 });
    expect(create.status).toBe(200);
    const { uploadId, key } = jsonBody(create);

    const part1 = await withPass(request(app)
      .put(`/files/part/${uploadId}/1`))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('hello-'));
    expect(part1.status).toBe(200);

    const part2 = await withPass(request(app)
      .put(`/files/part/${uploadId}/2`))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('world'));
    expect(part2.status).toBe(200);

    const complete = await withPass(request(app).post('/files/multipart/complete')).send({ uploadId, key });
    expect(complete.status).toBe(200);
    expect(jsonBody(complete)).toHaveProperty('downloadUrl');

    // ⚠️ ПЕРЕВЁРНУТО (третий из трёх): выдача требует пропуск. Пары у
    // многокусочного ключа нет вовсе (названный пробел, см.
    // chatFilesPass.test.js), поэтому годится ЛЮБОЙ живой пропуск — здесь
    // намеренно СВЕЖИЙ (`withPass(...)` без второго аргумента), не пропуск
    // ни одного из заливавших выше, чтобы не выдать «совпало владельцем» за
    // «принадлежность проверена».
    const getRes = await withPass(request(app).get(`/files/${key}`));
    expect(getRes.status).toBe(200);
    expect(getRes.body.toString('utf8')).toBe('hello-world');
  });

  it('404s a part upload for an unknown uploadId', async () => {
    const res = await withPass(request(app)
      .put('/files/part/nonexistent-upload-id/1'))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    expect(res.status).toBe(404);
  });

  it('aborts an in-progress upload without error', async () => {
    const create = await withPass(request(app).post('/files/multipart/create')).send({ chunkCount: 1 });
    const { uploadId } = jsonBody(create);
    const res = await withPass(request(app).post('/files/multipart/abort')).send({ uploadId });
    expect(res.status).toBe(200);
    expect(jsonBody(res)).toEqual({ ok: true });
  });
});
