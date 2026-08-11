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

/**
 * НАХОДКА РЕВЬЮ: счётчик успехов выше — «раз в 5 минут, не на каждый
 * запрос», а путь ОТКАЗОВ был не защищён вовсе (`console.warn` на КАЖДЫЙ
 * отклонённый запрос). Если абузивный трафик продолжится (дешевле теперь,
 * но продолжится), в журнал польётся тот же порядок строк, где раньше было
 * около нуля — а `docker-compose.yml` ротацию логов не задаёт ни одному
 * сервису. Сведено к ТОМУ ЖЕ агрегату.
 */
function rejectableReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as never;
}

describe('/api/rpc — агрегат ОТКАЗОВ: тихо на каждом, печатается периодически', () => {
  beforeAll(async () => {
    // Смыть остаток от предыдущего блока (там нарочно копился eth_call=…
    // между печатями) — иначе первый отказ здесь считался бы поверх чужого
    // хвоста, и числа ниже не отвечали бы за само число отказов.
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    logSpy.mockClear();
  });

  it('ни один отклонённый гейтом запрос не пишет строку в журнал сразу (ни console.warn, ни console.log)', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    warnSpy.mockClear();
    logSpy.mockClear();

    const bigBatch = Array.from({ length: 50 }, (_, i) => ({ jsonrpc: '2.0', method: 'eth_call', id: i }));
    for (let i = 0; i < 5; i++) {
      const res = await POST(rejectableReq(bigBatch, { 'x-forwarded-for': `203.0.113.${i}` }));
      expect(res.status).toBe(400);
    }
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('спустя интервал печати — строка «отказы» с ПРИЧИНОЙ и настоящим счётом, разными гейтами по отдельности', async () => {
    // Смыть 5 batch_too_large из предыдущего теста — тот тест нарочно НЕ
    // печатает (проверяет тишину), значит они всё ещё в карте. Без этого
    // числа ниже отвечали бы за чужой тест, а не за этот.
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    logSpy.mockClear();

    const bigBatch = Array.from({ length: 50 }, (_, i) => ({ jsonrpc: '2.0', method: 'eth_call', id: i }));
    const badMethod = { jsonrpc: '2.0', method: 'debug_traceTransaction', params: [], id: 1 };

    // 3 отказа по потолку пачки, 2 отказа по списку методов — разные причины,
    // разные числа: строка обязана различать их, а не сваливать в одну кучу.
    for (let i = 0; i < 3; i++) {
      await POST(rejectableReq(bigBatch, { 'x-forwarded-for': `198.51.100.${10 + i}` }));
    }
    for (let i = 0; i < 2; i++) {
      await POST(rejectableReq(badMethod, { 'x-forwarded-for': `198.51.100.${20 + i}` }));
    }

    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);

    const rejectLine = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('отказы'));
    expect(rejectLine).toBeTruthy();
    expect(rejectLine).toContain('batch_too_large=3');
    expect(rejectLine).toContain('method_not_allowed:debug_traceTransaction=2');
  });

  it('период без отказов — строки «отказы» нет вовсе (не печатает пустой агрегат)', async () => {
    logSpy.mockClear();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    const rejectLine = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('отказы'));
    expect(rejectLine).toBeUndefined();
  });
});
