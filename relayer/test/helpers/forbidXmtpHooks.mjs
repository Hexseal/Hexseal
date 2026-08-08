/**
 * forbidXmtpHooks.mjs — крючок резолвера, запрещающий загрузку XMTP.
 *
 * Ставится через `--import ./test/helpers/forbidXmtp.mjs` в отдельно
 * запускаемый процесс релеера. Смысл: доказать, что бот НЕ ПОДНИМАЕТСЯ,
 * ГРАФОМ МОДУЛЕЙ, а не поиском слова «xmtp» в исходниках. Если хоть один
 * модуль на пути загрузки попросит `@xmtp/*`, процесс упадёт громко — и
 * упадёт с узнаваемой строкой, а не «где-то что-то».
 */
export async function resolve(specifier, context, nextResolve) {
  if (/^@xmtp(\/|$)/.test(specifier)) {
    throw new Error(`FORBIDDEN_XMTP_IMPORT:${specifier}`);
  }
  return nextResolve(specifier, context);
}
