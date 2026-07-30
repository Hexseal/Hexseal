import {
  AbiFunctionNotFoundError,
  parseEventLogs,
  type Log,
  type PublicClient,
} from 'viem';
import { AGREEMENT_ABI, DISPUTE_SPLIT_EVENT, DISPUTE_UNANSWERED_EVENT } from '@/config/contracts';
import { decideArbiterTimeout } from './arbiterTimeoutSettlement';
import { usdcExact } from './splitPot';

/**
 * ЧТО ФАКТИЧЕСКИ ПРОИЗОШЛО с деньгами сделки, которая закрылась со статусом
 * REFUNDED. Это поверхность ПОСЛЕ действия, в отличие от
 * `lib/arbiterTimeoutSettlement`, который предсказывает исход ДО него.
 *
 * Различать обязательно, потому что реестр не различает: таймаут спора, за
 * который никто не взялся, делит котёл пополам и ставит тот же REFUNDED(2), что
 * и настоящий возврат — перечисление статусов расширять нельзя, оно повторяет
 * `enum Status` агримента, чья раскладка заморожена. Из-за этого лента
 * уведомлений говорила исполнителю, только что получившему половину эскроу, что
 * «сделка отменена и деньги вернулись клиенту».
 *
 * Два источника признака, в порядке надёжности:
 *
 *  1. Событие дележа в логах ТОЙ ЖЕ транзакции. Их два, по одному на каждую
 *     ветку правила явки: `DisputeSplitNoVerdict` (откликнулись оба — пополам) и
 *     `DisputeUnanswered` (одна сторона молчала — ей четверть, остаток
 *     явившемуся). Суммы в обоих фактически переведённые: если USDC заблокировал
 *     исполнителя, контракт отдаёт его долю клиенту, и событие покажет ноль —
 *     ровно ради этого в контракте отделён `executorPaid` от `toExecutor`. Это
 *     точный ответ — и единственный путь, на котором мы вправе называть суммы.
 *
 *     Разница между двумя событиями одна: `DisputeSplitNoVerdict` несёт суммы
 *     сразу по сторонам сделки, а `DisputeUnanswered` — по РОЛЯМ в споре
 *     (`responder`/`silent`), и перевести роли в стороны без адресов клиента и
 *     исполнителя нельзя. Поэтому оно разбирается ниже, в пункте 2, где
 *     `getDetails()` и так читается: отдельного чтения ради этого не заводим, а
 *     точность события никуда не девается.
 *  2. Состояние агримента, когда хэша транзакции нет (холодный старт: лента
 *     достраивается из снимка реестра, где хэшей не было никогда). Тогда исход
 *     выводится тем же `decideArbiterTimeout`, что и на странице сделки —
 *     третьей копии этой логики в проекте нет. Но здесь исход — признак и
 *     размер котла, не более: «дележ был» — да, «сколько разделили всего» — да,
 *     «кому из двоих сколько» — нет. Отсюда отдельный вид
 *     `split-amounts-unknown`.
 *
 * ПОЧЕМУ НА ВТОРОМ ПУТИ НЕТ ДОЛЕЙ ПО СТОРОНАМ — И ПОЧЕМУ ОБЩАЯ СУММА ВСЁ-ТАКИ
 * ЕСТЬ.
 *
 * Доли посчитать нечем. `splitPot(totalPayout())` даёт половины ПО ПРАВИЛУ, а в
 * ветке заблокированного исполнителя контракт платит иначе: мягкий перевод не
 * прошёл, недоставленная половина ушла клиенту, событие несёт `toExecutor = 0`
 * (`src/Agreement.sol`, `triggerArbiterTimeout`). Расчёт об этом знать не может
 * и назвал бы заблокированному исполнителю половину, которой тот не получил, а
 * клиенту — половину вместо всего котла: ровно тот класс вранья про деньги, ради
 * которого всё это писалось, только в редкой ветке. Раньше это расхождение было
 * здесь записано как принятое; больше не принято. Правило одно: не называть
 * сумму, которой не знаешь.
 *
 * А вот ОБЩАЯ сумма котла знаема, и она одна и та же в обеих ветках. Из эскроу
 * уходит весь котёл целиком: `toClient + toExecutor == amount + extrasTotal ==
 * totalPayout()`. Блокировка исполнителя ничего не отменяет — недоставленная
 * половина не исчезает, а переезжает клиенту, и сумма остаётся прежней
 * (`src/Agreement.sol`, `triggerArbiterTimeout`). Читать ради неё нечего:
 * `totalPayout()` на этом пути и так запрашивается, он нужен
 * `decideArbiterTimeout`. Молчать про неё было перестраховкой, а не честностью:
 * человек не узнавал даже размера собственной сделки.
 *
 * Дочитать фактические ДОЛИ с цепи тоже нечем, и это проверялось:
 *
 *  • `getLogs` требует диапазона блоков, а у ленты его нет — снимок реестра
 *    (`getClientDeals`/`getExecutorDeals`) отдаёт агримент, сумму и статус,
 *    номера блока в нём нет никогда, и сам агримент хранит только время
 *    (`resolvedAt`), а не блок. Перевод времени в блок — это бинарный поиск по
 *    цепи, десятки запросов на каждую сделку в цикле бэкфилла;
 *  • скан от начала цепи на публичном RPC неприемлем по той же причине, только
 *    хуже;
 *  • «спросить у USDC `isBlacklisted`» — эвристика, а не факт: она соврёт, если
 *    исполнителя заблокировали ПОСЛЕ выплаты, и по её ответу мы всё равно
 *    угадывали бы, а не читали.
 *
 * Один настоящий источник существует и здесь намеренно НЕ используется:
 * сабграф с версии 2.1.0 индексирует это самое событие в поля
 * `splitToClient`/`splitToExecutor` сущности Agreement (`subgraph/schema.graphql`,
 * `handleDisputeSplitNoVerdict`), и из браузера он доступен через уже
 * существующий прокси `/api/subgraph`. Цена — новая зависимость ленты
 * уведомлений от стороннего индексатора с его лагом, кэшем и версией деплоя,
 * ради долей в одной редкой ветке. Это отдельное решение, а не побочный эффект
 * этой правки; молчание про долю честно и без него.
 *
 * Если не удалось ни то, ни другое — 'unknown'. Молча выбрать «возврат» здесь
 * было бы тем же враньём, только по умолчанию.
 */
