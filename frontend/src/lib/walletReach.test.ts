/**
 * walletReach.test.ts — «кошелёк не отвечает» опознано и названо.
 *
 * ─── ЖУРНАЛ ЖИВОГО ТЕЛЕФОНА (Redmi по кабелю, 9 августа), дословно ──────────
 *
 *     Error: No matching key. history: 1785667754733574
 *     Error: emitting session_request:1785667434298616 without any listeners
 *     Error: Invalid Id
 *
 * Записи сеанса WalletConnect протухли: запросы на подпись доставить НЕКОМУ.
 * Владелец: «на рэдми вообще все колом стоит, ничего не меняется».
 *
 * Что показывал наш чат: подпись отказывала ошибкой, которую мы не опознаём, —
 * `openSession` падал, код отказа не наш, и человек получал общий экран
 * «Переписка не открылась» с кнопкой «повторить», которая будет отказывать
 * ВЕЧНО, потому что чинить надо не переписку, а подключение.
 *
 * ⚠️ ЭТО ШИРЕ ЧАТА: так же сломается любая подпись в приложении, включая
 * сделки. Поэтому наблюдение стоит на общем мьютексе кошелька
 * (`lib/walletLock.ts`), через который проходят ВСЕ семь мест, где приложение
 * открывает окно кошелька, — а не в чате.
 *
 * ⚠️ ЧЕГО ЗДЕСЬ НЕТ НАРОЧНО. Мы не лезем в саму библиотеку кошельков и не
 * чиним её сеансы своими руками. Наше дело — опознать, сказать и предложить
 * переподключиться.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isWalletUnreachableError, reachVerdict, walletReach,
  subscribeWalletReach, _resetWalletReachForTest,
  WALLET_QUIET_AFTER_MS,
} from '@/lib/walletReach';
import { withWalletLock, _resetWalletLockForTest } from '@/lib/walletLock';

const ALICE = '0xa1ce00000000000000000000000000000000cafe';

beforeEach(() => {
  _resetWalletReachForTest();
  _resetWalletLockForTest?.();
  vi.stubGlobal('document', { visibilityState: 'visible' });
});

afterEach(() => { vi.unstubAllGlobals(); });

/* ═══════════ 1. опознать: чем протухший сеанс отличим от отказа ════════════ */

describe('ошибки протухшего сеанса опознаются', () => {
  it.each([
    ['No matching key. history: 1785667754733574'],
    ['Invalid Id'],
    ['emitting session_request:1785667434298616 without any listeners'],
    ['No matching key. session topic doesn\'t exist: abc'],
    ['Missing or invalid. Record was recently deleted - session: abc'],
  ])('«%s» — это «доставить некому»', (message) => {
    expect(isWalletUnreachableError(new Error(message))).toBe(true);
  });

  it.each([
    ['User rejected the request'],
    ['User denied message signature'],
    ['Signature not valid'],
    ['Failed to fetch'],
    ['Request expired. Please try again.'],
  ])('«%s» — НЕ это (иначе отказ человека лечили бы переподключением)', (message) => {
    // Замок, который горит всегда, — не замок. Отказ человека и обрыв сети
    // переподключением не лечатся, и предлагать его там значило бы сбить с
    // толку того, у кого всё работает.
    expect(isWalletUnreachableError(new Error(message))).toBe(false);
  });

  it('причина лежит в глубине цепочки — всё равно опознаётся', () => {
    // viem и wagmi заворачивают ошибку провайдера в свою, а WalletConnect — в
    // свою: настоящая причина часто на два-три уровня вглубь.
    const deep = new Error('Signature request failed', {
      cause: new Error('provider error', { cause: new Error('No matching key. history: 1') }),
    });
    expect(isWalletUnreachableError(deep)).toBe(true);
  });
});

/* ═══════════ 2. вердикт: правило, а не догадка ═════════════════════════════ */

