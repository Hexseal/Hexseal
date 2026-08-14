import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Замок на ХОЗЯИНА ЧИСЛА: пол записи о молчании приходит из цепи, а не из копии
 * во фронте (замысел 5.2, общее ограничение плана).
 *
 * ⚠️ ПОЧЕМУ ОТВЕТ ЦЕПИ ЗДЕСЬ НАРОЧНО СТРАННЫЙ. Подставь сюда настоящие 86400 —
 * и тест прошёл бы одинаково и на честном чтении, и на зашитом во фронт числе:
 * ровно та «пустая мутация», где красное число ничего не значит. Поэтому цепь
 * отвечает 4242 — значением, которого в контракте нет и быть не может, и
 * совпасть с ним можно только одним способом: действительно взяв ответ цепи.
 *
 * ⚠️ ЧЕГО ЗАМОК НЕ ДОКАЗЫВАЕТ: что спрошен именно тот контракт и та функция.
 * Это отдельная проверка ниже (адрес и имя функции сверяются с тем, что крючок
 * передал в wagmi) — без неё чтение чужого геттера с тем же типом возврата
 * было бы неотличимо.
 */

let chainAnswer: { data: bigint | undefined; isLoading: boolean } = {
  data: undefined,
  isLoading: true,
};
const calls: Array<Record<string, unknown>> = [];

vi.mock('wagmi', () => ({
  useReadContract: (args: Record<string, unknown>) => {
    calls.push(args);
    return chainAnswer;
  },
}));

const { useNoResponseFloor } = await import('./useNoResponseFloor');
const { CONTRACTS } = await import('@/config/contracts');

beforeEach(() => {
  calls.length = 0;
  chainAnswer = { data: undefined, isLoading: true };
});

describe('пол записи о молчании берётся у цепи', () => {
  it('отдаёт ровно то число, что назвала цепь', () => {
    chainAnswer = { data: 4242n, isLoading: false };
    expect(useNoResponseFloor()).toEqual({ floorSeconds: 4242, isLoading: false });
  });

  it('и другое число — тоже ровно то, что назвала цепь', () => {
    // Второе значение здесь не для красоты: с одним-единственным ответом
    // подмена «вернуть 4242 всегда» осталась бы незамеченной.
    chainAnswer = { data: 60n, isLoading: false };
    expect(useNoResponseFloor().floorSeconds).toBe(60);
  });

  it('пока ответа нет — null, а не ноль: ноль обещал бы кнопку немедленно', () => {
    chainAnswer = { data: undefined, isLoading: true };
    expect(useNoResponseFloor()).toEqual({ floorSeconds: null, isLoading: true });
  });

  it('честный ноль от цепи остаётся нулём и с «нет ответа» не путается', () => {
    chainAnswer = { data: 0n, isLoading: false };
    expect(useNoResponseFloor().floorSeconds).toBe(0);
  });

  it('спрашивается диамонд и именно getNoResponseFloor', () => {
    chainAnswer = { data: 86_400n, isLoading: false };
    useNoResponseFloor();
    expect(calls).toHaveLength(1);
    expect(calls[0].address).toBe(CONTRACTS.diamond);
    expect(calls[0].functionName).toBe('getNoResponseFloor');
  });

  it('в самом крючке нет своей копии числа — искать её негде, кроме исходника', async () => {
    // ⚠️ Эта проверка сторожит ТЕКСТ, и так и написано. Она нужна не вместо
    // проверок выше, а рядом: те ловят подмену значения, а эта — приписку
    // «а если цепь молчит, возьмём сутки», которая на всех сценах выше
    // невидима, потому что цепь там отвечает всегда.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./useNoResponseFloor.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\b86[_ ]?400\b/);
    expect(code).not.toMatch(/\b24\s*\*\s*60\s*\*\s*60\b/);
  });
});
