/**
 * «Я уже откликнулся» — до того, как об этом узнает сабграф.
 *
 * Жалоба владельца дословно: «после отклика с борда кнопка откликнуться
 * доступна, а должна быть недоступной, серой или типа того».
 *
 * Причина двойная, и одной блокировкой кнопки она не лечится. Признак отклика
 * на доске приходит из сабграфа (`job.applicants`), а тот индексирует событие
 * секунды, и поверх него лежит серверный кэш прокси со своим TTL. То есть
 * между «транзакция в блоке» и «сабграф это признал» проходит окно, в котором
 * правда о цепи уже другая, а список о ней ещё не знает. Держать всё это окно
 * крутилку — значит врать в другую сторону: действие-то завершилось.
 *
 * Поэтому исход собственного действия запоминается локально и ПЕРЕБИВАЕТ
 * сабграф до тех пор, пока тот не догонит. Пометка именно двузначная
 * (`true`/`false`), а не «множество откликнувшихся»: отзыв отклика — такое же
 * действие с таким же отставанием, и множество умело бы поправить только одно
 * направление из двух — после отзыва сабграф ещё какое-то время продолжает
 * считать нас откликнувшимися, и кнопка прыгала бы обратно в «Отозвать».
 *
 * Когда сабграф догоняет, пометка перестаёт что-либо менять и снимается
 * (`pruneSettledOverrides`) — дальше правда снова одна, с цепи.
 */

/** id заказа → каким его сделало наше собственное действие. */
export type AppliedOverrides = ReadonlyMap<string, boolean>;

/**
 * Откликнулись ли мы на этот заказ. Локальная пометка сильнее сабграфа.
 */
export function resolveApplied(
  jobId: string,
  subgraphApplied: ReadonlySet<string>,
  overrides: AppliedOverrides,
): boolean {
  const own = overrides.get(jobId);
  if (own !== undefined) return own;
  return subgraphApplied.has(jobId);
}

/**
 * Ставит пометку о собственном действии.
 */
export function withOverride(
  overrides: AppliedOverrides,
  jobId: string,
  applied: boolean,
): Map<string, boolean> {
  const next = new Map(overrides);
  next.set(jobId, applied);
  return next;
}

/**
 * Снимает пометки, которые сабграф уже подтвердил: дальше они ничего не
 * меняют, а вечно живущая пометка пережила бы реальные изменения на цепи
 * (например, отклик, отозванный из другой вкладки).
 *
 * Возвращает ИСХОДНУЮ ссылку, если снимать нечего, — вызывающая сторона кладёт
 * результат в `useState` и на новой ссылке каждый раз получала бы лишний
 * рендер.
 */
export function pruneSettledOverrides(
  overrides: AppliedOverrides,
  subgraphApplied: ReadonlySet<string>,
  knownJobIds: ReadonlySet<string>,
): AppliedOverrides {
  let changed = false;
  const next = new Map<string, boolean>();
  for (const [jobId, applied] of overrides) {
    // Заказа нет в текущей выдаче (другой фильтр, другая страница, заказ
    // закрыт) — подтвердить пометку нечем, держим.
    if (!knownJobIds.has(jobId)) { next.set(jobId, applied); continue; }
    if (subgraphApplied.has(jobId) === applied) { changed = true; continue; }
    next.set(jobId, applied);
  }
  return changed ? next : overrides;
}
