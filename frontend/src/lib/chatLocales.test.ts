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

/** Ключи показа кода восстановления (Задача 8). Отдельным списком, а не
 *  дописью в `REQUIRED`: у них своя причина существовать и свой владелец
 *  текста — четыре первых утверждены им дословно и меняться не должны. */
const REQUIRED_RECOVERY = [
  // Утверждено владельцем — текст плашки.
  'chat.recovery_warning_title',
  'chat.recovery_warning_access',
  'chat.recovery_warning_loss',
  'chat.recovery_warning_keep',
  // Проверка «докажи, что записал» и честный выход из неё.
  'chat.recovery_written',
  'chat.recovery_skip',
  'chat.recovery_where',
  'chat.recovery_check_title',
  'chat.recovery_check_hint',
  'chat.recovery_check_word',
  'chat.recovery_check_failed',
  'chat.recovery_check_done',
  'chat.recovery_reminder',
  'chat.recovery_show',
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

  it('код восстановления: все четырнадцать ключей есть в каждой локали и не пусты', () => {
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      for (const key of REQUIRED_RECOVERY) {
        const value = pick(dict, key);
        if (typeof value !== 'string' || value.trim().length === 0) missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('номер слова подставляется, а не вписан цифрой', () => {
    // `{n}` обязан доехать до каждой локали: без него человек получит
    // «Слово» без номера и не поймёт, какое слово вписывать. Общий гейт
    // (`i18n/messages.test.ts`) сверяет набор аргументов с английским — здесь
    // сказано ЧИСЛОМ, какой именно аргумент нужен.
    const bad: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      for (const key of ['chat.recovery_check_word', 'chat.recovery_check_failed']) {
        if (!String(pick(dict, key)).includes('{n}')) bad.push(`${locale}:${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('⚠️ нигде не сказано «сохраните» — только «запишите»', () => {
    // Правило владельца, и причина у него неочевидная: «сохраните» люди
    // читают как «сфотографируйте». Снимок уезжает в галерею, галерея — в
    // облако, и код оказывается ровно там, где мы просили его не держать.
    // Обнаружить это мы не можем никак — единственное, что в наших силах,
    // это не подсказывать такой способ словом.
    const BANNED: Record<string, RegExp> = {
      ru: /сохран/i,
      uk: /збереж|зберіг/i,
      en: /\bsav(e|ed|ing)\b|\bstore\b/i,
      de: /speicher/i,
      fr: /sauvegard|enregistr/i,
      es: /guard/i,
      pt: /guard|salv/i,
      it: /salva/i,
    };
    const bad: string[] = [];
    for (const locale of LOCALES) {
      const banned = BANNED[locale];
      if (!banned) continue; // письменности без прямого аналога — гейт не врёт
      const chat = pick(read(locale), 'chat') as Record<string, string>;
      for (const [key, value] of Object.entries(chat)) {
        if (key.startsWith('recovery_') && banned.test(value)) bad.push(`${locale}:${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('русское предупреждение — дословно утверждённый владельцем текст', () => {
    const ru = read('ru');
    expect(pick(ru, 'chat.recovery_warning_title')).toBe('Код восстановления');
    expect(pick(ru, 'chat.recovery_warning_access')).toBe(
      'Это доступ ко всей вашей переписке. Кто получит эти 12 слов — прочитает всё. Отозвать или сменить их нельзя.',
    );
    expect(pick(ru, 'chat.recovery_warning_loss')).toBe('Потеряете — переписка не вернётся.');
    expect(pick(ru, 'chat.recovery_warning_keep')).toBe('Запишите и держите в секрете.');
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
