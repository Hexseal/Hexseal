import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isPushRegistrationStale, isPushRegisteredForAddress, subscriptionMatchesVapidKey,
} from './webpush';

const ADDR = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
const REG_KEY      = `hexseal-push-reg-${ADDR.toLowerCase()}`;
const DISABLED_KEY = `hexseal-push-disabled-${ADDR.toLowerCase()}`;
const DAY = 24 * 60 * 60 * 1000;

/** Минимальный localStorage — среда тестов node, окна нет. */
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

const g = globalThis as unknown as { localStorage?: unknown };
let saved: unknown;

beforeEach(() => {
  saved = g.localStorage;
  g.localStorage = fakeStorage();
});
afterEach(() => {
  if (saved === undefined) delete g.localStorage;
  else g.localStorage = saved;
});

const store = () => g.localStorage as ReturnType<typeof fakeStorage>;

describe('isPushRegistrationStale', () => {
  it('свежая регистрация протухшей не считается', () => {
    store().setItem(REG_KEY, String(Date.now()));
    expect(isPushRegistrationStale(ADDR)).toBe(false);
  });

  it('регистрация старше суток считается протухшей', () => {
    // Ровно тот порог, по которому раньше срабатывала фоновая перерегистрация
    // — и раз в сутки сама выбрасывала человека в кошелёк за подписью. Теперь
    // тот же порог только ПОКАЗЫВАЕТ состояние.
    store().setItem(REG_KEY, String(Date.now() - DAY - 1000));
    expect(isPushRegistrationStale(ADDR)).toBe(true);
  });

  it('«ни разу не регистрировались» — это не «протухло»', () => {
    // Иначе человек, который пуши никогда не включал, видел бы предложение
    // «включи заново» на пустом месте.
    expect(isPushRegistrationStale(ADDR)).toBe(false);
  });

  it('явно выключенные пуши протухшими не считаются', () => {
    // Здесь нечему протухать: человек сказал «нет». Показывать ему баннер
    // «включи заново» — это ровно тот навязчивый путь, от которого уходим.
    store().setItem(REG_KEY, String(Date.now() - DAY * 10));
    store().setItem(DISABLED_KEY, '1');
    expect(isPushRegistrationStale(ADDR)).toBe(false);
  });

  it('адрес нечувствителен к регистру', () => {
    store().setItem(REG_KEY, String(Date.now() - DAY - 1000));
    expect(isPushRegistrationStale(ADDR.toLowerCase())).toBe(true);
    expect(isPushRegistrationStale(ADDR.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('без localStorage не пугает наугад', () => {
    delete g.localStorage;
    expect(isPushRegistrationStale(ADDR)).toBe(false);
  });
});

describe('isPushRegisteredForAddress', () => {
  it('true только при записанной регистрации без явного отказа', () => {
    expect(isPushRegisteredForAddress(ADDR)).toBe(false);
    store().setItem(REG_KEY, String(Date.now()));
    expect(isPushRegisteredForAddress(ADDR)).toBe(true);
    store().setItem(DISABLED_KEY, '1');
    expect(isPushRegisteredForAddress(ADDR)).toBe(false);
  });

  it('протухшая регистрация всё ещё числится включённой', () => {
    // Иначе строка «пуши включены» просто исчезала бы через сутки, и человеку
    // нечего было бы нажать: `subscribed` остаётся true, а рядом поднимается
    // `stale` — вместе они и дают видимое «могло сломаться, включи заново».
    store().setItem(REG_KEY, String(Date.now() - DAY * 3));
    expect(isPushRegisteredForAddress(ADDR)).toBe(true);
    expect(isPushRegistrationStale(ADDR)).toBe(true);
  });
});

// ─── Ключ VAPID ───────────────────────────────────────────────────────────────

/** Ключ в том виде, в каком его хранит браузер: сырые байты в options. */
const subWithKey = (bytes: number[]) => ({
  options: { applicationServerKey: new Uint8Array(bytes).buffer },
});

/** base64url тех же байтов — в таком виде ключ приходит из окружения. */
const b64url = (bytes: number[]) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('subscriptionMatchesVapidKey', () => {
  const KEY = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('подписка, созданная этим же ключом, годится', () => {
    expect(subscriptionMatchesVapidKey(subWithKey(KEY), b64url(KEY))).toBe(true);
  });

  it('ключ сменили — подписка мертва, хотя браузер её отдаёт', () => {
    // Подписка криптографически привязана к ключу, которым создана, и браузер
    // НЕ выбрасывает её при ротации серверного ключа. Каждая отправка при этом
    // отваливается 403 VapidPkHashMismatch, а интерфейс без этой проверки
    // показывает «уведомления включены».
    expect(subscriptionMatchesVapidKey(subWithKey(KEY), b64url([9, 9, 9]))).toBe(false);
  });

  it('совпадение по длине без совпадения по байтам не считается', () => {
    const other = [...KEY.slice(0, -1), 99];
    expect(subscriptionMatchesVapidKey(subWithKey(KEY), b64url(other))).toBe(false);
  });

  it('пустой ключ окружения — «сверять не с чем», а не «подходит всё»', () => {
    expect(subscriptionMatchesVapidKey(subWithKey(KEY), '')).toBe(false);
  });

  it('подписки нет или у неё нет ключа — false', () => {
    expect(subscriptionMatchesVapidKey(null, b64url(KEY))).toBe(false);
    expect(subscriptionMatchesVapidKey(undefined, b64url(KEY))).toBe(false);
    expect(subscriptionMatchesVapidKey({}, b64url(KEY))).toBe(false);
    expect(subscriptionMatchesVapidKey({ options: {} }, b64url(KEY))).toBe(false);
    expect(subscriptionMatchesVapidKey({ options: { applicationServerKey: null } }, b64url(KEY))).toBe(false);
  });

  it('битый base64 не роняет проверку', () => {
    // Переменную окружения правит человек, и опечатка в ней не должна
    // превращаться в исключение посреди чтения состояния подписки.
    expect(subscriptionMatchesVapidKey(subWithKey(KEY), '!!!не-base64!!!')).toBe(false);
  });
});
