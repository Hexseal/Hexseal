/**
 * recoveryCode.test.tsx — что человек ВИДИТ, когда ему выдали код (Задача 8).
 *
 * ⚠️ ЭТО НАСТОЯЩЕЕ ОКНО, а не его описание. `RecoveryCodeModal` импортируется
 * как есть и отрисовывается `react-dom/server` в разметку; проверяется
 * РАЗМЕТКА и настоящие тексты из `messages/ru.json`. Той же дисциплиной
 * живут `chatPanelDisplay.test.tsx` и `chatPanelCircumstances.test.tsx`.
 *
 *   ЧТО НАСТОЯЩЕЕ: сам компонент, его ветвления, порядок узлов, тексты.
 *   ЧТО ПОДМЕНЕНО: `next-intl` (в `node` его React-обёртки не живут).
 *   ЧЕГО НЕТ: событий и эффектов — jsdom у фронта нет (шапка
 *   `vitest.config.mjs`). Поэтому окно СДЕЛАНО управляемым: шаг, ответы и
 *   несошедшийся номер приходят пропсами, а решает их `lib/chatRecovery.ts`,
 *   запертый отдельно.
 *
 * Замер, ради которого файл существует: до него `recoveryCode` из
 * `useChatSession.ts` не читал ни один компонент — код выдавался и не
 * показывался никогда.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');
const RU = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as Record<string, unknown>;

/** Настоящий словарь, а не `k => k`: тест обязан видеть ТЕКСТ, который увидит
 *  человек. Отсутствующий ключ — красный тест, а не тихий прочерк. */
function translate(key: string, params?: Record<string, string | number>): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    RU,
  );
  if (typeof value !== 'string') throw new Error(`нет ключа перевода: ${key}`);
  return params
    ? value.replace(/\{(\w+)\}/g, (_m, n: string) => String(params[n] ?? `{${n}}`))
    : value;
}

vi.mock('next-intl', () => ({ useTranslations: () => translate }));

const GOLD = entropyToMnemonic(new Uint8Array(16).fill(0x7f), wordlist);
const WORDS = GOLD.split(' ');

const TEXTS = {
  title: translate('chat.recovery_warning_title'),
  access: translate('chat.recovery_warning_access'),
  loss: translate('chat.recovery_warning_loss'),
  keep: translate('chat.recovery_warning_keep'),
  written: translate('chat.recovery_written'),
  skip: translate('chat.recovery_skip'),
  where: translate('chat.recovery_where'),
  checkTitle: translate('chat.recovery_check_title'),
  checkHint: translate('chat.recovery_check_hint'),
  done: translate('chat.recovery_check_done'),
  reminder: translate('chat.recovery_reminder'),
  show: translate('chat.recovery_show'),
  keyNotSaved: translate('chat.key_not_saved'),
};

type Props = Partial<import('./RecoveryCodeModal').RecoveryCodeModalProps>;

async function renderModal(patch: Props = {}): Promise<string> {
  const { RecoveryCodeModal } = await import('./RecoveryCodeModal');
  return renderToStaticMarkup(React.createElement(RecoveryCodeModal, {
    open: true,
    words: WORDS,
    positions: [2, 5, 9],
    step: 'show',
    answers: {},
    failed: null,
    copied: false,
    notSaved: false,
    onCopy: () => {},
    onAnswer: () => {},
    onProceed: () => {},
    onConfirm: () => {},
    onSkip: () => {},
    ...patch,
  }));
}

/* ───────────────────────── показ кода ─────────────────────────────────── */

