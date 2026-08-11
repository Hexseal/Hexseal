/**
 * §5 замысла, клиентская половина замка выдачи: скачивание вложения везёт
 * пропуск склада — тот же, которым уже пользуется переписка и заливка, из той
 * же кладовой, БЕЗ нового окна кошелька.
 *
 * Замер по БАЙТАМ, УХОДЯЩИМ НАРУЖУ (правило проекта): смотрим, что реально
 * попало в `fetch`, а не на то, что функция «вроде бы умеет».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { decryptToObjectUrl, decryptAndSaveChunked } = await import('./fileCrypto');

const ME = '0xaaaa000000000000000000000000000000000001';
const PASS_STORAGE_PREFIX = 'hexseal_bagpass_';   // тот же, что пишет lib/chatTransport.ts

/** Умолчание `NEXT_PUBLIC_RELAYER_URL` в fileCrypto — доверенный источник. */
const ORIGIN = 'http://localhost:3001';

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

const g = globalThis as unknown as { localStorage?: unknown };
let savedStorage: unknown;
let savedCreate: unknown;
let fetchMock: ReturnType<typeof vi.fn>;
let key: CryptoKey;
let keyHex: string;
let ivHex: string;
let ciphertext: ArrayBuffer;

function hex(b: Uint8Array) { return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(''); }

beforeEach(async () => {
  savedStorage = g.localStorage;
  g.localStorage = fakeStorage();

  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  keyHex = hex(raw); ivHex = hex(iv);
  key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('файл'));

  fetchMock = vi.fn(async () => new Response(ciphertext, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  // Node-среда: объектных URL нет. Подменяем только этот метод — `new URL()`
  // нужен живым, им проверяется доверенность адреса вложения.
  savedCreate = (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:test';
});

afterEach(() => {
  if (savedStorage === undefined) delete g.localStorage; else g.localStorage = savedStorage;
  if (savedCreate === undefined) delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  else (URL as unknown as { createObjectURL: unknown }).createObjectURL = savedCreate;
  vi.unstubAllGlobals();
});

function storePass(addr: string, pass: string) {
  (g.localStorage as Storage).setItem(
    PASS_STORAGE_PREFIX + addr.toLowerCase(),
    JSON.stringify({ pass, expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
  );
}

function storePassWithExpiry(addr: string, pass: string, expiresInSec: number) {
  (g.localStorage as Storage).setItem(
    PASS_STORAGE_PREFIX + addr.toLowerCase(),
    JSON.stringify({ pass, expiresAt: Math.floor(Date.now() / 1000) + expiresInSec }),
  );
}

function headersOfCall(i: number): Record<string, string> {
  const [, init] = fetchMock.mock.calls[i] as [string, RequestInit | undefined];
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('скачивание вложения предъявляет пропуск склада', () => {
  it('decryptToObjectUrl везёт x-bag-pass', async () => {
    storePass(ME, 'v1.mine.mac');
    const url = await decryptToObjectUrl(`${ORIGIN}/files/one.bin`, keyHex, ivHex, 'text/plain');
    expect(url).toBe('blob:test');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headersOfCall(0)['x-bag-pass']).toBe('v1.mine.mac');
  });

  it('decryptAndSaveChunked везёт x-bag-pass', async () => {
    storePass(ME, 'v1.mine.mac');
    // ⚠️ НАЗЫВАЮ ВСЛУХ: дальше ветка сохранения требует окна браузера
    // (`'showSaveFilePicker' in window`, `document.createElement`), которого у
    // тестов нет (правило 6 плана). Нас интересует РОВНО то, что уехало в
    // сеть, а сеть трогается ДО окна — поэтому отказ после запроса не мешает
    // замеру и глотается намеренно.
    await decryptAndSaveChunked(`${ORIGIN}/files/two.bin`, keyHex, ivHex, 'f.bin', undefined, 1, 8, 4)
      .catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headersOfCall(0)['x-bag-pass']).toBe('v1.mine.mac');
  });

  it('пропуска в кладовой нет — запрос уходит БЕЗ заголовка, решает сервер', async () => {
    // Не бросаем: единственный источник истины про доступ — сервер. Своё
    // предсказание «пропуска нет, значит не пустят» было бы вторым мнением
    // рядом с настоящим, и разошлось бы с ним при первом же изменении правил.
    await decryptToObjectUrl(`${ORIGIN}/files/three.bin`, keyHex, ivHex).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headersOfCall(0)).not.toHaveProperty('x-bag-pass');
  });

  describe('два аккаунта на устройстве — подсказка адреса решает, чей пропуск едет', () => {
    // Итоговое ревью 4в-1: `findStoredBagPass()` без подсказки берёт САМЫЙ
    // ДОЛГОЖИВУЩИЙ пропуск устройства. На устройстве с двумя аккаунтами это
    // может оказаться пропуск ЧУЖОГО — свой протухает раньше (обычный ход
    // событий: чужой аккаунт залогинился позже и получил более свежий срок),
    // а склад тогда отвечает 403 `not_your_file` на СОБСТВЕННОМ вложении.
    const FOREIGN = '0xbbbb000000000000000000000000000000000002';

    beforeEach(() => {
      // Свой — истекает раньше (близкий срок). Чужой — истекает позже
      // (дальний срок). Без подсказки «самый долгоживущий» — это чужой.
      storePassWithExpiry(ME, 'v1.mine.mac', 600);
      storePassWithExpiry(FOREIGN, 'v1.foreign.mac', 7200);
    });

    it('БЕЗ подсказки берётся пропуск с дальним сроком — то есть ЧУЖОЙ', async () => {
      const url = await decryptToObjectUrl(`${ORIGIN}/files/mine.bin`, keyHex, ivHex, 'text/plain');
      expect(url).toBe('blob:test');
      expect(headersOfCall(0)['x-bag-pass']).toBe('v1.foreign.mac');
    });

    it('С подсказкой своего адреса берётся СВОЙ пропуск, несмотря на более близкий срок', async () => {
      const url = await decryptToObjectUrl(`${ORIGIN}/files/mine.bin`, keyHex, ivHex, 'text/plain', ME);
      expect(url).toBe('blob:test');
      expect(headersOfCall(0)['x-bag-pass']).toBe('v1.mine.mac');
    });

    it('decryptAndSaveChunked тоже слушает подсказку', async () => {
      await decryptAndSaveChunked(`${ORIGIN}/files/mine2.bin`, keyHex, ivHex, 'f.bin', undefined, 1, 8, 4, undefined, ME)
        .catch(() => {});
      expect(headersOfCall(0)['x-bag-pass']).toBe('v1.mine.mac');
    });
  });
});
