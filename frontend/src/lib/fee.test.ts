import { describe, it, expect } from 'vitest';
import { quoteFeeLocal } from './fee';

const BPS = 500n;          // 5%
const FLOOR = 1_000_000n;  // $1

describe('quoteFeeLocal', () => {
  it('берёт пол, когда процент ниже него', () => {
    expect(quoteFeeLocal(5_000_000n, BPS, FLOOR)).toBe(1_000_000n);
  });

  it('на $20 процент ровно равен полу', () => {
    expect(quoteFeeLocal(20_000_000n, BPS, FLOOR)).toBe(1_000_000n);
  });

  it('выше стыка берёт процент', () => {
    expect(quoteFeeLocal(200_000_000n, BPS, FLOOR)).toBe(10_000_000n);
  });

  it('масштабируется на крупных суммах', () => {
    expect(quoteFeeLocal(1_000_000_000n, BPS, FLOOR)).toBe(50_000_000n);
  });

  it('на нулевой сумме отдаёт пол — как контракт', () => {
    expect(quoteFeeLocal(0n, BPS, FLOOR)).toBe(1_000_000n);
  });

  it('нулевая ставка вырождается в пол', () => {
    expect(quoteFeeLocal(200_000_000n, 0n, FLOOR)).toBe(1_000_000n);
  });

  it('ровная сумма — процент делится нацело, сверх пола ничего не прибавляется', () => {
    // 5% от $33.33 = 1_666_500 — точное деление, округлять нечего.
    expect(quoteFeeLocal(33_330_000n, BPS, FLOOR)).toBe(1_666_500n);
  });

  it('отбрасывает дробную часть, а не округляет её вверх', () => {
    // 33_333_333 × 500 = 16 666 666 500; делим на 10 000 → 1 666 666.65
    // Целочисленное деление отбрасывает .65 — как uint256 в Solidity.
    // Реализация через Number + Math.round дала бы 1_666_667 и упала бы здесь.
    expect(quoteFeeLocal(33_333_333n, 500n, 1_000_000n)).toBe(1_666_666n);
  });
});
