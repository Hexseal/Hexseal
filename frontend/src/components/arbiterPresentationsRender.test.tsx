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
import type { NoResponseRecord } from '@/lib/presentationAnchor';

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
  sealedForOthersDeclared: 0, notOurs: 0, notOursFetched: 0, notParsed: 0,
  // ⚠️ Индекс доверенный — умолчание для ВСЕХ сцен R1-R10: ни одна из них это
  // поле не переопределяет и не обязана, они про другие охранники. Сцена
  // «опись перестраивалась» (R7b) называет его явно.
  indexTrusted: true,
  // ⚠️ Умолчание — «цепь не читана» для ВСЕХ прежних сцен R1-R12: они про
  // другое, и отпечаток в них не участвует. Сцены сверки (R13-R16) называют
  // это поле явно.
  anchors: null,
  skipped: [], presentations: [], ...over,
});

const DIGEST = `0x${'ab'.repeat(32)}` as `0x${string}`;

const anchorsOf = (over: Partial<NonNullable<DisputeBoxReading['anchors']>> = {}) => ({
  digests: [], digestsComplete: true, records: [], noResponse: [],
  logsComplete: true, window: null, ...over,
});

const bagOf = (over: Partial<PresentedBag> = {}): PresentedBag => ({
  bagKey: 'k', uploadedBy: A, uploadedAt: 1,
  declared: { read: 3, hidden: 4, notPrepared: 1 },
  measured: { read: 2, unopened: 1, hidden: 4, notPrepared: 1 },
  countsDisagree: [], uploaderIsPresenter: true,
  digest: DIGEST,
  anchor: { verdict: 'unread', block: null, submitter: null, records: 0, total: 0 },
  view: { container: 'ok', messages: [], counts: { read: 2, unopened: 1, hidden: 4, notPrepared: 1 },
          notPrepared: [], perSender: [], presenter: A },
  messages: [{
    seq: 0, sender: A, read: true, text: 'сроки прошли', file: null,
    openFailure: null, attestation: 'ok', frameFailure: null,
    authorConfirmed: true, attestedAt: 1_754_400_000_000, legacyAttachmentExposed: false,
  }],
  ...over,
});

type DeviceKey = 'agree' | 'differs' | 'chain_missing' | 'chain_unread';

