/**
 * К-4 — файловый сервер чата открыт настежь.
 *
 * `POST /files/presign` и вся многокусочная дорога рядом с ним: без пропуска,
 * без ограничителя, до 5 ГБ на файл. Готовый способ забить диск дешёвого VPS.
 * Плюс анонимная запись в опись «кто с кем» (`file-pairs.json`), которая от
 * непрозвонившихся выдач НИКОГДА не убиралась: чистка ходит по ФАЙЛАМ на
 * диске, а запись описи появляется на ВЫДАЧЕ, до всякого файла.
 *
 * ⚠️ Этими маршрутами пользуется не только чат — рядом живут профили и
 * аватары (`/files/public/presign` ← `frontend/src/app/api/ipfs/upload/
 * route.ts`, вызов СЕРВЕРНЫЙ, кошелька у него нет). Замер того, кто чем
 * пользуется, — в конце файла: он и разделяет две семьи маршрутов.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CHAT_FILE_RATE_MAX = '5';
process.env.CHAT_FILE_IP_RATE_MAX = '8';

const { app, MAX_CHAT_FILE_SIZE } = await import('../app.js');
const { issueBagPass } = await import('../bagPass.js');

const ME    = '0xaaaa000000000000000000000000000000000001';
const PEER  = '0xbbbb000000000000000000000000000000000002';
const OTHER = '0xcccc000000000000000000000000000000000003';

let _ip = 0;
function freshIp() { _ip++; return `192.168.${(_ip >> 8) & 255}.${_ip & 255}`; }

// По умолчанию — СВЕЖИЙ адрес на каждый вызов: бюджеты здесь маленькие
// (CHAT_FILE_RATE_MAX=5), и общий адрес на все кейсы означал бы, чточасть кейсов
// падает от чужого исчерпания, а не от того, что проверяет тест.
let _addr = 0;
function freshAddr() { _addr++; return '0x' + String(_addr).padStart(40, '9'); }
function pass(addr) { return issueBagPass(addr ?? freshAddr()).token; }

function presign(opts = {}) {
  const r = request(app).post('/files/presign').set('CF-Connecting-IP', opts.ip ?? freshIp());
  if (opts.pass !== null) r.set('x-bag-pass', opts.pass ?? pass());
  return r.send(opts.body ?? {});
}

describe('К-4: чат-файлы за тем же пропуском, что и мешки', () => {
  it('ЗАМЕР ДО ПОЧИНКИ: выдача без пропуска отдавала адрес для заливки любому', async () => {
    const res = await presign({ pass: null });
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('uploadUrl');
  });

  it('с пропуском выдача работает', async () => {
    const res = await presign();
    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toContain('/files/upload-put/');
  });

  it('мёртвый пропуск не годится', async () => {
    const res = await presign({ pass: issueBagPass(ME, 1_700_000_000).token });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('pass_expired');
  });

  it.each([
    ['начало многокусочной заливки', 'post', '/files/multipart/create',   { chunkCount: 2 }],
    ['сборка многокусочной',         'post', '/files/multipart/complete', { uploadId: 'x', key: 'y' }],
    ['отмена многокусочной',         'post', '/files/multipart/abort',    { uploadId: 'x' }],
    ['обновление адреса',            'post', '/files/refresh-url',        { key: 'x' }],
  ])('%s тоже требует пропуска', async (_n, method, url, body) => {
    const res = await request(app)[method](url).set('CF-Connecting-IP', freshIp()).send(body);
    expect(res.status).toBe(401);
  });

  it('заливка байтов тоже требует пропуска — иначе адрес заливки был бы предъявительским', async () => {
    const { body } = await presign();
    const key = body.key;

    const noPass = await request(app)
      .put(`/files/upload-put/${key}`)
      .set('CF-Connecting-IP', freshIp())
      .send('данные');
    expect(noPass.status).toBe(401);

    const withPass = await request(app)
      .put(`/files/upload-put/${key}`)
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass())
      .send('данные');
    expect(withPass.status).toBe(200);
  });

  it('кусок многокусочной заливки тоже требует пропуска', async () => {
    const create = await request(app)
      .post('/files/multipart/create')
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass())
      .send({ chunkCount: 1 });
    expect(create.status).toBe(200);
    const uploadId = create.body.uploadId;

    const noPass = await request(app)
      .put(`/files/part/${uploadId}/1`)
      .set('CF-Connecting-IP', freshIp())
      .send('кусок');
    expect(noPass.status).toBe(401);
  });
});

describe('К-4: ограничитель', () => {
  it('ЗАМЕР ДО ПОЧИНКИ: сто выдач подряд с одного адреса проходили все', async () => {
    const p = pass(OTHER);
    const statuses = [];
    for (let i = 0; i < 8; i++) statuses.push((await presign({ pass: p })).status);

    // CHAT_FILE_RATE_MAX=5 (выставлен выше файла)
    expect(statuses.filter(s => s === 200).length).toBe(5);
    expect(statuses.slice(5).every(s => s === 429)).toBe(true);
  });

  it('исчерпавший бюджет мешает только себе', async () => {
    const p = pass('0xdddd000000000000000000000000000000000004');
    for (let i = 0; i < 8; i++) await presign({ pass: p });

    const stranger = pass('0xeeee000000000000000000000000000000000005');
    expect((await presign({ pass: stranger })).status).toBe(200);
  });

  it('бюджет выхода в сеть отдельно от адресного — двадцать адресов с одного выхода тоже упираются', async () => {
    const ip = freshIp();
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await presign({ pass: pass('0x' + String(i).padStart(40, 'f')), ip })).status);
    }
    // CHAT_FILE_IP_RATE_MAX=8
    expect(statuses.filter(s => s === 200).length).toBe(8);
    expect(statuses.slice(8).every(s => s === 429)).toBe(true);
  });
});

describe('К-4: потолок размера согласован с тем, что нужно чату', () => {
  it('ЗАМЕР ДО ПОЧИНКИ: потолок был 5 ГБ на файл', () => {
    console.log(`[замер К-4] потолок чат-файла: ${(MAX_CHAT_FILE_SIZE / 1024 / 1024).toFixed(0)} МБ`);
    expect(MAX_CHAT_FILE_SIZE).toBeLessThan(5 * 1024 * 1024 * 1024);
    // Не «поменьше», а «влезает в дешёвый VPS»: один файл не имеет права
    // занять заметную долю диска.
    expect(MAX_CHAT_FILE_SIZE).toBeLessThanOrEqual(512 * 1024 * 1024);
    // И не «так мало, что чат сломался»: порог многокусочной заливки — 20 МБ.
    expect(MAX_CHAT_FILE_SIZE).toBeGreaterThan(20 * 1024 * 1024);
  });

  it('фронт обещает ровно тот же потолок, что принимает сервер', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/src/lib/fileStorage.ts'),
      'utf8',
    );
    const m = src.match(/export const MAX_FILE_SIZE\s*=\s*([^;]+);/);
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-eval
    const clientMax = Function(`"use strict"; return (${m[1]})`)();
    expect(clientMax).toBe(MAX_CHAT_FILE_SIZE);
  });
});

describe('К-4: опись «кто с кем» не растёт от чужих обращений', () => {
  const pairsFile = () => path.join(process.env.STORAGE_DIR, 'file-pairs.json');
  const readPairs = () => {
    try { return JSON.parse(fs.readFileSync(pairsFile(), 'utf8')); } catch { return {}; }
  };

  it('ЗАМЕР ДО ПОЧИНКИ: любой мог записать ЧУЖУЮ пару, себя в ней не упоминая', async () => {
    const OTHER_FRESH = freshAddr();
    const before = Object.keys(readPairs()).length;

    const res = await presign({
      pass: pass(OTHER_FRESH),                 // мы — OTHER_FRESH
      body: { peerA: ME, peerB: PEER },        // а пишем про ME и PEER
    });
    expect(res.status).toBe(200);

    const pairs = readPairs();
    expect(Object.keys(pairs).length).toBe(before + 1);
    // Записана пара С НАМИ, а не та, которую попросили.
    const { pairIdFromAddresses } = await import('../app.js');
    // В-3 (соседняя правка того же дня): запись описи вложений стала
    // объектом `{ p: pairId, d: срок }` вместо голой строки — у вложения
    // теперь есть собственный срок, усыновлённый сделкой. Сама проверка
    // этого теста не изменилась ни на йоту: записана пара С НАМИ, а не та,
    // которую попросили; читается только поле пары.
    expect(pairs[res.body.key].p).toBe(pairIdFromAddresses(OTHER_FRESH, PEER));
    expect(pairs[res.body.key].p).not.toBe(pairIdFromAddresses(ME, PEER));
  });

  it('без собеседника запись не появляется вовсе', async () => {
    const before = Object.keys(readPairs()).length;
    const res = await presign({ body: {} });
    expect(res.status).toBe(200);
    expect(Object.keys(readPairs()).length).toBe(before);
  });

  it('запись, за которой так и не приехал файл, убирается чисткой', async () => {
    const res = await presign({ body: { peerB: PEER } });
    const key = res.body.key;
    expect(readPairs()[key]).toBeTruthy();

    // Файла по этому ключу нет и не будет: человек закрыл вкладку на середине.
    expect(fs.existsSync(path.join(process.env.STORAGE_DIR, 'files', key))).toBe(false);

    const { runFileCleanup } = await import('../app.js');
    await runFileCleanup();

    // Раньше чистка ходила ТОЛЬКО по файлам на диске, поэтому такая запись
    // жила вечно — это и была «вечная опись».
    expect(readPairs()[key]).toBeUndefined();
  });
});

describe('К-4: диск кончился — отказ, а не падение всего релеера', () => {
  it('мало места → 507, и байты не принимаются вовсе', async () => {
    const spy = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096, bavail: 1 });
    try {
      const res = await presign();
      expect(res.status).toBe(507);
      expect(res.body.code).toBe('disk_full');
    } finally {
      spy.mockRestore();
    }
  });

  it('места хватает → выдача идёт как обычно', async () => {
    const spy = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096, bavail: 100_000_000 });
    try {
      expect((await presign()).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('мерка места сама сломалась — это не повод отказать человеку', async () => {
    const spy = vi.spyOn(fs, 'statfsSync').mockImplementation(() => { throw new Error('statfs unsupported'); });
    try {
      expect((await presign()).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('К-4: ЗАМЕР — кто ещё пользуется файловым сервером', () => {
  it('профили и аватары ходят ДРУГОЙ дорогой и пропуска не требуют', async () => {
    // `/files/public/presign` зовёт `frontend/src/app/api/ipfs/upload/route.ts`
    // — вызов СЕРВЕРНЫЙ, кошелька у него нет и пропуска взять неоткуда.
    // Сломать это починкой чата было бы ровно тем «своя починка хуже
    // дефекта», о котором предупреждает CLAUDE.md.
    const res = await request(app)
      .post('/files/public/presign')
      .set('CF-Connecting-IP', freshIp())
      .send({ ext: '.png' });

    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toContain('/files/public-put/');
  });

  it('заливка аватара тоже без пропуска', async () => {
    const presignRes = await request(app)
      .post('/files/public/presign')
      .set('CF-Connecting-IP', freshIp())
      .send({ ext: '.png' });

    const res = await request(app)
      .put(`/files/public-put/${presignRes.body.key}`)
      .set('CF-Connecting-IP', freshIp())
      .send('картинка');

    expect(res.status).toBe(200);
  });

  it('скачивание чат-файла ТРЕБУЕТ пропуск — без него 401', async () => {
    // ⚠️ ПЕРЕВЁРНУТЫЙ ТЕСТ. До 10 августа 2026 здесь утверждалось обратное:
    // «скачивание остаётся открытым — ключ и есть пропуск, содержимое
    // зашифровано». Довод верен ровно до того дня, когда у переписки
    // появляется ТРЕТИЙ читатель. Арбитр им и становится (§5 замысла): он
    // обязан видеть, ЧТО вложение было, и не мочь его взять. Главный замок —
    // вложенный на ключ (chatEnvelope.ts) и вид арбитра БЕЗ адреса файла;
    // этот — второй, для сообщений, отправленных до правки формы: у них ключ
    // открыт, и живут они ещё семь дней (FILE_TTL_MS).
    const p = pass();
    const { body } = await presign({ pass: p });
    await request(app).put(`/files/upload-put/${body.key}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', p).send('шифротекст');

    const res = await request(app).get(`/files/${body.key}`);
    expect(res.status).toBe(401);
    // Код читается — значит отказ уехал как JSON, а не под навязанным
    // Content-Type: application/octet-stream (замок обязан стоять ДО
    // защитных заголовков, иначе res.json() их не перебьёт).
    expect(res.body.code).toBe('pass_invalid');
  });

  // ⚠️ ПРАВКА ПРИ ИСПОЛНЕНИИ (не дословно по плану): четыре теста ниже сначала
  // делили общие адреса ME/PEER/OTHER (POST /files/presign И PUT upload-put
  // оба списывают адресный бюджет `CHAT_FILE_RATE_MAX` — здесь 5, выставлен в
  // начале файла). Каждый тест тратит на владельца ДВЕ единицы (presign +
  // upload); трёх таких тестов подряд на ОДНОМ адресе — уже 6 > 5. Четвёртый
  // и пятый по счёту тесты ловили тихий 429 на заливке, файл не долетал до
  // диска, и GET по правильному ключу отвечал 404 (а не тем кодом, что
  // проверяет тест) — замерено запуском с исходной фикстурой. Лечение —
  // свой свежий адрес владельца на каждый тест (freshAddr()), как везде в
  // остальном файле; общие ME/PEER/OTHER оставлены только там, где были до
  // этой правки.
  it('участника пары к её вложению пускает', async () => {
    const owner = freshAddr();
    const peer = freshAddr();
    const me = pass(owner);
    const { body } = await presign({ pass: me, body: { peerB: peer } });
    await request(app).put(`/files/upload-put/${body.key}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', me).send('шифротекст');

    const mine = await request(app).get(`/files/${body.key}`).set('x-bag-pass', pass(owner));
    expect(mine.status).toBe(200);
    const theirs = await request(app).get(`/files/${body.key}`).set('x-bag-pass', pass(peer));
    expect(theirs.status).toBe(200);
  });

  it('сторонний пропуск к вложению пары — 403, а не 200', async () => {
    // Пропуск склада есть у КАЖДОГО пользователя чата, включая арбитра.
    // Значит «просто требовать пропуск» его бы не остановило — нужна
    // принадлежность паре, а она в описи (`file-pairs.json`) уже есть.
    const owner = freshAddr();
    const peer = freshAddr();
    const stranger = freshAddr();
    const me = pass(owner);
    const { body } = await presign({ pass: me, body: { peerB: peer } });
    await request(app).put(`/files/upload-put/${body.key}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', me).send('шифротекст');

    const res = await request(app).get(`/files/${body.key}`).set('x-bag-pass', pass(stranger));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_your_file');
  });

  it('Cache-Control приватный — общий кэш не раздаст чужое вложение', async () => {
    // Пока выдача была открыта всем, `public, max-age=3600` не значил ничего.
    // Появилась проверка личности — и общий кэш на пути (прокси, тоннель)
    // раздавал бы уже проверенный ответ следующему просящему.
    const owner = freshAddr();
    const peer = freshAddr();
    const me = pass(owner);
    const { body } = await presign({ pass: me, body: { peerB: peer } });
    await request(app).put(`/files/upload-put/${body.key}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', me).send('шифротекст');

    const res = await request(app).get(`/files/${body.key}`).set('x-bag-pass', pass(owner));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['cache-control']).not.toContain('public');
  });

  it('НАЗВАННЫЙ ПРОБЕЛ: у ключа без записи в описи пара неизвестна — пускает любой живой пропуск', async () => {
    // ⚠️ ЭТО НЕ ЗАБЫТО, ЭТО ИЗМЕРЕНО. Метка пары ставится ТОЛЬКО в
    // `POST /files/presign` и только при переданном `peerB`; многокусочная
    // заливка (>20 МБ) не метится ВОВСЕ — `create` даже не принимает `peerB`
    // (relayer/app.js:2405, frontend/src/lib/fileStorage.ts:224-225).
    // Значит для крупных вложений принадлежность паре проверить нечем, и
    // замок вырождается в «нужен любой пропуск». Отказать всем было бы хуже:
    // сломались бы все крупные вложения у обеих сторон. Пробел закрывается
    // меткой пары на многокусочном пути — отдельная работа, §4.5 справочника
    // вложений.
    const owner = freshAddr();
    const stranger = freshAddr();
    const me = pass(owner);
    const { body } = await presign({ pass: me });   // без peerB — записи в описи нет
    await request(app).put(`/files/upload-put/${body.key}`)
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', me).send('шифротекст');

    const res = await request(app).get(`/files/${body.key}`).set('x-bag-pass', pass(stranger));
    expect(res.status).toBe(200);
  });
});
