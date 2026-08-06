/**
 * chatLocales.test.ts — тексты пересадки во всех локалях (Задача 7).
 *
 * `zh.json` НЕ ТРОГАЕТСЯ и здесь не проверяется: он сирота — в списке локалей
 * приложения его нет (`i18n/routing`, `zh-CN` — китайская локаль проекта).
 * Правило записано в плане прямым текстом; тест повторяет его числом, а не
 * доверием: список локалей задан здесь явно, и `zh.json` в нём отсутствует.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');

/** Четырнадцать локалей приложения. `zh.json` — сирота, вне списка. */
const LOCALES = [
  'ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'uk', 'zh-CN',
];

/** Ключи, появившиеся вместе с пересадкой. */
const REQUIRED = [
  'chat.privacy_badge_title',
  'chat.privacy_badge_storage',
  'chat.privacy_badge_dispute',
  'chat.chain_gap',
  'chat.chain_gap_start',
  'chat.pass_signature_hint',
  'chat.key_not_saved',
  'chat.key_not_saved_blocked',
];

/** Ключи, которые обязаны исчезнуть: они говорили про XMTP и про журнал
 *  бота, которого больше нет. Оставленный ключ — не мусор, а обещание,
 *  которое кто-нибудь снова выведет на экран. */
const REMOVED = [
  'chat.dispute_log_badge',
  'chat.dispute_log_hint',
  'chat.log_incomplete',
  'chat.load_older',
  'chat.search_history_hint',
  'chat.open_xmtp',
  'chat.connecting_messenger',
  'notifications.enable_messaging_hint',
];

function read(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), 'utf8'));
}

function pick(dict: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    dict,
  );
}

describe('тексты пересадки — 14 локалей', () => {
  it('в каждой локали есть все новые ключи, и ни один не пустой', () => {
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      for (const key of REQUIRED) {
        const value = pick(dict, key);
        if (typeof value !== 'string' || value.trim().length === 0) missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('третья строка бейджа — настоящее предложение, а не заглушка', () => {
    // Смысл проверить нечем, длину и несовпадение — можно. Заглушка вида
    // "TODO" или копия соседней строки этот замок красит.
    //
    // Порог разный: иероглифическое письмо укладывает то же предложение
    // втрое короче по символам (ja/zh-CN — 36–37 знаков против 88 у ru), и
    // единый латинский порог красил бы честный перевод. Числа записаны
    // руками по факту, а не выведены формулой.
    const MIN_LEN: Record<string, number> = { ja: 20, ko: 20, 'zh-CN': 18, th: 30 };
    const bad: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      const dispute = pick(dict, 'chat.privacy_badge_dispute');
      const storage = pick(dict, 'chat.privacy_badge_storage');
      const title = pick(dict, 'chat.privacy_badge_title');
      const min = MIN_LEN[locale] ?? 40;
      if (typeof dispute !== 'string' || dispute.length < min) bad.push(`${locale}: короткая`);
      if (dispute === storage || dispute === title) bad.push(`${locale}: копия соседней`);
    }
    expect(bad).toEqual([]);
  });

  it('русский бейдж — дословно утверждённый владельцем текст', () => {
    const ru = read('ru');
    expect(pick(ru, 'chat.privacy_badge_title')).toBe('Только вы двое');
    expect(pick(ru, 'chat.privacy_badge_storage'))
      .toBe('Переписка зашифрована. Сервер хранит её в нечитаемом виде и не имеет ключей.');
    expect(pick(ru, 'chat.privacy_badge_dispute'))
      .toBe('При споре предъявить переписку арбитру может каждая из сторон — со своего устройства.');
  });

  it('ключи про XMTP и журнал бота удалены во всех локалях', () => {
    const alive: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      if (pick(dict, 'xmtp_error') !== undefined) alive.push(`${locale}:xmtp_error`);
      for (const key of REMOVED) {
        if (pick(dict, key) !== undefined) alive.push(`${locale}:${key}`);
      }
    }
    expect(alive).toEqual([]);
  });

  it('обещание «платформа читает переписку» убрано из оставшихся текстов', () => {
    // Прямая ложь после пересадки: сервер ключей не имеет. Ловится по двум
    // текстам, которые её несли (ru), — остальные локали закрыты тем, что
    // ключи `dispute_log_*` удалены целиком (проверка выше).
    const ru = read('ru');
    expect(String(pick(ru, 'chat.e2e_notice'))).not.toContain('спор');
    expect(String(pick(ru, 'chat.encrypted'))).not.toContain('спор');
  });

  it('zh.json — сирота: в списке локалей его нет, и он не тронут', () => {
    expect(LOCALES).not.toContain('zh');
    const zh = read('zh');
    // Ровно то, что там было до пересадки: старые ключи на месте, новых нет.
    expect(pick(zh, 'chat.open_xmtp')).toBeTypeOf('string');
    expect(pick(zh, 'chat.privacy_badge_title')).toBeUndefined();
  });
});
