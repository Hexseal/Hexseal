import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';

import {
  EVIDENCE_UPLOAD_ENDPOINT, MAX_EVIDENCE_BYTES,
  EvidenceTooLargeError, evidenceDigest, uploadRemovalEvidence,
} from './removalEvidence';

/**
 * Замок на корзину доказательства.
 *
 * ⚠️ ЧТО ИМЕННО СТОРОЖИТСЯ И ПОЧЕМУ ЭТО НЕ ПРИДИРКА. У релеера две файловые
 * корзины, и они отличаются НЕ ПАПКОЙ, А СРОКОМ ЖИЗНИ:
 *
 *   • `/files/presign`        → `/storage/files/`, TTL 7 ДНЕЙ, чистка в 03:00;
 *   • `/files/public/presign` → `/storage/public/`, ПОСТОЯННО (`max-age: 365d`).
 *
 * Обвинение живёт 14 дней, запись о сносе — вечно. Уйди доказательство в
 * чатовую корзину, и на восьмой день отпечаток в цепи пережил бы файл ПО
 * УСТРОЙСТВУ: осталось бы обязательство, проверить которое нечем. Молча — ни
 * отказа, ни события, просто ссылка перестаёт отвечать через неделю после того,
 * как все посмотрели и разошлись. Найти это можно было бы только через неделю
 * после первого настоящего обвинения.
 *
 * ⚠️ ПОЭТОМУ ПРОВЕРОК ДВЕ, И ОДНОЙ БЫЛО БЫ МАЛО. Первая сторожит НАШ конец шва
 * — куда стучимся отсюда; вторая ЧУЖОЙ — в какую корзину этот адрес ведёт,
 * читая исходник самого маршрута. Оставь только первую — и переключение корзины
 * внутри маршрута пройдёт молча; оставь только вторую — и вызов мимо маршрута
 * (например через `fileStorage.uploadEncryptedFile`) пройдёт молча.
 *
 * ⚠️ ОЖИДАЕМОЕ ВЗЯТО НЕ ИЗ ПРОВЕРЯЕМОГО. Обе строки — `'/api/ipfs/upload'` и
 * `'/files/public/presign'` — записаны здесь литералами руками, а не выведены
 * из `EVIDENCE_UPLOAD_ENDPOINT` или из исходника. Сверяй мы одно с другим,
 * замок смотрелся бы в зеркало и был доволен всегда.
 */

const ROUTE_SOURCE = fileURLToPath(
  new URL('../app/api/ipfs/upload/route.ts', import.meta.url),
);

/* ── 1. наш конец шва: куда стучимся ── */

describe('доказательство уходит в ПОСТОЯННУЮ корзину', () => {
  it('заливка идёт на /api/ipfs/upload — дверь постоянной корзины', async () => {
    const seen: string[] = [];
    const fake = vi.fn(async (url: unknown) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ url: 'https://api.example/public/x.pdf' }) } as Response;
    }) as unknown as typeof fetch;

    const file = new File([new Uint8Array([1, 2, 3])], 'leak.pdf', { type: 'application/pdf' });
    const out = await uploadRemovalEvidence(file, fake);

    // Литерал руками — не `EVIDENCE_UPLOAD_ENDPOINT`.
    expect(seen).toEqual(['/api/ipfs/upload']);
    expect(out.url).toBe('https://api.example/public/x.pdf');
    expect(out.name).toBe('leak.pdf');
  });

  it('и НЕ в чатовую /files/presign, у которой TTL семь дней', async () => {
    const seen: string[] = [];
    const fake = vi.fn(async (url: unknown) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ url: 'https://api.example/public/x.pdf' }) } as Response;
    }) as unknown as typeof fetch;

    await uploadRemovalEvidence(new File([new Uint8Array([9])], 'a.bin'), fake);

    for (const url of seen) {
      expect(url).not.toContain('/files/presign');
      expect(url).not.toContain('/files/multipart');
    }
  });

  it('объявленная дверь — та же самая', () => {
    expect(EVIDENCE_UPLOAD_ENDPOINT).toBe('/api/ipfs/upload');
  });
});

/* ── 2. чужой конец шва: куда ведёт эта дверь ── */

