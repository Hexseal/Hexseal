/**
 * presentToArbiter.test.tsx — что есть в разметке (Задача 6).
 *
 * ⚠️ ЭТО СТРУКТУРНАЯ ПРОВЕРКА, И ТАК ОНА И НАЗЫВАЕТСЯ. Компонент настоящий,
 * тексты из настоящего `messages/ru.json`, отрисовка — `react-dom/server`.
 * Проверяется РАЗМЕТКА. Что человек это увидел и понял — не проверяется
 * ничем: у фронта нет ни jsdom, ни @testing-library, события не работают.
 *
 * ⚠️ И ГЛАВНОЕ, ЧЕМ ЭТОТ ФАЙЛ ОТЛИЧАЕТСЯ ОТ ЗАМКА НА ТЕКСТ СТРАНИЦЫ. Владелец
 * уже замерял такой замок и получил ноль: «удаление блока дисклеймера целиком
 * даёт 0 красных». Здесь предупреждение — ДАННЫЕ (`presentWarning`), а тест
 * сверяет разметку С ТЕМ, ЧТО НАЗВАЛА ФУНКЦИЯ: и число строк, и текст каждой.
 * Поэтому краснеет и снятие строки из функции, и снятие её из разметки при
 * живой функции (мутации 14 и 15).
 *
 * ⚠️ И ТО ЖЕ ПРАВИЛО ДЛЯ РЕШЕНИЙ: `canSendNow` здесь СЧИТАЕТСЯ настоящим
 * `canSend`, а не подаётся литералом (C4). Литерал превратил бы замок в
 * проверку проводки пропса, и мутация «убрать условие согласия» дала бы ноль,
 * выглядя при этом красным числом в отчёте.
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
  return params
    ? value.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? `{${name}}`))
    : value;
}

const ME    = '0x1111111111111111111111111111111111111111';
const PEER  = '0x2222222222222222222222222222222222222222';
const DEAL  = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const ARB   = '0x4444444444444444444444444444444444444444' as `0x${string}`;

let status = 4;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ME }),
  usePublicClient: () => null,
  useWalletClient: () => ({ data: null }),
  useReadContract: (args: { functionName: string }) => (
    args.functionName === 'status'
      ? { data: status }
      : { data: { client_: ME, executor_: PEER } }
  ),
}));
vi.mock('next-intl', () => ({ useTranslations: () => translate }));
vi.mock('react-hot-toast', () => ({
  toast: Object.assign(() => {}, { error: () => {}, success: () => {} }),
}));

/** ⚠️ Импорт ВНУТРИ тестов, как в соседних замках
 *  (`chatPanelDisplay.test.tsx:120`): `vi.mock` поднимается выше импортов, и
 *  статический импорт компонента утащил бы настоящий `wagmi` раньше подделки. */
const load = async () => ({
  ...(await import('./PresentToArbiter')),
  ...(await import('@/lib/presentToArbiter')),
});

const msg = (from: string, seq: number, text: string) =>
  ({ from, seq, text, timestamp: 1_754_400_000_000 + seq, isFromMe: from === ME });

describe('кнопка предъявления в разметке', () => {
  it('C1: вне спора кнопки в разметке НЕТ вовсе', async () => {
    const { PresentToArbiter } = await load();
    status = 2;
    const html = renderToStaticMarkup(
      <PresentToArbiter agreement={DEAL} peer={PEER as `0x${string}`}
        messages={[msg(ME, 0, 'раз')]} session={{} as never} />,
    );
    expect(html).toBe('');
  });

  it('C2: в споре и я сторона — кнопка в разметке есть', async () => {
    const { PresentToArbiter } = await load();
    status = 4;
    const html = renderToStaticMarkup(
      <PresentToArbiter agreement={DEAL} peer={PEER as `0x${string}`}
        messages={[msg(ME, 0, 'раз')]} session={{} as never} />,
    );
    expect(html).toContain('data-present-btn');
    expect(html).toContain(translate('chat.present_btn'));
  });
});

