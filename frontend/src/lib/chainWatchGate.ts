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

/**
 * Сколько блоков берётся ОДНИМ `eth_getLogs`. Провайдеры ограничивают диапазон, и
 * запрос «от блока годичной давности» вернёт отказ, а не логи. 3600 блоков — это
 * примерно два часа при блоке Base в две секунды, с запасом внутри типичных
 * ограничений.
 */
export const CATCHUP_CHUNK_BLOCKS = BigInt(3_600);

/**
 * Потолок догона целиком — примерно сутки. Пропуск длиннее одного куска
 * добирается НЕСКОЛЬКИМИ запросами подряд, а не урезается: вкладка, свёрнутая на
 * ночь, иначе теряла бы всё, кроме последних двух часов. Сутки стоят двенадцать
 * запросов — против 187 200, которые то же время стоило круглосуточное слежение.
 *
 * Что дальше суток: урезается, и это не молчит (`onTruncated`). Состояние своих
 * сделок при этом всё равно достраивается из реестра на холодном старте
 * (`useNotifications`), так что теряются только извещения о чужих нажатиях
 * давностью больше суток.
 */
export const CATCHUP_MAX_BLOCKS = CATCHUP_CHUNK_BLOCKS * BigInt(12);

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

export interface CatchUpChunk {
  fromBlock: bigint;
  toBlock: bigint;
}

export interface CatchUpPlan {
  /** Куски по порядку, от старых блоков к новым. Без дыр и без нахлёста. */
  chunks: CatchUpChunk[];
  /** Пропуск был длиннее потолка, часть событий не добирается. */
  truncated: boolean;
}

/**
 * Какие диапазоны добирать. `null` — добирать нечего (курсора нет, голова не
 * ушла, либо на входе мусор).
 *
 * Куски идут от СТАРЫХ к новым: так уведомления попадают в колокольчик в том же
 * порядке, в каком случились, и курсор можно двигать после каждого удавшегося
 * куска, не теряя прогресс на отказе следующего.
 */
export function planCatchUp(
  cursor: bigint | null,
  head: bigint,
  maxBlocks: bigint = CATCHUP_MAX_BLOCKS,
  chunkBlocks: bigint = CATCHUP_CHUNK_BLOCKS,
): CatchUpPlan | null {
  if (typeof cursor !== 'bigint' || typeof head !== 'bigint') return null;
  if (cursor < BigInt(0) || head <= BigInt(0)) return null;
  if (head <= cursor) return null;
  if (chunkBlocks <= BigInt(0) || maxBlocks <= BigInt(0)) return null;

  const wanted = head - cursor;
  const truncated = wanted > maxBlocks;
  const first = truncated ? head - maxBlocks + BigInt(1) : cursor + BigInt(1);

  const chunks: CatchUpChunk[] = [];
  let from = first;
  while (from <= head) {
    const to = from + chunkBlocks - BigInt(1);
    chunks.push({ fromBlock: from, toBlock: to > head ? head : to });
    from = to + BigInt(1);
  }
  return { chunks, truncated };
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

    // Куски идут по порядку, и курсор двигается ПОСЛЕ КАЖДОГО удавшегося. Отказ
    // на середине оставляет добранное добранным: следующая попытка продолжит с
    // места обрыва, а не потянет всё заново и не отчитается «догнали».
    for (const chunk of plan.chunks) {
      if (stopped) return;
      let logs: unknown[];
      try {
        const got = await io.getLogs(chunk.fromBlock, chunk.toBlock);
        if (!Array.isArray(got)) throw new Error('узел отдал не массив логов');
        logs = got;
      } catch (e) {
        onError?.(e, 'catchup');
        return; // курсор остаётся на конце последнего удавшегося куска
      }
      cursor.write(chunk.toBlock);
      if (logs.length > 0 && !stopped) await onLogs(logs, 'catchup');
    }
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
