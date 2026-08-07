/**
 * chatSessionOff.test.ts — «Мессенджер выключен» перестаёт обвинять того,
 * кто ни при чём (находка аудита К-2).
 *
 * ⚠️ ЧЕМ ЭТО БЫЛО. Один экран на все причины: человек сам выключил чат,
 * кошелёк не подписал, соседняя вкладка держит хранилище, хранилище молчит,
 * на устройстве запись незнакомой версии. Пять разных бед — одна надпись, и
 * та в страдательном залоге про действие человека: «Мессенджер выключен».
 * Чаще всего он ничего не выключал, и прочесть это ему нечем, кроме как
 * «я что-то сломал».
 *
 * Здесь заперто: у каждой причины свои слова И СВОЁ ДЕЙСТВИЕ. Действие —
 * половина дела: «повторить» на заблокированном хранилище бесполезно, там
 * надо закрыть соседнюю вкладку.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatSessionErrorCode } from './chatSession';
import { offScreenFor, OFF_SCREENS } from './chatSessionOff';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = path.resolve(HERE, '../../messages');
const LOCALES = ['ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'uk', 'zh-CN'];
const dict = (l: string) => JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${l}.json`), 'utf8'));
const pick = (d: unknown, key: string) => key.split('.').reduce<unknown>(
  (a, p) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[p] : undefined), d);

/** Причины, по которым сеанс НЕ открылся и человек видит пустой экран. */
const CAUSES: ChatSessionErrorCode[] = [
  'storage_read_failed',
  'storage_blocked',
  'storage_open_timeout',
  'storage_version_unknown',
  'signature_malformed',
  'address_malformed',
];

describe('экран «чат не открылся» разведён по причинам', () => {
  it('⚠️ у каждой причины СВОИ слова — ни одна не делит надпись с другой', () => {
    // ГЛАВНЫЙ ЗАМОК К-2. Красит: карта, где две причины ведут на один ключ.
    const hints = CAUSES.map(c => offScreenFor(c).hintKey);
    expect(new Set(hints).size).toBe(CAUSES.length);
  });

  it('⚠️ ни одна из них не называется «мессенджер выключен»', () => {
    // Человек ничего не выключал. Заголовок про его действие — обвинение
    // того, кто ни при чём, и он перестаёт искать настоящую причину.
    for (const cause of CAUSES) {
      expect(offScreenFor(cause).titleKey, cause).not.toBe('chat.messaging_off');
    }
  });

  it('человек ВЫКЛЮЧИЛ сам (причины нет) — вот тогда «мессенджер выключен»', () => {
    // Обратная сторона: единственный случай, когда прежняя надпись верна,
    // обязан её сохранить. Красит: замена надписи на всех подряд.
    expect(offScreenFor(null).titleKey).toBe('chat.messaging_off');
    expect(offScreenFor(null).action).toBe('retry');
  });

  it('⚠️ заблокированное хранилище не зовёт «повторить» — там нужно другое', () => {
    // Красит: одно действие на все причины. Повтор на занятой соседней
    // вкладкой базе не даст ничего, сколько ни жми.
    expect(offScreenFor('storage_blocked').action).toBe('close-tabs');
  });

  it('незнакомая версия записи не зовёт ни повторить, ни восстановить', () => {
    // Запись не трогают намеренно: для кошелька-контракта выбросить её —
    // стереть личность навсегда. Предлагать человеку действие, которого у
    // него нет, значит врать.
    expect(offScreenFor('storage_version_unknown').action).toBe('none');
  });

  it('нечитаемое хранилище предлагает восстановление — код у человека есть', () => {
    // Прочитать не смогли, значит ключа у нас нет. Если человек записал
    // двенадцать слов, ему сюда.
    expect(offScreenFor('storage_read_failed').action).toBe('restore');
  });

  it('незнакомая причина не даёт пустого экрана', () => {
    const unknown = offScreenFor('recovery_code_checksum');
    expect(unknown.titleKey).toBeTruthy();
    expect(unknown.hintKey).toBeTruthy();
  });

  it('все действия — из закрытого набора, а не строкой на глаз', () => {
    const allowed = new Set(['retry', 'restore', 'close-tabs', 'none']);
    for (const screen of Object.values(OFF_SCREENS)) {
      expect(allowed.has(screen.action), screen.action).toBe(true);
    }
  });
});

describe('надписи есть во всех четырнадцати локалях', () => {
  it('каждый ключ каждого экрана — настоящая непустая строка', () => {
    const keys = new Set<string>();
    for (const cause of [...CAUSES, null]) {
      const s = offScreenFor(cause);
      keys.add(s.titleKey);
      keys.add(s.hintKey);
    }
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const d = dict(locale);
      for (const key of keys) {
        const v = pick(d, key);
        if (typeof v !== 'string' || v.trim().length === 0) missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('панель читает разведённые экраны, а не общий', () => {
  const SRC = path.resolve(HERE, '..');
  it('ChatPanel зовёт offScreenFor', () => {
    // Тот же замок, что спас на М-31: карта, которую никто не читает, —
    // это код, который объясняет несуществующее.
    const panel = fs.readFileSync(path.join(SRC, 'components/ChatPanel.tsx'), 'utf8');
    expect(panel).toContain('offScreenFor');
  });
});