async function summary(reading: DisputeBoxReading, before: number | null, deviceKey: DeviceKey = 'agree'): Promise<string> {
  const { BoxSummaryView } = await import('@/components/ArbiterPresentations');
  return renderToStaticMarkup(React.createElement(BoxSummaryView, { reading, before, deviceKey }));
}
async function bagHtml(bag: PresentedBag, noResponse: NoResponseRecord | null = null): Promise<string> {
  const { PresentationBagView } = await import('@/components/ArbiterPresentations');
  return renderToStaticMarkup(React.createElement(PresentationBagView, { bag, noResponse }));
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
    expect(html).toContain(translate('arbiter.presentations_partial_budget', { read: 99, total: 122 }));
    expect(html, '«пусто» показано поверх непрочитанного ящика')
      .not.toContain(translate('arbiter.presentations_empty'));
  });

  it('R5b: причина недочитанного НЕ угадывается — три остановки, три разных надписи (ревью круг 1)', async () => {
    // Прежде здесь всегда печаталось «кончился бюджет чтения». На обрыве связи
    // это ложь про причину И неверный совет («вернитесь через минуту»), а на
    // `read_all` бюджет не тратился вовсе: мешки отсеяны до забора по толщине
    // или чужому ключу. Тот же экран отказывается угадывать причину отказа по
    // классу статуса — угадывать её тут было бы той же ошибкой рядом.
    const budget = await summary(emptyReading({ listed: 122, tried: 99, stop: 'read_budget' }), 0);
    const broke = await summary(emptyReading({ listed: 122, tried: 99, stop: 'transport' }), 0);
    const skipped = await summary(emptyReading({
      listed: 3, tried: 1, stop: 'read_all', notParsed: 2,
      skipped: [{ bagKey: 'a', why: 'too_big' }, { bagKey: 'b', why: 'foreign_key' }],
    }), 0);

    expect(budget).toContain(translate('arbiter.presentations_partial_budget', { read: 99, total: 122 }));
    expect(broke).toContain(translate('arbiter.presentations_partial_transport', { read: 99, total: 122 }));
    expect(skipped).toContain(translate('arbiter.presentations_partial_unread', { read: 1, total: 3 }));

    // И ни одна из трёх не притворяется другой: совет у них разный и
    // несовместимый, схлопывание — ровно тот промах, ради которого замок стоит.
    expect(broke, 'обрыв связи выдан за кончившийся бюджет')
      .not.toContain(translate('arbiter.presentations_partial_budget', { read: 99, total: 122 }));
    expect(skipped, 'мешки, отсеянные до забора, выданы за кончившийся бюджет')
      .not.toContain(translate('arbiter.presentations_partial_budget', { read: 1, total: 3 }));
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

  it('R7c: мешок не доехал до вердикта — назван числом, и «пусто» подавлено (ревью круг 1, Important 1)', async () => {
    // САМЫЙ ОСТРЫЙ СЛУЧАЙ — `not_presentation`: у стороны клиент другой версии,
    // её контейнер отсеивается ДО читалки, и мешок демонстративно лежал в
    // ящике. Без этого охранника арбитр читал бы «вам сюда пока ничего не
    // предъявили» — активное ложное утверждение, а не умолчание. `tried` его
    // не спасает: мешок ЗАБРАН, то есть `tried === listed`, и строка
    // «прочитано N из M» молчит.
    const alien = await summary(emptyReading({
      listed: 1, tried: 1, stop: 'read_all', notParsed: 1,
      skipped: [{ bagKey: 'k', why: 'not_presentation' }],
    }), 0);
    expect(alien, '«сторона молчала» сказано над ящиком, в котором мешок ЛЕЖАЛ')
      .not.toContain(translate('arbiter.presentations_empty'));
    expect(alien, 'число не доехавших до вердикта не показано никому')
      .toContain(translate('arbiter.presentations_not_parsed', { count: 1 }));

    // И то же самое, когда мешок пропал со склада между описью и забором.
    const gone = await summary(emptyReading({
      listed: 1, tried: 1, stop: 'read_all', notParsed: 1,
      skipped: [{ bagKey: 'k', why: 'gone' }],
    }), 0);
    expect(gone).not.toContain(translate('arbiter.presentations_empty'));

    // Обратная сторона: пустой ящик обязан остаться названным пустым, иначе
    // «подавить всегда» было бы дешёвым способом пройти замок.
    const really = await summary(emptyReading(), 0);
    expect(really, 'пустой ящик перестал называться пустым')
      .toContain(translate('arbiter.presentations_empty'));
    expect(really, 'ноль не доехавших до вердикта показан числом')
      .not.toContain(translate('arbiter.presentations_not_parsed', { count: 0 }));
  });

  it('R7d: «не открылось моим ключом» и «не доехало до вердикта» — РАЗНЫЕ числа, не сумма (ревью круг 1)', async () => {
    // `sealed_for_other` живёт в `skipped` тоже, и сложить его сюда значило бы
    // посчитать один и тот же мешок дважды: одной строкой как нечитаемый,
    // другой — как неразобранный. Модель вычитает его, и это видно на экране.
    const html = await summary(emptyReading({
      listed: 3, tried: 3, stop: 'read_all', notOurs: 2, notParsed: 1,
      skipped: [
        { bagKey: 'a', why: 'sealed_for_other' },
        { bagKey: 'b', why: 'sealed_for_other' },
        { bagKey: 'c', why: 'not_presentation' },
      ],
    }), 0);
    expect(html).toContain(translate('arbiter.presentations_not_ours', { count: 2 }));
    expect(html).toContain(translate('arbiter.presentations_not_parsed', { count: 1 }));
    expect(html, 'нечитаемые сложены с неразобранными — мешок посчитан дважды')
      .not.toContain(translate('arbiter.presentations_not_parsed', { count: 3 }));
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
    //
    // ⚠️ ИЩЕМ НЕ СЫРУЮ РУССКУЮ ПОДСТРОКУ, А НЕИЗМЕННУЮ ЧАСТЬ САМОГО ПЕРЕВОДА
    // (ревью круг 1, мелочь 2). Сырое слово в тесте держится за нынешнюю
    // редакцию ru.json: перепишут строку — замок промолчит, ничего не заметив,
    // и это ровно класс «тест сторожит текст, а не работу». Кусок до
    // подстановки берётся из локали, значит правка текста замок не обманет.
    const attestedPrefix = translate('arbiter.msg_author_attested', { date: 'ДАТА-СЮДА' }).split('ДАТА-СЮДА')[0];
    expect(attestedPrefix.length, 'у надписи не осталось неизменной части — замерять нечем')
      .toBeGreaterThan(10);
    const undated = await bagHtml(bagOf({
      messages: [{ ...bagOf().messages[0], attestedAt: null }],
    }));
    expect(undated, 'дата придумана там, где заверения нет').not.toContain(attestedPrefix);
  });
});