describe('предупреждение: разметка сверяется с тем, что назвала функция', () => {
  it('C3: печатаются РОВНО те строки, что вернул presentWarning', async () => {
    const { PresentWarningModal, presentWarning } = await load();
    const input = { count: 3, arbiter: ARB, turn: { known: true as const, turn: 2 } };
    const warning = presentWarning(input);
    const html = renderToStaticMarkup(
      <PresentWarningModal open lines={warning.lines} consent={false} busy={false}
        canSendNow={false} onConsent={() => {}} onSend={() => {}} onCancel={() => {}} />,
    );
    // Число строк — из функции, не из глаза.
    const printed = (html.match(/data-warn-line/g) ?? []).length;
    expect(printed, 'в разметке напечатано не столько строк, сколько названо').toBe(warning.lines.length);
    // И текст каждой.
    for (const line of warning.lines) {
      expect(html, `строка ${line.key} названа, но не напечатана`)
        .toContain(translate(line.key, line.params));
    }
    // Третьи лица и §2.10 — поимённо: они несущие, и потерять их молча нельзя.
    expect(html).toContain(translate('chat.present_warn_everything'));
    expect(html).toContain(translate('chat.present_warn_files'));
  });

  it('C4: без согласия «Отправить» заперта, с согласием — нет', async () => {
    const { PresentWarningModal, presentWarning, canSend } = await load();
    const lines = presentWarning({ count: 1, arbiter: ARB, turn: { known: false } }).lines;
    // ⚠️ `canSendNow` СЧИТАЕТСЯ ТЕМ ЖЕ РЕШАЮЩИМ, ЧТО И В БОЮ. Подай сюда
    // литералы `false`/`true` — замок мерил бы проводку пропса, а снятие
    // условия согласия из `canSend` не красило бы его вовсе: мутация была бы
    // пустой, а число красных — враньём.
    const render = (consent: boolean) => renderToStaticMarkup(
      <PresentWarningModal open lines={lines} consent={consent} busy={false}
        canSendNow={canSend({ consent, selected: 1, busy: false, status: 4 })}
        onConsent={() => {}} onSend={() => {}} onCancel={() => {}} />,
    );
    expect(render(false)).toContain('disabled=""');
    expect(render(true)).not.toContain('disabled=""');
    // Согласие — настоящий чекбокс, первый во всём фронте.
    expect(render(false)).toContain('type="checkbox"');
    expect(render(false)).toContain(translate('chat.present_consent'));
  });
});

