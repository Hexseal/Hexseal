import { keccak256, encodePacked, isAddress } from 'viem';

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

export type ChainVerdict =
  | { ok: true }
  | { ok: false; reason: 'gap'; missingAfterSeq: number[] }
  | { ok: false; reason: 'broken'; atSeq: number }
  | { ok: false; reason: 'unordered' };

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function isBytes32Hex(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && BYTES32_RE.test(value);
}

/** Number.isSafeInteger, а не Number.isInteger: encodePacked(['uint256'])
 *  бросает IntegerOutOfRangeError далеко до границы uint256 — уже на числах,
 *  которые JS не может представить точно (Number.isInteger(1e100) === true,
 *  но это не то целое число, которым кажется). Заодно закрывает зону 2^53,
 *  где x+1 === x. */
function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Звено «в форме» — ровно то, что не даст linkHash бросить исключение
 *  (encodePacked внутри него требует: адрес — проходящий isAddress, оба
 *  хеша — ровно 32 байта строкой, seq/sentAt — целые неотрицательные, иначе
 *  BigInt()/encodePacked бросают RangeError/IntegerOutOfRangeError). Не
 *  переиспользуем viem.size() для длины хеша: на нечётном числе hex-символов
 *  она округляет вверх и врёт, что 63 символа — это 32 байта, тогда как
 *  encodePacked всё равно бросает («bytes31.5»). Точный regexp — надёжнее. */
function isWellFormedLink(link: unknown): link is ChainLink {
  if (typeof link !== 'object' || link === null) return false;
  const l = link as Record<string, unknown>;
  return (
    isSafeNonNegativeInt(l.seq) &&
    isBytes32Hex(l.prevHash) &&
    isBytes32Hex(l.bodyHash) &&
    typeof l.sender === 'string' && isAddress(l.sender) &&
    isSafeNonNegativeInt(l.sentAt)
  );
}

/** Номер для отчёта о негодном звене. Если seq хоть как-то похож на число —
 *  сообщаем его как есть (дробный/отрицательный тоже валиден как значение
 *  atSeq: number, это по-прежнему осмысленный указатель на место поломки).
 *  Если seq вообще не число — сообщаем позицию в предъявленном массиве. */
function reportedSeqFor(link: unknown, index: number): number {
  if (typeof link === 'object' && link !== null) {
    const seq = (link as Record<string, unknown>).seq;
    if (typeof seq === 'number') return seq;
  }
  return index;
}

/** Проверяет предъявленную цепочку.
 *
 *  Звенья приходят от противной стороны спора — это не тот код, что строит
 *  buildLink. Форма проверяется ПЕРВЫМ делом, до какой-либо арифметики над
 *  seq и до вызова linkHash: искажённый seq (дробный, отрицательный,
 *  вообще не число) иначе тихо просочился бы в сравнения `seq <= prevSeq`
 *  и `seq !== prevSeq + 1`, которые не бросают на мусоре — просто дают
 *  случайный числовой результат. Это скрыло бы подделку под honest-омиссию
 *  (gap), а мусор — это фальсификация формы, ближе по духу к broken.
 *  Дальше порядок проверок как в спеке: порядок → пропуски → связность.
 *  Пропуск обязан быть найден ДО связности — у предъявленного подмножества
 *  отпечатки заведомо не сойдутся, и без этой очерёдности всякое умолчание
 *  выглядело бы подделкой. Разница между «скрыл» и «сфальсифицировал» —
 *  это разница между минусом в репутацию и полным недоверием к
 *  предъявленному. */
export function verifyChain(links: ChainLink[]): ChainVerdict {
  // Мусором может быть не только звено внутри массива, но и сам массив —
  // JSON.parse чужого ответа с лёгкостью даёт {} или null вместо [].
  if (!Array.isArray(links)) return { ok: false, reason: 'broken', atSeq: -1 };

  if (links.length === 0) return { ok: true };

  for (let i = 0; i < links.length; i++) {
    if (!isWellFormedLink(links[i])) {
      return { ok: false, reason: 'broken', atSeq: reportedSeqFor(links[i], i) };
    }
  }

  for (let i = 1; i < links.length; i++) {
    if (links[i].seq <= links[i - 1].seq) return { ok: false, reason: 'unordered' };
  }

  const missingAfterSeq: number[] = [];
  if (links[0].seq !== 0) missingAfterSeq.push(-1);
  for (let i = 1; i < links.length; i++) {
    if (links[i].seq !== links[i - 1].seq + 1) missingAfterSeq.push(links[i - 1].seq);
  }
  if (missingAfterSeq.length > 0) return { ok: false, reason: 'gap', missingAfterSeq };

  if (links[0].prevHash !== GENESIS_HASH) return { ok: false, reason: 'broken', atSeq: links[0].seq };
  for (let i = 1; i < links.length; i++) {
    if (links[i].prevHash !== linkHash(links[i - 1])) {
      return { ok: false, reason: 'broken', atSeq: links[i].seq };
    }
  }

  return { ok: true };
}
