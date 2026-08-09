import { describe, it, expect } from 'vitest';
import { buildClaimDisputeCalldata, buildSetArbiterChatKeyCalldata } from './relay';
import { toBoxKey, toSignKey } from './arbiterChatKey';
import type { Address, Hex } from 'viem';

/**
 * Замок на БАЙТЫ калдаты — последний слой, ниже него нет ничего: калдата
 * это то, что реально уходит в цепь.
 *
 * ⚠️ ПОЧЕМУ ФИРМЕННЫЕ ТИПЫ BoxKey/SignKey ЭТОГО НЕ ЛОВЯТ. Они защищают
 * ГРАНИЦУ ВЫЗОВА `buildClaimDisputeCalldata`/`buildSetArbiterChatKeyCalldata`
 * — подставить их местами при самом вызове не даёт тип-чекер (см.
 * type-check-мутации в task-5-report.md, круг доработки). Но ВНУТРИ этих
 * функций, в массиве `args` для `encodeFunctionData`, BoxKey/SignKey —
 * подтипы обычного `Hex` — расширяются обратно: виem типизирует аргументы
 * по ABI, а там оба параметра `bytes32`, структурно неразличимы.
 * Перестановка МЕСТАМИ ВНУТРИ этих двух функций компилируется без единой
 * ошибки и не роняет ни одного из 1826 тестов — замерено ревью на боевом
 * коде. Единственное, что остаётся, — проверить фактическое содержимое
 * калдаты по фиксированному смещению байт, не факт того, что функция была
 * вызвана.
 *
 * `word()` ниже читает калдату НАПРЯМУЮ по смещению (4-байтовый селектор +
 * N 32-байтовых слов), а не через повторный вызов encodeFunctionData с теми
 * же аргументами — иначе тест доказывал бы только детерминизм
 * encodeFunctionData, а не то, что аргументы стоят в правильном порядке.
 */

// Заметно разные ключи — перепутать их в тексте ошибки нельзя.
const BOX = ('0x' + 'aa'.repeat(32)) as Hex;
const SIGN = ('0x' + 'bb'.repeat(32)) as Hex;

/** 32-байтовое слово номер `i` (0-based) из калдаты, без ведущего 0x, в нижнем регистре. */
function word(calldata: Hex, i: number): string {
  const body = calldata.slice(2 + 8); // отбросить '0x' и 4-байтовый (8 hex-символов) селектор
  return body.slice(i * 64, i * 64 + 64).toLowerCase();
}

describe('калдата claimDispute: boxKey и signKey лежат в правильных словах — байтами', () => {
  it('слово 2 (после agreement, salt) — boxKey; слово 3 — signKey', () => {
    const agreement = ('0x' + '11'.repeat(20)) as Address;
    const salt = ('0x' + '22'.repeat(32)) as Hex;
    const calldata = buildClaimDisputeCalldata(agreement, salt, toBoxKey(BOX), toSignKey(SIGN));

    expect(word(calldata, 2)).toBe(BOX.slice(2).toLowerCase());
    expect(word(calldata, 3)).toBe(SIGN.slice(2).toLowerCase());
  });

  it('слова agreement/salt на месте — сверка не случайно попала не туда', () => {
    const agreement = ('0x' + '11'.repeat(20)) as Address;
    const salt = ('0x' + '22'.repeat(32)) as Hex;
    const calldata = buildClaimDisputeCalldata(agreement, salt, toBoxKey(BOX), toSignKey(SIGN));

    // address паддится нулями слева до 32 байт.
    expect(word(calldata, 0)).toBe('0'.repeat(24) + '11'.repeat(20));
    expect(word(calldata, 1)).toBe('22'.repeat(32));
  });
});

describe('калдата setArbiterChatKey: boxKey раньше signKey — байтами', () => {
  it('слово 0 — boxKey, слово 1 — signKey', () => {
    const calldata = buildSetArbiterChatKeyCalldata(toBoxKey(BOX), toSignKey(SIGN));

    expect(word(calldata, 0)).toBe(BOX.slice(2).toLowerCase());
    expect(word(calldata, 1)).toBe(SIGN.slice(2).toLowerCase());
  });
});
