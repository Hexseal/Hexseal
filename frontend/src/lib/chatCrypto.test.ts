import { describe, it, expect } from 'vitest';
import { deriveChatKeypair, CHAT_KEY_MESSAGE } from './chatCrypto';

const SIG_A = ('0x' + 'ab'.repeat(65)) as `0x${string}`;
const SIG_B = ('0x' + 'cd'.repeat(65)) as `0x${string}`;

describe('deriveChatKeypair', () => {
  it('одна и та же подпись всегда даёт одну и ту же пару', async () => {
    const first  = await deriveChatKeypair(SIG_A);
    const second = await deriveChatKeypair(SIG_A);
    expect(first.publicKey).toEqual(second.publicKey);
    expect(first.privateKey).toEqual(second.privateKey);
  });

  it('разные подписи дают разные пары', async () => {
    const a = await deriveChatKeypair(SIG_A);
    const b = await deriveChatKeypair(SIG_B);
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it('фраза для подписи зафиксирована и не пуста', () => {
    // Смена фразы = смена ключа у ВСЕХ существующих пользователей: их прежняя
    // переписка станет нечитаемой. Тест стоит здесь как замок: менять фразу
    // можно только вместе с осознанной миграцией.
    expect(CHAT_KEY_MESSAGE).toBe('hexseal.chat.key.v1');
  });

  it('регистр подписи не влияет на результат', async () => {
    const lower = await deriveChatKeypair(SIG_A);
    const upper = await deriveChatKeypair(SIG_A.toUpperCase() as `0x${string}`);
    expect(lower.publicKey).toEqual(upper.publicKey);
  });
});
