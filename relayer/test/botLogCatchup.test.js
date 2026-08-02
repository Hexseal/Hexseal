import { describe, it, expect, beforeEach } from 'vitest';
import {
  watchPairGroup,
  rescanPairGroups,
  resetWatchRegistry,
  createPairLogger,
  readGroupHistory,
  pairIdFromGroupName,
  createMemberResolver,
  HISTORY_PAGE_SIZE,
} from '../botLog.js';
import { readLog, appendLogEntry } from '../app.js';

// Журнал спора — доказательная база для решения о деньгах: арбитр читает его и
// решает, кому уходит эскроу. Пока бот жил только на живом потоке, в журнал не
// попадало первое сообщение переписки (бот в этот момент ещё подхватывал
// группу) и всё, что писали во время перезапуска релеера. Дыры были при этом
// невидимы — журнал выглядел целым.
//
// Эти тесты краснеют, если дочитывание истории убрать.

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

let pairSeq = 0;
/** Своя пара на каждый тест — журналы лежат в общем каталоге на процесс. */
function freshPair() {
  pairSeq++;
  const hex = pairSeq.toString(16).padStart(4, '0');
  const a = '0x' + 'a'.repeat(36) + hex;
  const b = '0x' + 'b'.repeat(36) + hex;
  return { pairId: `${a}-${b}`, name: `HSEAL-PAIR-${a}-${b}` };
}

let msgSeq = 0;
function message({ text, from = A, at, id }) {
  msgSeq++;
  return {
    id: id ?? `msg-${msgSeq}`,
    content: text,
    senderInboxId: `inbox-${from}`,
    sentAt: new Date(at),
    sentAtNs: BigInt(at) * 1_000_000n,
  };
}

/** Управляемый асинхронный поток: `push()` отдаёт сообщение подписчику. */
function controllableStream() {
  const queue = [];
  const waiters = [];
  let closed = false;
  return {
    push(msg) {
      const w = waiters.shift();
      if (w) w({ value: msg, done: false });
      else queue.push(msg);
    },
    close() {
      closed = true;
      const w = waiters.shift();
      if (w) w({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise(resolve => waiters.push(resolve));
        },
        return() { closed = true; return Promise.resolve({ value: undefined, done: true }); },
      };
    },
  };
}

let groupSeq = 0;
function fakeGroup({ name, history = [], stream = null, membersOf = { [A]: A, [B]: B }, historyThrows = false }) {
  groupSeq++;
  const calls = { messages: 0, members: 0, sync: 0 };
  return {
    id: `group-${groupSeq}`,
    name,
    calls,
    async sync() { calls.sync++; },
    async members() {
      calls.members++;
      return Object.entries(membersOf).map(([addr]) => ({
        inboxId: `inbox-${addr}`,
        accountIdentifiers: [{ identifier: addr }],
      }));
    },
    async messages(opts = {}) {
      calls.messages++;
      if (historyThrows) throw new Error('SecretReuseError');
      const after = opts.sentAfterNs ?? null;
      const filtered = history
        .filter(m => after === null || m.sentAtNs > after)
        .sort((x, y) => (x.sentAtNs < y.sentAtNs ? -1 : 1));
      return filtered.slice(0, opts.limit ?? HISTORY_PAGE_SIZE);
    },
    async stream() {
      if (stream === null) throw new Error('no stream');
      return stream;
    },
  };
}

const texts = entries => entries.map(e => e.text);

beforeEach(() => { resetWatchRegistry(); });

