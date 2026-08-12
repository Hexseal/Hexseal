/**
 * presentToArbiter.test.ts — кнопка стороны: что решает, что отправляет, что
 * говорит человеку (Задача 6).
 *
 * ⚠️ КЛИКА ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ. У фронта нет ни jsdom, ни
 * @testing-library (`vitest.config.mjs`, environment: 'node'). Поэтому всё,
 * что решает, вынесено отдельными функциями и зовётся напрямую. Разметку
 * проверяет `components/presentToArbiter.test.tsx`, и там про неё сказано
 * «структурно», а не «человек увидел».
 *
 * ⚠️ СБОРКА ЗДЕСЬ НАСТОЯЩАЯ. Актёры, кадры, архив и заверения — общая оснастка
 * `__stand__/presentationFixtures.ts` (та же, что у стендового замера). Ни
 * одного подставного контейнера: подделка контейнера прятала бы ровно тот
 * стык, ради которого задача существует.
 *
 * ⚠️ СКЛАД ПОДДЕЛАН ТОЛЬКО ЗДЕСЬ, И ЭТО ЗНАЧИТ, ЧТО ОН ПРОВЕРЯЕТ РАЗВОДКУ, А НЕ
 * КОДЫ. Живой маршрут ящика проверяет `__stand__/disputeBoxWire.test.ts` на
 * настоящем релеере; здесь подделка нужна, чтобы получить 500, 429 и 401 по
 * требованию — настоящий склад их по заказу не отдаёт. Что имена кодов совпали
 * с серверными, сторожит стенд (S7): там отказ приходит с живого сервера.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChatSession } from '@/lib/chatSession';
import type { ChatKeyAttestation } from '@/lib/chatKeyAttestation';
import type { FitVerdict } from '@/lib/presentationBag';
import { toBoxKey } from '@/lib/arbiterChatKey';
import type { DisputeArbiterKey, PresentedTo } from '@/lib/disputeArbiter';
import type { Hex } from 'viem';
import {
  AGREEMENT_STATUS_DISPUTED,
  PRESENT_REFUSAL_KEYS,
  boxStateFromList,
  canSend,
  draftKeepNotice,
  fitNotice,
  keepFirstSent,
  keepKnownBox,
  restoreMountImpl,
  sameBoxState,
  shouldPollBox,
  tickBoxImpl,
  lastDraftOfDeal,
  lastSentBag,
  otherAttestationsOf,
  pickingPrep,
  presentButtonVisible,
  presentWarning,
  presentedFromKey,
  refusalOfBoxError,
  restoreSentBag,
  selectableMessages,
  selectionFromContainer,
  sendPresentation,
  sentBagState,
  _resetSendingForTest,
  type PresentRefusal,
  type ReadyArbiterKey,
  type SendPresentationDeps,
  type SentBagState,
} from './presentToArbiter';
import type { DisputeBoxList } from './disputeBox';
import { fetchDisputeBag, putDisputeBag } from './disputeBox';
import { installFakeChatDisk, type FakeChatDisk } from './__stand__/fakeChatDisk';
import {
  makeActor, attestationOf, forgeFrames, seedArchive, type Actor,
} from './__stand__/presentationFixtures';
import {
  readPresentationDrafts, unsentPresentationDrafts, type PresentationDraft,
} from './presentationDraft';
import { presentationWireBytes } from './presentationBag';
import { _resetConversationMemoryForTest } from './chatConversation';
import {
  BagBudgetError, BagPassError, BagRateLimitError, BagTransportError,
} from './chatTransport';

const AGREEMENT = '0x760f07367888c62f7c2dfb619a5e534132855ce5' as `0x${string}`;
const ARBITER   = '0x2e7a7a0515bfdc0006a812ebb3e55d32800bc660' as `0x${string}`;
const OTHER_ARB = '0x268dcfa7ab0dc134d01c5cbcaa7d2834d6dd0f0f' as `0x${string}`;
/** Время склада. Отличается от `now()` НАРОЧНО: человеку показывается оно. */
const STORED_AT = 1_754_401_010_000;
const BAG_KEY   = `${AGREEMENT}/1754401010000-aaaa.bin`;

