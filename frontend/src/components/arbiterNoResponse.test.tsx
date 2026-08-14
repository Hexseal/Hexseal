/**
 * arbiterNoResponse.test.tsx — кнопка арбитра «просил переписку, ответа не было»
 * (4в-2, Выкатка 2, Задача 8).
 *
 * ⚠️ ТРИ РОДА ПРОВЕРОК, И НАЗЫВАЮ ИХ ВСЛУХ, потому что доверие к ним разное:
 *   — РЕШЕНИЕ (`noResponseState`, `releaseAdvice`) запирается ВЫЗОВОМ: это
 *     единственный хозяин порядка состояний, и порядок здесь — предмет задачи,
 *     а не украшение;
 *   — РАЗМЕТКА запирается СТРУКТУРНО (`renderToStaticMarkup` + настоящий
 *     `messages/ru.json`): у фронта нет ни jsdom, ни `@testing-library`
 *     (`environment: 'node'`), поэтому НАЖАТИЕ здесь не проверяется ничем и
 *     «кнопка дошла до глаз» не замеряется. Проверяется, что решённое доехало
 *     до разметки и что запрещённое в ней не появилось. Бриф Задачи 8 показывал
 *     эти проверки в виде `render()/getByRole()` — так их здесь написать
 *     нечем, и подменять род доверия молча нельзя;
 *   — ШОВ С ЦЕПЬЮ (крючок `useNoResponseRecord`) запирается подставным ответом
 *     цепи: у кого спрошено, что спрошено и то ли число доехало до решения.
 *
 * ⚠️ ЧИСЛА ЦЕПИ ЗДЕСЬ НАРОЧНО НЕ 86400. Подставь настоящий пол — и проверка
 * прошла бы одинаково и на честном чтении цепи, и на зашитом во фронт числе:
 * ровно та «пустая мутация», где красное ничего не значит. Поэтому цепь всюду
 * отвечает 4242 и 60 — значениями, совпасть с которыми можно только одним
 * способом: действительно взяв ответ цепи.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ───────────────────────── настоящие переводы ──────────────────────────── */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = path.resolve(HERE, '../../messages');
const RU = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as Record<string, unknown>;

/** ⚠️ Переводы НАСТОЯЩИЕ. Подставной словарь сделал бы замок тавтологией: он
 *  сверял бы разметку с тем, что сам же придумал, и промолчал бы ровно в том
 *  случае, ради которого стоит, — ключ объявлен в коде и не заведён в локали. */
function translate(key: string, params?: Record<string, string | number>): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), RU);
  if (typeof value !== 'string') throw new Error(`нет ключа перевода: ${key}`);
  return params ? value.replace(/\{(\w+)\}/g, (_m, n: string) => String(params[n] ?? `{${n}}`)) : value;
}
vi.mock('next-intl', () => ({ useTranslations: () => translate }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));

/* ────────────────────────── подставная цепь ────────────────────────────── */