describe('дочитывание истории при подхвате группы', () => {
  it('записывает ПЕРВОЕ сообщение переписки, которого поток уже не отдаст', async () => {
    // Ровно наблюдение с живого сервера: группа создана, бриф ушёл почти сразу,
    // бот в этот момент ещё подхватывал группу. Поток отдаёт только второе.
    const { pairId, name } = freshPair();
    const brief = message({ text: 'Бриф: нужен лендинг на next.js', at: 1000 });
    const stream = controllableStream();
    const group = fakeGroup({ name, history: [brief], stream });

    const res = await watchPairGroup(group);
    expect(res.pairId).toBe(pairId);
    expect(res.caughtUp).toBe(1);

    expect(texts(readLog(pairId))).toEqual(['Бриф: нужен лендинг на next.js']);
  });

  it('дочитывает всё, что написали, пока релеер поднимался', async () => {
    const { pairId, name } = freshPair();
    // Журнал уже есть — релеер работал раньше и остановился на «до связи».
    appendLogEntry(pairId, { ts: 1000, from: A, text: 'до связи', dealId: null, id: 'old-1' });

    const group = fakeGroup({
      name,
      stream: controllableStream(),
      history: [
        message({ text: 'до связи', at: 1000, id: 'old-1' }),
        message({ text: 'пока лежал релеер, 1', at: 2000, from: B }),
        message({ text: 'пока лежал релеер, 2', at: 3000, from: A }),
      ],
    });

    const res = await watchPairGroup(group);
    expect(res.caughtUp).toBe(2);
    expect(texts(readLog(pairId))).toEqual(['до связи', 'пока лежал релеер, 1', 'пока лежал релеер, 2']);
  });

  it('не задваивает записи при повторном подхвате той же группы', async () => {
    const { pairId, name } = freshPair();
    const history = [
      message({ text: 'раз', at: 1000 }),
      message({ text: 'два', at: 2000, from: B }),
    ];

    await watchPairGroup(fakeGroup({ name, history, stream: controllableStream() }));
    resetWatchRegistry();
    // Второй перезапуск подряд — история та же, дописать нечего.
    const second = await watchPairGroup(fakeGroup({ name, history, stream: controllableStream() }));

    expect(second.caughtUp).toBe(0);
    expect(texts(readLog(pairId))).toEqual(['раз', 'два']);
  });

  it('дедуплицирует по id сообщения, а не по времени и тексту', async () => {
    // Два разных сообщения с одинаковым текстом в одну миллисекунду — это
    // нормальная переписка, а не дубль, и оба обязаны попасть в журнал.
    const { pairId, name } = freshPair();
    const history = [
      message({ text: '+1', at: 5000, from: A, id: 'x-1' }),
      message({ text: '+1', at: 5000, from: A, id: 'x-2' }),
    ];

    await watchPairGroup(fakeGroup({ name, history, stream: controllableStream() }));
    expect(texts(readLog(pairId))).toEqual(['+1', '+1']);

    resetWatchRegistry();
    const again = await watchPairGroup(fakeGroup({ name, history, stream: controllableStream() }));
    expect(again.caughtUp).toBe(0);
    expect(readLog(pairId)).toHaveLength(2);
  });

  it('не задваивает СТАРЫЕ записи, у которых id ещё нет', async () => {
    // Первое дочитывание на живом сервере: весь накопленный журнал написан
    // прежним кодом и id не несёт. Без слабой опоры на отпечаток он задвоился
    // бы целиком.
    const { pairId, name } = freshPair();
    appendLogEntry(pairId, { ts: 1000, from: A.toLowerCase(), text: 'старое раз', dealId: null });
    appendLogEntry(pairId, { ts: 2000, from: B.toLowerCase(), text: 'старое два', dealId: null });

    const group = fakeGroup({
      name,
      stream: controllableStream(),
      history: [
        message({ text: 'старое раз', at: 1000, from: A }),
        message({ text: 'старое два', at: 2000, from: B }),
        message({ text: 'новое', at: 3000, from: A }),
      ],
    });

    const res = await watchPairGroup(group);
    expect(res.caughtUp).toBe(1);
    expect(texts(readLog(pairId))).toEqual(['старое раз', 'старое два', 'новое']);
  });

  it('порядок в журнале хронологический: сначала история, потом поток', async () => {
    const { pairId, name } = freshPair();
    const stream = controllableStream();
    const group = fakeGroup({
      name,
      stream,
      history: [
        message({ text: '1 бриф', at: 1000 }),
        message({ text: '2 ответ', at: 2000, from: B }),
      ],
    });

    const watching = watchPairGroup(group, { logger: { warn() {}, log() {} } });
    // Живое сообщение приходит ПОКА идёт дочитывание — оно обязано лечь после
    // истории, а не перед ней.
    stream.push(message({ text: '3 живое', at: 3000 }));
    await watching;

    expect(texts(readLog(pairId))).toEqual(['1 бриф', '2 ответ', '3 живое']);
  });

  it('после дочитывания продолжает слушать поток', async () => {
    const { pairId, name } = freshPair();
    const stream = controllableStream();
    const group = fakeGroup({ name, stream, history: [message({ text: 'бриф', at: 1000 })] });

    await watchPairGroup(group);
    stream.push(message({ text: 'позже', at: 4000, from: B }));
    // Даём потоку такт на запись.
    for (let i = 0; i < 20 && readLog(pairId).length < 2; i++) await new Promise(r => setTimeout(r, 5));

    expect(texts(readLog(pairId))).toEqual(['бриф', 'позже']);
  });
});

