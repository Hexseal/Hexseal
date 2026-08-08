/**
 * chatOwnHalf.test.ts — К-1: своя половина переписки переживает перезагрузку.
 *
 * ЗАМЕР ДО ПРАВКИ (на этом же стенде): Алиса пишет Бобу два сообщения, вкладку
 * закрывают и открывают заново — Алиса видит **0 из 2 своих**, Боб видит 2 из 2.
 * Мешок лежит в каталоге получателя, скачать его мог только получатель, а на
 * устройстве переживает перезагрузку лишь голова цепочки, не содержимое.
 * Конверт при этом запечатан ДВУМЯ слотами, второй — на себя, ровно ради
 * собственного архива (Задача 3): слот был, доставать нечем.
 *
 * Это ломало обещание общей спеки §4 «потеря устройства перестаёт быть потерей
 * истории» ровно наполовину — причём терялась половина не при потере
 * устройства, а при обычном F5.
 *
 * Здесь стенд настоящий: настоящий релеер со своим складом на диске,
 * настоящие кошельки, настоящий пропуск, настоящий движок переписки.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { deriveChatKeypair } from '../chatCrypto';
import type { ChatSession } from '../chatSession';

function signatureOf(marker: string): `0x${string}` {
  const body = marker.repeat(130).slice(0, 130).replace(/[^0-9a-f]/g, 'a');
  return `0x${body}` as `0x${string}`;
}

async function makeSession(marker: string, address: `0x${string}`): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(signatureOf(marker)),
    address, origin: 'signature', walletKind: 'eoa', restored: true, persisted: true,
  };
}

describe('К-1: своя половина переписки', () => {
  let stand: import('./chatStand').ChatStand;

  beforeAll(async () => {
    const { startChatStand } = await import('./chatStand');
    stand = await startChatStand();
    process.env.NEXT_PUBLIC_RELAYER_URL = stand.url;
    vi.resetModules();
  }, 60_000);

  afterAll(async () => {
    await stand?.stop();
    delete process.env.NEXT_PUBLIC_RELAYER_URL;
  });

  it('ЗАМЕР: после перезагрузки вкладки Алиса видит свои 2 из 2, а не 0 из 2', async () => {
    const transport = await import('../chatTransport');
    const session = await import('../../hooks/useChatSession');
    const pair = await import('../../hooks/usePairChat');

    const [aw, bw] = stand.wallets;
    const A = aw.address as `0x${string}`;
    const B = bw.address as `0x${string}`;
    const alice = await makeSession('a1ce', A);
    const bob = await makeSession('b0b7', B);

    const ap = await transport.requestBagPass(m => aw.signMessage(m), A);
    const bp = await transport.requestBagPass(m => bw.signMessage(m), B);
    await session.publishChatKeys(ap.pass, alice);
    await session.publishChatKeys(bp.pass, bob);

    // ─── Алиса пишет два сообщения настоящим движком ───
    const first = pair.startPairChat({
      session: alice, peer: B, getPass: async () => ap.pass,
      onState: () => {}, onError: () => {}, sleep: async () => new Promise(() => {}),
    });
    await first.send({ text: 'моё первое' });
    await first.send({ text: 'моё второе' });
    first.stop();

    // ─── «Закрыли и открыли вкладку»: свежий движок, память пуста ───
    const open = (s: ChatSession, peer: `0x${string}`, pass: string) =>
      new Promise<{ messages: { text: string; isFromMe: boolean }[]; gapAfterSeq: number[] }>(
        (resolve, reject) => {
          const e = pair.startPairChat({
            session: s, peer, getPass: async () => pass,
            // ⚠️ ЖДЁМ СНИМОК СО СКЛАДА (`synced`), а не первый попавшийся.
            // С тех пор как движок выдаёт снимок ДО пропуска (чтобы человек
            // не смотрел на «Настройка шифрования» минутами), первый снимок —
            // это «что нашлось на устройстве», и своей половины со СКЛАДА в
            // нём ещё нет. Замер без этого условия проверял бы пустоту.
            onState: (st) => {
              if (!(st as { synced?: boolean }).synced) return;
              e.stop(); resolve(st as never);
            },
            onError: (err) => { e.stop(); reject(err); },
          });
        },
      );

    const aliceAgain = await open(alice, B, ap.pass);
    expect(aliceAgain.messages.map(m => m.text)).toEqual(['моё первое', 'моё второе']);
    expect(aliceAgain.messages.every(m => m.isFromMe)).toBe(true);
    // Своя половина — не разрыв: обвинять собеседника здесь не в чем.
    expect(aliceAgain.gapAfterSeq).toEqual([]);

    // У Боба та же переписка, с другой стороны.
    const bobSide = await open(bob, A, bp.pass);
    expect(bobSide.messages.map(m => m.text)).toEqual(['моё первое', 'моё второе']);
    expect(bobSide.messages.every(m => m.isFromMe)).toBe(false);
  }, 120_000);

  it('память вкладки и склад не задваивают одно сообщение', async () => {
    // Живой движок держит свои отправленные в памяти И скачивает их же со
    // склада. Без дедупликации по ключу мешка одно сообщение показалось бы
    // дважды, а разбор цепочки дал бы `duplicate_seq` на честной переписке.
    const transport = await import('../chatTransport');
    const pair = await import('../../hooks/usePairChat');
    const [aw, bw] = stand.wallets;
    const A = aw.address as `0x${string}`;
    const B = bw.address as `0x${string}`;
    const alice = await makeSession('a1ce', A);
    const ap = await transport.requestBagPass(m => aw.signMessage(m), A);

    const states: { messages: { text: string }[]; troubles: unknown[] }[] = [];
    const engine = pair.startPairChat({
      session: alice, peer: B, getPass: async () => ap.pass,
      onState: (s) => { states.push(s as never); },
      onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 5)); },
    });
    try {
      await engine.send({ text: 'третье' });
      // Дать опросу пройти несколько кругов — мешок успевает приехать со
      // склада к уже лежащему в памяти.
      const started = Date.now();
      while (states.filter(s => (s as { synced?: boolean }).synced).length < 4
        && Date.now() - started < 20_000) {
        await new Promise(r => setTimeout(r, 50));
      }
    } finally {
      engine.stop();
    }

    const last = states[states.length - 1];
    const thirds = last.messages.filter(m => m.text === 'третье');
    expect(thirds).toHaveLength(1);
    expect(last.messages.map(m => m.text)).toEqual(['моё первое', 'моё второе', 'третье']);
    expect(last.troubles).toEqual([]);
    expect(bw.address).toBeTruthy();
  }, 120_000);

  it('дыра в СВОЕЙ цепочке НЕ становится обвинением собеседнику', async () => {
    // `gapAfterSeq` читается интерфейсом как «здесь собеседник чего-то не
    // предъявил» и рисуется значком разрыва. Своя половина теперь тоже
    // проверяется цепочкой — значит собственная пропажа (мешок истёк на
    // складе, отправка оборвалась на сгоревшем номере) попала бы в тот же
    // плоский список и обвинила бы невиновного.
    const transport = await import('../chatTransport');
    const conv = await import('../chatConversation');
    const { ethers } = await import('ethers');

    const [aw] = stand.wallets;
    const A = aw.address as `0x${string}`;
    const dave = ethers.Wallet.createRandom();
    const D = dave.address as `0x${string}`;
    const alice = await makeSession('a1ce', A);
    const daveSession = await makeSession('dead', D);
    const ap = await transport.requestBagPass(m => aw.signMessage(m), A);

    // Три своих звена подряд, второе — вырезано со склада.
    const sent = [];
    let prev = null;
    for (let i = 0; i < 3; i++) {
      const m = await conv.sendMessage(
        alice, D, daveSession.keypair.publicKey, { text: `своё ${i}` }, prev, { pass: ap.pass },
      );
      sent.push(m);
      prev = m.link;
    }
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    fsMod.default.unlinkSync(pathMod.default.join(stand.storageDir, 'bags', sent[1].key));

    const list = await transport.listBags(ap.pass);
    const bags = [];
    for (const b of list.inbox) {
      if (!b.key.toLowerCase().startsWith(D.toLowerCase())) continue;
      const body = await transport.fetchBag(ap.pass, b.key);
      if (body) bags.push({ key: b.key, sender: b.sender, uploadedAt: b.uploadedAt, body });
    }
    const state = await conv.receiveBags(alice, bags, { peer: D });

    // Показано два из трёх — дыра настоящая.
    expect(state.messages.map(m => m.payload.text)).toEqual(['своё 0', 'своё 2']);
    // …и она НАЗВАНА, но с автором — со мной.
    expect(state.gaps).toEqual([{ from: A.toLowerCase(), afterSeq: 0 }]);
    // …а плоский список, по которому рисуется значок, ПУСТ: обвинять
    // собеседника нечем и не в чем.
    expect(state.gapAfterSeq).toEqual([]);
  }, 120_000);

  it('своё, написанное ДРУГОМУ, в эту переписку не попадает', async () => {
    // Отбор своих мешков идёт по получателю, а получатель живёт в ключе
    // мешка (`<получатель>/<файл>`). Без этого отбора переписка с Бобом
    // показывала бы написанное Кэрол — ровно та ошибка, которую Задача 5 уже
    // ловила на своей половине разговора.
    const transport = await import('../chatTransport');
    const conv = await import('../chatConversation');
    const pair = await import('../../hooks/usePairChat');
    const { ethers } = await import('ethers');

    const [aw] = stand.wallets;
    const A = aw.address as `0x${string}`;
    const carol = ethers.Wallet.createRandom();
    const C = carol.address as `0x${string}`;
    const alice = await makeSession('a1ce', A);
    const carolSession = await makeSession('ca01', C);
    const ap = await transport.requestBagPass(m => aw.signMessage(m), A);

    // ⚠️ НОМЕРА РАЗВЕДЕНЫ НАМЕРЕННО. Первая версия этой заготовки слала Кэрол
    // ОДНО сообщение, и оно получало номер 0 — тот же, что у первого
    // сообщения Бобу. Лишнее выбрасывалось как ДУБЛЬ НОМЕРА, а не отбором по
    // получателю, чьё имя стоит в названии теста: мутация «снять проверку
    // получателя» выживала, 4 из 4 зелёных. Зонд с несовпадающим номером
    // показывал чужое сообщение в переписке — то есть свойство в коде было
    // верным, а замка не было вовсе.
    //
    // Шлём столько, чтобы последнее заведомо ушло за пределы номеров
    // переписки с Бобом, и проверяем ИМЕННО ЕГО.
    let lastToCarol!: Awaited<ReturnType<typeof conv.sendMessage>>;
    for (let i = 0; i < 6; i++) {
      lastToCarol = await conv.sendMessage(
        alice, C, carolSession.keypair.publicKey, { text: `это Кэрол ${i}` }, null, { pass: ap.pass },
      );
    }
    // Замок на саму заготовку: если номера снова сойдутся, тест обязан
    // покраснеть ЗДЕСЬ, а не притвориться зелёным ниже.
    expect(lastToCarol.link.seq).toBeGreaterThanOrEqual(5);

    const [, bw] = stand.wallets;
    const seen = await new Promise<{ messages: { text: string }[] }>((resolve, reject) => {
      const e = pair.startPairChat({
        session: alice, peer: bw.address as `0x${string}`, getPass: async () => ap.pass,
        onState: (s) => {
          if (!(s as { synced?: boolean }).synced) return;
          e.stop(); resolve(s as never);
        },
        onError: (err) => { e.stop(); reject(err); },
      });
    });
    const texts = seen.messages.map(m => m.text);
    // Ни одного из шести — и особенно последнего, чей номер с перепиской
    // Боба не пересекается ничем.
    expect(texts).not.toContain(`это Кэрол ${5}`);
    expect(texts.filter(t => t.startsWith('это Кэрол'))).toEqual([]);
    expect(texts).toContain('моё первое');
  }, 120_000);
});
