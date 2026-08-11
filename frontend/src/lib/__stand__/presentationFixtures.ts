/**
 * presentationFixtures.ts — оснастка предъявления переписки арбитру.
 *
 * ⚠️ ЗАЧЕМ ОБЩАЯ. Двум замерам (обычному и стендовому) нужны одни и те же
 * актёры, одни и те же кадры и одни и те же заверения кошельком. Две копии
 * этого кода разошлись бы молча — ровно причина, по которой в репозитории
 * появился общий `fakeChatDisk.ts` (см. его шапку, строки 4-10).
 *
 * ⚠️ `vitest` ЗДЕСЬ НЕ ИМПОРТИРУЕТСЯ. Раннер лежит в `../relayer/node_modules`
 * и `npm run type-check` его не видит (та же причина и тот же обход описаны в
 * `chatStand.ts:178-195`). Ничего из этого файла не зависит от раннера. Именно
 * поэтому здесь же лежат ТИП-ЗАМКИ на стык с задачей 5: файл не тест, значит
 * проверка типов на него смотрит (см. блок ниже).
 *
 * ⚠️ ПОДПИСЬ КОШЕЛЬКА ЗДЕСЬ НАСТОЯЩАЯ. Заверение (задача 1) — это EIP-712
 * подпись, и проверяет её `verifyChatKeyAttestation` восстановлением адреса.
 * Синтетическая строка нужной формы (обычный приём тестов чата,
 * `chatConversation.test.ts:50-70`) здесь НЕ подойдёт: восстановленный из неё
 * адрес будет случайным, и замер мерил бы отказ вместо согласия. Поэтому
 * поддельный viem-клиент подписывает НАСТОЯЩИМ ethers-кошельком, а типы
 * подписываемых данных берутся из вызова — то есть оснастка не знает и не
 * повторяет схему задачи 1, а значит и не может с ней разойтись.
 */
import { ethers } from 'ethers';
import type { WalletClient } from 'viem';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import { buildPresentation } from '@/lib/presentation';
import { packEnvelope } from '@/lib/chatEnvelope';
import { buildLink, type ChainLink } from '@/lib/chatChain';
import {
  deriveLinkSigningKeypair, linkSignaturePreimage, messageBodyHash, encodeFrame,
  archiveConversationFrames, readConversationArchive, type ArchivedFrame,
} from '@/lib/chatConversation';
import type { ChatSession } from '@/lib/chatSession';
import { signChatKeyAttestation, type ChatKeyAttestation } from '@/lib/chatKeyAttestation';

/* ─────────── ТИП-ЗАМКИ НА СТЫК С ЗАДАЧЕЙ 5 (лежат ЗДЕСЬ не случайно) ───────────
 *
 * ⚠️ `npm run type-check` НЕ ВИДИТ `*.test.ts` — они исключены из программы tsc
 * (`frontend/tsconfig.json`, вместе с причиной: у фронта нет своего раннера).
 * Значит тип-замок, поставленный в тесте, зеленел бы ВСЕГДА. Этот файл — не тест
 * (`vitest` в нём не импортируется), и он в программе, поэтому два договорных
 * стыка запирает форма, а не договорённость:
 *
 *  1. `peer` во входе сборщика ОБЯЗАТЕЛЕН (исправление 6);
 *  2. отказ `too_large` НЕСЁТ ЧИСЛО влезающих (исправление 11) — иначе
 *     `fittingMessageCount` пришлось бы считать самой, то есть завести второй счёт.
 *
 * ⚠️ ШЕСТНАДЦАТЫЙ СЛУЧАЙ «замка, который зеленеет сам по себе» — БЫЛ ЗДЕСЬ, и он
 * мой. Прежняя запись второго замка выглядела так:
 *
 *     type TooLargeRefusal = Extract<BuildResult, { reason: 'too_large' }>;
 *     export const tooLargeCarriesFits: TooLargeRefusal['fits'] extends number ? true : never = true;
 *
 * Отказ задачи 5 был ПЛОСКИМ (`{ ok: false; reason: BuildFailure }`), а союз
 * литералов не присваивается литералу `'too_large'`: `Extract` схлопывался в
 * `never`, `never['fits']` — тоже `never`, и `never extends number ? true : never`
 * вычислялось в `true`. Замок проходил при ЛЮБОМ отказе, в том числе при отказе
 * без `fits` вовсе — это ЗАМЕРЕНО на `tsc 5.9.2` этого репозитория: прежняя
 * запись на плоском отказе даёт `exit 0`, ноль ошибок (разбор — шаг 8, мутация
 * 18). Договор v3 сделал отказ размеченным союзом, а запись ниже —
 * такой, которую в `never` схлопнуть нечем: число берётся ПОСЛЕ СУЖЕНИЯ по
 * `reason === 'too_large'`, тем же способом, каким его берёт боевой
 * `fittingMessageCount`, и без `!` — восклицательный знак сам и есть способ
 * пройти проверку типов при отсутствующем поле.
 *
 * Убери поле из задачи 5 — и `type-check` покраснеет ЗДЕСЬ, до единого замера
 * (мутации 16, 17 и 18).
 */
type BuildInput = Parameters<typeof buildPresentation>[0];
type BuildResult = Awaited<ReturnType<typeof buildPresentation>>;

/** `never`, если `peer` стал необязательным: тогда вход без него — тоже вход. */
export const peerIsRequired: Omit<BuildInput, 'peer'> extends BuildInput ? never : true = true;

