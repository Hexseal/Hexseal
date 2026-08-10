import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Отсечка газа для заявки на спор не должна опускаться ниже замеренной нужды.
 *
 * Замер по фасету: первая в жизни запись ключа арбитра — до 72 868 газа, и это
 * поверх прежней стоимости заявки. Слишком низкая отсечка валит предварительный
 * staticCall релеера, действие отдаёт отказ, снаружи это «арбитраж сломался».
 * Такое в этом файле уже случалось: 126 383 против отсечки 120 000.
 */
const RELAY = readFileSync(new URL('./relay.ts', import.meta.url), 'utf8');

function gasCeiling(fnName: string): bigint {
  const m = RELAY.match(new RegExp(`\\n\\s*${fnName}:\\s*([0-9_]+)n`, 'm'));
  if (!m) throw new Error(`отсечка ${fnName} не найдена в GAS_DEFAULTS`);
  return BigInt(m[1].replace(/_/g, ''));
}

describe('отсечка газа заявки на спор', () => {
  it('не ниже замеренной нужды', () => {
    expect(gasCeiling('claimDispute')).toBeGreaterThanOrEqual(260_000n);
  });

  it('предварительная заявка своей отсечки не потеряла', () => {
    // Соседняя запись: если кто-то перепишет объект целиком, это заметно.
    expect(gasCeiling('commitDisputeClaim')).toBeGreaterThanOrEqual(100_000n);
  });
});
