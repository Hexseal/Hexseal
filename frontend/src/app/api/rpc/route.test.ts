/**
 * `/api/rpc` был открытым прокси к платному узлу drpc: тело пересылалось как
 * есть, без потолка на пачку/тело, без списка методов, без лимитера частоты.
 * ~150 000 запросов в сутки на панели drpc, источник неизвестен.
 *
 * Логика гейтов — чистые функции в `lib/rpcProxy.ts`, проверенные там без
 * сети. Здесь — ДРУГОЕ: что сам маршрут их реально ЗОВЁТ в нужном порядке и
 * отвечает нужным статусом, теми же приёмами, что и сосед `api/push/route.ts`
 * (`POST()` напрямую, `fetch` подменён). Без этого лок в библиотеке мог бы
 * существовать и не влиять ни на что — класс дефекта, которого этот файл и
 * призван не допустить.
 *
 * `ALLOWED_ORIGINS` намеренно НЕ задан здесь — это тесты гейтов 1-3
 * (пачка/тело, методы, частота) при ВЫКЛЮЧЕННОЙ проверке происхождения
 * (умолчание). Сам гейт происхождения — `route.origin.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_BATCH_SIZE, MAX_BODY_BYTES, RPC_RATE_MAX } from '@/lib/rpcProxy';

// ⚠️ ОБЯЗАТЕЛЬНО ДО ИМПОРТА. Рабочий каталог репозитория ходит под direnv
// (`.envrc: dotenv`), а корневой `.env` реально задаёт `ALLOWED_ORIGINS` —
// то есть просто «не задавать переменную в тесте» НЕ значит «она пуста»:
// оболочка, из которой запускается `npm test`, уже могла унаследовать
// боевое значение. Замерено: без этой строки мутация в `isOriginAllowed`
// (пустой список → «отказ» вместо «пропуск») проходила МИМО этого файла —
// не потому что маршрут её ловит, а потому что список ВСЁ РАВНО не был
// пуст. Этот файл проверяет гейты 1-3 при ВЫКЛЮЧЕННОМ гейте 4 — и обязан
// гарантировать это сам, не полагаясь на то, что оболочка её не задала.
delete process.env.ALLOWED_ORIGINS;

const { POST } = await import('./route');

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: '0x1', id: 1 }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
});

function req(body: unknown, headers: Record<string, string> = {}, rawBody?: string) {
  return new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody ?? JSON.stringify(body),
  }) as never;
}

const CALL = { jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0xabc', data: '0x1234' }], id: 1 };

describe('/api/rpc — гейт 1: потолок пачки и тела', () => {
  it('одиночный разрешённый вызов проходит и уходит в fetch', async () => {
    const res = await POST(req(CALL, { 'x-forwarded-for': '198.51.100.1' }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('пачка РОВНО на потолке — проходит', async () => {
    const batch = Array.from({ length: MAX_BATCH_SIZE }, (_, i) => ({ ...CALL, id: i }));
    const res = await POST(req(batch, { 'x-forwarded-for': '198.51.100.2' }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('пачка длиннее потолка на единицу — отказ, fetch не позван', async () => {
    const batch = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({ ...CALL, id: i }));
    const res = await POST(req(batch, { 'x-forwarded-for': '198.51.100.3' }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const j = await res.json();
    expect(j.error.message).toContain(String(MAX_BATCH_SIZE + 1));
  });

  it('ЗАМЕР: пачка в сто раз больше потолка (класс амплификации, ради которого всё заведено) — тоже отказ', async () => {
    // На такой длине пачки тело заодно перевалит и потолок байт — отказ
    // законно может прийти любым из двух гейтов (1а или 1б); важно, что он
    // приходит, и что fetch НИ РАЗУ не позван — амплификация не проезжает.
    const batch = Array.from({ length: MAX_BATCH_SIZE * 100 }, (_, i) => ({ ...CALL, id: i }));
    const res = await POST(req(batch, { 'x-forwarded-for': '198.51.100.4' }));
    expect([400, 413]).toContain(res.status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ЗАМЕР: пачка в сто раз больше потолка, но КАЖДЫЙ вызов крошечный — тело меньше потолка, ловит именно счётчик пачки', async () => {
    // Минимальный по байтам вызов (короткий метод, без params) — так тело
    // остаётся МЕНЬШЕ MAX_BODY_BYTES даже при MAX_BATCH_SIZE×100 элементах,
    // и единственный гейт, который может сработать, — счётчик пачки (1б).
    const batch = Array.from({ length: MAX_BATCH_SIZE * 100 }, (_, i) => ({ jsonrpc: '2.0', method: 'eth_blockNumber', id: i }));
    const text = JSON.stringify(batch);
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_BODY_BYTES);
    const res = await POST(req(null, { 'x-forwarded-for': '198.51.100.41' }, text));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.message).toContain(String(MAX_BATCH_SIZE * 100));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('тело больше потолка байт — отказ 413, fetch не позван, парсинг не тратится (мусорный текст, не валидный JSON)', async () => {
    const huge = 'x'.repeat(MAX_BODY_BYTES + 1);
    const res = await POST(req(null, { 'x-forwarded-for': '198.51.100.5' }, huge));
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('тело чуть меньше потолка — проходит гейт тела (упадёт позже разбором JSON, но не здесь)', async () => {
    // Валидный вызов, раздутый безобидным по смыслу, но большим по байтам полем.
    const padded = { ...CALL, params: [{ to: '0xabc', data: '0x' + '00'.repeat(1000) }] };
    const text = JSON.stringify(padded);
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_BODY_BYTES);
    const res = await POST(req(null, { 'x-forwarded-for': '198.51.100.6' }, text));
    expect(res.status).toBe(200);
  });
});

describe('/api/rpc — гейт 2: лимитер частоты по IP', () => {
  it('в пределах потолка проходят все, за потолком — 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < RPC_RATE_MAX + 20; i++) {
      const res = await POST(req(CALL, { 'x-forwarded-for': '203.0.113.50' }));
      statuses.push(res.status);
    }
    const throttled = statuses.filter(s => s === 429).length;
    expect(throttled).toBe(20);
    expect(fetchMock.mock.calls.length).toBe(RPC_RATE_MAX);
  });

  it('исчерпавший потолок источник мешает только своему IP', async () => {
    for (let i = 0; i < RPC_RATE_MAX + 5; i++) {
      await POST(req(CALL, { 'x-forwarded-for': '203.0.113.60' }));
    }
    const other = await POST(req(CALL, { 'x-forwarded-for': '203.0.113.61' }));
    expect(other.status).toBe(200);
  });

  it('X-Forwarded-For берёт ПОСЛЕДНИЙ прыжок — подмена первого не открывает свежий лимит', async () => {
    for (let i = 0; i < RPC_RATE_MAX; i++) {
      await POST(req(CALL, { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.70` }));
    }
    // Первый прыжок каждый раз разный (подделан клиентом), последний — один и тот же
    // (наш ближайший прокси). Лимит обязан сработать по последнему.
    const res = await POST(req(CALL, { 'x-forwarded-for': '10.0.0.999, 203.0.113.70' }));
    expect(res.status).toBe(429);
  });

  it('CF-Connecting-IP приоритетнее X-Forwarded-For', async () => {
    for (let i = 0; i < RPC_RATE_MAX; i++) {
      await POST(req(CALL, { 'cf-connecting-ip': '203.0.113.80', 'x-forwarded-for': `1.1.1.${i}` }));
    }
    const res = await POST(req(CALL, { 'cf-connecting-ip': '203.0.113.80', 'x-forwarded-for': '9.9.9.9' }));
    expect(res.status).toBe(429);
  });

  /* ═══ НАХОДКА РЕВЬЮ (Critical): гейт методов раньше стоял ДО лимитера ═══
   * Запрос с запрещённым методом отклонялся 400-м раньше, чем доходил до
   * счётчика частоты — то есть отправлялся сколько угодно раз в секунду с
   * одного IP БЕЗ ограничения. Лимитер переставлен раньше — тесты ниже
   * доказывают именно это, а не факт существования обоих гейтов по
   * отдельности (это уже покрыто выше и в следующем describe).
   */
  it('ЗАМЕР: запросы с ЗАПРЕЩЁННЫМ методом теперь тоже упираются в потолок частоты', async () => {
    const badCall = { jsonrpc: '2.0', method: 'debug_traceTransaction', params: [], id: 1 };
    const statuses: number[] = [];
    for (let i = 0; i < RPC_RATE_MAX + 20; i++) {
      const res = await POST(req(badCall, { 'x-forwarded-for': '203.0.113.90' }));
      statuses.push(res.status);
    }
    const rateLimited = statuses.filter(s => s === 429).length;
    const methodRejected = statuses.filter(s => s === 400).length;
    // До находки: 400 без предела (RPC_RATE_MAX+20 раз), 429 — НИ РАЗУ.
    expect(methodRejected).toBe(RPC_RATE_MAX); // не больше потолка проехало ДО лимитера
    expect(rateLimited).toBe(20);
    expect(fetchMock).not.toHaveBeenCalled(); // метод всё равно не разрешён — fetch не идёт
  });

  it('ПОРЯДОК: источник, уже исчерпавший потолок валидными вызовами, получает 429 даже на запрещённый метод (не 400)', async () => {
    for (let i = 0; i < RPC_RATE_MAX; i++) {
      await POST(req(CALL, { 'x-forwarded-for': '203.0.113.91' }));
    }
    const res = await POST(req(
      { jsonrpc: '2.0', method: 'debug_traceTransaction', params: [], id: 1 },
      { 'x-forwarded-for': '203.0.113.91' },
    ));
    // Если бы список методов проверялся раньше, здесь был бы 400 (метод
    // запрещён) — 429 доказывает, что лимитер сработал ПЕРВЫМ.
    expect(res.status).toBe(429);
  });
});