export type SettledRefund =
  /**
   * Дележ, суммы ФАКТИЧЕСКИЕ — взяты из события, а не посчитаны.
   *
   * `silent` задан, когда источником было `DisputeUnanswered`: тогда мы знаем
   * не только суммы, но и ПРИЧИНУ их неравенства. Без него текст с точными
   * суммами объяснял бы меньше, чем текст без сумм (`split-amounts-unknown`
   * причину называет), — то есть точный путь оказался бы беднее
   * приблизительного. Не задан — `DisputeSplitNoVerdict`, откликнулись оба,
   * называть некого.
   */
  | { kind: 'split'; toClient: bigint; toExecutor: bigint; silent?: 'client' | 'executor' }
  /**
   * Дележ был, кому сколько — неизвестно. Доли (число) в этом виде
   * отсутствуют намеренно; `pot` — не доля, а весь котёл, который эскроу
   * отдал целиком, и он верен в обеих ветках.
   *
   * `silent`, если задан, — КАЧЕСТВЕННЫЙ признак, не число: сторона, которая
   * на спор не откликнулась (`decideArbiterTimeout` вернул `'unanswered'`, а
   * не `'split'`). Число (сколько именно ей причиталось) по-прежнему не
   * называем — расчётные доли остаются под тем же запретом, что и раньше, —
   * но ФАКТ «эта сторона молчала, и поэтому дележ вышел неровным» ничем не
   * расчётный: он не про распределение внутри котла, а про причину дележа, и
   * его теряет не жаль, а нечестно. Не задан — обе стороны ответили, дележ был
   * честным «пополам», говорить нечего.
   *
   * Чего этот признак НЕ означает: что молчавшему досталось меньше. Так было
   * написано в первой редакции, и в ветке чёрного списка USDC это ложь —
   * недоставленная доля явившегося уходит клиенту, и молчавший клиент может
   * получить весь котёл. Признак отвечает на «почему неровно», а не на «в чью
   * сторону»; см. `refundNotifCopy`.
   */
  | { kind: 'split-amounts-unknown'; pot: bigint; silent?: 'client' | 'executor' }
  | { kind: 'refund' }
  | { kind: 'unknown' };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Ошибка НАШЕГО кода, а не отказ цепи.
 *
 * Ниже три `catch`, и каждый по построению возвращает «не знаем»: сеть падает
 * буднично, и уведомление из-за этого падать не должно. Но тот же `catch`
 * ловит и опечатку — `client.readContrct(...)`, обращение к полю `undefined`,
 * имя функции, которого нет в ABI, — и обе стороны прочитают её как «RPC
 * недоступен». Такой баг живёт до первого разбора вручную; поэтому его отделяем
 * и печатаем, оставляя возвращаемое значение прежним.
 *
 * Классы движка (`TypeError` и родня) сюда попадают целиком: цепь их не бросает.
 * `AbiFunctionNotFoundError` добавлен отдельно, потому что он наследует
 * viem'овский `BaseError`, то есть по предку неотличим от сетевого, а означает
 * ровно опечатку в имени функции — и летит мимо обёртки `getContractError`
 * (`encodeFunctionData` в `readContract` вызывается ДО try).
 */