describe('четыре вердикта ключа устройства — четыре исхода (ревью круг 1)', () => {
  it('R12: «ключа в цепи нет» и «цепь не ответила» больше не молчат', async () => {
    // Оба — законные причины, по которым ящик выглядит пустым НЕ из-за
    // стороны, и оба молчали: разметка знала только `differs`. Пара
    // «модель/разметка» тут была единственной несделанной.
    const missing = await summary(emptyReading(), 0, 'chain_missing');
    expect(missing).toContain(translate('arbiter.presentations_device_key_chain_missing'));
    const unread = await summary(emptyReading(), 0, 'chain_unread');
    expect(unread).toContain(translate('arbiter.presentations_device_key_chain_unread'));
    const differs = await summary(emptyReading(), 0, 'differs');
    expect(differs).toContain(translate('arbiter.presentations_device_key_differs'));

    // Три разные новости — три разные надписи, ни одна не притворяется другой.
    expect(missing, 'два разных вердикта схлопнуты в одну надпись')
      .not.toContain(translate('arbiter.presentations_device_key_differs'));
    expect(unread).not.toContain(translate('arbiter.presentations_device_key_chain_missing'));

    // А согласие молчит намеренно: это отсутствие новости, а не новость.
    const agree = await summary(emptyReading(), 0, 'agree');
    for (const k of ['differs', 'chain_missing', 'chain_unread']) {
      expect(agree, `при согласии ключей показана тревога ${k}`)
        .not.toContain(translate(`arbiter.presentations_device_key_${k === 'differs' ? 'differs' : k}`));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Сверка отпечатка доехала ДО ГЛАЗ (Задача 7)
//
// ⚠️ Отпечаток, который никто не сверяет, — украшение; сверка, которая не
// доехала до разметки, — то же самое украшение этажом выше. Именно этот класс
// промаха замок и сторожит (находка К-2: разводка причин доехала до панели и
// не доехала до списка).
// ═══════════════════════════════════════════════════════════════════════════

describe('три состояния отпечатка на экране арбитра', () => {
  it('R13: «сходится» — с НОМЕРОМ БЛОКА, а не одним словом', async () => {
    const html = await bagHtml(bagOf({
      anchor: { verdict: 'match', block: BigInt(44_700_000), submitter: A, records: 1, total: 1 },
    }));
    expect(html).toContain(translate('arbiter.presentation_anchor_match', { block: '44700000' }));
    expect(html).not.toContain(translate('arbiter.presentation_anchor_absent'));
    expect(html).not.toContain(translate('arbiter.presentation_anchor_mismatch', { count: 1 }));
  });

  it('R14: «не сходится» — сказано, и сказано числом отпечатков, с которыми сверяли', async () => {
    const html = await bagHtml(bagOf({
      anchor: { verdict: 'mismatch', block: null, submitter: null, records: 0, total: 2 },
    }));
    expect(html).toContain(translate('arbiter.presentation_anchor_mismatch', { count: 2 }));
    expect(html).not.toContain(translate('arbiter.presentation_anchor_absent'));
  });

  it('R15: «в цепи не отмечено» и «цепь не ответила» — РАЗНЫЕ надписи, и ни одна не обвиняет', async () => {
    const absent = await bagHtml(bagOf({
      anchor: { verdict: 'absent', block: null, submitter: null, records: 0, total: 0 },
    }));
    const unread = await bagHtml(bagOf({
      anchor: { verdict: 'unread', block: null, submitter: null, records: 0, total: 0 },
    }));
    expect(absent).toContain(translate('arbiter.presentation_anchor_absent'));
    expect(unread).toContain(translate('arbiter.presentation_anchor_unread'));
    expect(absent).not.toContain(translate('arbiter.presentation_anchor_unread'));
    expect(unread).not.toContain(translate('arbiter.presentation_anchor_absent'));
    // Ни то, ни другое не смеет звучать как «не сходится».
    expect(absent + unread).not.toContain(translate('arbiter.presentation_anchor_mismatch', { count: 0 }));
  });

  it('R16: отметка есть, а блока в ленте нет — своя надпись, а не молчание и не «не отмечено»', async () => {
    const html = await bagHtml(bagOf({
      anchor: { verdict: 'match', block: null, submitter: null, records: 1, total: 1 },
    }));
    expect(html).toContain(translate('arbiter.presentation_anchor_match_no_block'));
    expect(html).not.toContain(translate('arbiter.presentation_anchor_absent'));
  });

  it('R17: дубли схлопнуты в строку, но число записей на экране ЕСТЬ', async () => {
    const html = await bagHtml(bagOf({
      anchor: { verdict: 'match', block: BigInt(44_700_000), submitter: A, records: 3, total: 3 },
    }));
    expect(html).toContain(translate('arbiter.presentation_anchor_dupes', { count: 3 }));
  });

  it('R18: ПОРЯДОК доехал до глаз — оба номера блока в одной строке', async () => {
    const record: NoResponseRecord = {
      arbiter: B, at: BigInt(1_760_000_000), block: BigInt(44_700_050), txHash: null,
    };
    const before = await bagHtml(bagOf({
      anchor: { verdict: 'match', block: BigInt(44_700_000), submitter: A, records: 1, total: 1 },
    }), record);
    expect(before).toContain(translate('arbiter.presentation_anchor_order_digest_first',
      { digest: '44700000', record: '44700050' }));

    const after = await bagHtml(bagOf({
      anchor: { verdict: 'match', block: BigInt(44_700_090), submitter: A, records: 1, total: 1 },
    }), record);
    expect(after).toContain(translate('arbiter.presentation_anchor_order_record_first',
      { digest: '44700090', record: '44700050' }));

    // Записи о молчании нет — порядка на экране нет вовсе, а не «одновременно».
    const alone = await bagHtml(bagOf({
      anchor: { verdict: 'match', block: BigInt(44_700_000), submitter: A, records: 1, total: 1 },
    }), null);
    expect(alone).not.toContain(translate('arbiter.presentation_anchor_order_digest_first',
      { digest: '44700000', record: '44700050' }));
  });

  it('R19: запись арбитра о молчании названа в сводке НОМЕРОМ БЛОКА', async () => {
    const html = await summary(emptyReading({
      anchors: anchorsOf({
        noResponse: [{ arbiter: B, at: BigInt(1_760_000_000), block: BigInt(44_699_000), txHash: null }],
      }),
    }), 0);
    expect(html).toContain(translate('arbiter.presentations_no_response_record',
      { block: '44699000', count: 1 }));
  });
});
