import { pollForFact, DEFAULT_POLL_INTERVAL_MS } from './pollForFact';

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
 *
 * ⚠️ РЕВЬЮ КРУГ 1, НАХОДКА 4 — `getRecord` стал единой точкой отказа
 * денежного пути, и класс отказа шире, чем «diamondCut потерял селектор».
 * Любой ревert из `RegistryFacet` (не только пропавший селектор — рассинхрон
 * раскладки хранилища, апгрейд с забытой миграцией и т.п.) даёт 503
 * `chain_unavailable` на КАЖДЫЙ агриментный гейслесс-вызов сразу — прецедент
 * в этом же репозитории: `getOpenJobs()` ревертил `Panic(0x22)` после разъезда
 * раскладки хранилища JobBoard (см. `project_terms_storage_layout_break`).
 * Самолечения нет: `isRelayDown` (`frontend/src/lib/relay.ts:456`) узнаёт
 * «релеер лежит» по тексту `relay error 5\d\d` в сообщении об ошибке, а не по
 * коду `chain_unavailable`, поэтому 403/503 отсюда фолбэк на кошелёк не
 * включают — решение оставлено как есть НАМЕРЕННО (не молча): научить
 * `isRelayDown` считать `chain_unavailable` «релеер лежит» значило бы отдать
 * фолбэк на кошелёк ЛЮБОМУ отказу реестра, включая мутацию 8 задачи
 * («существование по статусу вместо адреса» и подобные баги замка) — то есть
 * превратить сломанный ЗАМОК в способ обойти его же тише происходящим
 * фолбэком. Вопрос фолбэка при 503 закреплён за отдельной работой (Задача 8
 * плана 4в-2, она и так трогает фолбэк) — здесь он назван явно, а не
 * обнаружится в день, когда реестр однажды сломается.
 *
 * ⚠️ РЕВЬЮ КРУГ 1, НАХОДКА 1 — чтение сразу после записи по отставшей реплике.
 * `Agreement` разворачивается и РЕГИСТРИРУЕТСЯ в реестре ОДНОЙ транзакцией
 * (`FactoryFacet.acceptRequest`/`acceptApplicant`/`deployAndFund`), и следом
 * фронт сразу шлёт гейслесс-вызов на свежий адрес (пример:
 * `app/request/[id]/page.tsx` — `acceptRequest` → тут же `activate`). RPC за
 * одним URL — пул реплик (drpc), и чтение может попасть на узел, который блок
 * регистрации ещё не увидел: `getRecord` отдаёт нулевую запись, замок читает
 * это как «не наш» и честная сделка получает 403 на первом же действии, без
 * фолбэка (`isRelayDown` смотрит текст ошибки, не код) и без автоповтора.
 * Лечение — то же, что уже трижды применялось в этом дереве для того же
 * класса лага (`lib/pollForFact.ts`: счётчик форвардера, роль арбитра,
 * allowance после permit): не читать один раз и надеяться, а ОПРАШИВАТЬ до
 * факта — но ТОЛЬКО когда чтение УЖЕ прошло (структурно разобралось) и сказало
 * «не наш»: гонка бывает именно там, а «не разбирается» (`null`) — другой
 * класс беды (сорванный ABI/селектор), который повтор не лечит и который
 * незачем облагать той же задержкой.
 *
 * РЕВЬЮ КРУГ 2, БЛОКЕР -> КРУГ 3, ИСПРАВЛЕНО. Ограничитель на этом же
 * маршруте (route.ts) ключевался по from из тела запроса, БЕЗ проверки
 * формата (у to есть isAddress, у from - нет вовсе): нападающему не нужны ни
 * кошелёк, ни подпись, достаточно менять строку на каждый запрос. Опрос из
 * круга 1 делает это дорогим ВПЕРВЫЕ. Круг 2 предложил ТРИ средства; круг 3
 * оставил ОДНО и отменил два других:
 *  1. Бюджет опроса ВОЗВРАЩЁН к 9 попыток (круг 2 временно сжимал его до 4,
 *     ссылаясь на "3 чтения" из тестовой сцены "отстаёт" - это ФИКСТУРА, не
 *     замер, и автор того требования сам отменил его на круге 3. Настоящий
 *     замер лага - `lib/walletLock.ts:166-172`: отставание реплик того же
 *     порядка, что блок Base Sepolia (~2 с), и принятая в проекте доктрина
 *     ТРЁХКРАТНОГО запаса - именно её даёт 9×750≈6.75 с, см. докстринг
 *     RELAY_TARGET_POLL ниже);
 *  2. Короткий отрицательный кэш УБРАН (был заведён на круге 2, снят на
 *     круге 3): он переносил неудачу ПЕРВОГО спросившего на ЛЮБОГО другого,
 *     кто интересовался тем же адресом в течение TTL - включая контрагента
 *     по той же самой свежесозданной сделке, у которого был бы свой
 *     независимый шанс на опрос. Единственная причина заводить кэш
 *     (удешевление спама одним адресом) закрыта пунктом 3 и без кэша:
 *     30 запросов/мин с одного IP × 9 чтений = 270 чтений/мин - не то
 *     число, которое в этом проекте кого-то пугало (для сравнения -
 *     150 000/сутки в соседней работе);
 *  3. Ограничитель по IP остаётся - переиспользует lib/rpcProxy.ts
 *     (requestSourceIp, checkRpcRateLimit) в route.ts, а не строку, которую
 *     выбирает сам нападающий. Единственное из трёх средств, оставшееся
 *     после круга 3.
 */

