import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { ethers } from 'ethers';
import { app, runFileCleanup, relayerInfo } from '../app.js';
import { bagPassChallenge } from '../bagPass.js';
import { issueBagPass } from '../bagPass.js';
import { mockContract } from './mocks/ethersRegistry.js';
import { jsonBody } from './helpers/httpBody.js';

// Задача 4 (chat-transport-storage): cleanupBags() подключается внутри
// runFileCleanup() отдельным try — падение чистки мешков не должно мешать
// (и не должно от неё зависеть) чистке вложений, и наоборот. Мокаем сам
// bagStore.js тем же приёмом, что уже применяет test/bagRoutes.test.js:
// оборачиваем настоящий модуль и включаем бросок точечно, per-тест, через
// мутируемый флаг. Флаг по умолчанию false — реальная реализация
// используется во всех остальных тестах этого файла (включая четыре
// существующих выше, которые cleanupBags вообще не касаются) и в helper'е
// putBag() ниже.
//
// ЛОВУШКА В ФИКСТУРЕ (закрывающий раунд ревью, замечена координатором, не
// мной — оставлено громко, чтобы не повторилась). `{...actual}` спредит
// ЗНАЧЕНИЯ экспортов bagStore.js НА МОМЕНТ, когда эта фабрика отработала в
// первый раз — а не создаёт живую пересылку. Для `export function` (сам
// cleanupBags, recordBag и т.д.) это без разницы: функции не
// переприсваиваются. Но bagStore.js держит семь `export let`
// (DIR_BAGS/BAG_TTL_MS/.../CLOCK_SKEW_ALLOWANCE_MS — см. заголовок
// bagStore.js, И-3), пересчитываемых заново из окружения внутри
// assertBagStoreReady(). Настоящий модуль после такого пересчёта отдаёт
// новое значение через живую ES-привязку; ЭТОТ мок — старый снимок,
// замороженный на момент первого импорта. Сегодня в этом файле никто
// окружение/STORAGE_DIR не меняет посреди теста, так что ловушка не
// кусает. Если когда-нибудь здесь понадобится тест на пересчёт
// лимитов/сроков (как в test/bagStore.test.js, withFreshBagStoreModule) —
// он получит зелёный на пустом месте, сверяясь с замороженным старым
// значением, а не с тем, что реально видит app.js. Проверять такое —
// не в этом файле; для этого класса тестов нужен bagStore.test.js напрямую,
// без vi.mock над ним.
const bagCleanup = vi.hoisted(() => ({ throws: false, calls: 0 }));

vi.mock('../bagStore.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    cleanupBags: (...args) => {
      bagCleanup.calls++;
      if (bagCleanup.throws) throw new Error('simulated bagStore cleanup failure (test)');
      return actual.cleanupBags(...args);
    },
  };
});

const { recordBag, bagKeyFor, bagPathFor, bagMetaOf } = await import('../bagStore.js');

afterEach(() => {
  bagCleanup.throws = false;
  bagCleanup.calls = 0;
  // Реверс-тест ниже сносит relayerInfo.dirFiles целиком, чтобы имитировать
  // отвалившийся том — восстановить его для всех остальных тестов файла,
  // которые делят один и тот же STORAGE_DIR на весь файл (test/setup.js
  // создаёт его один раз, не per-test).
  fs.mkdirSync(relayerInfo.dirFiles, { recursive: true });
});

