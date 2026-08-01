'use client';

/**
 * xmtpTabLock.ts — одна вкладка на мессенджер, и честная надпись во второй.
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ НУЖНО. У `@xmtp/browser-sdk` 7.0.0 в собственном README
 * написано прямым текстом: хранилище OPFS не поддерживает несколько
 * одновременных подключений. Две вкладки Hexseal — это два клиента на одну базу.
 * Вторая не падала с внятной ошибкой: она упиралась в занятое хранилище, ждала
 * 90 секунд и показывала «проверь интернет, включи VPN» — уверенный
 * неправильный диагноз, ровно как у незакрытого клиента.
 *
 * ЧТО ДЕЛАЕМ. Вторая вкладка НЕ ПЫТАЕТСЯ поднимать клиента вовсе. Не «пытается
 * и красиво падает» — именно не пытается: каждая брошенная попытка оставляет
 * после себя WASM-воркер, которого потом некому закрыть, а это та же утечка,
 * ради которой в `lib/xmtp.ts` появился `releaseXmtpClient()`.
 *
 * ЧЕМ БЕРЁМ. `navigator.locks` — тот же механизм, что уже держит очередь
 * подписей кошелька (`lib/walletLock.ts`). Его главное свойство здесь:
 * браузер отпускает лок сам, когда контекст держателя исчезает — вкладку
 * закрыли, выгрузили по памяти, она упала. Никакого «протухшего» флага в
 * localStorage, который пришлось бы вычищать по таймауту и который переживёт
 * падение вкладки.
 *
 * ЧТО ПРИ ОСВОБОЖДЕНИИ. Ожидающая вкладка не сидит с надписью «занято» до
 * ручного тыка: `waitForXmtpTabLock()` встаёт в очередь Web Locks БЕЗ
 * `ifAvailable`, то есть браузер разбудит её сам, как только держатель отпустит
 * лок. Разбудив, она сразу становится держателем (лок из колбэка не
 * отпускается) и зовёт `onAcquired` — контекст перезапускает инициализацию.
 * Состояние «первая вкладка закрыта, вторая всё ещё пишет, что занято» таким
 * образом недостижимо; кнопка «Повторить» остаётся вторым, ручным путём.
 *
 * МЯГКАЯ ДЕГРАДАЦИЯ. Нет `navigator.locks` — возвращаем `unsupported`, и всё
 * работает ровно как до этой правки (то есть без меж-вкладочной защиты, но и
 * без отказа мессенджера). Отсутствие API не повод оставить человека без чата.
 *
 * ЗАМЕТКА ПРО ПОЛИТИКУ. Реализован вариант «первая вкладка держит, вторая
 * честно говорит». Вариант «последняя забирает» владелец рассмотрел и отложил —
 * здесь под него намеренно нет ни задела, ни переключателя.
 */

/** Минимальная часть Web Locks API, которой пользуется этот модуль.
 *  Объявлена структурно, чтобы тесты подставляли свой менеджер, а не городили
 *  глобальный `navigator` в node-окружении. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => Promise<void> | void,
  ): Promise<unknown>;
}

export type TabLockResult =
  /** Лок наш — можно поднимать клиента. */
  | 'acquired'
  /** Лок держит другая вкладка — подниматься НЕЛЬЗЯ. */
  | 'busy'
  /** Web Locks недоступны — едем как раньше, без меж-вкладочной защиты. */
  | 'unsupported';

/** Держим release-колбэки взятых локов. Ключ — адрес: база OPFS у SDK
 *  раздельная по адресу (`dbPath: xmtp-<addr>`), значит и конфликт раздельный. */
const _held = new Map<string, () => void>();
/** Активные ожидания освобождения — чтобы не встать в очередь дважды и чтобы
 *  было что отменить, если человек выключил мессенджер, не дождавшись. */
const _waiting = new Map<string, AbortController>();

function lockName(addr: string): string {
  return `hexseal-xmtp-${addr}`;
}

function defaultManager(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks;
  return locks ?? null;
}