/** Ровно те же роды исхода, что у релеерной половины. */
export type RelayTargetVerdict =
  | { ok: true;  kind: 'diamond' | 'agreement' }
  | { ok: false; status: 403; code: 'target_not_ours';   error: string }
  | { ok: false; status: 503; code: 'chain_unavailable'; error: string };

/** Читалка записи реестра. Отдаёт что угодно — разбирает это сам модуль. */
export type RegistryRecordReader = (agreement: `0x${string}`) => Promise<unknown>;

// Ревью круг 1, находка 3: минимальный, локально прибитый ABI getRecord — НЕ
// общий DIAMOND_ABI (`@/config/contracts`, руками поддерживаемый файл с
// сотнями записей). Замерено round-trip'ом реального viem
// (decodeFunctionResult): у tuple с ИМЕНОВАННЫМИ компонентами decode отдаёт
// объект (`rec.agreement` читается); стоит компонентам потерять имена —
// отдаёт МАССИВ, `rec.agreement` становится `undefined`, `readOnce` ниже
// читает это как «не разбирается» → 503 на КАЖДЫЙ агриментный вызов денежного
// пути, хотя цепь ответила прекрасно (`route.test.ts` держит отдельный тест
// именно на эту форму, decode-путём, без мока клиента).
//
// Живёт здесь, а не в `route.ts`: Next запрещает route-файлам экспортировать
// что-либо кроме признанных обработчиков (`GET`/`POST`/…) — маршрут ИМПОРТИРУЕТ
// эту константу для собственного `readContract`, а не объявляет её сам.
// Обычный JSON-ABI массив, не `parseAbi`-строка — этот файл намеренно не тянет
// 'viem' (см. докстринг модуля); маршрут передаёт его viem как есть, viem JSON-
// ABI понимает нативно. Зеркало — REGISTRY_RECORD_ABI в relayer/app.js (та же
// форма человекочитаемой строкой, для ethers.Interface).
export const REGISTRY_RECORD_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getRecord',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'agreement', type: 'address' },
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'address', name: 'executor', type: 'address' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'uint256', name: 'resolvedAt', type: 'uint256' },
        ],
        internalType: 'struct RegistryStorage.AgreementRecord',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// Кэшируем ТОЛЬКО положительные ответы: «наш агримент» монотонно (реестр
// записи не удаляет), «не наш» — нет (адрес станет нашим в ту секунду, когда
// acceptApplicant/acceptRequest/deployAndFund зарегистрируют сделку). Срок и
// размер — границы для нас самих; перезапуск оставляет кэш пустым, и это
// безопасно: пустой кэш стоит лишнего чтения цепи, а не лишнего пропуска.
//
// Ревью круг 2 заводил ЕЩЁ и короткий отрицательный кэш — круг 3 его убрал:
// он переносил неудачу ПЕРВОГО спросившего на любого ДРУГОГО, кто спросил про
// тот же адрес в течение TTL, включая контрагента по той же свежесозданной
// сделке с собственным независимым шансом на опрос. См. докстринг модуля.
//
// Ревью круг 1, мелочь: `RELAY_TARGET_CACHE_MAX` экспортирован и сверяется с
// `shared/relay-target-scenes.json` («кэшРазмер») — то же число, что у
// релеерного близнеца, пиннится ОДНИМ местом, а не двумя несверенными
// копиями (тест — в обоих файлах сцен).
const RELAY_TARGET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const RELAY_TARGET_CACHE_MAX = 1000;

