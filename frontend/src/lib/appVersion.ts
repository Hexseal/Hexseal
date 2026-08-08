/**
 * appVersion.ts — узнать, что выкатилась новая версия, и не устроить при этом петлю.
 *
 * ─── ЗАЧЕМ ЭТО ЕСТЬ ─────────────────────────────────────────────────────────
 *
 * В манифесте `launch_handler: { client_mode: 'focus-existing' }`
 * (`public/manifest.json`): открытие ярлыка ВОЗВРАЩАЕТ существующее окно, а не
 * перезагружает страницу. Куски кода с хешем в имени живут вечно
 * (`/_next/static/…`, `immutable`). Значит установленное приложение, открытое ДО
 * выкатки, крутит прежний код сколько угодно — и человек проверяет починку,
 * которой у него нет. Это стоило нам часов 8 августа: правки были выкачены, а
 * телефон работал по-старому.
 *
 * ─── ГЛАВНАЯ ОПАСНОСТЬ — НЕ СТАРЫЙ КОД, А ПЕТЛЯ ─────────────────────────────
 *
 * Если «моя версия» и «версия на сервере» разъедутся по любой причине, страница
 * будет перезагружаться БЕСКОНЕЧНО: стало бы не «работает старый код», а «не
 * работает ничего». Разъехаться они могут легко — например, если номер считать
 * заново при каждом запуске сервера.
 *
 * Отсюда две меры, и обе обязательны:
 *
 *  1. **номер обоих берётся из одного места** — `NEXT_PUBLIC_BUILD_ID`,
 *     подставленный В КОД на сборке (`next.config.ts`, поле `env`). И страница, и
 *     обработчик `/api/version` читают одну и ту же вкомпилированную строку, так
 *     что перезапуск сервера её не меняет;
 *  2. **на одну версию сервера — ОДНА попытка.** Не помогло — больше не пробуем.
 *     Память живёт в сеансовой кладовой; нет кладовой (приватный режим) — считаем,
 *     что попытка уже была, то есть НЕ перезагружаемся вовсе. Лучше старый код,
 *     чем приложение, которое не открывается.
 */

/** Версия, вкомпилированная в ЭТУ страницу. Пустая строка — сборка без номера
 *  (развёртывание без переменной): тогда сверять нечего и мы молчим. */
export const APP_BUILD_ID: string = process.env.NEXT_PUBLIC_BUILD_ID ?? '';

const MEMORY_KEY = 'hexseal-reload-for-build';
/** Не чаще раза в минуту. Возвращение в приложение бывает частым — каждое
 *  переключение на кошелёк и обратно, — и без этого каждое стоило бы запроса. */
export const VERSION_CHECK_INTERVAL_MS = 60_000;

/* ─────────────────────────── правило, чистой функцией ─────────────────────── */

export interface VersionVerdictInput {
  /** Версия этой страницы. */
  current: string | null | undefined;
  /** Версия, которую назвал сервер. */
  served: string | null | undefined;
  /** Для этой версии сервера попытка уже была. */
  alreadyTried: boolean;
}

/**
 * Перезагружаться ли.
 *
 * ⚠️ Отказывает при ЛЮБОМ сомнении: нет своего номера, нет ответа сервера, уже
 * пробовали. Ложное «да» здесь дороже ложного «нет» — оно ломает приложение
 * целиком, а ложное «нет» всего лишь оставляет старый код до следующего запуска.
 */
export function shouldReloadForVersion(input: VersionVerdictInput): boolean {
  if (!input.current) return false;
  if (!input.served) return false;
  if (input.alreadyTried) return false;
  return input.current !== input.served;
}

/**
 * Пора ли снова спрашивать. Отдельной функцией, чтобы ограничитель мерился.
 *
 * `lastCheckedAt === 0` — «не спрашивали ни разу», и это ДА: первое возвращение в
 * приложение обязано проверить версию сразу, иначе починка приезжала бы с
 * минутной задержкой ровно в тот момент, когда человек смотрит на экран.
 */
export function versionCheckDue(lastCheckedAt: number, now: number): boolean {
  if (lastCheckedAt === 0) return true;
  return now - lastCheckedAt >= VERSION_CHECK_INTERVAL_MS;
}

/* ──────────────────────────── память о попытке ─────────────────────────────── */

function store(): Storage | null {
  try {
    const s = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    // Доступ к кладовой сам умеет бросать (третьи стороны запрещены настройками).
    return null;
  }
}

export function rememberReloadAttempt(served: string): void {
  try { store()?.setItem(MEMORY_KEY, served); } catch { /* заперта — см. ниже */ }
}

/**
 * Пробовали ли уже перезагрузиться ради этой версии.
 *
 * ⚠️ БЕЗ КЛАДОВОЙ ОТВЕЧАЕТ `true`, то есть «пробовали». Это не описка: без памяти
 * попытку не отличить от второй, и честное `false` означало бы бесконечную
 * перезагрузку в приватном режиме и во встроенных браузерах кошельков. Молча
 * остаться на старом коде там — меньшее зло, и оно названо вслух.
 */
export function reloadAlreadyTried(served: string): boolean {
  const s = store();
  if (!s) return true;
  try {
    return s.getItem(MEMORY_KEY) === served;
  } catch {
    return true;
  }
}

/** Только для замеров. */
export function _resetVersionMemoryForTest(): void {
  try { store()?.removeItem(MEMORY_KEY); } catch { /* нечего убирать */ }
}

/* ─────────────────────────── спросить сервер ──────────────────────────────── */

/**
 * Версия, которую отдаёт сервер прямо сейчас. `null` — не ответил или ответил не
 * тем; в обоих случаях трогать работающее приложение нельзя.
 *
 * `cache: 'no-store'` — весь смысл: спросив через кэш, мы получили бы тот же
 * старый номер, что и старый код, и починка не сработала бы никогда.
 */
export async function fetchServedVersion(): Promise<string | null> {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object') return null;
    const id = (body as { buildId?: unknown }).buildId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
