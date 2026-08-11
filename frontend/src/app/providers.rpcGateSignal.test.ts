/**
 * НАХОДКА РЕВЬЮ: `/api/rpc`-гейты (потолок пачки/тела, список методов,
 * лимитер, происхождение) отвечают честной JSON-RPC-ошибкой, но её никто
 * не смотрит — `DealCard.tsx`'s `useReadContracts` без `isError`,
 * `useNotifications`/`useDealLiveRefresh` только логируют. Экран застывает
 * и это неотличимо от факта. Починка — в `providers.tsx`: viem http-
 * транспорта `onFetchResponse` перехватывает ответ ДО того, как он
 * долетает до экранов, и поднимает видимый тост при отказе НАШЕГО гейта.
 *
 * Классификация/троттлинг (`createRpcGateSignal`) уже покрыта без DOM в
 * `lib/rpcProxy.test.ts`. ЭТОТ файл — другое: доказывает, что
 * `providers.tsx` РЕАЛЬНО подключает эту функцию к настоящему `toast()` и
 * к настоящему собранному транспорту, а не держит её сиротой в импорте.
 * Без этого файла правка `createRpcGateSignal` могла бы существовать и
 * никогда не влиять ни на что — ровно тот класс дефекта, о котором в
 * `docs/PROCESS.md`.
 *
 * `SUBGRAPH_URL` выставлен ДО импорта: `providers.tsx` строит urql-клиент
 * (`lib/graph.ts`) на уровне модуля, и без URL конструктор бросает ещё до
 * того, как код дойдёт до транспортов, которые здесь и проверяются.
 *
 * Фейковые часы — ДО импорта, тем же приёмом, что `route.counters.test.ts`:
 * `onRpcGateSignal` строится в `providers.tsx` БЕЗ инъекции `now` (в
 * настоящем приложении так и должно быть — реальные часы вкладки), поэтому
 * его троттлинг («не чаще раза в минуту») использует `Date.now()`
 * НАПРЯМУЮ. Тесты в этом файле идут друг за другом за миллисекунды
 * реального времени — без фейковых часов второй тест на «поднялся тост»
 * попал бы в то же окно остывания, что и первый, и результат зависел бы от
 * порядка запуска, а не от правильности кода.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

process.env.SUBGRAPH_URL = 'http://localhost/graph';

const toastMock = vi.fn();
vi.mock('react-hot-toast', () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

vi.useFakeTimers();
vi.setSystemTime(0);

const { onRpcGateSignal, clientRpcTransport } = await import('./providers');
const { appChain } = await import('@/config/chain');
const { GATE_SIGNAL_MESSAGE, GATE_SIGNAL_COOLDOWN_MS } = await import('@/lib/rpcProxy');

function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Каждый тест, который вправе поднять сигнал, получает СВОЙ, далеко отстоящий
// момент времени — гарантированно вне минуты остывания предыдущего такого
// теста, независимо от порядка запуска.
let _clock = 0;
function freshMoment(): number {
  _clock += GATE_SIGNAL_COOLDOWN_MS * 10;
  return _clock;
}

beforeAll(() => {
  toastMock.mockClear();
});

describe('providers.tsx — сигнал на отказ гейта /api/rpc подключён к настоящему toast()', () => {
  it('отказ нашего гейта (429, -32005) — toast() позван с текстом задачи', async () => {
    toastMock.mockClear();
    vi.setSystemTime(freshMoment());
    await onRpcGateSignal(fakeResponse(429, { jsonrpc: '2.0', error: { code: -32005, message: 'Rate limit exceeded' }, id: null }));
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toBe(GATE_SIGNAL_MESSAGE);
  });

  it('успешный ответ — toast() не позван', async () => {
    toastMock.mockClear();
    vi.setSystemTime(freshMoment());
    await onRpcGateSignal(fakeResponse(200, { jsonrpc: '2.0', result: '0x1', id: 1 }));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('502 апстрима (-32603, не наш гейт) — toast() не позван', async () => {
    toastMock.mockClear();
    vi.setSystemTime(freshMoment());
    await onRpcGateSignal(fakeResponse(502, { jsonrpc: '2.0', error: { code: -32603 }, id: null }));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('СКВОЗНОЙ ЗАМЕР: настоящий вызов через собранный viem-транспорт (не напрямую onRpcGateSignal) тоже поднимает тост', async () => {
    // Это — прицельный замок на саму СБОРКУ `transports` в providers.tsx:
    // снять `onFetchResponse: onRpcGateSignal` при сборе `clientRpcTransport`
    // и оставить экспорт `onRpcGateSignal` сиротой — предыдущие тесты этого
    // файла (зовут `onRpcGateSignal` напрямую) такую порчу НЕ поймают.
    // Здесь — настоящий EIP-1193 `.request()`, настоящий (подменённый)
    // `fetch`, тот же путь, которым идёт viem в браузере.
    toastMock.mockClear();
    vi.setSystemTime(freshMoment());

    const fetchMock = vi.fn(async () => fakeResponse(429, {
      jsonrpc: '2.0', error: { code: -32005, message: 'Rate limit exceeded' }, id: 1,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const transport = clientRpcTransport({ chain: appChain, retryCount: 0 });
    await expect(transport.request({ method: 'eth_call', params: [] })).rejects.toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toBe(GATE_SIGNAL_MESSAGE);

    vi.unstubAllGlobals();
  });

  it('троттлинг настоящий: два отказа подряд (без freshMoment между ними) — ОДИН тост, не два', async () => {
    toastMock.mockClear();
    const t = freshMoment();
    vi.setSystemTime(t);
    await onRpcGateSignal(fakeResponse(400, { jsonrpc: '2.0', error: { code: -32600 }, id: null }));
    vi.setSystemTime(t + 30_000); // 30 с спустя — ещё внутри минуты остывания
    await onRpcGateSignal(fakeResponse(400, { jsonrpc: '2.0', error: { code: -32600 }, id: null }));
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});
