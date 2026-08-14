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

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * ⚠️ ЦЕПЬ ОТВЕЧАЕТ НА ДВА ВОПРОСА, А НЕ НА ОДИН (итоговое ревью ветки, правка
 * 1). Кнопка живёт теперь не по статусу сделки, а по «кто ведёт спор сейчас», и
 * правило это составное: живой заявитель, при нуле — арбитр поданного вердикта.
 * Мок отвечает на оба чтения порознь именно затем, чтобы сцена «вердикт подан,
 * сделка уже RESOLVED» была здесь ВОЗМОЖНА — при старом моке (одно `status`) её
 * нельзя было даже поставить.
 */
let claimer: string = ZERO;
let verdict: { arbiter: string; submittedAt: bigint } = { arbiter: ZERO, submittedAt: 0n };

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ME }),
  usePublicClient: () => null,
  useWalletClient: () => ({ data: null }),
  useReadContract: (args: { functionName: string }) => {
    if (args.functionName === 'getDisputeClaimer') return { data: claimer };
    if (args.functionName === 'getPendingVerdict') return { data: verdict };
    return { data: { client_: ME, executor_: PEER } };
  },
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

/** Сообщение СТАРОЙ формы: ключ вложения лежит в самом сообщении (до
 *  10 августа 2026). Ровно то, что отдаёт `usePairChat` (`:355-370`). */
const msgWithKey = (from: string, seq: number, text: string) => ({
  ...msg(from, seq, text),
  attachment: { name: text, url: 'https://s/x', key: 'ab'.repeat(16), iv: 'cd'.repeat(6) },
});

function renderPanel(PresentToArbiter: (p: never) => React.ReactElement | null) {
  return renderToStaticMarkup(
    <PresentToArbiter agreement={DEAL} peer={PEER as `0x${string}`}
      messages={[msg(ME, 0, 'раз')]} session={{} as never} {...({} as never)} />,
  );
}