describe('маркер deal_ctx при дочитывании', () => {
  it('привязывает записи к той сделке, что была активна в момент отправки', async () => {
    const { pairId, name } = freshPair();
    const deal = '0xDEADBEEFdeadbeefDEADBEEFdeadbeefDEADBEEF';
    const group = fakeGroup({
      name,
      stream: controllableStream(),
      history: [
        message({ text: 'до сделки', at: 1000 }),
        message({ text: JSON.stringify({ _type: 'deal_ctx', dealId: deal }), at: 1500 }),
        message({ text: 'по сделке', at: 2000, from: B }),
        message({ text: JSON.stringify({ _type: 'deal_ctx', dealId: null }), at: 2500 }),
        message({ text: 'снова общий чат', at: 3000 }),
      ],
    });

    await watchPairGroup(group);
    const entries = readLog(pairId);

    // Сам маркер записью не становится.
    expect(texts(entries)).toEqual(['до сделки', 'по сделке', 'снова общий чат']);
    expect(entries.map(e => e.dealId)).toEqual([null, deal.toLowerCase(), null]);
  });

  it('переживает перезапуск: курсор сделки засевается из последней записи', async () => {
    const { pairId, name } = freshPair();
    const deal = '0xabcabcabcabcabcabcabcabcabcabcabcabcabca';
    // Журнал оборвался на записи, помеченной сделкой. Маркер, который её
    // установил, старше окна дочитывания и в него уже не попадёт.
    appendLogEntry(pairId, { ts: 1000, from: A, text: 'по сделке', dealId: deal, id: 'old-1' });

    const group = fakeGroup({
      name,
      stream: controllableStream(),
      history: [
        message({ text: 'по сделке', at: 1000, id: 'old-1' }),
        message({ text: 'ещё по той же сделке', at: 2000, from: B }),
      ],
    });

    await watchPairGroup(group);
    const entries = readLog(pairId);
    expect(entries.map(e => e.dealId)).toEqual([deal, deal]);
  });
});

describe('устойчивость подхвата', () => {
  it('порченая история не роняет подписку на поток', async () => {
    const { pairId, name } = freshPair();
    const stream = controllableStream();
    const warnings = [];
    const group = fakeGroup({ name, stream, historyThrows: true });

    const res = await watchPairGroup(group, { logger: { warn: m => warnings.push(m), log() {} } });
    expect(res.caughtUp).toBe(0);
    expect(res.streaming).toBe(true);
    expect(warnings.join(' ')).toContain('history catch-up failed');

    stream.push(message({ text: 'поток жив', at: 1000 }));
    for (let i = 0; i < 20 && readLog(pairId).length < 1; i++) await new Promise(r => setTimeout(r, 5));
    expect(texts(readLog(pairId))).toEqual(['поток жив']);
  });

  it('упавший поток не отменяет дочитывание', async () => {
    const { pairId, name } = freshPair();
    const group = fakeGroup({ name, stream: null, history: [message({ text: 'бриф', at: 1000 })] });

    const res = await watchPairGroup(group, { logger: { warn() {}, log() {} } });
    expect(res.streaming).toBe(false);
    expect(texts(readLog(pairId))).toEqual(['бриф']);
  });

  it('пустая история — ни записей, ни падения', async () => {
    const { pairId, name } = freshPair();
    const res = await watchPairGroup(fakeGroup({ name, history: [], stream: controllableStream() }));
    expect(res.caughtUp).toBe(0);
    expect(readLog(pairId)).toEqual([]);
  });

  it('на одну группу вешается один наблюдатель, а не два', async () => {
    const { name } = freshPair();
    const group = fakeGroup({ name, history: [message({ text: 'раз', at: 1000 })], stream: controllableStream() });

    const [a, b] = await Promise.all([watchPairGroup(group), watchPairGroup(group)]);
    expect(a).toBe(b);
    expect(group.calls.sync).toBe(1);
  });

  it('непарная группа игнорируется', async () => {
    const group = fakeGroup({ name: 'Random group', history: [message({ text: 'x', at: 1 })] });
    expect(await watchPairGroup(group)).toBeNull();
    expect(group.calls.messages).toBe(0);
  });
});

