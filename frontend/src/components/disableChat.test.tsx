/**
 * disableChat.test.tsx — «отключить чат» больше не стирает ключ одним
 * нажатием (находка аудита К-1).
 *
 * ⚠️ ЧЕМ ЭТО БЫЛО. `WalletMenu` звал `disableChat` прямо с пункта меню.
 * Одно нажатие — `forgetSession`, ключ снят с устройства. Для обычного
 * кошелька это неудобство: подписал те же данные — ключ вернулся. Для
 * КОШЕЛЬКА-КОНТРАКТА ключ случайный, и второго источника у него нет: без
 * кода восстановления это вся переписка НАВСЕГДА. И тут же рядом стоял пункт
 * «включить», то есть человек даже не понимал, что потерял.
 *
 * Здесь заперто: подтверждение есть, оно РАЗНОЕ для двух родов кошелька, и
 * тому, кому есть что терять, предложено сперва посмотреть код.
 *
 * Разметка настоящая (`react-dom/server`), тексты — из настоящего
 * `messages/ru.json`; подменён только `next-intl`, которого в `node` нет.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');
const RU = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as Record<string, unknown>;

function translate(key: string, params?: Record<string, string | number>): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    RU,
  );
  if (typeof value !== 'string') throw new Error(`нет ключа перевода: ${key}`);
  return params ? value.replace(/\{(\w+)\}/g, (_m, n: string) => String(params[n] ?? `{${n}}`)) : value;
}

vi.mock('next-intl', () => ({ useTranslations: () => translate }));

const T = {
  title: translate('chat.disable_title'),
  eoa: translate('chat.disable_eoa'),
  contract: translate('chat.disable_contract'),
  confirm: translate('chat.disable_confirm'),
  showFirst: translate('chat.disable_show_code_first'),
};

async function render(patch: Partial<import('./DisableChatModal').DisableChatModalProps> = {}): Promise<string> {
  const { DisableChatModal } = await import('./DisableChatModal');
  return renderToStaticMarkup(React.createElement(DisableChatModal, {
    open: true,
    losesEverything: false,
    onConfirm: () => {},
    onShowCode: () => {},
    onCancel: () => {},
    ...patch,
  }));
}

describe('подтверждение отключения чата', () => {
  it('закрытое окно не рисует ничего', async () => {
    expect(await render({ open: false })).toBe('');
  });

  it('⚠️ обычному кошельку сказано про ПОДПИСЬ, а не про потерю', async () => {
    // Красит: одна надпись на оба рода. Обычному кошельку «переписка
    // пропадёт навсегда» — прямая неправда: он подпишет те же данные и
    // получит тот же ключ.
    const html = await render({ losesEverything: false });
    expect(html).toContain(T.title);
    expect(html).toContain(T.eoa);
    expect(html).not.toContain(T.contract);
  });

  it('⚠️ кошельку-контракту сказано про ПОТЕРЮ НАВСЕГДА', async () => {
    const html = await render({ losesEverything: true });
    expect(html).toContain(T.contract);
    expect(html).not.toContain(T.eoa);
  });

  it('две надписи — РАЗНЫЕ, а не одна с запасом', async () => {
    // Красит: копипаста одного текста в оба ключа. Тогда предыдущие два
    // теста прошли бы, а человек читал бы одно и то же.
    expect(T.eoa).not.toBe(T.contract);
  });

  it('тому, кому есть что терять, предложено сперва ПОСМОТРЕТЬ КОД', async () => {
    // Это и есть связка двух половин: показ кода уже сделан, вход в
    // восстановление тоже — здесь они встречаются в единственном месте, где
    // человек может потерять всё по неведению.
    const html = await render({ losesEverything: true });
    expect(html).toContain(T.showFirst);
  });

  it('обычному кошельку «посмотреть код» НЕ предлагается — кода у него нет', async () => {
    // Красит: кнопка, показанная всем. У обычного кошелька
    // `exportRecoveryCode` отказывает `recovery_not_applicable`, то есть
    // кнопка вела бы в пустоту.
    const html = await render({ losesEverything: false });
    expect(html).not.toContain(T.showFirst);
  });

  it('отключение — отдельная кнопка, а не единственная', async () => {
    const html = await render({ losesEverything: true });
    expect(html).toContain(T.confirm);
    expect(html).toContain(translate('common.cancel'));
  });

  it('окно не закрывается кликом мимо — на подложке нет обработчика', async () => {
    const { DisableChatModal } = await import('./DisableChatModal');
    const tree = DisableChatModal({
      open: true, losesEverything: true,
      onConfirm: () => {}, onShowCode: () => {}, onCancel: () => {},
    }) as React.ReactElement<{ onClick?: unknown; className?: string }>;
    expect(tree.props.className).toContain('fixed inset-0');
    expect(tree.props.onClick).toBeUndefined();
  });
});

describe('пункт меню больше не стирает ключ сразу', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

  it('⚠️ WalletMenu НЕ зовёт disable() напрямую — он просит подтверждения', () => {
    // ГЛАВНЫЙ ЗАМОК находки К-1. Красит: возврат `onClick={disableChat}`.
    const menu = read('components/WalletMenu.tsx');
    expect(menu).not.toMatch(/onClick=\{\s*disableChat\s*\}/);
    expect(menu).toContain('DISABLE_CHAT_EVENT');
  });

  it('окно подтверждения отрисовано привратником, а не просто ввезено', () => {
    // Та же проверка разметкой, что спасла на М-31: импорт без отрисовки
    // выглядит как подключение и им не является.
    const gate = read('components/RecoveryCodeGate.tsx');
    expect(gate).toMatch(/<DisableChatModal\b/);
    expect(gate).toMatch(/\{\s*disableModal\s*\}/);
  });

  it('род кошелька решает чистая функция, а не привратник на глаз', () => {
    const gate = read('components/RecoveryCodeGate.tsx');
    expect(gate).toContain('hasRecoveryCode');
  });
});
