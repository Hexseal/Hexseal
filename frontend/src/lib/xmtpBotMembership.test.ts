import { describe, it, expect } from 'vitest';
import { ensureBotInGroup, journalIsIncomplete } from './xmtpBotMembership';
import type { PeerIdentifier } from './xmtpDelivery';

// Бот релеера ведёт журнал переписки — доказательную базу, по которой арбитр
// решает, кому уходит эскроу. Раньше он мог молча не попасть в группу (релеер
// моргнул → `getBotAddress()` вернул null; или `canMessage` вернул не true), и
// это было НАВСЕГДА: состав группы больше нигде не пересматривался. Узнать
// можно было только при споре, когда уже поздно.

const BOT  = '0xB0T0000000000000000000000000000000000001';
const ME   = '0xMe00000000000000000000000000000000000002';
const PEER = '0xPeer000000000000000000000000000000000003';

const botId: PeerIdentifier = { identifier: BOT };
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
      return new Map<string, boolean>([[BOT, o.canMessage === true]]);
    },
  };
  return { group, client, calls };
}

describe('ensureBotInGroup', () => {
  it('бот в группе — журнал ведётся, никого не трогаем', async () => {
    const { group, client, calls } = fakes({ members: [ME, PEER, BOT] });
    expect(await ensureBotInGroup(group, client, botId)).toBe('present');
    expect(calls.canMessage).toBe(0);
    expect(calls.add).toBe(0);
  });

  it('сравнение регистронезависимое — адрес в группе может быть в любом регистре', async () => {
    const { group, client } = fakes({ members: [ME, PEER, BOT.toUpperCase()] });
    expect(await ensureBotInGroup(group, client, { identifier: BOT.toLowerCase() })).toBe('present');
  });

  it('бота нет, но он достижим — добавляем, и группа чинится', async () => {
    // Ровно тот случай, ради которого всё: группа была собрана, когда релеер
    // моргнул. Раньше это было навсегда.
    const { group, client, calls } = fakes({ members: [ME, PEER], canMessage: true });
    expect(await ensureBotInGroup(group, client, botId)).toBe('added');
    expect(calls.add).toBe(1);
    expect(calls.sync).toBe(1);
  });

  it('провал sync после добавления членства не отменяет', async () => {
    const { group, client } = fakes({ members: [ME, PEER], canMessage: true, syncThrows: true });
    expect(await ensureBotInGroup(group, client, botId)).toBe('added');
  });

  it('бота нет и он недостижим — missing, и об этом надо сказать', async () => {
    const { group, client, calls } = fakes({ members: [ME, PEER], canMessage: false });
    const state = await ensureBotInGroup(group, client, botId);
    expect(state).toBe('missing');
    expect(calls.add).toBe(0);
    expect(journalIsIncomplete(state)).toBe(true);
  });

  it('добавление упало — тоже missing: журнал прямо сейчас не ведётся', async () => {
    const { group, client } = fakes({ members: [ME, PEER], canMessage: true, addThrows: true });
    expect(await ensureBotInGroup(group, client, botId)).toBe('missing');
  });

  it('canMessage упал при отсутствующем боте — missing, а не unknown', async () => {
    const { group, client } = fakes({ members: [ME, PEER], canMessageThrows: true });
    expect(await ensureBotInGroup(group, client, botId)).toBe('missing');
  });

  it('адрес бота неизвестен — unknown, а не «бота нет»', async () => {
    // Релеер не ответил за три секунды: `getBotAddress()` вернул null.
    // Сравнивать не с чем — обвинять группу не в чем.
    const { group, client, calls } = fakes({ members: [ME, PEER] });
    const state = await ensureBotInGroup(group, client, null);
    expect(state).toBe('unknown');
    expect(calls.canMessage).toBe(0);
    expect(journalIsIncomplete(state)).toBe(false);
  });

  it('состав не прочитался — unknown: доказательств, что журнала нет, у нас тоже нет', async () => {
    const { group, client } = fakes({ membersThrows: true });
    const state = await ensureBotInGroup(group, client, botId);
    expect(state).toBe('unknown');
    expect(journalIsIncomplete(state)).toBe(false);
  });
});

describe('journalIsIncomplete', () => {
  it('предупреждает только на missing', () => {
    expect(journalIsIncomplete('missing')).toBe(true);
    expect(journalIsIncomplete('present')).toBe(false);
    expect(journalIsIncomplete('added')).toBe(false);
    expect(journalIsIncomplete('unknown')).toBe(false);
  });
});
