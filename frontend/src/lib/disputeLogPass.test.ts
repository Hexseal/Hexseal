import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadPass, savePass, clearPass, dropForeignPasses } from './disputeLogPass';

/**
 * Окружение тестов — 'node' (vitest.config.mjs), никакого `window` в нём нет, а
 * весь модуль намеренно молчит без sessionStorage. Поэтому хранилище здесь
 * настоящее по поведению и поддельное по происхождению: обычная Map за тем же
 * интерфейсом. Тест на «нет хранилища вовсе» ниже как раз снимает эту подпорку.
 */
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  [name: string]: unknown;
}

const ARBITER  = '0xAAaA000000000000000000000000000000000001';
const OTHER    = '0xbbbb000000000000000000000000000000000002';
const DEAL     = '0xDeaD000000000000000000000000000000000003';
const OTHERDEAL = '0xdead000000000000000000000000000000000004';

const now = () => Math.floor(Date.now() / 1000);
const pass = (token: string, ttl = 3600) => ({ token, expiresAt: now() + ttl });

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  (globalThis as { window?: unknown }).window = { sessionStorage: storage };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('пропуск к журналу спора', () => {
  it('сохранённый пропуск читается обратно', () => {
    savePass(ARBITER, DEAL, pass('tok-1'));
    expect(loadPass(ARBITER, DEAL)).toBe('tok-1');
  });

  it('регистр адреса и сделки значения не имеет', () => {
    savePass(ARBITER.toLowerCase(), DEAL.toUpperCase(), pass('tok-2'));
    expect(loadPass(ARBITER.toUpperCase(), DEAL.toLowerCase())).toBe('tok-2');
  });

  it('пропуск одной сделки не открывает другую', () => {
    savePass(ARBITER, DEAL, pass('tok-3'));
    expect(loadPass(ARBITER, OTHERDEAL)).toBeNull();
  });

  it('смена кошелька: чужой пропуск не находится И удаляется из хранилища', () => {
    savePass(ARBITER, DEAL, pass('tok-4'));
    // Подключился другой кошелёк и полез в тот же журнал.
    expect(loadPass(OTHER, DEAL)).toBeNull();
    // Мало не отдать его — он не должен пережить смену аккаунта вообще.
    expect(storage.length).toBe(0);
    // И возврат прежнего кошелька тоже требует новой подписи.
    expect(loadPass(ARBITER, DEAL)).toBeNull();
  });

  it('истёкший пропуск не отдаётся и подчищается', () => {
    savePass(ARBITER, DEAL, { token: 'tok-5', expiresAt: now() - 1 });
    expect(loadPass(ARBITER, DEAL)).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('пропуск, которому осталось меньше запаса на дорогу, считается истёкшим', () => {
    // Иначе он уйдёт в релеер и вернётся гарантированным 401 — лишний
    // круг вместо того, чтобы сразу попросить подпись.
    savePass(ARBITER, DEAL, { token: 'tok-6', expiresAt: now() + 5 });
    expect(loadPass(ARBITER, DEAL)).toBeNull();
  });

  it('битая запись не роняет чтение', () => {
    storage.setItem(`hexseal:dispute-log-pass:${ARBITER.toLowerCase()}:${DEAL.toLowerCase()}`, '{not json');
    expect(loadPass(ARBITER, DEAL)).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('запись без срока отвергается — иначе пропуск был бы вечным', () => {
    storage.setItem(
      `hexseal:dispute-log-pass:${ARBITER.toLowerCase()}:${DEAL.toLowerCase()}`,
      JSON.stringify({ token: 'tok-7' }),
    );
    expect(loadPass(ARBITER, DEAL)).toBeNull();
  });

  it('clearPass убирает ровно свой ключ', () => {
    savePass(ARBITER, DEAL, pass('tok-8'));
    savePass(ARBITER, OTHERDEAL, pass('tok-9'));
    clearPass(ARBITER, DEAL);
    expect(loadPass(ARBITER, DEAL)).toBeNull();
    expect(loadPass(ARBITER, OTHERDEAL)).toBe('tok-9');
  });

  it('dropForeignPasses не трогает пропуска текущего адреса', () => {
    savePass(ARBITER, DEAL, pass('tok-10'));
    savePass(ARBITER, OTHERDEAL, pass('tok-11'));
    savePass(OTHER, DEAL, pass('tok-12'));
    dropForeignPasses(ARBITER);
    expect(loadPass(ARBITER, DEAL)).toBe('tok-10');
    expect(loadPass(ARBITER, OTHERDEAL)).toBe('tok-11');
    expect(loadPass(OTHER, DEAL)).toBeNull();
  });

  it('без sessionStorage всё молча превращается в «пропуска нет»', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => savePass(ARBITER, DEAL, pass('tok-13'))).not.toThrow();
    expect(loadPass(ARBITER, DEAL)).toBeNull();
    expect(() => clearPass(ARBITER, DEAL)).not.toThrow();
  });

  it('хранилище, которое бросает, тоже не роняет страницу', () => {
    (globalThis as { window?: unknown }).window = {
      get sessionStorage(): Storage { throw new Error('access denied'); },
    };
    expect(() => savePass(ARBITER, DEAL, pass('tok-14'))).not.toThrow();
    expect(loadPass(ARBITER, DEAL)).toBeNull();
  });
});