describe('умерший поток и повторный проход', () => {
  const quiet = { warn() {}, log() {} };

  it('умерший поток снимает группу с учёта, и её можно подхватить заново', async () => {
    const { pairId, name } = freshPair();
    const stream = controllableStream();
    const group = fakeGroup({ name, stream, history: [message({ text: 'бриф', at: 1000, id: 'm-1' })] });

    await watchPairGroup(group, { logger: quiet });
    // Поток кончился — раньше это значило «переписка больше не пишется, молча
    // и до перезапуска».
    stream.close();
    await new Promise(r => setTimeout(r, 10));

    // Повторный подхват той же группы уже не отсекается картой: `sync()`
    // зовётся второй раз, значит дочитывание действительно случилось снова.
    // Останься группа на учёте — вернулся бы кэшированный промис и счётчик
    // остался бы на единице.
    const again = await watchPairGroup(
      { ...group, stream: async () => controllableStream(), messages: group.messages.bind(group) },
      { logger: quiet },
    );
    expect(again.pairId).toBe(pairId);
    expect(group.calls.sync).toBe(2);
    // И ничего не задвоило.
    expect(texts(readLog(pairId))).toEqual(['бриф']);
  });

  it('повторный проход подхватывает группу, приглашение в которую пропустили', async () => {
    const { pairId, name } = freshPair();
    const group = fakeGroup({ name, stream: controllableStream(), history: [message({ text: 'мимо потока', at: 1000 })] });
    const client = {
      conversations: {
        async sync() {},
        async listGroups() { return [group]; },
      },
    };

    expect(await rescanPairGroups(client, { logger: quiet })).toBe(1);
    // rescan не ждёт подхвата — даём ему завершиться.
    await new Promise(r => setTimeout(r, 20));
    expect(texts(readLog(pairId))).toEqual(['мимо потока']);
  });

  it('повторный проход не трогает то, за чем уже следим', async () => {
    const { name } = freshPair();
    const group = fakeGroup({ name, stream: controllableStream(), history: [] });
    const client = { conversations: { async sync() {}, async listGroups() { return [group]; } } };

    await watchPairGroup(group, { logger: quiet });
    expect(await rescanPairGroups(client, { logger: quiet })).toBe(0);
    expect(group.calls.sync).toBe(1);
  });

  it('упавший повторный проход не роняет процесс', async () => {
    const client = { conversations: { async sync() { throw new Error('network down'); }, async listGroups() { return []; } } };
    const warnings = [];
    expect(await rescanPairGroups(client, { logger: { warn: m => warnings.push(m), log() {} } })).toBe(0);
    expect(warnings.join(' ')).toContain('rescan failed');
  });
});

describe('глубина дочитывания', () => {
  it('первый подхват пары читает историю с самого начала', async () => {
    const { pairId, name } = freshPair();
    const seen = [];
    const group = fakeGroup({ name, stream: controllableStream(), history: [message({ text: 'древнее', at: 1 })] });
    const origMessages = group.messages.bind(group);
    group.messages = async (opts) => { seen.push(opts); return origMessages(opts); };

    await watchPairGroup(group);
    expect(seen[0].sentAfterNs).toBeUndefined();
    expect(texts(readLog(pairId))).toEqual(['древнее']);
  });

  it('при существующем журнале читает от последней записи минус запас', async () => {
    const { pairId, name } = freshPair();
    const lastTs = 10_000_000;
    appendLogEntry(pairId, { ts: lastTs, from: A, text: 'последнее', dealId: null, id: 'old-1' });

    const seen = [];
    const group = fakeGroup({ name, stream: controllableStream(), history: [] });
    group.messages = async (opts) => { seen.push(opts); return []; };

    await watchPairGroup(group, { overlapMs: 60_000 });
    expect(seen[0].sentAfterNs).toBe(BigInt(lastTs - 60_000) * 1_000_000n);
  });

  it('листает историю страницами и упирается в потолок, а не висит вечно', async () => {
    const { pairId, name } = freshPair();
    const history = Array.from({ length: 7 }, (_, i) => message({ text: `m${i}`, at: 1000 + i }));
    const group = fakeGroup({ name, history, stream: controllableStream() });
    const warnings = [];

    await watchPairGroup(group, { pageSize: 2, maxPages: 2, logger: { warn: m => warnings.push(m), log() {} } });
    expect(texts(readLog(pairId))).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(warnings.join(' ')).toContain('ceiling');
  });
});

