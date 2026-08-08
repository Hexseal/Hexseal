/**
 * Слежение за цепью, которое идёт только пока смотрят, и догоняет пропущенное.
 *
 * ЗАЧЕМ. Замер с телефона: простаивающая страница просила у цепи 135 раз в
 * минуту круглые сутки — независимо от того, открыта вкладка на экране или лежит
 * в фоне (`docs/OPEN-ITEMS.md`, пункт 38). Пока человек не смотрит, уведомления
 * ему не нужны; а чтобы ничего не потерялось, при возврате пропуск добирается
 * ОДНОЙ выборкой `eth_getLogs` от курсора до головы.
 *
 * ТРИ СВОЙСТВА, БЕЗ КОТОРЫХ ЭТО СТАНОВИТСЯ ХУЖЕ ДЕФЕКТА.
 *
 * 1. ОТСРОЧКА СНЯТИЯ. Возня кошелька с фокусом прячет вкладку по два раза за
 *    секунды (две подписи подряд), и на этом уже сгорела одна починка: защита
 *    воспроизводила дефект, который чинила. Здесь сворачивание короче
 *    `hideGraceMs` не снимает слежение ВООБЩЕ — ни лишнего запроса, ни разрыва в
 *    покрытии. Замерено: сто переключений подряд стоят ноль запросов.
 *
 * 2. КУРСОР НЕ ПРОДВИГАЕТСЯ НА НЕУДАЧЕ. Если выборка не удалась (узел отказал,
 *    туннель лёг), курсор остаётся на месте и следующий догон добирает тот же
 *    пропуск. Продвинуть курсор на неудаче — потерять события навсегда и при
 *    этом отчитаться «догнали».
 *
 * 3. ПЕРВЫЙ В ЖИЗНИ ЗАПУСК НЕ ДОГОНЯЕТ. Курсора нет — значит неизвестно, с
 *    какого места человек «не видел»; тянуть всю историю биржи в колокольчик
 *    было бы и дорого, и бессмысленно. Курсор просто ставится на голову. Своё
 *    состояние сделок при этом всё равно достраивается из цепи —
 *    `useNotifications` делает это чтением реестра, не логами.
 *
 * ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ. Не разбирает логи (это `lib/notifRouter`) и не
 * знает про React (это `hooks/useNotifications`). Всё внешнее — цепь, курсор,
 * видимость — подаётся снаружи, поэтому весь модуль замеряется без браузера.
 */

/** Потолок догона в блоках. Base — 2 секунды на блок, то есть примерно два часа.
 *
 * Почему потолок вообще нужен: `eth_getLogs` у провайдеров ограничен по
 * диапазону, и запрос «от блока годичной давности» вернёт отказ, а не логи —
 * то есть без потолка длинный пропуск не догонялся бы ВОВСЕ. Урезание не молчит:
 * зовётся `onTruncated`. */
export const CATCHUP_MAX_BLOCKS = BigInt(3_600);

/**
 * Отсрочка снятия слежения после сворачивания. Один такт опроса уведомлений:
 * вкладка, спрятанная на меньшее время, не стоит ни одного лишнего запроса.
 */
export const HIDE_GRACE_MS = 20_000;

