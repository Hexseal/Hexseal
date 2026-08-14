import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Срок годности фактов ящика НЕ ЖИВЁТ В ТЕКСТЕ ЛОКАЛИ.
 *
 * ⚠️ ЧТО БЫЛО (итоговое ревью ветки 4в-2, правка 6). Две строки экрана арбитра
 * говорили «не позже пятнадцати секунд назад» — числом, во всех четырнадцати
 * файлах. А хозяин этого числа — `DISPUTE_BOX_TTL_MS` в релеере, и он
 * читается ИЗ ОКРУЖЕНИЯ (`relayer/app.js`, `readPositiveInt('DISPUTE_BOX_TTL_MS',
 * 15_000)`). Одна строка в `.env.vps` — и экран начинает врать числом, молча и
 * на четырнадцати языках сразу. Хозяев у числа было двое, а править надо было
 * пятнадцать мест.
 *
 * Лечение — снять число: строка по-прежнему честно говорит «это последнее, что
 * прочитал НАШ СЕРВЕР, а не ответ цепи сию секунду», но величину не называет.
 * Величина остаётся у одного хозяина — в окружении релеера.
 *
 * ⚠️ ЧТО ЭТОТ ЗАМОК ЛОВИТ, А ЧТО НЕТ — говорю вслух. Цифры любой из систем
 * счисления, встречающихся в наших локалях, он ловит все. Число ПРОПИСЬЮ он
 * ловит по списку слов, и список этот заведомо неполон: он покрывает ровно те
 * четырнадцать написаний, что были удалены этой правкой, то есть сторожит
 * откат и повторение той же ошибки, а не всякую мыслимую формулировку.
 */

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');

/** Те же четырнадцать, что и у остальных замков локалей. */
const LOCALES = [
  'en', 'ru', 'es', 'de', 'fr', 'it', 'pt', 'uk', 'zh-CN', 'ja', 'ko', 'th', 'ar', 'hi',
];

/** Ключи, которым величину TTL называть запрещено. */
const KEYS = ['presentations_not_mine', 'presentations_box_closed'] as const;

/** Цифры латиницы, арабо-индийские, персидские, деванагари и тайские. */
const DIGITS = /[0-9٠-٩۰-۹०-९๐-๙]/;

/**
 * Пятнадцать прописью — ровно те написания, что убраны этой правкой, плюс
 * «полминуты»/«half a minute», которое было ВТОРЫМ выражением того же числа
 * (тридцать секунд — это два TTL, и оно поехало бы вместе с ним).
 */
const SPELLED = [
  'fifteen', 'fünfzehn', 'quince', 'quindici', 'quinze',
  'пятнадцат', "п'ятнадцят", '十五', '십오', '열다섯', 'สิบห้า',
  'خمس عشرة', 'पंद्रह',
  'half a minute', 'полминуты', 'півхвилини', 'demi-minute', 'medio minuto',
  'halbe minute', 'meio minuto', 'mezzo minuto', '半分钟', '30秒', '30초',
];

function localeValue(locale: string, section: string, key: string): string {
  const json = JSON.parse(
    fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), 'utf8'),
  ) as Record<string, Record<string, unknown>>;
  const value = json[section]?.[key];
  if (typeof value !== 'string') throw new Error(`${locale}: нет строки ${section}.${key}`);
  return value;
}

describe('срок годности фактов ящика не назван числом ни в одной локали', () => {
  for (const locale of LOCALES) {
    for (const key of KEYS) {
      it(`${locale}: arbiter.${key} — без цифр`, () => {
        const value = localeValue(locale, 'arbiter', key);
        expect(DIGITS.test(value), `в ${locale}.json/${key} появилась цифра: «${value}»`).toBe(false);
      });

      it(`${locale}: arbiter.${key} — без «пятнадцати» прописью`, () => {
        const value = localeValue(locale, 'arbiter', key).toLowerCase();
        const found = SPELLED.filter((w) => value.includes(w.toLowerCase()));
        expect(found, `в ${locale}.json/${key} величина названа словом`).toEqual([]);
      });
    }
  }

  it('обе строки всё ещё говорят, что это слово СЕРВЕРА, а не цепи сию секунду', () => {
    // Снять число легко, снять вместе с ним и оговорку — тоже. Без неё арбитр,
    // только что взявший спор, прочтёт «ящик для вас закрыт» как утверждение
    // цепи и решит, что дело у него отняли. Проверяется на русском и
    // английском — тех двух, что пишутся здесь, а не переводятся.
    expect(localeValue('ru', 'arbiter', 'presentations_not_mine')).toContain('СЕРВЕР');
    expect(localeValue('ru', 'arbiter', 'presentations_box_closed')).toContain('сервера');
    expect(localeValue('en', 'arbiter', 'presentations_not_mine')).toContain('SERVER');
    expect(localeValue('en', 'arbiter', 'presentations_box_closed')).toContain("server's");
  });
});