function isOwnBug(err: unknown): boolean {
  if (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError ||
    err instanceof RangeError
  ) {
    return true;
  }
  return err instanceof AbiFunctionNotFoundError;
}

function reportIfBug(err: unknown, where: string, agreement: string): void {
  if (!isOwnBug(err)) return;
  console.error(
    `[settledRefund] ${where} threw a programmer error, not a chain or network failure. `
      + `The outcome of ${agreement} is being reported as "unknown" because of a bug here, `
      + 'not because the chain was unreachable:',
    err,
  );
}

/**
 * `DisputeSplitNoVerdict` этого агримента среди логов чека, или null.
 * Фильтр по адресу намеренный: только сам агримент вправе решать, как читается
 * уведомление про его сделку.
 */
export function findSplitInLogs(
  logs: readonly Log[],
  agreement: string,
): { toClient: bigint; toExecutor: bigint } | null {
  const target = agreement.toLowerCase();
  const parsed = parseEventLogs({
    abi: [DISPUTE_SPLIT_EVENT],
    eventName: 'DisputeSplitNoVerdict',
    logs: logs as Log[],
  });
  for (const ev of parsed) {
    if (ev.address.toLowerCase() !== target) continue;
    return { toClient: ev.args.toClient, toExecutor: ev.args.toExecutor };
  }
  return null;
}

/**
 * `DisputeUnanswered` этого агримента среди логов чека, или null. Фильтр по
 * адресу — по той же причине, что и у `findSplitInLogs`.
 *
 * Суммы возвращаются В ТОМ ВИДЕ, в каком их несёт событие: по ролям в споре, а
 * не по сторонам сделки. Перевести одно в другое здесь нечем — для этого нужны
 * адреса клиента и исполнителя, а чек их не содержит; делает это
 * `classifySettledRefund` там, где `getDetails()` уже прочитан.
 *
 * Событие само по себе тоже говорит больше, чем суммы: `responder` — это
 * сторона, которая на спор откликнулась, то есть вторая молчала. Именно этот
 * факт и есть причина, по которой доли не равны.
 */
export function findUnansweredInLogs(
  logs: readonly Log[],
  agreement: string,
): { responder: `0x${string}`; toResponder: bigint; toSilent: bigint } | null {
  const target = agreement.toLowerCase();
  const parsed = parseEventLogs({
    abi: [DISPUTE_UNANSWERED_EVENT],
    eventName: 'DisputeUnanswered',
    logs: logs as Log[],
  });
  for (const ev of parsed) {
    if (ev.address.toLowerCase() !== target) continue;
    return {
      responder: ev.args.responder,
      toResponder: ev.args.toResponder,
      toSilent: ev.args.toSilent,
    };
  }
  return null;
}

async function readOrError<T>(
  client: PublicClient,
  agreement: `0x${string}`,
  functionName: 'disputeFee' | 'totalPayout' | 'DISPUTE_WINDOW' | 'clientResponded' | 'executorResponded',
): Promise<{ data: T | undefined; error: unknown }> {
  try {
    const data = (await client.readContract({
      address: agreement,
      abi: AGREEMENT_ABI,
      functionName,
    })) as T;
    return { data, error: undefined };
  } catch (error) {
    reportIfBug(error, `${functionName}()`, agreement);
    return { data: undefined, error };
  }
}

