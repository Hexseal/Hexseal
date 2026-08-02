import { describe, it, expect } from 'vitest';
import { bytesToHex } from 'viem';
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

  it('золотой вектор: абсолютные байты для SIG_A, не сравнение двух вызовов', async () => {
    // Все остальные тесты в этом файле ОТНОСИТЕЛЬНЫЕ — сравнивают два вызова
    // между собой. Ревью Задачи 2 (раунд 2) доказало мутацией, что этого
    // недостаточно: смена `CHAT_KEY_SEED_CONTEXT` (единственной константы,
    // реально влияющей на ключ на тот момент) меняла публичный ключ у ВСЕХ
    // пользователей, а все относительные тесты оставались зелёными — они не
    // видят СМЕЩЕНИЕ, только несовпадение между двумя своими же вызовами.
    //
    // Значения посчитаны независимо от этого файла — отдельным скриптом на
    // чистом node (не через chatCrypto.ts), реализующим ту же формулу
    // (context ‖ подпись ‖ hashTypedData(CHAT_KEY_TYPED_DATA) → keccak256 →
    // crypto_box_seed_keypair), и перепроверены в трёх отдельных процессах
    // `node` — совпали побайтово во всех трёх. Тест ниже — четвёртая,
    // независимая проверка: что САМА `chatCrypto.ts` даёт то же самое.
    //
    // Если этот тест когда-нибудь покраснеет — это ЛИБО осознанная миграция
    // (тогда вектор пересчитывается и обновляется здесь тем же способом),
    // ЛИБО молчаливый сдвиг константы, который иначе не поймал бы ничто.
    const { publicKey, privateKey } = await deriveChatKeypair(SIG_A);
    expect(bytesToHex(publicKey)).toBe(
      '0x16cf8aa0cecfda7229d1f3e15b92732f96d0f9f695c697753d0a8cc22c6b9e0a',
    );
    expect(bytesToHex(privateKey)).toBe(
      '0xb46f6d2e59217f698a3817f3667574ec52b7cb0de60f6217eaf718d2459ccfbc',
    );
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
