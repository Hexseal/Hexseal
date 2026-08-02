import { keccak256 } from 'viem';

/** Фраза, которую подписывает кошелёк. Версия в имени — чтобы будущая смена
 *  схемы была явной, а не молчаливой сменой ключа у всех сразу. */
export const CHAT_KEY_MESSAGE = 'hexseal.chat.key.v1';

export type ChatKeypair = { publicKey: Uint8Array; privateKey: Uint8Array };

/**
 * Подпись — 65 байт и распределена неравномерно, поэтому ключом быть не
 * может. Хешируем в 32 байта и подаём как семя. Регистр приводим к нижнему:
 * кошельки отдают hex по-разному, а ключ обязан получаться один.
 *
 * `libsodium-wrappers` импортируется только динамически (`await import`) —
 * статический импорт кладёт ~147 КБ gzip в общий чанк сборки Next
 * (docs/superpowers/reports/2026-08-02-chat-crypto-library-choice.md, §6).
 */
export async function deriveChatKeypair(signature: `0x${string}`): Promise<ChatKeypair> {
  const seedHex = keccak256(signature.toLowerCase() as `0x${string}`);
  const seed = Uint8Array.from(
    (seedHex.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)),
  );

  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;

  const { publicKey, privateKey } = sodium.crypto_box_seed_keypair(seed);
  return { publicKey, privateKey };
}
