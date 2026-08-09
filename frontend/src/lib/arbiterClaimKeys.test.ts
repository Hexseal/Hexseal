import { describe, it, expect, vi, beforeEach } from 'vitest';
import { claimKeysFromSession } from './arbiterClaimKeys';
import { ZERO_KEY } from './arbiterChatKey';

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
