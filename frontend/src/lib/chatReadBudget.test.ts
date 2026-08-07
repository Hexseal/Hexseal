/**
 * chatReadBudget.test.ts — две вкладки одного человека и один бюджет склада.
 *
 * ЧТО ЗАМЕРЕНО СКВОЗНОЙ ПРОВЕРКОЙ. Склад даёт адресу `BAG_READ_RATE_MAX = 120`
 * чтений в минуту, и этот бюджет ОБЩИЙ у перечисления (`GET /bags`) и
 * скачивания (`GET /bags/:key`). Счёт при этом вёлся ПО ВКЛАДКЕ: открытая
 * переписка отмеряла себе 80 скачиваний, список переписок — 24 превью, и
 * каждая вкладка считала это заново.
 *
 * Две вкладки ОДНОГО И ТОГО ЖЕ ЧЕЛОВЕКА (что бывает постоянно: чат открыт и
 * рядом сделка) вместе просят вдвое больше, чем склад разрешает. Дальше `429`,
 * отступление до пяти минут — и чат заморожен на минуту у человека, который не
 * сделал ничего.
 *
 * ⚠️ ПОЧЕМУ СЧЁТ ОБЯЗАН ЖИТЬ ЗДЕСЬ, А НЕ В ХУКАХ. Хуков два, вкладок сколько
 * угодно, а бюджет один и он АДРЕСНЫЙ. Счётчик в хуке — это счётчик на хук на
 * вкладку, то есть заведомо не тот, который считает сервер. Единственное
 * место, через которое проходит КАЖДОЕ чтение любой вкладки, — эти две
 * функции; и единственная память, общая у вкладок одного источника, —
 * `localStorage` (плюс `navigator.locks`, чтобы две вкладки не прочитали и не
 * записали одно и то же значение разом).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Пропуск настоящей формы: `v1.<base64url(addr.exp)>.<подпись>`. */
function passFor(addr: string): string {
  const body = Buffer.from(`${addr}.9999999999`, 'utf8').toString('base64url');
  return `v1.${body}.sig`;
}

const ADDR = '0xa1ce00000000000000000000000000000000cafe';
const PASS = passFor(ADDR);

/** Общий `localStorage` двух вкладок — обычная карта, как настоящий. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    clear: () => map.clear(),
  };
  (globalThis as { localStorage?: unknown }).localStorage = store;
  return map;
}

/**
 * Склад с НАСТОЯЩИМ адресным пределом: 120 чтений в минуту, общих у
 * перечисления и скачивания. Всё сверх — `429`, ровно как у релеера.
 */
function installRelayer() {
  const seen = { reads: 0, refused: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = new URL(String(url), 'http://x');
    if (!u.pathname.startsWith('/bags')) return new Response('{}', { status: 200 });
    seen.reads++;
    if (seen.reads > 120) {
      seen.refused++;
      return new Response(JSON.stringify({ error: 'too many', code: 'rate_limited' }), {
        status: 429, headers: { 'retry-after': '60' },
      });
    }
    if (u.pathname === '/bags') {
      return new Response(JSON.stringify({ inbox: [], sent: [], peers: [] }), { status: 200 });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }));
  return seen;
}

/** Две вкладки — два экземпляра модуля, общий `globalThis`. Тот же приём и та
 *  же причина, что в `chatRecoveryTwoTabs.test.ts`. */
async function twoTabs() {
  vi.resetModules();
  const one = await import('./chatTransport');
  vi.resetModules();
  const two = await import('./chatTransport');
  expect(one.listBags).not.toBe(two.listBags); // это действительно два экземпляра
  return { one, two };
}

beforeEach(() => { installStorage(); });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('адресный бюджет чтения общий у вкладок', () => {
  it('ЗАМЕР: две вкладки по 100 чтений — сервер не отказывает НИ РАЗУ', async () => {
    // Что красит: возврат к счёту по вкладке. Тогда обе вкладки уходят в сеть
    // по сто раз каждая, сервер отбивает всё сверх 120, и `pollBags` уводит
    // опрос в отступление — чат заморожен у человека, который ничего не делал.
    const seen = installRelayer();
    const { one, two } = await twoTabs();

    const attempts = 100;
    let admittedOne = 0;
    let admittedTwo = 0;
    for (let i = 0; i < attempts; i++) {
      try { await one.fetchBag(PASS, `${ADDR}/${i}-a.bin`); admittedOne++; } catch { /* отказ бюджета */ }
      try { await two.fetchBag(PASS, `${ADDR}/${i}-b.bin`); admittedTwo++; } catch { /* отказ бюджета */ }
    }

    console.log(
      `[бюджет замер] попыток: ${attempts * 2}; ушло в сеть: ${seen.reads}; ` +
      `сервер отбил: ${seen.refused}; пропущено бюджетом: вкладка-1 ${admittedOne}, вкладка-2 ${admittedTwo}`,
    );

    // ГЛАВНОЕ: до отказа сервера дело не доходит вовсе.
    expect(seen.refused).toBe(0);
    // И в сеть ушло не больше, чем разрешает склад на минуту.
    expect(seen.reads).toBeLessThanOrEqual(120);
    // При этом бюджет не выродился в «не читаем вовсе» — обе вкладки работали.
    expect(admittedOne + admittedTwo).toBeGreaterThan(50);
  }, 60_000);

  it('ЗАМЕР: перечисление и скачивание тратят ОДИН бюджет, как на складе', async () => {
    // Отдельный замок: на складе это один счётчик, и разведи мы их — сумма
    // снова перевалила бы за 120.
    const seen = installRelayer();
    const { one } = await twoTabs();

    let lists = 0;
    for (let i = 0; i < 60; i++) {
      try { await one.listBags(PASS); lists++; } catch { /* отказ бюджета */ }
    }
    let downloads = 0;
    for (let i = 0; i < 60; i++) {
      try { await one.fetchBag(PASS, `${ADDR}/${i}-c.bin`); downloads++; } catch { /* отказ бюджета */ }
    }

    console.log(
      `[бюджет замер] перечислений ${lists} + скачиваний ${downloads} = ${lists + downloads}; ` +
      `ушло в сеть ${seen.reads}, сервер отбил ${seen.refused}`,
    );
    expect(seen.refused).toBe(0);
    expect(lists + downloads).toBeLessThanOrEqual(120);
    // Скачиванию досталось МЕНЬШЕ, чем оно просило: перечисление уже съело
    // часть общего бюджета. Если бы счётчики были разные, оба дали бы по 60.
    expect(downloads).toBeLessThan(60);
  }, 60_000);

  it('нет хранилища — не запираем: работать важнее, чем считать', async () => {
    // Приватный режим, сторонний контекст с запрещёнными куками. Считать
    // нечем; отказать всем чтениям значило бы выключить чат целиком там, где
    // он работал.
    delete (globalThis as { localStorage?: unknown }).localStorage;
    installRelayer();
    const { one } = await twoTabs();
    const body = await one.fetchBag(PASS, `${ADDR}/1-d.bin`);
    expect(body).toBeInstanceOf(Uint8Array);
  }, 60_000);
});