/** 0x + 64 hex из байтов — свой, чтобы не тянуть чужой helper в замер. */
function hex32(bytes: Uint8Array): Hex {
  return ('0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

let disk: FakeChatDisk;
let alice: Actor;
let bob: Actor;
/** Тот же кошелёк, что `bob`, но ДРУГИЕ ключи чата — вошёл по коду
 *  восстановления. Ради него и существует пункт 48. */
let bobRestored: Actor;
let judy: Actor;

beforeEach(async () => {
  _resetSendingForTest();
  _resetConversationMemoryForTest();
  disk = installFakeChatDisk();
  alice       = await makeActor(`0x${'11'.repeat(32)}`, '1c');
  bob         = await makeActor(`0x${'22'.repeat(32)}`, '7f');
  bobRestored = await makeActor(`0x${'22'.repeat(32)}`, '5e');
  judy        = await makeActor(`0x${'33'.repeat(32)}`, '3d');
});

afterEach(() => {
  disk.restore();
  _resetConversationMemoryForTest();
  vi.unstubAllGlobals();
});

/** Снимок, который человеку показали и на который он согласился. */
function snapshotOf(arbiter: `0x${string}`, keyBytes: Uint8Array): PresentedTo {
  return { arbiter, boxKey: toBoxKey(hex32(keyBytes)) };
}

/** Свежее чтение цепи в форме Задачи 5. */
function readyKey(arbiter: `0x${string}`, keyBytes: Uint8Array): DisputeArbiterKey {
  const boxKey = toBoxKey(hex32(keyBytes));
  return {
    state: 'ready', arbiter, boxKey,
    boxKeyBytes: keyBytes as never,   // клеймо не нужно: сюда смотрит только сверка
    registered: true,
  };
}

/**
 * Отслеживает порядок шагов. ⚠️ Шаги `save` и `mark` видны ТОЛЬКО потому, что
 * черновик пишется и помечается через зависимости: без следа мутации «пометить
 * раньше склада» и «черновик не ложится» отличались бы от честного порядка
 * ничем, и число красных было бы враньём.
 */
interface Trace { steps: string[]; puts: number }

async function realDeps(over: Partial<SendPresentationDeps> = {}, trace?: Trace):
  Promise<SendPresentationDeps> {
  const mine   = await forgeFrames(alice, bob, ['сроки прошли', 'где работа']);
  const theirs = await forgeFrames(bob, alice, ['почти готово'], 1_754_400_500_000);
  expect(await seedArchive(alice, bob, [...mine, ...theirs])).toBe(3);
  const drafts = await import('./presentationDraft');
  return {
    agreement: AGREEMENT,
    presenter: alice.address.toLowerCase() as `0x${string}`,
    peer: bob.address.toLowerCase() as `0x${string}`,
    presented: snapshotOf(ARBITER, judy.session.keypair.publicKey),
    // ⚠️ БАЙТЫ ПЕЧАТИ ПРИХОДЯТ ГОТОВЫМИ (снимок Задачи 5) — путь отправки
    // `arbiterBoxKeyBytes` не зовёт нигде. Здесь это те же байты, что и в
    // `presented.boxKey`: снимок один, из него и разложены.
    arbiterBoxKey: judy.session.keypair.publicKey as never,
    peerBoxKey: bob.session.keypair.publicKey,
    selected: [
      { seq: 0, sender: alice.address.toLowerCase() as `0x${string}` },
      { seq: 1, sender: alice.address.toLowerCase() as `0x${string}` },
      { seq: 0, sender: bob.address.toLowerCase() as `0x${string}` },
    ],
    session: alice.session,
    ownAttestation: await attestationOf(alice),
    // ⚠️ СПИСКОМ и через настоящий сборщик списка: подставь сюда одно
    // заверение — и мутация 19 перестанет что-либо значить.
    otherAttestations: otherAttestationsOf({
      attestation: await attestationOf(bob), attestationHistory: [],
    }),
    consent: true,
    readStatus: async () => { trace?.steps.push('status'); return 4; },
    readArbiterNow: async () => {
      trace?.steps.push('arbiter');
      return readyKey(ARBITER, judy.session.keypair.publicKey);
    },
    getPass: async () => { trace?.steps.push('pass'); return 'v1.pass.sig'; },
    put: async () => {
      trace?.steps.push('put');
      if (trace) trace.puts++;
      return { key: BAG_KEY, uploadedAt: STORED_AT };
    },
    saveDraft: async (d) => { trace?.steps.push('save'); return drafts.savePresentationDraft(d); },
    markSent: async (p, id, issuedAt, key, at) => {
      trace?.steps.push('mark');
      return drafts.markPresentationSent(p, id, issuedAt, key, at);
    },
    now: () => 1_754_400_999_000,
    ...over,
  };
}

/** Дешёвые деньги: путь, который отказывает ДО сборки, настоящих ключей не ждёт.
 *  ⚠️ Годится ТОЛЬКО для дверей, стоящих раньше сборщика (T4). Всё, что должно
 *  проехать сборку, идёт на `realDeps` — иначе замер мерил бы отказ сборщика. */
function cheapDeps(over: Partial<SendPresentationDeps> = {}, trace?: Trace): SendPresentationDeps {
  return {
    agreement: AGREEMENT,
    presenter: '0x1111111111111111111111111111111111111111',
    peer: '0x2222222222222222222222222222222222222222',
    presented: snapshotOf(ARBITER, new Uint8Array(32).fill(0xab)),
    arbiterBoxKey: new Uint8Array(32).fill(0xab) as never,
    peerBoxKey: new Uint8Array(32).fill(7),
    selected: [{ seq: 0, sender: '0x1111111111111111111111111111111111111111' }],
    session: {} as unknown as ChatSession,
    ownAttestation: {} as unknown as ChatKeyAttestation,
    consent: true,
    readStatus: async () => { trace?.steps.push('status'); return 4; },
    readArbiterNow: async () => {
      trace?.steps.push('arbiter');
      return readyKey(ARBITER, new Uint8Array(32).fill(0xab));
    },
    getPass: async () => { trace?.steps.push('pass'); return 'v1.pass.sig'; },
    put: async () => {
      trace?.steps.push('put');
      if (trace) trace.puts++;
      return { key: BAG_KEY, uploadedAt: STORED_AT };
    },
    saveDraft: async () => { trace?.steps.push('save'); return 'saved'; },
    markSent: async () => { trace?.steps.push('mark'); return 'saved'; },
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Кнопка живёт вместе со спором (§2.2 замысла)
// ═══════════════════════════════════════════════════════════════════════════

describe('когда кнопка вообще есть', () => {
  it('T1: вне спора кнопки нет ни в одном из шести прочих статусов', () => {
    // Число 4 написано РУКАМИ рядом с константой модуля — иначе замер сверял бы
    // значение сам с собой и молчал бы при её смене.
    expect(AGREEMENT_STATUS_DISPUTED).toBe(4);
    const shown = [0, 1, 2, 3, 5, 6, undefined].map(
      status => presentButtonVisible({ status, isParty: true }));
    expect(shown).toEqual([false, false, false, false, false, false, false]);
  });

  it('T2: в споре и я сторона — кнопка есть', () => {
    expect(presentButtonVisible({ status: 4, isParty: true })).toBe(true);
  });

  it('T3: в споре, но я не сторона (арбитр, посторонний) — кнопки нет', () => {
    expect(presentButtonVisible({ status: 4, isParty: false })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Согласие — заново на каждое предъявление (§2.4 замысла)
// ═══════════════════════════════════════════════════════════════════════════

describe('согласие', () => {
  it('T4: без согласия отправки нет, и склада никто не трогал', async () => {
    const trace: Trace = { steps: [], puts: 0 };
    const v = await sendPresentation(cheapDeps({ consent: false }, trace));
    expect(v).toEqual({ ok: false, reason: 'no_consent' });
    expect(trace.puts, 'без согласия сходили на склад').toBe(0);
    expect(trace.steps, 'без согласия вообще что-то делали').toEqual([]);
  });

  it('T5: «Отправить» заперта, пока согласие не поставлено — и после отправки заново', () => {
    const base = { selected: 3, busy: false, status: 4 };
    expect(canSend({ ...base, consent: false })).toBe(false);
    expect(canSend({ ...base, consent: true })).toBe(true);
    // Второе предъявление начинается с чистого согласия: состояние согласия —
    // не «поставил однажды», а «поставил на ЭТО предъявление». Проверяется тем,
    // что `canSend` знает только про поданное значение и ничего не помнит.
    expect(canSend({ ...base, consent: false })).toBe(false);
    // И три остальных запрета — каждый сам по себе.
    expect(canSend({ ...base, consent: true, selected: 0 })).toBe(false);
    expect(canSend({ ...base, consent: true, busy: true })).toBe(false);
    expect(canSend({ ...base, consent: true, status: 2 })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Снимок сверяется с цепью — ДВАЖДЫ, и это разные двери
// ═══════════════════════════════════════════════════════════════════════════

describe('цепь сверяется со снимком, а не сама с собой', () => {
  it('T6: спор закрылся, пока человек читал предупреждение — не отправляем', async () => {
    // ⚠️ ЗДЕСЬ НУЖНЫ НАСТОЯЩИЕ ЗАВИСИМОСТИ, и это не роскошь. На дешёвых
    // снятие проверки статуса упёрлось бы в сборщик (`no_session`), и мутация
    // 2 красила бы имя чужого отказа, а не факт «мешок уехал по закрытому
    // спору». С `realDeps` снятие двери даёт `trace.puts === 1` — порча портит.
    const trace: Trace = { steps: [], puts: 0 };
    const v = await sendPresentation(await realDeps({ readStatus: async () => {
      trace.steps.push('status'); return 5;
    } }, trace));
    expect(v).toEqual({ ok: false, reason: 'not_disputed' });
    expect(trace.puts, 'мешок уехал по закрытому спору').toBe(0);
    expect(trace.steps, 'до сборки дело дошло').toEqual(['status']);
  }, 120_000);

  it('T7: арбитр сменился ДО сборки — отказ раньше пяти секунд крипто', async () => {
    const trace: Trace = { steps: [], puts: 0 };
    const v = await sendPresentation(await realDeps({
      readArbiterNow: async () => {
        trace.steps.push('arbiter');
        return readyKey(OTHER_ARB, judy.session.keypair.publicKey);
      },
    }, trace));
    expect(v).toEqual({ ok: false, reason: 'arbiter_changed' });
    expect(trace.puts, 'мешок на ключ прежнего арбитра всё-таки уехал').toBe(0);
    // ⚠️ ИМЕННО ЭТО ОТЛИЧАЕТ ПЕРВУЮ ДВЕРЬ ОТ ВТОРОЙ: сборки не было вовсе.
    // Уберите раннюю сверку — появится 'save', и замер это назовёт.
    expect(trace.steps).toEqual(['status', 'arbiter']);
  }, 120_000);

  it('T22: арбитр сменился МЕЖДУ сборкой и складом — согласие было про другого', async () => {
    // Сцена дословно: человек прочёл «Получит арбитр 0x2e7a…», нажал
    // «Отправить», и пока шла печать, спор перезаклеймили. Снимок в замере
    // ОДИН и тот же — сверяется он, а не два свежих чтения между собой.
    const trace: Trace = { steps: [], puts: 0 };
    let call = 0;
    const v = await sendPresentation(await realDeps({
      readArbiterNow: async () => {
        trace.steps.push('arbiter');
        call++;
        return call === 1
          ? readyKey(ARBITER, judy.session.keypair.publicKey)
          : readyKey(OTHER_ARB, judy.session.keypair.publicKey);
      },
    }, trace));
    expect(v).toEqual({ ok: false, reason: 'arbiter_changed' });
    expect(trace.puts, 'мешок уехал ДРУГОМУ человеку, чем показали').toBe(0);
    // Сборка была, склад — нет: вторая дверь стоит именно там.
    expect(trace.steps).toEqual(['status', 'arbiter', 'save', 'arbiter']);
  }, 120_000);

  it('T23: ключ повернулся, арбитра нет, узел молчит — три разные двери', async () => {
    const other = new Uint8Array(32).fill(0xcd);
    const cases: Array<[DisputeArbiterKey, PresentRefusal]> = [
      // Тот же человек, ДРУГОЙ ключ чата: адресная сверка это пропустила бы, и
      // арбитр получил бы нечитаемые байты.
      [readyKey(ARBITER, other), 'key_changed'],
      // ⚠️ ТРЕБОВАНИЕ К ЗАДАЧЕ 5, и оно здесь запирается: на этих состояниях
      // `comparePresentedWith` обязана давать сигнал, а не молчать.
      [{ state: 'no_key', arbiter: ARBITER, registered: null }, 'key_changed'],
      [{ state: 'no_arbiter' }, 'arbiter_left'],
      // «Не спросили» — не «сменился»: разбирается ДО сверки.
      [{ state: 'unreadable', error: new Error('узел молчит') }, 'chain_unavailable'],
    ];
    for (const [now, reason] of cases) {
      _resetSendingForTest();
      const trace: Trace = { steps: [], puts: 0 };
      const v = await sendPresentation(await realDeps({
        readArbiterNow: async () => { trace.steps.push('arbiter'); return now; },
      }, trace));
      expect({ reason, got: v }).toEqual({ reason, got: { ok: false, reason } });
      expect(trace.puts, `${reason}: мешок всё-таки уехал`).toBe(0);
    }
  }, 240_000);

  it('T26: узел не ответил — вердикт с именем, а не поломка', async () => {
    // Докстринг обещает «НЕ БРОСАЕТ». Обещание проверяется, а не подразумевается.
    const trace: Trace = { steps: [], puts: 0 };
    expect(await sendPresentation(await realDeps({
      readStatus: async () => { throw new Error('RPC timeout'); },
    }, trace))).toEqual({ ok: false, reason: 'chain_unavailable' });
    _resetSendingForTest();
    expect(await sendPresentation(await realDeps({
      readArbiterNow: async () => { throw new Error('RPC timeout'); },
    }, trace))).toEqual({ ok: false, reason: 'chain_unavailable' });
    expect(trace.puts).toBe(0);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Честная отправка: порядок шагов и что уходит на склад
// ═══════════════════════════════════════════════════════════════════════════

describe('отправка', () => {
  it('T8: порядок «статус → арбитр → сборка → черновик → арбитр → пропуск → склад → пометка»', async () => {
    const trace: Trace = { steps: [], puts: 0 };
    const deps = await realDeps({}, trace);
    const v = await sendPresentation(deps);
    expect(v.ok, `отправка отказала: ${v.ok ? '' : v.reason}`).toBe(true);
    if (!v.ok) return;
    expect(trace.steps).toEqual(['status', 'arbiter', 'save', 'arbiter', 'pass', 'put', 'mark']);
    expect(v.draftSaved, 'черновик не лёг ДО отправки').toBe('saved');
    expect(v.draftMarked, 'помечать было нечего — черновика не было').toBe('saved');
    expect(v.bagKey).toBe(BAG_KEY);
    // ⚠️ ВРЕМЯ СКЛАДА, А НЕ СВОИ ЧАСЫ. `now()` в замере — 1_754_400_999_000,
    // склад ответил 1_754_401_010_000. Возьми клиент свои часы — «положено в
    // 14:02» у стороны разошлось бы с описью у арбитра.
    expect(v.uploadedAt).toBe(STORED_AT);
    expect(v.uploadedAt).not.toBe(1_754_400_999_000);
    // И то же число уехало в черновик: у времени один хозяин, а не два.
    const marked = await readPresentationDrafts(deps.presenter);
    expect(marked[0].sentAt).toBe(STORED_AT);
    expect(marked[0].bagKey).toBe(BAG_KEY);
    // Черновик после успешной отправки перестаёт быть неотправленным.
    expect(await unsentPresentationDrafts(deps.presenter)).toEqual([]);
  }, 120_000);

  it('T9: склад отказал — черновик остался НЕОТПРАВЛЕННЫМ', async () => {
    // 500 `internal_error` — то, чем живой сервер отвечает на кончившееся
    // место (507 он не отдаёт вовсе, см. перечень Задачи 1).
    const deps = await realDeps({
      put: async () => { throw new BagTransportError('Storage failed', 'internal_error', 500); },
    });
    const v = await sendPresentation(deps);
    expect(v).toEqual({ ok: false, reason: 'box_refused' });
    const left = await unsentPresentationDrafts(deps.presenter);
    expect(left.length, 'после отказа склада черновик потерян').toBe(1);
    expect(left[0].state).toBe('built');
    expect(left[0].container.frames.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('T10: у каждой беды ящика своя дверь — по КОДУ, а не по классу статуса', async () => {
    // ⚠️ ЗДЕСЬ НУЖНА НАСТОЯЩАЯ СБОРКА, и это не роскошь: путь до склада идёт
    // ПОСЛЕ неё. На дешёвых зависимостях сборка отказала бы `no_session`, и
    // замер мерил бы отказ сборщика, а не разводку бед ящика — ровно «тест
    // краснеет по чужой причине».
    const base = await realDeps();
    // Коды — из таблицы Задачи 1, написаны здесь РУКАМИ. Схлопнуть их в один
    // «ящик не принял» значит выбросить её работу на подходе к глазам:
    // «вы не сторона», «спор закрылся», «цепь молчит» и «слишком часто» —
    // четыре разные беды с четырьмя разными лечениями.
    const cases: Array<[unknown, PresentRefusal]> = [
      [new BagTransportError('Not a party', 'not_a_party', 403), 'not_a_party'],
      [new BagTransportError('Not disputed', 'not_disputed', 409), 'not_disputed'],
      [new BagTransportError('No such deal', 'no_such_deal', 404), 'no_such_deal'],
      [new BagTransportError('Chain silent', 'chain_unavailable', 503), 'chain_unavailable'],
      [new BagRateLimitError('Slow down', 'rate_limited_write', 60), 'rate_limited'],
      [new BagBudgetError(), 'rate_limited'],
      [new BagTransportError('Too large', 'payload_too_large', 413), 'box_refused'],
      [new BagTransportError('Broken', 'internal_error', 500), 'box_refused'],
      [new TypeError('fetch failed'), 'offline'],
    ];
    for (const [err, reason] of cases) {
      _resetSendingForTest();
      const v = await sendPresentation({ ...base, put: async () => { throw err; } });
      expect({ reason, got: v }).toEqual({ reason, got: { ok: false, reason } });
    }
    // Протухший пропуск — своя дверь: чинить человеку нечего, надо переподписать.
    _resetSendingForTest();
    expect(await sendPresentation({
      ...base, getPass: async () => { throw new BagPassError('pass expired', 'pass_expired', 401); },
    })).toEqual({ ok: false, reason: 'pass_refused' });
    // И та же разводка отдельно, без пути отправки: её зовёт Задача 7.
    expect(refusalOfBoxError(new BagTransportError('Not a party', 'not_a_party', 403)))
      .toBe('not_a_party');
  }, 240_000);

  it('T11: двадцать нажатий подряд — ОДИН мешок на складе', async () => {
    const trace: Trace = { steps: [], puts: 0 };
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r; });
    const deps = await realDeps({
      put: async () => {
        trace.puts++;
        await held;               // держим первую отправку в полёте
        return { key: BAG_KEY, uploadedAt: STORED_AT };
      },
    }, trace);
    const all = Array.from({ length: 20 }, () => sendPresentation(deps));
    // Дать девятнадцати добежать до замка «в полёте».
    await new Promise((r) => setTimeout(r, 0));
    release?.();
    const results = await Promise.all(all);
    expect(trace.puts, 'на склад ушло не одно предъявление').toBe(1);
    const busy = results.filter(r => !r.ok && r.reason === 'already_sending').length;
    expect(busy, 'занятость не назвала себя').toBe(19);
    expect(results.filter(r => r.ok).length).toBe(1);
  }, 120_000);

  it('T12: ЗАМЕР ЧЕСТНОСТИ — две вкладки замком не связаны, и это НЕ починено', async () => {
    // Замок «в полёте» живёт в памяти модуля, то есть в одной вкладке. Второй
    // экземпляр модуля — это ровно вторая вкладка. Число называется вслух:
    // два мешка, а не один. Общая память вкладок (`navigator.locks`) закрыла бы
    // и это, но цена — ещё один замок на пути отправки; в объём не входит и
    // записано в «Возражения».
    vi.resetModules();
    const second = await import('./presentToArbiter');
    const trace: Trace = { steps: [], puts: 0 };
    const deps = await realDeps({}, trace);
    const [a, b] = await Promise.all([
      sendPresentation(deps),
      second.sendPresentation(deps as never),
    ]);
    expect(a.ok && b.ok, 'обе «вкладки» обязаны были доехать').toBe(true);
    expect(trace.puts, 'две вкладки внезапно связаны замком').toBe(2);
  }, 120_000);

  it('T13: закрыл вкладку сразу после сборки — черновик читается заново', async () => {
    const deps = await realDeps({
      put: async () => { throw new TypeError('fetch failed'); },   // «вкладку закрыли»
    });
    expect(await sendPresentation(deps)).toEqual({ ok: false, reason: 'offline' });
    // Новая «вкладка»: модули заново, диск тот же (Map переживает resetModules).
    vi.resetModules();
    const draftModule = await import('./presentationDraft');
    const left = await draftModule.unsentPresentationDrafts(deps.presenter);
    expect(left.length, 'после перезапуска собранное предъявление пропало').toBe(1);
    expect(left[0].dealId.toLowerCase()).toBe(AGREEMENT);
    expect(left[0].wireBytes).toBeGreaterThan(0);
  }, 120_000);

  it('T17: на склад уходит РОВНО собранный контейнер — «замазать» негде', async () => {
    let sent: Uint8Array | null = null;
    const deps = await realDeps({
      put: async (_p, _a, sealed) => {
        sent = sealed;
        return { key: BAG_KEY, uploadedAt: STORED_AT };
      },
    });
    // Черновик читаем ДО отправки нельзя (он ляжет внутри), поэтому берём его
    // после: контейнер там тот же объект, что уехал в печать.
    const v = await sendPresentation(deps);
    expect(v.ok).toBe(true);
    const drafts = await readPresentationDrafts(deps.presenter);
    expect(drafts.length).toBe(1);
    const container = drafts[0].container;

    expect(sent, 'на склад ничего не ушло').not.toBeNull();
    // ⚠️ Побайтно сверить с повторной печатью НЕЛЬЗЯ: `crypto_box_seal` берёт
    // разовый ключ, две печати одного контейнера дают разные байты. Сверяется
    // ДЛИНА — тот же замок, что у стендового замера потопа
    // (`presentationFlood.test.ts`: `sealed.length === presentationWireBytes(c)`).
    // Что мешок распечатывается в ТОТ ЖЕ контейнер, проверяет стенд (S2), где
    // есть настоящая пара ключей арбитра.
    expect((sent as unknown as Uint8Array).byteLength)
      .toBe(presentationWireBytes(container));
    expect(drafts[0].wireBytes).toBe(presentationWireBytes(container));
  }, 120_000);

  it('T21: собеседник сменил ключ — в контейнер едут ОБА заверения (пункт 48)', async () => {
    // ⚠️ СЦЕНА ПУНКТА 48 ДОСЛОВНО. Боб потерял устройство, вошёл по коду
    // восстановления, `signKey` сменился. Кадры в архиве подписаны ПРЕЖНИМ
    // ключом. Уедет одно нынешнее заверение — читалка у арбитра даст
    // `frame: malformed` и `attestation: wrong_keys`, то есть честный человек
    // будет предъявлен подделывателем, и все тесты при этом останутся зелёными.
    //
    // ⚠️ Кадры сеет сам `realDeps` (архив в этом файле один на кейс, второй
    // посев сложился бы с первым и уронил его же проверку числа). Кадр Боба
    // там подписан ключами `bob` — то есть ПРЕЖНЕЙ парой.
    const peerKeys = {
      // Нынешнее заверение — про НОВУЮ пару ключей (после восстановления).
      attestation: await attestationOf(bobRestored),
      // История — про ту пару, которой подписаны показываемые кадры.
      attestationHistory: [await attestationOf(bob)],
    };
    const base = await realDeps({
      selected: [
        { seq: 0, sender: alice.address.toLowerCase() as `0x${string}` },
        { seq: 0, sender: bob.address.toLowerCase() as `0x${string}` },
      ],
      otherAttestations: otherAttestationsOf(peerKeys),
      put: async () => ({ key: BAG_KEY, uploadedAt: STORED_AT }),
    });
    expect((await sendPresentation(base)).ok).toBe(true);
    const withHistory = (await readPresentationDrafts(base.presenter))[0].container;
    // Своё заверение + заверение той пары, которой подписан кадр Боба.
    expect(withHistory.attestations.length,
      'в контейнер уехало не больше одного чужого заверения').toBeGreaterThanOrEqual(2);
    expect(withHistory.attestations.map(a => a.signKey))
      .toContain((await attestationOf(bob)).signKey);
  }, 180_000);

  it('T25: выбор восстанавливается из сохранённого контейнера — «одно нажатие»', async () => {
    const deps = await realDeps();
    expect((await sendPresentation(deps)).ok).toBe(true);
    const container = (await readPresentationDrafts(deps.presenter))[0].container;
    const restored = selectionFromContainer(container);
    const key = (s: { seq: number; sender: string }) => `${s.sender.toLowerCase()}|${s.seq}`;
    expect([...restored].map(key).sort()).toEqual([...deps.selected].map(key).sort());
  }, 120_000);

  it('T27: перезагрузили вкладку — «положено» и время поднимаются из ЧЕРНОВИКА', async () => {
    // ⚠️ ЭТО ОБСТОЯТЕЛЬСТВО «УШЁЛ И ВЕРНУЛСЯ», А НЕ УКРАШЕНИЕ. Пока «положено»
    // жило только в состоянии React той вкладки, где нажали «Отправить»,
    // вернувшийся видел ПУСТОТУ — при том что мешок лежит и, возможно, уже
    // забран; такт описи гейтится тем же состоянием и после перезагрузки не
    // запускался вовсе. Самый вероятный следующий шаг человека в этом месте —
    // предъявить второй раз (замок «в полёте» этого не ловит, T12).
    const deps = await realDeps();
    expect((await sendPresentation(deps)).ok).toBe(true);

    // Новая «вкладка»: модули заново, диск тот же (Map переживает resetModules).
    vi.resetModules();
    const fresh = await import('./presentToArbiter');
    const back = await fresh.restoreSentBag(deps.presenter, AGREEMENT);
    expect(back, 'после перезагрузки восстанавливать оказалось нечего').not.toBeNull();
    // ⚠️ ВРЕМЯ СКЛАДА, А НЕ СВОИ ЧАСЫ: в черновик уехало серверное `uploadedAt`
    // (`now()` в замере — 1_754_400_999_000, склад ответил 1_754_401_010_000).
    expect(back).toEqual({ key: BAG_KEY, uploadedAt: STORED_AT });

    // И такт описи, поднятый по восстановленному ключу, доносит «забрали».
    const bag = {
      key: BAG_KEY, sender: deps.presenter, sealedFor: ARBITER, size: 10,
      uploadedAt: STORED_AT, fetchedAt: STORED_AT + 60_000,
    };
    expect(fresh.sentBagState(
      { bags: [bag], arbiter: ARBITER, sealedForOthers: 0, indexTrusted: true }, String(back?.key)))
      .toEqual({ kind: 'fetched', uploadedAt: STORED_AT, fetchedAt: STORED_AT + 60_000 });

    // Отбор — по делу и по состоянию, а не «последний какой попало».
    const drafts = await readPresentationDrafts(deps.presenter);
    expect(lastSentBag(drafts, `0x${'9'.repeat(40)}`), 'взят черновик ЧУЖОЙ сделки').toBeNull();
    expect(lastSentBag(drafts.map(d => ({ ...d, state: 'built' as const })), AGREEMENT),
      'неотправленный черновик выдан за положенное').toBeNull();
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Черновик как вход в «одно нажатие» (§2.3 замысла)
// ═══════════════════════════════════════════════════════════════════════════

describe('какой черновик предлагаем вернуть', () => {
  it('T31: из двух собранных этой сделки берётся СВЕЖИЙ, а не первый попавшийся', () => {
    // ⚠️ ЗАПИСИ СОБРАНЫ РУКАМИ, И ЭТО НЕ ПОДДЕЛКА КОНТЕЙНЕРА. Отбор — свойство
    // СПИСКА записей (`issuedAt`, `dealId`), контейнер в нём не участвует
    // вовсе; настоящая сборка стоила бы крипто-операции на кадр и не доказала
    // бы ничего сверх этого. Сцена штатная, а не редкая: `sendPresentation`
    // кладёт черновик ДО отправки, значит каждый отказ
    // `arbiter_changed`/`key_changed` оставляет ещё один собранный черновик.
    const OTHER_DEAL = `0x${'9'.repeat(40)}` as `0x${string}`;
    const draft = (issuedAt: number, state: 'built' | 'sent', deal = AGREEMENT) => ({
      dealId: deal, presenter: ARBITER, issuedAt, messageCount: 1, wireBytes: 10,
      state, container: { frames: [] },
    } as unknown as PresentationDraft);
    // Порядок — тот, что отдаёт хозяин (`readPresentationDrafts`: по `issuedAt`
    // УБЫВАНИЮ, `presentationDraft.ts:295`). Своей сортировки здесь нет.
    const list = [draft(300, 'built'), draft(200, 'built'), draft(100, 'sent')];
    expect(lastDraftOfDeal(list, AGREEMENT)?.issuedAt,
      'взят самый СТАРЫЙ черновик — «последний» в списке, отсортированном по убыванию').toBe(300);
    // Чужая сделка и пустота — `null`, а не «что-нибудь».
    expect(lastDraftOfDeal([draft(300, 'built', OTHER_DEAL)], AGREEMENT)).toBeNull();
    expect(lastDraftOfDeal([], AGREEMENT)).toBeNull();
  });

  it('T32: уже ОТПРАВЛЕННОЕ предлагается заново — сцена §2.3 дословно', async () => {
    // ⚠️ СЦЕНА ЗАМЫСЛА: предъявили арбитру №1, арбитра сменили, сторону просят
    // предъявить заново. Модалка, спрашивающая только НЕотправленные, в этой
    // сцене не предложит ничего — и «одно нажатие» §2.3 не существует.
    const deps = await realDeps();
    expect((await sendPresentation(deps)).ok).toBe(true);
    expect(await unsentPresentationDrafts(deps.presenter),
      '§2.3: после отправки предлагать нечего').toEqual([]);

    const offer = lastDraftOfDeal(await readPresentationDrafts(deps.presenter), AGREEMENT);
    expect(offer, 'после отправки вход «вернуть отметки» пуст').not.toBeNull();
    expect(offer?.state).toBe('sent');
    // ⚠️ «Одно нажатие» — это ВЕРНУЛИСЬ ОТМЕТКИ, а не пересылка мешка: разовые
    // ключи запечатаны на прежнего арбитра (раздел 6 договора шапки).
    const key = (s: { seq: number; sender: string }) => `${s.sender.toLowerCase()}|${s.seq}`;
    expect(selectionFromContainer(offer?.container ?? { frames: [] }).map(key).sort())
      .toEqual([...deps.selected].map(key).sort());
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Снимок ключа и адрес ящика — то, что едет НАРУЖУ
// ═══════════════════════════════════════════════════════════════════════════

describe('снимок: переход один (Задача 5), добывание одно (сеанс выбора)', () => {
  it('T28: presentedFromKey РАЗДАЁТ снимок, а не пересчитывает его', () => {
    const bytes = new Uint8Array(32).fill(0xab);
    const key = readyKey(ARBITER, bytes) as ReadyArbiterKey;
    const snap = presentedFromKey(key);
    expect(snap.presented).toEqual({ arbiter: ARBITER, boxKey: key.boxKey });
    // ⚠️ ТОЖДЕСТВО (`toBe`), А НЕ РАВЕНСТВО СОДЕРЖИМОГО. Пересчитанные из
    // `boxKey` байты совпали бы побайтно, и замер промолчал бы — то есть
    // второй переход завёлся бы при зелёных тестах. Здесь он краснеет
    // (мутация 26).
    expect(snap.arbiterBoxKey).toBe(key.boxKeyBytes);
  });

  it('T30: двадцать отметок — ОДИН поход в цепь, справочник и кошелёк', async () => {
    // ⚠️ ЗАМЕР ЦЕНЫ ВЫБОРА, И ЧИСЛО ЗДЕСЬ ГЛАВНОЕ. Прежняя редакция брала
    // снимок в `recount`, а `recount` зовётся на КАЖДУЮ отметку: двадцать
    // галочек стоили двадцати чтений цепи, двадцати запросов в справочник и
    // двадцати заходов в кошелёк — при том что докстринг
    // `ensureChatKeyAttestation` разрешает вызов ТОЛЬКО по человеческому
    // действию. Сюда же входил `arbiterTurnOf` (до `TURN_MAX_CHUNKS` = 64
    // кусков `eth_getLogs` у узкого провайдера, Задача 5) — в дешёвом снимке
    // его нет вовсе, и это видно по составу полей ниже.
    const calls = { arbiter: 0, peer: 0, attestation: 0 };
    const bytes = new Uint8Array(32).fill(0xab);
    const io = {
      readArbiterKey: async () => { calls.arbiter++; return readyKey(ARBITER, bytes); },
      readPeerKeys: async () => {
        calls.peer++;
        return {
          boxKey: bob.session.keypair.publicKey,
          attestation: await attestationOf(bob),
          attestationHistory: [],
        };
      },
      ensureAttestation: async () => { calls.attestation++; return attestationOf(alice); },
    };
    const picking = pickingPrep(io);

    // Число написано РУКАМИ: иначе замер сверял бы себя с собой.
    const TICKS = 20;
    expect(TICKS).toBe(20);
    // Двадцать разом — люди щёлкают быстрее, чем отвечает сеть; плюс один
    // после, чтобы память сеанса не сводилась к «склеили одновременные».
    const parallel = await Promise.all(Array.from({ length: TICKS }, () => picking.get()));
    const later = await picking.get();
    expect(parallel.every(v => v.ok) && later.ok, 'снимок не собрался').toBe(true);
    expect(calls, 'снимок берётся не один раз на открытие выбора')
      .toEqual({ arbiter: 1, peer: 1, attestation: 1 });

    // ⚠️ СЧЁТА АРБИТРОВ В ДЕШЁВОМ СНИМКЕ НЕТ — это ФОРМА, а не дисциплина:
    // поля перечислены руками, и `turn` среди них не бывает.
    if (!later.ok) return;
    expect(Object.keys(later.prep).sort()).toEqual(
      ['arbiterBoxKey', 'otherAttestations', 'ownAttestation', 'peerBoxKey', 'presented']);
    // И раздаётся ТОТ ЖЕ снимок, а не пересобранный на каждый зов.
    expect(parallel[0].ok && parallel[0].prep).toBe(later.prep);
  });

  it('T29: мусорный адрес ящика — громкий отказ ДО сети, а не запрос не в тот ящик', () => {
    // ⚠️ ЗАМЕР СМОТРИТ НА СЕТЬ, А НЕ НА РОД ОШИБКИ, и это не придирка: `fetch`
    // с негодным путём тоже бросает `TypeError`, поэтому одно
    // `rejects.toThrow(TypeError)` сходилось бы и БЕЗ проверки формы — пустая
    // мутация в чистом виде. Главное утверждение здесь — что в сеть не пошли.
    const wentOut = vi.fn(async () => { throw new Error('запрос ушёл в сеть'); });
    vi.stubGlobal('fetch', wentOut);
    return (async () => {
      await expect(putDisputeBag('v1.pass', 'не адрес' as never, new Uint8Array([1]), null))
        .rejects.toThrow(TypeError);
      // Ключ без ящика и ключ из ЧУЖОГО ящика — тоже наш мусор, и тоже громко.
      await expect(fetchDisputeBag('v1.pass', AGREEMENT, 'без-ящика.bin'))
        .rejects.toThrow(TypeError);
      await expect(fetchDisputeBag('v1.pass', AGREEMENT, `${OTHER_ARB}/1-a.bin`))
        .rejects.toThrow(TypeError);
      expect(wentOut, 'клиент пошёл в сеть с адресом, который сам же не разобрал')
        .not.toHaveBeenCalled();
    })();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Что человек читает
// ═══════════════════════════════════════════════════════════════════════════

describe('слова человеку', () => {
  it('T14: у КАЖДОЙ причины отказа свой ключ локали, и все они разные', () => {
    // Список причин написан РУКАМИ, и в нём ВОСЕМЬ имён сборщика (Задача 4),
    // а не пять: у `attestation_missing` / `_expired` / `_unproven` лечение
    // РАЗНОЕ — «нажать заверить ключи», «заверение устарело», «переподпись не
    // поможет, подключите сеть». Схлопнуть их обратно в один текст значит
    // вернуть пункт 49: человек лечил не то.
    const REASONS: PresentRefusal[] = [
      'arbiter_has_no_key', 'peer_has_no_key', 'nothing_selected', 'too_large', 'no_session',
      'attestation_missing', 'attestation_expired', 'attestation_unproven',
      'not_disputed', 'arbiter_changed', 'key_changed', 'arbiter_left',
      'no_consent', 'already_sending',
      'chain_unavailable', 'not_a_party', 'no_such_deal', 'rate_limited',
      'box_refused', 'offline', 'pass_refused',
      // Ревью, круг 1 (I-5): наша поломка ДО склада.
      'internal_error',
    ];
    expect(REASONS.length, 'список причин усох незамеченным').toBe(22);
    expect(Object.keys(PRESENT_REFUSAL_KEYS).sort()).toEqual([...REASONS].sort());
    const values = REASONS.map(r => PRESENT_REFUSAL_KEYS[r]);
    expect(new Set(values).size, 'две причины делят один текст').toBe(REASONS.length);
    for (const v of values) expect(v.startsWith('chat.present_err_')).toBe(true);
  });

  it('T20: заверения собеседника собираются СПИСКОМ — нынешнее и вся история', () => {
    const now = { signKey: '0xaa', address: ARBITER } as unknown as ChatKeyAttestation;
    const old1 = { signKey: '0xbb', address: ARBITER } as unknown as ChatKeyAttestation;
    const old2 = { signKey: '0xcc', address: ARBITER } as unknown as ChatKeyAttestation;
    expect(otherAttestationsOf({ attestation: now, attestationHistory: [old1, old2] }))
      .toEqual([now, old1, old2]);
    // Нынешнего нет (старая запись справочника) — история всё равно едет.
    expect(otherAttestationsOf({ attestation: null, attestationHistory: [old1] }))
      .toEqual([old1]);
    // Пусто — пусто, а не `[null]`: сборщик получит массив, а не мусор.
    expect(otherAttestationsOf({ attestation: null, attestationHistory: [] })).toEqual([]);
  });

  it('T24: «положено» и «забрали» — из ОПИСИ, и «не знаю» называется отдельно', () => {
    const bag = {
      key: BAG_KEY, sender: ARBITER, sealedFor: null, size: 10,
      uploadedAt: STORED_AT, fetchedAt: null,
    };
    const list = { bags: [bag], arbiter: ARBITER, sealedForOthers: 0, indexTrusted: true };
    expect(sentBagState(list, BAG_KEY)).toEqual({ kind: 'placed', uploadedAt: STORED_AT });
    expect(sentBagState({ ...list, bags: [{ ...bag, fetchedAt: STORED_AT + 60_000 }] }, BAG_KEY))
      .toEqual({ kind: 'fetched', uploadedAt: STORED_AT, fetchedAt: STORED_AT + 60_000 });
    // Описи нет вовсе (не прочиталась) и мешка в описи нет — это ОДНО и то же
    // «не знаю», и врать «не забрали» здесь нельзя.
    expect(sentBagState(null, BAG_KEY)).toEqual({ kind: 'unknown' });
    expect(sentBagState({ ...list, bags: [] }, BAG_KEY)).toEqual({ kind: 'unknown' });
  });

  it('T15: «влезает N» — только когда число известно; сами НИЧЕГО не режем', () => {
    const all: FitVerdict = { ok: true, fit: { fits: 5, limit: 262_144, bytesAtFits: 1000 } };
    expect(fitNotice(all, 5)).toEqual({ kind: 'all', fits: 5 });
    const part: FitVerdict = { ok: true, fit: { fits: 3, limit: 262_144, bytesAtFits: 900 } };
    expect(fitNotice(part, 5)).toEqual({ kind: 'partial', fits: 3, total: 5 });
    // ⚠️ ПУНКТ 50.1 СОБРАН РУКАМИ: настоящее расхождение требует четверти
    // мегабайта переписки, и выдавать это за сквозной замер нельзя. Сцена
    // такая: сборщик назвал число, на своём же числе не собрался, и
    // `fittingMessageCount` вернула его причину БЕЗ числа.
    expect(fitNotice({ ok: false, reason: 'too_large' }, 5)).toEqual({ kind: 'unknown' });
    // Прочие причины — не «неизвестно», а свой отказ.
    expect(fitNotice({ ok: false, reason: 'no_session' }, 5))
      .toEqual({ kind: 'refused', reason: 'no_session' });
    expect(fitNotice({ ok: false, reason: 'nothing_selected' }, 0))
      .toEqual({ kind: 'refused', reason: 'nothing_selected' });
  });

  it('T16: сообщение с негодным отправителем выбрасывается, и число называется', () => {
    const rows = selectableMessages([
      { from: '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa', seq: 0, text: 'раз', timestamp: 1, isFromMe: true },
      { from: 'bot', seq: 1, text: 'служебное', timestamp: 2, isFromMe: false },
      { from: '', seq: 2, text: 'ничьё', timestamp: 3, isFromMe: false },
      { from: '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb', seq: 0, text: 'два', timestamp: 4, isFromMe: false },
    ]);
    expect(rows.dropped, 'выброшенные сообщения не посчитаны').toBe(2);
    expect(rows.rows.map(r => r.sender)).toEqual([
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(rows.rows.map(r => r.mine)).toEqual([true, false]);
  });

  it('T18: предупреждение называет ВСЕ пять вещей, включая третьих лиц и вложения', () => {
    const w = presentWarning({ count: 7, arbiter: ARBITER, turn: { known: true, turn: 2 } });
    expect(w.lines.map(l => l.key)).toEqual([
      'chat.present_warn_who',
      'chat.present_warn_turn',
      'chat.present_warn_everything',
      'chat.present_warn_files',
      'chat.present_warn_final',
    ]);
    expect(w.lines[0].params).toEqual({ n: 7, arbiter: ARBITER });
    expect(w.lines[1].params).toEqual({ n: 2 });
  });

  it('T19: счёт арбитров неизвестен — так и написано, а не «первый»', () => {
    const w = presentWarning({ count: 1, arbiter: ARBITER, turn: { known: false } });
    expect(w.lines.map(l => l.key)).toEqual([
      'chat.present_warn_who',
      'chat.present_warn_turn_unknown',
      'chat.present_warn_everything',
      'chat.present_warn_files',
      'chat.present_warn_final',
    ]);
    // ⚠️ `known: false` и `turn: 0` — разные вещи, и слить их нельзя: сторона
    // решает по этому числу, показывать ли переписку.
    expect(w.lines[1].params).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Монтирование и такт описи — РЕШЕНИЯ, вынесенные из эффектов (ревью, круг 1)
//
// ⚠️ ЗАЧЕМ ЭТОТ БЛОК. Прежде эти правила жили функциональными обновлениями
// внутри `useEffect`, и я назвал это «замка нет и БЫТЬ НЕ МОЖЕТ». Это было
// шире правды: приём есть в этом же репозитории (Задача 5,
// `handleChainLogsImpl` + `chainEventBus.test.ts`). Здесь меряется РАБОТА, а
// проводка сторожится вторым, ТЕКСТОВЫМ слоем — и его природа названа там.
// ═══════════════════════════════════════════════════════════════════════════

describe('вернулся на страницу: восстановление не затирает свежее', () => {
  it('T33: восстановленное СТАРОЕ уступает тому, что уже на экране', () => {
    const back = { key: BAG_KEY, uploadedAt: STORED_AT };
    // Пусто — берём восстановленное.
    expect(keepFirstSent(null, back)).toEqual({ key: BAG_KEY });
    expect(keepKnownBox({ kind: 'unknown' }, back))
      .toEqual({ kind: 'placed', uploadedAt: STORED_AT });
    // ⚠️ ГЛАВНОЕ: человек успел отправить ЗАНОВО, пока читался диск. Прямая
    // запись вместо функционального обновления вернула бы ему прошлый мешок и
    // прошлое время — то есть соврала бы про то, что лежит в ящике сейчас.
    const fresher = { key: `${AGREEMENT}/1754402000000-bbbb.bin` };
    expect(keepFirstSent(fresher, back), 'восстановленное затёрло свежее').toBe(fresher);
    const known: SentBagState = { kind: 'fetched', uploadedAt: 1, fetchedAt: 2 };
    expect(keepKnownBox(known, back), 'известное понижено до восстановленного').toBe(known);
  });

  it('T34: тело эффекта монтирования зовёт оба слияния — и молчит, когда нечего', async () => {
    const draft = {
      dealId: AGREEMENT, presenter: ARBITER, issuedAt: 1, messageCount: 1, wireBytes: 10,
      state: 'sent' as const, bagKey: BAG_KEY, sentAt: STORED_AT,
      container: { frames: [] },
    } as unknown as PresentationDraft;

    const applied: string[] = [];
    await restoreMountImpl({
      presenter: ARBITER, agreement: AGREEMENT, alive: () => true,
      applySent: (fn) => { applied.push(`sent:${JSON.stringify(fn(null))}`); },
      applyBox: (fn) => { applied.push(`box:${JSON.stringify(fn({ kind: 'unknown' }))}`); },
      read: async () => [draft],
    });
    expect(applied).toEqual([
      `sent:${JSON.stringify({ key: BAG_KEY })}`,
      `box:${JSON.stringify({ kind: 'placed', uploadedAt: STORED_AT })}`,
    ]);

    // Вкладку закрыли, пока читался диск — не трогаем ничего.
    const dead: string[] = [];
    await restoreMountImpl({
      presenter: ARBITER, agreement: AGREEMENT, alive: () => false,
      applySent: () => dead.push('sent'), applyBox: () => dead.push('box'),
      read: async () => [draft],
    });
    expect(dead, 'писали в состояние мёртвой вкладки').toEqual([]);

    // Восстанавливать нечего — и не пишем «положено неизвестно когда».
    const empty: string[] = [];
    await restoreMountImpl({
      presenter: ARBITER, agreement: AGREEMENT, alive: () => true,
      applySent: () => empty.push('sent'), applyBox: () => empty.push('box'),
      read: async () => [],
    });
    expect(empty).toEqual([]);

    // Диск сломался — «нечего восстанавливать», а не поломка открытия чата.
    const broken: string[] = [];
    await expect(restoreMountImpl({
      presenter: ARBITER, agreement: AGREEMENT, alive: () => true,
      applySent: () => broken.push('sent'), applyBox: () => broken.push('box'),
      read: async () => { throw new Error('диск'); },
    })).resolves.toBeUndefined();
    expect(broken).toEqual([]);
  });
});

describe('такт описи: три правила, и каждое меряется', () => {
  const listOf = (over: Partial<DisputeBoxList> = {}): DisputeBoxList => ({
    bags: [{
      key: BAG_KEY, sender: ARBITER, sealedFor: ARBITER, size: 10,
      uploadedAt: STORED_AT, fetchedAt: null,
    }],
    arbiter: ARBITER, sealedForOthers: 0, indexTrusted: true, ...over,
  });

  it('T35: нет пропуска — в сеть не пошли и состояния не тронули', async () => {
    const calls: string[] = [];
    await tickBoxImpl({
      presenter: ARBITER, agreement: AGREEMENT, bagKey: BAG_KEY, alive: () => true,
      peekPass: () => null,
      list: async () => { calls.push('list'); return listOf(); },
      applyBox: () => calls.push('apply'),
    });
    expect(calls, 'такт описи разбудил бы кошелёк или тронул состояние').toEqual([]);

    // Опись не ответила — известное остаётся как есть, а не мигает.
    const onFail: string[] = [];
    await tickBoxImpl({
      presenter: ARBITER, agreement: AGREEMENT, bagKey: BAG_KEY, alive: () => true,
      peekPass: () => 'v1.pass',
      list: async () => { throw new BagTransportError('нет связи'); },
      applyBox: () => onFail.push('apply'),
    });
    expect(onFail, 'сбой описи стёр то, что уже знали').toEqual([]);

    // Ответила — «забрали» доезжает.
    let got: SentBagState | null = null;
    await tickBoxImpl({
      presenter: ARBITER, agreement: AGREEMENT, bagKey: BAG_KEY, alive: () => true,
      peekPass: () => 'v1.pass',
      list: async () => listOf({ bags: [{
        key: BAG_KEY, sender: ARBITER, sealedFor: ARBITER, size: 10,
        uploadedAt: STORED_AT, fetchedAt: STORED_AT + 60_000,
      }] }),
      applyBox: (fn) => { got = fn({ kind: 'placed', uploadedAt: STORED_AT }); },
    });
    expect(got).toEqual({ kind: 'fetched', uploadedAt: STORED_AT, fetchedAt: STORED_AT + 60_000 });
  });

  it('T36: НЕДОВЕРЕННАЯ опись не понижает «положено» — единственный потребитель indexTrusted', () => {
    const placed: SentBagState = { kind: 'placed', uploadedAt: STORED_AT };
    // ⚠️ СЦЕНА I-3 ДОСЛОВНО. Опись релеера перестраивалась с диска, у
    // восстановленных записей нет `deal`, мешок выпал из выдачи. Понизь мы
    // здесь известное — строка «Положено в ящик спора · 14:02» ИСЧЕЗЛА бы,
    // сменившись на «узнать не удалось», при том что сервер прямым текстом
    // сказал «моей описи не верь», а у стороны есть и ответ склада, и черновик.
    expect(boxStateFromList(placed, listOf({ bags: [], indexTrusted: false }), BAG_KEY))
      .toBe(placed);
    // А при ДОВЕРЕННОЙ описи «мешка нет» — честный ответ сервера (вышел срок).
    expect(boxStateFromList(placed, listOf({ bags: [], indexTrusted: true }), BAG_KEY))
      .toEqual({ kind: 'unknown' });
    // Ничего не знали и при недоверенной описи — так и остаёмся «не знаю».
    expect(boxStateFromList({ kind: 'unknown' }, listOf({ bags: [], indexTrusted: false }), BAG_KEY))
      .toEqual({ kind: 'unknown' });
    // ⚠️ ТОЖДЕСТВО ПРИ НЕИЗМЕНИВШЕМСЯ: без него каждый такт отдавал бы новый
    // объект, экран перерисовывался бы, а эффект такта (он зависит от
    // состояния) перезапускался бы — опрос шёл бы со скоростью перерисовки.
    expect(boxStateFromList(placed, listOf(), BAG_KEY)).toBe(placed);
    expect(sameBoxState(placed, { kind: 'placed', uploadedAt: STORED_AT })).toBe(true);
    expect(sameBoxState(placed, { kind: 'placed', uploadedAt: STORED_AT + 1 })).toBe(false);
    expect(sameBoxState(
      { kind: 'fetched', uploadedAt: 1, fetchedAt: 2 },
      { kind: 'fetched', uploadedAt: 1, fetchedAt: 3 })).toBe(false);
  });

  it('T37: после «забрали» опрос прекращается — узнавать больше нечего', () => {
    expect(shouldPollBox({ kind: 'unknown' })).toBe(true);
    expect(shouldPollBox({ kind: 'placed', uploadedAt: STORED_AT })).toBe(true);
    expect(shouldPollBox({ kind: 'fetched', uploadedAt: 1, fetchedAt: 2 })).toBe(false);
  });
});

describe('человек узнаёт, если запись на устройстве не легла', () => {
  it('T38: отказ черновика назван строкой, а отправка остаётся успешной', () => {
    const ok = {
      ok: true as const, bagKey: BAG_KEY, uploadedAt: STORED_AT,
      draftSaved: 'saved' as const, draftMarked: 'saved' as const,
    };
    expect(draftKeepNotice(ok), 'сказали лишнее там, где всё легло').toBeNull();
    // ⚠️ ПЯТЫЙ ВОПРОС ОБСТОЯТЕЛЬСТВ: «сломается — узнает ли?». Прежде — нет.
    expect(draftKeepNotice({ ...ok, draftSaved: 'disk_unavailable' }))
      .toBe('chat.present_draft_not_saved');
    expect(draftKeepNotice({ ...ok, draftSaved: 'lock_timeout' }))
      .toBe('chat.present_draft_not_saved');
    expect(draftKeepNotice({ ...ok, draftMarked: 'not_found' }))
      .toBe('chat.present_draft_not_saved');
    // Отказ отправки — не про устройство, и второй строкой его не сопровождаем.
    expect(draftKeepNotice({ ok: false, reason: 'offline' })).toBeNull();
  });
});

describe('«не бросает» — про весь путь, а не про половину', () => {
  it('T39: сборщик бросил на чужой форме входа — вердикт с именем, а не поломка', async () => {
    // ⚠️ СЦЕНА I-5. Сборщик бросает `TypeError` на само наличие прежнего имени
    // `peerAttestation` (Задача 4) и на мусорный адрес. Голым он уводил бросок
    // мимо `doSend` (там `try/finally` без `catch`) в `void doSend()` — то есть
    // в необработанный отказ промиса: ни тоста, ни причины, окно открыто,
    // кнопка снова живая.
    const trace: Trace = { steps: [], puts: 0 };
    const v = await sendPresentation({
      ...(await realDeps({}, trace)),
      peerBoxKey: new Uint8Array(7),   // не 32 байта — сборщик бросит
    });
    expect(v).toEqual({ ok: false, reason: 'internal_error' });
    expect(trace.puts, 'мешок уехал после нашей же поломки').toBe(0);

    // Черновик бросил — тоже вердикт, и тоже ДО склада.
    _resetSendingForTest();
    const t2: Trace = { steps: [], puts: 0 };
    expect(await sendPresentation(await realDeps({
      saveDraft: async () => { throw new Error('кладовая'); },
    }, t2))).toEqual({ ok: false, reason: 'internal_error' });
    expect(t2.puts).toBe(0);

    // ⚠️ А ПОМЕТКА, БРОСИВШАЯ ПОСЛЕ УСПЕШНОГО СКЛАДА, — НЕ ОТКАЗ: мешок уже в
    // ящике, и «ничего не отправлено» было бы враньём с уверенным лицом.
    _resetSendingForTest();
    const t3: Trace = { steps: [], puts: 0 };
    const after = await sendPresentation(await realDeps({
      markSent: async () => { throw new Error('кладовая'); },
    }, t3));
    expect(after.ok, 'бросок пометки выдан за несостоявшуюся отправку').toBe(true);
    if (!after.ok) return;
    expect(t3.puts).toBe(1);
    expect(after.draftMarked).toBe('disk_unavailable');
    expect(draftKeepNotice(after)).toBe('chat.present_draft_not_saved');
  }, 180_000);
});