const AGREEMENT = '0xdead000000000000000000000000000000000001' as `0x${string}`;
const ME = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const OTHER = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`;

/** Что цепь отвечает на каждый геттер. `undefined` — «ещё не ответила». */
let chain: Record<string, unknown> = {};
/** Все обращения крючка к цепи — с адресом, именем функции и аргументами. */
const calls: Array<Record<string, unknown>> = [];

vi.mock('wagmi', () => ({
  useReadContract: (args: Record<string, unknown>) => {
    calls.push(args);
    const enabled = (args.query as { enabled?: boolean } | undefined)?.enabled;
    if (enabled === false) return { data: undefined, isLoading: false, refetch: () => {} };
    const name = String(args.functionName);
    return { data: chain[name], isLoading: chain[name] === undefined, refetch: () => {} };
  },
}));

const {
  noResponseState, releaseAdvice, noResponseWait, noResponseAtLabel,
} = await import('@/lib/arbiterNoResponse');
type Facts = Parameters<typeof noResponseState>[0];

const NOW = 1_770_000_000;

/** Сцена по умолчанию: спор мой, взят сутки назад по меркам подставного пола. */
const facts = (over: Partial<Facts> = {}): Facts => ({
  nowSec: NOW, me: ME, claimer: ME,
  claimedAt: NOW - 5000, recordedAt: 0, floorSeconds: 4242,
  release: 'open', ...over,
});

beforeEach(() => { calls.length = 0; chain = {}; });

/* ═══════════════════════ 1. РЕШЕНИЕ — ВЫЗОВОМ ═══════════════════════════ */

describe('порядок состояний повторяет порядок проверок в контракте', () => {
  it('N1: цепь не ответила — ни кнопки, ни обещаний (любое из четырёх чисел)', () => {
    // ⚠️ Четыре ответа, и каждый обязан гасить кнопку сам по себе. Ноль вместо
    // «не знаем» здесь обещал бы кнопку раньше, чем она заработает: цепь
    // ответила бы NoResponseTooEarly, а виноватым оказался бы интерфейс.
    expect(noResponseState(facts({ claimer: null })).kind).toBe('chain_unread');
    expect(noResponseState(facts({ claimedAt: null })).kind).toBe('chain_unread');
    expect(noResponseState(facts({ recordedAt: null })).kind).toBe('chain_unread');
    expect(noResponseState(facts({ floorSeconds: null })).kind).toBe('chain_unread');
  });

  it('N2: часы браузера сломаны — тоже «не знаем», а не готовность', () => {
    // NaN < чего угодно === false, то есть наивное сравнение выдало бы
    // «можно записывать» при сломанных часах.
    expect(noResponseState(facts({ nowSec: Number.NaN })).kind).toBe('chain_unread');
    expect(noResponseState(facts({ nowSec: Number.POSITIVE_INFINITY })).kind).toBe('chain_unread');
  });

  it('N3: спор ведёт другой или никто — кнопки нет, и это РАЗНЫЕ новости', () => {
    // Контракт проверяет это первым (NotClaimingArbiter). Геттеры отвечают про
    // ТЕКУЩЕГО клеймера: не сверив его со мной, экран показал бы чужое время
    // взятия как своё и предложил бы кнопку, гарантированно отвергнутую.
    expect(noResponseState(facts({ claimer: OTHER }))).toEqual({ kind: 'not_mine', arbiter: OTHER });
    expect(noResponseState(facts({ claimer: ZERO })).kind).toBe('not_claimed');
    expect(noResponseState(facts({ me: null })).kind).toBe('not_mine');
  });

  it('N4: адрес сверяется без оглядки на регистр', () => {
    // Цепь отдаёт checksum-вид, кошелёк — как придётся. Сравнение «как есть»
    // молча превратило бы мой спор в чужой.
    expect(noResponseState(facts({ claimer: ME.toUpperCase().replace('0X', '0x') })).kind).toBe('ready');
  });

  it('N5: УЖЕ ЗАПИСАНО ПРОВЕРЯЕТСЯ РАНЬШЕ ПОЛА — иначе экран обещает то, чего не будет', () => {
    // ⚠️ ГЛАВНАЯ ПРОВЕРКА ЗАДАЧИ (поправка координатора). Якорь пола
    // переставляется при КАЖДОМ взятии спора, а запись о молчании — нет.
    // Значит арбитр, уже сделавший запись и перевзявший спор, упирается в пол
    // раньше, чем в однократность. Скажи интерфейс «можно будет через сутки» —
    // он соврёт: через сутки цепь ответит NoResponseAlreadyRecorded. Ровно эту
    // ложь исполнитель Задачи 2 убрал из контракта.
    const reclaimed = facts({ claimedAt: NOW - 10, recordedAt: NOW - 100_000 });
    expect(noResponseState(reclaimed)).toEqual({ kind: 'recorded', at: NOW - 100_000 });

    // И то же самое на обычной сцене, где пол давно вышел.
    expect(noResponseState(facts({ recordedAt: NOW - 5 })).kind).toBe('recorded');
  });

  it('N6: время взятия ноль — кнопки нет, и с советом про отпускание', () => {
    // Спор взят ДО разреза: цепь не знает, когда это было, и считать пол не от
    // чего. Кода переноса нет вовсе — решение владельца 14.08.2026.
    expect(noResponseState(facts({ claimedAt: 0, release: 'open' })))
      .toEqual({ kind: 'claim_unknown', release: 'open' });
    expect(noResponseState(facts({ claimedAt: 0, release: 'window_passed' })))
      .toEqual({ kind: 'claim_unknown', release: 'window_passed' });
  });

  it('N7: до пола — «рано» с остатком, после пола — готово', () => {
    expect(noResponseState(facts({ claimedAt: NOW - 242 })))
      .toEqual({ kind: 'too_early', leftSeconds: 4000 });
    expect(noResponseState(facts({ claimedAt: NOW - 4242 })).kind).toBe('ready');
    // Ровно на границе контракт уже принимает: block.timestamp < claimedAt +
    // NO_RESPONSE_FLOOR — строгое «меньше».
    expect(noResponseState(facts({ claimedAt: NOW - 4241 })).kind).toBe('too_early');
  });

  it('N26: сорвавшийся ПОРОГ не гасит того, что уже известно (ревью, круг 1)', () => {
    // ⚠️ Порог нужен ровно двум веткам — «рано» и «можно». Требуй его наверху —
    // и один неудавшийся `getNoResponseFloor` спрятал бы в «цепь не ответила»
    // и «уже записано», и «спор ведёт другой»: факты, которые в этот момент
    // ЗНАЕМ и которые от порога не зависят вовсе.
    expect(noResponseState(facts({ floorSeconds: null, recordedAt: NOW - 5 })).kind).toBe('recorded');
    expect(noResponseState(facts({ floorSeconds: null, claimer: OTHER })).kind).toBe('not_mine');
    expect(noResponseState(facts({ floorSeconds: null, claimer: ZERO })).kind).toBe('not_claimed');
    expect(noResponseState(facts({ floorSeconds: null, claimedAt: 0 })).kind).toBe('claim_unknown');
    // А вот про «рано / можно» без порога сказать нечем — и это честное «не
    // знаем», а не готовность.
    expect(noResponseState(facts({ floorSeconds: null })).kind).toBe('chain_unread');
  });

  it('N8: ПОЛ БЕРЁТСЯ ИЗ ВХОДА, а не из своего числа — та же сцена, два пола', () => {
    // ⚠️ Это поведенческий замок на хозяина числа, а не текстовый: если пол
    // где-то зашит, эта сцена перестанет двигаться вслед за цепью. Оба числа
    // выдуманные — совпасть с ними можно только взяв их у цепи.
    const scene = { claimedAt: NOW - 300 };
    expect(noResponseState(facts({ ...scene, floorSeconds: 60 })).kind).toBe('ready');
    expect(noResponseState(facts({ ...scene, floorSeconds: 4242 })))
      .toEqual({ kind: 'too_early', leftSeconds: 3942 });
  });
});

describe('совет про отпускание говорит правду про сегодня', () => {
  it('N9: окно спора открыто — совет годится; закрыто — выхода нет и обещать его нельзя', () => {
    // releaseDisputeClaim ревертит DisputeWindowPassed при
    // block.timestamp > disputedAt + DISPUTE_WINDOW (ArbiterRegistryFacet.sol,
    // ~691-734) — сравнение здесь ровно то же, включая строгое «больше».
    const base = { nowSec: NOW, disputedAt: NOW - 1000, disputeWindow: 1000, verdictPending: false };
    expect(releaseAdvice(base)).toBe('open');                                   // ровно на границе
    expect(releaseAdvice({ ...base, disputedAt: NOW - 1001 })).toBe('window_passed');
  });

  it('N10: вердикт уже подан — отпустить нельзя, и это отдельная новость', () => {
    // require(pendingVerdicts[agreement].submittedAt == 0) — тот же отказ, что
    // и закрытое окно, но по другой причине и с другим советом.
    expect(releaseAdvice({
      nowSec: NOW, disputedAt: NOW - 10, disputeWindow: 1000, verdictPending: true,
    })).toBe('verdict_pending');
  });

  it('N11: не прочитали — «не знаем», а не «открыто»', () => {
    const base = { nowSec: NOW, disputedAt: NOW - 10, disputeWindow: 1000, verdictPending: false };
    expect(releaseAdvice({ ...base, disputedAt: null })).toBe('unknown');
    expect(releaseAdvice({ ...base, disputeWindow: null })).toBe('unknown');
    expect(releaseAdvice({ ...base, verdictPending: null })).toBe('unknown');
    // Нулевые ответы — это не «окно длиной ноль», а «спора не было / не читано».
    expect(releaseAdvice({ ...base, disputedAt: 0 })).toBe('unknown');
    expect(releaseAdvice({ ...base, disputeWindow: 0 })).toBe('unknown');
  });
});

describe('надписи про время', () => {
  it('N12: остаток называется числом, и единица выбрана по величине', () => {
    expect(noResponseWait(2 * 86_400 + 3 * 3600)).toEqual({ key: 'arbiter.no_response_wait_dh', params: { d: 2, h: 3 } });
    expect(noResponseWait(82_800)).toEqual({ key: 'arbiter.no_response_wait_hm', params: { h: 23, m: 0 } });
    expect(noResponseWait(300)).toEqual({ key: 'arbiter.no_response_wait_m', params: { m: 5 } });
    // Меньше минуты — это «через минуту», а не «через 0 минут»: ноль читается
    // как «уже можно», и человек нажмёт на отказ.
    expect(noResponseWait(5)).toEqual({ key: 'arbiter.no_response_wait_m', params: { m: 1 } });
  });

  it('N13: время записи — датой и часами по UTC, а выдумывать его нечем', () => {
    // Часовой пояс не наш: запись работает уликой, и расхождение поясов между
    // арбитром и стороной здесь стоило бы разбора.
    expect(noResponseAtLabel(1_770_000_000)).toBe('2026-02-02 02:40 UTC');
    expect(noResponseAtLabel(0)).toBeNull();
    expect(noResponseAtLabel(Number.NaN)).toBeNull();
  });
});

/* ═══════════════════ 2. РАЗМЕТКА — СТРУКТУРНО ══════════════════════════ */

async function html(over: Partial<Facts> = {}, busy = false): Promise<string> {
  const { ArbiterNoResponse } = await import('@/components/ArbiterPresentations');
  return renderToStaticMarkup(React.createElement(ArbiterNoResponse, {
    facts: facts(over), busy, onRecord: () => {},
  }));
}

const BTN = () => translate('arbiter.no_response_btn');

describe('четыре состояния кнопки доехали до разметки, и ни одно не молчит', () => {
  it('N14: до пола — кнопка есть, она НЕАКТИВНА, и сказано, сколько ждать', async () => {
    const markup = await html({ claimedAt: NOW - 42, floorSeconds: 4242 });
    expect(markup).toContain(BTN());
    // ⚠️ ИЩЕТСЯ АТРИБУТ, А НЕ СЛОВО. Слово `disabled` есть в классах кнопки
    // ВСЕГДА (`disabled:opacity-50` из `ui/button`), и проверка на подстроку
    // была бы зелёной при любой мутации — та самая пустая проверка.
    expect(markup, 'кнопка активна раньше пола — цепь ответит отказом').toContain('disabled=""');
    // ⚠️ Число берётся из ПОЛА ЦЕПИ (4242 − 42 = 4200 с = 1 ч 10 мин). Зашей
    // кто-нибудь сутки — здесь стояло бы другое число, и замок покраснеет.
    expect(markup).toContain(translate('arbiter.no_response_wait_hm', { h: 1, m: 10 }));
  });

  it('N15: после пола — кнопка активна, и рядом сказано, чего запись НЕ делает', async () => {
    const markup = await html({ claimedAt: NOW - 4242, floorSeconds: 4242 });
    expect(markup).toContain(BTN());
    expect(markup, 'кнопка осталась неактивной после пола').not.toContain('disabled=""');
    // Запись не влечёт ничего (замысел 2.6). Не сказать этого — значит дать
    // арбитру поверить, что он кого-то наказывает.
    expect(markup).toContain(translate('arbiter.no_response_hint'));
  });

  it('N16: уже записано — КНОПКИ НЕТ, показан факт и время', async () => {
    const markup = await html({ recordedAt: 1_770_000_000 });
    expect(markup, 'кнопка предлагает записать второй раз').not.toContain(BTN());
    expect(markup).toContain(translate('arbiter.no_response_recorded',
      { at: '2026-02-02 02:40 UTC' }));
  });

  it('N17: время взятия ноль — кнопки нет, сказано почему, и совет ЧЕСТНЫЙ', async () => {
    const open = await html({ claimedAt: 0, release: 'open' });
    expect(open).not.toContain(BTN());
    expect(open).toContain(translate('arbiter.no_response_claim_unknown'));
    expect(open).toContain(translate('arbiter.no_response_release_open'));

    // ⚠️ ВТОРАЯ ПОПРАВКА КООРДИНАТОРА. Совет «отпустите и возьмите заново»
    // неисполним после закрытия окна спора: releaseDisputeClaim ревертит
    // DisputeWindowPassed. Обещать выход, которого нет, — та же ложь, что и
    // «можно будет через сутки» перед однократностью.
    const closed = await html({ claimedAt: 0, release: 'window_passed' });
    expect(closed).toContain(translate('arbiter.no_response_release_closed'));
    expect(closed, 'обещан выход, которого нет')
      .not.toContain(translate('arbiter.no_response_release_open'));

    const verdict = await html({ claimedAt: 0, release: 'verdict_pending' });
    expect(verdict).toContain(translate('arbiter.no_response_release_verdict'));
    expect(verdict).not.toContain(translate('arbiter.no_response_release_open'));

    const unknown = await html({ claimedAt: 0, release: 'unknown' });
    expect(unknown).toContain(translate('arbiter.no_response_release_unknown'));
    expect(unknown, '«не знаем» выдано за «закрыто»')
      .not.toContain(translate('arbiter.no_response_release_closed'));
  });

  it('N18: чужой спор, ничей спор и молчащая цепь — три РАЗНЫЕ надписи, и ни одной кнопки', async () => {
    const other = await html({ claimer: OTHER });
    const nobody = await html({ claimer: ZERO });
    const unread = await html({ claimer: null });

    const { shortAddr } = await import('@/lib/utils');
    expect(other).toContain(translate('arbiter.no_response_not_mine', { arbiter: shortAddr(OTHER) }));
    expect(nobody).toContain(translate('arbiter.no_response_not_claimed'));
    expect(unread).toContain(translate('arbiter.no_response_chain_unread'));

    // Ни одна не притворяется другой: советы у них несовместимые.
    expect(other).not.toContain(translate('arbiter.no_response_not_claimed'));
    expect(nobody).not.toContain(translate('arbiter.no_response_chain_unread'));
    for (const markup of [other, nobody, unread]) expect(markup).not.toContain(BTN());
  });

  it('N19: ни одно состояние без кнопки не молчит вовсе', async () => {
    // Молчащий экран — это «сломалось и никто не узнал»: арбитр решит, что
    // записал, и не вернётся.
    for (const over of [
      { claimer: null }, { claimer: ZERO }, { claimer: OTHER },
      { recordedAt: NOW - 5 }, { claimedAt: 0, release: 'unknown' as const },
    ]) {
      const markup = await html(over);
      expect(markup.replace(/<[^>]*>/g, '').trim().length,
        `состояние ${JSON.stringify(over)} не сказало ничего`).toBeGreaterThan(20);
    }
  });

  it('N20: пока запись едет в цепь — кнопка заперта, чтобы не уехала дважды', async () => {
    const markup = await html({ claimedAt: NOW - 4242 }, true);
    expect(markup).toContain('disabled=""');
  });
});

/* ═════════════════ 3. ШОВ С ЦЕПЬЮ — ПОДСТАВНЫМ ОТВЕТОМ ═════════════════ */

describe('крючок спрашивает цепь, а не сам себя', () => {
  async function probeFacts(): Promise<Facts> {
    const { useNoResponseRecord } = await import('@/hooks/useNoResponseRecord');
    function Probe() {
      const { facts: seen } = useNoResponseRecord(AGREEMENT, ME, true);
      // ⚠️ Факты уезжают ЧЕРЕЗ РАЗМЕТКУ, а не присваиванием в переменную
      // снаружи: присваивание во время рендера — побочный эффект, и правило
      // React его запрещает (ESLint валит на этом же файле).
      return React.createElement('i', { 'data-facts': JSON.stringify(seen) });
    }
    const markup = renderToStaticMarkup(React.createElement(Probe));
    const found = /data-facts="([^"]*)"/.exec(markup);
    if (!found) throw new Error('крючок не вернул фактов');
    return JSON.parse(found[1].replace(/&quot;/g, '"')) as Facts;
  }

  it('N21: спрошен диамонд и именно те три геттера — с адресом сделки', async () => {
    chain = { getDisputeClaimer: ME, getDisputeClaimedAt: 100n, getNoResponseAt: 0n, getNoResponseFloor: 4242n };
    await probeFacts();
    const { CONTRACTS } = await import('@/config/contracts');
    for (const name of ['getDisputeClaimer', 'getDisputeClaimedAt', 'getNoResponseAt']) {
      const call = calls.find(c => c.functionName === name);
      expect(call, `${name} у цепи не спрошен вовсе`).toBeTruthy();
      expect(call!.address).toBe(CONTRACTS.diamond);
      expect(call!.args).toEqual([AGREEMENT]);
    }
    // Пол — у цепи же, отдельным геттером, без аргументов.
    expect(calls.find(c => c.functionName === 'getNoResponseFloor')).toBeTruthy();
  });

  it('N22: числа цепи доезжают до фактов ровно теми, что назвала цепь', async () => {
    chain = {
      getDisputeClaimer: ME, getDisputeClaimedAt: 4_242_000n,
      getNoResponseAt: 777n, getNoResponseFloor: 60n,
    };
    const f = await probeFacts();
    expect(f.claimer).toBe(ME);
    expect(f.claimedAt).toBe(4_242_000);
    expect(f.recordedAt).toBe(777);
    expect(f.floorSeconds).toBe(60);
  });

  it('N23: цепь молчит — null, а не ноль', async () => {
    chain = {};
    const f = await probeFacts();
    expect(f.claimer).toBeNull();
    expect(f.claimedAt).toBeNull();
    expect(f.recordedAt).toBeNull();
    expect(f.floorSeconds).toBeNull();
    expect(noResponseState(f).kind).toBe('chain_unread');
  });

  it('N24: про окно спора цепь спрашивается ТОЛЬКО у спора без времени взятия', async () => {
    // Три лишних чтения на каждую карточку ради совета, который нужен ровно
    // одному спору на свете (решение владельца: таких споров ровно один).
    chain = { getDisputeClaimer: ME, getDisputeClaimedAt: 100n, getNoResponseAt: 0n, getNoResponseFloor: 4242n };
    await probeFacts();
    const asked = calls.filter(c => (c.query as { enabled?: boolean } | undefined)?.enabled !== false)
      .map(c => c.functionName);
    expect(asked).not.toContain('disputedAt');
    expect(asked).not.toContain('DISPUTE_WINDOW');
    expect(asked).not.toContain('getPendingVerdict');

    calls.length = 0;
    chain = { getDisputeClaimer: ME, getDisputeClaimedAt: 0n, getNoResponseAt: 0n, getNoResponseFloor: 4242n };
    await probeFacts();
    const askedLegacy = calls.filter(c => (c.query as { enabled?: boolean } | undefined)?.enabled !== false)
      .map(c => c.functionName);
    for (const name of ['disputedAt', 'DISPUTE_WINDOW', 'getPendingVerdict']) {
      expect(askedLegacy, `${name} не спрошен там, где совет без него — догадка`).toContain(name);
    }
  });
});

/* ═══════ 4. ЖИВОЙ СПОР ПРОТИВ ВСЕЙ ИСТОРИИ АРБИТРА (ревью, круг 1) ══════ */

describe('кнопка ставится на открытый спор, а не на всю историю', () => {
  const OPEN = '0xaaaa000000000000000000000000000000000001' as `0x${string}`;
  const CLOSED = '0xbbbb000000000000000000000000000000000002' as `0x${string}`;

  async function tab(): Promise<string> {
    const { ArbiterPresentationsTab } = await import('@/components/ArbiterPresentations');
    return renderToStaticMarkup(React.createElement(ArbiterPresentationsTab, {
      cases: [
        { agreement: OPEN, client: OTHER, executor: ME, disputeOpen: true },
        { agreement: CLOSED, client: OTHER, executor: ME, disputeOpen: false },
      ],
      me: ME,
      chainKeys: null,
      publicClient: undefined,
      signChatKey: () => null,
      getBoxPass: async () => '',
      recordNoResponse: async () => {},
    }));
  }

  it('N27: у разобранного дела кнопки НЕТ и чтений цепи на него НЕ ТРАТИТСЯ', async () => {
    // ⚠️ Карточки ставятся на `getArbiterDeals()` — все дела, что арбитр когда-
    // либо брал. Без гейта арбитр с сотней разобранных дел платил бы тремя
    // чтениями цепи за каждое и читал бы на каждом «спор ведёт другой» про
    // спор, кончившийся месяц назад.
    chain = { getDisputeClaimer: ME, getDisputeClaimedAt: 1n, getNoResponseAt: 0n, getNoResponseFloor: 1n };
    const markup = await tab();

    const seen = markup.split(translate('arbiter.no_response_btn')).length - 1;
    expect(seen, 'кнопка нарисована не только у живого спора').toBe(1);

    const spent = calls.filter(c => Array.isArray(c.args) && (c.args as unknown[])[0] === CLOSED
      && (c.query as { enabled?: boolean } | undefined)?.enabled !== false);
    expect(spent.map(c => c.functionName),
      'на разобранное дело потрачены чтения цепи').toEqual([]);

    // И обратная сторона: у живого спора чтения ИДУТ, иначе «гейт» был бы
    // просто выключенной кнопкой.
    const live = calls.filter(c => Array.isArray(c.args) && (c.args as unknown[])[0] === OPEN
      && (c.query as { enabled?: boolean } | undefined)?.enabled !== false);
    expect(live.map(c => c.functionName)).toContain('getDisputeClaimer');
  });
});

/* ═════════════════════ 5. ХОЗЯИН ЧИСЛА — ТЕКСТОМ ══════════════════════ */

describe('на экране сказано, ЧЬЯ это запись (ревью, круг 1)', () => {
  it('N28: «ваша» у кнопочной строки и «не обязательно ваша» у строки сводки', () => {
    // ⚠️ Замок ТЕКСТОВЫЙ, и так и написано. Сцена, ради которой он стоит:
    // прежний арбитр записал молчание и отпустил спор, спор взял я. Сводка
    // ящика читает ЛЕНТУ (запись по сделке, любого арбитра) и говорит «в цепи
    // есть запись, блок N»; кнопочный блок читает ГЕТТЕР (запись ТЕКУЩЕГО
    // клеймера) и честно показывает активную кнопку. Оба верны, а человек
    // читает противоречие — пока не сказано, чья запись.
    const arb = (locale: string) => {
      const bundle = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), 'utf8')) as
        { arbiter: Record<string, string> };
      return bundle.arbiter;
    };
    for (const locale of ['ru', 'en']) {
      const a = arb(locale);
      const mine = locale === 'ru' ? /ваша|ваш /i : /your/i;
      const notMine = locale === 'ru' ? /не обязательно ваша/i : /not necessarily yours/i;
      expect(a.no_response_recorded, `${locale}: не сказано, что запись ваша`).toMatch(mine);
      expect(a.presentations_no_response_record,
        `${locale}: запись из ленты выдана за вашу`).toMatch(notMine);
    }
  });
});

describe('своей копии пола во фронте нет', () => {
  it('N25: ни в компоненте, ни в крючке, ни в решении числа пола не написано', () => {
    // ⚠️ Эта проверка сторожит ТЕКСТ, и так и написано. Она стоит не вместо
    // N8/N14 (те ловят подмену значения ПОВЕДЕНИЕМ), а рядом: они ловят
    // подстановку числа, а эта — приписку «а если цепь молчит, возьмём сутки»,
    // которая на всех сценах выше невидима, потому что цепь там отвечает.
    const sources = [
      path.resolve(HERE, './ArbiterPresentations.tsx'),
      path.resolve(HERE, '../hooks/useNoResponseRecord.ts'),
      path.resolve(HERE, '../lib/arbiterNoResponse.ts'),
    ];
    for (const file of sources) {
      const code = fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(code, `${path.basename(file)}: своя копия пола`).not.toMatch(/\b86[_ ]?400\b/);
      expect(code, `${path.basename(file)}: своя копия пола`).not.toMatch(/\b24\s*\*\s*60\s*\*\s*60\b/);
      expect(code, `${path.basename(file)}: своя копия пола`).not.toMatch(/24\s*hours/i);
    }
  });
});
