/**
 * arbiterKeyCopyHonesty.test.ts — копирайт про ключ арбитра говорит правду
 * про сегодня (финальное ревью, находки №5 и №6).
 *
 * Находка №5: `arbiter.key_published` обещал «теперь вам смогут предъявить
 * переписку» и `no_key_notice` подразумевал то же — а предъявления в
 * продукте НЕТ, это следующая работа. Переписаны на честные про сегодня:
 * ключ ЗАПИСАН/ПУБЛИКУЕТСЯ в цепь, и на него МОЖНО БУДЕТ запечатать
 * переписку, когда предъявление появится.
 *
 * Находка №6: `en` и `ar` были переведены со смещением смысла — «nothing can
 * be presented AGAINST you» / «تقديم أي شيء ضدك» звучит как «против вас»,
 * будто арбитр подсудимый. Остальные 12 локалей говорили нейтрально
 * («вам», не «против вас»). `en` — локаль по умолчанию.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { locales } from './config';

type Messages = Record<string, unknown>;

const bundles: Record<string, Messages> = {};
for (const locale of locales) {
  const path = fileURLToPath(new URL(`../../messages/${locale}.json`, import.meta.url));
  bundles[locale] = JSON.parse(readFileSync(path, 'utf8')) as Messages;
}

function arbiter(locale: string): Record<string, string> {
  return (bundles[locale] as { arbiter: Record<string, string> }).arbiter;
}

describe('находка №6: en и ar — без «против вас»', () => {
  it('en.no_key_notice не говорит "against you"', () => {
    expect(arbiter('en').no_key_notice.toLowerCase()).not.toMatch(/against you/);
  });

  it('ar.no_key_notice не содержит "ضدك" (против тебя)', () => {
    expect(arbiter('ar').no_key_notice).not.toMatch(/ضدك/);
  });

  it('ни одна из 14 локалей не обвиняет арбитра ("против")', () => {
    // Общая проверка на будущее: en/ar были не единственными местами, где
    // могла просочиться формулировка "против" — этот же ключ.
    for (const locale of locales) {
      const text = arbiter(locale).no_key_notice;
      expect(text, `${locale}: no_key_notice звучит как "против"`).not.toMatch(/against you|ضدك/i);
    }
  });
});

describe('находка №5: копирайт не обещает предъявления, которого нет', () => {
  it('en.key_published не обещает "теперь можно предъявить" — только что ключ записан', () => {
    const text = arbiter('en').key_published;
    // Раньше здесь стояло "now the conversation can be presented to you" —
    // прямое обещание работающего предъявления. Новый текст обязан говорить
    // про ЗАПИСЬ ключа, а не про предъявление как свершившийся факт.
    expect(text).not.toMatch(/conversation can be presented/i);
    expect(text.toLowerCase()).toMatch(/on-chain/);
  });

  it('en.no_key_notice не обещает "nothing can be presented" как факт про сегодня', () => {
    const text = arbiter('en').no_key_notice;
    expect(text).not.toMatch(/nothing can be presented/i);
  });

  it('ru.key_published и ru.no_key_notice — эталонный честный текст (замок от отката)', () => {
    expect(arbiter('ru').key_published)
      .toBe('Готово — ключ записан в цепи, будет использован, когда появится предъявление дела.');
    expect(arbiter('ru').no_key_notice)
      .toBe('В цепи пока нет вашего ключа для переписки по этому делу — именно на него запечатают переписку, когда появится предъявление дела. Публикация — одна транзакция.');
  });

});
