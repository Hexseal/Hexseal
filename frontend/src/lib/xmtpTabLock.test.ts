import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireXmtpTabLock,
  waitForXmtpTabLock,
  releaseXmtpTabLock,
  dropXmtpTabLock,
  isXmtpTabLockHeld,
  _resetXmtpTabLocksForTest,
  type LockManagerLike,
} from './xmtpTabLock';

const ADDR = '0xAAaAAaAAAAAAAaaaAAAaAaaAAAaAAAAaaAAAAAaa';
const NAME = `hexseal-xmtp-${ADDR.toLowerCase()}`;

type Waiter = {
  callback: (lock: unknown | null) => Promise<void> | void;
  resolve: () => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/** Подделка Web Locks с теми свойствами, ради которых он тут и выбран:
 *  один держатель на имя, очередь ожидающих, отмена по сигналу и —
 *  главное — автоматическая передача лока следующему, когда держатель исчез. */
class FakeLockManager implements LockManagerLike {
  held = new Set<string>();
  waiters = new Map<string, Waiter[]>();
  requests = 0;

  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => Promise<void> | void,
  ): Promise<unknown> {
    this.requests++;
    if (this.held.has(name)) {
      if (options.ifAvailable) return Promise.resolve(callback(null)).then(() => undefined);
      return new Promise<void>((resolve, reject) => {
        const w: Waiter = { callback, resolve, reject, signal: options.signal };
        if (options.signal) {
          w.onAbort = () => {
            const list = this.waiters.get(name) ?? [];
            const i = list.indexOf(w);
            if (i >= 0) list.splice(i, 1);
            reject(new Error('AbortError'));
          };
          options.signal.addEventListener('abort', w.onAbort);
        }
        this.waiters.set(name, [...(this.waiters.get(name) ?? []), w]);
      });
    }
    return this.grant(name, callback);
  }

  private grant(name: string, callback: (lock: unknown | null) => Promise<void> | void): Promise<unknown> {
    this.held.add(name);
    return Promise.resolve(callback({ name })).then(() => {
      this.held.delete(name);
      this.pump(name);
    });
  }

  private pump(name: string): void {
    const w = (this.waiters.get(name) ?? []).shift();
    if (!w) return;
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
    void this.grant(name, w.callback).then(() => w.resolve(), w.reject);
  }

  /** Имитация ДРУГОЙ вкладки, держащей лок. Возвращает её «закрытие». */
  occupy(name: string): () => void {
    let release!: () => void;
    void this.grant(name, () => new Promise<void>(r => { release = r; }));
    return release;
  }
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

beforeEach(() => { _resetXmtpTabLocksForTest(); });

describe('acquireXmtpTabLock', () => {
  it('свободный лок берётся', async () => {
    const m = new FakeLockManager();
    expect(await acquireXmtpTabLock(ADDR, m)).toBe('acquired');
    expect(isXmtpTabLockHeld(ADDR)).toBe(true);
  });

  it('повторный вызов не ходит в браузер — иначе вкладка сообщит «занято» сама себе', async () => {
    const m = new FakeLockManager();
    await acquireXmtpTabLock(ADDR, m);
    expect(await acquireXmtpTabLock(ADDR, m)).toBe('acquired');
    expect(m.requests).toBe(1);
  });

  it('держит другая вкладка — busy, и мы НЕ становимся держателем', async () => {
    // Смысл всей затеи: не поднимать второго клиента поверх занятого OPFS.
    const m = new FakeLockManager();
    m.occupy(NAME);
    expect(await acquireXmtpTabLock(ADDR, m)).toBe('busy');
    expect(isXmtpTabLockHeld(ADDR)).toBe(false);
  });

  it('браузер без Web Locks — мягкая деградация, а не отказ мессенджера', async () => {
    expect(await acquireXmtpTabLock(ADDR, null)).toBe('unsupported');
    expect(isXmtpTabLockHeld(ADDR)).toBe(false);
  });

  it('менеджер бросает — тоже деградация, а не поломка', async () => {
    const broken: LockManagerLike = { request: () => { throw new Error('nope'); } };
    expect(await acquireXmtpTabLock(ADDR, broken)).toBe('unsupported');
  });

  it('регистр адреса не заводит второй лок', async () => {
    const m = new FakeLockManager();
    await acquireXmtpTabLock(ADDR.toLowerCase(), m);
    expect(isXmtpTabLockHeld(ADDR.toUpperCase())).toBe(true);
  });
});

describe('releaseXmtpTabLock', () => {
  it('отпущенный лок достаётся следующему', async () => {
    const m = new FakeLockManager();
    await acquireXmtpTabLock(ADDR, m);
    releaseXmtpTabLock(ADDR);
    await tick();
    expect(m.held.has(NAME)).toBe(false);
    expect(isXmtpTabLockHeld(ADDR)).toBe(false);
  });

  it('отпускать невзятое безопасно', () => {
    expect(() => releaseXmtpTabLock(ADDR)).not.toThrow();
  });
});

describe('dropXmtpTabLock', () => {
  it('отпускает взятый лок', async () => {
    const m = new FakeLockManager();
    await acquireXmtpTabLock(ADDR, m);
    dropXmtpTabLock(ADDR);
    await tick();
    expect(isXmtpTabLockHeld(ADDR)).toBe(false);
    expect(m.held.has(NAME)).toBe(false);
  });

  it('НЕ вычёркивает вкладку из очереди', async () => {
    // Сдавшаяся попытка обязана вернуть хранилище, но не отменять ожидание:
    // именно отказ «занято» и поставил вкладку в очередь, а его собственный
    // finally пробегает сразу следом. Сняв очередь, вкладка осталась бы с
    // надписью «занято» и без единого шанса узнать, что уже свободно.
    const m = new FakeLockManager();
    const closeOtherTab = m.occupy(NAME);
    let woke = 0;
    waitForXmtpTabLock(ADDR, () => { woke++; }, m);
    await tick();

    dropXmtpTabLock(ADDR);   // попытка сдалась
    await tick();
    closeOtherTab();
    await tick();

    expect(woke).toBe(1);
    expect(isXmtpTabLockHeld(ADDR)).toBe(true);
  });
});

describe('waitForXmtpTabLock', () => {
  it('закрыли вкладку-держателя — ожидающая подхватывает лок сама', async () => {
    // Ровно тот тупик, который нельзя допустить: «первая закрыта, вторая всё
    // ещё пишет, что занято, и ничего не делает».
    const m = new FakeLockManager();
    const closeOtherTab = m.occupy(NAME);
    expect(await acquireXmtpTabLock(ADDR, m)).toBe('busy');

    let woke = 0;
    waitForXmtpTabLock(ADDR, () => { woke++; }, m);
    await tick();
    expect(woke).toBe(0);

    closeOtherTab();
    await tick();
    expect(woke).toBe(1);
    expect(isXmtpTabLockHeld(ADDR)).toBe(true);
  });

  it('ожидание не встаёт в очередь дважды', async () => {
    const m = new FakeLockManager();
    m.occupy(NAME);
    await acquireXmtpTabLock(ADDR, m);
    const before = m.requests;
    waitForXmtpTabLock(ADDR, () => {}, m);
    waitForXmtpTabLock(ADDR, () => {}, m);
    expect(m.requests).toBe(before + 1);
  });

  it('выключили мессенджер — ожидание снимается и лок не перехватывается', async () => {
    const m = new FakeLockManager();
    const closeOtherTab = m.occupy(NAME);
    let woke = 0;
    waitForXmtpTabLock(ADDR, () => { woke++; }, m);
    await tick();

    releaseXmtpTabLock(ADDR);   // человек выключил мессенджер, не дождавшись
    await tick();
    closeOtherTab();
    await tick();

    expect(woke).toBe(0);
    expect(isXmtpTabLockHeld(ADDR)).toBe(false);
  });

  it('лок уже наш — ждать нечего', () => {
    const m = new FakeLockManager();
    void acquireXmtpTabLock(ADDR, m);
    const before = m.requests;
    waitForXmtpTabLock(ADDR, () => {}, m);
    expect(m.requests).toBe(before);
  });

  it('без Web Locks ожидание — пустышка, а не исключение', () => {
    expect(() => waitForXmtpTabLock(ADDR, () => {}, null)).not.toThrow();
  });
});
