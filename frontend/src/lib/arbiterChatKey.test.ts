import { describe, it, expect } from 'vitest';
import { compareChainWithDirectory, decideDirectoryDivergenceNotice, ZERO_KEY } from './arbiterChatKey';
import type { DirectoryVerdict } from './arbiterChatKey';
import type { Hex } from 'viem';

const KEY_A = ('0x' + 'aa'.repeat(32)) as Hex;
const KEY_B = ('0x' + 'bb'.repeat(32)) as Hex;
const SIG_A = ('0x' + '11'.repeat(32)) as Hex;

function bytes(hex: Hex): Uint8Array {
  const s = hex.slice(2);
  return new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));
}

describe('ключ арбитра: цепь против справочника', () => {
  it('согласны — вердикт agree', () => {
    expect(
      compareChainWithDirectory(
        { boxKey: KEY_A, signKey: SIG_A },
        { boxKey: bytes(KEY_A), signKey: bytes(SIG_A) },
      ),
    ).toBe('agree');
  });

  it('справочник молчит — это НЕ тревога, он просто отстал', () => {
    expect(
      compareChainWithDirectory({ boxKey: KEY_A, signKey: SIG_A }, null),
    ).toBe('directory_missing');
  });

  it('справочник назвал ДРУГОЙ ключ — тревога', () => {
    // Это единственный сигнал, по которому мы вообще способны узнать, что до
    // нашего сервера добрались. Молчать здесь нельзя (решение владельца).
    expect(
      compareChainWithDirectory(
        { boxKey: KEY_A, signKey: SIG_A },
        { boxKey: bytes(KEY_B), signKey: bytes(SIG_A) },
      ),
    ).toBe('directory_differs');
  });

  it('половина подписи различается — тоже тревога, не только шифрование', () => {
    expect(
      compareChainWithDirectory(
        { boxKey: KEY_A, signKey: SIG_A },
        { boxKey: bytes(KEY_A), signKey: bytes(KEY_B) },
      ),
    ).toBe('directory_differs');
  });

  it('в цепи ключа нет — решает цепь, справочник не подменяет решение', () => {
    // ⚠️ ЗАМОК: если кто-нибудь однажды сделает так, что при пустой цепи берётся
    // ключ из справочника, этот тест обязан покраснеть. «Цепь главнее» верно
    // только пока клиент правда читает цепь.
    expect(
      compareChainWithDirectory(
        { boxKey: ZERO_KEY, signKey: ZERO_KEY },
        { boxKey: bytes(KEY_A), signKey: bytes(SIG_A) },
      ),
    ).toBe('chain_missing');
  });
});

describe('decideDirectoryDivergenceNotice — говорим ТОЛЬКО при directory_differs', () => {
  // Решение владельца 9 августа: расхождение обязано быть проговорено —
  // иначе о подмене ключа на нашем сервере мы не узнаем никогда. Но
  // отсутствие в справочнике (директория просто отстала) — не тревога.
  const cases: Array<[DirectoryVerdict | null, boolean]> = [
    ['directory_differs', true],
    ['directory_missing', false],
    ['chain_missing', false],
    ['agree', false],
    [null, false],
  ];

  for (const [verdict, expected] of cases) {
    it(`${verdict} → ${expected}`, () => {
      expect(decideDirectoryDivergenceNotice(verdict)).toBe(expected);
    });
  }
});