describe('вердикт о достижимости кошелька', () => {
  const base = { askedAt: null as number | null, answered: true, brokenSeen: false, hiddenNow: false, now: 1_000_000 };

  it('всё в порядке — молчим', () => {
    expect(reachVerdict(base)).toBe('ok');
  });

  it('окно кошелька открыто пару секунд — молчим', () => {
    expect(reachVerdict({ ...base, askedAt: 1_000_000 - 3_000, answered: false })).toBe('ok');
  });

  it('видели ошибку протухшего сеанса — говорим сразу, не ждём', () => {
    expect(reachVerdict({ ...base, brokenSeen: true })).toBe('broken');
  });

  it('ответа нет долго, а страница на экране — «кошелёк молчит»', () => {
    expect(reachVerdict({
      ...base, askedAt: 1_000_000 - WALLET_QUIET_AFTER_MS - 1, answered: false,
    })).toBe('quiet');
  });

  it('страница СКРЫТА — молчим, человек в приложении кошелька', () => {
    // Пока страница скрыта, человек как раз подтверждает подпись в кошельке, и
    // «кошелёк не отвечает» было бы враньём. Заодно показывать некому.
    expect(reachVerdict({
      ...base, askedAt: 1_000_000 - WALLET_QUIET_AFTER_MS - 1, answered: false, hiddenNow: true,
    })).toBe('ok');
  });

  it('ждём меньше порога — молчим (порог щедрый нарочно)', () => {
    // ⚠️ Порог щедрый потому, что своя починка не должна оказаться хуже
    // дефекта: 8 августа ожидание кнопки уже считалось неудачей входа и
    // убивало чат за 15 секунд — быстрее исходной беды.
    expect(reachVerdict({
      ...base, askedAt: 1_000_000 - (WALLET_QUIET_AFTER_MS - 1), answered: false,
    })).toBe('ok');
  });
});

/* ═══════════ 3. наблюдение стоит на настоящем мьютексе кошелька ════════════ */

describe('замер через НАСТОЯЩИЙ мьютекс кошелька', () => {
  it('подпись отказала протухшим сеансом — состояние «broken»', async () => {
    await expect(withWalletLock(ALICE, async () => {
      throw new Error('No matching key. history: 1785667754733574');
    })).rejects.toThrow(/No matching key/);
    expect(walletReach(), 'протухший сеанс не опознан на настоящем пути подписи').toBe('broken');
  });

  it('человек отказался подписать — состояние остаётся «ok»', async () => {
    await expect(withWalletLock(ALICE, async () => {
      throw new Error('User rejected the request');
    })).rejects.toThrow(/User rejected/);
    expect(walletReach()).toBe('ok');
  });

  it('подпись прошла — состояние «ok», и прежний диагноз снят', async () => {
    await expect(withWalletLock(ALICE, async () => {
      throw new Error('Invalid Id');
    })).rejects.toThrow();
    expect(walletReach()).toBe('broken');
    // Переподключились, подпись прошла — приговор обязан сняться сам, иначе
    // надпись «кошелёк не отвечает» осталась бы на экране навсегда.
    await withWalletLock(ALICE, async () => 'ok');
    expect(walletReach(), 'диагноз не снимается успехом').toBe('ok');
  });

  it('окно кошелька висит дольше порога — «quiet», и подпись НЕ отменена', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      let release: (() => void) | null = null;
      const pending = withWalletLock(ALICE, () => new Promise<string>(r => { release = () => r('подписано'); }));
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(walletReach()).toBe('ok');
      vi.setSystemTime(1_000_000 + WALLET_QUIET_AFTER_MS + 1);
      expect(walletReach(), 'долгое молчание кошелька не названо').toBe('quiet');
      // ⚠️ САМОЕ ВАЖНОЕ ЗДЕСЬ: подпись жива. Мы только СКАЗАЛИ.
      release?.();
      await expect(pending).resolves.toBe('подписано');
      expect(walletReach(), 'ответ кошелька не снял надпись').toBe('ok');
    } finally { vi.useRealTimers(); }
  });

  it('изменение состояния доходит до экрана (подписка)', async () => {
    let told = 0;
    const stop = subscribeWalletReach(() => { told++; });
    try {
      await expect(withWalletLock(ALICE, async () => {
        throw new Error('No matching key. history: 7');
      })).rejects.toThrow();
      expect(told, 'экран не узнает о том, что кошелёк недостижим').toBeGreaterThan(0);
    } finally { stop(); }
  });
});