/** True, если лок этого адреса держит ИМЕННО ЭТА вкладка. */
export function isXmtpTabLockHeld(address: string): boolean {
  return _held.has(address.toLowerCase());
}

/**
 * Пытается взять лок, НЕ вставая в очередь: занято — сразу `busy`.
 *
 * Повторный вызов при уже взятом локе — не попытка взять второй раз, а `acquired`
 * без обращения к браузеру. Так и должно быть: запрос того же имени из вкладки,
 * которая его держит, с `ifAvailable` вернул бы `null`, и вкладка сообщила бы
 * «занято» сама себе.
 */
export async function acquireXmtpTabLock(
  address: string,
  manager: LockManagerLike | null = defaultManager(),
): Promise<TabLockResult> {
  const addr = address.toLowerCase();
  if (_held.has(addr)) return 'acquired';
  if (!manager) return 'unsupported';

  try {
    return await new Promise<TabLockResult>((resolve) => {
      let settled = false;
      const settle = (r: TabLockResult) => { if (!settled) { settled = true; resolve(r); } };
      Promise.resolve(
        manager.request(lockName(addr), { ifAvailable: true }, (lock) => {
          if (!lock) { settle('busy'); return; }
          // Обещание колбэка НЕ резолвится, пока лок нам нужен: пока оно живо,
          // лок наш. Отпускаем его только из release ниже — или браузер сам,
          // если вкладка исчезнет.
          return new Promise<void>((release) => {
            _held.set(addr, () => { _held.delete(addr); release(); });
            settle('acquired');
          });
        }),
      ).catch(() => settle('unsupported'));
    });
  } catch {
    return 'unsupported';
  }
}

/**
 * Встаёт в очередь за локом и зовёт `onAcquired`, когда браузер его отдаст.
 *
 * Лок при этом ОСТАЁТСЯ за нами: если бы мы его тут же отпустили и только потом
 * пошли инициализироваться, между этими двумя шагами его успела бы перехватить
 * третья вкладка, и «занято» вернулось бы на ровном месте.
 */
export function waitForXmtpTabLock(
  address: string,
  onAcquired: () => void,
  manager: LockManagerLike | null = defaultManager(),
): void {
  const addr = address.toLowerCase();
  if (_held.has(addr) || _waiting.has(addr)) return;
  if (!manager) return;

  const ctrl = new AbortController();
  _waiting.set(addr, ctrl);
  Promise.resolve(
    manager.request(lockName(addr), { signal: ctrl.signal }, (lock) => {
      _waiting.delete(addr);
      if (!lock) return;
      return new Promise<void>((release) => {
        _held.set(addr, () => { _held.delete(addr); release(); });
        onAcquired();
      });
    }),
  ).catch(() => { _waiting.delete(addr); });
}

/** Отпускает лок этой вкладки, НЕ снимая ожидание.
 *
 *  Ровно это нужно, когда попытка провалилась: хранилище мы больше не держим,
 *  но узнать «освободилось» по-прежнему хотим. Отменять здесь очередь было бы
 *  ошибкой — брошенная попытка вычеркнула бы вкладку из очереди, в которую её
 *  поставил предыдущий отказ «занято». */
export function dropXmtpTabLock(address: string): void {
  const addr = address.toLowerCase();
  _held.get(addr)?.();
  _held.delete(addr);
}

/** Отпускает лок этой вкладки И снимает ожидание.
 *  Зовётся, когда человек выключил мессенджер или ушёл с этого адреса: держать
 *  хранилище, которым не пользуешься, — это чужая вкладка без чата на пустом
 *  месте, а ждать освобождения для адреса, который больше не нужен, незачем. */
export function releaseXmtpTabLock(address: string): void {
  const addr = address.toLowerCase();
  _waiting.get(addr)?.abort();
  _waiting.delete(addr);
  dropXmtpTabLock(addr);
}

/** Только для тестов: забыть всё, что модуль держит в памяти. */
export function _resetXmtpTabLocksForTest(): void {
  for (const release of _held.values()) release();
  _held.clear();
  for (const ctrl of _waiting.values()) ctrl.abort();
  _waiting.clear();
}
