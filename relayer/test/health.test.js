import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import request from 'supertest';
import { app, relayerInfo } from '../app.js';
import * as bagStore from '../bagStore.js';

// ─── В-1 (аудит устойчивости, 6 августа) ────────────────────────────────────
//
// `/health` отвечал `{status:'ok'}` безусловно — он не знал ни про режим
// недоверия склада, ни про то, что диск больше не принимает запись. Две
// разные беды из одного корня:
//
//   • Отправитель получает 200 на сообщение, которое НЕ ПЕРЕЖИВЁТ
//     перезапуск: в режиме недоверия запись остаётся только в памяти.
//   • Внешний надзор видит «жив» на сервере, который уже ничего не
//     сохраняет, и не поднимает тревогу — то есть беда не будет замечена
//     ровно тем механизмом, который для этого и поставлен.
//
// Правило: состояние здоровья обязано включать то, от чего зависит
// СОХРАННОСТЬ, а не только то, что процесс жив и отвечает.

afterEach(() => {
  bagStore._resetPersistHealthForTests();
});

describe('GET /health', () => {
  it('здоровый склад — ok, 200, и прежние поля на месте', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.relayer).toBe(relayerInfo.relayerAddress);
    expect(res.body.diamond).toBe(relayerInfo.diamondAddr);
    // Сохранность названа явно, а не подразумевается отсутствием жалоб.
    expect(res.body.storage.indexTrusted).toBe(true);
    expect(res.body.storage.lastPersistError).toBeNull();
    expect(res.body.storage.diskFull).toBe(false);
  });

  // Сквозная проверка перед слиянием: первая редакция В-1 научила `/health`
  // режиму недоверия и отказу записи, но НЕ полному диску — а сервер к тому
  // моменту уже отвечал `507 disk_full` на запись. Надзор при этом видел
  // `200 ok`: половина работы, и худшая половина — беда УЖЕ наступила и
  // УЖЕ отражена в отказах человеку, а внешний глаз о ней не знает.
  it('свободного места меньше запаса — 503 degraded, тем же порогом, каким сервер уже отвечает 507', async () => {
    const RESERVE = 2 * 1024 * 1024 * 1024;
    const spy = vi.spyOn(fs, 'statfsSync').mockImplementation(() => ({
      bavail: Math.floor((RESERVE - 1) / 4096), bsize: 4096,
    }));
    try {
      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.storage.diskFull).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('места хватает — 200, и признак полного диска честно false', async () => {
    const spy = vi.spyOn(fs, 'statfsSync').mockImplementation(() => ({
      bavail: Math.floor((50 * 1024 * 1024 * 1024) / 4096), bsize: 4096,
    }));
    try {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.storage.diskFull).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('измерить место не вышло — это НЕ «диск полон»: 200, признак null', async () => {
    // `statfsSync` может отсутствовать или не работать на файловой системе
    // (замечено на exFAT). Сломанная мерка — «не знаем», а не «плохо»:
    // иначе весь надзор встал бы красным на ровном месте.
    const spy = vi.spyOn(fs, 'statfsSync').mockImplementation(() => { throw new Error('ENOSYS'); });
    try {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.storage.diskFull).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('режим недоверия — 503 и degraded: надзор обязан увидеть, что склад не сохраняет', async () => {
    const spy = vi.spyOn(bagStore, 'isBagStoreHealthy').mockReturnValue(false);
    try {
      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.storage.indexTrusted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('диск не принял запись — 503 и degraded, с причиной текстом', async () => {
    // Настоящий отказ записи, а не выставленный руками флаг: валим дозапись
    // ровно так, как это делает полный диск, и даём складу об неё споткнуться.
    const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const key = bagStore.bagKeyFor('0x' + 'a'.repeat(40));
    try {
      expect(() => bagStore.recordBag({
        key, sender: '0x' + 'b'.repeat(40), recipient: '0x' + 'a'.repeat(40),
        size: 1, uploadedAt: Date.now(),
      })).toThrow(/ENOSPC/);
    } finally {
      appendSpy.mockRestore();
    }

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.storage.lastPersistError).toMatch(/ENOSPC/);
  });

  it('после удачной записи отметка об отказе снимается — «было плохо» не залипает навсегда', async () => {
    const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const addr = '0x' + 'c'.repeat(40);
    try {
      expect(() => bagStore.recordBag({
        key: bagStore.bagKeyFor(addr), sender: '0x' + 'd'.repeat(40), recipient: addr,
        size: 1, uploadedAt: Date.now(),
      })).toThrow();
    } finally {
      appendSpy.mockRestore();
    }
    expect((await request(app).get('/health')).status).toBe(503);

    // Диск снова принимает — следующая удачная запись обязана вернуть 200,
    // иначе один давний сбой держал бы сервер «больным» до перезапуска.
    bagStore.recordBag({
      key: bagStore.bagKeyFor(addr), sender: '0x' + 'd'.repeat(40), recipient: addr,
      size: 1, uploadedAt: Date.now(),
    });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.storage.lastPersistError).toBeNull();
  });
});
