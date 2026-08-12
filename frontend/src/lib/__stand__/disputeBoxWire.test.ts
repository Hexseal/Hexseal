/**
 * disputeBoxWire.test.ts — ящик спора на НАСТОЯЩЕМ релеере (Задача 6).
 *
 * ⚠️ ЗАЧЕМ НЕ МОК. Форма описи объявлена на сервере (Задача 1) и зеркалится
 * на клиенте. Замок, сверяющий «одинаковые строки в двух файлах», зелен и
 * бесполезен: он не видит, что сервер отдаёт другое. Здесь поднимается
 * `relayer/app.js` — тот же Express, что в бою (`chatStand.ts`), — и поля
 * ЖИВОГО ОТВЕТА сверяются со списком, написанным здесь РУКАМИ.
 *
 * ⚠️ УЗЕЛ ПОДДЕЛАН, И ТОЛЬКО ОН. Маршруты ящика читают цепь (замок ящика,
 * Задача 1), а стенд по умолчанию прибит к недостижимому RPC. Поддельный узел
 * ниже отвечает на ПЯТЬ чтений — весь список договора шапки плана (§4):
 * `getRecord`, `getDetails`, `getDisputeClaimer`, `getPendingVerdict` (все
 * четыре от Задачи 1) и `DISPUTE_WINDOW` (от Задачи 2, срок жизни мешка
 * считается на ЗАПИСИ). На любой другой селектор он отвечает ОШИБКОЙ С ИМЕНЕМ
 * СЕЛЕКТОРА — то есть если задачи 1 и 2 читают цепь иначе, этот стенд скажет
 * об этом вслух, а не подгонит число.
 *
 * ⚠️ ПЯТОЕ ЧТЕНИЕ ЗДЕСЬ НЕ ПРО ЗАПАС. Задача 2 идёт РАНЬШЕ этой и добавляет
 * `getDisputeWindowMs(agr, agreement)` в тот же `PUT`, а на отказ чтения
 * отвечает `503 chain_unavailable`. Забыть селектор — получить 503 на КАЖДОМ
 * `PUT` и семь красных на единственных тестах, которые переходят шов
 * фронт↔релеер по-настоящему, причём красных по чужой причине.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { ethers } from 'ethers';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector, type Hex } from 'viem';
import type { ChatStand } from './chatStand';

const ZERO = '0x0000000000000000000000000000000000000000';

/** Ответы поддельного узла — их меняют тесты. */
const chainState = {
  agreement: '' as `0x${string}`,
  client: '' as `0x${string}`,
  executor: '' as `0x${string}`,
  arbiter: ZERO as `0x${string}`,
  status: 4,
};

const SEL = {
  getRecord:          toFunctionSelector('function getRecord(address)'),
  getDetails:         toFunctionSelector('function getDetails()'),
  getDisputeClaimer:  toFunctionSelector('function getDisputeClaimer(address)'),
  getPendingVerdict:  toFunctionSelector('function getPendingVerdict(address)'),
  // ⚠️ ПЯТОЕ — от Задачи 2, на пути ЗАПИСИ. Без него каждый PUT даёт 503.
  disputeWindow:      toFunctionSelector('function DISPUTE_WINDOW()'),
};

/** 4 дня в СЕКУНДАХ — `Agreement.DISPUTE_WINDOW` (`src/Agreement.sol`,
 *  `4 days`). Число написано здесь руками: подставить миллисекунды значило бы
 *  дать релееру срок мешка в тысячу раз больше и не заметить этого. */
const DISPUTE_WINDOW_SEC = BigInt(345_600);

