/**
 * Чтение пропуска склада из кладовой браузера — БЕЗ окна кошелька.
 *
 * ⚠️ ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ОБРАЩЕНИЕ К ТРАНСПОРТУ. Пропуск заводит и
 * кладёт на диск `lib/chatTransport.ts` (`requestBagPass` → `writeStoredPass`)
 * — он же единственный, кто умеет попросить подпись. Но пропуск нужен ещё
 * двум местам, у которых сеанса чата под рукой нет вовсе:
 *
 *   - `lib/webpush.ts`    — уведомление «вам написали» (К-2)
 *   - `lib/fileStorage.ts` — заливка вложения чата (К-4)
 *
 * Оба зовутся из мест, где просить подпись нельзя (внутри отправки сообщения,
 * из обработчика на доске), и оба обязаны обойтись ТЕМ, ЧТО УЖЕ ЕСТЬ. Отсюда
 * правило этого модуля: только чтение, никогда запись, никогда запрос
 * подписи. Если живого пропуска нет — так и сказать вызывающему.
 *
 * Форма ключа кладовой продублирована с `chatTransport.ts` намеренно и с
 * открытыми глазами: транспорт свой кэш наружу не отдаёт. Расхождение
 * форматов сломает поиск пропуска (уведомление не уйдёт, вложение не
 * зальётся) — но не переписку, потому что писать сюда мы не умеем.
 */

/** Тот же ключ, что пишет `lib/chatTransport.ts` (`PASS_STORAGE_PREFIX`). */
const PASS_STORAGE_PREFIX = 'hexseal_bagpass_';

/** Запас на дорогу до релеера — тот же приём, что у самого транспорта. */
const PASS_SKEW_SEC = 30;

function storage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    // Доступ к `localStorage` умеет БРОСАТЬ (сторонний контекст с
    // запрещёнными куками), а не просто отсутствовать.
    return null;
  }
}

function readPassAt(s: Storage, key: string, nowSec: number): { pass: string; expiresAt: number } | null {
  let raw: string | null;
  try { raw = s.getItem(key); } catch { return null; }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { pass?: unknown; expiresAt?: unknown };
    if (typeof parsed?.pass !== 'string' || !parsed.pass) return null;
    if (typeof parsed?.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return null;
    if (nowSec + PASS_SKEW_SEC >= parsed.expiresAt) return null;   // мёртвый за живой не считается
    return { pass: parsed.pass, expiresAt: parsed.expiresAt };
  } catch {
    return null;   // мусор в кладовой — считаем, что записи нет
  }
}

/**
 * Живой пропуск.
 *
 * `hint` — адрес владельца, если известен. Когда подсказки нет, берём самый
 * долгоживущий: на устройстве кошелёк подключён один, а если от прежнего
 * аккаунта остался протухающий пропуск, у свежего срок дальше.
 */
export function findStoredBagPass(hint?: string): string | null {
  const s = storage();
  if (!s) return null;
  const nowSec = Math.floor(Date.now() / 1000);

  if (hint) {
    const exact = readPassAt(s, PASS_STORAGE_PREFIX + hint.toLowerCase(), nowSec);
    if (exact) return exact.pass;
  }

  let best: { pass: string; expiresAt: number } | null = null;
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (!key || !key.startsWith(PASS_STORAGE_PREFIX)) continue;
    const entry = readPassAt(s, key, nowSec);
    if (entry && (!best || entry.expiresAt > best.expiresAt)) best = entry;
  }
  return best?.pass ?? null;
}

/** Заголовок, которым пропуск предъявляется — тот же, что у мешков. */
export const BAG_PASS_HEADER = 'x-bag-pass';
