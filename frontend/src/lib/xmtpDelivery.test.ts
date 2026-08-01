import { describe, it, expect } from 'vitest';
import {
  ensurePeerInGroup,
  blocksDelivery,
  PEER_UNREACHABLE_MESSAGE,
  type PeerIdentifier,
} from './xmtpDelivery';

const PEER = '0xPeer000000000000000000000000000000000001';
const ME   = '0xMe00000000000000000000000000000000000002';

const peerId: PeerIdentifier = { identifier: PEER };

/** Участник группы в том виде, в каком его отдаёт browser-sdk. */
const member = (addr: string) => ({ accountIdentifiers: [{ identifier: addr }] });

interface FakeOpts {
  members?: string[];
  membersThrows?: boolean;
  canMessage?: boolean;
  canMessageThrows?: boolean;
  addThrows?: boolean;
  syncThrows?: boolean;
}

function fakes(o: FakeOpts) {
  const calls = { canMessage: 0, add: 0, sync: 0 };
  const group = {
    members: async () => {
      if (o.membersThrows) throw new Error('SecretReuseError');
      return (o.members ?? []).map(member);
    },
    addMembersByIdentifiers: async () => {
      calls.add++;
      if (o.addThrows) throw new Error('add failed');
    },
    sync: async () => {
      calls.sync++;
      if (o.syncThrows) throw new Error('sync failed');
    },
  };
  const client = {
    canMessage: async () => {
      calls.canMessage++;
      if (o.canMessageThrows) throw new Error('network down');
      return new Map<string, boolean>([[PEER, o.canMessage === true]]);
    },
  };
  return { group, client, calls };
}

describe('ensurePeerInGroup', () => {
  it('собеседник в группе — ничего не трогаем', async () => {
    const { group, client, calls } = fakes({ members: [ME, PEER] });
    expect(await ensurePeerInGroup(group, client, peerId)).toBe('present');
    // Лишний canMessage — это сетевой запрос на КАЖДУЮ отправку сообщения.
    expect(calls.canMessage).toBe(0);
    expect(calls.add).toBe(0);
  });

  it('регистр адреса роли не играет', async () => {
    // viem отдаёт checksum-адрес, XMTP — свой; без нормализации собственный
    // собеседник выглядел бы отсутствующим и каждая отправка ходила бы в сеть.
    const { group, client } = fakes({ members: [ME, PEER.toUpperCase()] });
    expect(await ensurePeerInGroup(group, client, { identifier: PEER.toLowerCase() })).toBe('present');
  });

  it('нет в группе, но достижим — добавляем и синхронизируем', async () => {
    // Ровно ради этого самопочинка и написана: собеседника не было ни одной
    // живой установки в момент создания группы, теперь он вернулся.
    const { group, client, calls } = fakes({ members: [ME], canMessage: true });
    expect(await ensurePeerInGroup(group, client, peerId)).toBe('added');
    expect(calls.add).toBe(1);
    expect(calls.sync).toBe(1);
  });

  it('нет в группе и недостижим — отправлять нельзя', async () => {
    // Тот самый случай, который раньше молчал: `if (canMsg === true)` без
    // `else`. Группа возвращалась без собеседника, отправка выглядела
    // успешной, получатель не видел сообщение никогда.
    const { group, client, calls } = fakes({ members: [ME], canMessage: false });
    const state = await ensurePeerInGroup(group, client, peerId);
    expect(state).toBe('unreachable');
    expect(blocksDelivery(state)).toBe(true);
    expect(calls.add).toBe(0);
  });

  it('проба достижимости упала — всё равно нельзя', async () => {
    // Знание о том, ПОЧЕМУ не вышло добавить, ничего не меняет: на момент
    // отправки собеседник не член группы, сообщение до него не дойдёт.
    const { group, client } = fakes({ members: [ME], canMessageThrows: true });
    expect(await ensurePeerInGroup(group, client, peerId)).toBe('unreachable');
  });

  it('добавление не удалось — тоже нельзя', async () => {
    const { group, client } = fakes({ members: [ME], canMessage: true, addThrows: true });
    expect(await ensurePeerInGroup(group, client, peerId)).toBe('unreachable');
  });

  it('добавили, но синхронизация упала — отправлять можно', async () => {
    // Членство уже изменено; синхронизация — удобство, а не условие доставки.
    const { group, client } = fakes({ members: [ME], canMessage: true, syncThrows: true });
    const state = await ensurePeerInGroup(group, client, peerId);
    expect(state).toBe('added');
    expect(blocksDelivery(state)).toBe(false);
  });

  it('состав группы не прочитался — отправку НЕ запрещаем', async () => {
    // Локальная база MLS умеет бросать на порченой churn'ом группе
    // (SecretReuseError) — соседний код это специально глушит. Запрет по такому
    // чтению завёл бы вторую поломку зеркально первой: сообщение не уходит там,
    // где прекрасно дошло бы.
    const { group, client, calls } = fakes({ membersThrows: true });
    const state = await ensurePeerInGroup(group, client, peerId);
    expect(state).toBe('unknown');
    expect(blocksDelivery(state)).toBe(false);
    expect(calls.add).toBe(0);
  });

  it('пустая группа — это отсутствие собеседника, а не «неизвестно»', async () => {
    const { group, client } = fakes({ members: [], canMessage: false });
    expect(await ensurePeerInGroup(group, client, peerId)).toBe('unreachable');
  });
});

describe('PEER_UNREACHABLE_MESSAGE', () => {
  it('содержит подстроку, по которой её узнаёт интерфейс', () => {
    // ChatPanel матчит `msg.includes('not registered')`, чтобы показать
    // объяснение со ссылкой-приглашением вместо общего «ошибка соединения».
    // Потеря этих двух слов не сломает ни один тип — только текст на экране.
    expect(PEER_UNREACHABLE_MESSAGE).toContain('not registered');
  });
});
