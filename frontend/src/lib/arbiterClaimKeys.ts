import type { Address, Hex } from 'viem';
import { openSession, type SignChatKey, type ChatSession } from '@/lib/chatSession';
import { deriveLinkSigningKeypair } from '@/lib/chatConversation';
import { toKeyHex } from '@/lib/chatDirectoryTypes';
import { noteWalletHandoff, isSignatureDeferred } from '@/lib/chatSignatureGate';

/**
 * Добыча открытых половин ключей чата арбитра для транзакции заявки на спор.
 *
 * Отделено от разметки страницы намеренно: сюда можно приехать тестом, а в
 * обработчик нажатия — нет.
 *
 * ⚠️ Ключ добывается ТОЛЬКО по действию арбитра, никогда на входе на страницу.
 * Решение владельца 9 августа: «никаких заранее быть не может». Поэтому здесь
 * нет и не должно быть реактивного хука — только явный вызов.
 */

// Константа нуля одна на весь фронт — берём из Задачи 3, своей не заводим.
export { ZERO_KEY } from '@/lib/arbiterChatKey';
import { ZERO_KEY } from '@/lib/arbiterChatKey';

function keyToHex(bytes: Uint8Array): Hex {
  const hex = toKeyHex(bytes);
  return (hex.startsWith('0x') ? hex : '0x' + hex) as Hex;
}

/** Обе открытые половины из уже открытой сессии. Окон кошелька не просит. */
export async function claimKeysFromSession(
  session: ChatSession,
): Promise<{ boxKey: Hex; signKey: Hex }> {
  const boxKey = keyToHex(session.keypair.publicKey);
  // Ключ подписи выводится из ЗАКРЫТОЙ половины X25519-пары отдельным
  // контекстом — это НЕ тот же ключ, что boxKey.
  const link = await deriveLinkSigningKeypair(session.keypair);
  const signKey = keyToHex(link.publicKey);
  return { boxKey, signKey };
}

/**
 * Есть ли ключ на этом устройстве — БЕЗ окна кошелька.
 * `createIfMissing: false` означает «прочитай, но не заводи».
 */
export async function hasLocalChatKeys(
  address: Address,
  signTypedData: SignChatKey,
): Promise<boolean> {
  try {
    const session = await openSession(address, signTypedData, { createIfMissing: false });
    return !!session?.keypair?.publicKey?.length;
  } catch {
    return false;
  }
}

/**
 * Ключи для заявки. Если на устройстве ключа нет — просит ОДНО окно подписи,
 * и только здесь, в момент, когда арбитр уже нажал и потратил ход.
 */
export async function deriveClaimChatKeys(
  address: Address,
  signTypedData: SignChatKey,
): Promise<{ boxKey: Hex; signKey: Hex }> {
  const session = await openSession(address, signTypedData, { createIfMissing: true });
  return claimKeysFromSession(session);
}

/* ───────────────── подписывающая обёртка с отметкой ухода ─────────────── */

/**
 * Оборачивает подписывающую функцию так, чтобы КАЖДЫЙ вызов сначала отмечал
 * уход к кошельку (`noteWalletHandoff`), и только потом звал настоящего
 * подписчика.
 *
 * ⚠️ ПОРЯДОК — ГАРАНТИЯ ФАЙЛА, НЕ СОВПАДЕНИЕ. Гейт подписи
 * (`chatSignatureGate.ts`) решает по факту «мы уходили к кошельку», а этот
 * факт взводится ИСКЛЮЧИТЕЛЬНО отметкой `noteWalletHandoff()`. Отметка ПОСЛЕ
 * подписи (или вовсе без вызова) делает `requireSignatureGate(false)`
 * пустышкой: синтаксически стоит там, где надо, а порог всегда отвечает
 * «можно» — телефонный баг 8 августа возвращается ровно так, и структурный
 * тест по тексту файла этого не видит (замер ревьюера: 0 красных из 1804
 * при снятой отметке и оставленном на месте вызове гейта).
 *
 * Вынесено отдельной функцией, а не строкой в компоненте, СПЕЦИАЛЬНО ради
 * теста: страница не рендерится (нет jsdom), а сюда можно приехать напрямую
 * с подставными `markHandoff`/`sign` и проверить ПОРЯДОК вызовов по факту
 * исполнения — не по тексту между двумя строками. Страница обязана звать
 * ИМЕННО эту функцию, а не повторять приём своими руками: замок на функцию,
 * которой никто не пользуется, ничего не доказывает.
 */
export function createGatedSignChatKey(
  sign: SignChatKey,
  markHandoff: () => void = noteWalletHandoff,
): SignChatKey {
  return async (typedData) => {
    markHandoff();
    return sign(typedData);
  };
}

/* ─────────────── решение по неудавшемуся reveal быстрого пути ─────────── */

/**
 * Неудавшийся reveal (`claimDisputeGasless` после уже найденной соли,
 * коммит был раньше) — повод начать всё заново СВЕЖИМ коммитом, или просто
 * отсрочка гейта подписи, после которой соль и коммит остаются валидны и
 * нужно только повторное нажатие?
 *
 * Отсрочка (`ChatSignatureDeferred`) — единственный случай с ответом «нет»:
 * коммит не протух, дело не в контракте — страница уходила к кошельку, и
 * гейт попросил нажать ещё раз. Трактовать её как «начинаем заново» стёрло
 * бы валидную соль и сожгло бы новую коммит-транзакцию за то, что человек
 * ничего не сделал не так («нажмите ещё раз» тихо стало бы «заплатите за
 * новый коммит»).
 *
 * Вынесено чистым предикатом ради теста по той же причине, что и
 * `createGatedSignChatKey` выше: страница зовёт эту функцию, а не решение,
 * переписанное заново внутри `catch`.
 */
export function canRetryRevealAsFreshCommit(err: unknown): boolean {
  return !isSignatureDeferred(err);
}
