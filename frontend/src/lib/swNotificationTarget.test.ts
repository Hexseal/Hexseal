/**
 * К-2, вторая половина — служебный работник (`frontend/public/sw.js`).
 *
 * Переход по уведомлению проверял происхождение У УЖЕ ОТКРЫТОГО ОКНА
 * (`client.url.startsWith(self.location.origin)`), а потом уводил это окно
 * по ссылке ИЗ УВЕДОМЛЕНИЯ — не проверив её саму. Ветка «вкладок нет» не
 * проверяла вообще ничего: `clients.openWindow(data.url)`.
 *
 * Замер опровергателя, на настоящем файле в поддельном окружении:
 *   нет вкладок     → clients.openWindow("https://evil.example/drain")
 *   вкладка открыта → client.navigate("https://evil.example/drain")
 *
 * Здесь тот же настоящий файл гоняется тем же способом. Источник обязан
 * проверяться У ЦЕЛИ.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://hexseal.com';

type Listener = (event: unknown) => void;

interface Harness {
  listeners: Record<string, Listener>;
  openWindow: ReturnType<typeof vi.fn>;
  showNotification: ReturnType<typeof vi.fn>;
  windows: Array<{ url: string; focused: boolean; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> }>;
}

/** Грузит НАСТОЯЩИЙ public/sw.js в поддельное окружение служебного работника. */
function loadServiceWorker(windows: Harness['windows'] = []): Harness {
  const src = fs.readFileSync(path.join(process.cwd(), 'public', 'sw.js'), 'utf8');

  const listeners: Record<string, Listener> = {};
  const openWindow = vi.fn(async (u: string) => ({ url: u }));
  const showNotification = vi.fn(async () => {});

  const self = {
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; },
    location: { origin: ORIGIN },
    registration: {
      showNotification,
      getNotifications: async () => [],
    },
  };
  const clients = {
    matchAll: async () => windows,
    openWindow,
  };
  const navigator = {};   // без setAppBadge — updateBadge() выходит сразу

  // `src` — наш собственный файл из репозитория, прочитанный с диска, без
  // единой подстановки: интерполяции в тело функции здесь нет и быть не
  // может. Это единственный способ прогнать НАСТОЯЩИЙ sw.js, а не его
  // перепечатку в тесте: перепечатка проверяла бы копию, а чинить надо
  // оригинал.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const run = new Function('self', 'clients', 'navigator', src);
  run(self, clients, navigator);

  return { listeners, openWindow, showNotification, windows };
}

function openTab(url: string, focused = false) {
  return { url, focused, focus: vi.fn(), navigate: vi.fn(async () => {}) };
}

/** Событие с waitUntil, который тест умеет дождаться. */
function makeEvent(extra: Record<string, unknown>) {
  const waits: Array<Promise<unknown>> = [];
  return {
    event: { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, ...extra },
    settled: () => Promise.all(waits),
  };
}

describe('К-2: переход по уведомлению проверяет источник У ЦЕЛИ', () => {
  const EVIL = 'https://evil.example/drain';

  it('ЗАМЕР ДО ПОЧИНКИ: вкладок нет → окно открывалось прямо на чужом сайте', async () => {
    const sw = loadServiceWorker([]);
    const { event, settled } = makeEvent({
      notification: { close: vi.fn(), data: { url: EVIL } },
    });

    sw.listeners.notificationclick(event);
    await settled();

    expect(sw.openWindow).toHaveBeenCalledTimes(1);
    const target = String(sw.openWindow.mock.calls[0][0]);
    expect(target.startsWith(ORIGIN) || target.startsWith('/')).toBe(true);
    expect(target).not.toContain('evil.example');
  });

  it('ЗАМЕР ДО ПОЧИНКИ: вкладка открыта → её уводили на чужой сайт', async () => {
    const tab = openTab(`${ORIGIN}/dashboard`);
    const sw = loadServiceWorker([tab]);
    const { event, settled } = makeEvent({
      notification: { close: vi.fn(), data: { url: EVIL } },
    });

    sw.listeners.notificationclick(event);
    await settled();

    const navigatedTo = tab.navigate.mock.calls.map(c => String(c[0]));
    expect(navigatedTo.every(u => !u.includes('evil.example'))).toBe(true);
  });

  it.each([
    ['абсолютный чужой',          'https://evil.example/drain'],
    ['без схемы (//)',            '//evil.example/drain'],
    ['javascript:',               'javascript:alert(1)'],
    ['data:',                     'data:text/html,<script>alert(1)</script>'],
    ['обратный слэш',             '/\\evil.example/drain'],
    ['чужой поддомен нашего',     'https://hexseal.com.evil.example/x'],
  ])('%s не уводит никуда, кроме нашего происхождения', async (_name, url) => {
    const sw = loadServiceWorker([]);
    const { event, settled } = makeEvent({
      notification: { close: vi.fn(), data: { url } },
    });

    sw.listeners.notificationclick(event);
    await settled();

    const target = new URL(String(sw.openWindow.mock.calls[0][0]), ORIGIN);
    expect(target.origin).toBe(ORIGIN);
  });

  it('своя ссылка проходит целиком, с путём и запросом', async () => {
    const sw = loadServiceWorker([]);
    const { event, settled } = makeEvent({
      notification: { close: vi.fn(), data: { url: '/chat?peer=0xabc' } },
    });

    sw.listeners.notificationclick(event);
    await settled();

    const target = new URL(String(sw.openWindow.mock.calls[0][0]), ORIGIN);
    expect(target.pathname + target.search).toBe('/chat?peer=0xabc');
  });

  it('чужая ссылка обезвреживается уже при ПОКАЗЕ, а не только при нажатии', async () => {
    const sw = loadServiceWorker([]);
    const { event, settled } = makeEvent({
      data: { json: () => ({ title: 'New message', body: '', url: EVIL, tag: 'deal' }) },
    });

    sw.listeners.push(event);
    await settled();

    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const opts = sw.showNotification.mock.calls[0][1] as { data: { url: string } };
    expect(new URL(opts.data.url, ORIGIN).origin).toBe(ORIGIN);
  });

  it('ссылка не строка вовсе — показ не падает', async () => {
    const sw = loadServiceWorker([]);
    const { event, settled } = makeEvent({
      data: { json: () => ({ title: 'x', body: '', url: { evil: true } }) },
    });

    sw.listeners.push(event);
    await expect(settled()).resolves.toBeDefined();
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
  });
});