function answer(data: string): Hex {
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === SEL.getDisputeClaimer.toLowerCase()) {
    return encodeAbiParameters(parseAbiParameters('address'), [chainState.arbiter]);
  }
  if (sel === SEL.getRecord.toLowerCase()) {
    // RegistryStorage.AgreementRecord — тот же tuple, что в REGISTRY_MINI_ABI
    // релеера (`app.js:173`). ⚠️ `status` реестра — ДРУГОЙ enum (там
    // DISPUTED = 3), и существование сделки проверяется полем `agreement`,
    // а не статусом: у незнакомого адреса геттер отдаёт нули, а 0 в реестре
    // означает ACTIVE.
    return encodeAbiParameters(
      parseAbiParameters('(address,address,address,uint256,uint8,uint256,uint256)'),
      [[chainState.agreement, chainState.client, chainState.executor, BigInt(1_000_000), 3, BigInt(1), BigInt(0)]],
    );
  }
  if (sel === SEL.getDetails.toLowerCase()) {
    return encodeAbiParameters(
      parseAbiParameters('address,address,address,uint256,string,uint256,uint256,uint256,uint256,uint256,uint256,uint8'),
      [chainState.client, chainState.executor, ZERO, BigInt(1_000_000), 'terms',
        BigInt(7), BigInt(1), BigInt(2), BigInt(0), BigInt(3), BigInt(0), chainState.status],
    );
  }
  if (sel === SEL.getPendingVerdict.toLowerCase()) {
    return encodeAbiParameters(
      parseAbiParameters('(address,bool,uint256,bool,bool,bool,bool,bool,bool,address,uint256,uint256,uint256)'),
      [[ZERO, false, BigInt(0), false, false, false, false, false, false, ZERO, BigInt(0), BigInt(0), BigInt(0)]],
    );
  }
  if (sel === SEL.disputeWindow.toLowerCase()) {
    // Секунды, как в контракте. Релеер переводит их в миллисекунды сам
    // (`makeCachedConstantMsReader`, `relayer/app.js:372`).
    return encodeAbiParameters(parseAbiParameters('uint256'), [DISPUTE_WINDOW_SEC]);
  }
  throw new Error(`поддельный узел: неизвестный селектор ${sel}`);
}

async function startFakeChain(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed: unknown;
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
      // ⚠️ ethers v6 БАТЧИТ запросы: тело бывает массивом. Разобрав только
      // объект, стенд молча отвечал бы мусором на каждый второй прогон.
      const many = Array.isArray(parsed) ? parsed : [parsed];
      const out = many.map((r) => {
        const call = r as { id: number; method: string; params?: unknown[] };
        try {
          if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: '0x14a34' };
          if (call.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: call.id, result: '0x1' };
          if (call.method === 'net_version') return { jsonrpc: '2.0', id: call.id, result: '84532' };
          if (call.method === 'eth_call') {
            const p = (call.params?.[0] ?? {}) as { data?: string };
            return { jsonrpc: '2.0', id: call.id, result: answer(String(p.data ?? '')) };
          }
          throw new Error(`поддельный узел: неизвестный метод ${call.method}`);
        } catch (e) {
          return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: String((e as Error).message) } };
        }
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('поддельный узел не встал на порт');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    stop: () => new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve()))),
  };
}

let stand: ChatStand;
let chain: { url: string; stop: () => Promise<void> };
let presenterPass = '';
let arbiterPass = '';
let arbiterWallet: ethers.HDNodeWallet;
let judyKeypair: { publicKey: Uint8Array; privateKey: Uint8Array };

