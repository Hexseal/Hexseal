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
import { ZERO_KEY, toBoxKey, toSignKey, type BoxKey, type SignKey } from '@/lib/arbiterChatKey';

function keyToHex(bytes: Uint8Array): Hex {
  const hex = toKeyHex(bytes);
  return (hex.startsWith('0x') ? hex : '0x' + hex) as Hex;
}

/** Обе открытые половины из уже открытой сессии. Окон кошелька не просит. */
export async function claimKeysFromSession(
  session: ChatSession,
): Promise<{ boxKey: BoxKey; signKey: SignKey }> {
  // ТОЧКА ДОВЕРИЯ №2 (первая — readArbiterChatKeysFromChain, arbiterChatKey.ts):
  // единственное место, где ключи, добытые из ЛОКАЛЬНОЙ сессии, помечаются
  // BoxKey/SignKey. Порядок известен по построению, не по соглашению: box —
  // публичная половина X25519-пары сессии, sign — ключ, выведенный из неё
  // ОТДЕЛЬНЫМ контекстом (см. комментарий у deriveLinkSigningKeypair ниже).
  const boxKey = toBoxKey(keyToHex(session.keypair.publicKey));
  // Ключ подписи выводится из ЗАКРЫТОЙ половины X25519-пары отдельным
  // контекстом — это НЕ тот же ключ, что boxKey.
  const link = await deriveLinkSigningKeypair(session.keypair);
  const signKey = toSignKey(keyToHex(link.publicKey));
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

/* ───────────────── подписывающая обёртка с отметкой ухода ─────────────── */

declare const GATED_SIGN_CHAT_KEY: unique symbol;

/**
 * Подписывающая функция, которая ГАРАНТИРОВАННО отмечает уход к кошельку
 * (`noteWalletHandoff`) перед каждым вызовом — потому что произведена
 * ТОЛЬКО функцией `createGatedSignChatKey` ниже.
 *
 * ⚠️ ФИРМЕННЫЙ (NOMINAL) ТИП, НЕ СТРУКТУРНЫЙ, И ЭТО НАМЕРЕННО. Обычный
 * `SignChatKey` имеет ТУ ЖЕ сигнатуру вызова — структурно они неотличимы,
 * и именно это позволило второму кругу независимого ревью найти дыру:
 * позвать `createGatedSignChatKey(rawSignChatKey)` и ВЫБРОСИТЬ результат,
 * подставив дальше голый `rawSignChatKey` — компилировалось, все тесты
 * оставались зелёными, гейт подписи не получал ни одной отметки ухода.
 * Клеймо `[GATED_SIGN_CHAT_KEY]` (приватный уникальный символ, недоступный
 * снаружи модуля) делает эту подмену НЕВОЗМОЖНОЙ, а не «замеченной»: без
 * приведения типа обычный `SignChatKey` этому типу не удовлетворяет, и
 * `deriveClaimChatKeys` ниже принимает ТОЛЬКО `GatedSignChatKey` —
 * `npm run type-check` красит именно эту подмену, до всякого запуска.
 */
export type GatedSignChatKey = SignChatKey & { readonly [GATED_SIGN_CHAT_KEY]: true };

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
 * исполнения — не по тексту между двумя строками.
 */
export function createGatedSignChatKey(
  sign: SignChatKey,
  markHandoff: () => void = noteWalletHandoff,
): GatedSignChatKey {
  const gated: SignChatKey = async (typedData) => {
    markHandoff();
    return sign(typedData);
  };
  // Приведение типа — ЕДИНСТВЕННОЕ допустимое место во всём модуле: клеймо
  // ставится РОВНО здесь, и только значение, прошедшее через эту функцию,
  // имеет право называться `GatedSignChatKey`. Рантайм о клейме не знает
  // вовсе — оно существует только для тип-чекера.
  return gated as GatedSignChatKey;
}

/**
 * Ключи для заявки. Если на устройстве ключа нет — просит ОДНО окно подписи,
 * и только здесь, в момент, когда арбитр уже нажал и потратил ход.
 *
 * Принимает ТОЛЬКО `GatedSignChatKey`, не голый `SignChatKey`, — это и есть
 * компиляционная граница, описанная в докстринге типа выше: подставить сюда
 * неотмеченного подписчика (обойдя гейт) отныне невозможно, а не «поймано
 * тестом при следующем прогоне».
 */
export async function deriveClaimChatKeys(
  address: Address,
  signTypedData: GatedSignChatKey,
): Promise<{ boxKey: BoxKey; signKey: SignKey }> {
  const session = await openSession(address, signTypedData, { createIfMissing: true });
  return claimKeysFromSession(session);
}

/* ─────────────── проброс отсрочки reveal'а быстрого пути ──────────────── */

/**
 * Пробрасывает отсрочку гейта подписи ДАЛЬШЕ, если `err` — она. Единственный
 * эффект этой функции — и он же весь её смысл.
 *
 * ⚠️ ДЕЙСТВИЕ, А НЕ РЕШЕНИЕ — И ЭТО НАМЕРЕННАЯ ЗАМЕНА. Здесь стоял предикат
 * `canRetryRevealAsFreshCommit(err): boolean`, и второй круг независимого
 * ревью показал его цену: `if (!canRetryRevealAsFreshCommit(revealErr))
 * throw revealErr;` → `canRetryRevealAsFreshCommit(revealErr);` (вызов
 * остался в тексте, `if`/`throw` исчезли) — компилировалось, `npm test` был
 * зелёным, а отказ гейта на быстром пути (соль уже была) снова стирал соль
 * и жёг свежую коммит-транзакцию за то, что человек ничего не сделал не так.
 *
 * У действия нет результата, который можно «не посмотреть»: либо оно бросает
 * (и выполнение обрывается там же, синтаксически заметно — соседние строки
 * `catch`-блока просто не выполнятся), либо не бросает, и код идёт дальше.
 * Смотреть не на что — сам вызов и есть эффект.
 */
export function rethrowIfSignatureDeferred(err: unknown): void {
  if (isSignatureDeferred(err)) throw err;
}
