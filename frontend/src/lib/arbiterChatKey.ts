import type { Address, Hex, PublicClient } from 'viem';
import type { Abi } from 'viem';
import { ARBITER_REGISTRY_ABI, CONTRACTS } from '@/config/contracts';
import { toKeyHex } from '@/lib/chatDirectoryTypes';

/**
 * Ключи чата арбитра читаются ИЗ ЦЕПИ, а не из справочника на релеере.
 *
 * Почему: справочник живёт на нашем сервере, и тот, кто до сервера добрался
 * (включая владельца), подсунул бы свой ключ вместо ключа арбитра и прочитал бы
 * ВСЕ предъявления по ВСЕМ спорам, ничем себя не выдав. В цепи ключ пишет сам
 * арбитр своей транзакцией.
 *
 * Справочник остаётся только свидетелем: если он назовёт другой ключ, мы об этом
 * говорим (решение владельца 9 августа), потому что иначе о подмене не узнаем
 * никогда.
 */

export const ZERO_KEY = ('0x' + '00'.repeat(32)) as Hex;

export type DirectoryVerdict =
  | 'agree'              // справочник согласен с цепью
  | 'directory_missing'  // справочник не знает ключа — он просто отстал, это не тревога
  | 'directory_differs'  // ⚠️ справочник называет ДРУГОЙ ключ
  | 'chain_missing';     // в цепи ключа нет — предъявлять некому, справочник не спасает

export interface ChainChatKeys {
  boxKey: Hex;
  signKey: Hex;
  /** false означает «в цепи ключей нет» — для предъявления это «некому». */
  present: boolean;
}

export async function readArbiterChatKeysFromChain(
  publicClient: PublicClient,
  arbiter: Address,
): Promise<ChainChatKeys> {
  const [boxKey, signKey] = (await publicClient.readContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'getArbiterChatKeys',
    args: [arbiter],
  })) as [Hex, Hex];

  // Нули означают «ключей нет»: запись нулевого ключа контракт отвергает
  // (ZeroChatKey), поэтому различать «нет записи» и «записан нуль» незачем.
  const present = boxKey !== ZERO_KEY && signKey !== ZERO_KEY;
  return { boxKey, signKey, present };
}

/**
 * Показывать ли дисклеймер «вам не смогут предъявить».
 *
 * ⚠️ Отказ чтения — это НЕ «ключа нет». До разреза даймонда getArbiterChatKeys
 * в нём отсутствует, и чтение ревертит; трактовать это как отсутствие ключа
 * значило бы показать дисклеймер всем и предложить кнопку, которая не сработает
 * (setArbiterChatKey в даймонде ещё тоже нет). «Не знаем» → молчим.
 */
export function decideNoKeyNotice(input: {
  keys: readonly [Hex, Hex] | undefined;
  error: unknown;
}): boolean {
  if (input.error) return false;
  if (!input.keys) return false;
  return input.keys[0] === ZERO_KEY || input.keys[1] === ZERO_KEY;
}

export function compareChainWithDirectory(
  chain: { boxKey: Hex; signKey: Hex },
  directory: { boxKey: Uint8Array; signKey: Uint8Array | null } | null,
): DirectoryVerdict {
  if (chain.boxKey === ZERO_KEY || chain.signKey === ZERO_KEY) {
    // Решает цепь. Даже если справочник что-то знает — брать оттуда нельзя:
    // ровно этого доверия мы и уходили.
    return 'chain_missing';
  }
  if (!directory) return 'directory_missing';

  const dirBox = ('0x' + toKeyHex(directory.boxKey).replace(/^0x/, '')) as Hex;
  if (dirBox.toLowerCase() !== chain.boxKey.toLowerCase()) return 'directory_differs';

  if (!directory.signKey) return 'directory_missing';
  const dirSign = ('0x' + toKeyHex(directory.signKey).replace(/^0x/, '')) as Hex;
  if (dirSign.toLowerCase() !== chain.signKey.toLowerCase()) return 'directory_differs';

  return 'agree';
}