describe('окно с кодом — первый шаг', () => {
  it('закрытое окно не рисует ничего — и код в разметку не попадает', async () => {
    // Красит: окно, которое всегда в дереве и лишь спрятано стилем — код
    // тогда лежит в разметке страницы у всех, включая обычные кошельки.
    const html = await renderModal({ open: false });
    expect(html).toBe('');
    for (const word of WORDS) expect(html).not.toContain(word);
  });

  it('все четыре утверждённые строки на экране — из переводов, не из кода', async () => {
    // Свойство 3 задачи. Строки берутся из настоящего `messages/ru.json`:
    // если компонент зашьёт текст в себя, он разойдётся с переводом и тест
    // покраснеет на первой же правке словаря.
    const html = await renderModal();
    expect(html).toContain(TEXTS.title);
    expect(html).toContain(TEXTS.access);
    expect(html).toContain(TEXTS.loss);
    expect(html).toContain(TEXTS.keep);
  });

  it('все двенадцать слов показаны, каждое со своим номером', async () => {
    const html = await renderModal();
    for (let i = 0; i < WORDS.length; i++) {
      expect(html).toContain(WORDS[i]);
      expect(html).toContain(`>${i + 1}<`);
    }
  });

  it('есть кнопка «скопировать» и кнопка «я записал»', async () => {
    const html = await renderModal();
    expect(html).toContain(translate('common.copy'));
    expect(html).toContain(TEXTS.written);
  });

  it('после копирования сказано, что скопировано', async () => {
    const html = await renderModal({ copied: true });
    expect(html).toContain(translate('common.copied'));
  });

  it('честный выход есть, и рядом сказано, где взять код потом', async () => {
    // Требование владельца: наглухо запертое окно даёт дефект хуже
    // чинимого — человек в дороге, записывать нечем, и он не может начать
    // пользоваться вовсе.
    const html = await renderModal();
    expect(html).toContain(TEXTS.skip);
    expect(html).toContain(TEXTS.where);
  });

  it('окно не закрывается кликом мимо — на подложке нет обработчика', async () => {
    // ⚠️ Единственный способ проверить это без DOM: убедиться, что React
    // НЕ повесил обработчик на подложку. `renderToStaticMarkup` обработчики
    // в разметку не пишет вовсе — значит смотрим иначе, по дереву элементов.
    const { RecoveryCodeModal } = await import('./RecoveryCodeModal');
    const tree = RecoveryCodeModal({
      open: true, words: WORDS, positions: [2, 5, 9], step: 'show', answers: {},
      failed: null, copied: false, notSaved: false,
      onCopy: () => {}, onAnswer: () => {}, onProceed: () => {},
      onConfirm: () => {}, onSkip: () => {},
    }) as React.ReactElement<{ onClick?: unknown; className?: string }>;
    expect(tree.props.className).toContain('fixed inset-0');
    expect(tree.props.onClick).toBeUndefined();
  });

  it('ключ не лёг на устройство — про это сказано прямо в окне', async () => {
    // Обстоятельство 2: диск кончился. Код всё равно показываем — он
    // единственное, чем человек вернёт себе переписку. Но молчать про то,
    // что на устройстве ничего не осталось, нельзя.
    const html = await renderModal({ notSaved: true });
    expect(html).toContain(TEXTS.keyNotSaved);
  });

  it('обычное окно про несохранённый ключ не врёт', async () => {
    const html = await renderModal({ notSaved: false });
    expect(html).not.toContain(TEXTS.keyNotSaved);
  });
});

/* ──────────────────────── шаг проверки ────────────────────────────────── */