// Ревью круг 1, находка 1 -> круг 3: бюджет опроса при "false" ответе.
// Интервал (750мс) взят готовым из lib/pollForFact.ts
// (DEFAULT_POLL_INTERVAL_MS) - тот же RPC, тот же приём "проба - это
// round-trip, не время блока". ЧИСЛО ПОПЫТОК = 9, ТА ЖЕ цифра, что
// `lib/walletLock.ts` (NONCE_POLL_ATTEMPTS) - и ВЗЯТА ОТТУДА, не изобретена
// заново: `walletLock.ts:166-172` документирует НАСТОЯЩИЙ замер (отставание
// реплик того же порядка, что блок Base Sepolia, ~2 с) и принятую в проекте
// доктрину ТРЁХКРАТНОГО запаса поверх измеренного - 9×750≈6.75 с даёт ровно
// её. (Круг 2 временно сжимал это число до 4, обосновывая цифрой "3 чтения"
// из тестовой СЦЕНЫ "отстаёт" - фикстуры, не замера; отменено на круге 3,
// см. докстринг модуля.) Цена этого числа при спаме теперь ограничена не
// им самим, а IP-лимитером в route.ts (30 запросов/мин × 9 = 270 чтений/мин
// с одного источника). Мутируемый экспортируемый объект (тот же приём, что
// RECEIPT_POLL в relayer/app.js) - тесты сокращают `intervalMs` до нуля, не
// трогая `attempts` (иначе замеры чтений станут неправдой про боевой бюджет).
export const RELAY_TARGET_POLL = { attempts: 9, intervalMs: DEFAULT_POLL_INTERVAL_MS };

const _ourAgreements = new Map<string, number>();
const _agreementLookups = new Map<string, Promise<boolean | null>>();

export function _resetRelayTargetCacheForTest(): void {
  _ourAgreements.clear();
  _agreementLookups.clear();
}

function rememberOurAgreement(key: string): void {
  _ourAgreements.delete(key);
  _ourAgreements.set(key, Date.now() + RELAY_TARGET_CACHE_TTL_MS);
  while (_ourAgreements.size > RELAY_TARGET_CACHE_MAX) {
    const oldest = _ourAgreements.keys().next().value;
    if (oldest === undefined) break;
    _ourAgreements.delete(oldest);
  }
}

function cachedAsOurAgreement(key: string): boolean {
  const until = _ourAgreements.get(key);
  if (until === undefined) return false;
  if (until <= Date.now()) { _ourAgreements.delete(key); return false; }
  return true;
}

/**
 * Одно чтение реестра, разобранное в true/false — БРОСАЕТ на «не удалось
 * прочитать» (узел молчит либо ответ не разбирается), вместо того чтобы
 * отдать это третьим значением. Так решает разница между двумя классами
 * беды: «false» (запись пуста/чужая) стоит ПОВТОРИТЬ — это может быть гонка
 * с отставшей репликой; «не прочиталось вовсе» повторять незачем — это не
 * гонка (сеть легла или ABI разъехался), и `pollForFact` бросок на ПЕРВОЙ
 * попытке отдаёт наружу без единой лишней попытки (см. вызывающего ниже),
 * сохраняя ту же цену в один read, что была до этой правки.
 *
 * Ревью круг 2, находка 2: подпорка `client !== ZERO_ADDRESS` УБРАНА.
 * Автор плана отменил решение исходной задачи (обоснование 3) на этом круге:
 * `RegistryFacet.register()` (`src/RegistryFacet.sol:141-148`) пишет всю
 * структуру ОДНИМ присваиванием — значит `client != 0` при `agreement !=
 * addr` СТРУКТУРНО недостижим по коду контракта, не «маловероятен». Хуже
 * того: подпорка регистронезависима (сравнение с адресом из одних нулей) и
 * спасала бы исход при ЛЮБОМ регистре — то есть маскировала `.toLowerCase()`
 * у `agreement` мёртвым замком ДАЖЕ на checksum-фикстурах кругa 1. Убрана —
 * `agreement === addr` стала единственной несущей проверкой.
 */
async function readOnce(addr: string, readRecord: RegistryRecordReader): Promise<boolean> {
  const raw = await readRecord(addr as `0x${string}`);
  const rec = raw as { agreement?: unknown; client?: unknown } | null | undefined;
  const agreement = typeof rec?.agreement === 'string' ? rec.agreement.toLowerCase() : null;
  const client    = typeof rec?.client    === 'string' ? rec.client.toLowerCase()    : null;
  if (agreement === null || client === null) {
    console.error('[relay] реестр ответил тем, что не разбирается как запись сделки:', addr);
    throw new Error('registry response does not parse as a deal record');
  }
  // ⚠️ АДРЕС, а не статус: RegistryStorage.AgreementStatus.ACTIVE == 0, и
  // нулевая запись незнакомого адреса выглядит «активной».
  return agreement === addr;
}