describe('кнопка предъявления в разметке', () => {
  it('C1: спор никто не ведёт — кнопки в разметке НЕТ вовсе', async () => {
    const { PresentToArbiter } = await load();
    claimer = ZERO;
    verdict = { arbiter: ZERO, submittedAt: 0n };
    expect(renderPanel(PresentToArbiter as never)).toBe('');
  });

  it('C2: спор ведут и я сторона — кнопка в разметке есть', async () => {
    const { PresentToArbiter } = await load();
    claimer = ARB;
    verdict = { arbiter: ZERO, submittedAt: 0n };
    const html = renderPanel(PresentToArbiter as never);
    expect(html).toContain('data-present-btn');
    expect(html).toContain(translate('chat.present_btn'));
  });

  it('C2b: вердикт подан, заявка стёрта — кнопка ЕСТЬ (шов со складом и экраном арбитра)', async () => {
    // ⚠️ ЭТО ТА САМАЯ СЦЕНА (решение владельца, итоговое ревью ветки). Арбитр
    // разбирает апелляцию и просит предъявить заново; сделка при этом уже
    // RESOLVED. При старом правиле кнопки не было, а склад отвечал 409 —
    // совет с экрана арбитра было физически нечем выполнить. Теперь и склад,
    // и кнопка смотрят на одно: у спора есть ведущий арбитр.
    const { PresentToArbiter } = await load();
    claimer = ZERO;
    verdict = { arbiter: ARB, submittedAt: 1n };
    expect(renderPanel(PresentToArbiter as never)).toContain('data-present-btn');
  });

  it('C2c: вердикта нет (submittedAt = 0) — запись о нём кнопку НЕ оживляет', async () => {
    // Пустая запись вердикта несёт нулевой адрес и нулевое время; принять её
    // за «арбитр есть» значило бы открыть кнопку на всякой сделке подряд.
    const { PresentToArbiter } = await load();
    claimer = ZERO;
    verdict = { arbiter: ARB, submittedAt: 0n };
    expect(renderPanel(PresentToArbiter as never)).toBe('');
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
        canSendNow={canSend({ consent, selected: 1, busy: false, arbiter: ARB })}
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

  it('C14: «в цепи не отмечено» — ТРЕТЬЯ строка и кнопка «отметить»', async () => {
    // ⚠️ РАДИ ЭТОГО ЗАДАЧА 6 СУЩЕСТВУЕТ ОТДЕЛЬНО. Мешок у арбитра, отпечатка в
    // цепи нет: «предъявлено» — неправда (страховки нет), «ошибка» — тоже
    // неправда (переписка у арбитра). Третье слово, и с выходом: кнопкой.
    const { PresentAnchorLine } = await load();
    const missing = renderToStaticMarkup(
      <PresentAnchorLine state={{ kind: 'missing', digest: `0x${'11'.repeat(32)}` }}
        busy={false} onRetry={() => {}} />);
    const anchored = renderToStaticMarkup(
      <PresentAnchorLine state={{ kind: 'anchored', txHash: `0x${'ab'.repeat(32)}` }}
        busy={false} onRetry={() => {}} />);
    const none = renderToStaticMarkup(
      <PresentAnchorLine state={{ kind: 'none' }} busy={false} onRetry={() => {}} />);

    expect(missing).toContain(translate('chat.present_not_anchored'));
    expect(missing, 'у плохой новости нет выхода — кнопки «отметить» нет')
      .toContain('data-present-anchor-retry');
    expect(missing).toContain(translate('chat.present_anchor_retry'));
    expect(anchored).toContain(translate('chat.present_anchored'));
    expect(anchored, 'отмеченное предлагают отметить ещё раз')
      .not.toContain('data-present-anchor-retry');
    // Три РАЗНЫХ вида, и «не спрашивали» — пустое место, а не «всё хорошо».
    expect(none).toBe('');
    expect(new Set([missing, anchored, none]).size).toBe(3);
    // Средняя строка не выдаёт себя за успех.
    expect(missing).not.toContain(translate('chat.present_anchored'));
    // Пока идём в цепь — кнопка заперта: два похода одним нажатием не нужны.
    const busy = renderToStaticMarkup(
      <PresentAnchorLine state={{ kind: 'missing', digest: `0x${'11'.repeat(32)}` }}
        busy onRetry={() => {}} />);
    expect(busy).toContain('disabled=""');
    expect(missing).not.toContain('disabled=""');
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

/**
 * ВТОРОЙ СЛОЙ — СВЕРКА ТЕКСТА ИСХОДНИКА, и его природа названа прямо здесь.
 *
 * ⚠️ ЭТО ЗАМОК НА ПРОВОДКУ, А НЕ НА РАБОТУ. Он видит, что имя употреблено в
 * нужном месте, и НЕ видит, что оно употреблено осмысленно: `{false && <X/>}`
 * или `tickBoxImpl({} as never)` оставили бы его зелёным. Работу меряют
 * поведенческие замки в `lib/presentToArbiter.test.ts` (T33–T39) — здесь
 * закрывается ровно та половина, которой у них нет: что вынесенное **кому-то
 * отдано**. Тот же приём и та же оговорка, что у соседа
 * (`lib/chainEventBus.test.ts`, «второй слой — сверка ТЕКСТА»).
 *
 * ⚠️ Позвать по-настоящему нельзя: ни jsdom, ни `@testing-library` в проекте
 * нет, эффекты не исполняются, `renderToStaticMarkup` их не запускает.
 * НАЖАТИЕ не проверяется по-прежнему ничем, и это остаётся правдой.
 */
describe('проводка: вынесенное действительно кому-то отдано (замок на ТЕКСТ)', () => {
  const PANEL = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), './ChatPanel.tsx'), 'utf8');
  const SELF = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), './PresentToArbiter.tsx'), 'utf8');

  it('C10: кнопка ВСТАВЛЕНА в панель чата — иначе её нет в приложении вовсе', () => {
    // ⚠️ ПРИЕХАЛО РЕВЬЮ (круг 1, I-2). Удали две строки вставки из
    // `ChatPanel.tsx` — красных было НОЛЬ, а кнопки в приложении нет: то
    // единственное, ради чего задача существует, держалось дисциплиной.
    expect(PANEL, 'ChatPanel не импортирует кнопку предъявления')
      .toMatch(/import\s*\{\s*PresentToArbiter\s*\}\s*from\s*'@\/components\/PresentToArbiter'/);
    expect(PANEL, 'кнопка не отрисовывается в панели').toMatch(/<PresentToArbiter\b/);
    // И ей отданы все четыре пропса — без любого из них она не соберётся, но
    // `npm run build` скажет об этом непонятным местом, а этот замок — именем.
    for (const prop of ['agreement=', 'peer=', 'messages=', 'session=']) {
      const at = PANEL.indexOf('<PresentToArbiter');
      expect(PANEL.slice(at, at + 400), `кнопке не передан ${prop}`).toContain(prop);
    }
  });

  it('C11: вынесенные тела эффектов отданы самим эффектам', () => {
    // Половина, которой нет у T33–T39: они меряют работу вынесенных функций,
    // но не то, что кто-то их зовёт.
    expect(SELF, 'восстановление при монтировании никем не вызывается')
      .toMatch(/void\s+restoreMountImpl\s*\(/);
    expect(SELF, 'такт описи никем не вызывается')
      .toMatch(/void\s+tickBoxImpl\s*\(/);
    expect(SELF, 'опрос не прекращается после «забрали»')
      .toMatch(/if\s*\(!shouldPollBox\(/);
    expect(SELF, 'человеку не говорят, что запись на устройстве не легла')
      .toMatch(/draftKeepNotice\s*\(\s*verdict\s*\)/);
    // ⚠️ Круг 2: число старых вложений считается по ОТМЕЧЕННЫМ, а не по всей
    // переписке. Замерено: подмена `selectedRows` на `rows` даёт ноль красных
    // во всех поведенческих — счёт-то верный, неверен набор, а набор
    // собирается здесь. Это ловится только текстом, и это его законная работа.
    expect(SELF, 'старые вложения считаются не по отмеченным')
      .toMatch(/legacyExposed:\s*countLegacyExposed\(selectedRows\)/);
    // ⚠️ И обратная сторона: восстановлению отданы ФУНКЦИОНАЛЬНЫЕ обновления,
    // а не прямая запись. Слияния (`keepFirstSent`/`keepKnownBox`) без этого
    // получали бы не то `prev`, ради которого написаны, и правило
    // «восстановленное старое не затирает свежее» умерло бы при зелёных
    // T33/T34 — они-то зовут слияния сами.
    // ⚠️ Прямая запись в `doSend` (`setSent({ key: verdict.bagKey })`) законна
    // и намеренно НЕ запрещается: там свежая отправка, затирать нечего.
    expect(SELF, 'восстановлению отданы не функциональные обновления')
      .toMatch(/applySent:\s*\(fn\)\s*=>\s*setSent\(fn\)/);
    expect(SELF, 'восстановлению отданы не функциональные обновления')
      .toMatch(/applyBox:\s*\(fn\)\s*=>\s*setBoxState\(fn\)/);
  });

  it('C15: второй шаг ОТДАН отправке, а третье состояние — экрану', () => {
    // ⚠️ ТА ЖЕ ПРИРОДА, ЧТО У C11: замок на проводку, а не на работу. Работу
    // второго шага меряют T43–T48; здесь закрывается ровно то, чего у них
    // нет, — что решения кому-то отданы. Без этого `sendPresentation` получил
    // бы `recordDigest`, который ничего не делает, а `presentSay` считал бы
    // слова, которых никто не показывает.
    expect(SELF, 'отправке не отдан второй шаг — отпечаток в цепь не поедет ни разу')
      .toMatch(/recordDigest:\s*\(digest\)\s*=>\s*\n?\s*recordPresentationDigestGasless\(/);
    expect(SELF, 'слово после отправки выбирает не presentSay, а ветвление на месте')
      .toMatch(/presentSay\(verdict\)/);
    // ⚠️ Слияние — ДО раннего выхода по отказу, иначе правило «отказ не стирает
    // неотмеченного» (T47) на экране не действует ни разу: `return` случится
    // раньше. Проверяется расстоянием: `setAnchor` стоит перед `if (!verdict.ok)`.
    const merge = SELF.indexOf('setAnchor(prev => anchorAfter(prev, verdict))');
    const bail  = SELF.indexOf('if (!verdict.ok) {');
    expect(merge, 'состояние отпечатка никем не сливается').toBeGreaterThan(0);
    expect(bail, 'ранний выход по отказу пропал — сцена изменилась').toBeGreaterThan(0);
    expect(merge, 'слияние стоит ПОСЛЕ раннего выхода: при отказе строка гаснет')
      .toBeLessThan(bail);
    expect(SELF, 'кнопке «отметить» не отдан повтор').toMatch(/void\s+retryAnchorImpl\(/);
    expect(SELF, 'строка про отпечаток не отрисовывается').toMatch(/<PresentAnchorLine\b/);
    // ⚠️ Ревью, круг 1, правка 2: нажатие «отметить» без кошелька молчало.
    // Решение вынесено (T49), здесь — что его СПРАШИВАЮТ и что отказ доезжает
    // до человека тостом, а не до консоли.
    expect(SELF, 'повтор отметки решает не anchorRetryGate, а условие на месте')
      .toMatch(/anchorRetryGate\(\{/);
    expect(SELF, 'отказ повтора не показывается человеку — нажатие проваливается в тишину')
      .toMatch(/if\s*\(gate\.key\)\s*toast\.error\(/);
  });

  it('C16: «отмечено ли» СПРАШИВАЕТСЯ У ЦЕПИ на монтировании, и тем же путём, что у арбитра', () => {
    // ⚠️ ТА ЖЕ ПРИРОДА, ЧТО У C11/C15: замок на проводку. Работу восстановления
    // меряют H1-H8 (`lib/presentationAnchor.test.ts`); здесь закрывается ровно
    // то, чего у них нет, — что кто-то это зовёт. Без строки ниже человек,
    // перезагрузивший вкладку на неотмеченном предъявлении, возвращается к
    // экрану без строки и без кнопки — это сомнение №1 отчёта Задачи 6.
    expect(SELF, 'восстановление отметки из цепи никем не вызывается')
      .toMatch(/void\s+restoreAnchorImpl\s*\(/);
    // ⚠️ И ЧТЕНИЕ ЦЕПИ — ОДНО НА ОБЕ СТОРОНЫ. Своя копия здесь разошлась бы с
    // арбитровой молча: сторона видела бы «отмечено» там, где арбитр видит
    // «не сходится».
    expect(SELF, 'сторона читает цепь своим способом, а не общим')
      .toMatch(/readAnchors:\s*\(\)\s*=>\s*readChainAnchors\(/);
    // ⚠️ ФУНКЦИОНАЛЬНОЕ ОБНОВЛЕНИЕ, как у C11: без него `keepKnownAnchor`
    // получал бы не то `prev`, ради которого написан, и правило
    // «восстановленное не затирает известное» умерло бы при зелёном H7.
    expect(SELF, 'восстановлению отдана прямая запись вместо слияния')
      .toMatch(/applyAnchor:\s*\(fn\)\s*=>\s*setAnchor\(fn\)/);
  });
});

describe('старое вложение: человек видит, КАКИЕ сообщения это касается', () => {
  it('C12: помечено ровно то сообщение, у которого ключ в нём самом', async () => {
    // ⚠️ ПОМЕТКА НУЖНА ДО ОТМЕТКИ (ревью, круг 2). Число в окне согласия
    // отвечает «сколько», а этот значок — «какие именно»; без него человек
    // узнавал бы про исключение уже после того, как всё выбрал.
    const { PresentPickerModal, selectableMessages } = await load();
    const { rows, dropped } = selectableMessages([
      msgWithKey(ME, 0, 'акт.pdf'), msg(PEER, 0, 'привет'),
    ]);
    expect(rows.map(r => r.legacyAttachmentExposed)).toEqual([true, false]);
    const html = renderToStaticMarkup(
      <PresentPickerModal open rows={rows} dropped={dropped} picked={new Set()}
        notice={null} draft={null} onToggle={() => {}} onUseDraft={() => {}}
        onNext={() => {}} onCancel={() => {}} />,
    );
    // Ровно ОДНА пометка на два сообщения — не на всех и не ни на ком.
    expect((html.match(/data-pick-legacy/g) ?? []).length).toBe(1);
    expect(html).toContain(translate('chat.present_pick_legacy_mark'));

    // Старых вложений нет — и пометки нет вовсе.
    const clean = selectableMessages([msg(ME, 0, 'привет'), msg(PEER, 0, 'ответ')]);
    const quiet = renderToStaticMarkup(
      <PresentPickerModal open rows={clean.rows} dropped={clean.dropped} picked={new Set()}
        notice={null} draft={null} onToggle={() => {}} onUseDraft={() => {}}
        onNext={() => {}} onCancel={() => {}} />,
    );
    expect(quiet).not.toContain('data-pick-legacy');
    expect(quiet).not.toContain(translate('chat.present_pick_legacy_mark'));
  });

  it('C13: строка предупреждения про старые вложения печатается числом', async () => {
    const { PresentWarningModal, presentWarning } = await load();
    const lines = presentWarning({
      count: 3, arbiter: ARB, turn: { known: true as const, turn: 1 }, legacyExposed: 2,
    }).lines;
    const html = renderToStaticMarkup(
      <PresentWarningModal open lines={lines} consent={false} busy={false}
        canSendNow={false} onConsent={() => {}} onSend={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain(translate('chat.present_warn_legacy_files', { n: 2 }));
    // И число подставлено, а не осталось фигурной скобкой.
    expect(html).not.toContain('{n}');
    // Ноль — строки в разметке нет, потому что её нет в списке.
    const zero = renderToStaticMarkup(
      <PresentWarningModal open busy={false} consent={false} canSendNow={false}
        lines={presentWarning({ count: 3, arbiter: ARB, turn: { known: true as const, turn: 1 } }).lines}
        onConsent={() => {}} onSend={() => {}} onCancel={() => {}} />,
    );
    expect(zero).not.toContain(translate('chat.present_warn_legacy_files', { n: 2 }));
  });
});
