import type { Address, Hex } from 'viem';
import { openSession, type SignChatKey, type ChatSession } from '@/lib/chatSession';
import { deriveLinkSigningKeypair } from '@/lib/chatConversation';
import { toKeyHex } from '@/lib/chatDirectoryTypes';

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