describe('шаг проверки — докажи, что записал', () => {
  it('⚠️ КОД НА ЭТОМ ШАГЕ НЕ ПОКАЗАН — иначе проверка ничего не доказывает', async () => {
    // Главный замок шага. Красит: окно, которое оставляет двенадцать слов на
    // экране рядом с полями — человек списывает с экрана, а не с бумажки, и
    // проверка становится украшением.
    const html = await renderModal({ step: 'check' });
    for (const word of WORDS) expect(html, `слово «${word}» видно`).not.toContain(word);
  });

  it('спрошены ровно те номера, что выбраны, и подписаны словами', async () => {
    const html = await renderModal({ step: 'check', positions: [3, 7, 11] });
    expect(html).toContain(TEXTS.checkTitle);
    expect(html).toContain(TEXTS.checkHint);
    // ⚠️ Подпись сверяется ЦЕЛЫМ УЗЛОМ (`>Слово 3<`), а не вхождением
    // подстроки: «Слово 1» лежит внутри «Слово 11», и наивная проверка
    // отсутствия объявила бы спрошенным то, чего не спрашивали. Поймано
    // этим же тестом на первом прогоне.
    const label = (n: number) => `>${translate('chat.recovery_check_word', { n })}<`;
    for (const n of [3, 7, 11]) expect(html).toContain(label(n));
    for (const n of [1, 2, 4, 12]) expect(html).not.toContain(label(n));
  });

  it('ровно три поля ввода — по числу спрошенных слов', async () => {
    const html = await renderModal({ step: 'check' });
    expect((html.match(/<input/g) ?? [])).toHaveLength(3);
  });

  it('⚠️ поля не подсказывают ответ: ни автодополнение, ни правописание, ни менеджер паролей', async () => {
    // Обстоятельство 5, усиленное владельцем. Браузер, помнящий прошлый
    // ввод, подставил бы правильное слово прямо в подсказке — и проверка
    // проверяла бы память браузера, а не человека.
    const html = await renderModal({ step: 'check' });
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(3);
    // ⚠️ РЕГИСТР ИМЕНИ АТРИБУТА НЕ ВАЖЕН, и это ЗАМЕРЕНО, а не предположено:
    // react-dom 19.1 пишет в разметку `autoComplete="off"`, `spellCheck=
    // "false"` — как названы пропсы, — и лишь часть имён (`tabindex`)
    // приводит к нижнему регистру. Имена атрибутов HTML разбираются без
    // учёта регистра, так что браузер видит ровно то, что нужно. Сверять
    // здесь нижний регистр значило бы держать тест, красный на исправном
    // окне.
    for (const input of inputs) {
      const attrs = input.toLowerCase();
      expect(attrs, input).toContain('autocomplete="off"');
      expect(attrs, input).toContain('autocorrect="off"');
      expect(attrs, input).toContain('autocapitalize="off"');
      expect(attrs, input).toContain('spellcheck="false"');
      // Менеджеры паролей игнорируют autocomplete="off"; у 1Password и
      // LastPass есть свои признаки, и они дешевы.
      expect(attrs, input).toContain('data-1p-ignore');
      expect(attrs, input).toContain('data-lpignore="true"');
    }
  });

  it('несошедшееся слово названо НОМЕРОМ, а не «неверно»', async () => {
    const html = await renderModal({ step: 'check', positions: [3, 7, 11], failed: 7 });
    expect(html).toContain(translate('chat.recovery_check_failed', { n: 7 }));
    // И это не тот же текст, что подпись поля, — иначе «ошибка» неотличима
    // от обычного состояния.
    expect(translate('chat.recovery_check_failed', { n: 7 }))
      .not.toBe(translate('chat.recovery_check_word', { n: 7 }));
  });

  it('без ошибки текста ошибки нет', async () => {
    const html = await renderModal({ step: 'check', positions: [3, 7, 11], failed: null });
    for (const n of [3, 7, 11]) {
      expect(html).not.toContain(translate('chat.recovery_check_failed', { n }));
    }
  });

  it('вписанные слова видны в своих полях', async () => {
    const html = await renderModal({
      step: 'check', positions: [2, 5, 9], answers: { 2: 'альфа', 5: 'браво' },
    });
    expect(html).toContain('value="альфа"');
    expect(html).toContain('value="браво"');
  });

  it('на шаге проверки есть «готово» и всё тот же честный выход', async () => {
    const html = await renderModal({ step: 'check' });
    expect(html).toContain(TEXTS.done);
    expect(html).toContain(TEXTS.skip);
  });
});

/* ───────────────────────── плашка-напоминание ─────────────────────────── */

describe('плашка-напоминание в чате', () => {
  async function renderReminder(visible: boolean): Promise<string> {
    const { RecoveryReminder } = await import('./RecoveryCodeModal');
    return renderToStaticMarkup(React.createElement(RecoveryReminder, {
      visible, onShow: () => {},
    }));
  }

  it('видна, пока код не подтверждён — с текстом и кнопкой «показать»', async () => {
    const html = await renderReminder(true);
    expect(html).toContain(TEXTS.reminder);
    expect(html).toContain(TEXTS.show);
  });

  it('после подтверждения не рисуется вовсе', async () => {
    expect(await renderReminder(false)).toBe('');
  });

  it('плашка НЕ содержит кода — она напоминает, а не показывает', async () => {
    const html = await renderReminder(true);
    for (const word of WORDS) expect(html).not.toContain(word);
  });
});