describe('createPairLogger', () => {
  it('пропускает пустые и нестроковые сообщения', async () => {
    const { pairId } = freshPair();
    const log = createPairLogger(pairId);
    expect(await log.consume({ content: '' }, async () => A)).toBe('skipped');
    expect(await log.consume({ content: { hi: 1 } }, async () => A)).toBe('skipped');
    expect(readLog(pairId)).toEqual([]);
  });

  it('не-JSON текст, начинающийся с фигурной скобки, записывается как обычный', async () => {
    const { pairId } = freshPair();
    const log = createPairLogger(pairId);
    expect(await log.consume(message({ text: '{ не json', at: 1 }), async () => A)).toBe('logged');
    expect(texts(readLog(pairId))).toEqual(['{ не json']);
  });

  it('JSON без _type deal_ctx — обычная запись, а не маркер', async () => {
    const { pairId } = freshPair();
    const log = createPairLogger(pairId);
    const payload = JSON.stringify({ kind: 'file', name: 'spec.pdf' });
    expect(await log.consume(message({ text: payload, at: 1 }), async () => A)).toBe('logged');
    expect(texts(readLog(pairId))).toEqual([payload]);
  });
});

describe('readGroupHistory', () => {
  it('отдаёт сообщения в хронологическом порядке, даже если страница пришла вперемешку', async () => {
    const group = {
      async messages() {
        return [message({ text: 'b', at: 200 }), message({ text: 'a', at: 100 })];
      },
    };
    const { messages } = await readGroupHistory(group, { pageSize: 10 });
    expect(messages.map(m => m.content)).toEqual(['a', 'b']);
  });

  it('не зацикливается, когда вся страница пришла одной наносекундой', async () => {
    let calls = 0;
    const group = {
      async messages() {
        calls++;
        return [message({ text: 'x', at: 100 }), message({ text: 'y', at: 100 })];
      },
    };
    const { messages } = await readGroupHistory(group, { sinceMs: 50, pageSize: 2, maxPages: 10 });
    expect(calls).toBe(2); // первый запрос + один сдвиг курсора, дальше стоп
    expect(messages).toHaveLength(4);
  });
});

describe('createMemberResolver', () => {
  it('читает состав один раз на весь подхват', async () => {
    let calls = 0;
    const resolve = createMemberResolver({
      async members() {
        calls++;
        return [{ inboxId: `inbox-${A}`, accountIdentifiers: [{ identifier: A }] }];
      },
    });
    expect(await resolve(`inbox-${A}`)).toBe(A.toLowerCase());
    expect(await resolve(`inbox-${A}`)).toBe(A.toLowerCase());
    expect(calls).toBe(1);
  });

  it('незнакомого отправителя отдаёт как inboxId, а не теряет сообщение', async () => {
    const resolve = createMemberResolver({ async members() { return []; } });
    expect(await resolve('inbox-unknown')).toBe('inbox-unknown');
  });

  it('нечитаемый состав не роняет подхват', async () => {
    const resolve = createMemberResolver({ async members() { throw new Error('SecretReuseError'); } });
    expect(await resolve('inbox-x')).toBe('inbox-x');
  });
});

describe('pairIdFromGroupName', () => {
  it('достаёт pairId из имени парной группы', () => {
    expect(pairIdFromGroupName(`HSEAL-PAIR-${A}-${B}`)).toBe(`${A}-${B}`.toLowerCase());
  });
  it('отбрасывает чужие и порченые имена', () => {
    expect(pairIdFromGroupName('Random')).toBeNull();
    expect(pairIdFromGroupName('HSEAL-PAIR-nonsense')).toBeNull();
    expect(pairIdFromGroupName(null)).toBeNull();
  });
});