/**
 * ⚠️ ДАЛЬНИЙ КОНЕЦ ШВА ПРОВЕРЯЕТСЯ ЗАПУСКОМ, А НЕ ЧТЕНИЕМ ИСХОДНИКА (круг
 * правок 1). Раньше здесь стояло `source.toContain('/files/public/presign')`, и
 * это был тот же шестой способ, что уже дважды ловили: замок узнавал
 * НАПИСАНИЕ. Собери адрес из переменных —
 *
 *     const BUCKET = 'public/';
 *     fetch(`${INTERNAL}/files/${BUCKET}presign`)
 *
 * — и обе проверки молчали бы, а доказательства начали бы тихо умирать на
 * восьмой день. Поэтому маршрут теперь ЗОВЁТСЯ, `fetch` подменён, и сверяется
 * адрес, по которому он реально постучался. Как эта строка собрана внутри —
 * больше не имеет значения.
 */
describe('маршрут /api/ipfs/upload действительно ведёт в постоянную корзину', () => {
  /** Куда маршрут постучится, если дать ему обычный файл. */
  async function bucketCalls(): Promise<string[]> {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => ({
      ok: true,
      json: async () => {
        seen.push(String(url));
        return { uploadUrl: 'http://relayer:3001/files/public-put/k', publicUrl: 'http://pub/x' };
      },
      text: async () => '',
    } as unknown as Response)));
    try {
      const { POST } = await import('@/app/api/ipfs/upload/route');
      const { NextRequest } = await import('next/server');
      const form = new FormData();
      form.append('file', new File([new Uint8Array([1, 2, 3])], 'evidence.pdf', { type: 'application/pdf' }));
      const res = await POST(new NextRequest('http://localhost/api/ipfs/upload', {
        method: 'POST', body: form,
      }));
      expect(res.status, 'маршрут не отработал — разбор ненадёжен').toBe(200);
      return seen;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('он стучится в постоянную корзину', async () => {
    const seen = await bucketCalls();
    // Литерал руками; ожидаемое не выведено ни из маршрута, ни из нашего кода.
    expect(seen.some((u) => u.endsWith('/files/public/presign')), `куда ходил: ${seen.join(', ')}`).toBe(true);
  });

  it('и ни разу — в чатовую, у которой TTL семь дней', async () => {
    const seen = await bucketCalls();
    for (const url of seen) expect(url).not.toMatch(/\/files\/presign$/);
  });
});

/* ── 3. отпечаток ── */

describe('отпечаток доказательства', () => {
  it('это keccak256 сырых байтов файла — тот же хэш, что в цепи', async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const digest = await evidenceDigest(new Blob([bytes]));
    // Ожидаемое считается ЧУЖОЙ реализацией (viem напрямую), а не вызовом
    // проверяемой функции.
    expect(digest).toBe(keccak256(bytes));
  });

  it('считается ДО заливки: сервер упал — 32 байта у человека уже есть', async () => {
    const fake = vi.fn(async () => { throw new Error('relayer down'); }) as unknown as typeof fetch;
    const file = new File([new Uint8Array([7, 7])], 'x.bin');
    const expected = await evidenceDigest(file);

    await expect(uploadRemovalEvidence(file, fake)).rejects.toThrow('relayer down');
    // Отпечаток от падения заливки не зависит — он функция файла, а не сервера.
    expect(await evidenceDigest(file)).toBe(expected);
  });

  it('содержимое в цепь не идёт: наружу отдаётся только отпечаток и ссылка', async () => {
    const fake = vi.fn(async () => (
      { ok: true, json: async () => ({ url: 'https://api.example/public/y' }) } as Response
    )) as unknown as typeof fetch;
    const out = await uploadRemovalEvidence(new File([new Uint8Array([1])], 'y'), fake);
    expect(Object.keys(out).sort()).toEqual(['digest', 'name', 'size', 'url']);
  });
});

/* ── 4. потолок ── */

describe('потолок на доказательство', () => {
  it('слишком большой файл отвергается ДО заливки', async () => {
    const fake = vi.fn() as unknown as typeof fetch;
    const huge = { size: MAX_EVIDENCE_BYTES + 1, name: 'big.bin' } as File;
    await expect(uploadRemovalEvidence(huge, fake)).rejects.toBeInstanceOf(EvidenceTooLargeError);
    expect(fake).not.toHaveBeenCalled();
  });

  it('тот же потолок, что у маршрута', () => {
    const source = readFileSync(ROUTE_SOURCE, 'utf8');
    const m = /MAX_FILE_SIZE\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(source);
    expect(m, 'потолок маршрута не найден — разбор устарел').not.toBeNull();
    expect(MAX_EVIDENCE_BYTES).toBe(Number(m![1]) * 1024 * 1024);
  });
});
