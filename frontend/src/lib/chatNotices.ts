/**
 * chatNotices.ts — слова для того, что хук уже посчитал.
 *
 * Три поля (`pendingBags`, `bagsFailed`, `pushOutcome`) считались верно и не
 * читались никем. Здесь только выбор слов и громкости; считает по-прежнему
 * `usePairChat`, а рисует панель.
 */

import type { PushOutcome } from './webpush';

/* ─────────────────────── невзятые мешки ───────────────────────────────── */

export interface BagsNotice {
  key: string;
  /** Сколько мешков склад показал и мы ещё не взяли. */
  count: number;
  /** `quiet` — просто очередь, тревожить нечем. `loud` — скачать не смогли. */
  tone: 'quiet' | 'loud';
}

/**
 * ⚠️ ДВА СЛУЧАЯ, А НЕ ОДИН, И ЭТО НЕ ОТТЕНОК.
 *
 * «Ещё качаем» — очередь за потолком бюджета: подождать, и всё приедет.
 * «Не смогли» — скачивание отказало, мешок так и остался невзятым. Сводить
 * их значило бы либо пугать очередью, либо молчать об отказе; человек,
 * прочитавший «ещё качаем» на отказе, будет ждать вечно.
 *
 * Отказ показывается ДАЖЕ на нулевом счётчике: `bagsFailed` живёт своим
 * счётчиком подряд идущих неудач, а не длиной очереди, и условие
 * `count > 0 && failed` молчало бы ровно тогда, когда сказать важнее всего.
 */
export function bagsNoticeFor(pendingBags: number, bagsFailed: boolean): BagsNotice | null {
  // Вход приезжает из хука, но считать его заведомо целым и неотрицательным
  // — это вера, а не проверка.
  const count = Number.isFinite(pendingBags) ? Math.max(0, Math.floor(pendingBags)) : 0;
  if (bagsFailed) return { key: 'chat.bags_failed', count, tone: 'loud' };
  if (count <= 0) return null;
  return { key: 'chat.bags_pending', count, tone: 'quiet' };
}

/* ─────────────────── исход отправки уведомления ───────────────────────── */

/**
 * Исход → надпись. Три случая, за которыми ТРИ РАЗНЫХ действия, и одна общая
 * надпись «уведомление не ушло» вела бы во все три тупика сразу:
 *
 *   `no-pass`      — на этом устройстве нет сеанса чата. Лечится заведением;
 *   `rate-limited` — слишком часто. Лечится ожиданием;
 *   `error`        — сеть или отказ сервера. Не лечится ни тем, ни другим.
 */
export const PUSH_OUTCOME_KEYS: Readonly<Record<string, string>> = {
  'no-pass': 'chat.push_no_pass',
  'rate-limited': 'chat.push_rate_limited',
  error: 'chat.push_error',
};

/** `null` — говорить нечего: уведомление ушло либо не отправлялось вовсе. */
export function pushOutcomeKey(outcome: PushOutcome | null | undefined): string | null {
  if (!outcome || outcome === 'ok') return null;
  // Незнакомый исход — общая надпись, а не молчание: молчание про неушедшее
  // уведомление человек читает как «ушло».
  return PUSH_OUTCOME_KEYS[outcome] ?? 'chat.push_error';
}
