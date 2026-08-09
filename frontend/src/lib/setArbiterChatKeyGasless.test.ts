import { describe, it, expect } from 'vitest';
import { SET_ARBITER_CHAT_KEY_ABI } from './relay';

/**
 * Замок против расхождения ABI публикации ключа с контрактом — тот же класс
 * дыры, что claimAbiMatchesContract.test.ts закрывает для заявки на спор.
 * Читаем ИСХОДНИК .sol, а не out/*.json: out/ в гите нет (.gitignore),
 * артефакт сборки на чистой копии репозитория отсутствует.
 */
describe('публикация ключа арбитра', () => {
  it('ABI совпадает с исходником контракта', async () => {
    const { readFileSync } = await import('node:fs');
    const facet = readFileSync(
      new URL('../../../src/facets/ArbiterRegistryFacet.sol', import.meta.url),
      'utf8',
    );
    const m = facet.match(/function\s+setArbiterChatKey\s*\(([^)]*)\)/m);
    expect(m, 'setArbiterChatKey не найдена в исходнике').not.toBeNull();
    const types = m![1].split(',').map((p) => p.trim().split(/\s+/)[0]);
    expect(types).toEqual(['bytes32', 'bytes32']);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (SET_ARBITER_CHAT_KEY_ABI as any[]).find(
      (e) => e.type === 'function' && e.name === 'setArbiterChatKey',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(entry.inputs.map((i: any) => i.type)).toEqual(types);
  });
});
