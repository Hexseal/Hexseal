/**
 * chatSessionLazy.test.ts — окно подписи перестаёт всплывать на любой
 * странице сразу после подключения кошелька (находка аудита К-3).
 *
 * ⚠️ ЧЕМ ЭТО БЫЛО. `useChatSession` открывал сеанс, как только появлялся
 * адрес. Хук живёт в шапке (`WalletMenu`), то есть НА КАЖДОЙ СТРАНИЦЕ:
 * человек зашёл посмотреть доску заказов — кошелёк просит подписать что-то
 * без единого объяснения. Отказ нигде не запоминался, значит на следующей
 * странице спросят снова.
 *
 * Разделение, на котором стоит починка: ПРОЧИТАТЬ ключ с устройства и
 * ЗАВЕСТИ его — разные по цене действия. Чтение бесплатно и молчаливо;
 * подпись — окно кошелька. Значит читать можно всегда и везде, а заводить —
 * только когда человек пришёл в чат.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeChatDisk } from './__stand__/fakeChatDisk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const ADDRESS = '0x1234567890AbcdEF1234567890aBcdef12345678' as `0x${string}`;
const CONTRACT_SIG = `0x${'ab'.repeat(96)}` as `0x${string}`;

async function freshModule() {
  vi.resetModules();
  return import('./chatSession');
}

describe('читать — всегда, заводить — только по просьбе', () => {
  let stand: ReturnType<typeof installFakeChatDisk>;
  beforeEach(() => { stand = installFakeChatDisk(); });
  afterEach(() => { stand?.restore(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('⚠️ ключа на устройстве нет, заводить не просили — НОЛЬ окон подписи', async () => {
    // ГЛАВНЫЙ ЗАМОК К-3. Красит: прежнее поведение, где `openSession` всегда
    // доходил до `establishIdentity` и дёргал кошелёк.
    const mod = await freshModule();
    const sign = vi.fn(async () => CONTRACT_SIG);
    await expect(mod.openSession(ADDRESS, sign, { createIfMissing: false }))
      .rejects.toMatchObject({ code: 'session_absent' });
    expect(sign).toHaveBeenCalledTimes(0);
  });

  it('ключ на устройстве ЕСТЬ — отдаётся молча, и заводить не надо', async () => {
    // Тот, кто однажды завёл ключ, не должен ничего подписывать снова ни
    // на одной странице. Красит: отказ читать без разрешения заводить.
    const seed = await freshModule();
    const sign1 = vi.fn(async () => CONTRACT_SIG);
    await seed.openSession(ADDRESS, sign1);
    expect(sign1).toHaveBeenCalledTimes(1);

    const later = await freshModule();
    const sign2 = vi.fn(async () => CONTRACT_SIG);
    const restored = await later.openSession(ADDRESS, sign2, { createIfMissing: false });
    expect(sign2).toHaveBeenCalledTimes(0);
    expect(restored.restored).toBe(true);
  });

  it('заводить попросили — окно подписи ровно одно', async () => {
    const mod = await freshModule();
    const sign = vi.fn(async () => CONTRACT_SIG);
    const opened = await mod.openSession(ADDRESS, sign, { createIfMissing: true });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(opened.restored).toBe(false);
  });

  it('умолчание — ЗАВОДИТЬ: старые вызывающие не меняют поведения молча', async () => {
    // Красит: смену умолчания. Тогда всякий, кто не передал опцию, тихо
    // перестал бы заводить ключ — и чат не открылся бы вовсе.
    const mod = await freshModule();
    const sign = vi.fn(async () => CONTRACT_SIG);
    await mod.openSession(ADDRESS, sign);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('«не заводить» НЕ маскирует отказ хранилища', async () => {
    // Прочитать не смогли — это не «ключа нет». Разница в цене: для
    // кошелька-контракта завести новый поверх нечитаемого старого значит
    // потерять личность (К-4 в `chatSession.ts`). Красит: обработка отказа
    // чтения как пустоты.
    stand.restore();
    vi.stubGlobal('indexedDB', {
      open() {
        const r: Record<string, unknown> = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
        queueMicrotask(() => (r.onerror as (() => void) | null)?.());
        return r;
      },
    });
    const mod = await freshModule();
    const sign = vi.fn(async () => CONTRACT_SIG);
    await expect(mod.openSession(ADDRESS, sign, { createIfMissing: false }))
      .rejects.toMatchObject({ code: 'storage_read_failed' });
    expect(sign).toHaveBeenCalledTimes(0);
  });
});

describe('отказ подписать помнится, и человека не долбят', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('отказ запоминается по адресу и снимается явным «включить»', async () => {
    const { rememberChatDecline, isChatDeclined, forgetChatDecline } = await import('./chatDecline');
    expect(isChatDeclined(ADDRESS)).toBe(false);
    rememberChatDecline(ADDRESS);
    expect(isChatDeclined(ADDRESS)).toBe(true);
    forgetChatDecline(ADDRESS);
    expect(isChatDeclined(ADDRESS)).toBe(false);
  });

  it('отказ одного адреса не запирает другой', async () => {
    const { rememberChatDecline, isChatDeclined } = await import('./chatDecline');
    rememberChatDecline(ADDRESS);
    expect(isChatDeclined('0x2222222222222222222222222222222222222222')).toBe(false);
  });

  it('⚠️ отказом человека признаётся ТОЛЬКО отказ человека', async () => {
    // Красит: «любая ошибка подписи — отказ». Тогда моргнувшая сеть или
    // сбой кошелька запирали бы чат до явного нажатия, а человек не
    // понимал бы, почему.
    const { isUserDecline } = await import('./chatDecline');
    expect(isUserDecline(Object.assign(new Error('x'), { name: 'UserRejectedRequestError' }))).toBe(true);
    expect(isUserDecline(new Error('User rejected the request'))).toBe(true);
    expect(isUserDecline(new Error('user denied message signature'))).toBe(true);
    expect(isUserDecline(new Error('network error'))).toBe(false);
    expect(isUserDecline(new Error('quota exceeded'))).toBe(false);
    expect(isUserDecline(null)).toBe(false);
  });

  it('хранилище отказало — не падаем и считаем, что не отказывался', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('нет'); },
      setItem: () => { throw new Error('нет'); },
      removeItem: () => { throw new Error('нет'); },
    });
    const { rememberChatDecline, isChatDeclined, forgetChatDecline } = await import('./chatDecline');
    expect(() => rememberChatDecline(ADDRESS)).not.toThrow();
    expect(() => forgetChatDecline(ADDRESS)).not.toThrow();
    expect(isChatDeclined(ADDRESS)).toBe(false);
  });
});

describe('чат заводит ключ там, где человек в чат и пришёл', () => {
  it('⚠️ хук больше не заводит ключ сам собой — он ждёт просьбы', () => {
    // Красит: возврат безусловного `openSession(address, ...)`.
    const hook = read('hooks/useChatSession.ts');
    expect(hook).toContain('createIfMissing');
    expect(hook).toMatch(/export function armChatSession/);
  });

  it('обе половины чата просят завести ключ', () => {
    // `usePairChat` — открытая переписка, `usePairConversations` — список.
    // Обе живут только на страницах чата, и обе означают «человек пришёл».
    for (const rel of ['hooks/usePairChat.ts', 'hooks/usePairConversations.ts']) {
      expect(read(rel), rel).toMatch(/armChatSession\(\)/);
    }
  });

  it('шапка НЕ просит: она стоит на каждой странице', () => {
    // Ровно та причина, по которой находка К-3 существует.
    expect(read('components/WalletMenu.tsx')).not.toContain('armChatSession');
  });
});
