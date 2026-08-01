/**
 * attachmentFailure.ts — «файл не открылся» это два разных события.
 *
 * ЧТО БЫЛО. И протухшее вложение, и битый ключ показывались одной подписью
 * «Ошибка расшифровки». Первое — нормальный, заранее объявленный срок хранения
 * (релеер чистит `/storage/files/` через семь дней), человеку надо просто
 * попросить прислать заново. Второе — настоящая поломка. Один и тот же текст на
 * оба случая заставлял человека чинить то, что не ломалось.
 *
 * КАК ОТЛИЧАЕМ. Два независимых признака, любого достаточно:
 *
 *  • ответ файлового сервера 404/410 (`decryptToObjectUrl` кладёт статус прямо
 *    в текст ошибки: `Failed to fetch file: 404`);
 *  • сообщению больше срока хранения — тогда файла на диске нет гарантированно,
 *    чем бы ни кончился запрос. Этот признак нужен потому, что до сервера можно
 *    вообще не доехать (офлайн, релеер лежит), а правда о файле от этого не
 *    меняется.
 */

/** Срок хранения чат-вложений на релеере. Держится в трёх местах и обязан
 *  совпадать: `relayer/app.js` (`FILE_TTL_MS`), тексты локалей и вот это
 *  значение. Расхождение уже случалось — интерфейс обещал 18 дней при реальных
 *  семи. */
export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AttachmentFailure =
  /** Срок хранения истёк — файла нет и не будет, чинить нечего. */
  | 'expired'
  /** Файл есть, но открыть не вышло — вот это настоящая ошибка. */
  | 'decrypt_failed';

export interface AttachmentFailureContext {
  /** Время сообщения с вложением, мс. */
  sentAt?: number;
  now?: number;
  ttlMs?: number;
}

/** HTTP-статусы, которыми файловый сервер отвечает на «этого файла здесь нет».
 *  403 в этот список НЕ входит: у самодельного файлового сервера это «нельзя»,
 *  а не «удалено», и списывать запрет на срок хранения значит снова соврать. */
const GONE_STATUSES = [404, 410];

export function classifyAttachmentFailure(
  err: unknown,
  ctx: AttachmentFailureContext = {},
): AttachmentFailure {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (GONE_STATUSES.some(s => message.includes(String(s)))) return 'expired';

  const ttl = ctx.ttlMs ?? ATTACHMENT_TTL_MS;
  const now = ctx.now ?? Date.now();
  if (ctx.sentAt !== undefined && ctx.sentAt > 0 && now - ctx.sentAt > ttl) return 'expired';

  return 'decrypt_failed';
}