export async function classifySettledRefund(
  client: PublicClient | undefined,
  agreement: `0x${string}`,
  txHash?: `0x${string}`,
): Promise<SettledRefund> {
  if (!client) return { kind: 'unknown' };

  // (1) Признак и точные суммы лежат в чеке той же транзакции.
  //
  // `unanswered` дочитывается здесь, а применяется ниже: суммы в нём точные, но
  // разложены по РОЛЯМ в споре, и без адресов сторон в стороны не переводятся.
  let unanswered: ReturnType<typeof findUnansweredInLogs> = null;
  if (txHash) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      const split = findSplitInLogs(receipt.logs, agreement);
      if (split) return { kind: 'split', ...split };
      unanswered = findUnansweredInLogs(receipt.logs, agreement);
      // Событий нет — это ещё не значит «возврат»: если `updateStatus` упал при
      // завершении (RegistrySyncFailed), статус в реестр приносит уже отдельная
      // транзакция `syncRegistry()`, в чьих логах дележа не будет. Поэтому
      // падаем в состояние, а не отвечаем сразу.
    } catch (err) {
      // До цепи не доехали — ниже вторая попытка, по состоянию. Если же это не
      // цепь, а мы сами, пусть об этом хотя бы останется след.
      reportIfBug(err, 'the receipt path', agreement);
    }
  }

  // (2) По состоянию агримента.
  try {
    const details = (await client.readContract({
      address: agreement,
      abi: AGREEMENT_ABI,
      functionName: 'getDetails',
    })) as readonly unknown[];
    const dealClient = details[0] as string;
    const executor   = details[1] as string;
    const arbiter    = details[2] as string;
    const disputedAt = details[9] as bigint;

    // Событие из чека, доведённое до сторон сделки. Стоит ПЕРЕД любыми выводами
    // по состоянию намеренно: событие — факт о том, что уже произошло с
    // деньгами, а состояние — вывод о том, что произошло бы по правилам. Когда
    // они расходятся (ветка чёрного списка USDC: молчал клиент, явившийся
    // исполнитель заблокирован — его три четверти не доставлены, и клиент
    // получает ВЕСЬ котёл), прав факт. Вывод по состоянию в этом случае
    // утверждал бы качественно обратное: исполнителю «доля больше половины» при
    // нуле на кошельке, клиенту «меньше половины» при целом котле.
    if (unanswered) {
      const responder = unanswered.responder.toLowerCase();
      if (responder === dealClient.toLowerCase()) {
        return {
          kind: 'split',
          toClient: unanswered.toResponder,
          toExecutor: unanswered.toSilent,
          silent: 'executor',
        };
      }
      if (responder === executor.toLowerCase()) {
        return {
          kind: 'split',
          toClient: unanswered.toSilent,
          toExecutor: unanswered.toResponder,
          silent: 'client',
        };
      }
      // Откликнувшийся — не сторона этой сделки. На цепи недостижимо (фильтр по
      // адресу агримента уже отсеял чужие события, а звать `respondToDispute`
      // может только сторона), но если такое пришло, значит одно из двух чтений
      // соврало — и тогда суммы приписывать некому. Дальше по состоянию.
    }

    // Спора не было вовсе — REFUNDED означает ровно возврат (отмена до
    // активации, таймаут активации, таймаут дедлайна). Дележ без спора
    // невозможен, поэтому дальше читать нечего.
    if (disputedAt === 0n) return { kind: 'refund' };

    // За спор брались — весь котёл клиенту в любой реализации.
    if (arbiter.toLowerCase() !== ZERO_ADDRESS) return { kind: 'refund' };

    const [fee, pot, disputeWindow, clientResponded, executorResponded] = await Promise.all([
      readOrError<bigint>(client, agreement, 'disputeFee'),
      readOrError<bigint>(client, agreement, 'totalPayout'),
      readOrError<bigint>(client, agreement, 'DISPUTE_WINDOW'),
      readOrError<boolean>(client, agreement, 'clientResponded'),
      readOrError<boolean>(client, agreement, 'executorResponded'),
    ]);

    const settlement = decideArbiterTimeout({
      arbiter,
      fee: fee.data,
      feeError: fee.error,
      pot: pot.data,
      disputeWindow: disputeWindow.data,
      clientResponded: clientResponded.data,
      executorResponded: executorResponded.data,
    });

    // Доли у `decideArbiterTimeout` есть, и они РАСЧЁТНЫЕ — `splitPot(pot)` или
    // `splitPotUnanswered(pot, silent)`. На странице сделки это верно: там они
    // предсказывают, что случится, и ветку заблокированного исполнителя никто
    // предсказать не может. Здесь же выплата уже прошла, и назвать расчётное
    // числом «сколько тебе пришло» значило бы соврать всякий раз, когда мягкий
    // перевод не прошёл. Признак берём, доли — намеренно роняем. То же верно
    // для 'unanswered': это тот же класс расчётных долей, только по другой
    // формуле, и то же самое обязательство не называть их не пропадает.
    //
    // А их СУММУ оставляем, и она не расчётная в том же смысле: сколько бы ни
    // ушло каждой стороне, вместе это ровно котёл — что `splitPot`, что
    // `splitPotUnanswered` делят вычитанием и ничего не теряют даже на
    // нечётном, поэтому `toClient + toExecutor` тождественно равно
    // прочитанному `totalPayout()` в обеих ветках — берём его отсюда, а не из
    // `pot.data`, только чтобы не разворачивать `bigint | undefined`, которое
    // на этой ветке уже гарантированно определено.
    //
    // `silent`, наоборот, число не несёт — только признак того, какая
    // сторона не откликнулась. Он не расчётный (не зависит от того, прошёл
    // ли мягкий перевод), и его молчаливо ронять было бы отдельным враньём:
    // именно этот факт — предмет всей задачи о явке. Есть только у
    // 'unanswered'; у честного 'split' (оба ответили) называть некого.
    if (settlement.kind === 'split' || settlement.kind === 'unanswered') {
      return {
        kind: 'split-amounts-unknown',
        pot: settlement.toClient + settlement.toExecutor,
        ...(settlement.kind === 'unanswered' ? { silent: settlement.silent } : {}),
      };
    }
    return { kind: settlement.kind };
  } catch (err) {
    reportIfBug(err, 'the state path', agreement);
    return { kind: 'unknown' };
  }
}

