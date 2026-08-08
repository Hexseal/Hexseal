/**
 * staleStorage.test.ts — что можно выбросить из хранилища, а что нельзя.
 *
 * Два случая, и они РАЗНЫЕ по цене ошибки:
 *
 *  1. мусор снесённого мессенджера (`hexseal-xmtp-crumb*`) — его никто не
 *     читает с 6 августа, выбрасывается сам, без спроса;
 *  2. записи сеанса кошелька (`wc@2:*`) — выбрасываются ТОЛЬКО по нажатию
 *     человека «переподключить кошелёк». Снести их без спроса значило бы
 *     отключить работающее подключение у того, у кого всё в порядке.
 *
 * ⚠️ ГЛАВНЫЙ ЗАМОК ЗДЕСЬ — ТРЕТИЙ: ни один отбор не смеет тронуть НАШИ ключи.
 * В хранилище лежат ключ переписки, пропуск склада и метки прочтения; ошибка
 * в шаблоне здесь стоит человеку переписки, а не удобства.
 */
import { describe, it, expect } from 'vitest';
import { staleLegacyKeys, walletSessionKeys, dropKeys } from '@/lib/staleStorage';

/** Хранилище, каким его видит браузер: список ключей плюс удаление. */
function fakeStorage(keys: string[]): { keys: string[]; removeItem: (k: string) => void; key: (i: number) => string | null; length: number } {
  const store = {
    keys: [...keys],
    removeItem(k: string) { store.keys = store.keys.filter(x => x !== k); },
    key(i: number) { return store.keys[i] ?? null; },
    get length() { return store.keys.length; },
  };
  return store as never;
}

const OURS = [
  'hexseal-chat',
  'hexseal_bagpass_0xa1ce',
  'hexseal_chat_seen_0xa1ce:0xb0b1',
  'hexseal-reload-for-build',
  'hexseal-wallet-crumb',
  'hexseal_bagreads_0xa1ce',
];

describe('мусор снесённого мессенджера', () => {
  it('крошки XMTP отобраны, и только они', () => {
    const all = [...OURS, 'hexseal-xmtp-crumb', 'hexseal-xmtp-crumb-prev', 'wc@2:client:0.3:session'];
    expect(staleLegacyKeys(all).sort()).toEqual(['hexseal-xmtp-crumb', 'hexseal-xmtp-crumb-prev']);
  });

  it('НАШИ ключи не тронуты ни одним отбором', () => {
    for (const key of OURS) {
      expect(staleLegacyKeys([key]), `отбор мусора забрал наш ключ ${key}`).toEqual([]);
      expect(walletSessionKeys([key]), `отбор сеанса кошелька забрал наш ключ ${key}`).toEqual([]);
    }
  });
});

describe('записи сеанса кошелька', () => {
  it('отобраны записи WalletConnect, и только они', () => {
    const all = [
      ...OURS,
      'wc@2:client:0.3:session',
      'wc@2:core:0.3:history',
      'wc@2:core:0.3:messages',
      'walletconnect',
      'WALLETCONNECT_DEEPLINK_CHOICE',
      'wagmi.store',
    ];
    expect(walletSessionKeys(all).sort()).toEqual([
      'WALLETCONNECT_DEEPLINK_CHOICE',
      'walletconnect',
      'wc@2:client:0.3:session',
      'wc@2:core:0.3:history',
      'wc@2:core:0.3:messages',
    ].sort());
  });

  it('запись самой wagmi НЕ трогается — её ведёт библиотека', () => {
    // Наше дело — протухшие записи сеанса, а не состояние библиотеки. Снеся
    // `wagmi.store`, мы полезли бы чинить библиотеку своими руками — это прямо
    // запрещено заданием.
    expect(walletSessionKeys(['wagmi.store', 'wagmi.recentConnectorId'])).toEqual([]);
  });
});

describe('удаление', () => {
  it('удаляет ровно отобранное и возвращает число', () => {
    const st = fakeStorage([...OURS, 'hexseal-xmtp-crumb', 'hexseal-xmtp-crumb-prev']);
    const dropped = dropKeys(st as never, ['hexseal-xmtp-crumb', 'hexseal-xmtp-crumb-prev']);
    expect(dropped).toBe(2);
    expect(st.keys.sort()).toEqual([...OURS].sort());
  });

  it('хранилище бросает на удалении — считаем удалённое, не падаем', () => {
    // Приватный режим и запреты третьих сторон умеют бросать на любом
    // обращении. Уборка мусора не имеет права ронять страницу.
    const st = {
      length: 1,
      key: () => 'hexseal-xmtp-crumb',
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(() => dropKeys(st as never, ['hexseal-xmtp-crumb'])).not.toThrow();
    expect(dropKeys(st as never, ['hexseal-xmtp-crumb'])).toBe(0);
  });

  it('нет хранилища вовсе — ноль, без падения', () => {
    expect(dropKeys(null, ['что-нибудь'])).toBe(0);
  });
});
