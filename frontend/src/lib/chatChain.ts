import { keccak256, encodePacked } from 'viem';

export type ChainLink = {
  seq: number;
  prevHash: `0x${string}`;
  bodyHash: `0x${string}`;
  sender: `0x${string}`;
  sentAt: number;
};

/** Отпечаток «предыдущего» у самого первого звена. Отдельная константа, а не
 *  нули: нулевой хеш легко получить случайно, а генезис должен быть намеренным. */
export const GENESIS_HASH = keccak256(
  new TextEncoder().encode('hexseal.chat.chain.genesis.v1'),
);

/** Отпечаток звена. В него входят ВСЕ поля: подмена любого обязана рвать
 *  связь со следующим звеном, иначе вырезанное сообщение можно было бы
 *  заменить другим того же размера. */
export function linkHash(link: ChainLink): `0x${string}` {
  return keccak256(
    encodePacked(
      ['uint256', 'bytes32', 'bytes32', 'address', 'uint256'],
      [BigInt(link.seq), link.prevHash, link.bodyHash, link.sender, BigInt(link.sentAt)],
    ),
  );
}

export function buildLink(
  prev: ChainLink | null,
  bodyHash: `0x${string}`,
  sender: `0x${string}`,
  sentAt: number,
): ChainLink {
  return {
    seq: prev ? prev.seq + 1 : 0,
    prevHash: prev ? linkHash(prev) : GENESIS_HASH,
    bodyHash,
    sender: sender.toLowerCase() as `0x${string}`,
    sentAt,
  };
}