// Пометить вложение парой можно только через настоящий маршрут выдачи
// адреса — `_filePairs` живёт внутри app.js и грузится один раз при импорте,
// так что подложить метку файлом на диске после импорта нельзя. Маршрут
// требует пропуск (первый участник пары берётся из пропуска, а не из тела),
// поэтому пропуск честно выпускается тем же путём, что и в боевом клиенте.
let _ipCounter = 0;
const freshIp = () => { _ipCounter++; return `10.66.${(_ipCounter >> 8) & 255}.${_ipCounter & 255}`; };

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
  if (res.status !== 200) throw new Error(`issuePassFor: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.pass;
}

/** Помечает новое вложение парой (владелец пропуска, peerB) и отдаёт путь. */
async function tagFileForPair(peerB) {
  const wallet = ethers.Wallet.createRandom();
  const pass = await issuePassFor(wallet);
  const presign = await request(app)
    .post('/files/presign')
    .set('CF-Connecting-IP', freshIp())
    .set('x-bag-pass', pass)
    .send({ peerB });
  if (presign.status !== 200) throw new Error(`presign: ${presign.status} ${JSON.stringify(presign.body)}`);
  return path.join(relayerInfo.dirFiles, jsonBody(presign).key);
}

function touch(filePath, mtimeMs) {
  fs.writeFileSync(filePath, 'x');
  const t = new Date(mtimeMs);
  fs.utimesSync(filePath, t, t);
}

// Пишет настоящий файл мешка на диск и регистрирует его в индексе — тот же
// приём, что put() в test/bagStore.test.js: mtime файла реального значения
// не имеет (cleanupBags решает по meta.uploadedAt в индексе, не по mtime),
// но пишем честный файл, чтобы проверять и его физическое удаление тоже.
function putBag(recipient, sender, uploadedAt) {
  const key = bagKeyFor(recipient);
  const fp = bagPathFor(key);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, Buffer.from('sealed'));
  recordBag({ sender, recipient, key, size: 6, uploadedAt });
  return { key, fp };
}

describe('runFileCleanup', () => {
  it('deletes an untagged file older than the 7-day TTL', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [] });
    const fp = path.join(relayerInfo.dirFiles, `old-untagged-${Date.now()}.bin`);
    touch(fp, Date.now() - 8 * 24 * 60 * 60 * 1000);

    await runFileCleanup();
    expect(fs.existsSync(fp)).toBe(false);
  });

  it('keeps a fresh untagged file (younger than the TTL)', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [] });
    const fp = path.join(relayerInfo.dirFiles, `fresh-${Date.now()}.bin`);
    touch(fp, Date.now());

    await runFileCleanup();
    expect(fs.existsSync(fp)).toBe(true);
  });

  it('protects a tagged file whose pair is currently disputed and younger than the 90-day ceiling', async () => {
    const client = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const executor = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [{ client, executor }] });

    // Tag the file via a real presign call so _filePairs is populated the same
    // way production traffic populates it, then age the file past the TTL.
    // К-4: первый участник пары берётся ИЗ ПРОПУСКА, из тела он больше не
    // принимается — поэтому пропуск выпускается на `client`.
    const presign = await request(app).post('/files/presign')
      .set('x-bag-pass', issueBagPass(client).token)
      .send({ peerB: executor });
    const fp = path.join(relayerInfo.dirFiles, jsonBody(presign).key);
    touch(fp, Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days — past TTL, well within the 90-day ceiling

    await runFileCleanup();
    expect(fs.existsSync(fp)).toBe(true);
  });

  it('deletes a tagged-and-disputed file once it exceeds the 90-day protection ceiling', async () => {
    const client = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const executor = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [{ client, executor }] });

    // К-4: первый участник пары берётся ИЗ ПРОПУСКА, из тела он больше не
    // принимается — поэтому пропуск выпускается на `client`.
    const presign = await request(app).post('/files/presign')
      .set('x-bag-pass', issueBagPass(client).token)
      .send({ peerB: executor });
    const fp = path.join(relayerInfo.dirFiles, jsonBody(presign).key);
    touch(fp, Date.now() - 120 * 24 * 60 * 60 * 1000); // 120 days — past the 90-day ceiling

    await runFileCleanup();
    expect(fs.existsSync(fp)).toBe(false);
  });

  // ─── К-1 (аудит устойчивости, 6 августа) ────────────────────────────────
  //
  // Один отказ узла цепи в 03:00 — и уборка сносила доказательства по
  // ЖИВОМУ спору. fetchDisputedRecords() при отказе сети возвращала пустой
  // массив с комментарием «fail open on the on-chain read», и защита
  // вложений читала эту пустоту как «спорных пар нет ни одной».
  //
  // Это ровно тот класс, что уже ломал живое в этом проекте: строка «метла
  // сносила доказательства по живому спору» стоит в docs/PROCESS.md среди
  // шести случаев, породивших правило про обстоятельства.
  //
  // Правило: НЕ ЗНАЕМ — НЕ СНОСИМ. Отказ узла обязан ОТКЛАДЫВАТЬ уборку
  // помеченных вложений, а не разрешать её.
  describe('К-1 — узел цепи молчит: «не знаем» не должно значить «спорных пар нет»', () => {
    it('узел отказал — помеченное вложение переживает ночь, хотя срок вышел', async () => {
      const executor = '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
      // Узел цепи не отвечает — единственное отличие от соседнего теста,
      // где та же пара честно приезжает спорной.
      mockContract(process.env.DIAMOND_ADDRESS, {
        getDisputed: () => { throw new Error('network error (simulated node outage)'); },
        getActive: () => { throw new Error('network error (simulated node outage)'); },
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const fp = await tagFileForPair(executor);
      touch(fp, Date.now() - 30 * 24 * 60 * 60 * 1000); // срок вышел давно, но до 90-дневного потолка далеко

      await runFileCleanup();
      errSpy.mockRestore();

      expect(fs.existsSync(fp)).toBe(true);
    });

    it('узел отказал — НЕпомеченное вложение всё равно снесено: откладывается только то, про что мы не знаем', async () => {
      mockContract(process.env.DIAMOND_ADDRESS, {
        getDisputed: () => { throw new Error('network error (simulated node outage)'); },
        getActive: () => { throw new Error('network error (simulated node outage)'); },
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Без пары в описи это вложение не может быть защищено спором НИ ПРИ
      // КАКОМ ответе цепи — значит знание цепи для решения по нему не нужно,
      // и откладывать его нечестно: это был бы не «не знаем», а «перестали
      // убирать вообще».
      const fp = path.join(relayerInfo.dirFiles, `untagged-outage-${Date.now()}.bin`);
      touch(fp, Date.now() - 30 * 24 * 60 * 60 * 1000);

      await runFileCleanup();
      errSpy.mockRestore();

      expect(fs.existsSync(fp)).toBe(false);
    });

    it('узел отказал — отложенное названо в логе числом, а не тишиной', async () => {
      const executor = '0x1111111111111111111111111111111111111113';
      mockContract(process.env.DIAMOND_ADDRESS, {
        getDisputed: () => { throw new Error('network error (simulated node outage)'); },
        getActive: () => { throw new Error('network error (simulated node outage)'); },
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const fp = await tagFileForPair(executor);
      touch(fp, Date.now() - 30 * 24 * 60 * 60 * 1000);

      await runFileCleanup();

      const line = logSpy.mock.calls.map((a) => String(a[0]))
        .find((m) => m.includes('[files] cleanup: deferred'));
      logSpy.mockRestore();
      errSpy.mockRestore();

      // Молчание не годится: ночь, когда уборка отложена отказом сети,
      // обязана быть отличима от ночи, когда сносить было нечего.
      expect(line).toBeDefined();
      expect(line).toMatch(/deferred \d+ tagged file/);
    });
  });

  it('removes an orphaned temp upload dir older than 1 day', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [] });
    const dir = path.join(relayerInfo.storageDir, 'temp', `orphan-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);

    await runFileCleanup();
    expect(fs.existsSync(dir)).toBe(false);
  });

  // «Докажи замером, что стало иначе»: на боевом умолчании BAG_UNREAD_TTL_MS
  // (30 дней, ничем в этом файле не переопределённом) — до подключения
  // cleanupBags() внутрь runFileCleanup() этот мешок переживал чистку
  // вечно; после подключения обязан быть снесён и из индекса, и с диска.
  it('runFileCleanup чистит и просроченные мешки на боевом умолчании BAG_UNREAD_TTL_MS (30д)', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [] });
    const RECIPIENT = '0x' + 'b'.repeat(40);
    const SENDER    = '0x' + 'c'.repeat(40);
    const uploadedAt = Date.now() - 31 * 24 * 60 * 60 * 1000; // за боевым 30-дневным умолчанием
    const { key, fp } = putBag(RECIPIENT, SENDER, uploadedAt);

    await runFileCleanup();

    expect(fs.existsSync(fp)).toBe(false);
    expect(bagMetaOf(key)).toBeUndefined();
  });

  it('падение чистки мешков не мешает чистке вложений и не улетает из runFileCleanup наружу', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [] });
    bagCleanup.throws = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const fp = path.join(relayerInfo.dirFiles, `old-untagged-${Date.now()}.bin`);
    touch(fp, Date.now() - 8 * 24 * 60 * 60 * 1000);

    await expect(runFileCleanup()).resolves.toBeUndefined();

    // cleanupBags и правда была вызвана — не "ничего не сломалось, потому
    // что она и не звалась вовсе" (тест, который красится от отсутствия
    // вызова так же, как от присутствующего и упавшего, ничего не запирает).
    expect(bagCleanup.calls).toBe(1);
    // Вложение почищено, несмотря на бросок в соседнем блоке.
    expect(fs.existsSync(fp)).toBe(false);
    // Ошибка залогирована текстом, а не проглочена молча.
    const call = errSpy.mock.calls.find(args => String(args[0]).includes('[bags] cleanup error'));
    expect(call).toBeDefined();
    // Закрывающий раунд ревью: не только e.message — стек тоже. Второй
    // аргумент обязан быть многострочным (стек), а не голой строкой
    // сообщения — реальный Error всегда даёт "Error: ...\n    at ..."; если
    // правку откатят на e.message, вторая строка (" at ") пропадёт, и это
    // видно из содержимого, а не из одного факта "что-то залогировано".
    expect(String(call[1])).toContain('simulated bagStore cleanup failure (test)');
    expect(String(call[1])).toMatch(/\n\s+at /);
  });

  // Требование 1 (закрывающий раунд ревью): изоляция обязана работать в
  // ОБЕ стороны. Тест выше запирает «падение мешков не мешает вложениям»;
  // этот — обратное, реалистичным сценарием «отвалился том»: каталог
  // вложений снесён целиком, fs.readdirSync(DIR_FILES) бросает ENOENT
  // внутри уже существующего try/catch файлового блока (не мой код — но
  // ничто раньше не проверяло, что мешки переживут ЕГО падение). До этого
  // теста перенос вызова cleanupBags() внутрь блока вложений (с проброс
  // из его catch вместо локального try/catch) красил 0 из 414/422 тестов.
  it('падение чистки вложений не мешает чистке мешков (реалистично: отвалился том — каталог вложений снесён)', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [] });
    const RECIPIENT = '0x' + '4'.repeat(40);
    const SENDER    = '0x' + '5'.repeat(40);
    const uploadedAt = Date.now() - 31 * 24 * 60 * 60 * 1000; // за боевым 30-дневным умолчанием
    const { key, fp } = putBag(RECIPIENT, SENDER, uploadedAt);

    fs.rmSync(relayerInfo.dirFiles, { recursive: true, force: true }); // "том отвалился"

    await expect(runFileCleanup()).resolves.toBeUndefined();

    expect(fs.existsSync(fp)).toBe(false);
    expect(bagMetaOf(key)).toBeUndefined();
  });

  // Требование 3 (закрывающий раунд ревью): строка о результате чистки
  // мешков раньше печаталась только когда removed>0 — ночь без удалений
  // неотличима в логе от ночи, когда расписание вообще не сработало.
  // Печатаем итог всегда; числа — конкретные и РАЗНЫЕ (removed=2, kept=1),
  // так что мутация "поменять местами removed/kept в шаблонной строке"
  // тоже красит тест, не только мутация "печатать не всегда".
  it('runFileCleanup всегда печатает итог чистки мешков, даже без единого удаления, и с точными числами', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Сценарий А: нечего чистить вообще (мешков нет). Тишина в логе не
    // должна означать "нечего чистить" — обязана стать явной строкой.
    await runFileCleanup();
    expect(logSpy.mock.calls.some(args => String(args[0]) === '[bags] cleanup: removed 0, kept 0')).toBe(true);

    logSpy.mockClear();

    // Сценарий Б: removed=2 (просроченные), kept=1 (свежий) — числа разные,
    // перестановка местами в строке ловится буквальным совпадением текста.
    const RECIPIENT = '0x' + '6'.repeat(40);
    const SENDER    = '0x' + '7'.repeat(40);
    const expiredAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    putBag(RECIPIENT, SENDER, expiredAt);
    putBag(RECIPIENT, SENDER, expiredAt);
    putBag(RECIPIENT, SENDER, Date.now()); // свежий, не просрочен

    await runFileCleanup();

    expect(logSpy.mock.calls.some(args => String(args[0]) === '[bags] cleanup: removed 2, kept 1')).toBe(true);
  });
});
