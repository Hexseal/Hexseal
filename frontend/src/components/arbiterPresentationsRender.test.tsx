/**
 * arbiterPresentationsRender.test.tsx — СТРУКТУРНЫЙ замок разметки арбитра.
 *
 * ⚠️ НАЗЫВАЮ ВСЛУХ: ЭТО СТРУКТУРНАЯ ПРОВЕРКА, А НЕ ПОВЕДЕНЧЕСКАЯ. У фронта нет
 * ни jsdom, ни `@testing-library` (`environment: 'node'`): нажатие не
 * проверяется ничем, и что кнопка дошла ДО ГЛАЗ — не замеряется вовсе.
 * Проверяется ровно одно: что решённое доехало ДО РАЗМЕТКИ и что запрещённое в
 * ней не появилось. Класс промаха, ради которого замок стоит, известен и
 * оплачен (находка К-2: разводка причин доехала до панели и не доехала до
 * списка).
 *
 * ⚠️ ПЕРЕВОДЫ ЗДЕСЬ НАСТОЯЩИЕ — читаются из `messages/ru.json`. Подставной
 * словарь сделал бы замок тавтологией: он сверял бы разметку с тем, что сам же
 * и придумал, и молчал бы ровно в том случае, ради которого стоит, — ключ
 * объявлен в коде и не заведён в локали.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortAddr } from '@/lib/utils';
import type { DisputeBoxReading, PresentedBag } from '@/lib/arbiterPresentations';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');
const RU = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as Record<string, unknown>;

function translate(key: string, params?: Record<string, string | number>): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), RU);
  if (typeof value !== 'string') throw new Error(`нет ключа перевода: ${key}`);
  return params ? value.replace(/\{(\w+)\}/g, (_m, n: string) => String(params[n] ?? `{${n}}`)) : value;
}
vi.mock('next-intl', () => ({ useTranslations: () => translate }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));

const A = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const B = '0x2222222222222222222222222222222222222222' as `0x${string}`;

const emptyReading = (over: Partial<DisputeBoxReading> = {}): DisputeBoxReading => ({
  arbiterNow: A, mine: true, listed: 0, tried: 0, stop: 'read_all',
  sealedForOthersDeclared: 0, notOurs: 0, notOursFetched: 0,
  // ⚠️ Индекс доверенный — умолчание для ВСЕХ сцен R1-R10: ни одна из них это
  // поле не переопределяет и не обязана, они про другие охранники. Сцена
  // «опись перестраивалась» (R7b) называет его явно.
  indexTrusted: true,
  skipped: [], presentations: [], ...over,
});

const bagOf = (over: Partial<PresentedBag> = {}): PresentedBag => ({
  bagKey: 'k', uploadedBy: A, uploadedAt: 1,
  declared: { read: 3, hidden: 4, notPrepared: 1 },
  measured: { read: 2, unopened: 1, hidden: 4, notPrepared: 1 },
  countsDisagree: [], uploaderIsPresenter: true,
  view: { container: 'ok', messages: [], counts: { read: 2, unopened: 1, hidden: 4, notPrepared: 1 },
          notPrepared: [], perSender: [], presenter: A },
  messages: [{
    seq: 0, sender: A, read: true, text: 'сроки прошли', file: null,
    openFailure: null, attestation: 'ok', frameFailure: null,
    authorConfirmed: true, attestedAt: 1_754_400_000_000, legacyAttachmentExposed: false,
  }],
  ...over,
});

async function summary(reading: DisputeBoxReading, before: number | null, deviceKey = 'agree' as const): Promise<string> {
  const { BoxSummaryView } = await import('@/components/ArbiterPresentations');
  return renderToStaticMarkup(React.createElement(BoxSummaryView, { reading, before, deviceKey }));
}
async function bagHtml(bag: PresentedBag): Promise<string> {
  const { PresentationBagView } = await import('@/components/ArbiterPresentations');
  return renderToStaticMarkup(React.createElement(PresentationBagView, { bag }));
}

describe('два набора чисел — двумя строками', () => {
  it('R1: заявленное и посчитанное подписаны отдельно, ни одно не подменено', async () => {
    const html = await bagHtml(bagOf());
    expect(html).toContain(translate('arbiter.presentation_counts_declared',
      { read: 3, hidden: 4, notPrepared: 1 }));
    expect(html).toContain(translate('arbiter.presentation_counts_measured',
      { read: 2, unopened: 1, hidden: 4, notPrepared: 1 }));
  });

  it('R2: подпись не сошлась — слова стороны на экране НЕТ, а причина есть', async () => {
    const html = await bagHtml(bagOf({
      declared: null, uploaderIsPresenter: null,
      view: { ...bagOf().view, container: 'bad_signature' },
      messages: [{ seq: 0, sender: B, read: false, text: null, file: null, openFailure: null,
                   attestation: 'absent', frameFailure: null, authorConfirmed: false,
                   attestedAt: null, legacyAttachmentExposed: false }],
    }));
    expect(html).toContain(translate('arbiter.presentation_bad_signature'));
    expect(html, 'числа приписаны неизвестному автору').not.toContain('Счёт стороны:');
    expect(html).toContain(translate('arbiter.msg_author_unconfirmed', { verdict: 'absent' }));
  });
});

describe('слово сервера названо словом сервера', () => {
  it('R3: мешки на других арбитров — с пометкой, и без единого числа из них', async () => {
    const html = await summary(emptyReading({ sealedForOthersDeclared: 7, listed: 7 }), 1);
    expect(html).toContain(translate('arbiter.presentations_sealed_for_others', { count: 7 }));
    expect(html, 'слово сервера выдано за факт').toContain('СЕРВЕРА');
  });

  it('R4: счёт арбитров неизвестен — надпись «не знаем», нуля на экране нет', async () => {
    const html = await summary(emptyReading(), null);
    expect(html).toContain(translate('arbiter.presentations_turn_unknown'));
    expect(html).not.toContain(translate('arbiter.presentations_turn_known', { count: 0 }));
  });

  it('R5: ящик прочитан не целиком — сказано числом, а не молчанием', async () => {
    const html = await summary(emptyReading({ listed: 122, tried: 99, stop: 'read_budget' }), 0);
    expect(html).toContain(translate('arbiter.presentations_partial', { read: 99, total: 122 }));
    expect(html, '«пусто» показано поверх непрочитанного ящика')
      .not.toContain(translate('arbiter.presentations_empty'));
  });
});

describe('посчитанное доезжает до глаз, а «пусто» — не всегда', () => {
  it('R6: нечитаемые мешки названы ЧИСЛОМ, а не молчанием', async () => {
    const html = await summary(emptyReading({ listed: 3, tried: 3, notOurs: 3 }), 0);
    expect(html, 'посчитанное нечитаемое не доехало до разметки')
      .toContain(translate('arbiter.presentations_not_ours', { count: 3 }));
  });

  it('R7: «вам ничего не предъявили» подавлено, если ящик пуст не по обоим счётам', async () => {
    // ПОСЧИТАННОЕ: печать не открылась — факт.
    const measured = await summary(emptyReading({ listed: 3, tried: 3, notOurs: 3 }), 0);
    expect(measured, '«сторона молчала» сказано вместо «мы не открыли»')
      .not.toContain(translate('arbiter.presentations_empty'));
    // ЗАЯВЛЕННОЕ: слово сервера. Заголовка могло не быть вовсе, поэтому одного
    // этого числа мало — но и оно обязано затыкать «пусто».
    const declared = await summary(emptyReading({ listed: 2, tried: 2, sealedForOthersDeclared: 2 }), 0);
    expect(declared).not.toContain(translate('arbiter.presentations_empty'));
    // И обратная сторона: по-настоящему пустой ящик обязан остаться названным
    // пустым, иначе «подавить всегда» было бы дешёвым способом пройти замок.
    const really = await summary(emptyReading(), 0);
    expect(really, 'пустой ящик перестал называться пустым')
      .toContain(translate('arbiter.presentations_empty'));
  });

  it('R7b: опись перестраивалась (indexTrusted === false) — своя надпись, а НЕ «пусто»', async () => {
    // Тот же класс беды, что и в R7, но ТРЕТИЙ охранник, не первые два:
    // notOurs и sealedForOthersDeclared молчат ОДИНАКОВО что при честной
    // пустоте, что при потере индекса — восстановленная с диска запись не
    // несёт ни deal, ни sealedFor, значит оба числа остаются нулями в любом
    // случае. Отличить одно от другого может только indexTrusted; здесь
    // замеряется, что сигнал доехал до РАЗМЕТКИ, а не потерялся между моделью
    // и экраном.
    const rebuilt = await summary(emptyReading({ indexTrusted: false }), 0);
    expect(rebuilt, '«сторона молчала» сказано вместо «опись перестраивалась»')
      .not.toContain(translate('arbiter.presentations_empty'));
    expect(rebuilt, 'надпись про перестроенную опись не доехала до разметки')
      .toContain(translate('arbiter.presentations_index_rebuilt'));

    // Зеркало: индексу можно верить — обычная пустота, без лишней надписи.
    const trusted = await summary(emptyReading({ indexTrusted: true }), 0);
    expect(trusted).toContain(translate('arbiter.presentations_empty'));
    expect(trusted, 'лишняя надпись про перестройку при целом индексе')
      .not.toContain(translate('arbiter.presentations_index_rebuilt'));
  });

  it('R8: «уже забирали» — числом и без имени', async () => {
    const html = await summary(emptyReading({ listed: 2, tried: 2, notOurs: 2, notOursFetched: 1 }), 0);
    expect(html).toContain(translate('arbiter.presentations_not_ours_fetched', { count: 1 }));
    const none = await summary(emptyReading({ listed: 2, tried: 2, notOurs: 2, notOursFetched: 0 }), 0);
    expect(none, '«уже забирали 0» — это ложь про то, что кто-то приходил')
      .not.toContain(translate('arbiter.presentations_not_ours_fetched', { count: 0 }));
  });

  it('R9: «спор ведёт другой» и «спор не ведёт никто» — разные надписи, и ни одна не «пусто»', async () => {
    const other = await summary(emptyReading({ mine: false, arbiterNow: B, stop: 'not_mine' }), 0);
    expect(other).toContain(translate('arbiter.presentations_not_mine', { arbiter: shortAddr(B) }));
    expect(other, '«вам ничего не предъявили» поверх чужого ящика')
      .not.toContain(translate('arbiter.presentations_empty'));
    const closed = await summary(emptyReading({ mine: false, arbiterNow: null, stop: 'not_mine' }), 0);
    expect(closed).toContain(translate('arbiter.presentations_box_closed'));
    expect(closed, 'арбитр без адреса выдан прочерком за живого человека')
      .not.toContain(translate('arbiter.presentations_not_mine', { arbiter: '—' }));
  });

  it('R10: разобранная причина отказа доехала до глаз, а не схлопнулась в общую', async () => {
    const { BoxFailureView } = await import('@/components/ArbiterPresentations');
    const html = (refusal: string) =>
      renderToStaticMarkup(React.createElement(BoxFailureView, { refusal } as never));
    // «Спор у вас забрали» и «повторите через минуту» — несовместимые советы.
    expect(html('not_mine_now')).toContain(translate('arbiter.presentations_err_not_mine_now'));
    expect(html('not_mine_now'), 'разные беды схлопнуты в одну надпись')
      .not.toContain(translate('arbiter.presentations_box_unreadable'));
    expect(html('too_often')).toContain(translate('arbiter.presentations_err_too_often'));
    // А незнакомая беда обязана остаться незнакомой, а не притвориться одной из
    // названных: угаданная причина хуже честного «не знаем».
    expect(html('unknown')).toContain(translate('arbiter.presentations_box_unreadable'));
  });
});

describe('подтверждённый автор — с датой заверения (находка 51)', () => {
  it('R11: дата заверения доехала до глаз, а голого «автор подтверждён» на экране нет', async () => {
    // Заверение отозвать нечем. У человека украли устройство с сохранённым
    // сеансом, он восстановился по коду и заверил новую пару; прежнее
    // заверение осталось годным, и вор подписывает прежним ключом. Арбитр
    // получает `ok` и на словах человека, и на словах вора — развести их можно
    // ТОЛЬКО по дате, и она обязана быть на экране, а не в модели.
    const html = await bagHtml(bagOf());
    expect(html, 'дата заверения не доехала до разметки')
      .toContain(translate('arbiter.msg_author_attested', { date: '2025-08-05' }));
    // Голого бейджа «автор подтверждён» на экране нет и не должно быть: он и
    // есть та самая надпись, которую находка 51 запрещает.
    expect(html, 'подтверждение показано без даты')
      .not.toContain(translate('arbiter.msg_author_unconfirmed', { verdict: 'ok' }));

    // Датировать нечем — молчим, а не подставляем «—» и не пишем «подтверждён»
    // без даты: выдуманная дата хуже её отсутствия.
    const undated = await bagHtml(bagOf({
      messages: [{ ...bagOf().messages[0], attestedAt: null }],
    }));
    expect(undated, 'дата придумана там, где заверения нет')
      .not.toContain('заверил');
  });
});
