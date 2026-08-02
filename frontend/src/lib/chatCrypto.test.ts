import { describe, it, expect } from 'vitest';
import { deriveChatKeypair, CHAT_KEY_TYPED_DATA } from './chatCrypto';

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

  it('домен и содержимое подписи (EIP-712) зафиксированы целиком', () => {
    // Смена домена ИЛИ содержимого = смена ключа у ВСЕХ существующих
    // пользователей разом: их прежняя переписка станет нечитаемой. Тест
    // стоит здесь как замок: менять можно только вместе с осознанной
    // миграцией. Проверяется структура целиком (не отдельная строка) —
    // именно её обязана подписывать вызывающая сторона через
    // `walletClient.signTypedData(CHAT_KEY_TYPED_DATA)`, без права
    // собрать запрос из кусков по-своему.
    expect(CHAT_KEY_TYPED_DATA).toEqual({
      domain: { name: 'Hexseal', version: '1' },
      types: { ChatKey: [{ name: 'purpose', type: 'string' }] },
      primaryType: 'ChatKey',
      message: { purpose: 'hexseal.chat.key.v1' },
    });
  });

  it('регистр hex-цифр в подписи не влияет на результат (реальный случай: кошельки отдают hex по-разному)', async () => {
    const lower = await deriveChatKeypair(SIG_A);
    const upperDigits = await deriveChatKeypair(('0x' + 'AB'.repeat(65)) as `0x${string}`);
    expect(lower.publicKey).toEqual(upperDigits.publicKey);
  });

  it('заглавный префикс 0X тоже приводится к нижнему регистру (не встречается у реальных кошельков, но не должен ронять функцию)', async () => {
    const lower = await deriveChatKeypair(SIG_A);
    const upperPrefix = await deriveChatKeypair(SIG_A.toUpperCase() as `0x${string}`);
    expect(lower.publicKey).toEqual(upperPrefix.publicKey);
  });

  describe('отказ на невалидном входе — молчаливый приём мусора означает, что все, кто подал один и тот же мусор, получат один и тот же ключ', () => {
    const cases: Array<[label: string, input: string]> = [
      ['пустая строка', ''],
      ['голый префикс без байт', '0x'],
      ['невалидные hex-символы', '0x' + 'zz'.repeat(65)],
      ['строковая константа вместо подписи', 'undefined'],
      ['подпись на один байт короче нужного', '0x' + 'ab'.repeat(64)],
      ['подпись на один байт длиннее нужного', '0x' + 'ab'.repeat(66)],
    ];

    for (const [label, input] of cases) {
      it(label, async () => {
        await expect(
          deriveChatKeypair(input as unknown as `0x${string}`),
        ).rejects.toThrow();
      });
    }
  });
});
