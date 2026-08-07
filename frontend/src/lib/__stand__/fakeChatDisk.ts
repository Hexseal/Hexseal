/**
 * fakeChatDisk.ts — общий диск для стендов сеанса чата.
 *
 * ⚠️ ЗАЧЕМ ОБЩИЙ, А НЕ ПО КОПИИ В КАЖДОМ ФАЙЛЕ. Две подделки одного и того
 * же хранилища расходятся со временем, и расходятся молча: один стенд
 * начинает мерить не то, что другой, а выглядят оба одинаково зелёными. В
 * этой же задаче уже был случай, когда числа врал стенд, а не код (подделка
 * замка с неверной сигнатурой) — второй такой случай незачем создавать
 * копипастой.
 *
 * Подделка НАРОЧНО минимальная: общий диск двух вкладок и запись, видимая
 * следующему читателю. Все отказы хранилища (квота, блокировка, молчание,
 * откат транзакции) замерены в `chatSession.test.ts` своим, куда более
 * придирчивым стендом — задваивать его здесь значило бы получить ровно ту
 * расходящуюся пару, ради избежания которой этот файл и заведён.
 *
 * ⚠️ ЗАМОК МЕЖДУ ВКЛАДКАМИ НЕ ПОДДЕЛЫВАЕТСЯ ВОВСЕ. Node 24 отдаёт настоящий
 * `navigator.locks` (Web Locks), общий на процесс — то есть ровно то, чем он
 * является для двух вкладок одного источника. Замерено:
 * `typeof globalThis.navigator.locks === 'object'` на node v24.12.0.
 */
/*
 * ⚠️ `vitest` ЗДЕСЬ НЕ ИМПОРТИРУЕТСЯ. Пакет лежит в `../relayer/node_modules`
 * и `npm run type-check` его не видит вовсе (та же причина и тот же обход
 * описаны в `chatStand.ts`). Поэтому подделка ставится прямым присваиванием
 * в `globalThis` и снимается своим же `restore()`, а не `vi.stubGlobal` —
 * заодно исчезает зависимость общего стенда от раннера.
 */

type Cb = ((ev: unknown) => void) | null;

class Req {
  onsuccess: Cb = null;
  onerror: Cb = null;
  onupgradeneeded: Cb = null;
  onblocked: Cb = null;
  result: unknown;
}

export interface FakeDiskControl {
  /** Запись молча не проходит — приватный режим, кончившаяся квота.
   *  Сеанс при этом обязан работать, но с `persisted: false`. */
  failPut?: boolean;
}

export interface FakeChatDisk {
  /** Каталог «устройства». Обычная `Map`: два экземпляра модуля
   *  (`vi.resetModules()` дважды) видят ОДИН диск, как две вкладки. */
  disk: Map<string, unknown>;
  /** Вернуть `globalThis.indexedDB` как было. Звать в `afterEach`. */
  restore: () => void;
}

interface FakeTx {
  oncomplete: Cb;
  onerror: Cb;
  onabort: Cb;
  error: unknown;
  done: () => void;
  fail: () => void;
  objectStore: () => unknown;
}

/** Ставит подделку `indexedDB` и возвращает диск вместе со способом снять её. */
export function installFakeChatDisk(control: FakeDiskControl = {}): FakeChatDisk {
  const disk = new Map<string, unknown>();

  const store = (tx: FakeTx) => ({
    get(key: string) {
      const r = new Req();
      queueMicrotask(() => { r.result = structuredClone(disk.get(key)); r.onsuccess?.({}); tx.done(); });
      return r;
    },
    put(value: unknown, key: string) {
      const r = new Req();
      queueMicrotask(() => {
        if (control.failPut) {
          // ⚠️ КАК НА САМОМ ДЕЛЕ: непогашенная ошибка запроса ОТМЕНЯЕТ
          // транзакцию целиком, и `idbPut` ждёт именно этого (`tx.onabort`),
          // а не ошибки на запросе. Первая версия подделки звала `onerror`
          // на запросе и всё равно фиксировала транзакцию — сеанс приходил
          // с `persisted: true` при неработающей записи, то есть подделка
          // была СНИСХОДИТЕЛЬНЕЕ браузера и мерила не то.
          r.onerror?.({});
          tx.fail();
        } else {
          disk.set(key, structuredClone(value));
          r.onsuccess?.({});
          tx.done();
        }
      });
      return r;
    },
    delete(key: string) {
      const r = new Req();
      queueMicrotask(() => { disk.delete(key); r.onsuccess?.({}); tx.done(); });
      return r;
    },
  });

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    close: () => {},
    transaction() {
      const tx: FakeTx = {
        oncomplete: null, onerror: null, onabort: null, error: null,
        done: () => queueMicrotask(() => tx.oncomplete?.({})),
        fail: () => queueMicrotask(() => {
          tx.error = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          tx.onabort?.({});
        }),
        objectStore: () => store(tx),
      };
      return tx;
    },
  };

  const host = globalThis as { indexedDB?: unknown };
  const had = Object.prototype.hasOwnProperty.call(host, 'indexedDB');
  const previous = host.indexedDB;

  host.indexedDB = {
    open() {
      const r = new Req();
      queueMicrotask(() => { r.result = db; r.onsuccess?.({}); });
      return r;
    },
  };

  return {
    disk,
    restore: () => {
      if (had) host.indexedDB = previous;
      else delete host.indexedDB;
    },
  };
}
