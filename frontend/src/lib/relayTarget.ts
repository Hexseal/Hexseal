/**
 * Пункт 44, боевая половина: за чей контракт мы платим газ на Next-пути.
 *
 * Близнец relayer/app.js:relayTargetVerdict. Общего кода у них быть не может —
 * разные рантаймы (Node+ethers против Next+viem), — поэтому договор о ПОВЕДЕНИИ
 * вынесен в shared/relay-target-scenes.json и читается тестами обеих сторон.
 * Расходиться им нельзя: покраснеет та сторона, что отстала.
 *
 * Модуль намеренно не знает ни про viem-клиента, ни про сеть: читалку записи
 * реестра ему даёт вызывающий (маршрут). Так его можно проверять без подъёма
 * половины Next — но ⚠️ ровно поэтому проверки САМОГО МОДУЛЯ недостаточно:
 * маршрут обязан его звать, и это проверяется тестами через POST.
 */

/** Ровно те же роды исхода, что у релеерной половины. */
export type RelayTargetVerdict =
  | { ok: true;  kind: 'diamond' | 'agreement' }
  | { ok: false; status: 403; code: 'target_not_ours';   error: string }
  | { ok: false; status: 503; code: 'chain_unavailable'; error: string };

/** Читалка записи реестра. Отдаёт что угодно — разбирает это сам модуль. */
export type RegistryRecordReader = (agreement: `0x${string}`) => Promise<unknown>;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Кэшируем ТОЛЬКО положительные ответы: «наш агримент» монотонно (реестр
// записи не удаляет), «не наш» — нет (адрес станет нашим в ту секунду, когда
// acceptApplicant/acceptRequest/deployAndFund зарегистрируют сделку). Срок и
// размер — границы для нас самих; перезапуск оставляет кэш пустым, и это
// безопасно: пустой кэш стоит лишнего чтения цепи, а не лишнего пропуска.
const RELAY_TARGET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RELAY_TARGET_CACHE_MAX = 1000;

const _ourAgreements = new Map<string, number>();
const _agreementLookups = new Map<string, Promise<boolean | null>>();

export function _resetRelayTargetCacheForTest(): void {
  _ourAgreements.clear();
  _agreementLookups.clear();
}

function rememberOurAgreement(addr: string): void {
  _ourAgreements.delete(addr);
  _ourAgreements.set(addr, Date.now() + RELAY_TARGET_CACHE_TTL_MS);
  while (_ourAgreements.size > RELAY_TARGET_CACHE_MAX) {
    const oldest = _ourAgreements.keys().next().value;
    if (oldest === undefined) break;
    _ourAgreements.delete(oldest);
  }
}

function cachedAsOurAgreement(addr: string): boolean {
  const until = _ourAgreements.get(addr);
  if (until === undefined) return false;
  if (until <= Date.now()) { _ourAgreements.delete(addr); return false; }
  return true;
}

/**
 * true  — запись прочитана, это наш агримент;
 * false — запись прочитана, это НЕ наш;
 * null  — прочитать не удалось (узел молчит либо ответ не разбирается).
 */
async function readsAsOurAgreement(
  addr: string, readRecord: RegistryRecordReader,
): Promise<boolean | null> {
  try {
    const raw = await readRecord(addr as `0x${string}`);
    const rec = raw as { agreement?: unknown; client?: unknown } | null | undefined;
    const agreement = typeof rec?.agreement === 'string' ? rec.agreement.toLowerCase() : null;
    const client    = typeof rec?.client    === 'string' ? rec.client.toLowerCase()    : null;
    if (agreement === null || client === null) {
      console.error('[relay] реестр ответил тем, что не разбирается как запись сделки:', addr);
      return null;
    }
    // ⚠️ АДРЕС, а не статус: RegistryStorage.AgreementStatus.ACTIVE == 0, и
    // нулевая запись незнакомого адреса выглядит «активной».
    return agreement === addr || client !== ZERO_ADDRESS;
  } catch (err: unknown) {
    console.error('[relay] реестр не ответил на getRecord:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Можно ли платить газ за вызов к этому адресу.
 * Статус и код отказа отдаёт сама функция — у маршрута своих литералов нет.
 */
export async function relayTargetVerdict(
  to: string, diamond: string, readRecord: RegistryRecordReader,
): Promise<RelayTargetVerdict> {
  const addr = to.toLowerCase();

  if (addr === diamond.toLowerCase()) return { ok: true, kind: 'diamond' };
  if (cachedAsOurAgreement(addr))     return { ok: true, kind: 'agreement' };

  let lookup = _agreementLookups.get(addr);
  if (!lookup) {
    lookup = readsAsOurAgreement(addr, readRecord)
      .finally(() => { _agreementLookups.delete(addr); });
    _agreementLookups.set(addr, lookup);
  }
  const answer = await lookup;

  if (answer === null) {
    return {
      ok: false, status: 503, code: 'chain_unavailable',
      error: 'Cannot verify the target contract right now — the chain did not answer',
    };
  }
  if (answer === false) {
    return {
      ok: false, status: 403, code: 'target_not_ours',
      error: 'Target is not a Hexseal contract — the relayer pays gas only for its own',
    };
  }
  rememberOurAgreement(addr);
  return { ok: true, kind: 'agreement' };
}
