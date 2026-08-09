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

declare const BOX_KEY: unique symbol;
declare const SIGN_KEY: unique symbol;

/**
 * Открытая половина ключа ШИФРОВАНИЯ (box) арбитра — фирменный (nominal) тип,
 * не структурный. Тот же приём, что `GatedSignChatKey` в arbiterClaimKeys.ts.
 *
 * ⚠️ ПОЧЕМУ ЭТО ФИРМЕННЫЙ ТИП, А НЕ ПРОСТО `Hex`. И BoxKey, и SignKey под
 * капотом — обычный `Hex` (bytes32), структурно неотличимы друг от друга.
 * Независимое ревью Задачи 5 переставило аргументы в реальном вызове —
 * `setArbiterChatKeyGasless(walletClient, publicClient, keys.signKey,
 * keys.boxKey)` — и получило 0 красных из 1826, тип-чекер чист: замок ABI
 * (claimAbiMatchesContract.test.ts) защищает ОБЪЯВЛЕНИЕ функции, а не то, что
 * ВЫЗЫВАЮЩИЙ передал ключи в правильном порядке. Это хуже отсутствия ключа:
 * транзакция проходит, в цепи лежат два ненулевых ключа, decideNoKeyNotice
 * видит их и замолкает НАВСЕГДА, а сторона на предъявлении получает
 * нечитаемое — печать на ключ подписи вместо ключа шифрования.
 *
 * Приводить обычный Hex к этому типу можно только через toBoxKey() ниже —
 * единственная точка приведения. После этого перестановка с SignKey уже не
 * компилируется: не «ловится тестом», а невозможна.
 */
export type BoxKey = Hex & { readonly [BOX_KEY]: true };

/** Симметричная защита для второй половины пары. См. BoxKey выше. */
export type SignKey = Hex & { readonly [SIGN_KEY]: true };

/**
 * Единственная точка приведения Hex → BoxKey во всём фронте. Рантайм ничего
 * не проверяет (клеймо существует только для тип-чекера) — сюда приходят
 * СТРОГО со стороны, которая уже знает, что это ключ ШИФРОВАНИЯ: либо из
 * локальной сессии (claimKeysFromSession, arbiterClaimKeys.ts), либо из
 * чтения цепи (readArbiterChatKeysFromChain ниже).
 */
export function toBoxKey(hex: Hex): BoxKey {
  return hex as BoxKey;
}

/** Симметрично toBoxKey — единственная точка приведения Hex → SignKey. */
export function toSignKey(hex: Hex): SignKey {
  return hex as SignKey;
}

export type DirectoryVerdict =
  | 'agree'              // справочник согласен с цепью
  | 'directory_missing'  // справочник не знает ключа — он просто отстал, это не тревога
  | 'directory_differs'  // ⚠️ справочник называет ДРУГОЙ ключ
  | 'chain_missing';     // в цепи ключа нет — предъявлять некому, справочник не спасает

export interface ChainChatKeys {
  boxKey: BoxKey;
  signKey: SignKey;
  /** false означает «в цепи ключей нет» — для предъявления это «некому». */
  present: boolean;
}

export async function readArbiterChatKeysFromChain(
  publicClient: PublicClient,
  arbiter: Address,
): Promise<ChainChatKeys> {
  const [boxKeyRaw, signKeyRaw] = (await publicClient.readContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'getArbiterChatKeys',
    args: [arbiter],
  })) as [Hex, Hex];

  // ТОЧКА ДОВЕРИЯ: единственное место, где два Hex, вернувшиеся с чтения
  // цепи, помечаются как BoxKey/SignKey — в ТОМ порядке, в котором их
  // объявляет исходник контракта (`getArbiterChatKeys` returns (bytes32
  // boxKey, bytes32 signKey), проверено claimAbiMatchesContract.test.ts).
  // Дальше по коду перестановка местами уже не пройдёт тип-чекер.
  const boxKey = toBoxKey(boxKeyRaw);
  const signKey = toSignKey(signKeyRaw);

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

/**
 * Показывать ли человеку расхождение справочника с цепью.
 *
 * Решение владельца 9 августа: расхождение ОБЯЗАНО быть проговорено — иначе
 * о подмене ключа на нашем сервере мы не узнаем никогда. Но не при любом
 * вердикте:
 *
 *  - `directory_differs` — единственный случай, когда говорим. Справочник
 *    называет ДРУГОЙ ключ, чем записан в цепи: либо он отстал от старой
 *    публикации какой-то другой стороной, либо сервер подменили.
 *  - `directory_missing` — НЕ тревога, справочник просто ещё не знает ключа
 *    (устройство новое, запись не долетела). Молчим.
 *  - `chain_missing` — говорить нечего ПРО РАСХОЖДЕНИЕ: ключа в цепи нет
 *    вовсе, это другое уведомление (`decideNoKeyNotice` выше).
 *  - `agree` — сходится, молчим.
 *  - `null` — вердикт ещё не посчитан (страница только открылась либо чтение
 *    цепи не удалось) — молчим, а не гадаем.
 */
export function decideDirectoryDivergenceNotice(verdict: DirectoryVerdict | null): boolean {
  return verdict === 'directory_differs';
}
