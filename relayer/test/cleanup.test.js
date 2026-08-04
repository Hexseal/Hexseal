import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { app, runFileCleanup, relayerInfo } from '../app.js';
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
});

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
    const presign = await request(app).post('/files/presign').send({ peerA: client, peerB: executor });
    const fp = path.join(relayerInfo.dirFiles, jsonBody(presign).key);
    touch(fp, Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days — past TTL, well within the 90-day ceiling

    await runFileCleanup();
    expect(fs.existsSync(fp)).toBe(true);
  });

  it('deletes a tagged-and-disputed file once it exceeds the 90-day protection ceiling', async () => {
    const client = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const executor = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [{ client, executor }] });

    const presign = await request(app).post('/files/presign').send({ peerA: client, peerB: executor });
    const fp = path.join(relayerInfo.dirFiles, jsonBody(presign).key);
    touch(fp, Date.now() - 120 * 24 * 60 * 60 * 1000); // 120 days — past the 90-day ceiling

    await runFileCleanup();
    expect(fs.existsSync(fp)).toBe(false);
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
    expect(errSpy.mock.calls.some(args => String(args[0]).includes('[bags] cleanup error'))).toBe(true);
  });
});
