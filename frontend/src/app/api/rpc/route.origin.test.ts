/**
 * Гейт происхождения (4-й, последний) — отдельный файл, потому что
 * `ALLOWED_ORIGINS` читается ОДИН РАЗ на уровне модуля (тот же приём, что у
 * `PUSH_SECRET`/`RELAYER_URL` в `api/push/route.ts` и у `ALLOWED_ORIGINS` в
 * `relayer/app.js`) — задать его нужно ДО динамического импорта, а второй
 * `.test.ts`-файл в этом же каталоге (`route.test.ts`) намеренно проверяет
 * ПРОТИВОПОЛОЖНЫЙ случай (переменная не задана вовсе) с тем же модулем.
 * Vitest изолирует модульный граф по файлам — значит два разных значения
 * `ALLOWED_ORIGINS` не конфликтуют.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.ALLOWED_ORIGINS = 'https://hexseal.net, https://www.hexseal.net';

const { POST } = await import('./route');

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: '0x1', id: 1 }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
});

function req(headers: Record<string, string>) {
  const CALL = { jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0xabc', data: '0x1234' }], id: 1 };
  return new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(CALL),
  }) as never;
}

describe('/api/rpc — гейт 4: происхождение (ALLOWED_ORIGINS задан)', () => {
  it('свой origin из списка — проходит', async () => {
    const res = await POST(req({ origin: 'https://hexseal.net', 'x-forwarded-for': '198.51.100.20' }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('www-поддомен из списка — тоже проходит (это ОТДЕЛЬНАЯ строка списка, не префикс-угадывание)', async () => {
    const res = await POST(req({ origin: 'https://www.hexseal.net', 'x-forwarded-for': '198.51.100.21' }));
    expect(res.status).toBe(200);
  });

  it('чужой origin — отказ 403, fetch не позван', async () => {
    const res = await POST(req({ origin: 'https://evil.example', 'x-forwarded-for': '198.51.100.22' }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('устаревший (несуществующий) домен hexseal.io — НЕ в списке, отказ: ровно тот рассинхрон, который замечен в .env.vps.example', async () => {
    const res = await POST(req({ origin: 'https://hexseal.io', 'x-forwarded-for': '198.51.100.23' }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('нет заголовка Origin вовсе (curl-подобный запрос) — эта проверка его не ловит, проходит', async () => {
    const res = await POST(req({ 'x-forwarded-for': '198.51.100.24' }));
    expect(res.status).toBe(200);
  });

  it('Sec-Fetch-Site: cross-site — отказ, даже если бы Origin что-то странное сказал', async () => {
    const res = await POST(req({
      origin: 'https://hexseal.net',
      'sec-fetch-site': 'cross-site',
      'x-forwarded-for': '198.51.100.25',
    }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