/**
 * Текст записи в ленте уведомлений. Строки захардкожены по-английски, как все
 * остальные в `hooks/useNotifications` — локализации у ленты нет, и заводить её
 * ради одной записи значило бы оставить рядом четырнадцать английских соседей.
 *
 * Доли — обе, а не «пополам» словом: на нечётном котле они разные. И только
 * там, где они фактические. `split-amounts-unknown` не называет ни одной доли,
 * но называет общую сумму: её мы знаем, и она верна в обеих ветках — в отличие
 * от 'unknown', где неизвестен сам исход и называть нечего.
 */
export function refundNotifCopy(
  outcome: SettledRefund,
  role: 'client' | 'executor',
): { title: string; body: string } {
  if (outcome.kind === 'split') {
    const mine  = usdcExact(role === 'client' ? outcome.toClient : outcome.toExecutor);
    const other = usdcExact(role === 'client' ? outcome.toExecutor : outcome.toClient);
    const otherParty = role === 'client' ? 'the executor' : 'the client';
    // Причина неравенства долей, когда она известна (источник — событие
    // `DisputeUnanswered`). Без этой фразы точный путь объяснял бы человеку
    // меньше, чем приблизительный: `split-amounts-unknown` причину называет.
    //
    // Формулировка намеренно не сравнивает доли между собой — ни «больше», ни
    // «меньше половины». В ветке чёрного списка USDC сравнение переворачивается:
    // молчал клиент, явившийся исполнитель заблокирован, его три четверти не
    // доставлены и уходят клиенту — молчавший получает ВЕСЬ котёл, а
    // откликнувшийся ноль. Сказано поэтому только то, что верно всегда: почему
    // дележ вышел неровным. Сами суммы уже названы выше, и они фактические.
    const why = !outcome.silent ? ''
      : role === outcome.silent
        ? " You didn't answer the dispute in time, so the escrow was not split evenly."
        : ' The other party never answered the dispute, so the escrow was not split evenly.';
    return {
      title: 'Escrow Split',
      body:
        'Nobody took the dispute, so there was nobody to judge it. The escrow was split — '
        + `${mine} USDC to you, ${other} USDC to ${otherParty}.${why}`,
    };
  }

  // Дележ без долей (число). Но если известно, КТО молчал, это уже не число,
  // а причина — и её можно сказать каждой стороне свою: молчавшему, что дележ
  // вышел неровным именно потому, что он не откликнулся; откликнувшемуся — что
  // не откликнулась вторая сторона. Точную сумму по-прежнему не называем ни
  // тому, ни другому — за ней в кошелёк.
  //
  // ПОЧЕМУ НЕ «БОЛЬШЕ/МЕНЬШЕ ПОЛОВИНЫ». Так здесь и было написано, и это ложь
  // ровно того же класса, который весь файл убирает, — только не про сумму, а
  // про её направление. В ветке чёрного списка USDC сравнение переворачивается:
  // молчал клиент, явившийся исполнитель заблокирован, его три четверти не
  // доставлены и уходят клиенту — молчавший получает ВЕСЬ котёл, а
  // откликнувшийся ноль (`src/Agreement.sol`, `triggerArbiterTimeout`). Тогда
  // «твоя доля меньше половины» говорилось тому, кто получил всё.
  //
  // Данных для честного сравнения здесь нет и быть не может: на этом пути доли
  // расчётные по построению, а прошёл ли мягкий перевод — не знает никто.
  // Поэтому говорится ровно то, что верно в обеих ветках: дележ был неровным, и
  // вот по какой причине. Та же формулировка, что и у точного пути выше, —
  // разница между путями только в том, называются ли суммы, а не в том,
  // насколько смело можно утверждать про их соотношение.
  if (outcome.kind === 'split-amounts-unknown') {
    const total = usdcExact(outcome.pot);

    if (outcome.silent) {
      if (role === outcome.silent) {
        return {
          title: 'Escrow Split',
          body:
            "Nobody took the dispute, so there was nobody to judge it. You didn't answer the "
            + `dispute in time, so the escrow was not split evenly. The deal held ${total} USDC `
            + 'in total — check your wallet for the amount you received.',
        };
      }
      return {
        title: 'Escrow Split',
        body:
          'Nobody took the dispute, so there was nobody to judge it. The other party never '
          + `answered the dispute, so the escrow was not split evenly. The deal held ${total} USDC `
          + 'in total — check your wallet for the amount you received.',
      };
    }

    // Обе стороны ответили — назвать «твою половину» здесь нельзя ни одной из
    // них (число всё ещё расчётное); общий котёл, наоборот, обеим одинаково
    // верен, и текст поэтому один на двоих.
    return {
      title: 'Escrow Split',
      body:
        'Nobody took the dispute, so there was nobody to judge it, and the escrow was split '
        + `between the two of you. The deal held ${total} USDC in total — `
        + 'check your wallet for the amount you received.',
    };
  }

  if (outcome.kind === 'refund') {
    return {
      title: 'Deal Refunded',
      body: role === 'client'
        ? 'Funds returned to your wallet.'
        : 'The deal was refunded to the client.',
    };
  }

  if (outcome.kind === 'unknown') return CANNOT_READ_COPY;

  return unhandledOutcome(outcome);
}