describe('слежение за арбитром и судьба мешка', () => {
  it('C6: три сигнала смены — три РАЗНЫХ текста, каждый со своим ключом', async () => {
    const { PresentChangeNotice } = await load();
    const html = (signal: unknown) => renderToStaticMarkup(
      <PresentChangeNotice signal={signal as never} />,
    );
    // ⚠️ ФОРМА СИГНАЛА — ТРИ ЧЛЕНА, БЕЗ `blockNumber`: хозяин типа (Задача 5)
    // поле убрал, а лишнее поле в литерале теста не поймал бы никто — типы в
    // `*.test.tsx` не проверяются вовсе.
    const changed = html({ reason: 'arbiter_changed', arbiter: ARB });
    const rotated = html({ reason: 'key_changed', arbiter: ARB });
    const left    = html({ reason: 'arbiter_left', prevArbiter: ARB });
    expect(changed).toContain(translate('chat.present_err_arbiter_changed'));
    expect(rotated).toContain(translate('chat.present_err_key_changed'));
    expect(left).toContain(translate('chat.present_err_arbiter_left'));
    // Три текста, а не один на троих: лечение у них разное.
    expect(new Set([changed, rotated, left]).size).toBe(3);
    // Сигнала нет — и строки нет: пустое место лучше, чем «всё хорошо».
    expect(html(null)).toBe('');
  });

  it('C7: «положено · забрали» печатается ВРЕМЕНЕМ СЕРВЕРА, и «не знаю» отдельно', async () => {
    const { PresentSentLine } = await load();
    const placed = renderToStaticMarkup(
      <PresentSentLine state={{ kind: 'placed', uploadedAt: 1_754_401_010_000 }} />);
    const fetched = renderToStaticMarkup(
      <PresentSentLine state={{
        kind: 'fetched', uploadedAt: 1_754_401_010_000, fetchedAt: 1_754_401_070_000,
      }} />);
    const unknown = renderToStaticMarkup(<PresentSentLine state={{ kind: 'unknown' }} />);

    expect(placed).toContain(translate('chat.present_sent'));
    expect(placed).toContain(new Date(1_754_401_010_000).toLocaleTimeString());
    // Пока не забрали — про «забрали» НЕ пишем ничего.
    expect(placed).not.toContain(new Date(1_754_401_070_000).toLocaleTimeString());
    expect(fetched).toContain(new Date(1_754_401_070_000).toLocaleTimeString());
    // «Не спросили» — это не «не забрали», и текст у него свой.
    expect(unknown).toContain(translate('chat.present_fetch_unknown'));
    expect(unknown).not.toContain(translate('chat.present_sent'));
  });

  it('C8: собранное раньше предложено в модалке, и число названо', async () => {
    const { PresentPickerModal, selectableMessages } = await load();
    const { rows, dropped } = selectableMessages([msg(ME, 0, 'раз'), msg(PEER, 0, 'два')]);
    const withDraft = renderToStaticMarkup(
      <PresentPickerModal open rows={rows} dropped={dropped} picked={new Set()}
        notice={null} draft={{ count: 2, sent: false }} onToggle={() => {}} onUseDraft={() => {}}
        onNext={() => {}} onCancel={() => {}} />,
    );
    expect(withDraft).toContain('data-pick-draft');
    expect(withDraft).toContain(translate('chat.present_draft_found', { n: 2 }));
    expect(withDraft).toContain(translate('chat.present_draft_use'));
    // Черновика нет — и блока нет: «продолжить нечего» не показывают.
    const without = renderToStaticMarkup(
      <PresentPickerModal open rows={rows} dropped={dropped} picked={new Set()}
        notice={null} draft={null} onToggle={() => {}} onUseDraft={() => {}}
        onNext={() => {}} onCancel={() => {}} />,
    );
    expect(without).not.toContain('data-pick-draft');
  });

  it('C9: «не отправляли» и «уже предъявляли» — РАЗНЫЕ слова, а не один текст', async () => {
    // ⚠️ СЦЕНА §2.3 НА ГЛАЗАХ У ЧЕЛОВЕКА. Предъявили арбитру №1, арбитра
    // сменили, просят предъявить заново: черновик помечен `sent`, и сказать
    // ему «вы собрали и не отправили» значило бы соврать, а промолчать —
    // не предложить «одно нажатие» вовсе. Пересылки при этом нет и быть не
    // может (ключи запечатаны на прежнего), и второй текст говорит именно
    // это: соберётся заново, на нынешнем ключе.
    const { PresentPickerModal, selectableMessages } = await load();
    const { rows, dropped } = selectableMessages([msg(ME, 0, 'раз'), msg(PEER, 0, 'два')]);
    const html = (sent: boolean) => renderToStaticMarkup(
      <PresentPickerModal open rows={rows} dropped={dropped} picked={new Set()}
        notice={null} draft={{ count: 2, sent }} onToggle={() => {}} onUseDraft={() => {}}
        onNext={() => {}} onCancel={() => {}} />,
    );
    expect(html(false)).toContain(translate('chat.present_draft_found', { n: 2 }));
    expect(html(true)).toContain(translate('chat.present_draft_sent', { n: 2 }));
    // Ни в коем случае не оба сразу и не один на двоих.
    expect(html(true)).not.toContain(translate('chat.present_draft_found', { n: 2 }));
    expect(new Set([html(false), html(true)]).size, 'один текст на оба случая').toBe(2);
    // Вход «вернуть отметки» есть в обоих случаях — иначе «одно нажатие»
    // §2.3 остаётся обещанием.
    expect(html(true)).toContain(translate('chat.present_draft_use'));
  });
});

describe('выбор сообщений', () => {
  it('C5: по чекбоксу на сообщение, и число невыбираемых названо', async () => {
    const { PresentPickerModal, selectableMessages } = await load();
    const { rows, dropped } = selectableMessages([
      msg(ME, 0, 'раз'), msg(PEER, 0, 'два'), msg('bot', 1, 'служебное'),
    ]);
    expect({ rows: rows.length, dropped }).toEqual({ rows: 2, dropped: 1 });
    const html = renderToStaticMarkup(
      <PresentPickerModal open rows={rows} dropped={dropped} picked={new Set()}
        notice={null} draft={null} onToggle={() => {}} onUseDraft={() => {}}
        onNext={() => {}} onCancel={() => {}} />,
    );
    expect((html.match(/data-pick-row/g) ?? []).length).toBe(rows.length);
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(rows.length);
    expect(html).toContain('data-pick-dropped');
    expect(html).toContain(translate('chat.present_pick_dropped', { n: 1 }));
    // Пустой выбор — «Дальше» заперта: отправлять нечего.
    expect(html).toContain('disabled=""');
  });
});
