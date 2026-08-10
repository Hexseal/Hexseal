import { describe, it, expect, vi, beforeEach } from 'vitest';
import { claimKeysFromSession, createGatedSignChatKey, rethrowIfSignatureDeferred } from './arbiterClaimKeys';
import { ZERO_KEY } from './arbiterChatKey';
import { ChatSignatureDeferred } from './chatSignatureGate';

describe('добыча ключей для заявки', () => {
  it('обе половины отдаются как 0x + 64 hex', async () => {
    const session = {
      keypair: {
        publicKey: new Uint8Array(32).fill(0xab),
        privateKey: new Uint8Array(32).fill(0xcd),
      },
    };
    const keys = await claimKeysFromSession(session as any);
    expect(keys.boxKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keys.signKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('открытая половина шифрования берётся из сессии как есть', async () => {
    const session = {
      keypair: {
        publicKey: new Uint8Array(32).fill(0xab),
        privateKey: new Uint8Array(32).fill(0xcd),
      },
    };
    const keys = await claimKeysFromSession(session as any);
    expect(keys.boxKey).toBe('0x' + 'ab'.repeat(32));
  });

  it('половина подписи ОТЛИЧАЕТСЯ от половины шифрования', async () => {
    // ⚠️ ЗАМОК против самой дорогой опечатки в этой работе: положить один и тот
    // же ключ в оба аргумента. Контракт примет — он не умеет отличать. А сторона
    // запечатает предъявление правильно, но проверить подпись арбитра будет
    // нечем, и всё предъявление окажется непроверяемым.
    const session = {
      keypair: {
        publicKey: new Uint8Array(32).fill(0xab),
        privateKey: new Uint8Array(32).fill(0xcd),
      },
    };
    const keys = await claimKeysFromSession(session as any);
    expect(keys.signKey).not.toBe(keys.boxKey);
  });

  it('ни одна половина не нулевая — нулевую контракт отвергает', async () => {
    const session = {
      keypair: {
        publicKey: new Uint8Array(32).fill(0xab),
        privateKey: new Uint8Array(32).fill(0xcd),
      },
    };
    const keys = await claimKeysFromSession(session as any);
    expect(keys.boxKey).not.toBe(ZERO_KEY);
    expect(keys.signKey).not.toBe(ZERO_KEY);
  });
});

describe('createGatedSignChatKey — отметка ухода ДО подписи, по факту исполнения', () => {
  it('порядок вызовов: сначала отметка, потом настоящий подписчик', async () => {
    // Общий массив, а не .mock.invocationCallOrder — доказывает порядок ПО
    // ФАКТУ выполнения кода, не по чтению текста между двумя строками.
    const calls: string[] = [];
    const markHandoff = vi.fn(() => { calls.push('mark'); });
    const sign = vi.fn(async () => { calls.push('sign'); return '0xdeadbeef' as `0x${string}`; });

    const gated = createGatedSignChatKey(sign as any, markHandoff);
    const result = await gated({} as any);

    expect(calls).toEqual(['mark', 'sign']);
    expect(result).toBe('0xdeadbeef');
  });

  it('markHandoff вызывается ровно один раз за одну подпись', async () => {
    const markHandoff = vi.fn();
    const sign = vi.fn(async () => '0x' as `0x${string}`);
    const gated = createGatedSignChatKey(sign as any, markHandoff);
    await gated({} as any);
    expect(markHandoff).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('без markHandoff по умолчанию не падает (использует noteWalletHandoff)', async () => {
    // Только на отсутствие исключения — реальный noteWalletHandoff трогает
    // document, который в node-окружении может отсутствовать; сам модуль
    // это уже учитывает (см. chatSignatureGate.ts).
    const sign = vi.fn(async () => '0x' + '11'.repeat(32) as `0x${string}`);
    const gated = createGatedSignChatKey(sign as any);
    await expect(gated({} as any)).resolves.toMatch(/^0x/);
  });
});

describe('rethrowIfSignatureDeferred — действие, не решение', () => {
  it('отсрочка гейта подписи — бросает её же дальше', () => {
    const deferred = new ChatSignatureDeferred('needs_press');
    expect(() => rethrowIfSignatureDeferred(deferred)).toThrow(ChatSignatureDeferred);
    try {
      rethrowIfSignatureDeferred(deferred);
      throw new Error('не должно было дойти сюда');
    } catch (thrown) {
      expect(thrown).toBe(deferred); // та же ошибка, не обёртка и не новая
    }
  });

  it('обычная ошибка — не бросает, управление возвращается вызывающему', () => {
    expect(() => rethrowIfSignatureDeferred(new Error('дело в контракте, не в гейте'))).not.toThrow();
  });

  it('мусор на входе (не Error вовсе) — тоже не бросает', () => {
    expect(() => rethrowIfSignatureDeferred('строка вместо ошибки')).not.toThrow();
    expect(() => rethrowIfSignatureDeferred(undefined)).not.toThrow();
  });
});