/**
 * ТИП-ЗАМОК НА `fits`, который нельзя схлопнуть в `never`, — и заодно рабочая
 * функция: тот же ответ, взятый формой, сверяется в замере с числом из отказа.
 *
 * Возврат объявлен `number | null` НАРОЧНО. Что покраснеет:
 *  - поля `fits` не стало вовсе → `TS2339` на `result.fits`;
 *  - поле стало `fits?: number` → `TS2322`: `number | undefined` не присваивается
 *    `number | null`;
 *  - отказ снова расклеили в плоский `{ ok: false; reason: BuildFailure }` →
 *    сужение по литералу не даёт члена с `fits`, снова `TS2339`.
 *
 * Ни одного `as`, ни одного `!`: у замка нет способа согласиться молча.
 */
export function fitsFromRefusal(result: BuildResult): number | null {
  if (result.ok) return null;
  if (result.reason !== 'too_large') return null;
  return result.fits;
}

export interface Actor {
  /** Адрес С КОНТРОЛЬНОЙ СУММОЙ — ровно как отдаёт `useAccount()`. */
  address: `0x${string}`;
  wallet: ethers.Wallet;
  session: ChatSession;
  /** Поддельный по форме, настоящий по подписи. */
  walletClient: WalletClient;
  /** Сколько раз этого человека спросили кошельком. */
  prompts: () => number;
}

/** Настоящая по форме ECDSA-подпись: 0x + 130 hex-цифр. `deriveChatKeypair`
 *  проверяет форму на исполнении, '0xdeadbeef' не доедет. */
function chatKeySignature(marker: string): `0x${string}` {
  const body = marker.repeat(130).slice(0, 130).replace(/[^0-9a-f]/g, 'a');
  return `0x${body}` as `0x${string}`;
}

export async function makeActor(privateKeyHex: string, marker: string): Promise<Actor> {
  const wallet = new ethers.Wallet(privateKeyHex);
  const address = wallet.address as `0x${string}`;
  const keypair = await deriveChatKeypair(chatKeySignature(marker));
  const session: ChatSession = {
    keypair, address, origin: 'signature', walletKind: 'eoa', restored: true, persisted: true,
  };
  let prompts = 0;

  const client = {
    account: { address, type: 'json-rpc' as const },
    getAddresses: async () => [address],
    signMessage: async ({ message }: { message: string | { raw: `0x${string}` } }) => {
      prompts++;
      const payload = typeof message === 'string' ? message : ethers.getBytes(message.raw);
      return (await wallet.signMessage(payload)) as `0x${string}`;
    },
    signTypedData: async (args: {
      domain?: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) => {
      prompts++;
      // ethers добавляет EIP712Domain сам и падает, если его передать явно.
      const types = { ...args.types };
      delete (types as Record<string, unknown>).EIP712Domain;
      return (await wallet.signTypedData(
        (args.domain ?? {}) as ethers.TypedDataDomain,
        types as unknown as Record<string, ethers.TypedDataField[]>,
        args.message,
      )) as `0x${string}`;
    },
  };

  return { address, wallet, session, walletClient: client as unknown as WalletClient, prompts: () => prompts };
}

export async function attestationOf(actor: Actor): Promise<ChatKeyAttestation> {
  return signChatKeyAttestation(actor.walletClient, actor.session);
}

export interface ForgedFrame {
  seq: number;
  from: `0x${string}`;
  sentAt: number;
  frame: Uint8Array;
}

/**
 * Собирает цепочку кадров ключом самого отправителя — так, как собрал бы он
 * сам. Ничего «не того» здесь нет: каждое звено подписано законным владельцем
 * ключа и сцеплено с предыдущим (та же процедура, что `forgeChain` в
 * `chatConversation.test.ts:594-620`, и тот же вывод: без внешнего якоря
 * результат неотличим от честной переписки).
 */
export async function forgeFrames(
  from: Actor, to: Actor, texts: readonly string[], startAt = 1_754_400_000_000,
): Promise<ForgedFrame[]> {
  const signer = await deriveLinkSigningKeypair(from.session.keypair);
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const out: ForgedFrame[] = [];
  let prev: ChainLink | null = null;
  for (const [i, text] of texts.entries()) {
    const envelope = await packEnvelope(
      { text }, to.session.keypair.publicKey, from.session.keypair.publicKey,
      from.address.toLowerCase() as `0x${string}`,
    );
    const link = buildLink(
      prev, messageBodyHash(signer.publicKey, envelope), from.address, startAt + i * 1000,
    );
    out.push({
      seq: link.seq,
      from: from.address.toLowerCase() as `0x${string}`,
      sentAt: link.sentAt,
      frame: encodeFrame({
        link,
        signature: sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey),
        signerPublicKey: signer.publicKey,
        envelope,
      }),
    });
    prev = link;
  }
  return out;
}

/**
 * Кладёт кадры в АРХИВ УСТРОЙСТВА и возвращает число кадров, прочитанных
 * обратно.
 *
 * ⚠️ Архив — единственный склад кадров, откуда сборщик их берёт: во входе
 * `buildPresentation` кадров нет вовсе. Возврат числа тут не украшение:
 * если посев не лёг (поддельный диск не поставлен, память архива протекла
 * между кейсами), замер обязан упасть ЗДЕСЬ, на посеве, а не превратиться в
 * загадочный вердикт сборщика.
 */
export async function seedArchive(
  own: Actor, peer: Actor, frames: readonly ForgedFrame[],
): Promise<number> {
  const archived: ArchivedFrame[] = frames.map((f, i) => ({
    key: `${peer.address.toLowerCase()}/${1_754_400_100_000 + i}-${String(i).padStart(4, '0')}.bin`,
    from: f.from,
    seq: f.seq,
    sentAt: f.sentAt,
    receivedAt: f.sentAt + 500,
    frame: f.frame,
  }));
  await archiveConversationFrames(own.address, peer.address, archived);
  return (await readConversationArchive(own.address, peer.address)).length;
}