/** 0x + 64 hex из байтов — свой, не из проверяемого модуля. */
function hex32(bytes: Uint8Array): Hex {
  return ('0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

beforeAll(async () => {
  chain = await startFakeChain();
  const { startChatStand } = await import('./chatStand');
  stand = await startChatStand({ rpcUrl: chain.url });
  process.env.NEXT_PUBLIC_RELAYER_URL = stand.url;
  vi.resetModules();

  arbiterWallet = ethers.Wallet.createRandom();
  chainState.agreement = ethers.Wallet.createRandom().address.toLowerCase() as `0x${string}`;
  chainState.client = stand.wallets[0].address.toLowerCase() as `0x${string}`;
  chainState.executor = stand.wallets[1].address.toLowerCase() as `0x${string}`;
  chainState.arbiter = arbiterWallet.address.toLowerCase() as `0x${string}`;
  chainState.status = 4;

  const t = await import('../chatTransport');
  t._resetBagPassCacheForTest();
  presenterPass = (await t.requestBagPass(
    (m) => stand.wallets[0].signMessage(m), chainState.client)).pass;
  arbiterPass = (await t.requestBagPass(
    (m) => arbiterWallet.signMessage(m), chainState.arbiter)).pass;

  const { makeActor } = await import('./presentationFixtures');
  judyKeypair = (await makeActor(`0x${'33'.repeat(32)}`, '3d')).session.keypair;
}, 180_000);

afterAll(async () => {
  await stand?.stop();
  await chain?.stop();
  delete process.env.NEXT_PUBLIC_RELAYER_URL;
});

/** Настоящее предъявление: актёры, кадры, архив, сборка, печать на арбитра. */
async function sealedPresentation(sealFor: Uint8Array = judyKeypair.publicKey): Promise<{
  sealed: Uint8Array; container: unknown;
}> {
  const { installFakeChatDisk } = await import('./fakeChatDisk');
  const { makeActor, attestationOf, forgeFrames, seedArchive } = await import('./presentationFixtures');
  const { buildPresentation, toArbiterBoxKeyBytes, toPeerBoxKeyBytes } = await import('@/lib/presentation');
  const { sealPresentation } = await import('@/lib/presentationBag');
  const { _resetConversationMemoryForTest } = await import('@/lib/chatConversation');

  _resetConversationMemoryForTest();
  const disk = installFakeChatDisk();
  try {
    const alice = await makeActor(stand.wallets[0].privateKey, '1c');
    const bob = await makeActor(stand.wallets[1].privateKey, '7f');
    const mine = await forgeFrames(alice, bob, ['сроки прошли', 'где работа']);
    const theirs = await forgeFrames(bob, alice, ['почти готово'], 1_754_400_500_000);
    expect(await seedArchive(alice, bob, [...mine, ...theirs])).toBe(3);
    const built = await buildPresentation({
      dealId: chainState.agreement,
      presenter: alice.address,
      peer: bob.address,
      arbiterBoxKey: toArbiterBoxKeyBytes(sealFor),
      peerBoxKey: toPeerBoxKeyBytes(bob.session.keypair.publicKey),
      selected: [
        { seq: 0, sender: alice.address.toLowerCase() as `0x${string}` },
        { seq: 1, sender: alice.address.toLowerCase() as `0x${string}` },
        { seq: 0, sender: bob.address.toLowerCase() as `0x${string}` },
      ],
      session: alice.session,
      ownAttestation: await attestationOf(alice),
      // ⚠️ СПИСКОМ (Задача 4): поля `peerAttestation` больше нет, и сборщик
      // на само его наличие бросает TypeError.
      otherAttestations: [await attestationOf(bob)],
    });
    if (!built.ok) throw new Error(`сборка отказала: ${built.reason}`);
    return { sealed: await sealPresentation(built.container, sealFor), container: built.container };
  } finally {
    disk.restore();
    _resetConversationMemoryForTest();
  }
}

/**
 * ⚠️ БОЕВОЙ ПУТЬ ЦЕЛИКОМ: `sendPresentation` → печать на ключ АРБИТРА →
 * `putDisputeBag` на живой релеер. Подменены ровно три конца, у которых на
 * стенде нет настоящего источника: `readStatus` и `readArbiterNow` (узел
 * поддельный, значения те же, что отдаёт он) и `getPass` (пропуск уже получен
 * в `beforeAll`). Всё остальное — настоящее, включая ответ склада с его
 * `uploadedAt`.
 */
async function sendThroughButton(): Promise<{ key: string; uploadedAt: number; sealedBytes: number }> {
  const { installFakeChatDisk } = await import('./fakeChatDisk');
  const { makeActor, attestationOf, forgeFrames, seedArchive } = await import('./presentationFixtures');
  const {
    sendPresentation, otherAttestationsOf, _resetSendingForTest,
  } = await import('@/lib/presentToArbiter');
  const { toBoxKey } = await import('@/lib/arbiterChatKey');
  const { putDisputeBag } = await import('@/lib/disputeBox');
  const { _resetConversationMemoryForTest } = await import('@/lib/chatConversation');
  const { readPresentationDrafts } = await import('@/lib/presentationDraft');
  const { presentationWireBytes } = await import('@/lib/presentationBag');

  _resetSendingForTest();
  _resetConversationMemoryForTest();
  const disk = installFakeChatDisk();
  try {
    const alice = await makeActor(stand.wallets[0].privateKey, '1c');
    const bob = await makeActor(stand.wallets[1].privateKey, '7f');
    const mine = await forgeFrames(alice, bob, ['сроки прошли', 'где работа']);
    const theirs = await forgeFrames(bob, alice, ['почти готово'], 1_754_400_500_000);
    expect(await seedArchive(alice, bob, [...mine, ...theirs])).toBe(3);

    const boxKey = toBoxKey(hex32(judyKeypair.publicKey));
    const verdict = await sendPresentation({
      agreement: chainState.agreement,
      presenter: alice.address.toLowerCase() as `0x${string}`,
      peer: bob.address.toLowerCase() as `0x${string}`,
      // Снимок: тот арбитр и тот ключ, про которых спросили бы человека.
      presented: { arbiter: chainState.arbiter, boxKey },
      // ⚠️ Байты печати — из того же снимка, готовыми (в бою их отдаёт
      // Задача 5; здесь узел поддельный, и снимок собран руками рядом).
      arbiterBoxKey: judyKeypair.publicKey as never,
      peerBoxKey: bob.session.keypair.publicKey,
      selected: [
        { seq: 0, sender: alice.address.toLowerCase() as `0x${string}` },
        { seq: 1, sender: alice.address.toLowerCase() as `0x${string}` },
        { seq: 0, sender: bob.address.toLowerCase() as `0x${string}` },
      ],
      session: alice.session,
      ownAttestation: await attestationOf(alice),
      otherAttestations: otherAttestationsOf({
        attestation: await attestationOf(bob), attestationHistory: [],
      }),
      consent: true,
      readStatus: async () => chainState.status,
      // Поддельный узел на стенде для ЭТОГО чтения не годится: сюда едет
      // форма Задачи 5, а не сырой вызов цепи. Значения — те же, что отдаёт
      // узел, и снимок с ними сходится.
      readArbiterNow: async () => ({
        state: 'ready', arbiter: chainState.arbiter, boxKey,
        boxKeyBytes: judyKeypair.publicKey as never, registered: true,
      }),
      getPass: async () => presenterPass,
      put: (pass, box, sealed, sealedFor) => putDisputeBag(pass, box, sealed, sealedFor),
    });
    expect(verdict.ok, `боевой путь отказал: ${verdict.ok ? '' : verdict.reason}`).toBe(true);
    if (!verdict.ok) throw new Error(verdict.reason);
    const drafts = await readPresentationDrafts(alice.address.toLowerCase() as `0x${string}`);
    expect(drafts.length, 'черновик не лёг').toBe(1);
    expect(drafts[0].state, 'черновик не помечен отправленным').toBe('sent');

    // ⚠️ ВРЕМЯ СВЕРЯЕТСЯ С НЕЗАВИСИМЫМ ИСТОЧНИКОМ — С ОПИСЬЮ, А НЕ С САМИМ
    // СОБОЙ. Сверить `drafts[0].sentAt` с `verdict.uploadedAt` мало: оба
    // приезжают из ОДНОЙ переменной пути отправки, и подмена её на часы
    // клиента меняет обе стороны равенства одинаково — «порча не портит».
    // Опись отдаёт время из СВОЕЙ записи (`meta.uploadedAt`, Задача 1), то
    // есть часы сервера, добытые другим путём.
    const transport = await import('../chatTransport');
    const boxClient = await import('@/lib/disputeBox');
    transport._resetReadBudgetForTest();
    const listed = await boxClient.listDisputeBox(presenterPass, chainState.agreement);
    const listedBag = listed.bags.find(b => b.key === verdict.bagKey);
    expect(listedBag, 'положенного мешка нет в описи').toBeTruthy();
    expect(drafts[0].sentAt, 'в черновик уехало не серверное время (сверка с описью)')
      .toBe(listedBag?.uploadedAt);
    return {
      key: verdict.bagKey,
      uploadedAt: verdict.uploadedAt,
      sealedBytes: presentationWireBytes(drafts[0].container),
    };
  } finally {
    disk.restore();
    _resetConversationMemoryForTest();
  }
}

describe('ящик спора на живом релеере', () => {
  it('S1: поля ЖИВОГО ответа совпадают с типом клиента — список написан руками', async () => {
    const box = await import('@/lib/disputeBox');
    const t = await import('../chatTransport');
    const { sealed } = await sealedPresentation();
    const stored = await box.putDisputeBag(
      presenterPass, chainState.agreement, sealed, chainState.arbiter);

    // ⚠️ ОТВЕТ PUT — ТОЖЕ ФОРМА НА ШВЕ, и до этой редакции его не сверял
    // никто: клиент брал `key` и выбрасывал время, а стенд смотрел только на
    // опись. Список ключей написан руками.
    const rawPut = await fetch(`${stand.url}/disputes/${chainState.agreement}/bags`, {
      method: 'PUT',
      headers: {
        'x-bag-pass': presenterPass,
        'content-type': 'application/octet-stream',
        'x-sealed-for': chainState.arbiter,
      },
      body: (await sealedPresentation()).sealed as unknown as BodyInit,
    });
    expect(rawPut.status).toBe(200);
    const putBody = await rawPut.json() as Record<string, unknown>;
    expect(Object.keys(putBody).sort()).toEqual(['key', 'uploadedAt']);
    expect(typeof putBody.uploadedAt).toBe('number');
    // И клиент это время не выбросил.
    expect(typeof stored.uploadedAt).toBe('number');
    expect(stored.uploadedAt).toBeGreaterThan(1_700_000_000_000);

    // Сырой ответ описи, МИМО клиента: разбор клиента здесь проверять нечем —
    // он же и проверяется.
    const raw = await fetch(`${stand.url}/disputes/${chainState.agreement}/bags`, {
      headers: { 'x-bag-pass': arbiterPass },
    });
    expect(raw.status, 'опись не отдалась тому, кто ведёт спор').toBe(200);
    const body = await raw.json() as Record<string, unknown>;

    // ⚠️ СПИСКИ НАПИСАНЫ РУКАМИ, а не взяты из типа: иначе замер сверял бы
    // форму саму с собой. `indexTrusted` — ревью Задачи 1, круг 2.
    expect(Object.keys(body).sort()).toEqual(['arbiter', 'bags', 'indexTrusted', 'sealedForOthers']);
    // Индекс релеера на стенде цел — опись не восстанавливалась с диска.
    expect(body.indexTrusted).toBe(true);
    const bags = body.bags as Record<string, unknown>[];
    expect(bags.length).toBe(2);
    // ⚠️ `fetchedAt`, А НЕ БУЛЕВО `fetched`. Значение у Задачи 1 уже лежит
    // (`meta.firstFetchedAt`), и договор шапки требует отдать наружу именно
    // время: без него «забрал + время» из §4 замысла недостижимо. Красный
    // здесь — расхождение с Задачей 1, а не повод переписать тип клиента.
    expect(Object.keys(bags[0]).sort())
      .toEqual(['fetchedAt', 'key', 'sealedFor', 'sender', 'size', 'uploadedAt']);
    expect(bags[0].fetchedAt, 'мешок никто не забирал, а отметка стоит').toBe(null);
    expect(String(bags[0].sealedFor).toLowerCase(), '`x-sealed-for` не доехал')
      .toBe(chainState.arbiter);
    expect(String(bags[0].key).startsWith(`${chainState.agreement}/`), 'ключ не из этого ящика')
      .toBe(true);
    expect(bags.some(b => b.size === sealed.byteLength)).toBe(true);

    // И теперь тот же ответ через клиента — он обязан разобрать его без отказа.
    t._resetReadBudgetForTest();
    const list = await box.listDisputeBox(arbiterPass, chainState.agreement);
    expect(list.arbiter?.toLowerCase()).toBe(chainState.arbiter);
    expect(list.bags.length).toBe(2);
    expect(list.bags[0].sealedFor?.toLowerCase()).toBe(chainState.arbiter);
    expect(list.bags[0].fetchedAt).toBe(null);
    expect(typeof list.sealedForOthers).toBe('number');
    expect(list.indexTrusted).toBe(true);
  }, 180_000);

  it('S2: круговорот ЧЕРЕЗ БОЕВОЙ ПУТЬ — кнопка положила, арбитр забрал, читалка дала ok', async () => {
    const box = await import('@/lib/disputeBox');
    const t = await import('../chatTransport');
    const bag = await import('@/lib/presentationBag');
    const { readPresentation } = await import('@/lib/presentationRead');

    // ⚠️ ЗДЕСЬ ЗОВЁТСЯ `sendPresentation`, а не печать напрямую. Иначе стенд
    // проверял бы оснастку теста: боевой путь (печать на ключ АРБИТРА,
    // черновик, `putDisputeBag`) не был бы задет вовсе, и мутация «запечатать
    // на вторую сторону» дала бы ноль.
    const { key, sealedBytes } = await sendThroughButton();

    t._resetReadBudgetForTest();
    const bytes = await box.fetchDisputeBag(arbiterPass, chainState.agreement, key);
    expect(bytes, 'мешок не вернулся').not.toBeNull();
    expect((bytes as Uint8Array).byteLength).toBe(sealedBytes);

    const look = await bag.lookIntoBag(bytes as Uint8Array, judyKeypair);
    expect(look.kind, 'мешок не опознан как предъявление').toBe('presentation');
    if (look.kind !== 'presentation') return;
    // ⚠️ ВОТ ГДЕ ПРОВЕРЯЕТСЯ «НИЧЕГО НЕ ЗАМАЗАНО»: подпись контейнера покрывает
    // всё, кроме себя. Тронь путь отправки хоть байтом — здесь будет
    // `bad_signature`, а не `ok`.
    const view = await readPresentation(look.container, judyKeypair);
    expect(view.container).toBe('ok');
    expect(view.dealId?.toLowerCase()).toBe(chainState.agreement);
    expect(view.counts.read).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('S3: запечатано на АРБИТРА — чужой парой не открывается', async () => {
    const box = await import('@/lib/disputeBox');
    const t = await import('../chatTransport');
    const bag = await import('@/lib/presentationBag');
    const { makeActor } = await import('./presentationFixtures');
    const stranger = (await makeActor(`0x${'44'.repeat(32)}`, '9b')).session.keypair;

    const { sealed } = await sealedPresentation();
    const { key } = await box.putDisputeBag(
      presenterPass, chainState.agreement, sealed, chainState.arbiter);
    t._resetReadBudgetForTest();
    const bytes = await box.fetchDisputeBag(arbiterPass, chainState.agreement, key);
    expect((await bag.lookIntoBag(bytes as Uint8Array, stranger)).kind).toBe('sealed_for_other');
  }, 180_000);

  it('S4: мешок сверх потолка — 413, и это «ящик не принял», а не «места нет»', async () => {
    const box = await import('@/lib/disputeBox');
    const { BagTransportError } = await import('../chatTransport');
    let caught: unknown = null;
    try {
      await box.putDisputeBag(
        presenterPass, chainState.agreement, new Uint8Array(262_145).fill(3), chainState.arbiter);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BagTransportError);
    expect((caught as InstanceType<typeof BagTransportError>).status).toBe(413);
    // Что 413 разводится в «ящик не принял», а не в «места нет», проверяет
    // T10 на подделанном отказе; здесь доказано, что живой склад отдаёт
    // именно 413 — то есть сцена T10 не выдумана.
  }, 180_000);

  it('S5: сторона видит СВОЙ мешок и время, когда его забрали', async () => {
    // ⚠️ ЗДЕСЬ ЖИВЁТ ВСЁ ОБЕЩАНИЕ §4 ЗАМЫСЛА («положено» + «забрал» + время),
    // и оно переходит три границы разом: сторона кладёт, арбитр забирает,
    // сторона узнаёт об этом из описи. Ни один мок такой замок не заменит.
    const box = await import('@/lib/disputeBox');
    const t = await import('../chatTransport');
    const { sealed } = await sealedPresentation();
    const stored = await box.putDisputeBag(
      presenterPass, chainState.agreement, sealed, chainState.arbiter);

    // 1. Опись ПРОПУСКОМ СТОРОНЫ. Задача 1 пускает и сторону (`isParty`),
    //    отдавая ей только её мешки. Поменяет она это правило — красный
    //    здесь, а не у человека, который так и не узнает, дошло ли его
    //    предъявление.
    t._resetReadBudgetForTest();
    const res = await fetch(`${stand.url}/disputes/${chainState.agreement}/bags`, {
      headers: { 'x-bag-pass': presenterPass },
    });
    console.info(`[замер] опись ящика пропуском СТОРОНЫ: HTTP ${res.status}`);
    expect(res.status, 'сторона перестала видеть свой ящик').toBe(200);

    const { sentBagState } = await import('@/lib/presentToArbiter');
    t._resetReadBudgetForTest();
    const before = await box.listDisputeBox(presenterPass, chainState.agreement);
    expect(before.bags.every(b => b.sender.toLowerCase() === chainState.client),
      'стороне видны ЧУЖИЕ мешки').toBe(true);
    expect(sentBagState(before, stored.key))
      .toEqual({ kind: 'placed', uploadedAt: stored.uploadedAt });

    // 2. Арбитр забирает.
    t._resetReadBudgetForTest();
    expect(await box.fetchDisputeBag(arbiterPass, chainState.agreement, stored.key)).not.toBeNull();

    // 3. Сторона видит ВРЕМЯ, а не только факт.
    t._resetReadBudgetForTest();
    const after = sentBagState(
      await box.listDisputeBox(presenterPass, chainState.agreement), stored.key);
    expect(after.kind, '«забрали» до стороны не доехало').toBe('fetched');
    if (after.kind !== 'fetched') return;
    expect(after.fetchedAt).toBeGreaterThanOrEqual(after.uploadedAt);
    console.info(`[замер] от «положено» до «забрали»: ${after.fetchedAt - after.uploadedAt} мс`);
  }, 180_000);

  it('S7: чужому ящик отвечает 403 `not_a_party`, и клиент называет ИМЕННО ЭТО', async () => {
    // ⚠️ ЗАМОК НА РАЗБОР ПО КОДУ, И ОТКАЗ ЗДЕСЬ НАСТОЯЩИЙ. В поведенческом
    // замере (T10) отказы подделаны, то есть он проверяет только разводку.
    // Здесь код приходит с ЖИВОГО сервера: поменяет Задача 1 имя кода —
    // человек получит общее «ящик не принял» вместо объяснения, и этот замер
    // об этом скажет.
    const box = await import('@/lib/disputeBox');
    const { refusalOfBoxError } = await import('@/lib/presentToArbiter');
    const { sealed } = await sealedPresentation();
    let caught: unknown = null;
    try {
      // Пропуск АРБИТРА: он читать вправе, а класть в ящик — нет.
      await box.putDisputeBag(arbiterPass, chainState.agreement, sealed, chainState.arbiter);
    } catch (e) { caught = e; }
    const { BagTransportError } = await import('../chatTransport');
    expect(caught).toBeInstanceOf(BagTransportError);
    expect((caught as InstanceType<typeof BagTransportError>).status).toBe(403);
    expect((caught as InstanceType<typeof BagTransportError>).code).toBe('not_a_party');
    expect(refusalOfBoxError(caught)).toBe('not_a_party');
  }, 180_000);

  it('S6: ящик один и тот же, каким бы регистром адрес ни пришёл', async () => {
    const box = await import('@/lib/disputeBox');
    const t = await import('../chatTransport');
    const { sealed } = await sealedPresentation();
    const checksummed = ethers.getAddress(chainState.agreement) as `0x${string}`;
    expect(checksummed, 'адрес и так в нижнем регистре — замер ничего не мерит')
      .not.toBe(chainState.agreement);
    const { key } = await box.putDisputeBag(
      presenterPass, checksummed, sealed, chainState.arbiter);
    expect(key.startsWith(`${chainState.agreement}/`), 'мешок лёг в ящик другого регистра')
      .toBe(true);
    t._resetReadBudgetForTest();
    const list = await box.listDisputeBox(arbiterPass, chainState.agreement);
    expect(list.bags.some(b => b.key === key), 'опись мешка не видит').toBe(true);
  }, 180_000);
});
