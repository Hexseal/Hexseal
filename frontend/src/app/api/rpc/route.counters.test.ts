/**
 * Пункт 5 задачи: счётчик методов в журнал. Владелец хочет знать ЧИСЛОМ,
 * кто ест 150 000 запросов в сутки — свои или чужие. Требование было явным:
 * копить агрегат, но НЕ печатать его на каждый успешный запрос — иначе
 * журнал сам становится второй бедой (тем же классом, что и открытый прокси
 * до этого разреза, только по объёму строк, а не по деньгам).
 *
 * Отдельный файл — фейковые таймеры вступают в силу ДО динамического
 * импорта `route.ts` (его `setInterval` регистрируется на уровне модуля), а
 * остальные `.test.ts`-файлы этого маршрута реальными таймерами не
 * пользуются вовсе — смешивать их в одном файле лишний риск.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.useFakeTimers();
const { POST } = await import('./route');

let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: '0x1', id: 1 }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  logSpy = vi.spyOn(console, 'log');
});

function req(headers: Record<string, string> = {}) {
  const CALL = { jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0xabc', data: '0x1234' }], id: 1 };
  return new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(CALL),
  }) as never;
}

const FIVE_MIN_MS = 5 * 60_000;

describe('/api/rpc — счётчик методов: тихо на успехе, печатается периодически', () => {
  it('ни один успешный запрос не пишет строку агрегата в журнал', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await POST(req({ 'x-forwarded-for': `192.0.2.${i}` }));
      expect(res.status).toBe(200);
    }
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('спустя интервал печати — ОДНА строка с именем метода и настоящим счётом (не мёртвый таймер)', async () => {
    // К пяти запросам до этого момента добавим ещё три — итог 8, и строка
    // обязана назвать именно 8, а не 3 и не 5: замер того, что счётчик
    // копится МЕЖДУ печатями, а не обнуляется на каждом запросе.
    for (let i = 0; i < 3; i++) {
      await POST(req({ 'x-forwarded-for': `192.0.2.9${i}` }));
    }
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0][0]);
    expect(line).toContain('eth_call=8');
  });

  it('следующий интервал без новых запросов — счётчик пуст, ВТОРОЙ строки нет (не печатает пустоту)', async () => {
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(logSpy).toHaveBeenCalledTimes(1); // так и осталась одна с прошлого шага
  });

  it('после печати счётчик сброшен: следующий отчёт считает заново, не накапливает прошлое', async () => {
    await POST(req({ 'x-forwarded-for': '192.0.2.200' }));
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(logSpy).toHaveBeenCalledTimes(2);
    const line = String(logSpy.mock.calls[1][0]);
    expect(line).toContain('eth_call=1');
  });
});
