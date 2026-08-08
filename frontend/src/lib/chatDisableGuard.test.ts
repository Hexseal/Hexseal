/**
 * chatDisableGuard.test.ts — снятие ключа с устройства требует ЯВНОГО
 * подтверждения, и это свойство самой операции, а не кнопки.
 *
 * ⚠️ ПОЧЕМУ ЗАМОК ПЕРЕЕХАЛ. Первая починка К-1 стояла на тексте: тест
 * проверял, что `WalletMenu` не содержит `onClick={disableChat}`. Обход
 * ЗАМЕРЕН на сквозной проверке: строка `onClick={() => disableChat()}` стирает
 * ключ одним нажатием, и из 1338 тестов не краснеет НИ ОДИН. Замок сторожил
 * написание, а не поведение — ровно та болезнь, которую в этой задаче ловили
 * уже четырежды (М-31, М-41, М-52/53, М-58).
 *
 * Поэтому охрана переехала туда, где живёт опасность: в саму `forgetSession`.
 * Теперь любой путь к снятию ключа — старый, новый, ещё не написанный —
 * обязан СКАЗАТЬ ВСЛУХ, что человек подтвердил, зная цену. Забывший сказать
 * не стирает ничего: отказ закрытый, а не открытый.
 *
 * Цена решения названа честно: тот, кто нарочно впишет `acknowledged: true`
 * мимо подтверждения, ключ снимет. Но это уже не забывчивость, а ложь в
 * коде, и она видна на чтении — в отличие от пропущенной кнопки.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChatDisk } from './__stand__/fakeChatDisk';

const ADDRESS = '0x9876543210FedCBA9876543210fEDcbA98765432' as `0x${string}`;
const CONTRACT_SIG = `0x${'7a'.repeat(96)}` as `0x${string}`;

async function freshModule() {
  vi.resetModules();
  return import('./chatSession');
}

describe('снятие ключа не происходит без подтверждения', () => {
  let stand: ReturnType<typeof installFakeChatDisk>;
  beforeEach(() => { stand = installFakeChatDisk(); });
  afterEach(() => { stand?.restore(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('⚠️ БЕЗ подтверждения ключ ОСТАЁТСЯ на устройстве — замер по диску', async () => {
    // ГЛАВНЫЙ ЗАМОК. Красит: снятие охраны в `forgetSession`. И, в отличие
    // от прежнего замка, НЕ красится переписыванием кнопки — потому что про
    // кнопку он ничего не знает.
    const mod = await freshModule();
    await mod.openSession(ADDRESS, async () => CONTRACT_SIG);
    expect(stand.disk.size).toBe(1);

    const removed = await mod.forgetSession(ADDRESS);
    expect(removed).toBe(false);
    expect(stand.disk.size, 'ключ стёрт без подтверждения').toBe(1);
  });

  it('ключ остаётся ЖИВЫМ, а не просто лежит: сеанс открывается тем же', async () => {
    // Мало что запись на месте — она обязана остаться той же. Красит:
    // «стёрли и записали заново».
    const mod = await freshModule();
    const before = await mod.openSession(ADDRESS, async () => CONTRACT_SIG);
    const code = mod.exportRecoveryCode(before);
    await mod.forgetSession(ADDRESS);

    const after = await freshModule();
    const again = await after.openSession(ADDRESS, async () => CONTRACT_SIG);
    expect(again.restored).toBe(true);
    expect(after.exportRecoveryCode(again)).toBe(code);
  });

  it('С подтверждением ключ снимается — охрана не запирает намертво', async () => {
    const mod = await freshModule();
    await mod.openSession(ADDRESS, async () => CONTRACT_SIG);
    const removed = await mod.forgetSession(ADDRESS, { acknowledged: true });
    expect(removed).toBe(true);
    expect(stand.disk.size).toBe(0);
  });

  it('⚠️ забывчивость не стирает, а ложь видна: умолчание — НЕ снимать', async () => {
    // Отказ закрытый: вызывающий, не сказавший ничего, не стирает ничего.
    // Красит: умолчание `acknowledged: true`, при котором охрана есть на
    // бумаге и отсутствует на деле.
    const mod = await freshModule();
    await mod.openSession(ADDRESS, async () => CONTRACT_SIG);
    await mod.forgetSession(ADDRESS, {});
    expect(stand.disk.size).toBe(1);
  });

  it('снятие несуществующего ключа с подтверждением — не ошибка', async () => {
    const mod = await freshModule();
    await expect(mod.forgetSession(ADDRESS, { acknowledged: true })).resolves.toBe(true);
  });
});

describe('единственный путь к снятию в интерфейсе — через подтверждение', () => {
  it('⚠️ ни один компонент не снимает ключ, не сказав про подтверждение', async () => {
    // Осмотр здесь ДОПОЛНЯЕТ поведенческий замок, а не заменяет его: даже
    // если кто-то впишет `acknowledged: true`, это будет видно списком.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

    const files = ['components/RecoveryCodeGate.tsx', 'hooks/useChatSession.ts'];
    const callers: string[] = [];
    for (const rel of files) {
      const body = fs.readFileSync(path.join(SRC, rel), 'utf8');
      for (const m of body.matchAll(/forgetSession\(([^)]*)\)/g)) callers.push(`${rel}: ${m[1]}`);
    }
    // Оба вызова — и «отключить чат», и «забыть текущий и восстановить» —
    // приходят из явного нажатия человека и обязаны это сказать.
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) {
      expect(caller, caller).toMatch(/acknowledged/);
    }
  });
});
