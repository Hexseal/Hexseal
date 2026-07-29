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

  it('округляет вниз, как целочисленная арифметика Solidity', () => {
    // 5% от $33.33 = 1.6665 → 1_666_500, не округляется вверх
    expect(quoteFeeLocal(33_330_000n, BPS, FLOOR)).toBe(1_666_500n);
  });
});