/**
 * true  — запись прочитана (в т.ч. после отставания реплики), это наш агримент;
 * false — запись прочитана и это НЕ наш, даже после исчерпанных попыток опроса;
 * null  — ПЕРВОЕ чтение не удалось (узел молчит либо ответ не разбирается) —
 *         не повторяем: `pollForFact`'ово «сбой первой пробы бросается
 *         наружу» здесь и есть быстрый отказ, тот же, что был до опроса.
 *         Сбой НЕ первой пробы (мы уже видели хоть одно «false» от живого
 *         узла) `pollForFact` сам глотает и продолжает опрос — ревью круг 1,
 *         находка 1 просила именно ОГРАНИЧЕННЫЙ повтор на отрицательном
 *         ответе, а не на «не удалось прочитать вовсе».
 *
 * ⚠️ ИТОГОВОЕ РЕВЬЮ ВЕТКИ, ПРАВКА 4 — СМЕШАННЫЙ СЛУЧАЙ. «Первое чтение
 * разобралось и сказало „не наш“, а все повторы БРОСИЛИ» до этой правки
 * уезжало наружу последним прочитанным `false`, то есть 403 «Target is not a
 * Hexseal contract». Это утверждение, а знания под ним нет: единственное
 * доказательство — одна проба у отставшей реплики, ровно та сцена, ради
 * которой опрос и заведён. Цена ошибки названа выше в докстринге модуля: на
 * 403 фолбэк на кошелёк НЕ включается, и человек, оплачивающий сделку,
 * получает «ваш агримент не наш» в момент, когда мигнул узел. Теперь: ни одна
 * попытка после первой не разобралась — отвечаем «не знаем» (503).
 *
 * ⚠️ И НЕ ШИРЕ ЭТОГО. Разобралась хоть одна повторная проба — «не наш»
 * подтверждён живым узлом, и это 403, как было. Иначе одна моргнувшая проба
 * посреди опроса превращала бы законный отказ в неизвестность, а замок цели —
 * в необязательный.
 */
async function readsAsOurAgreement(
  addr: string, readRecord: RegistryRecordReader,
): Promise<boolean | null> {
  try {
    const poll = await pollForFact<boolean>(
      () => readOnce(addr, readRecord),
      (v) => v === true,
      { attempts: RELAY_TARGET_POLL.attempts, intervalMs: RELAY_TARGET_POLL.intervalMs },
    );
    // `reads > 1` — потому что при attempts=1 повторов не было вовсе, и
    // единственное разобравшееся чтение — это полноценный ответ, а не остаток.
    if (poll.reads > 1 && poll.okReads === 1) {
      console.error('[relay] реестр ответил один раз и замолчал — вердикта нет:', addr);
      return null;
    }
    return poll.value;
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
  const diamondLower = diamond.toLowerCase();

  if (addr === diamondLower) return { ok: true, kind: 'diamond' };

  // Ревью круг 1, мелочь: ключ кэша несёт диамонд, а не только адрес —
  // источник правды (`diamond`) приходит параметром, а не фиксированной
  // константой модуля, значит кэш не имеет права молчаливо доверять записи,
  // сделанной под ДРУГИМ диамондом (переживший процесс редеплой).
  const key = `${diamondLower}:${addr}`;
  if (cachedAsOurAgreement(key)) return { ok: true, kind: 'agreement' };

  let lookup = _agreementLookups.get(key);
  if (!lookup) {
    lookup = readsAsOurAgreement(addr, readRecord)
      .finally(() => { _agreementLookups.delete(key); });
    _agreementLookups.set(key, lookup);
  }
  const answer = await lookup;

  if (answer === null) {
    return {
      ok: false, status: 503, code: 'chain_unavailable',
      error: 'Cannot verify the target contract right now — the chain did not answer',
    };
  }
  if (answer === false) {
    // Ревью круг 2 -> круг 3: НЕ запоминаем «не наш», ни долго, ни коротко —
    // короткий отрицательный кэш (заведённый на круге 2) переносил неудачу
    // ПЕРВОГО спросившего на ЛЮБОГО другого в течение TTL, включая
    // контрагента по той же свежесозданной сделке. Убран (см. докстринг
    // модуля); каждый запрос получает свой независимый опрос.
    return {
      ok: false, status: 403, code: 'target_not_ours',
      error: 'Target is not a Hexseal contract — the relayer pays gas only for its own',
    };
  }
  rememberOurAgreement(key);
  return { ok: true, kind: 'agreement' };
}
