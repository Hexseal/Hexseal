/**
 * «Собеседник вообще состоит в этой группе?» — единственная проверка, которая
 * отделяет отправленное сообщение от исчезнувшего.
 *
 * ЧТО БЫЛО. В `findOrCreatePairGroup` две ветки обходились с одной и той же
 * бедой по-разному:
 *
 *  • путь СОЗДАНИЯ группы (`createIfMissing`) при недостижимом собеседнике
 *    бросал громко, и рядом стоял комментарий, почему молчать нельзя: группа
 *    создалась бы без него, сообщение ушло бы в группу, членом которой он
 *    никогда не был, и узнать об этом было бы нечем — ни ошибки, ни способа
 *    догнать пересинхронизацией;
 *
 *  • путь САМОПОЧИНКИ (группа уже есть, собеседника в ней нет) ту же ситуацию
 *    молчал: `if (canMsg === true) { добавить }` — и ни одного `else`. Группа
 *    возвращалась как ни в чём не бывало, отправка выглядела успешной, галочка
 *    рисовалась, получатель не видел ничего и никогда.
 *
 * Комментарий у ветки самопочинки просил не блокировать ОТКРЫТИЕ чата — и это
 * верно, требование остаётся. Но «не блокировать открытие» никогда не значило
 * «дать отправить в пустоту»: открытие и отправка — разные моменты.
 *
 * ЧТО СТАЛО. Решение вынесено сюда и одинаково для обеих веток, а спрашивают
 * его в РАЗНЫХ местах:
 *
 *  • при открытии чата — лучшим усилием, результат ни на что не влияет
 *    (собеседника молча добавят, если он снова достижим);
 *  • ПЕРЕД КАЖДОЙ ОТПРАВКОЙ — и вот здесь `unreachable` останавливает отправку
 *    с той же самой ошибкой, что и путь создания. ChatPanel уже узнаёт её по
 *    подстроке 'not registered' и показывает готовое объяснение со ссылкой-
 *    приглашением, а `usePairChat` снимает оптимистичный пузырь. То есть
 *    непроходимое сообщение не выглядит отправленным ни одной секунды.
 *
 * Почему проверка на отправке, а не на открытии: между открытием чата и
 * отправкой проходит сколько угодно времени, и собеседник может потерять
 * установку ровно в этом промежутке. Проверка на открытии не покрывает этот
 * случай в принципе, а стоит она столько же.
 *
 * Модуль намеренно не импортирует @xmtp/browser-sdk: ему хватает структурных
 * типов, зато его можно проверить тестами без wasm и без сети.
 */

/** Сообщение, по которому ChatPanel узнаёт «до этого адреса не дойдёт».
 *  Совпадение ищется по подстроке 'not registered' — менять формулировку
 *  можно, эти два слова терять нельзя. */
export const PEER_UNREACHABLE_MESSAGE =
  'This address is not registered on XMTP right now — they need to open Hexseal chat first.';

export interface PeerIdentifier {
  identifier: string;
}

export interface ReachabilityProbe<TId extends PeerIdentifier> {
  canMessage(identifiers: TId[]): Promise<{ get(key: string): boolean | undefined }>;
}

export interface MemberList {
  accountIdentifiers?: ReadonlyArray<{ identifier?: string } | undefined> | undefined;
}

export interface RepairableGroup<TId extends PeerIdentifier> {
  members(): Promise<ReadonlyArray<MemberList>>;
  addMembersByIdentifiers(identifiers: TId[]): Promise<unknown>;
  sync(): Promise<unknown>;
}

export type PeerMembership =
  /** Собеседник в группе — сообщение дойдёт. */
  | 'present'
  /** Его не было, но он достижим и только что добавлен — дальше дойдёт. */
  | 'added'
  /** Его нет и добавить не вышло — отправлять НЕЛЬЗЯ, не дойдёт. */
  | 'unreachable'
  /** Состав группы прочитать не удалось: доказательств, что не дойдёт, нет. */
  | 'unknown';

/**
 * Проверяет, что собеседник состоит в группе, и чинит, если может.
 *
 * `unknown` — отдельный исход, а не разновидность `unreachable`, и разница
 * принципиальная. Список участников читается из локальной базы MLS, и она
 * умеет бросать на порченой churn'ом группе (openmls SecretReuseError) — это
 * ровно та ошибка, которую соседний код глушит, чтобы не гасить чат целиком.
 * Отказать в отправке по такому чтению значило бы завести вторую поломку
 * зеркально первой: сообщение не уходит там, где оно прекрасно дошло бы.
 * Запрещаем отправку только когда точно известно, что получателя в группе нет.
 */
export async function ensurePeerInGroup<TId extends PeerIdentifier>(
  group: RepairableGroup<TId>,
  client: ReachabilityProbe<TId>,
  peerId: TId,
): Promise<PeerMembership> {
  const peerLc = peerId.identifier.toLowerCase();

  let members: ReadonlyArray<MemberList>;
  try {
    members = await group.members();
  } catch {
    return 'unknown';
  }

  const hasPeer = members.some(m =>
    (m?.accountIdentifiers?.[0]?.identifier?.toLowerCase() ?? '') === peerLc,
  );
  if (hasPeer) return 'present';

  // Собеседника в группе нет. Дальше любой отказ — это `unreachable`, а не
  // `unknown`: чем бы ни кончилась попытка добавить, на момент отправки он
  // членом группы не является, и сообщение до него не дойдёт физически.
  try {
    const canMsg = await client.canMessage([peerId]);
    if (canMsg.get(peerId.identifier) !== true) return 'unreachable';
    await group.addMembersByIdentifiers([peerId]);
  } catch {
    return 'unreachable';
  }

  // Добавление прошло; отдельная синхронизация — уже удобство, её провал
  // членства не отменяет.
  try { await group.sync(); } catch { /* некритично */ }
  return 'added';
}

/** `true`, если при таком исходе отправлять нельзя. */
export function blocksDelivery(state: PeerMembership): boolean {
  return state === 'unreachable';
}
