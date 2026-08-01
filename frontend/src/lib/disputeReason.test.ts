import { describe, it, expect, vi } from 'vitest';
import { postDisputeReason, warnDisputeReasonUnsigned } from './disputeReason';

const payload = {
  agreement: '0xAgReEmEnT',
  raiser: '0xRaIsEr',
  reason: 'Executor stopped responding after receiving the brief.',
  ts: 1_754_000_000,
  sig: '0xdeadbeef',
};

function okResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status } as Response;
}

describe('postDisputeReason', () => {
  it('отправляет причину на прокси методом POST с полным телом', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const warn = vi.fn();

    await postDisputeReason(payload, { fetchImpl: fetchImpl as never, warn });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/dispute-reason');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it('успех — true и ни одной записи в журнал', async () => {
    const warn = vi.fn();
    const ok = await postDisputeReason(payload, {
      fetchImpl: vi.fn().mockResolvedValue(okResponse()) as never,
      warn,
    });
    expect(ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  // Главный случай: `fetch` не отвергается на 4xx/5xx, поэтому прежний
  // `.catch(() => {})` пропускал отказ сервера как успех.
  it.each([400, 401, 413, 500, 502])('не-2xx (%i) — false и запись в журнал', async (status) => {
    const warn = vi.fn();
    const ok = await postDisputeReason(payload, {
      fetchImpl: vi.fn().mockResolvedValue(okResponse(status)) as never,
      warn,
    });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain(payload.agreement);
    expect(msg).toContain(String(status));
  });

  it('сетевой сбой — false, запись в журнал, наружу ничего не бросается', async () => {
    const warn = vi.fn();
    const boom = new Error('Failed to fetch');
    await expect(
      postDisputeReason(payload, {
        fetchImpl: vi.fn().mockRejectedValue(boom) as never,
        warn,
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(payload.agreement);
    expect(warn.mock.calls[0][1]).toBe(boom);
  });

  // Вызывающий продолжает открывать спор независимо от исхода — функция не
  // имеет права уронить обработчик нажатия.
  it('никогда не бросает, даже если сам fetch кинул синхронно', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(() => { throw new Error('sync boom'); });
    await expect(
      postDisputeReason(payload, { fetchImpl: fetchImpl as never, warn }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('в журнале назван адрес сделки — по нему находят потерянное изложение', async () => {
    const warn = vi.fn();
    await postDisputeReason(payload, {
      fetchImpl: vi.fn().mockResolvedValue(okResponse(500)) as never,
      warn,
    });
    expect(String(warn.mock.calls[0][0])).toContain('0xAgReEmEnT');
  });
});

describe('warnDisputeReasonUnsigned', () => {
  it('пишет в журнал адрес сделки и саму ошибку подписи', () => {
    const warn = vi.fn();
    const err = new Error('User rejected the request');
    warnDisputeReasonUnsigned('0xDeAl', err, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('0xDeAl');
    expect(warn.mock.calls[0][1]).toBe(err);
  });

  it('ничего не бросает', () => {
    expect(() => warnDisputeReasonUnsigned('0xDeAl', new Error('x'), vi.fn())).not.toThrow();
  });
});