/** Честный ответ, когда исход прочитать не удалось. Ничего не утверждает про деньги. */
const CANNOT_READ_COPY = {
  title: 'Deal Closed',
  body: "This deal closed as refunded, but we couldn't read how the escrow was settled. "
      + 'Check your wallet for the amount you received.',
};

/**
 * Ловушка на пятый вид `SettledRefund`.
 *
 * Пока ветки заканчивались общим `return`, новый вид объединения молча получал
 * бы чужой текст: «Deal Closed, прочитать не смогли» — тому самому человеку,
 * чью сделку мы как раз научились читать. Ошибка при этом не видна ниоткуда,
 * потому что кода, который упал бы, нет.
 *
 * Тип `never` переносит это на сборку: пока в объединении ровно четыре вида,
 * сюда доезжает `never` и всё компилируется; как только вид добавят и не
 * обработают выше, аргумент перестанет быть `never` и `tsc --noEmit` (он же
 * гейт `npm run build`) упадёт этой строкой.
 *
 * А вот бросать в рантайме нельзя, и первая редакция это делала зря. Развилка
 * там не «упасть или соврать про деньги»: третий вариант уже написан рядом —
 * сказать, что прочитать не смогли. Он ничего не утверждает про суммы, то есть
 * ложью не является.
 *
 * Цена броска при этом высокая и несоразмерная: единственный вызывающий —
 * цикл достройки ленты в `hooks/useNotifications`, и он не обёрнут в try/catch.
 * Одна сделка со странным видом убила бы уведомления по ВСЕМ сделкам сразу,
 * включая те, что читаются прекрасно. Гейт на сборке остаётся, рантайм остаётся
 * живым, а сам факт виден в консоли.
 */
function unhandledOutcome(outcome: never): { title: string; body: string } {
  const kind = (outcome as { kind?: unknown }).kind;
  console.error(`refundNotifCopy: unhandled SettledRefund kind ${String(kind)}`);
  return CANNOT_READ_COPY;
}