describe('/api/rpc — гейт 3: список разрешённых методов', () => {
  it('неразрешённый метод — отказ 400, fetch не позван', async () => {
    const res = await POST(req({ jsonrpc: '2.0', method: 'debug_traceTransaction', params: [], id: 1 }, {
      'x-forwarded-for': '198.51.100.10',
    }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const j = await res.json();
    expect(j.error.message).toContain('debug_traceTransaction');
  });

  it('пачка со ХОТЯ БЫ одним неразрешённым методом — отказ целиком, ни один вызов не уезжает', async () => {
    const res = await POST(req([
      CALL,
      { jsonrpc: '2.0', method: 'trace_block', params: [], id: 2 },
    ], { 'x-forwarded-for': '198.51.100.11' }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('eth_sendRawTransaction — отказ: этот путь никогда не идёт через /api/rpc', async () => {
    const res = await POST(req({ jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: ['0xdead'], id: 1 }, {
      'x-forwarded-for': '198.51.100.12',
    }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/api/rpc — parse error по-прежнему первым делом (не задет новыми гейтами)', () => {
  it('невалидный JSON — 400 с кодом -32700, fetch не позван', async () => {
    const res = await POST(req(null, { 'x-forwarded-for': '198.51.100.99' }, 'не json{'));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.code).toBe(-32700);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