export interface VisibilityDoc {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface ChainWatchIO {
  /** Взвести живое слежение. Возвращает снятие. */
  watch(onLogs: (logs: unknown[]) => void, onError: (e: unknown) => void): () => void;
  /** Голова цепи. */
  blockNumber(): Promise<bigint>;
  /** Логи диапазона — один запрос на весь пропуск. */
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<unknown[]>;
}

export interface ChainWatchCursor {
  read(): bigint | null;
  write(block: bigint): void;
}

export interface CatchUpPlan {
  fromBlock: bigint;
  toBlock: bigint;
  /** Пропуск был длиннее потолка и урезан. */
  truncated: boolean;
}

/**
 * Какой диапазон добирать. `null` — добирать нечего (курсора нет, голова не
 * ушла, либо на входе мусор).
 */
export function planCatchUp(
  cursor: bigint | null,
  head: bigint,
  maxBlocks: bigint = CATCHUP_MAX_BLOCKS,
): CatchUpPlan | null {
  if (typeof cursor !== 'bigint' || typeof head !== 'bigint') return null;
  if (cursor < BigInt(0) || head <= BigInt(0)) return null;
  if (head <= cursor) return null;
  const wanted = head - cursor;
  const truncated = wanted > maxBlocks;
  const fromBlock = truncated ? head - maxBlocks + BigInt(1) : cursor + BigInt(1);
  return { fromBlock, toBlock: head, truncated };
}

export type WatchPhase = 'watch' | 'catchup';

export interface RunChainWatchOptions {
  io: ChainWatchIO;
  /**
   * Курсор догона. НЕ передан — догона нет вовсе: ни `blockNumber`, ни
   * `getLogs`, только заглушка видимости. Так работает страница сделки: она уже
   * перечитывает всё при возврате во вкладку (`VisibilityRefresher`), и второй
   * догон был бы двумя запросами впустую.
   */
  cursor?: ChainWatchCursor;
  doc: VisibilityDoc;
  /** Логи доехали: `live` — живьём, `catchup` — добраны за пропуск. */
  onLogs: (logs: unknown[], reason: 'live' | 'catchup') => void | Promise<void>;
  onError?: (error: unknown, phase: WatchPhase) => void;
  /** Пропуск оказался длиннее потолка — часть событий не добрана. */
  onTruncated?: (plan: CatchUpPlan) => void;
  hideGraceMs?: number;
  maxCatchUpBlocks?: bigint;
}

/** Наибольший номер блока в пачке. */
function maxBlock(logs: readonly unknown[]): bigint | undefined {
  let out: bigint | undefined;
  for (const log of logs) {
    const b = (log as { blockNumber?: unknown } | null | undefined)?.blockNumber;
    if (typeof b === 'bigint' && (out === undefined || b > out)) out = b;
  }
  return out;
}

/**
 * Запустить слежение. Возвращает снятие — оно убирает и слушателя видимости, и
 * само слежение, и отменяет отложенное снятие.
 */
export function runChainWatch(opts: RunChainWatchOptions): () => void {
  const { io, cursor, doc, onLogs, onError, onTruncated } = opts;
  const graceMs = opts.hideGraceMs ?? HIDE_GRACE_MS;
  const maxBlocks = opts.maxCatchUpBlocks ?? CATCHUP_MAX_BLOCKS;

  let unwatch: (() => void) | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let catchingUp: Promise<void> | null = null;
  let stopped = false;

  const bumpCursor = (logs: readonly unknown[]) => {
    if (!cursor) return;
    const b = maxBlock(logs);
    if (b !== undefined) {
      const cur = cursor.read();
      if (cur === null || b > cur) cursor.write(b);
    }
  };

  /**
   * Догон. Курсор пишется ТОЛЬКО после успешной выборки — на неудаче он остаётся
   * позади, и следующий догон добирает тот же пропуск.
   */
  const catchUp = async (): Promise<void> => {
    if (!cursor) return;
    let head: bigint;
    try {
      head = await io.blockNumber();
    } catch (e) {
      onError?.(e, 'catchup');
      return;
    }
    if (typeof head !== 'bigint' || head <= BigInt(0)) return;

    const plan = planCatchUp(cursor.read(), head, maxBlocks);
    if (plan === null) {
      // Догонять нечего. Курсор всё равно ставим на голову: без этого первый в
      // жизни запуск оставил бы его пустым, и следующий догон потянул бы всё.
      if (cursor.read() === null) cursor.write(head);
      return;
    }
    if (plan.truncated) onTruncated?.(plan);

    let logs: unknown[];
    try {
      const got = await io.getLogs(plan.fromBlock, plan.toBlock);
      if (!Array.isArray(got)) throw new Error('узел отдал не массив логов');
      logs = got;
    } catch (e) {
      onError?.(e, 'catchup');
      return; // курсор НЕ двигаем
    }

    cursor.write(plan.toBlock);
    if (logs.length > 0 && !stopped) await onLogs(logs, 'catchup');
  };

  const activate = () => {
    if (stopped) return;
    if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
    if (unwatch !== null) return; // уже следим — мерцание видимости ничего не стоит

    // Живое слежение взводится СРАЗУ, не дожидаясь догона: иначе события,
    // случившиеся во время самой выборки, попали бы в щель между её концом и
    // взводом фильтра.
    unwatch = io.watch(
      (logs) => {
        if (stopped) return;
        bumpCursor(logs);
        void onLogs(logs, 'live');
      },
      (e) => onError?.(e, 'watch'),
    );

    // Один догон за раз: два быстрых возврата не должны идти в цепь параллельно.
    if (cursor && catchingUp === null) {
      const run = catchUp().finally(() => { if (catchingUp === run) catchingUp = null; });
      catchingUp = run;
    }
  };

  const deactivate = () => {
    if (unwatch !== null) { unwatch(); unwatch = null; }
  };

  const onVisibility = () => {
    if (stopped) return;
    if (doc.visibilityState === 'visible') { activate(); return; }
    // Спрятали. Снимаем не сразу — см. свойство 1 в шапке.
    if (unwatch === null || hideTimer !== null) return;
    if (graceMs <= 0) { deactivate(); return; }
    hideTimer = setTimeout(() => { hideTimer = null; deactivate(); }, graceMs);
  };

  doc.addEventListener('visibilitychange', onVisibility);
  if (doc.visibilityState === 'visible') activate();

  return () => {
    stopped = true;
    doc.removeEventListener('visibilitychange', onVisibility);
    if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
    deactivate();
  };
}
