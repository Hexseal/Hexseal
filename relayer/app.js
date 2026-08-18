import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from 'crypto';
import webpush from 'web-push';
import fs, { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: '.env.relayer' });

// Задача 3 (chat-transport-storage): статические импорты, не
// `const { X } = await import(...)` — тот и другой модуль экспортируют
// `export let` (DIR_BAGS, MAX_BAG_SIZE, ...), и только именованный статический
// import (или обращение через пространство имён) даёт живую ссылку, которая
// видит значения ПОСЛЕ assertBagStoreReady()/assertBagPassReady() ниже, а не
// снимок на момент этой строки — см. заголовок test/bagStore.test.js.
//
// Текстуально ПОСЛЕ dotenv.config() по требованию ревью Задачи 3. Строго
// говоря это не меняет порядок ВЫПОЛНЕНИЯ — ESM вычисляет все импорты раньше
// тела импортирующего модуля независимо от того, где текстуально стоит
// `import`, так что bagStore.js/bagPass.js в любом случае получают
// управление до этой строки. Оба спроектированы это пережить (ленивое чтение
// секрета в bagPass.js; module-level `_refreshConfig()` в bagStore.js,
// повторно вызываемая из assertBagStoreReady()) — но текстовый порядок здесь
// дешевле и надёжнее как сигнал для читателя, поэтому он такой.
import {
  bagKeyFor, recordBag, markFetched, listBagsFor, listBagsBySender, listBagsInvolving, bagMetaOf, bagPathFor,
  listDisputeBags,
  assertBagStoreReady, MAX_BAG_SIZE, cleanupBags,
  isBagStoreHealthy, bagStorePersistError,
  adoptPairBags, adoptDealBags, dealDeadlineFromDispute, dealDeadlineFromCreation,
  disputeBoxBagDeadline, listLiveBoxDeals,
  assertNotFromFuture,
} from './bagStore.js';
import { bagPassChallenge, issueBagPass, verifyBagPass, assertBagPassReady } from './bagPass.js';
// Задача 2 (chat-client): справочник открытых ключей чата. Тот же порядок
// комментария, что у bagStore.js/bagPass.js двумя строками выше — текстуально
// после dotenv.config(), но ESM всё равно вычисляет импорт раньше тела этого
// модуля; assertDirectoryReady() ниже (рядом с assertBagStoreReady()/
// assertBagPassReady()) — то место, где directory.js реально перечитывает
// process.env ПОСЛЕ dotenv.
import { putKey, getKeyRecord, assertDirectoryReady } from './directory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Web Push (VAPID) ─────────────────────────────────────────────────────────

let VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL     = process.env.VAPID_EMAIL || 'mailto:admin@hexseal.net';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC_KEY  = keys.publicKey;
  VAPID_PRIVATE_KEY = keys.privateKey;
  console.warn('[push] VAPID keys not set — generated for this session only.');
  console.warn('[push] Add to .env to persist subscriptions across restarts:');
  console.warn(`VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}`);
  console.warn(`VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}`);
  console.warn(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}`);
}

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Absolute, and honours STORAGE_DIR like every other storage path (see STORAGE_DIR
// below — this constant is declared earlier, so the same default is inlined). It used
// to be the relative './storage/push_subscriptions.json', which only resolved by
// accident from the container WORKDIR and silently pointed at a file that did not
// exist after the store was moved — so the relayer loaded an empty map and every push
// was sent to zero subscriptions with no error logged anywhere.
const PUSH_SUBS_FILE = path.join(
  process.env.STORAGE_DIR || path.join(__dirname, 'storage'),
  'push_subscriptions.json',
);
function loadPushSubs() {
  try {
    if (existsSync(PUSH_SUBS_FILE)) {
      const raw = JSON.parse(readFileSync(PUSH_SUBS_FILE, 'utf8'));
      return new Map(Object.entries(raw));
    }
  } catch (e) {
    // The paragraph above describes this exact outcome happening in production —
    // an empty map means every push for every user is dropped for the whole life
    // of the process. The path bug got fixed; the SILENCE around it did not, so a
    // truncated write or an EACCES still produced a perfectly healthy-looking
    // relayer that delivered nothing. A corrupt store is a loud failure now.
    console.error(`[push] FAILED TO LOAD ${PUSH_SUBS_FILE} — starting with ZERO subscriptions, no push will be delivered:`, e.message);
  }
  return new Map();
}
function savePushSubs() {
  try {
    const obj = Object.fromEntries(_pushSubs);
    // loadPushSubs()/savePushSubs() run at module load, before the storage dirs are
    // created further down — make sure the directory exists or the write is lost.
    fs.mkdirSync(path.dirname(PUSH_SUBS_FILE), { recursive: true });
    writeFileSync(PUSH_SUBS_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {
    // /push/subscribe answers {ok:true} off the in-memory map regardless, so a
    // read-only volume or a full disk used to mean: the user is told he is
    // subscribed, the subscription dies at the next restart, and nobody ever finds
    // out. At minimum the operator gets to see it.
    console.error(`[push] FAILED TO PERSIST ${PUSH_SUBS_FILE} — subscriptions live in memory only and are lost on restart:`, e.message);
  }
}
const _pushSubs = loadPushSubs();

async function sendPush(address, payload) {
  const subs = _pushSubs.get(address?.toLowerCase()) ?? [];
  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      // 404/410 = endpoint gone. 400/401/403 = the subscription was created with a
      // DIFFERENT VAPID key (VapidPkHashMismatch) and can never be delivered to
      // again — it was previously only logged and kept, so a stale subscription was
      // retried forever and the user's push stayed dead even after re-subscribing.
      if ([400, 401, 403, 404, 410].includes(e.statusCode)) {
        dead.push(sub.endpoint);
        console.warn('[push] dropping undeliverable subscription:', e.statusCode, e.body ?? e.message ?? '');
      } else {
        // Anything else (429, network errors, ...) is transient — log, keep, retry.
        console.error('[push] sendNotification failed:', e.statusCode ?? '', e.body ?? e.message ?? e);
      }
    }
  }
  if (dead.length) {
    _pushSubs.set(address.toLowerCase(), subs.filter(s => !dead.includes(s.endpoint)));
    savePushSubs();
  }
}

// ─── Agreement ABI ────────────────────────────────────────────────────────────

const AGREEMENT_MINI_ABI = [
  'function getDetails() view returns (address client_, address executor_, address arbiter_, uint256 amount_, string terms_, uint256 deadlineDays_, uint256 fundedAt_, uint256 activatedAt_, uint256 markedDoneAt_, uint256 disputedAt_, uint256 resolvedAt_, uint8 status_)',
  // Срок отклика на спор. Читается с контракта, а не берётся из константы здесь:
  // DISPUTE_WINDOW уже менялась однажды (7 дней → 4), и захардкоженное число
  // начнёт врать в пуше молча — а пуш живёт в шторке уведомлений, его не
  // отзовёшь. Тем же способом читает фронт (frontend/src/app/deal/[address]).
  'function DISPUTE_WINDOW() view returns (uint256)',
  // Задача 5, мелочь (закрывающий раунд ревью, находка координатора): этап 1
  // (adoptActivePairBags ниже) без спора считал предварительный срок только
  // от deadlineDays_, не учитывая, что собственный худший случай сделки БЕЗ
  // спора длиннее — грейс перед автовозвратом и окно клиента среагировать
  // после markDone тоже сдвигают момент, до которого спор в принципе
  // возможен. Обе — public constant, читаются тем же staticcall'ом, что и
  // DISPUTE_WINDOW выше.
  'function DEADLINE_GRACE() view returns (uint256)',
  'function AUTO_APPROVE_WINDOW() view returns (uint256)',
];

const REGISTRY_MINI_ABI = [
  'function getDisputed() view returns (tuple(address agreement, address client, address executor, uint256 amount, uint8 status, uint256 createdAt, uint256 resolvedAt)[])',
  // Задача 5, этап 1 (усыновление при создании сделки) — тот же tuple, что
  // getDisputed() выше, RegistryStorage.AgreementRecord одна на оба статуса.
  'function getActive() view returns (tuple(address agreement, address client, address executor, uint256 amount, uint8 status, uint256 createdAt, uint256 resolvedAt)[])',
  // 4в-2, Задача 1 (ящик спора): точечная проверка «этот адрес — сторона
  // ЭТОЙ сделки». Двух соседей выше для этого не хватает: getActive() и
  // getDisputed() возвращают ВСЮ историю (RegistryFacet.sol:219-236 —
  // массив allAgreements только растёт), то есть один вопрос про одну
  // сделку стоил бы полного прохода по всем когда-либо созданным. Здесь
  // такой вопрос задаётся на КАЖДЫЙ мешок.
  //
  // ⚠️ getRecord по незнакомому адресу НЕ ревертит — отдаёт нулевую
  // структуру, и `status = 0` в enum РЕЕСТРА означает ACTIVE. Значит
  // «сделки нет» и «сделка жива» по статусу неотличимы; признак
  // существования — `record.agreement === agreement`, ровно так проверяет
  // сам контракт (RegistryFacet.sol:104).
  'function getRecord(address agreement) view returns (tuple(address agreement, address client, address executor, uint256 amount, uint8 status, uint256 createdAt, uint256 resolvedAt))',
];

// ─── Who is the arbiter of a dispute (and why NOT Agreement.arbiter) ──────────
//
// Agreement.arbiter is never a human. claimDispute() sets it to the DIAMOND
// itself (Diamond-as-arbiter, so the diamond controls verdict execution,
// freezing and overturns) — see ArbiterRegistryFacet.sol, the comment block
// above creditDisputeFee. So comparing a recovered signer against
// getDetails().arbiter_ is "diamond vs human" and is false for everybody,
// always: it locked every arbiter out of the dispute log on the live server.
//
// The real arbiter lives on the diamond, in two mappings that cover different
// stages of one dispute:
//
//   disputeClaims[agreement]        — written by claimDispute(), the ONLY field
//     populated between claiming a dispute and submitting a verdict. That is
//     exactly the window in which an arbiter needs to read the log: he reads to
//     decide. Deleted by releaseDisputeClaim() (he gave the case back) and by
//     clearDisputeClaim() (the agreement left the dispute).
//
//   pendingVerdicts[agreement].arbiter — written by submitVerdict(), which also
//     requires the caller to BE disputeClaims[agreement], so the two can never
//     name different people. It outlives the claim: finalizeVerdict() holds
//     v.executing = true across the call into the agreement, and that flag is
//     precisely what stops clearDisputeClaim() from deleting the verdict while
//     the claim itself is cleared.
//
// Hence the union below, in that order. Before a verdict only the first exists;
// after a finalized verdict only the second does; in between both agree. On the
// timeout path (nobody claimed, or the claimer never delivered) BOTH are wiped,
// and access ends — which is right: nobody adjudicated that dispute.
const ARBITER_REGISTRY_MINI_ABI = [
  'function getDisputeClaimer(address agreement) view returns (address)',
  'function getPendingVerdict(address agreement) view returns (tuple(address arbiter, bool clientWins, uint256 submittedAt, bool frozen, bool finalized, bool overturned, bool executing, bool appealed, bool appealResolved, address appellant, uint256 appealDeadline, uint256 votesUphold, uint256 votesOverturn))',
];

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * The address currently entitled to read this deal's dispute log, or null.
 * Reads the DIAMOND, never the agreement — see the block above.
 */
export async function disputeArbiterOf(agreement) {
  const registry = new ethers.Contract(DIAMOND_ADDR, ARBITER_REGISTRY_MINI_ABI, provider);

  const claimer = (await registry.getDisputeClaimer(agreement))?.toLowerCase();
  if (claimer && claimer !== ZERO_ADDR) return claimer;

  // No live claim: either the dispute was never claimed, or it already ran to a
  // finalized verdict (which clears the claim but keeps the verdict record).
  const verdict = await registry.getPendingVerdict(agreement);
  if (!verdict) return null;
  // submittedAt == 0 is the facet's own "no verdict here" sentinel (finalizeVerdict
  // reverts NoVerdict on it); a zeroed struct decodes to arbiter == address(0) too,
  // so check both rather than trusting one of them.
  if (BigInt(verdict.submittedAt ?? 0) === 0n) return null;
  const arbiter = verdict.arbiter?.toLowerCase();
  if (!arbiter || arbiter === ZERO_ADDR) return null;
  return arbiter;
}

// Board / service / dispute-claim events. These are emitted by the Diamond (not an
// Agreement), so they can't be resolved from the relayed tx target the way
// AGR_PUSH_MSG/FUNC_PUSH_MSG are — pushBoardEvents() scans the receipt logs and
// resolves recipients from the event args (JobApplied/ServiceRequested need one
// follow-up read via getJob/getService for the poster's address).
const BOARD_EVENT_ABI = [
  'event JobApplied(uint256 indexed jobId, address indexed executor)',
  'event JobAccepted(uint256 indexed jobId, address indexed client, address indexed executor, address agreement)',
  'event ServiceRequested(uint256 indexed requestId, uint256 indexed serviceId, address indexed client, uint256 amount)',
  'event RequestAccepted(uint256 indexed requestId, address indexed executor, address indexed client, address agreement)',
  'event RequestRejected(uint256 indexed requestId, address indexed executor, address indexed client)',
  'event DisputeClaimed(address indexed agreement, address indexed arbiter)',
  'event AppealRaised(address indexed agreement, address indexed appellant)',
];
const boardEventInterface = new ethers.Interface(BOARD_EVENT_ABI);
const JOB_MINI_ABI = [
  'function getJob(uint256) view returns (tuple(address client, string title, string description, uint256 amount, uint256 deadlineDays, string terms, uint8 region, uint8 status, uint256 createdAt, address chosenExecutor, address agreement))',
];
const SERVICE_MINI_ABI = [
  'function getService(uint256) view returns (tuple(address executor, string title, string description, uint256 price, uint256 deadlineDays, uint8 region, uint8 status, uint256 createdAt, uint256 hiresCount))',
];

// Raw disputed records — one on-chain call per cleanup run, not per file and
// not per caller. Задача 5 (мелочь, закрывающий раунд ревью координатора):
// раньше это был отдельный getDisputed() ВНУТРИ getDisputedPairIds(), и
// adoptDisputedPairBags() ниже делала СВОЙ второй, независимый getDisputed()
// за тот же прогон — та же самая вью-функция реестра дважды. registry.getActive()
// /getDisputed() и без того делают по ДВА полных прохода по ИСТОРИИ ВСЕХ
// когда-либо созданных сделок, не только текущих активных/спорных
// (RegistryFacet.sol:219-236 — массив allAgreements только растёт, никогда
// не усекается) — вызывать это ЛИШНИЙ раз за прогон не нужно вообще. Один
// вызов здесь, наверху runFileCleanup(); и защита вложений (через
// disputedPairIdsFromRecords ниже), и усыновление по спору
// (adoptDisputedPairBags) читают ОДИН И ТОТ ЖЕ уже полученный массив.
async function fetchDisputedRecords() {
  try {
    const registry = new ethers.Contract(DIAMOND_ADDR, REGISTRY_MINI_ABI, provider);
    return { ok: true, records: await registry.getDisputed() };
  } catch (e) {
    // I-C (третий закрывающий раунд ревью, находка координатора): слив
    // двух вызовов getDisputed() в один (мелочь эффективности, коммит
    // perf(bags)) молча убрал СВОЁ сообщение об ошибке у этапа 2 —
    // adoptDisputedPairBags() получает уже готовый (пустой при отказе)
    // массив и просто не находит, что усыновлять, без единого слова о
    // причине. При отказе теперь ДВЕ строки, не одна: обе стороны,
    // которым нужен этот вызов (защита вложений И усыновление по спору),
    // получают СВОЙ узнаваемый префикс — иначе человек, ищущий в логе
    // "усыновление", не найдёт вообще ничего и решит, что оно просто ни
    // разу не сработало этой ночью, а не что причина известна и одна.
    // К-1 (аудит устойчивости, 6 августа): «пропускаем защиту в этом
    // прогоне» — это и был дефект, а не смягчение. Пустой массив
    // неотличим от честного «спорных пар сейчас нет», и защита вложений
    // читала отказ сети именно так: один отказ узла в 03:00 сносил
    // вложение пары, которая прямо сейчас в споре.
    console.error('[files] getDisputed lookup failed — DEFERRING cleanup of tagged attachments this run (we do not know which pairs are disputed, and "unknown" must never be read as "none"):', e.message);
    console.error('[bags] adoption: getDisputed lookup failed, skipping this run:', e.message);
    // Отказ теперь ЯВНЫЙ, а не закодированный пустотой. Вызывающий обязан
    // различать «спорных пар нет» и «мы не знаем» — типом, а не догадкой по
    // длине массива.
    return { ok: false, records: [] };
  }
}

// Чистая функция — превращает уже полученные записи в Set pairId для защиты
// вложений. Раньше делала I/O сама (см. fetchDisputedRecords() выше, куда
// это переехало).
function disputedPairIdsFromRecords(disputed) {
  return new Set(disputed.map((r) => pairIdFromAddresses(r.client, r.executor)));
}

// ─── Задача 5 (chat-transport-storage): усыновление переписки сделкой ────────
//
// §6 спеки: бриф обсуждают ДО сделки — без усыновления самое важное истечёт
// раньше, чем возникнет спор, а цепочка сообщений укажет на человека как на
// утаившего, хотя он ничего не прятал. "Откуда берётся событие" — тем же
// путём, каким релеер уже узнаёт о спорах (registry.getDisputed(), см.
// fetchDisputedRecords() выше): свой read-only вызов на реестр за прогон
// runFileCleanup(), никакого отдельного опроса/крона не заводится.
//
// ДВА ЭТАПА (находка координатора при ревью первой версии — усыновление
// только по спору не закрывает риск, ради которого заведена вся задача, см.
// bagStore.js, комментарий над dealDeadlineFromCreation/dealDeadlineFromDispute,
// и task-5-report.md, "Замер: дыра закрыта"):
//
//   adoptActivePairBags()   — при создании сделки (registry.getActive()),
//                             срок предварительный.
//   adoptDisputedPairBags() — при споре (принимает УЖЕ полученный массив
//                             getDisputed() — см. fetchDisputedRecords() и
//                             мелочь эффективности там же), срок точный, до
//                             конца окна апелляции.
//
// adoptActivePairBags() — свой read-only вызов на реестр (getActive()), не
// переиспользование того, что уже есть у getDisputed()-пути: разные
// вью-функции реестра, разные множества сделок. Цена — лишний read-only
// вызов за тот же ночной прогон (раз в сутки, не на каждый файл) — активных
// сделок на маркетплейсе в любой момент — разумное число, не история за
// всё время (в отличие от getActive()/getDisputed() внутри контракта,
// каждая из которых уже проходит ВСЮ историю дважды сама по себе,
// RegistryFacet.sol:219-236 — от этого релеер защититься не может, не меняя
// сам контракт, вне объёма этой задачи).
//
// disputedAt читается через Agreement.getDetails().disputedAt_ — ту же точку
// входа, которой уже пользуется disputeResponseDeadline() ниже по файлу —
// а не через RegistryStorage.AgreementRecord.resolvedAt, хотя для статуса
// DISPUTED они формально совпадают (raiseDispute() выставляет оба в одной
// транзакции, src/Agreement.sol:684,695): читать источник, который ИМЕНЕМ
// говорит "disputedAt", явно надёжнее, чем полагаться на совпадение полей
// двух разных контрактов, которое ничем не гарантировано на будущее.
//
// Задача 5, мелочь эффективности (закрывающий раунд ревью координатора):
// DISPUTE_WINDOW() — `public constant` реализации Agreement, вкомпилирована
// в байткод и для ДАННОГО клона неизменна навсегда (CLAUDE.md: "клоны
// прибиты к своей реализации намертво"). Читать её заново staticcall'ом на
// КАЖДУЮ ещё активную/спорную сделку КАЖДУЮ ночь не нужно — читаем один раз
// на адрес агримента и держим в памяти процесса до перезапуска. Разные
// клоны МОГУТ иметь разное значение (окно спора уже менялось однажды,
// 7д→4д, между версиями реализации), поэтому кэш обязан быть по адресу
// агримента, а не глобальной константой одной на всех.
//
// deadlineDays_ НЕ кэшируется отдельно тем же способом: она приезжает
// бесплатно, в том же getDetails(), который обе функции ниже обязаны звать
// в любом случае — ради мутирующихся полей (activatedAt_/disputedAt_),
// которые кэшировать нельзя. Отдельный кэш под неё не убрал бы ни одного
// сетевого вызова, только тривиальное повторное чтение уже полученного
// ответа — не то же самое, что DISPUTE_WINDOW()/DEADLINE_GRACE()/
// AUTO_APPROVE_WINDOW(), у каждой из которых свой, самостоятельный
// staticcall.
//
// Фабрика, не три копипасты одной и той же функции с разным именем метода:
// свой Map на каждый вызов makeCachedConstantMsReader — три независимых
// кэша (окно спора / грейс дедлайна / окно автоприёма), но один код.
// Кэш заполняется ТОЛЬКО ПОСЛЕ успешного await — если staticcall
// ревертит (например, старый несовместимый клон без этого метода), запись
// в кэш не попадает вовсе, и следующая попытка честно перечитает с цепи, а
// не запомнит ошибку как будто это было валидное значение (см. "мелочи",
// отчёт Задачи 5 — "ревертнувший вызов не отравляет кэш", проверено этим же
// порядком операций: await ДО set(), не после).
// ⚠️ ИТОГОВОЕ РЕВЬЮ 4в-2, ПРАВКА 7: ПРОВЕРКА СТОИТ ПЕРЕД cache.set(), А НЕ
// ПОСЛЕ. Комментарий выше обещает «ревертнувший вызов не отравляет кэш» — и
// это правда только про БРОСОК. Ответ, который не бросил, но не разбирается
// как число (сменили ABI, прокси отдал заглушку, клон вернул пустоту), давал
// `Number(...) * 1000` === NaN — и NaN ложился в кэш НАВСЕГДА: Map живёт до
// перезапуска процесса, промаха по этому ключу больше не будет никогда.
// Дальше `disputeBoxBagDeadline(now, NaN)` бросал на каждом мешке, маршрут
// отвечал 503 с советом «попробуйте через пять секунд», и совет не мог
// сработать ни разу — узел давно здоров, а мусор лежит у нас.
//
// Отрицательное значение проверяется тем же условием и по своей причине:
// Number(-1n)*1000 — безупречный safe integer, «разбирается ли это как
// число» его пропускает, а мешок получил бы срок жизни ПОЗАДИ «сейчас».
//
// Негодное значение НЕ запоминается и уходит броском: у вызывающего уже есть
// ветка «узел не ответил» (503 + Retry-After), и это ровно та новость —
// прочитать не удалось. Следующая попытка честно перечитает.
function makeCachedConstantMsReader(methodName) {
  const cache = new Map(); // agreement (нижний регистр) → мс
  return async function (agr, agreementAddress) {
    const key = agreementAddress.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const ms = Number(await agr[methodName]()) * 1000;
    if (!Number.isSafeInteger(ms) || ms < 0) {
      throw new Error(`${methodName}() ответил тем, что не разбирается как срок: ${String(ms)}`);
    }
    cache.set(key, ms);
    return ms;
  };
}

const getDisputeWindowMs = makeCachedConstantMsReader('DISPUTE_WINDOW');
const getDeadlineGraceMs = makeCachedConstantMsReader('DEADLINE_GRACE');
const getAutoApproveWindowMs = makeCachedConstantMsReader('AUTO_APPROVE_WINDOW');

// C-1 (координатор, четвёртый закрывающий раунд ревью): раньше обе функции
// ниже логировали ЗАПРОШЕННЫЙ dealDeadline ("to <дата> (preliminary)"), а
// не то, что реально получилось после потолка BAG_MAX_AGE_MS в bagExpiryAt()
// (adoptPairBags() теперь возвращает объект — см. её докстринг в bagStore.js
// — вместо голого числа именно ради этого). Замер координатора: сделка на
// 378 дней вперёд (контракт и фронт разрешают срок работы до 365 дней,
// JobBoardFacet.sol:213/ServiceBoardFacet.sol:218/
// frontend/src/config/constants.ts:30) давала лог "extended 1 bag(s) ... to
// 2030-01-23 (preliminary)" — а мешок реально жил 90 дней, ни слова о
// расхождении. Общая точка для обеих функций ниже — один и тот же формат
// строки успеха (по РЕАЛЬНОМУ minEffectiveExpiry, не requested) и одно и то
// же условие для громкого предупреждения, когда потолок реально что-то
// обрезал (cappedCount > 0): "хотели X, дали Y, потому что потолок" — с
// обоими числами, не одним. Не чинит сам потолок (BAG_MAX_AGE_MS) — то
// отдельное решение, вынесенное к владельцу; здесь только честность лога.
//
// Решение владельца (раунд после И-1/C-1/И-2): потолок BAG_MAX_AGE_MS
// больше не действует одинаково для всех — оплаченная сделка (fundedAt_ >
// 0) от него освобождена. Требование владельца, п.5: "в логе говори, какой
// режим применён — с оплатой или без", человек, глядя в лог, обязан
// понимать, ПОЧЕМУ срок такой. paymentTag ниже — это и есть ответ на этот
// вопрос, отдельно от cappedCount (который для оплаченной записи и так
// всегда 0 — см. докстринг adoptPairBags() в bagStore.js).
function logAdoptionResult(logPrefix, agreementAddress, kind, result) {
  const { adopted, requested, minEffectiveExpiry, cappedCount, funded } = result;
  if (!adopted) return;
  const paymentTag = funded ? 'paid — ceiling does not apply' : 'unpaid — 90d ceiling applies';
  const tail = kind === 'creation' ? `preliminary, ${paymentTag}` : paymentTag;
  // Задача 2 (4в-2): «for the pair of …» неправда для ящика спора — тот
  // отобран по СДЕЛКЕ, не по паре клиент↔исполнитель.
  const subject = kind === 'box'
    ? `bags in the dispute box of agreement ${agreementAddress}`
    : `bag(s) for the pair of ${kind === 'creation' ? 'active' : 'disputed'} agreement ${agreementAddress}`;
  console.log(`${logPrefix}: extended ${adopted} ${subject} to ${new Date(minEffectiveExpiry).toISOString()} (${tail})`);
  if (cappedCount) {
    console.warn(
      `${logPrefix}: BAG_MAX_AGE_MS ceiling cut ${cappedCount} of ${adopted} bag(s) short for agreement ${agreementAddress} — ` +
      `wanted ${new Date(requested).toISOString()}, gave ${new Date(minEffectiveExpiry).toISOString()} instead, because of the ceiling.`
    );
  }
}

// Каждая запись реестра — в СВОЁМ try, в обеих функциях: одна не
// читающаяся/бракованная запись (например, staticcall до старого/
// несовместимого клона) не должна останавливать усыновление для ВСЕХ
// остальных пар этого прогона.
async function adoptActivePairBags(nowMs = Date.now()) {
  let active;
  try {
    const registry = new ethers.Contract(DIAMOND_ADDR, REGISTRY_MINI_ABI, provider);
    active = await registry.getActive();
  } catch (e) {
    console.error('[bags] adoption (creation): getActive lookup failed, skipping this run:', e.message);
    return;
  }

  for (const r of active) {
    try {
      const pairId = pairIdFromAddresses(r.client, r.executor);
      const agr = new ethers.Contract(r.agreement, AGREEMENT_MINI_ABI, provider);
      const details = await agr.getDetails();
      const disputeWindowMs = await getDisputeWindowMs(agr, r.agreement);
      const deadlineGraceMs = await getDeadlineGraceMs(agr, r.agreement);
      const autoApproveWindowMs = await getAutoApproveWindowMs(agr, r.agreement);
      // r.createdAt приезжает прямо в tuple getActive() — RegistryFacet
      // ставит его в register() (тот же миг, что и "создание сделки"), лишнего
      // чтения агримента ради этого не нужно. deadlineDays_ — собственный
      // срок сделки, известен сразу, до funded/activated. activatedAt_ — С1
      // (находка координатора): приезжает в ТОМ ЖЕ getDetails(), что уже
      // читаем строкой выше — ни одного лишнего вызова в цепь. 0, пока
      // сделка не активирована — I-B: пока так, якорь dealDeadlineFromCreation()
      // берёт nowMs, а не застревает на createdAtMs навсегда (см. докстринг
      // там же); следующий ночной прогон сам подхватит настоящий activatedAtMs,
      // когда он появится, и Math.max не даст сроку откатиться назад.
      const createdAtMs = Number(r.createdAt) * 1000;
      const activatedAtMs = Number(details.activatedAt_) * 1000;
      const ownDeadlineMs = Number(details.deadlineDays_) * 24 * 60 * 60 * 1000;
      // Решение владельца (раунд после И-1/C-1/И-2): "оплачена" — это
      // fundedAt_ > 0 (src/Agreement.sol: fund()/fundFromFactory() ставят
      // ТОЛЬКО fundedAt, деньги реально в эскроу), НЕ activatedAt_ — это
      // разные, неатомарные события (activate() зовёт ИСПОЛНИТЕЛЬ отдельным
      // вызовом, требует fundedAt != 0; между ними реальный разрыв до
      // ACTIVATION_WINDOW = 2 дня, статус FUNDED, деньги уже заперты, работа
      // ещё не началась). Читается из ТОГО ЖЕ getDetails(), что и остальные
      // поля выше — ни одного лишнего вызова в цепь. fundedAt_ уже был в
      // AGREEMENT_MINI_ABI (читался раньше, просто не использовался).
      //
      // Мелочь (координатор, критический раунд): единственное поле этого
      // ответа, оставшееся без проверки "не из будущего" — метка из
      // 5138 года молча давала бы бессрочное освобождение от потолка
      // (funded вычисляется только через > 0, любая положительная метка,
      // хоть настоящая, хоть абсурдная, проходит одинаково). Тот же
      // assertNotFromFuture, что уже применяется к createdAtMs/activatedAtMs
      // в dealDeadlineFromCreation() — тем же принципом, но здесь, у
      // самого входа: funded не параметр формулы, значение проверяется
      // ДО того, как превратится в булев флаг, а не внутри чужой функции,
      // которая funded вообще не видит.
      const fundedAtMs = Number(details.fundedAt_) * 1000;
      if (fundedAtMs > 0) assertNotFromFuture('adoptActivePairBags', 'fundedAtMs', fundedAtMs, nowMs);
      const funded = fundedAtMs > 0;
      const dealDeadline = dealDeadlineFromCreation({
        createdAtMs, activatedAtMs, ownDeadlineMs, disputeWindowMs,
        deadlineGraceMs, autoApproveWindowMs, nowMs,
      });
      const result = adoptPairBags(pairId, dealDeadline, nowMs, funded);
      logAdoptionResult('[bags] adoption (creation)', r.agreement, 'creation', result);
      // В-3: вложения — тем же сроком и в тот же миг, что и сообщения.
      const files = adoptPairFiles(pairId, dealDeadline, nowMs, funded);
      if (files) console.log(`[files] adoption (creation): extended ${files} attachment(s) of ${r.agreement}`);
    } catch (e) {
      console.error(`[bags] adoption (creation): failed for active agreement ${r.agreement}, skipping:`, e.message);
    }
  }
}

// disputed — уже полученный массив (fetchDisputedRecords(), вызванный ОДИН
// раз в runFileCleanup() — см. комментарий там про мелочь эффективности:
// раньше это была вторая, независимая getDisputed() поверх той, что уже
// делает защита вложений).
async function adoptDisputedPairBags(disputed, nowMs = Date.now()) {
  for (const r of disputed) {
    try {
      const pairId = pairIdFromAddresses(r.client, r.executor);
      const agr = new ethers.Contract(r.agreement, AGREEMENT_MINI_ABI, provider);
      const details = await agr.getDetails();
      const disputeWindowMs = await getDisputeWindowMs(agr, r.agreement);
      // Цепь считает время в секундах (block.timestamp), bagStore.js — в мс
      // (Date.now()-based, как и весь остальной _bagMeta).
      const disputedAtMs = Number(details.disputedAt_) * 1000;
      // Не предполагаем true (хотя спор физически не может возникнуть на
      // незапущенном эскроу) — читаем fundedAt_ из ТОГО ЖЕ getDetails(),
      // тем же принципом, что и на этапе 1: не доверять, проверять явно,
      // даже когда ожидаемое значение очевидно. Мелочь (координатор): та
      // же проверка "не из будущего", что и на этапе 1 — см. комментарий
      // там.
      const fundedAtMs = Number(details.fundedAt_) * 1000;
      if (fundedAtMs > 0) assertNotFromFuture('adoptDisputedPairBags', 'fundedAtMs', fundedAtMs, nowMs);
      const funded = fundedAtMs > 0;
      const dealDeadline = dealDeadlineFromDispute(disputedAtMs, disputeWindowMs);
      const result = adoptPairBags(pairId, dealDeadline, nowMs, funded);
      logAdoptionResult('[bags] adoption', r.agreement, 'dispute', result);
      // Задача 2 (4в-2): ящик спора — отдельный отбор, по СДЕЛКЕ. Ни одного
      // лишнего вызова в цепь: disputeWindowMs и funded уже прочитаны выше,
      // из того же getDetails(). Якорь — nowMs (эта ночь), а не disputedAt:
      // пока цепь говорит DISPUTED, у мешка ящика всегда впереди полный хвост
      // спора (см. disputeBoxBagDeadline в bagStore.js). Как только сделка
      // ушла из getDisputed(), сюда мы больше не попадаем — мешок доживает
      // последний хвост и уходит.
      const boxResult = adoptDealBags(
        String(r.agreement).toLowerCase(),
        disputeBoxBagDeadline(nowMs, disputeWindowMs),
        nowMs,
        funded,
      );
      logAdoptionResult('[bags] adoption (box)', r.agreement, 'box', boxResult);
      // В-3: вложения — тем же сроком и в тот же миг, что и сообщения.
      const files = adoptPairFiles(pairId, dealDeadline, nowMs, funded);
      if (files) console.log(`[files] adoption: extended ${files} attachment(s) of ${r.agreement}`);
    } catch (e) {
      console.error(`[bags] adoption: failed for disputed agreement ${r.agreement}, skipping:`, e.message);
    }
  }
}

// Задача 2 (4в-2), ревью круг 1, находка 1 (Important). adoptDisputedPairBags()
// выше отбирает по Registry.getDisputed() — а PUT /disputes/:agreement/bags
// (disputeBoxFacts()) спрашивает статус НАПРЯМУЮ у Agreement.getDetails().
// Это два разных источника, и расхождение — ШТАТНОЕ: Agreement._updateRegistry()
// (Agreement.sol:1261-1266) обёрнут в try/catch и на отказе синхронизации
// только эмитит RegistrySyncFailed, raiseDispute() (:695) при этом НЕ
// ревертит. Значит «Agreement говорит DISPUTED, реестр молчит» — легальное
// состояние контракта.
//
// В этом состоянии, БЕЗ этой функции: PUT принимает мешок (её замок смотрит
// в Agreement), а adoptDisputedPairBags() выше НИКОГДА его не находит (её
// отбор — по getDisputed()) — мешок ящика умирает через disputeBoxBagDeadline()
// от МОМЕНТА ПОСЛЕДНЕЙ ЗАПИСИ, хотя спор физически идёт. Ровно та беда, ради
// которой заведена вся Задача 2, только с другой причиной расхождения.
//
// Дёшево — на общем пути (устойчивое состояние: реестр обычно синхронен).
// listLiveBoxDeals() (bagStore.js) — обход описи В ПАМЯТИ, ноль обращений в
// цепь; known — уже прочитанный этим же прогоном disputed-массив реестра.
// Только для РАЗНИЦЫ (в устойчивом состоянии — пустой набор) идёт прицельное
// Agreement.getDetails() — по одному на РАСХОДЯЩИЙСЯ адрес, не по одному на
// каждый мешок в описи.
//
// ⚠️ Не подменяет Registry — только продлевает срок мешка НАПРЯМУЮ по
// источнику маршрута (то же Agreement), и громко предупреждает: реестр для
// этой сделки устарел, а syncRegistry(agreement) (Agreement.sol:1273,
// публична, любой может позвать) — штатный способ починить САМ реестр, не
// эта функция. Починка реестра и продление мешка — независимы: продление не
// ждёт первого.
async function adoptStrandedBoxBags(disputed, nowMs = Date.now()) {
  const known = new Set(disputed.map((r) => String(r.agreement).toLowerCase()));
  const liveBoxDeals = listLiveBoxDeals(nowMs);
  for (const deal of liveBoxDeals) {
    if (known.has(deal)) continue;
    try {
      const agr = new ethers.Contract(deal, AGREEMENT_MINI_ABI, provider);
      const details = await agr.getDetails();
      // Agreement уже НЕ говорит DISPUTED — расхождение решилось само (спор
      // действительно закрылся на обеих сторонах, реестр просто ещё не
      // позвал sync); продлевать нечего, предупреждать не о чем — это не
      // рассинхрон, а обычный мешок, доживающий прежний хвост.
      if (Number(details.status_) !== AGREEMENT_STATUS_DISPUTED) continue;
      const disputeWindowMs = await getDisputeWindowMs(agr, deal);
      const fundedAtMs = Number(details.fundedAt_) * 1000;
      if (fundedAtMs > 0) assertNotFromFuture('adoptStrandedBoxBags', 'fundedAtMs', fundedAtMs, nowMs);
      const funded = fundedAtMs > 0;
      const result = adoptDealBags(deal, disputeBoxBagDeadline(nowMs, disputeWindowMs), nowMs, funded);
      logAdoptionResult('[bags] adoption (box, registry stale)', deal, 'box', result);
      if (result.adopted) {
        console.warn(
          `[bags] adoption (box): agreement ${deal} is DISPUTED on Agreement.getDetails() but MISSING from ` +
          `Registry.getDisputed() — the registry is likely out of sync (Agreement._updateRegistry() failed ` +
          `silently, see RegistrySyncFailed). The box bag(s) were extended directly from Agreement, without ` +
          `waiting for that. Anyone can call syncRegistry(${deal}) to fix the registry itself.`
        );
      }
    } catch (e) {
      console.error(`[bags] adoption (box, registry stale): failed for ${deal}, skipping:`, e.message);
    }
  }
}

const AGR_STATUS_EVENT_ABI = [
  'event AgreementStatusUpdated(address indexed agreement, uint8 newStatus)',
];
const agrEventInterface = new ethers.Interface(AGR_STATUS_EVENT_ABI);

// Push config for RegistryFacet.AgreementStatus event (ACTIVE=0, COMPLETED=1, REFUNDED=2, DISPUTED=3, RESOLVED=4).
// ACTIVE(0) is omitted — fund() doesn't call updateStatus in the current contract.
// notify: 'executor' | 'client' | 'both' | 'both+arbiter'
//
// DISPUTED(3) is a fallback here, not the normal path: the two parties are in
// opposite positions the moment a dispute is raised (only the non-raiser can
// still respond, and only she loses a quarter by not doing it), so one message
// for both roles is wrong by construction. When the receipt carries the
// agreement's own DisputeRaised — every real raiseDispute does —
// sendDisputeRaised() splits it into two messages and this row goes to the
// raiser alone. It is still reached by a later syncRegistry() that carries the
// status without the raiser.
const AGR_PUSH_MSG = {
  1: { title: 'Deal Complete',      body: 'Payment has been released. The deal is closed.',      notify: 'both'         },
  2: { title: 'Deal Refunded',       body: 'The deal was cancelled and refunded.',                notify: 'both'         },
  3: { title: 'Dispute Raised',   body: 'A dispute was opened. An arbiter will review.',      notify: 'both+arbiter' },
  4: { title: 'Dispute Resolved', body: 'The arbiter has resolved the dispute.',              notify: 'both'         },
};

// ─── REFUNDED(2) is two different outcomes ────────────────────────────────────
//
// Agreement.triggerArbiterTimeout() ends the deal one of two ways, and the
// Registry gets the same REFUNDED(2) for both — the enum mirrors the agreement's
// frozen `enum Status` and cannot grow, so what distinguishes the cases is an
// event, not a status:
//
//   • nobody ever claimed the dispute → the escrow is SPLIT (floor(pot/2) to the
//     executor, the remainder to the client) and DisputeSplitNoVerdict is emitted;
//   • an arbiter claimed it and never delivered → the whole pot goes back to the
//     client and ArbiterTimedOut is emitted.
//
// Without this distinction AGR_PUSH_MSG[2] told an executor who had just received
// half the escrow that "the deal was cancelled and refunded" — the lie lands in
// the OS notification tray and stays there, unlike an on-screen toast.
//
// The signal is free: DisputeSplitNoVerdict is in the SAME receipt as the
// AgreementStatusUpdated we already decode (Agreement emits it after
// _complete()), so no extra chain read is needed.
const AGR_SPLIT_EVENT_ABI = [
  'event DisputeSplitNoVerdict(uint256 toClient, uint256 toExecutor)',
];
const agrSplitInterface = new ethers.Interface(AGR_SPLIT_EVENT_ABI);

const AGR_RESPONDED_EVENT_ABI = [
  'event DisputeResponded(address indexed party)',
];
const agrRespondedInterface = new ethers.Interface(AGR_RESPONDED_EVENT_ABI);

// Who raised the dispute. The Diamond's AgreementStatusUpdated says only THAT a
// dispute exists, never by whom — and the two parties are in opposite positions
// from the moment it is raised (see sendDisputeRaised below), so the raiser's
// address is what decides who gets which message. Agreement-emitted, hence its
// own interface rather than boardEventInterface.
const AGR_RAISED_EVENT_ABI = [
  'event DisputeRaised(address indexed by)',
];
const agrRaisedInterface = new ethers.Interface(AGR_RAISED_EVENT_ABI);

/** REFUNDED(2), the status the split shares with a genuine refund. */
const AGR_STATUS_REFUNDED = 2;

/** DISPUTED(3) — the status whose two recipients need two different messages. */
const AGR_STATUS_DISPUTED = 3;

/**
 * Exact USDC amount, never shorter than two decimals: 200000000 → "200.00",
 * 33 → "0.000033". Rounding is not allowed here — these numbers have to match
 * what the contract actually paid, and the pot splits unevenly when it is odd.
 */
export function usdcExact(value) {
  const [whole, frac = ''] = ethers.formatUnits(value ?? 0n, 6).split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
}

/**
 * DisputeSplitNoVerdict from THIS agreement in a mined receipt, or null.
 * Address-scoped on purpose: only the agreement the relayed call targeted may
 * decide how that deal's push reads.
 */
export function findDisputeSplit(logs, agreementAddress) {
  const target = agreementAddress?.toLowerCase();
  for (const log of logs ?? []) {
    if (target && log.address?.toLowerCase() !== target) continue;
    let ev;
    try { ev = agrSplitInterface.parseLog(log); } catch { continue; }
    if (ev?.name === 'DisputeSplitNoVerdict') {
      return { toClient: ev.args.toClient, toExecutor: ev.args.toExecutor };
    }
  }
  return null;
}

/**
 * Who responded to the dispute in this transaction. Scoped by agreement address
 * for the same reason as findDisputeSplit: the agreement itself emits this event,
 * not the Diamond, so it never lands in the shared boardEventInterface.
 */
export function findDisputeResponded(logs, agreementAddress) {
  const target = agreementAddress?.toLowerCase();
  for (const log of logs ?? []) {
    if (target && log.address?.toLowerCase() !== target) continue;
    let ev;
    try { ev = agrRespondedInterface.parseLog(log); } catch { continue; }
    if (ev?.name === 'DisputeResponded') return { party: ev.args.party };
  }
  return null;
}

/**
 * Both amounts, as numbers rather than the word "half": on an odd pot they
 * differ by a unit, and if USDC has blacklisted the executor the contract sends
 * his half to the client instead — in which case the event carries a zero and
 * this message says so, which is the truth.
 */
export function disputeSplitPushMsg({ toClient, toExecutor }) {
  return {
    title: 'Escrow Split',
    body:  `Nobody took the dispute, so there was nobody to judge it. The escrow was split: `
         + `${usdcExact(toExecutor)} USDC to the executor, ${usdcExact(toClient)} USDC to the client.`,
    notify: 'both',
  };
}

/**
 * Who raised the dispute, from this agreement's own log in a mined receipt, or
 * null. Address-scoped for the same reason as findDisputeSplit.
 */
export function findDisputeRaised(logs, agreementAddress) {
  const target = agreementAddress?.toLowerCase();
  for (const log of logs ?? []) {
    if (target && log.address?.toLowerCase() !== target) continue;
    let ev;
    try { ev = agrRaisedInterface.parseLog(log); } catch { continue; }
    if (ev?.name === 'DisputeRaised') return { by: ev.args.by };
  }
  return null;
}

/**
 * Unambiguous instant, in UTC to the minute: "2026-08-03 09:41 UTC". The relayer
 * has no user locale to render into (every push string here is hardcoded
 * English), and a bare date would hide up to a day of the window.
 */
export function utcMinuteLabel(date) {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * When the response window closes, as a Date — or null if it could not be read.
 *
 * NOT `now + 4 days`. `DISPUTE_WINDOW` already changed once (7 days → 4), a
 * hardcoded number would start lying silently, and unlike an on-screen hint a
 * push sits in the notification tray until it is dismissed. The frontend reads
 * it from the contract for exactly this reason; so does this.
 *
 * `disputedAt` costs nothing extra — it already came back in the `getDetails()`
 * the caller does anyway — so the only added read is the window itself. Using
 * the contract's own `disputedAt` rather than the block time of the receipt also
 * makes the printed instant the one `triggerArbiterTimeout` will actually
 * compare against, with no room for the two to drift.
 */
async function disputeResponseDeadline(agreementAddress, disputedAt) {
  if (!disputedAt) return null;
  try {
    const agr = new ethers.Contract(agreementAddress, AGREEMENT_MINI_ABI, provider);
    const window = await agr.DISPUTE_WINDOW();
    return new Date(Number(BigInt(disputedAt) + BigInt(window)) * 1000);
  } catch (e) {
    // Degrade, don't drop: the price of silence is still worth saying, and the
    // deal page shows the exact deadline. Staying quiet would be the bug this
    // whole message exists to fix.
    console.warn('[push] DISPUTE_WINDOW read failed — warning goes out without a date:', e.message ?? e);
    return null;
  }
}

/**
 * The message for the side that has NOT responded — the only one with anything
 * at stake. Names the deadline and the price of silence, because a rule nobody
 * is told about before it fires is a trap, not a rule.
 */
export function disputeRaisedWarningMsg(deadline) {
  const by = deadline ? ` by ${utcMinuteLabel(deadline)}` : '';
  return {
    title: 'Answer the Dispute',
    body:  `A dispute was opened on your deal. Answer it${by} — if you stay silent `
         + 'and nobody takes the case, you get a quarter of the escrow instead of half.',
  };
}

// activate(), markDone(), and fund() don't emit AgreementStatusUpdated,
// so we detect them by function selector and send push directly.
const FUNC_PUSH_MSG = {
  '0xb60d4288': { title: 'Deal Funded',      body: 'Your deal has been funded. Activate to start working.',    notify: 'executor' },
  '0x0f15f4c0': { title: 'Deal Activated',  body: 'Work has started. Track progress in the deal page.',        notify: 'client'   },
  '0x1bdfc6e3': { title: 'Work Submitted',   body: 'The executor marked the job as done. Please review it.',   notify: 'client'   },
};

// OS pushes for Diamond-emitted board / service / dispute-claim events. Recipients come
// straight from the event args, except JobApplied/ServiceRequested where the poster's
// address is read via getJob/getService. Independent of the relayed tx target.
async function pushBoardEvents(receipt) {
  for (const log of receipt.logs) {
    let ev;
    try { ev = boardEventInterface.parseLog(log); } catch { continue; }
    if (!ev) continue;
    try {
      switch (ev.name) {
        case 'JobAccepted':
          await sendPush(ev.args.executor.toLowerCase(), {
            title: "You're Hired",
            body:  'Your application was accepted. The deal is funded — activate to start.',
            url:   `/deal/${ev.args.agreement}`,
          });
          break;
        case 'RequestAccepted':
          await sendPush(ev.args.client.toLowerCase(), {
            title: 'Request Accepted',
            body:  'The executor accepted your request. The deal is live.',
            url:   `/deal/${ev.args.agreement}`,
          });
          break;
        case 'RequestRejected':
          await sendPush(ev.args.client.toLowerCase(), {
            title: 'Request Declined',
            body:  'The executor declined your request. Your funds were refunded.',
            url:   '/dashboard',
          });
          break;
        case 'JobApplied': {
          const board = new ethers.Contract(DIAMOND_ADDR, JOB_MINI_ABI, provider);
          const job = await board.getJob(ev.args.jobId);
          if (job?.client) await sendPush(job.client.toLowerCase(), {
            title: 'New Applicant',
            body:  'Someone applied to your job. Review and pick your executor.',
            url:   `/job/${ev.args.jobId}`,
          });
          break;
        }
        case 'ServiceRequested': {
          const board = new ethers.Contract(DIAMOND_ADDR, SERVICE_MINI_ABI, provider);
          const svc = await board.getService(ev.args.serviceId);
          if (svc?.executor) await sendPush(svc.executor.toLowerCase(), {
            title: 'New Service Request',
            body:  `A client requested your service (${(Number(ev.args.amount) / 1e6).toFixed(2)} USDC). Accept to start.`,
            url:   `/request/${ev.args.requestId}`,
          });
          break;
        }
        case 'DisputeClaimed': {
          const agr = new ethers.Contract(ev.args.agreement, AGREEMENT_MINI_ABI, provider);
          const d = await agr.getDetails();
          const payload = { title: 'Arbiter Assigned', body: 'An arbiter took your dispute. Expect a resolution soon.', url: `/deal/${ev.args.agreement}` };
          if (d.client_)   await sendPush(d.client_.toLowerCase(),   payload);
          if (d.executor_) await sendPush(d.executor_.toLowerCase(), payload);
          break;
        }
        case 'AppealRaised': {
          const agr = new ethers.Contract(ev.args.agreement, AGREEMENT_MINI_ABI, provider);
          const d = await agr.getDetails();
          const appellant = ev.args.appellant.toLowerCase();
          const other = d.client_?.toLowerCase() === appellant ? d.executor_ : d.client_;
          if (other) await sendPush(other.toLowerCase(), {
            title: 'Verdict Appealed',
            body:  'The dispute verdict was appealed and is under review.',
            url:   `/deal/${ev.args.agreement}`,
          });
          break;
        }
      }
    } catch (e) {
      console.error('[push] board event', ev.name, 'failed:', e.message);
    }
  }
}

async function pushAfterRelay(receipt, agreementAddress, calldata) {
  // Diamond-emitted board/service/dispute events — resolved from logs, independent of
  // the tx target, so this runs for every relayed tx.
  await pushBoardEvents(receipt);

  // Agreement-lifecycle events need getDetails() on the agreement, so this only fires
  // when the tx actually targeted (or deployed) one. Wrapped separately so a
  // non-agreement target (a board action) can't abort the board pushes above.
  try {
    const agr = new ethers.Contract(agreementAddress, AGREEMENT_MINI_ABI, provider);
    const details = await agr.getDetails();
    const client   = details.client_?.toLowerCase();
    const executor = details.executor_?.toLowerCase();
    const arbiter  = details.arbiter_?.toLowerCase();
    const ZERO     = '0x0000000000000000000000000000000000000000';

    const sendCfg = (cfg) => {
      const url = `/deal/${agreementAddress}`;
      const payload = { title: cfg.title, body: cfg.body, url };
      const sends = [];
      if (cfg.notify !== 'executor' && client)   sends.push(sendPush(client,   payload));
      if (cfg.notify !== 'client'   && executor) sends.push(sendPush(executor, payload));
      // 'both+arbiter' reaches nobody extra, and cannot be made to by fixing this
      // line. `arbiter` here is Agreement.arbiter, which is never a human: it is
      // address(0) until someone claims the dispute (which is exactly when
      // DISPUTED fires) and the DIAMOND afterwards (Diamond-as-arbiter, see
      // ARBITER_REGISTRY_MINI_ABI). Notifying the arbiter of a *fresh* dispute
      // would mean notifying every registered arbiter — a product decision, not
      // a lookup. The arbiter who does take the case learns it from his own
      // claimDispute; the parties are told by the DisputeClaimed branch below.
      if (cfg.notify === 'both+arbiter' && arbiter && arbiter !== ZERO) sends.push(sendPush(arbiter, payload));
      return Promise.allSettled(sends);
    };

    /**
     * A dispute was just raised, and the two parties are NOT in the same
     * position — so one message for both is wrong no matter how it is worded.
     *
     * `raiseDispute` marks the raiser as present on the spot
     * (`src/Agreement.sol`), which means `respondToDispute()` reverts
     * `AlreadyResponded` for him: he risks nothing and can do nothing. The clock
     * runs against the OTHER side, and until this existed she was warned by no
     * channel at all — her only push was AGR_PUSH_MSG[3], one message for both
     * roles, with neither the deadline nor the price of silence in it.
     *
     * `sendCfg` cannot express this: its `notify` field knows only the hardcoded
     * roles, and "the other side, whichever that is" is a comparison, not a
     * role — same as the AppealRaised case in pushBoardEvents().
     */
    const sendDisputeRaised = async (raiser) => {
      const url = `/deal/${agreementAddress}`;
      const by = raiser?.toLowerCase();
      const other = by === client ? executor : by === executor ? client : null;
      // The raiser isn't one of our two parties — the log and the target
      // disagree about whose deal this is, so trust neither and fall back to the
      // role-blind message rather than guess who is at risk.
      if (!by || !other) return sendCfg(AGR_PUSH_MSG[AGR_STATUS_DISPUTED]);

      const deadline = await disputeResponseDeadline(agreementAddress, details.disputedAt_);
      const warning = disputeRaisedWarningMsg(deadline);
      const raiserCfg = AGR_PUSH_MSG[AGR_STATUS_DISPUTED];
      return Promise.allSettled([
        // The raiser keeps the old copy: nothing is running against him.
        sendPush(by,    { title: raiserCfg.title, body: raiserCfg.body, url }),
        sendPush(other, { title: warning.title,   body: warning.body,   url }),
      ]);
    };

    // A split pot reaches the Registry as REFUNDED(2), exactly like a real refund —
    // only the agreement's own event in THIS receipt tells them apart. Resolved up
    // front because the Diamond's AgreementStatusUpdated is emitted first (from
    // inside _complete()) and the loop below returns on the first match.
    const split = findDisputeSplit(receipt.logs, agreementAddress);

    // Someone answered the dispute. The recipient here is ALWAYS the raiser, and
    // that is structural, not incidental: `raiseDispute` marks the raiser present,
    // so `respondToDispute()` is only callable by the second party, and the party
    // opposite whoever responded is therefore the one who already responded.
    //
    // Which makes this message purely informational, and it used to demand an
    // action that reverts — "answer it too" cost the reader a signature and the
    // relayer gas for a guaranteed AlreadyResponded. What he actually needs to
    // know is that the arithmetic moved: with both sides present a timeout splits
    // the escrow in half, where a minute ago three quarters of it were his.
    //
    // The side with something at stake is warned when the dispute is RAISED
    // (sendDisputeRaised above), not here — by then it is too late to be news.
    const responded = findDisputeResponded(receipt.logs, agreementAddress);
    if (responded) {
      const party = responded.party?.toLowerCase();
      const other = party === client ? executor : party === executor ? client : null;
      if (other) {
        await sendPush(other, {
          title: 'Dispute Answered',
          body:  'The other side answered the dispute. If nobody takes the case, the escrow is '
               + 'now split in half instead of three quarters to you.',
          url:   `/deal/${agreementAddress}`,
        });
        return;
      }
      // The responder is neither of the two parties this agreement reports — the
      // log and getDetails() disagree about whose deal this is. The `return` used
      // to be unconditional, so this case ate the Dispute Answered push AND
      // short-circuited the status loop and the selector fallback below it: two
      // notifications gone, nothing written down. Say so and fall through, the
      // same way sendDisputeRaised() falls back rather than dropping.
      console.error(
        `[push] DisputeResponded on ${agreementAddress} came from ${responded.party}, ` +
        `who is neither client (${client}) nor executor (${executor}) — "Dispute Answered" not sent`,
      );
    }

    // Check for AgreementStatusUpdated event first (terminal state changes).
    // Scoped to THIS agreement: the recipients, the deal URL and the copy below all
    // come from the target we already resolved, so a status event about a different
    // agreement would describe someone else's deal to our two parties. Today one
    // receipt can only carry one (MinimalForwarder.execute() makes a single inner
    // call), which is why this was never a live bug — but that is a property of the
    // caller, not of this loop, and findDisputeSplit() right above already scopes.
    // Who raised it, resolved up front for the same reason as the split above: the
    // Diamond's status event is decoded in the loop below, which returns on the
    // first match, and DISPUTED(3) alone doesn't say by whom.
    const raised = findDisputeRaised(receipt.logs, agreementAddress);

    const target = agreementAddress?.toLowerCase();
    for (const log of receipt.logs) {
      try {
        const parsed = agrEventInterface.parseLog(log);
        if (parsed?.name === 'AgreementStatusUpdated') {
          if (target && parsed.args.agreement?.toLowerCase() !== target) continue;
          const status = Number(parsed.args.newStatus);
          // DISPUTED(3) with the raiser known — two recipients, two messages.
          // Without the raiser (a later syncRegistry() carrying the status alone)
          // there is nobody to compare against, and the role-blind message below
          // is all we can honestly send.
          if (status === AGR_STATUS_DISPUTED && raised) {
            await sendDisputeRaised(raised.by);
            return;
          }
          const cfg = status === AGR_STATUS_REFUNDED && split
            ? disputeSplitPushMsg(split)
            : AGR_PUSH_MSG[status];
          if (cfg) await sendCfg(cfg);
          return;
        }
      } catch {}
    }

    // No status event — check if the called function is fund()/activate()/markDone().
    // Those three emit no AgreementStatusUpdated, so the selector IS their only
    // notification path. /relay/notify does not require `calldata` (only txHash and
    // agreement), so a caller that omits it silently loses Deal Funded / Deal
    // Activated / Work Submitted entirely — worth a line, it can only mean the
    // caller is malformed.
    if (typeof calldata !== 'string') {
      console.warn(`[push] no calldata for ${agreementAddress} — fund/activate/markDone pushes cannot be resolved`);
      return;
    }
    const cfg = FUNC_PUSH_MSG[calldata.slice(0, 10).toLowerCase()];
    if (cfg) await sendCfg(cfg);
  } catch (e) {
    // This catch wraps EVERYTHING above — getDetails(), the dispute reads, every
    // sendCfg(). Its comment claimed it only caught "not an agreement target", and
    // for a board action that is true: getDetails() does not exist on the Diamond,
    // so the call reverts and lands here by design. But a transient RPC failure on
    // a REAL agreement was indistinguishable from that, and took Deal Complete /
    // Refunded / Dispute Raised / Funded / Activated / Work Submitted down with it
    // in complete silence — the same disease the receipt polling above was added to
    // cure, one frame further in, and reachable right after that polling succeeds.
    //
    // We can tell the two apart: a board action targets the Diamond itself, an
    // agreement action does not. So the expected case stays quiet and everything
    // else is reported.
    if (agreementAddress?.toLowerCase() === DIAMOND_ADDR?.toLowerCase()) return;
    console.error(`[push] lifecycle pushes failed for agreement ${agreementAddress}:`, e.message);
  }
}

// ─── Local file storage ───────────────────────────────────────────────────────

// Сквозная проверка перед слиянием (8 августа): `process.env.PORT || 3001`
// отдавал СТРОКУ, а Node понимает нечисловую строку в listen() как ПУТЬ К
// UNIX-СОКЕТУ. Замер на обычной ФС: PORT=3O01 (буква O вместо нуля) —
// сервер поднимается, обратный вызов listen срабатывает, в журнале
// «Relayer running on :3O01», а снаружи по TCP его нет вовсе. Человек видит
// зелёный старт и мёртвый сервер — худший вид отказа из всех возможных.
// PORT=0 — свой сорт того же: Node выдаёт СЛУЧАЙНЫЙ свободный порт
// (замерено: 32843), куда обратный прокси не попадёт никогда.
//
// Отдельная функция, а не readPositiveInt(): у порта есть верхняя граница и
// требование целости, которых у прочих чисел нет.
const PORT         = readPort('PORT', 3001);
const BASE_URL     = (process.env.RELAYER_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STORAGE_DIR  = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const DIR_FILES    = path.join(STORAGE_DIR, 'files');   // encrypted chat files — 7d TTL
const DIR_PUBLIC   = path.join(STORAGE_DIR, 'public');  // permanent public files (profiles, avatars)
const DIR_TEMP     = path.join(STORAGE_DIR, 'temp');    // in-progress multipart chunks
const FILE_TTL_MS  = 7 * 24 * 60 * 60 * 1000;          // 7 days
// Потолок защиты вложения от чистки. Был локальной константой внутри
// runFileCleanup(); поднят сюда (В-3), потому что теперь его читает ещё и
// adoptPairFiles() — две копии одного числа разошлись бы молча.
// Совпадает с BAG_MAX_AGE_MS склада намеренно: у текста и вложения одного
// сообщения не должно быть разных потолков.
const FILE_MAX_PROTECTED_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

for (const dir of [DIR_FILES, DIR_PUBLIC, DIR_TEMP]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── Dispute Bot ──────────────────────────────────────────────────────────────

const SERVER_SECRET = process.env.SERVER_SECRET;
if (!SERVER_SECRET) throw new Error('SERVER_SECRET is not set');

// Задача 3: перечитать/провалидировать конфигурацию пропуска и склада
// мешков ЗДЕСЬ, после dotenv.config() выше. Оба модуля посчитали свои
// значения ещё на импорте (до dotenv — см. комментарий у импортов выше);
// без этого вызова первым, кто заметит отсутствующий SERVER_SECRET или
// битый STORAGE_DIR/*_MS/*_SIZE, был бы не старт процесса, а первый живой
// запрос к /bags/*.
assertBagPassReady();
assertBagStoreReady();
assertDirectoryReady();

// Бот-кошелька и его XMTP-сайнера здесь больше нет: 6 августа 2026 бот
// выключен целиком (разбор — хвост `index.js`). Он существовал ровно затем,
// чтобы состоять в парных группах XMTP и писать переписку в журнал спора
// открытым текстом; ни для чего другого его подпись не использовалась.
//
// Вместе с ним ушёл и `GET /bot-address` — маршрут отдавал адрес бота фронту,
// чтобы тот добавлял его в группу. Добавлять больше некого и некуда.

// ─── Log encryption ───────────────────────────────────────────────────────────

const DIR_LOGS = path.join(STORAGE_DIR, 'logs');
fs.mkdirSync(DIR_LOGS, { recursive: true });

/**
 * AES-256-GCM key for a given pair's log.
 * key = keccak256(pairId.toLowerCase() + SERVER_SECRET) → 32 bytes
 */
export function deriveLogKey(pairId) {
  return ethers.getBytes(
    ethers.keccak256(ethers.toUtf8Bytes(pairId.toLowerCase() + SERVER_SECRET))
  );
}

export function encryptEntry(key, obj) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(obj), 'utf8'),
    cipher.final(),
  ]);
  return {
    iv:      iv.toString('hex'),
    ct:      ct.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

export function decryptEntry(key, { iv, ct, authTag }) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ct, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

const ETH_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
export const PAIR_ID_RE  = /^0x[a-fA-F0-9]{40}-0x[a-fA-F0-9]{40}$/;

// Known push-service endpoint hosts. A subscription's `endpoint` is a URL the
// relayer later POSTs to (via web-push's sendNotification) — accepting an
// arbitrary client-supplied host here would let a malicious "subscription"
// turn the relayer into an SSRF proxy against any URL of the attacker's choosing.
const PUSH_SERVICE_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
  'web.push.apple.com',
];

export function isKnownPushServiceEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return PUSH_SERVICE_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function sortAddressPair(a, b) {
  const lc = [a.toLowerCase(), b.toLowerCase()];
  return lc[0] <= lc[1] ? lc : [lc[1], lc[0]];
}

export function pairIdFromAddresses(a, b) {
  const [x, y] = sortAddressPair(a, b);
  return `${x}-${y}`;
}

export function safeLogPath(pairId) {
  const id = pairId.toLowerCase();
  if (!PAIR_ID_RE.test(id)) throw new Error(`invalid pairId: ${id}`);
  const logPath = path.join(DIR_LOGS, `${id}.ndjson`);
  if (!path.resolve(logPath).startsWith(path.resolve(DIR_LOGS) + path.sep)) throw new Error('path escape');
  return logPath;
}

/**
 * ⚠️ ПИСАТЕЛЯ У ЖУРНАЛА СЕЙЧАС НЕТ. Единственным был бот XMTP (`botLog.js`),
 * выключенный 6 августа 2026 вместе со всей XMTP-обвязкой: он держал ключи от
 * переписки, а экран теперь обещает обратное. Функция оставлена не «на
 * всякий случай», а как место, куда придёт предъявление сторон (отдельный
 * план): у обеих половин разговора лежат самодостаточные доказательства
 * (`chatConversation.MessageProof`), и класть их сюда — та же запись.
 *
 * Пока писателя нет, `GET /dispute-log/:dealId` отдаёт то, что бот успел
 * записать до выключения, и НИЧЕГО НОВОГО. Арбитру это сказано словами —
 * `arbiter.no_history_log` в локалях больше не пишет «сообщений пока нет».
 */
export function appendLogEntry(pairId, entry) {
  const key = deriveLogKey(pairId);
  const encrypted = encryptEntry(key, entry);
  const line = JSON.stringify(encrypted) + '\n';
  fs.appendFileSync(safeLogPath(pairId), line);
}

// Читает журнал. Прежний потребитель (`botLog.js`, дедупликация при
// дочитывании истории) удалён вместе с ботом; остался `GET
// /dispute-log/:dealId` — им пользуется арбитр.
export function readLog(pairId) {
  const logPath = safeLogPath(pairId);
  if (!fs.existsSync(logPath)) return [];
  const key = deriveLogKey(pairId);
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return decryptEntry(key, JSON.parse(line)); }
      catch { return null; }
    })
    .filter(Boolean);
}

// Strips path traversal and unsafe chars — returns just the basename
export function safeKey(key) {
  return path.basename(String(key).replace(/[^a-zA-Z0-9.\-_]/g, '')).slice(0, 200);
}

// Cleanup: delete expired chat files and orphaned temp dirs. Exported as a plain
// function (not wrapped in cron.schedule here) so importing this module — e.g.
// from a test — never schedules a real recurring job; index.js is the only
// place that actually calls cron.schedule(runFileCleanup).
export async function runFileCleanup() {
  const cutoff   = Date.now() - FILE_TTL_MS;
  const cutoff1d = Date.now() - 24 * 60 * 60 * 1000;
  // Один вызов getDisputed() на весь прогон (мелочь эффективности, находка
  // координатора) — используется и защитой вложений (disputedPairIds ниже),
  // и усыновлением по спору (adoptDisputedPairBags() дальше по функции).
  const { ok: chainKnown, records: disputedRecords } = await fetchDisputedRecords();
  const disputedPairIds = disputedPairIdsFromRecords(disputedRecords);

  // В-3 (аудит устойчивости, 6 августа): УСЫНОВЛЕНИЕ ИДЁТ ПЕРВЫМ — раньше
  // обоих циклов удаления, а не между ними.
  //
  // Раньше оба этапа усыновления стояли ПОСЛЕ чистки вложений (и только
  // перед чисткой мешков). Для мешков порядок был верным и объяснён на
  // месте; для вложений — нет, и это ровно то, что делало В-3
  // невоспроизводимым «на второй прогон»: файл сносился в этом же прогоне,
  // за несколько строк до того, как сделка успевала его усыновить, и
  // усыновлять становилось нечего. Один и тот же аргумент («продлённое в
  // этом прогоне не должно попасть под нож этого же прогона») теперь
  // применён к обоим потребителям, а не к одному.
  //
  // Отдельные try на каждый этап — прежний принцип изоляции: падение одного
  // этапа усыновления не останавливает ни другой этап, ни любую из чисток.
  try {
    await adoptActivePairBags();
  } catch (e) {
    console.error('[bags] adoption (creation) error:', e.stack || e.message);
  }

  try {
    await adoptDisputedPairBags(disputedRecords);
  } catch (e) {
    console.error('[bags] adoption error:', e.stack || e.message);
  }

  // Задача 2 (4в-2), ревью круг 1, находка 1: только когда реестр реально
  // ОТВЕТИЛ этой ночью (chainKnown) — `disputedRecords` тогда настоящий
  // список, и «отсутствует в нём» значит «расходится», а не «узел молчал».
  // При chainKnown=false пропускаем целиком: пришлось бы читать Agreement
  // для КАЖДОГО живого мешка ящика без всякой пользы — К-1 уже откладывает
  // снос этих же записей ниже, продлевать вслепую нечем.
  if (chainKnown) {
    try {
      await adoptStrandedBoxBags(disputedRecords);
    } catch (e) {
      console.error('[bags] adoption (box, registry stale) error:', e.stack || e.message);
    }
  }

  // Expired chat files — skip any still tagged to a currently-disputed pair,
  // but only up to MAX_PROTECTED_AGE_MS. peerA/peerB tagging on /files/presign
  // has no proof-of-participation check — any caller can tag their own upload
  // with a real, public agreement's addresses even if they're not a party to
  // it, which would otherwise let unrelated content be "protected" forever for
  // as long as that agreement's dispute stays open. This ceiling bounds that.
  try {
    let removed = 0;
    let protectedCount = 0;
    let deferredCount = 0;
    let adoptedCount = 0;
    for (const f of fs.readdirSync(DIR_FILES)) {
      const fp = path.join(DIR_FILES, f);
      try {
        const mtimeMs = fs.statSync(fp).mtimeMs;
        if (mtimeMs < cutoff) {
          const pairId = filePairIdOf(f);
          const withinProtectionCeiling = mtimeMs > Date.now() - FILE_MAX_PROTECTED_AGE_MS;
          // В-3: усыновлённое сделкой живёт до конца дела — тем же сроком,
          // что и сообщение, к которому вложение приложено. Проверка стоит
          // ПЕРЕД спорной: спор — частный случай живого дела, а усыновление
          // покрывает и то время, когда спора ещё нет (бриф обсуждают ДО
          // сделки — ровно та дыра, ради которой всё это заведено).
          // Потолок здесь НЕ применяется повторно: он уже применён в
          // adoptPairFiles() на момент продления, по статусу именно той
          // сделки, что его выдала. Применить его ещё раз тут значило бы
          // обрезать оплаченную сделку, которой он не касается.
          const adoptedUntil = fileDealDeadlineOf(f);
          if (adoptedUntil !== null && Date.now() < adoptedUntil) {
            adoptedCount++;
            continue;
          }
          // К-1: НЕ ЗНАЕМ — НЕ СНОСИМ. Узел цепи не ответил, значит про
          // ЛЮБУЮ помеченную пару неизвестно, в споре она или нет. Раньше
          // это неведение приезжало сюда пустым множеством и было
          // неотличимо от честного «спорных пар нет» — то есть отказ сети
          // РАЗРЕШАЛ снос вместо того, чтобы его откладывать.
          //
          // Откладываем ровно то, про что не знаем: помеченные вложения в
          // пределах 90-дневного потолка. НЕпомеченное сносится как
          // обычно — оно не могло бы быть защищено спором ни при каком
          // ответе цепи, и знание цепи для решения по нему не нужно.
          // Потолок сохраняется и здесь: он существует против пометки без
          // доказательства участия, а отказ узла не повод этот потолок
          // снимать.
          if (!chainKnown && pairId && withinProtectionCeiling) {
            deferredCount++;
            continue;
          }
          if (pairId && disputedPairIds.has(pairId) && withinProtectionCeiling) {
            protectedCount++;
            continue;
          }
          fs.unlinkSync(fp);
          removed++;
          if (pairId) {
            delete _filePairs[f];
          }
        }
      } catch {}
    }
    // К-4: записи описи, за которыми файла НЕТ ВОВСЕ.
    //
    // Цикл выше ходит по ФАЙЛАМ на диске, а запись описи появляется раньше
    // всякого файла — на выдаче адреса. Человек, закрывший вкладку между
    // выдачей и заливкой (а до этой правки — и любой посторонний, который
    // просто дёргал выдачу), оставлял запись «кто с кем» НАВСЕГДА: удалять её
    // было некому, потому что файла, за которым бы пришли, не существовало.
    // Это и была «вечная опись», и она же — причина замедления, когда её
    // становится много.
    //
    // Считаем один раз по каталогу, а не `existsSync` на каждую запись: описи
    // и файлов могут быть десятки тысяч, и проверка по одному превратила бы
    // ночную чистку в десятки тысяч обращений к диску.
    let orphanPairs = 0;
    try {
      const present = new Set(fs.readdirSync(DIR_FILES));
      for (const key of Object.keys(_filePairs)) {
        if (!present.has(key)) { delete _filePairs[key]; orphanPairs++; }
      }
    } catch { /* каталог не прочёлся — не трогаем опись вообще */ }

    if (removed || protectedCount || orphanPairs || deferredCount || adoptedCount) _saveFilePairs();
    if (orphanPairs) console.log(`[files] cleanup: dropped ${orphanPairs} pair record(s) with no file`);
    if (removed) console.log(`[files] cleanup: removed ${removed} expired file(s)`);
    if (protectedCount) console.log(`[files] cleanup: protected ${protectedCount} file(s) — pair still disputed`);
    if (adoptedCount) console.log(`[files] cleanup: kept ${adoptedCount} file(s) adopted by a deal — same deadline as the message they belong to`);
    // К-1: отложенное обязано быть НАЗВАНО числом. Ночь, в которую уборка
    // отложена отказом сети, иначе неотличима в логе от ночи, в которую
    // сносить было нечего, — а это разные вещи: первая копит мусор.
    if (deferredCount) {
      console.log(
        `[files] cleanup: deferred ${deferredCount} tagged file(s) — the chain node did not answer, so it is ` +
        `unknown which pairs are disputed. They will be reconsidered on the next run that reaches the chain.`
      );
    }
  } catch (e) {
    console.error('[files] cleanup error:', e.message);
  }

  // Orphaned temp dirs (uploads that never completed)
  try {
    for (const d of fs.readdirSync(DIR_TEMP)) {
      const dp = path.join(DIR_TEMP, d);
      try {
        if (fs.statSync(dp).mtimeMs < cutoff1d) fs.rmSync(dp, { recursive: true, force: true });
      } catch {}
    }
  } catch {}

  // Задача 4 (chat-transport-storage): мешки переписки — отдельный try, тот
  // же принцип изоляции, что у двух блоков выше (файлы / temp-каталоги).
  // Падение чистки мешков не должно оставить вложения непочищенными, и
  // наоборот — до этой правки cleanupBags() не вызывалась вообще нигде, так
  // что просроченные мешки и обрезки от оборванных загрузок не удалялись
  // никогда (см. test/cleanup.test.js — тест ловит именно это на боевом
  // умолчании BAG_UNREAD_TTL_MS, без переопределения в тесте). cleanupBags()
  // сама синхронна (никаких await внутри) и работает с общим in-process
  // состоянием (_bagMeta в bagStore.js) — так что параллельный вызов из
  // наложившихся друг на друга запусков runFileCleanup() (ночной поверх ещё
  // не отработавшего) не может исполниться вперемешку: событийный цикл
  // Node.js гарантирует, что один синхронный вызов cleanupBags() всегда
  // отрабатывает от начала до конца, прежде чем управление может перейти ко
  // второму — это единственная причина, по которой отдельный try здесь
  // достаточен и не требует своего собственного лока.
  //
  // Про node-cron (закрывающий раунд ревью): проверено запуском на
  // установленной версии (node-cron@4.2.1, см. package.json) —
  // Runner.runTask() уже ловит исключение задачи сам (свой try/catch →
  // onError → собственный логгер) и не даёт процессу упасть, даже без
  // этого try/catch здесь. Это СВОЙСТВО КОНКРЕТНОЙ ВЕРСИИ зависимости, не
  // нашего кода — при апгрейде/даунгрейде node-cron посылка может
  // вернуться. Не полагаемся на неё: этот try/catch остаётся ради (а)
  // изоляции мешков от вложений внутри одного вызова и (б) собственного
  // узнаваемого сообщения — общий "[NODE-CRON] [ERROR]" не называет ИМЯ
  // задачи (в index.js их две — файлы/мешки и казна, различить можно
  // только по стеку).
  // Задача 5: усыновление (ОБА этапа) — ДО cleanupBags(), не после. Порядок в
  // этой же функции значим: если поменять местами, продлённый в этом же
  // прогоне мешок мог бы уже попасть под нож основного цикла cleanupBags()
  // чуть ниже (оба читают/пишут один и тот же _bagMeta синхронно, событийный
  // цикл между ними не переключается) — и усыновление успело бы "спасти"
  // мешок только СО СЛЕДУЮЩЕЙ ночи, ровно то, чего задача и должна избежать
  // (§6 спеки: важное не должно успеть истечь раньше усыновления). Отдельные
  // try на каждый этап — тот же принцип изоляции, что и у остальных блоков
  // этой функции: падение ОДНОГО этапа усыновления не должно останавливать
  // ни другой этап, ни чистку мешков, ни вложения, и наоборот. Порядок между
  // самими этапами (создание/спор) не значим для корректности — статусы
  // ACTIVE и DISPUTED взаимоисключающие, так что getActive() (внутри
  // adoptActivePairBags()) и disputedRecords (уже полученный выше) отражают
  // непересекающиеся наборы пар в любой момент; порядок ниже — просто по
  // смыслу повествования ("сначала создание, потом спор").
  try {
    // К-1 для мешков: тот же признак «цепь ответила», что уже правит
    // отсрочкой вложений выше. Без него гейт внутри cleanupBags() не
    // достигается вовсе — именно так первая редакция К-1 накрыла вложения
    // и оставила снаружи сами слова переписки.
    const { removed, kept, deferred } = cleanupBags(Date.now(), { chainKnown });
    // Закрывающий раунд ревью: печатать ВСЕГДА, не только когда removed>0
    // — иначе ночь без единого удаления и ночь, когда расписание вообще не
    // сработало (крон не выстрелил, процесс не поднялся), выглядят в логе
    // одинаково — тишиной. Явная строка с обоими числами превращает
    // "ничего не залогировано" в однозначный сигнал "чистка не отработала".
    console.log(`[bags] cleanup: removed ${removed}, kept ${kept}${deferred ? `, deferred ${deferred} (chain node unreachable)` : ''}`);
  } catch (e) {
    // Стек, не только e.message — собственный узнаваемый префикс
    // "[bags] cleanup error" не должен проигрывать в информативности тому,
    // что напечатала бы сама библиотека, если бы броску дали долететь до
    // её собственного catch (см. комментарий про node-cron выше).
    console.error('[bags] cleanup error:', e.stack || e.message);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL        = process.env.RPC_URL || process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
// Задача 5, мелочь (находка координатора, закрывающий раунд): без таймаута
// зависший RPC-узел на ЛЮБОМ вызове (изначально — только meta-транзакции и
// пуши; теперь ЕЩЁ и getActive()/getDisputed()/getDetails()/DISPUTE_WINDOW()
// на каждую сделку в adoptActivePairBags()/adoptDisputedPairBags()) вешает
// ВЕСЬ ночной прогон runFileCleanup() целиком, включая обычную чистку
// вложений и мешков — ethers v6 по умолчанию ждёт 300с (FetchRequest.timeout,
// см. node_modules/ethers/.../fetch.js) на КАЖДЫЙ отдельный вызов, так что
// зависание на первой же спорной сделке блокирует все остальные, и саму
// чистку, дольше, чем есть смысл ждать один battle-тестed узел. Раньше эта
// проблема уже существовала (мета-транзакции/пуши), новые вызовы этой задачи
// только повышают частоту, с которой она может сработать — не вводят её.
// Сквозная проверка перед слиянием (8 августа): RPC_TIMEOUT_MS=0
// принимался молча, а ethers понимает нулевой таймаут как «ждать без
// конца» (проверено: fr.timeout = 0 присваивается без возражений). То есть
// ручка, заведённая ровно против зависшего узла, при 0 отменяла собственное
// лекарство: один повисший вызов вешал весь ночной прогон целиком.
// readPositiveInt() отвергает 0, отрицательное и мусор при старте, называя
// переменную — ethers на 'abc' ругался и сам, но своим текстом, из которого
// не видно, какую переменную чинить.
const RPC_TIMEOUT_MS = readPositiveInt('RPC_TIMEOUT_MS', 20_000);
const RELAYER_KEY    = process.env.RELAYER_PRIVATE_KEY;
const FORWARDER_ADDR = process.env.TRUSTED_FORWARDER;
const DIAMOND_ADDR   = process.env.DIAMOND_ADDRESS;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:3001')
  .split(',').map(o => o.trim()).filter(Boolean);

if (!RELAYER_KEY)    throw new Error('RELAYER_PRIVATE_KEY is not set');
if (!FORWARDER_ADDR) throw new Error('TRUSTED_FORWARDER is not set');
if (!DIAMOND_ADDR)   throw new Error('DIAMOND_ADDRESS is not set');

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 10;
const _rateMap       = new Map();

// И-4 (ревью): второй параметр — тот же общий `_rateMap`/`RATE_WINDOW_MS`
// (60с), но с СВОИМ потолком вместо глобального RATE_MAX (10/мин). Каждый
// существующий вызывающий (везде в файле, кроме нового блока мешков ниже)
// зовёт с одним аргументом и получает ровно прежнее поведение — потолок по
// умолчанию `RATE_MAX`. Разные бюджеты мешков (выпуск пропуска/чтение/
// запись, см. BAG_PASS_RATE_MAX и соседей) используют одну и ту же карту, но
// разные КЛЮЧИ (bagPassRateKey/bagReadRateKey/bagWriteRateKey) — так что
// потолок здесь не обязан быть одним числом для всех ключей одновременно;
// он просто параметр конкретного вызова, а не свойство самой карты.
export function checkRateLimit(ip, max = RATE_MAX) {
  const now = Date.now();
  const entry = _rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _rateMap) {
    if (now > entry.resetAt) _rateMap.delete(ip);
  }
}, 5 * 60_000);

// ─── Ethers ───────────────────────────────────────────────────────────────────

// FetchRequest, не голая строка — единственный способ в ethers v6 задать
// таймаут отдельного HTTP-запроса (JsonRpcProvider(url) со строкой строит
// FetchRequest(url) сама, но с умолчанием библиотеки — 300с). Тест —
// test/*.test.js проверяет через relayerInfo.rpcTimeoutMs/provider ниже, что
// значение реально дошло до объекта, которым пользуется ethers, а не просто
// лежит переменной, которую никто не читает.
const rpcConnection = new ethers.FetchRequest(RPC_URL);
rpcConnection.timeout = RPC_TIMEOUT_MS;
const provider = new ethers.JsonRpcProvider(rpcConnection);
const relayer  = new ethers.Wallet(RELAYER_KEY, provider);

const FORWARDER_ABI = [
  'function getNonce(address from) view returns (uint256)',
  'function verify((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) view returns (bool)',
  'function execute((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) payable returns (bool success, bytes retdata)',
  // Without this the relayer had no way to see execute()'s own success flag at all —
  // MinimalForwarder.execute() never reverts on an inner-call failure, it just emits
  // this and returns (false, revertData), so a receipt.status === 1 tells you nothing.
  'event Executed(address indexed from, address indexed to, bool success)',
];

// Standalone Interface (not the mocked `forwarder` Contract instance below) so log
// parsing works the same whether `forwarder` is real or, in tests, replaced by the
// ethers.Contract mock in test/mocks — that mock never fakes `.interface`.
const FORWARDER_INTERFACE = new ethers.Interface(FORWARDER_ABI);

const forwarder = new ethers.Contract(FORWARDER_ADDR, FORWARDER_ABI, provider);

// ─── Forwarder inner-call revert decoding ────────────────────────────────────
// Mirrors the CUSTOM_ERRORS table in frontend/src/app/api/relay/route.ts, the other
// path that forwards through this same MinimalForwarder and already had to solve
// this. Duplicated rather than shared: relayer/ is plain Node ESM with no build
// step and route.ts is compiled by Next.js, so importing one from the other would
// mean standing up a small internal package neither app currently has for the sake
// of one lookup table. Keep the two tables in sync if either changes.
//
// Exported for the lock in test/forwarderErrorsMatchFacet.test.js: it checks the
// COMPOSITION of this table against the error declarations of ALL arbiter facets
// (src/facets/Arbiter*.sol — two of them today, the registry and accountability).
// It could read app.js as text and skip the export — but then it would guard a
// line in a file rather than the thing decodeForwarderRevert actually uses.
export const FORWARDER_CUSTOM_ERRORS = {
  '0xf12ce677': 'ActivationWindowPassed',
  '0x646cf558': 'AlreadyClaimed',
  '0xb6682ad2': 'CommitmentNotFound',
  '0x8e128786': 'CommitmentTooEarly',
  '0x53adc965': 'CommitmentExpired',
  '0xb737f1d8': 'NotTheClaimer',
  '0xb78c9549': 'DisputeWindowPassed',
  '0x422a8e97': 'VerdictAlreadySubmitted',
  '0x7fcc22c9': 'HasOpenDisputeClaims',
  '0xf1898254': 'AppealInProgress',
  //   AlreadyOverturned() — the hand may not press twice on one verdict. The
  //     flag was written and never read back as a refusal, so three presses
  //     against the SAME agreement reached the demotion threshold: unseating an
  //     arbiter cost one submitted verdict, not three disputes. resolveAppeal
  //     sets the same flag, so a verdict reversed by the vote is closed to the
  //     hand as well.
  //     ⚠️ This refusal is only half of "one verdict, at most one judicial
  //     mistake" — the reverse order, hand then panel, stays open on purpose
  //     and is handled inside resolveAppeal, which books nothing there and
  //     takes the hand's booking back. Nobody sees THAT as a refusal, so it has
  //     no entry here; it is named only so this comment does not read as the
  //     whole promise.
  '0xd8d3519a': 'AlreadyOverturned',
  '0xdf726563': 'NoVerdict',
  '0x7c9a1cf9': 'AlreadyVoted',
  '0x4dcfa42d': 'AlreadyAppealed',
  '0x7401943d': 'AppealWindowClosed',
  '0x2b6484d8': 'NoAppeal',
  '0xb4021411': 'CannotVoteOnOwnVerdict',
  '0xe3c5eb52': 'AppealAlreadyResolved',
  '0x1285c993': 'AppealWindowNotClosed',
  '0x0cdc2cad': 'VerdictFrozenError',
  '0x5216eba1': 'InsufficientArbitersForAppeal',
  '0x630ed4c8': 'NotLosingParty',
  // Платный вызов арбитра (ArbiterRegistryFacet). NoRefundableBounty — своя
  // ошибка withdrawDisputeBounty, NothingToPush — своя ошибка
  // withdrawTreasurySlice: две функции, два адресата, два разных сообщения.
  // Разными их сделали намеренно (ArbiterRegistryFacet.sol:233-237, тест
  // testBountyAndTreasuryErrorsAreNotTheSameSelector) — и обе обязаны лежать
  // ЗДЕСЬ, иначе разделение бессмысленно: неразобранный селектор долетает до
  // человека сырым хексом, и различать в нём нечего.
  // withdrawTreasurySlice открыта намеренно, её толкает кипер, а кипер ходит
  // тем же путём через релеер.
  '0x277093f8': 'TopUpNotNeeded',
  '0x88d471c4': 'BountyAlreadyFunded',
  '0xd3fc8f8a': 'DisputeAlreadyClaimed',
  '0x2d4e8c7b': 'NoRefundableBounty',
  '0x68d369c9': 'NothingToPush',
  '0x30b29a76': 'ActiveDealExists',
  '0xf9be60a2': 'AlreadyActive',
  '0x09dd1236': 'AlreadyDisputed',
  '0x5adf6387': 'AlreadyFunded',
  '0xc851267c': 'AlreadyMarkedDone',
  '0x6d5703c2': 'AlreadyResolved',
  '0xb7ae9877': 'ArbiterWindowNotPassed',
  '0x2eb35430': 'DeadlineNotPassed',
  '0x70f65caa': 'DeadlinePassed',
  '0x80cb55e2': 'NotActive',
  '0xccb665a6': 'NotArbiter',
  '0x20dbc874': 'NotClient',
  '0x433b0e14': 'NotDisputed',
  '0xc32d1d76': 'NotExecutor',
  '0xd5ef09ba': 'NotFunded',
  '0x38cbd109': 'NotMarkedDone',
  '0xc8ee2d1d': 'NotParty',
  '0xb5365156': 'NoArbiterSet',
  '0x49986e73': 'WrongAmount',
  '0x607311ec': 'WindowAlreadyPassed',
  '0x4dc5a7d2': 'WindowNotPassed',
  '0x1f2a2005': 'ZeroAmount',
  '0x2e020977': 'ExtraNotPending',
  '0x475a2535': 'AlreadyFinalized',
  // Kept: Agreement.sol still declares ZeroAddress(), and the deployed diamond runs pre-F-5 facets until the next diamondCut
  '0xd92e233d': 'ZeroAddress',
  '0x57876cd6': 'FactoryZeroAddress',
  '0x6ca1fdd7': 'RegistryZeroAddress',
  '0xdac33008': 'JobBoardZeroAddress',
  '0x317820eb': 'ArbiterZeroAddress',
  '0xd45bbaf9': 'ClientEqualsExecutor',
  '0xd04b63aa': 'NotDiamond',
  '0xad32732c': 'ArbiterIsParty',
  '0xa22d819e': 'ArbiterNotRegistered',
  '0xf4d678b8': 'InsufficientBalance',
  '0x32cc7236': 'NotFactory',
  '0x90b8ec18': 'TransferFailed',
  // ── ArbiterRegistryFacet, остаток ───────────────────────────────────────────
  // Дописано 14 августа 2026 вместе с шестью ошибками 4в-2 Выкатки 2. Таблица
  // велась вручную и отставала: из ~54 ошибок фасета здесь лежала половина, а
  // всё, чего в ней нет, доезжает до человека сырым хексом. Полнота теперь
  // сторожится замком test/forwarderErrorsMatchFacet.test.js — каждая
  // объявленная в фасете ошибка обязана быть здесь.
  '0x30cd7471': 'NotOwner',
  '0xabf29500': 'NotOwnerOrFeeRecipient',
  '0x3551edda': 'NotOwnerOrChief',
  '0xffc49e8e': 'NotOwnerOrDAO',
  '0x0feb6fac': 'AlreadyArbiter',
  '0xad196d5d': 'NotAnArbiter',
  '0xb72a2522': 'NotClaimed',
  '0xea8e4eb5': 'NotAuthorized',
  '0x6eb498a6': 'DAONotActive',
  '0x419652c3': 'ZeroChatKey',
  '0x92762df3': 'InsufficientXP',
  '0xff892798': 'VaultInsufficient',
  '0x5aa9184d': 'NoRewardToClaim',
  '0xac2e659e': 'InsufficientCleanStreak',
  '0xf098a90b': 'NotRegisteredAgreement',
  '0x7b14afdf': 'NoVerdictSubmitted',
  '0xa807d475': 'RewardPathRetired',
  // ── 4в-2 Выкатка 2: запись о молчании и отпечаток предъявления ──────────────
  // Все новые вызовы идут гейслесс, то есть именно этой дорогой: без имён
  // «рано», «уже записано» и «не ваш спор» человек увидел бы «Inner call
  // reverted» ровно там, где ему надо объяснить, почему кнопка не сработала.
  '0x7c27222a': 'NoResponseTooEarly',
  '0x61ba6a10': 'NoResponseAlreadyRecorded',
  '0x29d2e575': 'NotClaimingArbiter',
  '0x616d24a0': 'ClaimTimeUnknown',
  '0xe56aceea': 'NotDisputeParty',
  '0x506f3a1b': 'ZeroDigest',
  // ── The arbiter-accountability branch (August 2026) ─────────────────────────
  // Eight new refusals from ArbiterRegistryFacet. All eight stand on doors a
  // person opens by hand, and each answers "why did the button do nothing" —
  // without an entry here the answer would be "Inner call reverted".
  //   ChiefBlocWouldDecideAppeal — the chief seats so many of his own that
  //     they would decide an appeal by themselves; the chain refuses the
  //     seating, not a person.
  //   TooManyOpenClaims — the arbiter already holds his cap of disputes and
  //     cannot take another.
  //   ArbiterSuspendedError — the arbiter is suspended, the deadline is in the
  //     argument.
  //   HasLiveRemovalProposal — a live removal proposal already lies against
  //     this person; a second one is not written.
  //   DaoAddressNotSet — governance is being switched on without a successor
  //     named.
  //   SeatingHandedOver — the right to seat arbiters has passed to the DAO,
  //     and manual seating is shut for good.
  //   NotCurrentDaoAddress — the caller is not the DAO address recorded right
  //     now.
  //   ReseatingRemovedIsOwnerOnly — only the owner can bring back a REMOVED
  //     arbiter; that door is shut to the chief.
  '0xd02d6f54': 'ChiefBlocWouldDecideAppeal',
  '0xe7b00352': 'TooManyOpenClaims',
  '0xbc9ad5e6': 'ArbiterSuspendedError',
  '0x34a0af52': 'HasLiveRemovalProposal',
  '0x4488109e': 'DaoAddressNotSet',
  '0x6a4dd129': 'SeatingHandedOver',
  '0x6aba596c': 'NotCurrentDaoAddress',
  '0xcf5bfb95': 'ReseatingRemovedIsOwnerOnly',
  // ── ArbiterAccountabilityFacet, eight refusals of its OWN ───────────────────
  // ⚠️ THIS IS THE SECOND FACET, AND UNTIL TODAY NOTHING GUARDED IT. The lock
  // looked at the registry only, while half the arbiter surface had moved into
  // the accountability facet — that is, the very class of miss the lock was
  // built for was living right under its nose. The lock reads BOTH sources now.
  //
  // The facet's five remaining errors (NotOwner, NotOwnerOrChief, NotAnArbiter,
  // ArbiterZeroAddress, ZeroDigest) are declared in the registry too with the
  // same signature — hence the same selector, and no separate entry is needed.
  //   RemovalSuspensionIsRemovalAuthorityOnly — a suspension imposed by a
  //     removal is lifted only by whoever holds the removal right; the plain
  //     chief is refused here not "by role" but by the weight of that
  //     particular suspension.
  //   CauseNotProven — the cause claims to be chain-checkable, but the chain
  //     does not confirm it (the argument is the cause code).
  //   EvidenceRequired — an unverifiable cause with no evidence digest.
  //   RemovalHandedOver — the removal right has passed to the named successor;
  //     the owner gets the same refusal, and there is no way back.
  //   DisputeRefRequired — the "silence" cause cannot be proven without a
  //     reference to a dispute.
  //   DisputeRefNotApplicable — a dispute reference attached to a cause it does
  //     not belong to.
  //   AlreadyAnswered — the removed arbiter has already answered; a second
  //     answer is not written.
  //   NothingToAnswer — there is nothing to answer: no removal against this
  //     address.
  '0xaaffc640': 'RemovalSuspensionIsRemovalAuthorityOnly',
  '0x6db5710d': 'CauseNotProven',
  '0xeb8bf73b': 'EvidenceRequired',
  '0xe25d596d': 'RemovalHandedOver',
  '0xe7666a2e': 'DisputeRefRequired',
  '0xa7599ad5': 'DisputeRefNotApplicable',
  '0xdc1a1b7d': 'AlreadyAnswered',
  '0x6739e29d': 'NothingToAnswer',
  // ── The accusation gets words (design of 17 August 2026, decision 7) ────────
  //   ReasonRequired — the accuser pressed "remove for collusion" without
  //     writing a single word. "Inner call reverted" would not tell him that
  //     what is missing is the EXPLANATION — and an explanation is mandatory
  //     exactly where the chain stays silent: collusion, leak and "other", and
  //     on the PROPOSAL as much as on the removal.
  //     ⚠️ This refusal never arrives by this road: neither accusation door is
  //     gasless (see script/gasless-sender.allow), and through the forwarder
  //     they answer NotOwner/NotOwnerOrChief long before reaching the words.
  //     It is listed for completeness of the table, which
  //     forwarderErrorsMatchFacet guards — the same footing as the
  //     neighbouring NotOwnerOrChief and SeatingHandedOver.
  //   ReasonTooLong(uint256) — over the cap, and the cap is in BYTES, not
  //     characters. This one does arrive by this road: it comes from
  //     respondToRemoval, the facet's only gasless door, i.e. the words of the
  //     DEFENCE. The chain puts the real length in the argument, but both
  //     tables decode the name only — "by how much exactly" is shown to nobody
  //     today. That is a neighbouring open seam, not a promise. The form must
  //     ask the chain for the cap (getMaxReasonBytes) and count BYTES: a
  //     "40 characters left" counter lies fourfold on the first emoji.
  '0xbc7fd331': 'ReasonRequired',
  '0x4763e825': 'ReasonTooLong',
  // ── 48 hours between the accusation and the removal (design of 17 August
  //    2026, decisions 1-4) ─────────────────────────────────────────────────
  // The proposal existed but was optional and changed nothing: removal went
  // through in one transaction and the person learned of it after the fact. It
  // is now the only way in — the execution window is [48 hours, 14 days) from
  // the proposal, and the cause at execution must match the proposed one.
  //   NoLiveProposal — nothing to execute: no proposal stands against this
  //     address at all, or it was withdrawn. A separate refusal from
  //     ProposalStale on purpose: there the accusation existed and expired.
  //   RemovalTooEarly(uint256) — the clock is still running. The argument is
  //     THE MOMENT from which removal is allowed, so the form can say "19 hours
  //     to go" rather than "try later". Same open seam as ReasonTooLong above:
  //     both tables decode the name only, so the moment reaches nobody today.
  //   ProposalStale(uint256) — the proposal outlived its 14 days; executing it
  //     would mean an old accusation firing without a fresh warning.
  //   CauseDiffersFromProposal(uint8,uint8) — warned about one thing, removed
  //     for another. Changing the cause costs a withdrawal, a new proposal and
  //     another 48 hours; that is the price of an accusation, not a bug.
  //     ⚠️ Like ReasonRequired above, none of these four arrives by this road:
  //     removeArbiterForCause is not gasless (see script/gasless-sender.allow)
  //     and answers NotOwner through the forwarder long before reaching them.
  //     They are listed for completeness of the table, which
  //     forwarderErrorsMatchFacet guards.
  '0xa6891f1e': 'NoLiveProposal',
  '0x05b9bc6b': 'RemovalTooEarly',
  '0x84db9930': 'ProposalStale',
  '0x033d5425': 'CauseDiffersFromProposal',
  //   NotYourProposal — the caller is allowed on the withdrawal door in
  //     general, but this record belongs to someone else. Separate from
  //     NotOwnerOrChief on purpose: there the role is wrong, here the role is
  //     right. Withdrawal used to clear anyone's record and that was harmless
  //     while a proposal took nothing away; once the proposal became the only
  //     way in to a removal, clearing someone else's became the power to STOP
  //     one — which the chief was deliberately never given.
  '0x4fbe5f11': 'NotYourProposal',
  //   ProposalAlreadyLive(address,uint256) — one live accusation per person,
  //     and it holds the door. Overwriting someone else's proposal used to
  //     reset the 48-hour clock and leave nothing behind — the very power round
  //     1 denied the chief on withdrawProposal, walking back in one door over.
  //     Clearing a record now costs an explicit withdrawal, which the feed
  //     records. Same open seam as RemovalTooEarly above: the table decodes the
  //     name only, so `by` and `proposedAt` reach nobody today.
  '0x21efc74d': 'ProposalAlreadyLive',
};

// Decodes MinimalForwarder.execute()'s `retdata` (the inner call's own revert data)
// into a human-readable reason, same shape as route.ts's inline decode.
function decodeForwarderRevert(retdata) {
  const selector = retdata && retdata !== '0x' ? retdata.slice(0, 10).toLowerCase() : '';
  let reason = 'Inner call reverted';
  if (FORWARDER_CUSTOM_ERRORS[selector]) {
    reason = FORWARDER_CUSTOM_ERRORS[selector];
  } else if (selector === '0x08c379a0') {
    // Standard Error(string)
    try {
      reason = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + retdata.slice(10))[0];
    } catch { /* ignore decode errors, fall back to generic reason */ }
  }
  return { reason, selector };
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
  optionsSuccessStatus: 200,
}));

app.use(express.json({ limit: '64kb' }));

// Serve public files (profiles, avatars) — permanent, long-cached
// nosniff + CSP prevent XSS even if someone smuggled an unexpected file type
app.use('/public', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  next();
// Note: no 'immutable' — allows hard-refresh (Ctrl+Shift+R) to bypass cache.
// 'immutable' would lock in a broken cache (e.g. missing CORS headers) for a year.
}, express.static(DIR_PUBLIC, { maxAge: '1d' }));
/**
 * Ключ файла из адреса запроса. Внутри `app.use('/files', …)` `req.path` уже
 * без префикса. `safeKey` — та же чистка, что на записи (только
 * `[a-zA-Z0-9.\-_]`, `path.basename`, 200 знаков).
 */
function fileKeyFromPath(reqPath) {
  let raw = String(reqPath || '');
  if (raw.startsWith('/')) raw = raw.slice(1);
  try { raw = decodeURIComponent(raw); } catch { /* не декодируется — берём как пришло */ }
  return safeKey(raw);
}

// Serve encrypted chat files — content is always AES-256-GCM ciphertext.
//
// ⚠️ ЗДЕСЬ ДО 10 АВГУСТА 2026 БЫЛО НАПИСАНО ОБРАТНОЕ, и обратное было заперто
// ТРЕМЯ зелёными тестами («скачивание остаётся открытым — ключ и есть
// пропуск»). Довод — ключ есть случайный UUID, который знают только
// собеседники — верен ровно до того дня, когда у переписки появляется ТРЕТИЙ
// читатель. Арбитр им и становится: §5 замысла требует, чтобы он видел, ЧТО
// вложение было, и не мог его взять.
//
// Главный замок — не здесь: ключ вложения ушёл под вложенное запечатывание
// (frontend/src/lib/chatEnvelope.ts), а вид арбитра не несёт даже АДРЕСА
// файла (`RedactedFilePayload`). Этот замок — второй, и он про сообщения,
// отправленные ДО правки формы: у них ключ открыт, и живут они ещё семь дней
// (FILE_TTL_MS). Плюс он закрывает утечку адреса «мимо» предъявления.
//
// ⚠️ ПРОПУСКА ОДНОГО НЕДОСТАТОЧНО, и это замерено: пропуск склада есть у
// каждого пользователя чата, включая арбитра. Поэтому проверяется
// ПРИНАДЛЕЖНОСТЬ ПАРЕ по уже существующей описи (`file-pairs.json`,
// filePairIdOf).
//
// ⚠️ ЗАМОК ПОКА НЕ ПОЛНЫЙ, и это открытый пункт: разметка принадлежности
// ставится не на всех путях заливки, поэтому у части ключей пара неизвестна.
// Ужесточить «в лоб» нельзя — сломает честных с обеих сторон; закрывается
// разметкой на оставшемся пути, отдельной работой. Подробности (какой путь,
// при каком условии, с какого размера) намеренно не публикуются ни здесь, ни
// в docs/OPEN-ITEMS.md (пункт 52) до починки. Пробел заперт тестом.
//
// ⚠️ БЮДЖЕТ ЗДЕСЬ НАМЕРЕННО НЕ СПИСЫВАЕТСЯ. `requireChatFileAccess` списал бы
// адресный бюджет (40/мин), и переписка с пятью десятками картинок упёрлась
// бы в 429 при обычном открытии чата. Ограничитель на скачивании остаётся
// тем же, что был, — то есть его нет; это НЕ ухудшение относительно прежнего
// состояния и названо здесь, чтобы не считалось сделанным.
app.use('/files', (req, res, next) => {
  // Только настоящая выдача файла (express.static ниже). JSON-маршруты
  // семьи /files/* (presign, multipart, …) обязаны сохранить свой реальный
  // Content-Type, чтобы res.json() не был подписан октет-стримом.
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  // ⚠️ ЗАМОК СТОИТ ДО ЗАЩИТНЫХ ЗАГОЛОВКОВ. `res.json()` в Express НЕ
  // перебивает уже выставленный Content-Type — отказ уехал бы как
  // application/octet-stream, и клиент (и тест) увидел бы Buffer вместо
  // {code}. Тот же казус уже описан в relayer/test/fileStorage.test.js.
  const asker = requireBagPass(req, res);
  if (!asker) return;                       // 401 уже отправлен

  const pairId = filePairIdOf(fileKeyFromPath(req.path));
  if (pairId && !String(pairId).split('-').includes(String(asker).toLowerCase())) {
    res.status(403).json({ error: 'Not your file', code: 'not_your_file' });
    return;
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Content-Type', 'application/octet-stream');
  next();
}, express.static(DIR_FILES, {
  maxAge: '1h',
  // ⚠️ `private`, а не `public`: выдача теперь зависит от того, КТО просит.
  // Общий кэш на пути (прокси, тоннель) раздал бы уже проверенный ответ
  // следующему просящему, и замок выше не сработал бы ни разу.
  setHeaders(res) { res.setHeader('Cache-Control', 'private, max-age=3600'); },
}));

// TRUST_PROXY=true only when the relayer sits behind a proxy we control that
// rewrites the client-identifying headers — here a Cloudflare Tunnel. Leave it
// unset if the port is reachable directly: then these headers are whatever the
// caller typed, and honouring them hands anyone a rate-limit bypass.
//
// Note that leaving it unset is not "safe by default" either. Behind a tunnel
// every request arrives from the cloudflared container, so req.socket sees one
// address for the whole world and RATE_MAX becomes a global cap of 10 req/min
// shared by all users. Behind a proxy this must be true; without one, false.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

export function clientIp(req) {
  if (TRUST_PROXY) {
    // Cloudflare sets CF-Connecting-IP itself and strips whatever the caller
    // sent under that name, so it cannot be forged from outside the tunnel.
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return cf.trim();

    // Fallback for a non-Cloudflare proxy. Take the LAST hop, not the first:
    // each proxy APPENDS the address it observed, so the tail is what our own
    // nearest proxy actually saw. The head is whatever the caller chose to
    // claim — Cloudflare appends to a client-supplied X-Forwarded-For instead
    // of replacing it, so trusting the head would let anyone rotate fake
    // addresses and never hit the rate limit at all.
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const hops = forwarded.split(',');
      return hops[hops.length - 1].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

// ─── Core routes ──────────────────────────────────────────────────────────────

// В-1 (аудит устойчивости, 6 августа): здоровье обязано включать то, от
// чего зависит СОХРАННОСТЬ, а не только то, что процесс жив и отвечает.
//
// Раньше здесь стоял безусловный {status:'ok'}. Две беды из одного корня:
// отправитель получал 200 на сообщение, которое не переживёт перезапуск (в
// режиме недоверия склад держит запись только в памяти), а внешний надзор
// видел «жив» на сервере, который уже ничего не сохраняет — то есть беда
// не была бы замечена ровно тем механизмом, который для этого и поставлен.
//
// 503, а не 200 с полем: надзор смотрит на КОД. Поле, которое надо ещё
// разобрать и на которое надо ещё догадаться настроить проверку, — это то
// же самое молчание, только длиннее.
//
// Прежние поля (status/relayer/diamond) на месте — существующие
// потребители не ломаются, они просто получают ещё и `storage`.
app.get('/health', (_req, res) => {
  // Сквозная проверка перед слиянием: первая редакция этой ручки знала про
  // режим недоверия и отказ записи, но НЕ про полный диск — а сервер к тому
  // моменту уже отвечал `507 disk_full` на запись. Надзор видел `200 ok`:
  // беда УЖЕ наступила, УЖЕ отражена в отказах человеку, а внешний глаз о
  // ней не знал.
  //
  // Порог — ТОТ ЖЕ `DISK_RESERVE_BYTES` и та же мерка `freeBytesOnStorage()`,
  // которыми отвечает 507. Второй, свой порог здесь рано или поздно разошёлся
  // бы с первым молча, и `/health` начал бы врать в другую сторону.
  //
  // `null` — «измерить не вышло» (statfsSync отсутствует или не работает на
  // этой ФС, замечено на exFAT), и это НЕ «диск полон»: сломанная мерка не
  // повод красить весь надзор.
  const freeBytes = freeBytesOnStorage();
  const diskFull = freeBytes === null ? null : freeBytes < DISK_RESERVE_BYTES;
  const storage = {
    indexTrusted: isBagStoreHealthy(),
    lastPersistError: bagStorePersistError(),
    diskFull,
    freeBytes,
    reserveBytes: DISK_RESERVE_BYTES,
  };
  const healthy = storage.indexTrusted && storage.lastPersistError === null && diskFull !== true;
  res
    .status(healthy ? 200 : 503)
    .json({
      status: healthy ? 'ok' : 'degraded',
      relayer: relayer.address,
      diamond: DIAMOND_ADDR,
      storage,
    });
});

app.get('/nonce/:address', async (req, res) => {
  try {
    const nonce = await forwarder.getNonce(req.params.address);
    res.json({ nonce: nonce.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/balance', async (_req, res) => {
  try {
    const balance = await provider.getBalance(relayer.address);
    res.json({ address: relayer.address, balance: ethers.formatEther(balance) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dispute-log session pass ────────────────────────────────────────────────
//
// The wallet signature proves WHO is asking. It used to be demanded on every
// single GET, with a ±5 minute window, so an arbiter who opened the history,
// closed it and opened it again paid a third wallet popup on top of the two the
// commit-reveal claim already costs. The complaint that started this was exactly
// that: "three signatures to take one dispute".
//
// The pass replaces the *identity proof* on repeat reads, and nothing else:
//
//   • it does NOT replace authorization. Every request — pass or signature —
//     still asks the chain whether that address is the arbiter of this dispute
//     right now (disputeArbiterOf). Release the claim, get overturned off the
//     case, and the pass stops working on the very next read. So the pass is
//     not a capability handed out for 12 hours; it is a cached "I am 0xabc…",
//     and the real gate is re-evaluated on-chain every time.
//   • it is bound to one deal AND one address, so it cannot be carried to
//     another dispute, and another wallet gains nothing by holding it: the
//     server authorizes the address inside the token, not the bearer.
//   • it is a keyed MAC over (deal, address, expiry) using SERVER_SECRET, which
//     the relayer already requires at boot. Nothing is stored server-side: no
//     table to grow, no state to lose on restart, and a token cannot be forged
//     without the secret that also protects the chat-log encryption keys.
//
// Twelve hours: an arbiter reads a thread, waits for the parties to answer in
// the deal chat, comes back and re-reads — that is a working day, and a shorter
// TTL just recreates the popup fatigue this removes. Longer would start to
// outlive the browser session it is scoped to. DISPUTE_WINDOW is four days, so
// a full case still costs a handful of signatures at most, not one per click.
//
// No revocation path, by design: expiry is the only exit, which is why the TTL
// is a day and not a week.
export const DISPUTE_PASS_TTL_SEC = 12 * 60 * 60;
const DISPUTE_PASS_PREFIX  = 'v1';

function disputePassMac(body) {
  return createHmac('sha256', SERVER_SECRET)
    .update(`hexseal:dispute-log-pass:${DISPUTE_PASS_PREFIX}:${body}`)
    .digest('base64url');
}

export function issueDisputeLogPass(dealId, arbiter, nowSec = Math.floor(Date.now() / 1000)) {
  const expiresAt = nowSec + DISPUTE_PASS_TTL_SEC;
  const body = `${dealId.toLowerCase()}.${arbiter.toLowerCase()}.${expiresAt}`;
  return {
    token: `${DISPUTE_PASS_PREFIX}.${Buffer.from(body, 'utf8').toString('base64url')}.${disputePassMac(body)}`,
    expiresAt,
  };
}

/**
 * → { address } on success, or { error, code } describing why not.
 * `code` exists so the frontend can tell "sign again, your pass ran out" apart
 * from "you are not the arbiter here" — an expired pass that answered a bare
 * 403 would look identical to being thrown off the case.
 */
export function verifyDisputeLogPass(token, dealId, nowSec = Math.floor(Date.now() / 1000)) {
  const bad = { error: 'Invalid dispute log pass', code: 'pass_invalid' };
  if (typeof token !== 'string') return bad;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== DISPUTE_PASS_PREFIX) return bad;

  const [, encodedBody, mac] = parts;
  let body;
  try {
    body = Buffer.from(encodedBody, 'base64url').toString('utf8');
  } catch { return bad; }

  // Constant-time compare, and only after a length check — timingSafeEqual
  // throws on mismatched lengths instead of returning false.
  const expected = Buffer.from(disputePassMac(body), 'utf8');
  const given    = Buffer.from(mac, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return bad;

  const [tokenDeal, tokenAddr, expRaw] = body.split('.');
  if (!tokenDeal || !tokenAddr || !expRaw) return bad;
  if (!ETH_ADDR_RE.test(tokenDeal) || !ETH_ADDR_RE.test(tokenAddr)) return bad;
  // A pass minted for one deal must not open another one's log, even though the
  // MAC is genuine.
  if (tokenDeal !== dealId.toLowerCase()) return bad;

  const expiresAt = Number(expRaw);
  if (!Number.isFinite(expiresAt)) return bad;
  if (nowSec >= expiresAt) {
    return { error: 'Dispute log pass expired', code: 'pass_expired' };
  }

  return { address: tokenAddr };
}

// Dispute log — only accessible to the arbiter who holds this deal's dispute.
// First read: arbiter signs "hexseal:dispute-log:{dealId}:{unixSeconds}" and gets
// a `pass` back. Later reads: send that pass in `x-dispute-pass`, no signature.
app.get('/dispute-log/:dealId', async (req, res) => {
  const { dealId } = req.params;
  if (!ETH_ADDR_RE.test(dealId.toLowerCase())) return res.status(400).json({ error: 'Invalid dealId' });

  const ts   = req.headers['x-ts'];
  const sig  = req.headers['x-sig'];
  const pass = req.headers['x-dispute-pass'];

  let callerAddr;
  let issuePass = false;

  if (pass) {
    const verified = verifyDisputeLogPass(pass, dealId);
    if (verified.error) return res.status(401).json({ error: verified.error, code: verified.code });
    callerAddr = verified.address;
  } else {
    if (!ts || !sig) return res.status(401).json({ error: 'Missing x-ts or x-sig header' });

    // Replay protection for the signature path is unchanged: ±5 minutes. The
    // pass carries its own, much longer, expiry inside the MAC instead.
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - Number(ts)) > 300) {
      return res.status(401).json({ error: 'Timestamp out of window' });
    }

    try {
      const message = `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`;
      callerAddr = ethers.verifyMessage(message, sig).toLowerCase();
    } catch {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    issuePass = true;
  }

  try {
    // Authorization, re-checked on chain for BOTH paths. Reads the diamond, not
    // the agreement — Agreement.arbiter is the diamond itself (see
    // ARBITER_REGISTRY_MINI_ABI above).
    const onChainArbiter = await disputeArbiterOf(dealId);

    if (!onChainArbiter) {
      return res.status(403).json({ error: 'No arbiter assigned for this deal', code: 'no_arbiter' });
    }
    if (onChainArbiter !== callerAddr) {
      return res.status(403).json({ error: 'Not the arbiter of this deal', code: 'not_arbiter' });
    }

    // Log storage is keyed by pair (client+executor), not by this individual deal —
    // a pair's thread can span casual chat plus multiple deals over time, and the
    // arbiter is meant to see that full context, not just this deal's slice.
    const agr = new ethers.Contract(dealId, AGREEMENT_MINI_ABI, provider);
    const details = await agr.getDetails();
    const pairId = pairIdFromAddresses(details.client_, details.executor_);
    const entries = readLog(pairId);
    res.json(issuePass ? { entries, pass: issueDisputeLogPass(dealId, callerAddr) } : { entries });
  } catch (err) {
    console.error('[dispute-log] error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Пункт 44: за чей контракт релеер платит газ ──────────────────────────────
//
// Подпись ForwardRequest доказывает «этот человек подписал этот запрос», а НЕ
// «этот запрос про Hexseal». Пока `to` сверялся только с формой адреса, любой
// желающий подписывал своим ключом вызов ЧУЖОГО контракта, и газ за него платили
// мы: при потолке 10 запросов/мин и 7 млн газа на вызов это ~$3600 в сутки с
// ОДНОГО адреса в мейннете (docs/OPEN-ITEMS.md, пункт 44).
//
// Разрешены ровно два рода цели:
//   1. сам диамонд — сверка с константой, БЕЗ обращения к цепи. Через него идут
//      все доски и весь арбитраж, то есть подавляющее большинство вызовов —
//      и именно поэтому молчание узла для них не меняет ничего;
//   2. наш Agreement — по записи реестра getRecord(addr) на диамонде.
//
// ⚠️ Признак существования сделки — АДРЕС в записи, а не статус.
// RegistryStorage.AgreementStatus.ACTIVE == 0, значит нулевая запись
// незнакомого адреса выглядит «активной». Проверка по статусу пускала бы кого
// угодно; условие `client != 0` — подпорка на случай реестра, заполняющего
// запись в два приёма (сегодняшний register() пишет всю структуру разом,
// src/RegistryFacet.sol:142-150).
//
// Списка разрешённых ФУНКЦИЙ здесь нет и не будет — решение владельца: гибкость
// «фронт сам решает, что звать» несущая, а список закрыл бы дыру лишь частично
// (за чужой контракт можно платить любым разрешённым селектором). `data` не
// разбирается вовсе.
//
// ⚠️ ВТОРАЯ ПОЛОВИНА ЭТОГО ЗАМКА ЖИВЁТ ВО ФРОНТЕ: frontend/src/lib/relayTarget.ts,
// вызывается из frontend/src/app/api/relay/route.ts — и сегодня боевой путь
// именно тот, а не этот (см. комментарий ниже). Общего кода у них быть не может:
// разные рантаймы. Договор о ПОВЕДЕНИИ — shared/relay-target-scenes.json, его
// читают тесты обеих сторон; разошлись — краснеет та сторона, что отстала.
//
// ⚠️ РЕВЬЮ КРУГ 1, НАХОДКА 4 — `getRecord` стал единой точкой отказа денежного
// пути, и класс отказа шире, чем «diamondCut потерял селектор». Любой ревert
// из RegistryFacet (рассинхрон раскладки хранилища, забытая миграция и т.п.)
// даёт 503 chain_unavailable на КАЖДЫЙ агриментный вызов — прецедент в этом же
// репозитории: getOpenJobs() ревертил Panic(0x22) после разъезда раскладки
// хранилища JobBoard. Самолечения нет — isRelayDown (frontend/src/lib/relay.ts)
// узнаёт «релеер лежит» по тексту ошибки, не по коду chain_unavailable, значит
// фолбэка на кошелёк здесь не будет. Оставлено НАМЕРЕННО: учить isRelayDown
// доверять chain_unavailable значило бы отдавать фолбэк любому отказу реестра,
// включая сломанный сам замок (мутация 8 задачи 3) — молчаливый выход из
// сломанного замка тише самой поломки. Вопрос — за Задачей 8 плана 4в-2.
//
// ⚠️ РЕВЬЮ КРУГ 1, НАХОДКА 1 — чтение сразу после записи по отставшей реплике.
// Agreement разворачивается и регистрируется в реестре ОДНОЙ транзакцией
// (FactoryFacet.acceptRequest/acceptApplicant/deployAndFund), и следом фронт
// сразу шлёт гейслесс-вызов на свежий адрес. RPC за одним URL — пул реплик, и
// чтение может попасть на узел, ещё не увидевший блок регистрации — getRecord
// отдаёт нулевую запись, замок читает «не наш», честная сделка получает 403.
// Здесь этот путь спит (см. выше), но твин на фронте — боевой, и договор о
// ПОВЕДЕНИИ обязывает обе стороны отвечать на гонку одинаково: readOnce/
// readsAsOurAgreement ниже опрашивают, не читают один раз и надеются — тот же
// приём, что уже применён к RECEIPT_POLL этого файла и к lib/pollForFact.ts
// на фронте.
//
// РЕВЬЮ КРУГ 2, БЛОКЕР -> КРУГ 3, ИСПРАВЛЕНО. Ограничитель на живом (Next)
// пути ключевался по строке, которую выбирает нападающий (route.ts:from, без
// проверки формата), а опрос из круга 1 впервые сделал бездействие дорогим.
// Круг 2 предложил три средства; круг 3 оставил одно:
//  1. RELAY_TARGET_POLL.attempts ВОЗВРАЩЁН к 9 (круг 2 временно сжимал до 4,
//     ссылаясь на цифру из тестовой СЦЕНЫ, не на замер — отменено на круге 3,
//     см. докстринг RELAY_TARGET_POLL ниже);
//  2. RELAY_TARGET_NEGATIVE_CACHE УБРАН (заводился на круге 2, снят на круге
//     3 — переносил неудачу первого спросившего на любого другого);
//  3. настоящий ограничитель по IP остался — только в route.ts (relayer/app.js
//     уже ограничивает POST /relay по IP через clientIp(), см. app.post('/relay')
//     ниже — здесь чинить было нечего, IP-ключ уже стоял).
const REGISTRY_RECORD_ABI = [
  'function getRecord(address agreement) view returns (tuple(address agreement, address client, address executor, uint256 amount, uint8 status, uint256 createdAt, uint256 resolvedAt))',
];

// Кэшируем ТОЛЬКО положительные ответы. «Наш агримент» — свойство монотонное:
// реестр записи не удаляет. «Не наш» — не монотонное: адрес станет нашим в ту
// секунду, когда acceptApplicant/acceptRequest/deployAndFund создадут и
// зарегистрируют сделку в одной транзакции (src/FactoryFacet.sol:271, :320).
// Закэшированный отказ запер бы свежесозданную сделку на весь срок кэша.
//
// Срок нужен не реестру (он не отзывает), а нам: он ограничивает, сколько мы
// верим себе после замены диамонда. Размер — чтобы карта не росла вечно.
// Перезапуск процесса оставляет кэш пустым, и это безопасно: пустой кэш стоит
// лишнего чтения цепи, а не лишнего пропуска.
//
// Ревью круг 2 заводил ЕЩЁ и короткий отрицательный кэш — круг 3 его убрал:
// он переносил неудачу ПЕРВОГО спросившего на любого ДРУГОГО, кто спросил про
// тот же адрес в течение TTL, включая контрагента по той же свежесозданной
// сделке с собственным независимым шансом на опрос.
//
// Ревью круг 1, мелочь: RELAY_TARGET_CACHE_MAX экспортирован и сверяется с
// shared/relay-target-scenes.json («кэшРазмер») — то же число, что у
// фронтового близнеца, пиннится ОДНИМ местом (тест — в обоих файлах сцен).
const RELAY_TARGET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // 6 часов
export const RELAY_TARGET_CACHE_MAX = 1000;

// Ревью круг 1, находка 1 -> круг 3: бюджет опроса при «false» ответе.
// Интервал (750 мс) — то же число, что у фронтового близнеца, там это
// DEFAULT_POLL_INTERVAL_MS из lib/pollForFact.ts (импортировать через
// границу пакетов нельзя — разные npm-проекты, отсюда литерал, не импорт).
// ЧИСЛО ПОПЫТОК = 9, ТА ЖЕ цифра, что NONCE_POLL_ATTEMPTS фронта
// (lib/walletLock.ts) — и ВЗЯТА ОТТУДА, не изобретена: walletLock.ts:166-172
// документирует НАСТОЯЩИЙ замер (отставание реплик того же порядка, что блок
// Base Sepolia, ~2 с) и принятую в проекте доктрину ТРЁХКРАТНОГО запаса
// поверх измеренного — 9×750≈6.75 с даёт ровно её. (Круг 2 временно сжимал
// это число до 4, обосновывая цифрой «3 чтения» из тестовой СЦЕНЫ «отстаёт» —
// фикстуры, не замера; отменено на круге 3.) Цена этого числа при спаме
// теперь ограничена не им самим, а IP-лимитером в route.ts (30 запросов/мин
// × 9 = 270 чтений/мин с одного источника). Мутируемый экспортируемый объект
// (тот же приём, что RECEIPT_POLL): тесты сокращают stepMs до нуля, не
// трогая attempts.
export const RELAY_TARGET_POLL = { attempts: 9, stepMs: 750 };

const _ourAgreements    = new Map();   // "диамонд:адрес" (нижний регистр) → до какого мс верим
const _agreementLookups = new Map();   // тот же ключ → обещание ИДУЩЕГО чтения (склейка одновременных)

export function _resetRelayTargetCacheForTest() {
  _ourAgreements.clear();
  _agreementLookups.clear();
}

function rememberOurAgreement(key) {
  _ourAgreements.delete(key);        // переставить в конец очереди вставки
  _ourAgreements.set(key, Date.now() + RELAY_TARGET_CACHE_TTL_MS);
  while (_ourAgreements.size > RELAY_TARGET_CACHE_MAX) {
    const oldest = _ourAgreements.keys().next().value;
    _ourAgreements.delete(oldest);
  }
}

function cachedAsOurAgreement(key) {
  const until = _ourAgreements.get(key);
  if (until === undefined) return false;
  if (until <= Date.now()) { _ourAgreements.delete(key); return false; }
  return true;
}

/**
 * Одно чтение реестра, разобранное в true/false — БРОСАЕТ на «не удалось
 * прочитать» (узел молчит либо ответ не разбирается) вместо третьего
 * значения. Решает разницу между двумя классами беды: «false» (запись
 * пуста/чужая) стоит ПОВТОРИТЬ — гонка с отставшей репликой; «не прочиталось
 * вовсе» повторять незачем (сеть легла или ABI разъехался) — вызывающий
 * (`readsAsOurAgreement`) ловит бросок на ПЕРВОЙ попытке и отдаёт его без
 * единой лишней попытки, той же ценой в один read, что была до этой правки.
 *
 * Ревью круг 2, находка 2: подпорка `client !== ZERO_ADDR` УБРАНА. Автор
 * плана отменил решение исходной задачи (обоснование 3): register()
 * (src/RegistryFacet.sol:141-148) пишет структуру ОДНИМ присваиванием —
 * client != 0 при agreement != addr СТРУКТУРНО недостижим, не «маловероятен».
 * Хуже: подпорка регистронезависима (сравнение с нулевым адресом) и спасала
 * бы исход при любом регистре — маскировала .toLowerCase() у agreement
 * мёртвым замком даже на checksum-фикстурах круга 1. agreement === addr —
 * теперь единственная несущая проверка.
 */
async function readOnce(addr) {
  const registry = new ethers.Contract(DIAMOND_ADDR, REGISTRY_RECORD_ABI, provider);
  const record = await registry.getRecord(addr);
  const agreement = typeof record?.agreement === 'string' ? record.agreement.toLowerCase() : null;
  const client    = typeof record?.client    === 'string' ? record.client.toLowerCase()    : null;
  if (agreement === null || client === null) {
    console.error('[relay] реестр ответил тем, что не разбирается как запись сделки:', addr);
    throw new Error('registry response does not parse as a deal record');
  }
  return agreement === addr;
}

/**
 * Опрашивает `readOnce` до `RELAY_TARGET_POLL.attempts` раз, пока не увидит
 * `true` — тот же приём (три правила), что `waitForReceipt` в этом же файле и
 * `lib/pollForFact.ts` на фронте:
 *  1. первое чтение — без сна, и его сбой бросается НАРУЖУ без единой
 *     дальнейшей попытки (быстрый отказ — тот же, что был до опроса);
 *  2. не подтвердилось за все попытки — отдаём последнее прочитанное `false`,
 *     молча не виснем;
 *  3. сбой НЕ первой попытки (узел уже ответил хоть раз) не роняет весь
 *     опрос — глотаем и пробуем дальше с последним удачным значением.
 * true  — запись прочитана (в т.ч. после отставания), это наш агримент;
 * false — запись прочитана и это НЕ наш, даже после исчерпанных попыток;
 * null  — ПЕРВОЕ чтение не удалось — не повторяем; ЛИБО первое чтение
 *         разобралось, а все повторы бросили (см. правило 4 ниже).
 *
 * ⚠️ ПРАВИЛО 4, ИТОГОВОЕ РЕВЬЮ ВЕТКИ 4в-2: если после первого чтения НИ ОДНА
 * попытка не дала разобранного ответа, наружу уходит null («не знаем»), а не
 * последнее прочитанное `false`. Прежде правило 3 глотало все восемь бросков и
 * отдавало `false` — то есть 403 «не наш контракт» — на единственном
 * доказательстве от отставшей реплики, ровно той, ради которой опрос и
 * заведён. Разобралась хоть одна повторная проба — отказ остаётся 403: там
 * «не наш» подтверждён живым узлом. Близнец — frontend/src/lib/relayTarget.ts.
 */
async function readsAsOurAgreement(addr) {
  const { attempts, stepMs } = RELAY_TARGET_POLL;
  let value;
  try {
    value = await readOnce(addr); // правило 1, первая половина
  } catch (e) {
    console.error('[relay] реестр не ответил на getRecord:', e.message);
    return null; // правило 1, вторая половина: первый сбой — наружу, без опроса
  }
  if (value === true) return true;

  let разобралось = 1;   // первое чтение уже разобралось, иначе мы бы сюда не дошли
  for (let i = 1; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, stepMs));
    try {
      value = await readOnce(addr);
      разобралось += 1;
    } catch (e) {
      console.error('[relay] реестр не ответил на getRecord (попытка', i + 1, '):', e.message);
      continue; // правило 3
    }
    if (value === true) return true;
  }
  // Правило 4. `attempts > 1` — потому что без повторов единственное
  // разобравшееся чтение и есть полноценный ответ, а не остаток от опроса.
  if (attempts > 1 && разобралось === 1) {
    console.error('[relay] реестр ответил один раз и замолчал — вердикта нет:', addr);
    return null;
  }
  return value; // правило 2
}

/**
 * Можно ли платить газ за вызов к этому адресу.
 * Статус и код отказа возвращает САМА функция — у маршрута своих литералов нет,
 * поэтому «один путь тихо поменял код» здесь негде сделать.
 */
export async function relayTargetVerdict(to) {
  const addr = String(to).toLowerCase();
  const diamondLower = String(DIAMOND_ADDR).toLowerCase();

  if (addr === diamondLower) return { ok: true, kind: 'diamond' };

  // Ревью круг 1, мелочь: ключ кэша несёт диамонд, а не только адрес — тот же
  // повод, что у фронтового близнеца (relayTarget.ts), хотя здесь DIAMOND_ADDR
  // — константа модуля, не параметр: симметрия ради одного и того же шва.
  const key = `${diamondLower}:${addr}`;
  if (cachedAsOurAgreement(key)) return { ok: true, kind: 'agreement' };

  // Склейка одновременных: пятьдесят запросов об одном адресе стоят одного
  // чтения цепи, а не пятидесяти. Неудачное чтение НЕ запоминается — обещание
  // удаляется из карты, как только оно сойдётся.
  let lookup = _agreementLookups.get(key);
  if (!lookup) {
    lookup = readsAsOurAgreement(addr).finally(() => { _agreementLookups.delete(key); });
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
    // контрагента по той же свежесозданной сделке. Убран; каждый запрос
    // получает свой независимый опрос.
    return {
      ok: false, status: 403, code: 'target_not_ours',
      error: 'Target is not a Hexseal contract — the relayer pays gas only for its own',
    };
  }
  rememberOurAgreement(key);
  return { ok: true, kind: 'agreement' };
}

// ⚠️  RELAY IS SPLIT: frontend currently calls Vercel /api/relay/route.ts, NOT this endpoint.
// This endpoint is unused until VPS migration. On VPS: /api/relay/route.ts becomes a thin
// proxy to this endpoint (localhost:3001/relay) and duplication disappears.
// Any change to gas cap or relay logic must also be applied to frontend/src/app/api/relay/route.ts.
app.post('/relay', async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded. Max 10 requests per minute.' });
    }

    const { from, to, value = '0', gas, nonce, data, signature } = req.body;
    if (!from || !to || !gas || !data || !signature) {
      return res.status(400).json({ error: 'Missing fields: from, to, gas, data, signature' });
    }
    if (!ethers.isAddress(from) || !ethers.isAddress(to)) {
      return res.status(400).json({ error: 'Invalid address in from/to' });
    }

    // Ceiling on how much gas one ForwardRequest may ask the relayer to pay for.
    //
    // The previous 5M cap (itself a fix, raised from an earlier 3M) was sized
    // off pre-fee-economics measurements. Task 10 of the fee-economics-frontend
    // branch re-measured every gasless path at the form's actual maxLength
    // (mock USDC, foundry) and found several functions grew once cancel/reject
    // started doing a second transfer plus a `FeeCollected` log — most sharply
    // `acceptRequest`, which also stacks the worst-case 19-sibling refund loop:
    //
    //   acceptRequest    (19 siblings, terms 2000)                   3_219_461
    //   mintJob          (title 100 / description 500 / terms 2000)  2_791_334
    //   acceptApplicant  (terms 2000)                                2_332_247
    //   deployAndFund    (terms 2000)                                2_074_240
    //
    // `acceptRequest` is the operation that squeezed the old 5M cap: the
    // frontend's live gas estimate buffers the measured value 1.3x before the
    // signed request ever reaches this route — 3_219_461 * 1.3 = 4_185_299
    // against mock USDC, only 16% margin under 5M. Real USDC (proxied
    // FiatTokenV2_2) costs ~19% more than the mock per the same adjustment
    // Task 10 applied elsewhere: 3_219_461 * 1.19 * 1.3 ≈ 4_980_505 — 0.4%
    // margin, i.e. functionally no headroom left.
    //
    // Raised to 7M: keeps ~40% margin over acceptRequest's real-USDC estimate
    // (4_980_505) while still cutting the per-request ETH-drain ceiling versus
    // the original 8M this cap descended from.
    //
    // The asymmetry here is worth spelling out: a cap that's too low kills a
    // legitimate user action outright — worse, the direct-tx fallback doesn't
    // save it, since isRelayDown() (frontend/src/lib/relay.ts) only catches
    // network failures and 5xx, not this 400 — while a cap that's too high
    // costs nothing, because the chain charges gas actually used, not gas
    // requested. Rate limiting (10 req/min) is the other half of the drain
    // defence.
    //
    // Keep in sync with MAX_FORWARD_GAS in frontend/src/app/api/relay/route.ts
    // — the other path through the same forwarder.
    const MAX_GAS = 7_000_000n;
    if (BigInt(gas) > MAX_GAS) {
      return res.status(400).json({ error: `gas exceeds maximum (${MAX_GAS})` });
    }

    // Пункт 44: цель обязана быть нашей. Стоит ДО нонса, подписи и симуляции —
    // три обращения к узлу, которых чужой контракт получать не должен.
    const target = await relayTargetVerdict(to);
    if (!target.ok) {
      return res.status(target.status).json({ error: target.error, code: target.code });
    }

    const onChainNonce = await forwarder.getNonce(from);
    const forwardReq = { from, to, value: BigInt(value), gas: BigInt(gas), nonce: onChainNonce, data };

    const valid = await forwarder.verify(forwardReq, signature);
    if (!valid) return res.status(400).json({ error: 'Invalid signature' });

    const forwarderAsRelayer = forwarder.connect(relayer);
    const gasOverride = { gasLimit: BigInt(gas) + 60_000n };

    // ── Simulate execute() to catch silent inner-call failures ────────────────
    // MinimalForwarder.execute() deliberately does NOT revert when the forwarded
    // call fails — it consumes the nonce, emits Executed(from, to, false), and
    // returns (false, revertData); the outer tx still succeeds. staticCall runs
    // execute() without spending gas or broadcasting, so a doomed call is caught
    // — and paid for nothing — before we ever send it.
    let simSuccess, simRetdata;
    try {
      [simSuccess, simRetdata] = await forwarderAsRelayer.execute.staticCall(forwardReq, signature, gasOverride);
    } catch (err) {
      console.error('[relay] simulation failed:', err.message);
      return res.status(400).json({ error: `Simulation failed: ${err.message}` });
    }
    if (!simSuccess) {
      const { reason, selector } = decodeForwarderRevert(simRetdata);
      console.error('[relay] inner call failed (caught by simulation):', reason, 'retdata:', simRetdata);
      return res.status(400).json({ error: `Call failed: ${reason}`, errorCode: selector });
    }

    const tx = await forwarderAsRelayer.execute(forwardReq, signature, gasOverride);
    const receipt = await tx.wait();
    if (receipt.status === 0) return res.status(400).json({ error: 'Transaction reverted on-chain' });

    // ── Re-verify after mining ─────────────────────────────────────────────────
    // A passing simulation does not guarantee the real tx still succeeds — state
    // can change between the two (another tx lands in the interim), so the mined
    // receipt's own Executed(from, to, success) log is the actual source of truth.
    let minedSuccess = true; // no matching log found is unexpected, not a signal — fail open, not closed
    for (const log of receipt.logs ?? []) {
      if (log.address?.toLowerCase() !== FORWARDER_ADDR.toLowerCase()) continue;
      try {
        const parsed = FORWARDER_INTERFACE.parseLog(log);
        if (parsed?.name === 'Executed') { minedSuccess = parsed.args.success; break; }
      } catch { /* not a log this ABI recognizes */ }
    }
    if (!minedSuccess) {
      console.error('[relay] inner call failed on the mined tx despite a passing simulation (state changed in between)');
      return res.status(400).json({ error: 'Transaction mined but the inner call failed (state changed after simulation)' });
    }

    res.json({ success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber });
    // Floating on purpose — the response is already out and a push must never
    // delay a tx. But it needs its own .catch(): pushAfterRelay() starts with
    // `await pushBoardEvents(receipt)`, which is OUTSIDE its internal try, so a
    // receipt without `logs` throws a TypeError that escapes as an unhandled
    // rejection — and on Node >= 15 that takes the whole relayer down. The same
    // call from /relay/notify has always been wrapped; this one was not.
    pushAfterRelay(receipt, forwardReq.to, data)
      .catch(e => console.error(`[push] post-relay pushes failed for ${receipt.hash}:`, e.message));
  } catch (err) {
    console.error('[relay] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── File endpoints — local disk ──────────────────────────────────────────────
//
// Small encrypted files (≤ 20 MB):
//   POST /files/presign           → { uploadUrl, downloadUrl, key }
//   PUT  /files/upload-put/:key   → streams body to DIR_FILES/<key>
//
// Large encrypted files (> 20 MB), chunk-by-chunk:
//   POST /files/multipart/create  → { uploadId, key, partUrls[] }
//   PUT  /files/part/:id/:num     → streams chunk to DIR_TEMP/<id>/<num>
//   POST /files/multipart/complete→ concatenates chunks → { downloadUrl }
//   POST /files/multipart/abort   → removes temp dir
//
// Public permanent files (profiles, avatars):
//   POST /files/public/presign    → { uploadUrl, publicUrl, key }
//   PUT  /files/public-put/:key   → streams body to DIR_PUBLIC/<key>
//
// URL refresh (local URLs never expire, just verify file still exists):
//   POST /files/refresh-url       → { downloadUrl }
//
// Serving:
//   GET  /files/:key              → express.static(DIR_FILES)
//   GET  /public/:key             → express.static(DIR_PUBLIC)

// ─── К-4: вход на файловый сервер чата ───────────────────────────────────
//
// ЧТО ЗДЕСЬ БЫЛО. `POST /files/presign` и вся многокусочная дорога рядом:
// без пропуска, без ограничителя, до 5 ГБ на файл. Готовый способ забить
// диск дешёвого VPS — и заодно анонимная запись в опись «кто с кем».
//
// ⚠️ ГРАНИЦА, КОТОРУЮ НЕЛЬЗЯ ПЕРЕЙТИ. Этими маршрутами пользуется НЕ ТОЛЬКО
// чат. Замерено (test/chatFilesPass.test.js, последний блок): рядом живут
// профили и аватары — `/files/public/presign` и `/files/public-put`, — и
// зовёт их СЕРВЕРНЫЙ маршрут `frontend/src/app/api/ipfs/upload/route.ts`, у
// которого кошелька нет и пропуска взять неоткуда. Пропуск требуется только
// от чат-семьи маршрутов; публичная семья остаётся как была.
//
// Скачивание чат-файла (`GET /files/:key`) тоже остаётся открытым, и это не
// упущение: ключ — случайный UUID, который знают только собеседники, а
// содержимое зашифровано на устройстве. Пропуск на скачивание не добавил бы
// секретности, зато сломал бы уже разосланные ссылки.
const CHAT_FILE_RATE_MAX    = readPositiveInt('CHAT_FILE_RATE_MAX',     40);
const CHAT_FILE_IP_RATE_MAX = readPositiveInt('CHAT_FILE_IP_RATE_MAX', 200);

// Куски многокусочной заливки — СВОЙ бюджет, отдельный от выдач.
//
// Замерено (test/chatFileBytes.test.js): два вложения по 200 МБ — это
// 2 × (1 создание + 25 кусков по 8 МБ + 1 сборка) = 54 запроса, а бюджет
// адреса был 40 на всё. Из 54 запросов 14 получали 429, то есть **второе
// вложение умирало на середине заливки**. Это не нападение, а самый обычный
// день: человек отправил два больших файла подряд.
//
// Считать куски вместе с выдачами было ошибкой: у них разная природа. Выдача
// заводит сеанс и стоит дёшево, поэтому её скупость осмысленна; кусок несёт
// байты, и его уже держат ДВА других предела — размер куска и сумма кусков
// при сборке. Ограничивать его ещё и счётчиком запросов значит ограничивать
// одно и то же трижды, причём самым грубым из трёх способов.
//
// 600 в минуту: 24 полных вложения по 200 МБ, то есть заведомо больше, чем
// пропустит потолок байтов и запас диска.
const CHAT_FILE_PART_RATE_MAX = readPositiveInt('CHAT_FILE_PART_RATE_MAX', 600);

function chatFileRateKey(address) { return `chatfile:${address}`; }
function chatFilePartRateKey(address) { return `chatfile-part:${address}`; }
function chatFileIpRateKey(ip)    { return `chatfile-ip:${ip}`;    }

// Потолок на файл. Пять гигабайт были не щедростью, а необеспеченным
// обещанием: столько на дешёвом VPS просто нет, и первый же такой файл
// положил бы вместе с собой ВСЁ — мешки, опись, журналы споров, мета-
// транзакции. Двести мегабайт — вдесятеро больше порога многокусочной
// заливки (20 МБ), то есть чат работает как работал, но один файл больше не
// способен занять заметную долю диска. Фронт обещает ровно это же число
// (`frontend/src/lib/fileStorage.ts`), и на совпадение есть тест — иначе
// человек узнавал бы о потолке от сервера, уже залив полфайла.
const MAX_CHAT_FILE_SIZE = readPositiveInt('MAX_CHAT_FILE_SIZE', 200 * 1024 * 1024);
export { MAX_CHAT_FILE_SIZE };

// Сколько места обязано остаться свободным, чтобы принимать чат-файлы.
// Отвечает на вопрос «диск кончился — вернули ошибку или упали целиком?»:
// чат-файлы отказывают первыми и в одиночку, а мешкам, описи и журналам
// споров остаётся запас. Без этого правила порядок отказа определялся тем,
// кто первым не смог записать.
const DISK_RESERVE_BYTES = readPositiveInt('DISK_RESERVE_BYTES', 2 * 1024 * 1024 * 1024);

/** Свободно ли на томе хранилища больше запаса. `null` — измерить не вышло. */
function freeBytesOnStorage() {
  try {
    const st = fs.statfsSync(STORAGE_DIR);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    // `statfsSync` может отсутствовать или не работать на файловой системе
    // (замечено на exFAT). Сломанная мерка — не повод отказать человеку:
    // без неё мы ровно там же, где были до этой правки, а ENOSPC ниже по
    // потоку по-прежнему обработан.
    return null;
  }
}

/**
 * Общий вход для всей чат-семьи файловых маршрутов. Порядок — от дешёвого к
 * дорогому, тот же, что у мешков: бюджет выхода → пропуск → бюджет адреса.
 * `needsDisk` — только для тех маршрутов, что реально пишут байты.
 * `part: true` — заливка куска: свой, щедрый бюджет (см. CHAT_FILE_PART_RATE_MAX).
 *
 * Возвращает адрес владельца пропуска или `null`, уже ответив клиенту.
 */
function requireChatFileAccess(req, res, { needsDisk = false, part = false } = {}) {
  if (!checkRateLimit(chatFileIpRateKey(clientIp(req)), CHAT_FILE_IP_RATE_MAX)) {
    bagRateLimited(res, 'rate_limited_ip');
    return null;
  }
  const address = requireBagPass(req, res);
  if (!address) return null;

  const [key, max] = part
    ? [chatFilePartRateKey(address), CHAT_FILE_PART_RATE_MAX]
    : [chatFileRateKey(address),     CHAT_FILE_RATE_MAX];
  if (!checkRateLimit(key, max)) {
    bagRateLimited(res, 'rate_limited_files');
    return null;
  }

  if (needsDisk) {
    const free = freeBytesOnStorage();
    if (free !== null && free < DISK_RESERVE_BYTES) {
      res.status(507).json({ error: 'Storage is full', code: 'disk_full' });
      return null;
    }
  }
  return address;
}

// ── Small encrypted file presign ──────────────────────────────────────────────

app.post('/files/presign', (req, res) => {
  const owner = requireChatFileAccess(req, res, { needsDisk: true });
  if (!owner) return;
  try {
    // Chat files are always encrypted binary blobs — extension is cosmetic only.
    // We ignore whatever ext the client sends and always use .bin so that
    // express.static never serves them with a text/html or image MIME type.
    const key = `${Date.now()}-${randomUUID()}.bin`;

    // Метка пары, чтобы ночная чистка щадила вложения, пока у пары открыт
    // спор.
    //
    // ⚠️ ПЕРВЫЙ УЧАСТНИК ПАРЫ БОЛЬШЕ НЕ БЕРЁТСЯ ИЗ ТЕЛА. Раньше брались оба
    // (`peerA`, `peerB`), без всякого доказательства, что зовущий имеет к
    // ним отношение — то есть кто угодно писал в вечную опись «кто с кем»
    // произвольную пару чужих адресов (они публичны в цепи), да ещё и
    // получал этим защиту своего файла от чистки на всё время чужого спора.
    // Теперь первый участник — владелец пропуска, и соврать про него
    // нечем.
    const { peerB } = req.body || {};
    if (typeof peerB === 'string' && ETH_ADDR_RE.test(peerB.toLowerCase())) {
      // В-3: новая, совместимая форма записи — пара плюс срок (пока пустой,
      // его проставит первое усыновление сделкой).
      _filePairs[key] = { p: pairIdFromAddresses(owner, peerB), d: null };
      _saveFilePairs();
    }

    res.json({
      uploadUrl:   `${BASE_URL}/files/upload-put/${key}`,
      downloadUrl: `${BASE_URL}/files/${key}`,
      key,
      expiresIn: '7 days',
      maxSize: MAX_CHAT_FILE_SIZE,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Small encrypted file upload (streaming, size-limited) ────────────────────

const MAX_PUBLIC_SIZE =           5 * 1024 * 1024; // 5 MB — avatars, profiles
const MAX_PART_SIZE   =          50 * 1024 * 1024; // 50 MB — per multipart chunk

// MAX_BAG_SIZE (Задача 3) is a quarter megabyte — `Math.round(bytes/1024/1024)`
// alone renders that as "(max 0 MB)", which is a genuine lie, not just an ugly
// number. KB below 1 MB, same rounding above it.
function formatMaxSize(maxBytes) {
  return maxBytes >= 1024 * 1024
    ? `${Math.round(maxBytes / 1024 / 1024)} MB`
    : `${Math.round(maxBytes / 1024)} KB`;
}

// onFinish, if given, replaces the default "200, empty body" success response —
// called with the written filePath once the stream has finished, aborted:false.
// Задача 3's bag upload route needs this: it has to stat the file (real bytes on
// disk, not the client-claimed size), persist metadata, and shape its own JSON
// body — none of which the three pre-existing callers below need, and none of
// them pass a 5th argument, so their behaviour is unchanged (undefined → old
// branch).
// Найдено попутно (не находка ревью — обнаружено собственным флаки-прогоном
// теста на И-1/И-2 несколько раз подряд, не одним прогоном): fs.unlink(path,
// () => {}) — «выстрелил и забыл», колбэк не дожидается завершения удаления
// перед тем, как маршрут отправит ответ. Тест, проверяющий сразу после
// ответа, что осиротевшего файла на диске больше нет, время от времени видел
// его ещё лежащим — не баг теста, а настоящая гонка: ответ мог уйти раньше,
// чем ОС успевала обработать unlink. Синхронное удаление — тот же путь
// исполнения (обработчик события, не запрос к сети), блокировать нечего;
// try/catch — файла может и не быть (например, ws.destroy() не успел
// сбросить ни байта), это не должно быть отдельной ошибкой.
function unlinkQuietSync(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* already gone, or never existed — fine either way */ }
}

function streamWithSizeLimit(req, res, filePath, maxBytes, onFinish) {
  let received = 0;
  let aborted  = false;
  const ws = fs.createWriteStream(filePath);
  req.on('data', (chunk) => {
    received += chunk.length;
    if (!aborted && received > maxBytes) {
      aborted = true;
      ws.destroy();
      unlinkQuietSync(filePath);
      // `code` (Задача 6, план «Клиент чата»): у 401/404/429 машинный признак
      // был с самого начала, у 413 — нет, и клиенту оставалось разбирать
      // английский текст, чтобы отличить «слишком большой файл» от «негодный
      // адрес» (оба 4xx). То же значение, что уже отдаёт обработчик
      // `entity.too.large` ниже — одна причина, один код, независимо от того,
      // поймал её парсер тела или этот поток.
      if (!res.headersSent) res.status(413).json({ error: `File too large (max ${formatMaxSize(maxBytes)})`, code: 'payload_too_large' });
      req.destroy();
    }
  });
  req.pipe(ws);
  ws.on('finish', () => {
    if (aborted) return;
    if (onFinish) { onFinish(filePath); return; }
    if (!res.headersSent) res.status(200).end();
  });
  // Находка ревью: четвёртая ветка сироты, не три — ws.on('error') это
  // отказ самой ЗАПИСИ посреди приёма (буквально "кончилось место на
  // диске", ENOSPC, а не оборванное соединение или превышение размера).
  // Раньше эта ветка не выставляла aborted и не удаляла файл вообще —
  // обрезок оставался на диске точно так же, как в двух других ветках,
  // ради которых делалась И-2, только про эту забыли. Общий помощник —
  // значит то же самое относилось и к обычным файловым маршрутам
  // (/files/*), не только к мешкам.
  ws.on('error', (err) => {
    aborted = true;
    unlinkQuietSync(filePath);
    // `write_failed`, а не `internal_error`: это НЕ «сервер сломался», это
    // «кончилось место на диске» — единственный отказ загрузки, о котором
    // человеку стоит сказать другими словами («попробуйте позже», а не
    // «сократите файл»). Различить их клиент обязан кодом.
    if (!res.headersSent) { console.error('[upload]', err.message); res.status(500).json({ error: 'Write error', code: 'write_failed' }); }
  });
  // И-2 (ревью): a dropped connection mid-upload (client closes the socket,
  // network drop) used to only stop the write — whatever had already landed
  // on disk stayed there, orphaned, with no metaindex entry (recordBag()
  // never ran). The only thing that would ever pick it up is the mtime-based
  // orphan sweep, not before BAG_UNREAD_TTL_MS (30 days by default) — and
  // Задача 4 hasn't even wired that sweep into the nightly schedule yet.
  // Same cleanup as the size-limit abort branch above: mark aborted so
  // ws.on('finish') (which can still fire after this) doesn't call onFinish
  // on a truncated file, and delete what was written so far.
  req.on('error', () => {
    if (aborted) return;
    aborted = true;
    ws.destroy();
    unlinkQuietSync(filePath);
  });
}

app.put('/files/upload-put/:key', (req, res) => {
  // Без этого адрес заливки был предъявительским: кто угодно, угадав или
  // подсмотрев ключ, писал байты — и, что важнее, выдача ключа сама по себе
  // ничего не стоила, так что угадывать было незачем.
  if (!requireChatFileAccess(req, res, { needsDisk: true })) return;
  const key = safeKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'Invalid key' });
  streamWithSizeLimit(req, res, path.join(DIR_FILES, key), MAX_CHAT_FILE_SIZE);
});

// ── URL refresh (local files don't expire by URL, only by TTL cleanup) ────────

app.post('/files/refresh-url', (req, res) => {
  if (!requireChatFileAccess(req, res)) return;
  try {
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Invalid key' });
    const safeK = safeKey(key);
    if (!fs.existsSync(path.join(DIR_FILES, safeK))) {
      return res.status(404).json({ error: 'File not found or expired' });
    }
    res.json({ downloadUrl: `${BASE_URL}/files/${safeK}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Public file presign (profiles, avatars — permanent) ───────────────────────
// Only whitelisted extensions allowed — prevents HTML/SVG XSS via static serve

const PUBLIC_ALLOWED_EXT = new Set(['.json', '.png', '.jpg', '.jpeg', '.webp', '.gif']);

app.post('/files/public/presign', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded' });
  }
  try {
    const { ext = '' } = req.body || {};
    const safeExt = String(ext).replace(/[^a-zA-Z0-9.]/g, '').toLowerCase().slice(0, 10);
    const dotExt  = safeExt.startsWith('.') ? safeExt : (safeExt ? `.${safeExt}` : '');
    if (dotExt && !PUBLIC_ALLOWED_EXT.has(dotExt)) {
      return res.status(400).json({ error: `File type not allowed. Allowed: ${[...PUBLIC_ALLOWED_EXT].join(', ')}` });
    }
    const key = `${Date.now()}-${randomUUID()}${dotExt}`;
    res.json({
      uploadUrl: `${BASE_URL}/files/public-put/${key}`,
      publicUrl: `${BASE_URL}/public/${key}`,
      key,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Public file upload (streaming) ────────────────────────────────────────────
// Profile JSONs (profile-0x<addr>.json) require an Ethereum signature from
// the profile owner to prevent unauthorized overwrites.

const PROFILE_KEY_RE = /^profile-(0x[a-f0-9]{40})\.json$/i;

// Tracks last-seen updatedAt nonce per address — prevents signature replay.
// Persisted to disk (mirrors _filePairs'/_pushSubs' own load/save pattern in
// this same file) so a server restart doesn't reset every address's floor
// back to 0 and allow a previously-valid, since-superseded signed profile
// update to be replayed.
const PROFILE_NONCES_FILE = path.join(STORAGE_DIR, 'profile_nonces.json');
function loadProfileNonces() {
  try {
    if (existsSync(PROFILE_NONCES_FILE)) {
      const raw = JSON.parse(readFileSync(PROFILE_NONCES_FILE, 'utf8'));
      return new Map(Object.entries(raw));
    }
  } catch {}
  return new Map();
}
function saveProfileNonces() {
  try { writeFileSync(PROFILE_NONCES_FILE, JSON.stringify(Object.fromEntries(_profileNonces)), 'utf8'); } catch {}
}
const _profileNonces = loadProfileNonces();

app.put('/files/public-put/:key', async (req, res) => {
  const key = safeKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'Invalid key' });

  const profileMatch = key.match(PROFILE_KEY_RE);
  if (profileMatch) {
    // ── Signed profile upload ──────────────────────────────────────────────
    // Content-Type is application/octet-stream (set by uploader) so express.json()
    // never consumes the stream — we read raw bytes here safely.
    const address = profileMatch[1].toLowerCase();
    const sig     = req.headers['x-profile-signature'];
    if (!sig) return res.status(401).json({ error: 'Profile upload requires X-Profile-Signature' });

    // 1. Buffer raw body
    const chunks = [];
    try { for await (const chunk of req) chunks.push(chunk); }
    catch { return res.status(400).json({ error: 'Body read error' }); }
    const body    = Buffer.concat(chunks);
    const bodyStr = body.toString('utf8');

    // 2. Parse JSON and extract nonce
    let profileData;
    try { profileData = JSON.parse(bodyStr); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    // The edit-form UI already checks this client-side, but a caller who signs
    // and uploads a profile JSON directly bypasses that entirely — their own
    // wallet signature is always valid for their own address. Reject an unsafe
    // scheme here so a javascript: URI can never be persisted and served back.
    const website = profileData?.links?.website;
    if (website && typeof website === 'string') {
      let scheme = null;
      try { scheme = new URL(website).protocol; } catch { /* invalid URL */ }
      if (scheme !== 'http:' && scheme !== 'https:') {
        return res.status(400).json({ error: 'links.website must be an http(s) URL' });
      }
    }

    const nonce = profileData.updatedAt;
    if (typeof nonce !== 'number' || !Number.isFinite(nonce)) {
      return res.status(400).json({ error: 'Missing or invalid updatedAt nonce' });
    }
    const lastNonce = _profileNonces.get(address) || 0;
    if (nonce <= lastNonce) {
      return res.status(400).json({ error: 'Stale nonce — replay detected' });
    }

    // 3. Verify: signed message commits to address + nonce + body hash
    //    message = "hexseal:profile:update:<addr>:<nonce>:<keccak256(body)>"
    const bodyHash = ethers.keccak256(ethers.toUtf8Bytes(bodyStr));
    const message  = `hexseal:profile:update:${address}:${nonce}:${bodyHash}`;
    let recovered;
    try { recovered = ethers.recoverAddress(ethers.hashMessage(message), sig).toLowerCase(); }
    catch { return res.status(400).json({ error: 'Invalid signature format' }); }

    if (recovered !== address) {
      console.warn(`[files/public-put] sig mismatch: recovered=${recovered} expected=${address}`);
      return res.status(403).json({ error: 'Signature mismatch' });
    }

    // 4. Persist nonce, write file
    _profileNonces.set(address, nonce);
    saveProfileNonces();
    fs.writeFile(path.join(DIR_PUBLIC, key), body, (err) => {
      if (err) { console.error('[files/public-put]', err.message); return res.status(500).json({ error: 'Write error' }); }
      res.status(200).end();
    });
    return;
  }

  // ── Non-profile files: stream with size limit ───────────────────────────
  streamWithSizeLimit(req, res, path.join(DIR_PUBLIC, key), MAX_PUBLIC_SIZE);
});

// ── Multipart create ──────────────────────────────────────────────────────────

app.post('/files/multipart/create', (req, res) => {
  if (!requireChatFileAccess(req, res, { needsDisk: true })) return;
  try {
    const { ext = '', chunkCount } = req.body || {};
    if (!chunkCount || chunkCount < 1 || chunkCount > 10000) {
      return res.status(400).json({ error: 'chunkCount must be 1–10000' });
    }
    const safeExt  = String(ext).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
    const uploadId = randomUUID();
    const key      = `${Date.now()}-${randomUUID()}${safeExt}`;

    fs.mkdirSync(path.join(DIR_TEMP, uploadId), { recursive: true });

    const partUrls = Array.from({ length: chunkCount }, (_, i) =>
      `${BASE_URL}/files/part/${uploadId}/${i + 1}`
    );

    res.json({ uploadId, key, partUrls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Multipart part upload (streaming, one chunk per request) ──────────────────

app.put('/files/part/:uploadId/:partNum', (req, res) => {
  // `part: true` — свой бюджет: считать куски вместе с выдачами убивало
  // ВТОРОЕ крупное вложение в минуту на середине заливки (замер в
  // test/chatFileBytes.test.js).
  if (!requireChatFileAccess(req, res, { needsDisk: true, part: true })) return;
  const uploadId = safeKey(req.params.uploadId);
  const partNum  = parseInt(req.params.partNum, 10);
  if (!uploadId || isNaN(partNum) || partNum < 1 || partNum > 10000) {
    return res.status(400).json({ error: 'Invalid uploadId or partNum' });
  }
  const dir = path.join(DIR_TEMP, uploadId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Upload session not found' });

  const filename = String(partNum).padStart(6, '0');
  // Кусок не может быть больше файла целиком: MAX_PART_SIZE (50 МБ) — предел
  // ОДНОГО куска, а не разрешение превысить им весь потолок. При потолке
  // меньше 50 МБ побеждает потолок.
  streamWithSizeLimit(req, res, path.join(dir, filename), Math.min(MAX_PART_SIZE, MAX_CHAT_FILE_SIZE));
});

// ── Multipart complete — concatenate chunks ───────────────────────────────────

app.post('/files/multipart/complete', async (req, res) => {
  if (!requireChatFileAccess(req, res, { needsDisk: true })) return;
  try {
    const { uploadId, key } = req.body || {};
    if (!uploadId || !key) return res.status(400).json({ error: 'uploadId and key required' });

    const safeUploadId = safeKey(uploadId);
    const safeK        = safeKey(key);
    const tempDir      = path.join(DIR_TEMP, safeUploadId);
    const destPath     = path.join(DIR_FILES, safeK);

    if (!fs.existsSync(tempDir)) return res.status(404).json({ error: 'Upload session not found' });

    const parts = fs.readdirSync(tempDir).sort();
    if (!parts.length) return res.status(400).json({ error: 'No parts found' });

    // ⚠️ ПОТОЛОК ФАЙЛА ДЕЙСТВУЕТ И ЗДЕСЬ. До этой строки его держала только
    // одиночная дорога: у кусков был свой предел (50 МБ), а СЛОЖЕНИЯ не
    // делал никто — замерено, 250 МБ в одном файле при потолке 200 МБ.
    //
    // Диском это не грозило (законная одиночная дорога пропускает вдвое
    // больше байт в минуту, и запас диска держит оба пути) — вред был в том,
    // что обещание не исполнялось: и в шапке потолка, и в договоре фронта с
    // сервером. Поэтому починка ровно одна: сложить и отказать.
    //
    // Считаем РЕАЛЬНЫЕ байты на диске, а не то, что клиент объявил в
    // chunkCount: объявить можно что угодно.
    let totalBytes = 0;
    for (const part of parts) totalBytes += fs.statSync(path.join(tempDir, part)).size;
    if (totalBytes > MAX_CHAT_FILE_SIZE) {
      // Обрезки не оставляем: сеанс закончен отказом, собирать больше нечего.
      fs.rmSync(tempDir, { recursive: true, force: true });
      return res.status(413).json({
        error: `File too large (max ${formatMaxSize(MAX_CHAT_FILE_SIZE)})`,
        code:  'payload_too_large',
      });
    }

    const ws = fs.createWriteStream(destPath);
    for (const part of parts) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(path.join(tempDir, part));
        rs.pipe(ws, { end: false });
        rs.on('end', resolve);
        rs.on('error', reject);
      });
    }
    await new Promise((resolve, reject) => {
      ws.end();
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    fs.rmSync(tempDir, { recursive: true, force: true });

    res.json({ downloadUrl: `${BASE_URL}/files/${safeK}` });
  } catch (err) {
    console.error('[files/multipart/complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Multipart abort ───────────────────────────────────────────────────────────

app.post('/files/multipart/abort', (req, res) => {
  if (!requireChatFileAccess(req, res)) return;
  try {
    const { uploadId } = req.body || {};
    if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
    fs.rmSync(path.join(DIR_TEMP, safeKey(uploadId)), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bag endpoints — chat transport, blind to content ─────────────────────────
//
// A "bag" is an opaque, client-encrypted chat payload — the server never reads,
// parses or logs its bytes, at upload, at download, or in cleanup (Задача 4).
// Everything this block operates on is addresses, sizes and timestamps.
//
// Separate storage, separate route family, on purpose: DIR_FILES/DIR_PUBLIC
// above are mounted under express.static and openly listable-by-guessing —
// tolerable for ciphertext attachments nobody can open without a key, but not
// for bags, where the metadata itself (who talked to whom, and when) is the
// thing the product promises not to hand to a stranger. Nothing below is
// mounted under express.static — see test/bagRoutes.test.js's direct-request
// test for the check that actually proves it.
//
//   POST /bags/pass         → { pass, expiresAt } — x-ts/x-sig headers over
//                              bagPassChallenge(address, ts), address in the
//                              JSON body (see the long comment on the route
//                              itself for why address can't come from the
//                              headers alone).
//   PUT  /bags/:recipient   → { key } — sender comes from the pass, never
//                              from the body; body is the raw sealed bytes.
//   GET  /bags?since=<ms>   → [{ key, sender, size, uploadedAt }] for the
//                              address inside the pass.
//   GET  /bags/:recipient/:filename (== GET /bags/:key, key = "recipient/filename"
//                              — the key format from bagKeyFor() always has one
//                              slash in it, so it needs two URL segments)
//                            → raw bytes, only if the pass's address is the
//                              recipient. Wrong owner and unknown key answer
//                              identically (404, same body) — see rule 3 below.
//
// Rules, each locked by test/bagRoutes.test.js:
//   1. Recipient/sender are read from the pass or the URL, never the body.
//   2. Wrong-owner and unknown-key GETs are indistinguishable (404, same
//      body) — a 403 there would let someone enumerate another address's
//      bag count by the status code alone. An invalid/expired PASS is still
//      401 with its own code — that one has to be distinguishable, or the
//      client can't tell "re-sign" from "no such bag".
//   3. The rate limiter runs on all four routes, keyed by IP (as elsewhere)
//      AND by the caller's address (bagPassRateKey/bagReadRateKey/
//      bagWriteRateKey below — see the long comment there for why three
//      separate budgets, not one shared one) — behind the
//      Cloudflare Tunnel every IP collapses to one (app.js:1081-1101), so an
//      IP-only limiter is worthless here.

const BAG_PASS_HEADER = 'x-bag-pass';
const BAG_NOT_FOUND   = { error: 'Bag not found', code: 'bag_not_found' };

// И-4 (ревью): один общий бюджет "bag-addr:<addr>" на все четыре маршрута
// оказался и небезопасным (С1 — непроверенный адрес мог тратить чужой), и
// непригодным для живого разговора сам по себе: 10 действий в минуту на ВСЕ
// четыре маршрута вместе означало, что один опрос списка раз в десять секунд
// съедал шесть, и собственная отправка следом уже голодала собственное же
// чтение — без единого нападающего, просто от нормального использования
// (измерено координатором: пропуск + девять отправок → своё же чтение
// получает 429). Три отдельных бюджета — выпуск пропуска, чтение (список +
// скачивание одного мешка — оба "прочитать что-то"), запись — не делят
// один счётчик, так что интенсивная отправка не блокирует чтение и наоборот.
//
// Числа подобраны под живой разговор, не под один запрос в шесть секунд:
//   - выпуск пропуска — редкое событие (раз в BAG_PASS_TTL_SEC = 12ч, плюс
//     случайные переподписи), запас на повторные попытки не помешает;
//   - чтение — список опрашивается чаще всего (раз в 1-2с в активном чате)
//     плюс скачивание каждого нового мешка тем же бюджетом;
//   - запись — всплеск быстрой печати/отправки короткими сообщениями.
// Через окружение, с явными умолчаниями — то же правило, что уже применено
// к MAX_BAG_SIZE и срокам жизни в bagStore.js.
// Порт — целое в 1..65535. Пустое значение — законное «пользуйся
// умолчанием», всё остальное негодное отвергается ГРОМКО и при старте:
// см. комментарий у объявления PORT, почему тихий отказ здесь особенно
// дорог (сервер поднимается на UNIX-сокете и рапортует успех).
function readPort(envVar, defaultValue) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  // 0 — НЕ опечатка, а осмысленное «дай любой свободный порт» (так поднимают
  // сервер тесты, чтобы не драться за один и тот же номер). Оставляем
  // законным: запрещать его значило бы придумать себе требование и сломать
  // намеренный приём. Опасность 0 не в самом значении, а в том, что журнал
  // рапортовал бы «:0» вместо настоящего порта — это чинится в index.js,
  // который печатает адрес УЖЕ ПОДНЯВШЕГОСЯ сервера, а не то, что просили.
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(
      `${envVar}=${JSON.stringify(raw)} is not a valid TCP port (expected an integer 0..65535, where 0 means ` +
      `"any free port"). Node treats a NON-NUMERIC value as a UNIX socket PATH: it would start "successfully", ` +
      `log that it is running, and be unreachable over TCP.`
    );
  }
  return n;
}

function readPositiveInt(envVar, defaultValue) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  // Громкий отказ при старте, не тихий NaN — `entry.count >= NaN` всегда
  // false, то есть битое значение здесь означает не "потолок поменьше", а
  // "лимитера нет вообще". На старте, а не на первом запросе: ровно то же
  // рассуждение, что assertBagStoreReady()/assertBagPassReady() выше по
  // файлу уже применяют к своим собственным числам.
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${envVar}=${JSON.stringify(raw)} is not a positive finite number`);
  }
  return n;
}

const BAG_PASS_RATE_MAX  = readPositiveInt('BAG_PASS_RATE_MAX',  30);
const BAG_READ_RATE_MAX  = readPositiveInt('BAG_READ_RATE_MAX', 120);
const BAG_WRITE_RATE_MAX = readPositiveInt('BAG_WRITE_RATE_MAX', 60);

// Находка ревью (критическая, второй раунд): все четыре маршрута мешков
// начинались с checkRateLimit(ip) БЕЗ второго аргумента — то есть с
// глобальным RATE_MAX=10, тем же самым, что рассчитан на мета-транзакции
// /relay. Это делало три бюджета выше ЛИТЕРАЛЬНО бесполезными: какими бы
// щедрыми ни были BAG_PASS_RATE_MAX/BAG_READ_RATE_MAX/BAG_WRITE_RATE_MAX,
// IP-лимитер срабатывал первым и жёстче любого из них. Измерено на боевых
// умолчаниях, без единого тестового переопределения (см.
// test/bagRoutesLiveDefaults.test.js): минута живого разговора одного
// человека — выпуск пропуска, опрос списка раз в 1-2с, десяток отправок,
// десяток скачиваний, 52 запроса всего — давала 42 ответа 429 из
// 52 ДО этой правки. Собственный IP-бюджет мешков, отдельный от RATE_MAX,
// с потолком, вмещающим сумму трёх адресных бюджетов (30+120+60=210) с
// запасом на реальную нагрузку — после правки 0 из тех же 52.
//
// Оставлен ОДНИМ общим счётчиком на все четыре маршрута (не разбит по
// назначению, как адресные) — IP-лимитер это грубая сетевая защита "не
// заваливай нас отсюда", не "не мешай себе самому по видам деятельности";
// последнее уже решено адресными бюджетами выше.
const BAG_IP_RATE_MAX = readPositiveInt('BAG_IP_RATE_MAX', 300);

// К-1: отдельный, НАМЕРЕННО СКУПОЙ бюджет на обращения к цепи при проверке
// контрактной подписи. Он не про «сколько запросов вынесет релеер» (это
// BAG_IP_RATE_MAX выше), а про «сколько чужого узла мы готовы сжечь на
// проверку подписей, которые никто не обязан был подписывать честно».
//
// Почему по IP, а не по заявленному адресу: списывать бюджет заявленным
// (непроверенным) адресом — это ровно С1, критическая находка предыдущего
// раунда (см. длинный комментарий в /bags/pass ниже). Нападающий, ни разу
// не подписавшись как жертва, разряжал бы бюджет чужого адреса и держал
// владельца Safe отрезанным от собственного чата. По IP — больно тому, кто
// долбит, а не соседу.
//
// Двенадцать в минуту с одного выхода: пропуск живёт 12 часов, то есть
// ЧЕСТНОМУ владельцу контрактного кошелька нужно ДВА обращения к цепи в
// сутки, не двенадцать в минуту. Запас здесь для человека, который
// переподключает кошелёк, а не для нагрузки.
const BAG_PASS_CHAIN_RATE_MAX = readPositiveInt('BAG_PASS_CHAIN_RATE_MAX', 12);

// Находка ревью (Important): адресные ключи и сырая строка из clientIp()
// жили в одном и том же _rateMap. При TRUST_PROXY=true clientIp() берёт
// значение из заголовка, выставленного впереди стоящим прокси, и берёт его
// дословно — а значит пространство имён счётчиков нельзя считать защищённым
// от того, что в него попадёт строка, выбранная не нами. Сегодня из
// интернета за настоящим туннелем это недостижимо (прокси сам выставляет
// заголовок и вычищает клиентский), но полагаться на это значило бы
// защищаться верой в конфигурацию.
//
// Поэтому разделение сделано ПО ФОРМЕ КЛЮЧА: префикс `ip:` не может
// встретиться ни в одном из bagPassRateKey/bagReadRateKey/bagWriteRateKey
// (они начинаются на `bag-`), и наоборот. Коллизия исключена построением, а
// не проверкой содержимого заголовка.
//
// ⚠️ Разделены не все пользователи общей карты — остаток записан отдельным
// открытым пунктом (docs/OPEN-ITEMS.md, 28.1); подробности там намеренно не
// публикуются, и здесь их тоже быть не должно.
function bagIpRateKey(ip)         { return `ip:${ip}`;             }
function bagPassRateKey(address)  { return `bag-pass:${address}`;  }
function bagReadRateKey(address)  { return `bag-read:${address}`;  }
function bagWriteRateKey(address) { return `bag-write:${address}`; }
// Тот же приём защиты от подмены ключа заголовком, что у `ip:` выше: префикс
// `chain:` не может встретиться ни в одном адресном ключе (они на `bag-`).
function bagChainRateKey(ip)      { return `chain:${ip}`;          }

// Свойство 3 (ревью, второй раунд): раньше все восемь мест лимитера отвечали
// БУКВАЛЬНО одним и тем же телом — { error: 'Rate limit exceeded' }, без
// кода. Тест на границу IP-бюджета и тест на границу адресного бюджета
// одного и того же маршрута оба проверяли только res.status === 429 —
// значит если бы IP-проверку СЛУЧАЙНО перепутали местами с адресной (или
// адресный бюджет одного назначения — с бюджетом другого), тест бы этого
// не заметил: 429 остаётся 429 независимо от того, ЧЕЙ именно бюджет
// сработал. `code` называет источник явно — reason обязателен, не
// опционален, чтобы новое место лимитера нельзя было забыть его назвать.
function bagRateLimited(res, reason) {
  return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded', code: reason });
}

// Shared by PUT/GET/GET-list: verify the pass, answer 401 with its code on
// failure, otherwise return the address it names. Every caller below treats
// that address as the ONLY source of truth for "who is asking" — see rule 1.
function requireBagPass(req, res) {
  const verified = verifyBagPass(req.headers[BAG_PASS_HEADER]);
  if (verified.error) {
    res.status(401).json({ error: verified.error, code: verified.code });
    return null;
  }
  return verified.address;
}

// ─── К-1: подпись любого из ЧЕТЫРЁХ родов кошелька ────────────────────────
//
// Родов на Base четыре, а не два (замерено 6 августа 2026, три независимых
// замера; таблица — во внутреннем замысле сквозного чата, §4, не публикуется):
//
//   1. Обычный (EOA)                     — 65 байт, ecrecover
//   2. Делегированный EIP-7702           — 65 байт, ecrecover (код на цепи ЕСТЬ)
//   3. Развёрнутый контракт (Safe)       — переменная длина, ERC-1271
//   4. Счётный (Coinbase до первой tx)   — переменная длина, обёртка ERC-6492
//
// До этой правки здесь стоял ГОЛЫЙ `ethers.verifyMessage`, то есть только
// ecrecover. Роды 3 и 4 не получали пропуск НИКОГДА: сеанс заводился, ключ
// выводился, мешок шифровался — и не мог быть ни выложен, ни скачан. Дыра
// была не в чате, а в его обвязке.
//
// ⚠️ ПОРЯДОК ВАЖЕН И ОН НЕ КОСМЕТИЧЕСКИЙ. Сначала — местный ecrecover, БЕЗ
// СЕТИ ВООБЩЕ. Роды 1 и 2 (то есть почти все люди) не платят за эту правку
// ни миллисекунды задержки и, главное, не становятся заложниками узла цепи:
// упавший RPC не имеет права выключить чат обычному кошельку. Замер —
// test/bagPassContractWallet.test.js, «ноль обращений к цепи».
//
// В сеть уходим ТОЛЬКО когда местная проверка не сошлась. Это покрывает и
// неочевидный случай: Safe с одним владельцем умеет отдать ровно 65 байт,
// которые ecrecover развернёт в АДРЕС ВЛАДЕЛЬЦА, а не в адрес самого Safe.
// Поэтому «не 65 байт» — не условие похода в цепь; условие — «местно не
// сошлось», чем бы подпись ни выглядела.
const ERC6492_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';

// Канонический байткод `UniversalSigValidator` из ERC-6492. Не наш и не
// переписанный своими руками намеренно: это ровно та же строка, которую
// возит viem (`viem/_esm/constants/contracts.js`, версия 2.34.0, уже лежит в
// `frontend/node_modules`), и происхождение заперто тестом — сверкой байт в
// байт с файлом viem.
//
// Что он делает за один `eth_call` без единого развёрнутого контракта
// (deployless: `to` пуст, вызов исполняет КОНСТРУКТОР и возвращает 1 байт):
// снимает обёртку ERC-6492 и при необходимости разворачивает счётный
// кошелёк ВНУТРИ симуляции → пробует ERC-1271, если по адресу есть код →
// иначе ecrecover. То есть роды 3 и 4 закрыты одним обращением, а не двумя,
// и разбор обёртки делаем не мы (нам нечего перепутать).
const UNIVERSAL_SIG_VALIDATOR_BYTECODE = '0x608060405234801561001057600080fd5b5060405161069438038061069483398101604081905261002f9161051e565b600061003c848484610048565b9050806000526001601ff35b60007f64926492649264926492649264926492649264926492649264926492649264926100748361040c565b036101e7576000606080848060200190518101906100929190610577565b60405192955090935091506000906001600160a01b038516906100b69085906105dd565b6000604051808303816000865af19150503d80600081146100f3576040519150601f19603f3d011682016040523d82523d6000602084013e6100f8565b606091505b50509050876001600160a01b03163b60000361016057806101605760405162461bcd60e51b815260206004820152601e60248201527f5369676e617475726556616c696461746f723a206465706c6f796d656e74000060448201526064015b60405180910390fd5b604051630b135d3f60e11b808252906001600160a01b038a1690631626ba7e90610190908b9087906004016105f9565b602060405180830381865afa1580156101ad573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906101d19190610633565b6001600160e01b03191614945050505050610405565b6001600160a01b0384163b1561027a57604051630b135d3f60e11b808252906001600160a01b03861690631626ba7e9061022790879087906004016105f9565b602060405180830381865afa158015610244573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906102689190610633565b6001600160e01b031916149050610405565b81516041146102df5760405162461bcd60e51b815260206004820152603a602482015260008051602061067483398151915260448201527f3a20696e76616c6964207369676e6174757265206c656e6774680000000000006064820152608401610157565b6102e7610425565b5060208201516040808401518451859392600091859190811061030c5761030c61065d565b016020015160f81c9050601b811480159061032b57508060ff16601c14155b1561038c5760405162461bcd60e51b815260206004820152603b602482015260008051602061067483398151915260448201527f3a20696e76616c6964207369676e617475726520762076616c756500000000006064820152608401610157565b60408051600081526020810180835289905260ff83169181019190915260608101849052608081018390526001600160a01b0389169060019060a0016020604051602081039080840390855afa1580156103ea573d6000803e3d6000fd5b505050602060405103516001600160a01b0316149450505050505b9392505050565b600060208251101561041d57600080fd5b508051015190565b60405180606001604052806003906020820280368337509192915050565b6001600160a01b038116811461045857600080fd5b50565b634e487b7160e01b600052604160045260246000fd5b60005b8381101561048c578181015183820152602001610474565b50506000910152565b600082601f8301126104a657600080fd5b81516001600160401b038111156104bf576104bf61045b565b604051601f8201601f19908116603f011681016001600160401b03811182821017156104ed576104ed61045b565b60405281815283820160200185101561050557600080fd5b610516826020830160208701610471565b949350505050565b60008060006060848603121561053357600080fd5b835161053e81610443565b6020850151604086015191945092506001600160401b0381111561056157600080fd5b61056d86828701610495565b9150509250925092565b60008060006060848603121561058c57600080fd5b835161059781610443565b60208501519093506001600160401b038111156105b357600080fd5b6105bf86828701610495565b604086015190935090506001600160401b0381111561056157600080fd5b600082516105ef818460208701610471565b9190910192915050565b828152604060208201526000825180604084015261061e816060850160208701610471565b601f01601f1916919091016060019392505050565b60006020828403121561064557600080fd5b81516001600160e01b03198116811461040557600080fd5b634e487b7160e01b600052603260045260246000fdfe5369676e617475726556616c696461746f72237265636f7665725369676e6572';

// Терпение на ОДНУ проверку контрактной подписи. Отдельно от RPC_TIMEOUT_MS
// (20 с) намеренно: двадцать секунд — потолок для фоновой работы вроде
// опроса квитанции, а здесь человек стоит перед окном кошелька и ждёт
// ответа. Лучше честное «узел недоступен, попробуйте ещё раз» через пять
// секунд, чем двадцать секунд тишины, которые он прочтёт как «сломалось».
const CONTRACT_SIG_TIMEOUT_MS = readPositiveInt('CONTRACT_SIG_TIMEOUT_MS', 5_000);

/**
 * Проверяет подпись `sig` над `message` от имени `address` — любым из
 * четырёх родов кошелька.
 *
 * Возвращает:
 *   { ok: true,  local: true|false }  — подпись принята (local: сети не было)
 *   { ok: false, reason: 'mismatch' } — подпись не признана ни ecrecover, ни контрактом
 *   { ok: false, reason: 'address_mismatch' } — то же, но ecrecover развернул
 *       её в ЧУЖОЙ адрес: подпись настоящая, прислали не за того. Отдельная
 *       причина, потому что человеку тут говорят другое («вы прислали чужой
 *       адрес», а не «подпишите заново»). Ставится только когда контрактная
 *       дорога тоже не признала — Safe с одним владельцем отдаёт ровно 65
 *       байт, разворачивающихся в адрес ВЛАДЕЛЬЦА, и это законная подпись.
 *   { ok: false, reason: 'chain_unavailable' } — цепь не ответила; ВЕРДИКТА НЕТ
 *
 * Третий исход обязан отличаться от второго: «переподпишись» и «попробуй
 * позже» — разные советы человеку, и путать их значит гонять владельца Safe
 * по кругу подписаний, пока лежит чужой узел.
 *
 * `onChainAttempt` — вызывается ПЕРЕД обращением к цепи и может его
 * запретить (вернув false): так бюджет обращений тратится ровно тогда,
 * когда обращение действительно случается, а не на каждый вызов функции.
 */
export async function verifyWalletSignature(address, message, sig, onChainAttempt) {
  const addr = String(address).toLowerCase();

  // 1. Местная дорога. Роды 1 и 2 заканчиваются здесь, не касаясь сети.
  let recoveredOther = false;
  try {
    if (ethers.verifyMessage(message, sig).toLowerCase() === addr) {
      return { ok: true, local: true };
    }
    // Развернулась, но в другой адрес. Само по себе ещё не отказ (см.
    // оговорку про Safe с одним владельцем в докстринге), но если и цепь
    // не признает — причина назовётся именно так.
    recoveredOther = true;
  } catch { /* не 65 байт / мусор — это ещё не отказ, дальше цепь */ }

  const noVerdict = () => ({ ok: false, reason: recoveredOther ? 'address_mismatch' : 'mismatch' });

  // Пустая подпись — единственный мусор, который проходит кодировщик
  // аргументов ниже (`0x` это законные нулевые байты) и потому доехал бы до
  // цепи. Ни один кошелёк ни одного из четырёх родов пустой подписи не
  // выдаёт, а обращение к чужому узлу за таким ответом мы платим зря —
  // отсекаем здесь, местно. Замерено: без этой строки `x-sig: 0x` тратил
  // обращение к цепи на каждый запрос.
  if (/^0x$/i.test(String(sig).trim())) return noVerdict();

  // 2. Дорога через цепь. Платная — сначала спрашиваем разрешение.
  if (onChainAttempt && !onChainAttempt()) return { ok: false, reason: 'rate_limited' };

  let data;
  try {
    data = ethers.concat([
      UNIVERSAL_SIG_VALIDATOR_BYTECODE,
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'bytes32', 'bytes'],
        [addr, ethers.hashMessage(message), sig],
      ),
    ]);
  } catch {
    // Подпись — не шестнадцатеричная строка вовсе. Это негодный ввод, а не
    // недоступная цепь: узел тут ни при чём, и звать его незачем.
    return noVerdict();
  }

  let result;
  try {
    // Гонка с собственным терпением: `provider.call` унаследует таймаут
    // соединения (20 с), а зависший узел не должен держать человека столько.
    result = await Promise.race([
      provider.call({ data }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('contract signature check timed out')), CONTRACT_SIG_TIMEOUT_MS).unref?.(),
      ),
    ]);
  } catch (e) {
    // Валидатор РЕВЕРТИТ на негодной подписи (например, обёртка ERC-6492
    // указывает на фабрику, которая не развернула кошелёк) — и это
    // неотличимо по типу ошибки от «узел не ответил». Разделять их нечем,
    // и мы выбираем осторожную сторону: сказать «цепь недоступна» и НЕ
    // выдать пропуск. Ошибиться в эту сторону — лишний повтор; ошибиться в
    // другую — выдать пропуск по подписи, которой не было.
    console.error('[bags] contract signature check failed:', e.message);
    return { ok: false, reason: 'chain_unavailable' };
  }

  // Конструктор возвращает ровно один байт: 0x01 — признана, 0x00 — нет.
  return /^0x0*1$/.test(String(result)) ? { ok: true, local: false } : noVerdict();
}

export { UNIVERSAL_SIG_VALIDATOR_BYTECODE };

// ─── ⚠️ ЧИТАТЬ ПРЕЖДЕ, ЧЕМ УБИРАТЬ ОТСЮДА ПОДПИСЬ КОШЕЛЬКА ─────────────────
//
// Записано 8 августа 2026 по прямому указанию координатора: «без этого
// кто-нибудь однажды снова пойдёт этой дорогой и потратит день, чтобы прийти к
// тому же».
//
// Живая выкатка чата дала главную находку, и она не про код: человек открыл
// переписку и УШЁЛ. Дословно: «я как юзер уже вышел и закрыл приложение потому
// что сразу не подключился», «оба просят вечное подключение/подпись».
//
// Подписей на первом заходе ДВЕ:
//   1. подпись типизированных данных — из неё ВЫВОДИТСЯ ключ переписки;
//   2. подпись вызова этого маршрута — доказывает серверу, что адрес твой.
//
// Напрашивается свести к одной. НЕЛЬЗЯ. Двух доказательств, и оба замерены:
//
// (а) ПЕРВУЮ подпись серверу показать нельзя, потому что она И ЕСТЬ КЛЮЧ.
//     `chatCrypto.deriveChatKeypair` выводит пару ключей ИЗ БАЙТ подписи. Отдав
//     её сюда как доказательство владения адресом, мы отдали бы серверу
//     возможность вывести тот же ключ и прочитать всю переписку — то есть
//     обменяли бы сквозное шифрование на одно окно кошелька. Это тождество, а
//     не осторожность: подпись здесь одновременно секрет и предъявляемое, а так
//     не бывает.
//
// (б) ВЫДАТЬ пропуск без доказательства владения адресом тоже нельзя, потому
//     что `POST /keys` берёт адрес ИЗ ПРОПУСКА (правило 1 Задачи 2). Пропуск,
//     выданный кому попало, означал бы: любой человек занимает ЛЮБУЮ строку
//     справочника (адреса в цепи публичны), кладёт туда свой открытый ключ
//     шифрования — и читает всё, что этому адресу напишут. Не «ослабление на
//     грани», а полная подмена личности в справочнике.
//
// Отсюда: ДВЕ подписи на первом заходе в жизни адреса — это ПОЛ, а не
// недоделка. Они идут подряд, в момент, когда человек сам пришёл в чат.
//
// ─── ТРЕТЬЯ ДОРОГА БЫЛА ПОСТРОЕНА И ОТКАЧЕНА ──────────────────────────────
//
// 8 августа здесь появлялась вторая дорога: подпись вызова САМИМ КЛЮЧОМ
// ПЕРЕПИСКИ (Ed25519, заголовок `x-key-sig`), проверяемая открытой половиной,
// которую адрес уже объявил в справочнике. Она работала и была замерена:
//
//   окон кошелька на каждый следующий заход      2 → 0
//   окон кошелька на новом устройстве (EOA)      2 → 1
//   чужим ключом за этот адрес                   401
//   ключа в справочнике нет                      401 key_not_enrolled
//   чужой мешок                                  404, как и раньше
//
// **Откачено решением владельца, а не потому, что довод был неверен.** Довод
// верен: `BAG_PASS_TTL_SEC` ниже прямо записывает, что пропуск от фишинга не
// защищает вовсе — сайт, выманивший подпись ключа, в том же визите выманит и
// эту. Двенадцать часов были отсрочкой, а не защитой, и платили за неё все.
//
// Причина отката — то, что это РАЗВИЛКА АРХИТЕКТУРЫ, а не мелочь, и решать её
// в этой задаче владелец не готов. Дословно: «хочется и ux хороший, и не
// хочется дыры, тем более подобной, где раз прорвался и всё читаешь».
//
// Что менялось при той дороге, честно: раньше выманенный ключ переписки давал
// чтение уже скачанного, а забрать НОВОЕ со склада требовало второй подписи, и
// выманенный пропуск умирал через 12 часов. С ней ключ переписки означал бы и
// доступ к складу — постоянный, пока ключ не сменён.
//
// ⚠️ ЕСЛИ ЭТА ДОРОГА КОГДА-НИБУДЬ ВЕРНЁТСЯ, ВМЕСТЕ С НЕЙ ОБЯЗАН ВЕРНУТЬСЯ СОРТ
// ПРОПУСКА И ЗАПРЕТ МЕНЯТЬ КЛЮЧ В СПРАВОЧНИКЕ ПРОПУСКОМ, ДОБЫТЫМ КЛЮЧОМ.
// Иначе выходит замкнутый круг: украденный на 12 часов пропуск позволяет
// записать в справочник свой `signKey` и выдавать себе пропуска ВЕЧНО — кошелёк
// жертвы больше не нужен никогда. Это было найдено и закрыто (`wallet_pass_required`
// на `POST /keys`) и снято вместе с самой дорогой, потому что сорт с одним
// возможным значением ничего не различает и только выглядит защитой.
//
// Настоящий корень задачи не здесь и этой дорогой не лечится: кошельки не
// сверяют имя домена с адресом сайта, поэтому выведенный ключ переписки —
// предъявительский. Кто его добыл, тот и хозяин: подпись, выманенную
// поддельным сайтом, от подписи, данной на нашем, не отличает никто — ни
// кошелёк, ни сервер, ни вторая сторона переписки. Разобрано во внутреннем
// замысле сквозного чата, §4 (не публикуется).
//
// ⚠️ ВЫБОР, ЧЕМ ЭТО ЛЕЧИТЬ, НЕ СДЕЛАН — и это записано честно, а не забыто
// (см. `docs/OPEN-ITEMS.md` и `docs/DECENTRALIZATION.md`: проект держит
// открытую позицию про незакрытое). Развилка разбиралась отдельно и осталась
// открытой; здесь она не решается и решаться не должна — маршрут выдачи
// пропуска не то место, где выбирают, чем человек доказывает, что адрес его.
// Пока выбор не сделан, дорога ровно одна: пропуск выдаётся ТОЛЬКО под
// подпись кошелька.
//
// Замки, сторожащие, что дороги по-прежнему одна: `test/bagPassWalletOnly.test.js`
// и `frontend/src/lib/chatPassWallet.test.ts`.
//
// POST /bags/pass — mints a bag pass from a wallet signature.
//
// Unlike GET /dispute-log/:dealId (app.js:1237-1258, the pattern this route
// is otherwise copied from), there is no resource id in this URL that the
// server already knows and can fold into the challenge — dispute-log signs
// over `dealId`, which comes from the path. bagPassChallenge(address, ts)
// signs over the CALLER's OWN address instead, and building that exact
// message server-side (required before ethers.verifyMessage can recover
// anyone) needs the address as an input, not just an output. So the caller
// states a claimed address in the JSON body, and the route checks
// self-consistency — recovered signer === claimed address — exactly the
// pattern /push/subscribe and /push/unsubscribe already use below for the
// same shape of problem (no URL-supplied resource, signer proves an address
// that's also plain input).
//
// Deliberately NOT copied from /push/subscribe/unsubscribe: the shape of the
// signed phrase over there is weaker, and that is filed as an open item
// (docs/OPEN-ITEMS.md #27 — details are kept out of the public register until
// it is fixed; do not restate them here either). This route keeps
// bagPassChallenge's ±5 minute window, the same discipline
// GET /dispute-log/:dealId already applies to its own signature path, and
// checks it via Number.isFinite rather than a bare magnitude comparison —
// see the note at the check itself for why the finite test carries its weight.
//
// Ordering is cost-ordered, cheapest first: address shape → header presence →
// timestamp window → rate limit by the CLAIMED address → only then the actual
// ecdsa recovery. The address-rate-limit step exists here specifically
// because — unlike the three consuming routes below, which only learn the
// caller's address by already having verified a pass — this route is handed
// an address up front, so a flood of garbage signatures against one address
// hits the limiter before paying for a single recovery.
app.post('/bags/pass', async (req, res) => {
  const ip = clientIp(req);
  // Not the app-wide checkRateLimit(ip) (RATE_MAX=10, sized for /relay's
  // meta-transactions) — see the long comment at BAG_IP_RATE_MAX above for
  // why the bag routes need their own IP budget, and the measured numbers
  // that proved the old shared one made every per-purpose budget below moot.
  if (!checkRateLimit(bagIpRateKey(ip), BAG_IP_RATE_MAX)) return bagRateLimited(res, 'rate_limited_ip');

  const { address } = req.body || {};
  if (typeof address !== 'string' || !ETH_ADDR_RE.test(address)) {
    return res.status(400).json({ error: 'Invalid address', code: 'invalid_address' });
  }
  const addr = address.toLowerCase();

  const ts  = req.headers['x-ts'];
  const sig = req.headers['x-sig'];
  if (!ts || !sig) {
    // Distinct code from ts_out_of_window (ревью, "слепота статуса"):
    // without it, removing this presence check entirely still answers 401 —
    // just via the window check a few lines down, since Number(undefined)
    // is NaN and !Number.isFinite(NaN) is true. Same status, different
    // cause; the code is what actually distinguishes them.
    return res.status(401).json({ error: 'Missing x-ts or x-sig header', code: 'missing_credentials' });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const tsNum  = Number(ts);
  // Number.isFinite first, not just `Math.abs(nowSec - tsNum) > 300`: a bare
  // magnitude comparison is not a total check over every input a client can
  // send, and the gap is silent rather than loud. Same class as the one filed
  // in docs/OPEN-ITEMS.md #27 (subpoint 3) — kept as a pointer only, the
  // mechanism stays out of the register until that item is closed.
  // (bagPassChallenge() below happens to also reject NaN via its own
  // Number.isSafeInteger guard — Задача 1's contract, not this route's — so
  // removing this line doesn't reopen an exploit today; it does start
  // reporting a garbage timestamp as "invalid signature" instead of what it
  // actually is, and removes the one guard here that doesn't depend on a
  // frozen module elsewhere still being strict tomorrow.)
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > 300) {
    return res.status(401).json({ error: 'Timestamp out of window', code: 'ts_out_of_window' });
  }

  // С1 (ревью, критическая — координаторская, не моя изначальная идея):
  // раньше здесь стоял `checkRateLimit(bagAddrRateKey(addr))` — бюджет
  // адреса тратился ЗАЯВЛЕННЫМ (непроверенным) адресом из тела, ДО
  // восстановления подписи. Это тот же бюджет, что PUT/GET/GET-список
  // списывают под настоящий, проверенный адрес — так что нападающий, ни
  // разу не подписавшись как жертва, мог 9-10 мусорными попытками в минуту
  // разрядить бюджет чужого адреса и держать человека отрезанным от
  // собственного чата постоянно, повторяя раз в минуту. Кошелёк жертвы не
  // нужен вообще — адреса публичны в цепи.
  //
  // Защита от нагрузки ДО восстановления подписи — только IP-лимитер выше
  // (`checkRateLimit(ip)`), больше ничего с адресом не связанного здесь не
  // трогается. Координатор явно допускал два варианта («только по IP, либо
  // по отдельному пространству имён, никак не связанному с бюджетом
  // адреса») — выбран первый, более простой: заводить третье пространство
  // имён ради ограничения объёма чистого ecdsa-восстановления (микросекунды
  // на попытку) не стоит сложности, которую оно добавляет.
  let message;
  try {
    message = bagPassChallenge(addr, tsNum);
  } catch {
    return res.status(401).json({ error: 'Invalid signature', code: 'invalid_signature' });
  }

  // К-1: не голый ecrecover, а все четыре рода кошелька (см. длинный
  // комментарий у verifyWalletSignature выше). Обычный кошелёк проходит
  // МЕСТНО и `onChainAttempt` даже не зовётся — значит ни бюджет обращений
  // к цепи, ни доступность узла его не касаются.
  //
  // Бюджет обращений к цепи ключуется IP, а не заявленным адресом — иначе
  // это была бы буквально С1 (см. ниже) в новой одежде: нападающий разряжал
  // бы чужой бюджет, ни разу не подписавшись как жертва.
  const verdict = await verifyWalletSignature(addr, message, sig, () =>
    checkRateLimit(bagChainRateKey(ip), BAG_PASS_CHAIN_RATE_MAX),
  );

  if (!verdict.ok) {
    if (verdict.reason === 'rate_limited') return bagRateLimited(res, 'rate_limited_chain');
    if (verdict.reason === 'chain_unavailable') {
      // 503, НЕ 401. Переподписывать нечего: подпись, возможно, безупречна,
      // а вердикта нет потому, что молчит узел цепи. 401 отправил бы
      // владельца Safe по кругу окон кошелька, каждое из которых
      // бессмысленно.
      return res.status(503).set('Retry-After', '5')
        .json({ error: 'Signature could not be verified on-chain right now', code: 'chain_unavailable' });
    }
    // Различие сохранено с прежней версии: «подпись разобралась, но она
    // чужая» и «подпись не разобралась» — разные советы человеку.
    if (verdict.reason === 'address_mismatch') {
      return res.status(401).json({ error: 'Signature does not match claimed address', code: 'address_mismatch' });
    }
    return res.status(401).json({ error: 'Invalid signature', code: 'invalid_signature' });
  }

  // Бюджет адреса тратится только ЗДЕСЬ — после того, как подпись реально
  // признана владельцем `addr` (местно или контрактом). Списывается бюджет
  // ТОЛЬКО доказанного адреса, никогда заявленного (С1).
  if (!checkRateLimit(bagPassRateKey(addr), BAG_PASS_RATE_MAX)) return bagRateLimited(res, 'rate_limited_pass');

  const { token, expiresAt } = issueBagPass(addr, nowSec);
  res.json({ pass: token, expiresAt });
});

// PUT /bags/:recipient — body is the raw sealed bag. Sender comes from the
// pass; the body is never parsed (bytes only, no matter what they look like).
app.put('/bags/:recipient', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(bagIpRateKey(ip), BAG_IP_RATE_MAX)) return bagRateLimited(res, 'rate_limited_ip');

  const sender = requireBagPass(req, res);
  if (!sender) return;

  if (!checkRateLimit(bagWriteRateKey(sender), BAG_WRITE_RATE_MAX)) return bagRateLimited(res, 'rate_limited_write');

  // И-1 (ревью): app.use(express.json({limit:'64kb'})) is mounted globally,
  // ahead of every route (app.js, near the top of the file) — for any
  // request whose Content-Type it recognises (exactly 'application/json',
  // by default; verified against the `type-is` matcher express.json() uses
  // internally — a `+json` suffix type like 'application/vnd.api+json' does
  // NOT match), it fully drains and parses the body BEFORE this handler
  // ever runs. By the time streamWithSizeLimit below tries to read the
  // request stream, there is nothing left on it — it writes zero bytes,
  // recordBag() happily records size:0, and the caller gets a normal
  // `200 {key}` for a bag that was never actually stored. The sender
  // believes it was delivered; the recipient downloads emptiness. Reject
  // explicitly instead of silently "succeeding" with nothing on disk.
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType === 'application/json') {
    return res.status(400).json({ error: 'Bag upload must not use Content-Type: application/json (body already consumed upstream)', code: 'bag_content_type' });
  }

  const recipient = String(req.params.recipient || '').toLowerCase();
  // Отдельный код от `bag_content_type` и `empty_bag` (Задача 6): все три
  // отвечают 400, и статус про причину не говорит ничего. Съеденное
  // json-парсером тело приезжает сюда пустым — то есть ветка «пустой мешок»
  // ниже перехватывает ТОТ ЖЕ случай своим 400, и без разных кодов клиент
  // не отличил бы «вы прислали не тот content-type» от «вы прислали ноль байт».
  if (!ETH_ADDR_RE.test(recipient)) return res.status(400).json({ error: 'Invalid recipient', code: 'invalid_recipient' });

  // Neither assertBagStoreReady() nor bagPathFor() creates the recipient's
  // own subdirectory — only the storage root (DIR_BAGS) exists at boot. This
  // route is the one place a bag actually lands on disk, so it has to make
  // the directory itself, or the very first write to a new recipient fails.
  let key, filePath;
  try {
    key = bagKeyFor(recipient);
    filePath = bagPathFor(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (e) {
    console.error('[bags] PUT setup failed:', e.message);
    return res.status(500).json({ error: 'Failed to prepare bag storage', code: 'internal_error' });
  }

  streamWithSizeLimit(req, res, filePath, MAX_BAG_SIZE, () => {
    // Measure what actually landed on disk — not the client-claimed size,
    // not a running byte count off the wire (see the comment on
    // MAX_BAG_SIZE in bagStore.js: recordBag()'s own ceiling check only ever
    // sees whatever number it's handed here). uploadedAt is `Date.now()`,
    // never anything the client sent — bagStore.js's assertNotFromFuture()
    // exists precisely so a spoofed uploadedAt can't be used to outlive the
    // TTL rules, and that protection is worthless if this route just
    // forwards a client-supplied value instead of stamping its own.
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch (e) {
      console.error('[bags] PUT stat-after-write failed:', e.message);
      unlinkQuietSync(filePath);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to read uploaded bag', code: 'internal_error' });
      return;
    }
    // Мелочь (ревью): пустое тело раньше принималось и хранилось до
    // истечения TTL. Настоящий запечатанный мешок от chatCrypto — это как
    // минимум IV + тег аутентификации AES-256-GCM, никогда не ноль байт;
    // ноль здесь — не легитимный пустой мешок, а шум (оборванная загрузка
    // до единого байта, пустой Buffer от неисправного клиента и т.п.).
    if (size === 0) {
      unlinkQuietSync(filePath);
      if (!res.headersSent) res.status(400).json({ error: 'Empty bag', code: 'empty_bag' });
      return;
    }
    try {
      const stored = recordBag({ sender, recipient, key, size, uploadedAt: Date.now() });
      res.status(200).json({ key: stored.key });
    } catch (e) {
      // recordBag() throws (bagStore.js's documented contract, not an
      // accident) — Express 4 doesn't turn a throw from inside this
      // callback into a response on its own, so this has to be caught here
      // or a disk failure kills the process instead of just failing the
      // request.
      console.error('[bags] recordBag failed:', e.message);
      unlinkQuietSync(filePath);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to record bag', code: 'internal_error' });
    }
  });
});

// ─── sent / peers (Задача 1, chat-client) ──────────────────────────────────
//
// Внутренний замысел клиента чата (не публикуется), §3.3/3.4:
// отправитель до сих пор не мог узнать судьбу собственных мешков ("забрали
// ли"), и заодно решено бесплатно отдать "когда собеседник последний раз
// тронул что-то моё" — обе вещи из ТЕХ ЖЕ данных, что GET /bags и так уже
// читает каждый опрос (раз в 5с), без единого лишнего обращения к складу.
//
// Координатор, при сверке плана — четыре правила, каждое заперто тестом
// (relayer/test/bagSenderView.test.js):
//   - sent — только мешки ВЛАДЕЛЬЦА ПРОПУСКА (listBagsBySender(address), не
//     чужой список).
//   - fetched — булево (firstFetchedAt != null), НЕ временная метка: точное
//     время забора — метаданные собеседника, отправителю знать незачем.
//   - peers — только адреса, с которыми есть переписка хоть в одну сторону.
//   - lastActivityWithMeAt — округлён ВНИЗ до минуты (roundDownToMinute) —
//     секундная точность рисует слишком подробную картину чужого дня.
// Ни одно поле не читает содержимое мешка — только то, что уже даёт
// listBagsFor()/listBagsBySender() (адреса, размеры, время).
//
// ⚠️ Переименовано 6 августа (ревью Задачи 1, координатор — уточнено у
// владельца): поле называлось `lastSeenAt` и спека §3.4 обещала «когда
// адрес последний раз ОБРАЩАЛСЯ К СЕРВЕРУ» — а реализовано было и остаётся
// «когда собеседник последний раз ТРОНУЛ ЧТО-ТО МОЁ» (см. buildPeerView()
// ниже — единственные два источника: он забрал мой мешок, или он прислал
// свой). Это НЕ то же самое, что «был в сети», и разница не мелочь: человек
// час сидит в открытом чате, ничего из МОЕГО не трогал — поле честно
// покажет «час назад», а не «прямо сейчас». Решение владельца: поведение
// ЛУЧШЕ обещанного (не рассказывает про весь чужой день, только про то, что
// касается вас двоих) и остаётся как есть; враньём было ИМЯ и обещание в
// спеке, не код — оба поправлены, код — нет.

const MINUTE_MS = 60 * 1000;

/**
 * "Тронул не позже этого момента" — округление ВНИЗ, не к ближайшей минуте:
 * округление вверх нарисовало бы активность раньше, чем она случилась.
 */
function roundDownToMinute(ms) {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * peers из уже полученных `received`/`sent` (никакого отдельного чтения
 * склада) — те же два сигнала, что уже дают галочку fetched:
 *   - собеседник САМ прислал мешок → uploadedAt этого мешка — прямое
 *     доказательство, что он в этот момент что-то делал СО МНОЙ;
 *   - собеседник забрал мешок, присланный ему, → firstFetchedAt — тоже
 *     прямое доказательство того же самого.
 * Без доказательства ни в одну сторону peer всё равно попадает в список
 * (переписка есть — хоть один мешок в любую сторону, только его прочитать
 * ещё не забрали и он ничего не присылал сам) с lastActivityWithMeAt: null
 * — честное "неизвестно", не выдуманная метка.
 *
 * ETH_ADDR_RE-проверка на `b.sender` из `received` — единственная защита от
 * режима недоверия bagStore.js (test/bagStore.test.js, describe про
 * listBagsBySender): реконструированная с диска запись несёт
 * meta.sender === '' (имя файла не хранит отправителя). listBagsBySender()
 * уже сама никогда не отдаёт такие записи ни для одного настоящего адреса
 * (assertAddress требует валидную форму), так что `sent` в этой защите не
 * нуждается — только `received`, где sender берётся из ЧУЖОЙ записи и мог
 * бы быть этим самым ''.
 */
function buildPeerView(received, sent) {
  const lastActivity = new Map(); // адрес -> последняя ЧЕСТНАЯ метка (до округления)
  const noteEvidence = (addr, ts) => {
    const prev = lastActivity.get(addr);
    if (prev === undefined || ts > prev) lastActivity.set(addr, ts);
  };

  const peers = new Set();
  for (const b of received) {
    if (!ETH_ADDR_RE.test(b.sender)) continue; // '' в режиме недоверия — не адрес, не собеседник
    peers.add(b.sender);
    noteEvidence(b.sender, b.uploadedAt);
  }
  for (const b of sent) {
    peers.add(b.recipient); // recipient всегда настоящий адрес — форма проверена recordBag()/PUT
    if (b.firstFetchedAt != null) noteEvidence(b.recipient, b.firstFetchedAt);
  }

  return [...peers].map((address) => {
    const ts = lastActivity.get(address);
    return { address, lastActivityWithMeAt: ts === undefined ? null : roundDownToMinute(ts) };
  });
}

// GET /bags?since=<ms> — {inbox, sent, peers} для адреса из пропуска.
// Раньше отдавал голый массив (только inbox) — форма сменилась объектом
// решением координатора при сверке плана (внутренний план «Клиент чата»,
// §"Сверка плана", не публикуется): добавить sent/peers в ТОТ ЖЕ ответ
// вместо отдельного запроса, раз опрос и так идёт каждые 5с.
//
// `since` применяется к inbox И к sent (правка ревью, находка координатора
// — см. sentList ниже: до правки sent ехал целиком на каждом тике; замерено
// честно, JSON.stringify реальной формы записи — ~207 байт на элемент, то
// есть ~12,16МБ на пустом тике у адреса с 60 000 СОБСТВЕННЫХ отправленных
// — не 60 000 мешков в СКЛАДЕ вообще, это разные числа, см. отчёт задачи).
// `peers` — единственное поле, которое остаётся НЕфильтрованным всегда:
// список собеседников и их lastActivityWithMeAt обязаны отражать всю
// историю, а не только окно
// текущего опроса (иначе на любом "тихом" тике, где since отфильтровал бы
// все недавние события, peers схлопнулся бы в пустой список — заперто
// test/bagSenderView.test.js).
app.get('/bags', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(bagIpRateKey(ip), BAG_IP_RATE_MAX)) return bagRateLimited(res, 'rate_limited_ip');

  const address = requireBagPass(req, res);
  if (!address) return;

  // Read budget — shared with GET /bags/:key (download) below: both are
  // "read something", and a client that lists then downloads several new
  // bags in one poll cycle is one coherent burst of reading, not two
  // independent activities that should each get their own ceiling.
  if (!checkRateLimit(bagReadRateKey(address), BAG_READ_RATE_MAX)) return bagRateLimited(res, 'rate_limited_read');

  let since = null;
  if (req.query.since !== undefined) {
    since = Number(req.query.since);
    if (!Number.isFinite(since)) return res.status(400).json({ error: 'Invalid since', code: 'invalid_since' });
  }

  let received, sentRaw;
  try {
    // В-4 (аудит устойчивости, 6 августа): ОДИН обход описи на тик вместо
    // двух. Раньше здесь стояли listBagsFor() и listBagsBySender() подряд —
    // два полных прохода по одному и тому же _bagMeta, чтобы разложить его
    // по двум полям одной и той же записи. Замер (один и тот же прогон,
    // 200 000 мешков): 347,53 мс на тик (2,9 тика в секунду) → 190,16 мс
    // (5,3 тика в секунду).
    ({ received, sent: sentRaw } = listBagsInvolving(address));
  } catch (e) {
    console.error('[bags] GET /bags failed:', e.message);
    return res.status(500).json({ error: 'Failed to list bags', code: 'internal_error' });
  }

  // `peers` считается на ИСХОДНЫХ списках, до объединения ниже: иначе в
  // собеседниках у человека появился бы он сам.
  const peers = buildPeerView(received, sentRaw);

  // К-1: читаемое владельцем пропуска — это обе половины переписки, а не
  // только адресованная ему. Своя половина иначе недостижима: ключи мешков
  // человек видит в `sent`, но скачать их не мог, и после перезагрузки
  // вкладки от собственных сообщений не оставалось ничего.
  //
  // Дедупликация по ключу обязательна: переписка с самим собой — тот
  // единственный случай, где один и тот же мешок стоит в обоих списках, и
  // без неё он приехал бы дважды, дав `duplicate_seq` на разборе цепочки.
  const readable = [];
  const seenKeys = new Set();
  for (const b of received) { seenKeys.add(b.key); readable.push(b); }
  for (const b of sentRaw) { if (!seenKeys.has(b.key)) readable.push(b); }
  readable.sort((a, b) => a.uploadedAt - b.uploadedAt);

  // И-3 (ревью): nonstrict `>=`, not `>`. Two bags landing in the same
  // millisecond is a real race, not a theoretical one (measured live by the
  // coordinator) — a client that remembers the newest uploadedAt it has seen
  // and polls with ?since=<that value> would, with a strict `>`, exclude a
  // sibling bag stamped with the EXACT same millisecond forever: that bag's
  // uploadedAt never becomes greater than the since it will keep sending
  // from now on. `>=` re-sends the already-seen bag alongside it — a client
  // dedupes by key, so a repeat is a no-op, not a data-loss risk the way
  // silently dropping a message forever is.
  const inboxList = since !== null ? readable.filter((b) => b.uploadedAt >= since) : readable;

  // Находка ревью (координатор): `since` фильтровал только inbox — sent
  // ехал ЦЕЛИКОМ на каждом тике, даже когда в нём ничего не изменилось.
  // Замерено честно (JSON.stringify реальной формы записи): ~207 байт на
  // элемент — ~243КБ у адреса с 1 200 собственными отправленными, ~12,16МБ
  // у адреса с 60 000 (не 60 000 мешков в складе вообще — именно у СЕБЯ
  // отправленных; первая версия этого числа в отчёте задачи спутала эти
  // два счётчика и занизила итог примерно в 50 раз). Каждые пять секунд,
  // каждому. Фильтр — по ЛЮБОМУ из двух событий, не только по
  // uploadedAt (зеркалом inbox): мешок, отправленный ДО cutoff, но
  // забранный ПОСЛЕ него, обязан остаться в ответе — иначе отправитель
  // никогда не узнал бы о собственной галочке, появившейся уже после того,
  // как мешок стал "старым" по времени загрузки. `peers` — ИЗ уже
  // посчитанного выше `buildPeerView(received, sentRaw)`, на НЕфильтрованных
  // списках: lastActivityWithMeAt обязано отражать всю историю, а не только
  // то, что попало в окно этого конкретного опроса.
  const sentList = since !== null
    ? sentRaw.filter((b) => b.uploadedAt >= since || (b.firstFetchedAt != null && b.firstFetchedAt >= since))
    : sentRaw;

  res.json({
    inbox: inboxList.map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt })),
    sent: sentList.map(({ key, recipient, uploadedAt, firstFetchedAt }) => ({
      key, recipient, uploadedAt, fetched: firstFetchedAt != null,
    })),
    peers,
  });
});

// GET /bags/:recipient/:filename — download. bagKeyFor() always produces a
// key shaped "<recipient>/<uploadedAt>-<uuid>.bin", so the external
// "GET /bags/:key" interface needs two URL segments here, not one — a single
// `:key` param would stop at the first `/`.
app.get('/bags/:recipient/:filename', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(bagIpRateKey(ip), BAG_IP_RATE_MAX)) return bagRateLimited(res, 'rate_limited_ip');

  const address = requireBagPass(req, res);
  if (!address) return;

  if (!checkRateLimit(bagReadRateKey(address), BAG_READ_RATE_MAX)) return bagRateLimited(res, 'rate_limited_read');

  const key = `${req.params.recipient}/${req.params.filename}`;

  // Every failure branch below — malformed key, wrong owner, meta present but
  // the file is gone, key simply never existed — answers with the exact same
  // 404 body. That collapse is the point (rule 2 above): a 403 on "wrong
  // owner" vs 404 on "no such key" would let someone learn which keys exist
  // in another address's bag list just by watching the status code.
  let meta;
  try {
    meta = bagMetaOf(key);
  } catch {
    return res.status(404).json(BAG_NOT_FOUND);
  }
  // К-1: читать мешок вправе тот, кто в нём НАЗВАН — получатель ИЛИ
  // отправитель. До этого стояло только `meta.recipient !== address`, и
  // собственных отправленных человек не мог забрать НИКОГДА: ни после
  // перезагрузки вкладки, ни на новом устройстве. Конверт при этом
  // запечатан двумя слотами, второй — на себя, ровно ради собственного
  // архива (план «Клиент чата», Задача 3): слот был, доставать нечем.
  //
  // Утечки здесь нет и взяться ей неоткуда: `meta.sender` пишет СЕРВЕР из
  // пропуска на PUT, а не клиент из тела (см. PUT /bags/:recipient). То
  // есть «я отправитель» означает «я это и загрузил» — человек получает
  // свои же байты, которые сам же сюда и положил.
  const owner = meta && (meta.recipient === address || meta.sender === address);
  if (!owner) {
    return res.status(404).json(BAG_NOT_FOUND);
  }

  let filePath;
  try {
    filePath = bagPathFor(key);
  } catch {
    return res.status(404).json(BAG_NOT_FOUND);
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json(BAG_NOT_FOUND);
  }

  // Same defensive headers as the /files static mount (app.js:1058-1068) —
  // ciphertext is never meant to be rendered or sniffed.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Content-Type', 'application/octet-stream');
  // И-5 (ревью): the right to read this response lives ENTIRELY in the
  // x-bag-pass header — the body itself carries no proof of authorization.
  // A caching intermediary that keys on URL alone (and the key is part of
  // the URL, so it's a stable cache address) could otherwise serve a stored
  // response to a LATER request for the same URL with no pass at all.
  // no-store forbids storing this response anywhere; Vary additionally
  // tells any cache that does inspect headers that the response depends on
  // x-bag-pass, not just the URL.
  res.setHeader('Cache-Control', 'private, no-store');
  // Найдено попутно (короткий список координатора, не измерено отдельно):
  // app.use(cors(...)) (app.js, выше по цепочке middleware) уже ставит
  // Vary: Origin на любой ответ с заголовком Origin. res.setHeader('Vary',
  // ...) ЗАМЕНЯЕТ значение целиком, а не добавляет к нему — здесь это
  // стирало бы Origin, который CORS поставил секундами раньше. Вреда от
  // этого сегодня нет (Cache-Control: no-store уже запрещает кэширование
  // в принципе), но append(), а не setHeader(), — правильная форма: имя
  // заголовка одно, значения через запятую, ничего не теряется.
  res.append('Vary', 'x-bag-pass');

  // Мелочь (ревью): Express auto-answers HEAD for any registered GET route
  // by running this SAME handler and stripping the body at the wire level —
  // without this branch, a HEAD probe/prefetch would start the 7-day
  // "read" countdown for a bag nobody actually received a single byte of.
  // A HEAD caller gets exactly the headers a GET would, no body, no side
  // effect on the bag's lifetime.
  if (req.method === 'HEAD') {
    return res.end();
  }

  const rs = fs.createReadStream(filePath);
  rs.on('error', (e) => {
    console.error('[bags] read failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to read bag', code: 'internal_error' });
  });
  // Мелочь (ревью): marking happens on res 'finish' — fired only once the
  // response has finished being handed to the socket — not before streaming
  // starts. Marking up front (the previous shape) meant a dropped connection
  // mid-download (client closes the tab, network drop) still started the
  // 7-day "read" clock for a bag the recipient never actually received.
  // 'finish' at least removes the worst case (nothing streamed at all, or
  // the response object itself errors) from counting as read.
  //
  // Found by review, corrected here after the code first shipped saying the
  // opposite: 'finish' is NOT a reliable proxy for "the client actually
  // received the bytes" at bag scale. Measured directly (see
  // relayer/scripts/ history and task-3-report.md): for a payload at
  // MAX_BAG_SIZE (256 KB), the kernel accepts the entire response into its
  // own socket send buffer in one write() call before a client that never
  // reads a single byte and then destroys the connection even gets a chance
  // to do so — 'finish' fires regardless, well before any abort could
  // interrupt it. So a dropped connection can still, in practice, mark a
  // bag as fetched. Consequence, stated plainly: an undelivered message can
  // move from the 30-day "unread" TTL to the 7-day "read" one early. This is
  // a real limitation of marking on a completion event for small payloads,
  // not a bug to fix here — the server has no other signal available to
  // tell "handed to the kernel" apart from "received by the recipient" at
  // this size, short of application-level acks this protocol doesn't have.
  //
  // Trade-off, stated plainly: markFetched() can still throw (bagStore.js's
  // contract), but by the time 'finish' fires the 200 + bytes have already
  // gone out — there is no response left to turn into a 500 for. That
  // failure is logged and otherwise swallowed; the alternative (mark BEFORE
  // streaming, so a throw can still become a 500) is what caused this
  // finding in the first place, and getting the message to its recipient
  // matters more than the read receipt.
  // ⚠️ ОТМЕТКА — ТОЛЬКО НА ЧТЕНИИ ПОЛУЧАТЕЛЕМ (К-1). Отправитель теперь тоже
  // вправе скачать свой мешок, и если бы его чтение поднимало `fetched`,
  // человек, открывший собственную переписку, САМ СЕБЕ зажигал бы галочку
  // «доставлено» — она начала бы врать, причём в сторону, которую невозможно
  // заметить. Заодно поехал бы и срок жизни: 7 дней «прочитан» вместо 30
  // «не прочитан», у мешка, которого получатель ещё в глаза не видел.
  const marksRead = meta.recipient === address;
  res.on('finish', () => {
    if (!marksRead) return;
    try {
      markFetched(key, Date.now());
    } catch (e) {
      console.error('[bags] markFetched failed after successful delivery (read receipt lost, bytes already sent):', e.message);
    }
  });
  rs.pipe(res);
});

// ─── Ящик спора: факты из цепи, кэш, придержка, бюджет ────────────────────
//
// Три вопроса на каждый мешок: кто стороны этой сделки, идёт ли спор, кто
// ведёт спор СЕЙЧАС. Все три — из цепи, ни один — из наших записей: наши
// записи говорят только о том, что мы сами когда-то записали.
//
// ⚠️ ПОЧЕМУ НЕ _disputeProof (ниже по файлу). Тот держит одно булево «спор
// есть/нет» и, исчерпав потолок, уходит на ЗАПАСНУЮ ДОРОГУ — список всех
// спорных сделок разом. Здесь запасной дороги НЕ СУЩЕСТВУЕТ: getDisputed()
// не отдаёт ни арбитра, ни принадлежность сторон. Значит при молчании узла
// — ОТКАЗ (503), а не «пускаем на всякий случай». Сомнение решается в
// пользу закрытого ящика.
//
// ⚠️ TTL — 15 000 мс, и число выбрано по самому скоропортящемуся факту
// записи. Стороны в реестре не меняются никогда, статус меняется редко, а
// «кто ведёт спор сейчас» меняется — и именно он и есть замок. После
// releaseDisputeClaim прежний арбитр читает ящик ещё не дольше 15 секунд.
// Не 60 (DISPUTE_PROOF_TTL_MS): там кэш защищал ПУШ, здесь — доступ к чужой
// переписке. Не 0: при опросе описи раз в 5 с ящик стоит ≤4 обращений к
// цепи в минуту вместо 12 (замер — T16). Остаточный риск назван вслух:
// мешки, положенные в эти 15 секунд, запечатаны уже на НОВОГО арбитра, так
// что прежний получил бы нечитаемые байты.
const DISPUTE_BOX_TTL_MS            = readPositiveInt('DISPUTE_BOX_TTL_MS', 15_000);
const DISPUTE_BOX_RETRY_COOLDOWN_MS = readPositiveInt('DISPUTE_BOX_RETRY_COOLDOWN_MS', 10_000);
// ⚠️ Бюджет обращений к цепи — ПО АДРЕСУ СПРАШИВАЮЩЕГО, общего потолка нет
// намеренно. Общий делает больно соседу: у dispute-proof-chain это пришлось
// лечить запасной дорогой, а здесь её нет — исчерпанный общий потолок
// означал бы 503 честной стороне из-за чужого потока. Ключ списывается
// ТОЛЬКО когда мы реально идём в цепь (попадание в кэш и отказ по придержке
// не стоят ничего), поэтому 90/мин покрывает 22 ящика, опрашиваемых
// непрерывно, — больше, чем открытых заявок бывает у одного арбитра.
const DISPUTE_BOX_CHAIN_MAX         = readPositiveInt('DISPUTE_BOX_CHAIN_MAX', 90);
const DISPUTE_BOX_MAX_ENTRIES = 500;

const _boxFacts        = new Map();   // сделка → { facts, at }
const _boxReadFailedAt = new Map();   // сделка → момент последней неудачи

// Префикс обязателен: ключи /relay — сырая строка clientIp() БЕЗ префикса
// (app.js:1920), а при TRUST_PROXY=true clientIp() отдаёт заголовок
// дословно, формы не проверяя. Голый адрес в качестве ключа означал бы, что
// `CF-Connecting-IP: 0x<жертва>` разряжает бюджет жертвы. Тот же приём, что
// у `ip:`/`bag-`/`chain:`/`push-` выше.
function boxWriteRateKey(address) { return `box-write:${address}`; }
function boxReadRateKey(address)  { return `box-read:${address}`;  }
function boxChainRateKey(address) { return `box-chain:${address}`; }

// ⚠️ Ревью круг 1, находка 2 (Important) — цена «не умрёт никогда», числом.
// ДО Задачи 2 (4в-2) у мешка ящика был жёсткий потолок BAG_MAX_AGE_MS
// (90 суток от загрузки), без исключений. ПОСЛЕ нeё: пока цепь говорит
// DISPUTED и эскроу заперт (funded=true), потолок НЕ применяется вовсе
// (disputeBoxBagDeadline() в bagStore.js, мутации 5/6 в её тестах) — якорь
// «сейчас» двигает срок вперёд каждую ночь, пока freezeVerdict() держит
// дело (ArbiterRegistryFacet.sol:848, onlyOwnerOrDAO, без таймаута).
// Потолка по объёму на ОДНУ сторону при этом тоже нет — квота на ящик не
// заводится (открытый пункт 28.2 плана 4в-2). Ограничение здесь только
// временно́е: темп записи, а не объём, который может накопиться, и не срок,
// пока дело заморожено.
//
// Это не гипотеза — это цена решения «funded освобождает от 90-дневного
// потолка», принятого этой же задачей. По ошибке одна сторона столько не
// накопит (нужен непрерывный поток), но это уже не «косметический» долг у
// пункта 28.2 — это то, что квота обязана будет закрыть. Худший случай
// посчитан и лежит во внутреннем реестре; здесь и в docs/OPEN-ITEMS.md он
// намеренно не приводится числом, пока квоты нет.
// ⚠️ Сосед по теме: отсрочка «узел молчит» (К-1, cleanupBags() в
// bagStore.js) ограничена ТЕМ ЖЕ BAG_MAX_AGE_MS от uploadedAt — то есть
// узел, молчащий дольше 90 суток подряд, снесёт мешок живого спора, даже
// если цепь (будь она доступна) сказала бы DISPUTED. Асимметрия честная:
// «спор жив и цепь отвечает» — бессрочно; «спор жив, а узнать нечем» —
// не дольше 90 суток. Не чинится этим кругом — названо числом, как
// потребовало ревью.
const DISPUTE_BOX_WRITE_RATE_MAX = readPositiveInt('DISPUTE_BOX_WRITE_RATE_MAX', 60);
const DISPUTE_BOX_READ_RATE_MAX  = readPositiveInt('DISPUTE_BOX_READ_RATE_MAX', 120);

function evictOldest(map, pick) {
  if (map.size < DISPUTE_BOX_MAX_ENTRIES) return;
  const oldest = [...map.entries()].sort((a, b) => pick(a[1]) - pick(b[1]))[0];
  if (oldest) map.delete(oldest[0]);
}

/**
 * Факты о ящике спора: { ok: true, facts } либо { ok: false, reason }.
 *
 * facts = { exists, client, executor, disputed, arbiter } — адреса в нижнем
 * регистре, `arbiter` может быть null («спор никто не ведёт»).
 * reason — 'chain_unavailable' | 'rate_limited'.
 *
 * ⚠️ Существование сделки — по `record.agreement === agreement`, НЕ по
 * статусу (см. комментарий у getRecord в REGISTRY_MINI_ABI).
 * ⚠️ Спор — по статусу САМОЙ СДЕЛКИ (== 4). У реестра DISPUTED = 3; два
 * разных enum, путать нельзя.
 * ⚠️ Арбитр — disputeArbiterOf(), НЕ Agreement.arbiter (туда claimDispute
 * пишет сам диамонд; разбор — комментарий у disputeArbiterOf).
 *
 * ⚠️ `disputed` С ИТОГОВОГО РЕВЬЮ ВЕТКИ БОЛЬШЕ НЕ ЗАМОК НИ ОДНОГО МАРШРУТА, и
 * это сказано вслух, а не оставлено на догадку. Право писать в ящик даёт
 * ведущий арбитр (см. PUT ниже), право читать — он же; статус сделки не
 * решает здесь ничего. Поле остаётся фактом о сделке и стоит одного
 * staticcall на промах кэша. Записано в docs/OPEN-ITEMS.md (пункт 53.5) —
 * чтобы следующий не счёл его проверяемым.
 */
async function disputeBoxFacts(agreement, asker) {
  const now = Date.now();

  const hit = _boxFacts.get(agreement);
  if (hit && now - hit.at < DISPUTE_BOX_TTL_MS) return { ok: true, facts: hit.facts };

  // Придержка по адресу, чтение которого только что сорвалось. Это НЕ кэш
  // ответа: ответа мы не запоминаем и на следующем запросе снова пойдём в
  // цепь — просто не чаще, чем раз в DISPUTE_BOX_RETRY_COOLDOWN_MS.
  const failedAt = _boxReadFailedAt.get(agreement);
  if (failedAt !== undefined && now - failedAt < DISPUTE_BOX_RETRY_COOLDOWN_MS) {
    return { ok: false, reason: 'chain_unavailable' };
  }

  // Бюджет тратится ТОЛЬКО когда мы собираемся реально пойти в цепь.
  if (!checkRateLimit(boxChainRateKey(asker), DISPUTE_BOX_CHAIN_MAX)) {
    return { ok: false, reason: 'rate_limited' };
  }

  let facts;
  try {
    const registry = new ethers.Contract(DIAMOND_ADDR, REGISTRY_MINI_ABI, provider);
    const rec = await registry.getRecord(agreement);
    const named = String(rec?.agreement ?? rec?.[0] ?? '').toLowerCase();
    if (named !== agreement) {
      facts = { exists: false, client: null, executor: null, disputed: false, arbiter: null };
    } else {
      const client   = String(rec?.client   ?? rec?.[1] ?? '').toLowerCase();
      const executor = String(rec?.executor ?? rec?.[2] ?? '').toLowerCase();
      const agr = new ethers.Contract(agreement, AGREEMENT_MINI_ABI, provider);
      const details = await agr.getDetails();
      // AGREEMENT_STATUS_DISPUTED объявлена ниже по файлу (у пушей спора) и
      // равна 4. Второй копии числа не заводим: хозяин у него один. К моменту
      // ПЕРВОГО вызова этой функции тело модуля давно вычислено, TDZ пройдена.
      const disputed = Number(details.status_) === AGREEMENT_STATUS_DISPUTED;
      const arbiter = await disputeArbiterOf(agreement);
      facts = { exists: true, client, executor, disputed, arbiter };
    }
  } catch (e) {
    // Сюда попадает и «узел молчит», и «по адресу не то, что мы думали».
    // Разделить их нечем, и обе — «вердикта нет»: ящик закрыт.
    console.error('[disputes] box facts read failed for', agreement, '-', e.message);
    evictOldest(_boxReadFailedAt, (v) => v);
    _boxReadFailedAt.set(agreement, now);
    return { ok: false, reason: 'chain_unavailable' };
  }

  _boxReadFailedAt.delete(agreement);
  evictOldest(_boxFacts, (v) => v.at);
  _boxFacts.set(agreement, { facts, at: now });
  return { ok: true, facts };
}

/** Только для тестов: забыть факты и придержки между кейсами. */
export function _resetDisputeBoxCache() { _boxFacts.clear(); _boxReadFailedAt.clear(); }

// ─── Ящик спора: три маршрута ─────────────────────────────────────────────
//
// Ящик опознаётся адресом Agreement-контракта. Писать в него могут только
// клиент и исполнитель ЭТОЙ сделки и только пока спор идёт; читать — тот,
// кто ведёт спор сейчас, плюс отправитель про СВОЙ мешок.
//
// ⚠️ ОТСТУПЛЕНИЕ ОТ «ПРАВИЛА 2» СКЛАДА, сознательное. Все ветки старого
// GET /bags/:key отвечают одним и тем же 404, чтобы по коду ответа нельзя
// было узнать, какие ключи есть у чужого адреса. Здесь коды РАЗНЫЕ, потому
// что участники спора и его арбитр ПУБЛИЧНЫ В ЦЕПИ — скрывать членство
// незачем, а экран обязан объяснить человеку, что именно не так («вы не
// сторона» и «спор ещё не начался» — разные советы). Отступление
// ограничено этими тремя маршрутами; старые /bags/* своего единого 404 не
// теряют. ВНУТРИ ящика правило 2 остаётся: «нет такого ключа», «мешок не
// твой» и «файла нет» — один и тот же bag_not_found, потому что ключ несёт
// uuid и его существование не публично нигде.
//
// ⚠️ 507 НА НЕХВАТКУ ДИСКА ЗДЕСЬ НЕТ, И ЭТО РЕШЕНИЕ. Запас
// (DISK_RESERVE_BYTES, 2 ГиБ) держится ИМЕННО для мешков — так сказано у
// самой константы. Мешок предъявления — 256 КиБ: в освобождённый отказом
// чат-файлов запас их влезает 8192. Поставить 507 здесь значило бы
// потратить резерв на то, ради чего он и держится. Настоящее кончившееся
// место обработано двумя ветками общего кода: ws.on('error') в
// streamWithSizeLimit → 500 write_failed с удалением обрезка, и бросок
// recordBag → 500 internal_error с удалением файла.
const DISPUTE_BOX_NOT_FOUND = { error: 'Bag not found', code: 'bag_not_found' };
const SEALED_FOR_HEADER = 'x-sealed-for';
const LOWER_ADDR_RE = /^0x[0-9a-f]{40}$/;

/** Адрес сделки из пути, в нижнем регистре, или null (клиенту уже отвечено). */
function boxAgreementParam(req, res) {
  const agreement = String(req.params.agreement || '').toLowerCase();
  if (!LOWER_ADDR_RE.test(agreement)) {
    res.status(400).json({ error: 'Invalid agreement address', code: 'invalid_agreement' });
    return null;
  }
  return agreement;
}

/** Факты о существующей сделке, или null (клиенту уже отвечено). */
async function requireBoxFacts(agreement, asker, res) {
  const verdict = await disputeBoxFacts(agreement, asker);
  if (!verdict.ok) {
    if (verdict.reason === 'rate_limited') {
      bagRateLimited(res, 'rate_limited_box_chain');
      return null;
    }
    // 503, не 404 и не 403. Переспрашивать нечего: и сделка, и права,
    // возможно, безупречны — молчит узел. Ответить «нет такой сделки»
    // значило бы соврать с уверенным лицом.
    res.status(503).set('Retry-After', '5')
      .json({ error: 'Deal state could not be read on-chain right now', code: 'chain_unavailable' });
    return null;
  }
  if (!verdict.facts.exists) {
    res.status(404).json({ error: 'No such deal', code: 'no_such_deal' });
    return null;
  }
  return verdict.facts;
}

// PUT /disputes/:agreement/bags — положить мешок в ящик спора.
//
// Порядок — от дешёвого к дорогому, как у всей семьи мешков: бюджет выхода
// → пропуск → бюджет адреса → форма запроса → цепь → права → диск.
//
// ⚠️ ЦЕПЬ СПРАШИВАЕТСЯ ДО ПЕРВОГО БАЙТА НА ДИСКЕ. Мешок постороннего не
// занимает места вообще, ни на миг — это и есть ответ на «21 ГиБ в сутки»:
// писать теперь НЕКУДА, а не «можно, но по чуть-чуть». Тело в это время
// лежит в буфере ядра: поток не читается никем, пока ниже не встанет
// streamWithSizeLimit.
app.put('/disputes/:agreement/bags', async (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(bagIpRateKey(ip), BAG_IP_RATE_MAX)) return bagRateLimited(res, 'rate_limited_ip');

  const sender = requireBagPass(req, res);
  if (!sender) return;

  if (!checkRateLimit(boxWriteRateKey(sender), DISPUTE_BOX_WRITE_RATE_MAX)) {
    return bagRateLimited(res, 'rate_limited_write');
  }

  // Тот же капкан, что у PUT /bags/:recipient: глобальный express.json()
  // выпил бы тело выше по цепочке, streamWithSizeLimit записал бы ноль
  // байт, и вызывающий получил бы 200 за мешок, которого нет.
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType === 'application/json') {
    return res.status(400).json({
      error: 'Bag upload must not use Content-Type: application/json (body already consumed upstream)',
      code: 'bag_content_type',
    });
  }

  const agreement = boxAgreementParam(req, res);
  if (!agreement) return;

  // ⚠️ x-sealed-for — СЛОВО КЛАДУЩЕГО. Мешок нечитаем для сервера, проверить
  // его содержимое нечем и никогда будет нечем. Проверяем ФОРМУ и только
  // её: иначе в опись поедет что угодно и экран арбитра покажет мусор на
  // месте адреса. Отсутствие заголовка — законно: это «не заявлено» (null),
  // а не ошибка.
  const claimedRaw = req.headers[SEALED_FOR_HEADER];
  let sealedFor = null;
  if (claimedRaw !== undefined) {
    const claimed = String(claimedRaw).trim().toLowerCase();
    if (!LOWER_ADDR_RE.test(claimed)) {
      return res.status(400).json({ error: 'Invalid x-sealed-for', code: 'invalid_sealed_for' });
    }
    sealedFor = claimed;
  }

  const facts = await requireBoxFacts(agreement, sender, res);
  if (!facts) return;

  if (sender !== facts.client && sender !== facts.executor) {
    return res.status(403).json({ error: 'Not a party to this deal', code: 'not_a_party' });
  }
  // ⚠️ ПРАВО ПИСАТЬ = ПРАВО ЧИТАТЬ, И ПРИЗНАК У НИХ ОДИН (решение владельца,
  // итоговое ревью ветки 4в-2). Прежде здесь стоял `!facts.disputed`, то есть
  // status_ == 4 у самой сделки, — а чтение ящика статуса не спрашивает вовсе
  // (см. ⚠ у GET ниже: вердикт подан → сделка RESOLVED, а арбитру ещё
  // разбирать апелляцию). Разъезд был не теоретический: экран арбитра
  // ЧЕТЫРЕЖДЫ советует «попросите предъявить заново» — «мешок заявлен на
  // другого», «не наш ключ», «не разобрался», «недочитано», — и все четыре
  // совета попадали в окно, где сторона физически не может этого сделать:
  // сделка уже не DISPUTED, кнопки нет, склад отвечает 409.
  //
  // Теперь замок один: пока у спора ЕСТЬ ведущий арбитр (disputeArbiterOf),
  // сторона вправе положить мешок. Нет арбитра — 409 и на живом споре тоже:
  // печатать не на кого, и мешок, запечатанный в пустоту, не откроет никто.
  //
  // ⚠️ ВТОРОЙ ЗАМОК ЗАПИСИ НЕ ТРОНУТ: выше стоит «только клиент и исполнитель
  // ЭТОЙ сделки», и правка его не касается (замер — T38).
  if (facts.arbiter === null) {
    return res.status(409).json({
      error: 'Nobody is handling this dispute right now — there is no arbiter to seal a presentation to',
      code: 'not_disputed',
    });
  }

  // Задача 2 (4в-2): СРОК СТАВИТСЯ ЗДЕСЬ, а не ночной уборкой в 03:00.
  // Мешок, залитый в 03:05 и открытый арбитром в тот же день, получил бы
  // семидневный срок (правило 2 склада) и мог не дожить до конца спора —
  // ночная уборка добралась бы до него только следующей ночью, а спор с
  // апелляцией идёт девять суток и верхней границы в цепи не имеет.
  //
  // ⚠️ Это ПЯТОЕ чтение цепи на маршрутах ящика — то самое, что названо
  // в договоре шапки плана («Кто это проверяет», строка 5 таблицы).
  // Список общий на весь план, не мой частный: поддельный узел в стендах
  // Задачи 6 обязан отвечать и на этот селектор, иначе каждый PUT вернёт
  // 503 ниже и стенд покраснеет по чужой причине.
  //
  // DISPUTE_WINDOW() — public constant КОНКРЕТНОГО клона, кэшируется по
  // адресу агримента на весь процесс (makeCachedConstantMsReader), так
  // что цена — один staticcall на ПЕРВЫЙ мешок каждой сделки, дальше 0.
  let boxDeadline;
  try {
    const agr = new ethers.Contract(agreement, AGREEMENT_MINI_ABI, provider);
    const disputeWindowMs = await getDisputeWindowMs(agr, agreement);
    boxDeadline = disputeBoxBagDeadline(Date.now(), disputeWindowMs);
  } catch (e) {
    // Отказ узла именно здесь — не повод принять мешок с неизвестным
    // сроком: «принято» с семидневной жизнью хуже, чем честное «попробуй
    // ещё раз», потому что первое человек считает сделанным делом. Ответ
    // — БАЙТ В БАЙТ тот же, которым requireBoxFacts() Задачи 1 отвечает
    // на молчащую цепь: второго словаря отказов у одного маршрута быть
    // не должно.
    console.error('[disputes] DISPUTE_WINDOW read failed for', agreement, '-', e.message);
    return res.status(503).set('Retry-After', '5')
      .json({ error: 'Deal state could not be read on-chain right now', code: 'chain_unavailable' });
  }

  let key, filePath;
  try {
    key = bagKeyFor(agreement);
    filePath = bagPathFor(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (e) {
    console.error('[disputes] PUT setup failed:', e.message);
    return res.status(500).json({ error: 'Failed to prepare bag storage', code: 'internal_error' });
  }

  streamWithSizeLimit(req, res, filePath, MAX_BAG_SIZE, () => {
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch (e) {
      console.error('[disputes] PUT stat-after-write failed:', e.message);
      unlinkQuietSync(filePath);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to read uploaded bag', code: 'internal_error' });
      return;
    }
    if (size === 0) {
      unlinkQuietSync(filePath);
      if (!res.headersSent) res.status(400).json({ error: 'Empty bag', code: 'empty_bag' });
      return;
    }
    try {
      const uploadedAt = Date.now();
      // ⚠️ Задача 2 (срок жизни мешков ящика) ДОПИСАЛА сюда `dealDeadline` —
      // она дописывает поле, а не переписывает вызов. `deal` и `sealedFor`
      // обязаны остаться: без первого мешок перестаёт быть мешком ящика
      // (6 красных в test/disputeBox.test.js), без второго опись теряет
      // «на кого заявлено», sealedForOthers становится вечным нулём, и новый
      // арбитр видит пустой ящик там, где сторона предъявляла (2 красных).
      const stored = recordBag({
        sender, recipient: agreement, key, size, uploadedAt,
        deal: agreement, sealedFor,
        dealDeadline: boxDeadline,   // ← Задача 2, единственная новая строка
      });
      // uploadedAt отдаём наружу намеренно: человеку показывают «положено в
      // ящик» + ВРЕМЯ, и это время обязано быть серверным. Возьми клиент
      // своё — и «положено 14:02» разошлось бы с «забрал 13:58» у другого.
      res.status(200).json({ key: stored.key, uploadedAt: stored.uploadedAt });
    } catch (e) {
      // recordBag бросает по контракту bagStore.js (в том числе когда на
      // диске кончилось место): без этого catch отказ записи убивал бы
      // процесс вместо одного запроса.
      console.error('[disputes] recordBag failed:', e.message);
      unlinkQuietSync(filePath);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to record bag', code: 'internal_error' });
    }
  });
});

// GET /disputes/:agreement/bags — опись ящика.
//
// ⚠️ ЧТЕНИЕ НЕ ТРЕБУЕТ status_ == 4. Вердикт подан — сделка уходит в
// RESOLVED, а арбитру ещё нужно смотреть предъявленное (апелляция, разбор).
// Право чтения даёт disputeArbiterOf, а не статус.
//
// ⚠️ СТОРОНА ВИДИТ ТОЛЬКО СВОИ МЕШКИ. «Противная сторона предъявила»
// ей не показывается: это её дело перед арбитром, а не перед оппонентом.
// Арбитр видит ящик целиком — иначе он не узнает, что предъявляли вообще.
app.get('/disputes/:agreement/bags', async (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(bagIpRateKey(ip), BAG_IP_RATE_MAX)) return bagRateLimited(res, 'rate_limited_ip');

  const address = requireBagPass(req, res);
  if (!address) return;

  if (!checkRateLimit(boxReadRateKey(address), DISPUTE_BOX_READ_RATE_MAX)) {
    return bagRateLimited(res, 'rate_limited_read');
  }

  const agreement = boxAgreementParam(req, res);
  if (!agreement) return;

  const facts = await requireBoxFacts(agreement, address, res);
  if (!facts) return;

  const isArbiter = facts.arbiter !== null && facts.arbiter === address;
  const isParty   = address === facts.client || address === facts.executor;
  if (!isArbiter && !isParty) {
    return res.status(403).json({ error: 'Not the arbiter of this dispute', code: 'not_the_arbiter' });
  }

  let all;
  try {
    all = listDisputeBags(agreement);
  } catch (e) {
    console.error('[disputes] GET box failed:', e.message);
    return res.status(500).json({ error: 'Failed to list the dispute box', code: 'internal_error' });
  }

  const visible = isArbiter ? all : all.filter((b) => b.sender === address);

  // ⚠️ sealedFor отдаётся с пометкой источника — не здесь, а в ТИПЕ и в
  // тексте на экране (Задачи 6 и 7). Сервер обязан только не выдавать его
  // за проверенное: он и не выдаёт — поле называется «на кого ЗАЯВЛЕНО»,
  // отдельного «проверено» рядом нет и не будет.
  // ⚠️ fetchedAt — МОМЕНТ (мс, часы сервера), а не галочка. Сторона печатает
  // «положено 14:02 · забрал 14:07», и оба времени обязаны быть серверными:
  // на устройстве с уехавшими часами булево заставило бы клиента подставить
  // СВОЁ время, а спор — ровно то место, где порядок событий имеет цену.
  // Значение уже лежит в описи (firstFetchedAt), выдумывать нечего;
  // `?? null` только приводит отсутствующее к честному null, чтобы поле не
  // исчезло из JSON целиком.
  const bags = visible.map((b) => ({
    key: b.key,
    sender: b.sender,
    sealedFor: b.sealedFor ?? null,
    size: b.size,
    uploadedAt: b.uploadedAt,
    fetchedAt: b.firstFetchedAt ?? null,
  }));

  // ⚠️ Считается по ВИДИМЫМ мешкам, а не по всему ящику: иначе сторона
  // узнавала бы про чужие предъявления числом. И ноль, когда арбитра нет
  // вовсе: сравнивать не с кем, а выдумать «на других» значило бы соврать.
  const sealedForOthers = facts.arbiter === null
    ? 0
    : visible.filter((b) => b.sealedFor != null && b.sealedFor !== facts.arbiter).length;

  // ⚠️ `arbiter` уезжает из КЭША ФАКТОВ, а не из свежего чтения: ему до
  // DISPUTE_BOX_TTL_MS (15 с), плюс придержка после неудачи. Значит это «кто
  // ведёт спор по нашему последнему чтению», и ни один текст на экране не
  // вправе выдавать его за состояние цепи прямо сейчас: арбитр, только что
  // взявший спор, до конца окна увидит здесь предшественника. То же
  // ограничение — у sealedForOthers: он сравнивается ровно с этим значением.
  //
  // ⚠️ Ревью, круг 2: `indexTrusted` — НЕ второй источник правды. Тот же
  // признак, что уже отдаёт /health в поле storage.indexTrusted (app.js:1737),
  // читается из ТОЙ ЖЕ isBagStoreHealthy(). Назначение здесь другое: круг 1
  // измерил (test/disputeBox.test.js:T30), что после потери индекса
  // _scanDiskBags() восстанавливает записи БЕЗ deal/sealedFor, они выпадают
  // из listDisputeBags() насовсем, и bags здесь может быть пуст, даже когда
  // мешки на диске лежат — арбитр не отличит это от «сторона ничего не
  // предъявляла» (§2.3 замысла). Комментарий в релеере фронт ни к чему не
  // обязывает — признак обязан ехать В ОТВЕТЕ, чтобы экран не мог его не
  // увидеть. `false` здесь означает ровно «bags мог бы быть неполон или
  // пуст не по факту, а по потере индекса» — Задача 7 обязана сказать это
  // человеку, а не показать пустой ящик как утверждение.
  res.json({ bags, arbiter: facts.arbiter, sealedForOthers, indexTrusted: isBagStoreHealthy() });
});

// GET /disputes/:agreement/bags/:name — забрать мешок.
app.get('/disputes/:agreement/bags/:name', async (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(bagIpRateKey(ip), BAG_IP_RATE_MAX)) return bagRateLimited(res, 'rate_limited_ip');

  const address = requireBagPass(req, res);
  if (!address) return;

  if (!checkRateLimit(boxReadRateKey(address), DISPUTE_BOX_READ_RATE_MAX)) {
    return bagRateLimited(res, 'rate_limited_read');
  }

  const agreement = boxAgreementParam(req, res);
  if (!agreement) return;

  const facts = await requireBoxFacts(agreement, address, res);
  if (!facts) return;

  const isArbiter = facts.arbiter !== null && facts.arbiter === address;
  const isParty   = address === facts.client || address === facts.executor;
  if (!isArbiter && !isParty) {
    return res.status(403).json({ error: 'Not the arbiter of this dispute', code: 'not_the_arbiter' });
  }

  // Ключ склада собирается ЗДЕСЬ из адреса сделки и имени, а не берётся у
  // клиента целиком: bagPathFor() бросает на любой форме, кроме своей
  // собственной, так что обход каталога отсекается формой ключа, а не
  // отдельным санитайзером, который можно забыть позвать.
  const key = `${agreement}/${req.params.name}`;

  let meta;
  try {
    meta = bagMetaOf(key);
  } catch {
    return res.status(404).json(DISPUTE_BOX_NOT_FOUND);
  }
  // meta.deal !== agreement отсекает чат-мешок, случайно адресованный
  // контракту сделки: он в ящике не лежит и через ящик не выдаётся.
  if (!meta || meta.deal !== agreement) return res.status(404).json(DISPUTE_BOX_NOT_FOUND);

  // Внутри ящика правило 2 действует: «не твой» и «нет такого» — один код.
  if (!isArbiter && meta.sender !== address) return res.status(404).json(DISPUTE_BOX_NOT_FOUND);

  let filePath;
  try {
    filePath = bagPathFor(key);
  } catch {
    return res.status(404).json(DISPUTE_BOX_NOT_FOUND);
  }
  if (!fs.existsSync(filePath)) return res.status(404).json(DISPUTE_BOX_NOT_FOUND);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Content-Type', 'application/octet-stream');
  // Право читать живёт ЦЕЛИКОМ в заголовке x-bag-pass — тело доказательства
  // авторизации не несёт. Посредник, кэширующий по URL, отдал бы этот ответ
  // следующему спросившему без всякого пропуска.
  res.setHeader('Cache-Control', 'private, no-store');
  res.append('Vary', 'x-bag-pass');   // append, а не setHeader: cors уже поставил Vary: Origin

  // Express отвечает на HEAD тем же обработчиком, срезая тело на проводе.
  // Без этой ветки разведочный HEAD зажигал бы «забрал» у мешка, которого
  // арбитр не получил ни байта.
  if (req.method === 'HEAD') return res.end();

  const rs = fs.createReadStream(filePath);
  rs.on('error', (e) => {
    console.error('[disputes] read failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to read bag', code: 'internal_error' });
  });
  // ⚠️ ОТМЕТКА — ТОЛЬКО ЧТЕНИЮ ТЕКУЩЕГО АРБИТРА. Отправитель вправе забрать
  // свой мешок (перезагрузил вкладку, сменил устройство), но его чтение не
  // имеет права зажигать галочку: она начала бы врать в сторону, которую
  // невозможно заметить — человек сам себе показал бы «арбитр забрал».
  //
  // ⚠️ И ЧЕСТНО О ГРАНИЦЕ САМОЙ ОТМЕТКИ: 'finish' срабатывает, когда ответ
  // отдан ЯДРУ, а не получен человеком. Для 256 КиБ ядро принимает весь
  // ответ одним write() раньше, чем оборвавший соединение клиент успеет
  // это сделать (замер — комментарий у GET /bags/:recipient/:filename).
  // Значит «забрал» — правда про байты и не обязательно правда про
  // доставку. Слов «прочитал» и «понял» здесь нет и не будет.
  //
  // ⚠️ И ЧТО ОТМЕТКА НЕ ДЕЛАЕТ: она НЕ УКОРАЧИВАЕТ срок мешка ящика. Правило
  // общего склада («прочитан» переводит с 30 дней на 7) для мешка ящика
  // перекрыто: PUT выше кладёт в опись `dealDeadline` (срок спора вместе с
  // окном апелляции, `disputeBoxBagDeadline`), а `bagExpiryAt` берёт
  // `Math.max(base, dealDeadline)` (bagStore.js). Значит первый заход арбитра
  // не может убить предъявление раньше спора — ни при каком порядке событий.
  // ⚠️ Прежде здесь было написано обратное («может умереть РАНЬШЕ спора, это
  // Задача 2, и она начинается отсюда»). Задача 2 приехала В ЭТОЙ ЖЕ ВЕТКЕ, и
  // с ней факт отменился; комментарий пережил её на один круг ревью.
  const marksRead = isArbiter;
  res.on('finish', () => {
    if (!marksRead) return;
    try {
      markFetched(key, Date.now());
    } catch (e) {
      console.error('[disputes] markFetched failed after successful delivery (read receipt lost, bytes already sent):', e.message);
    }
  });
  rs.pipe(res);
});

// ─── Справочник открытых ключей чата (Задача 2, chat-client) ───────────────
//
// POST /keys — положить свой открытый ключ. Требует пропуск (правило 1
// брифа: адрес берётся ИЗ пропуска через requireBagPass(), не из тела —
// тело может утверждать что угодно про `address`, это поле просто никогда
// не читается). GET /keys/:address — прочитать чужой, БЕЗ пропуска
// (правило 4: открытый ключ на то и открытый; требовать пропуск на чтение
// значило бы выдавать список того, кто кем интересуется).
//
// Свои собственные бюджеты лимитера, не переиспользуют BAG_*_RATE_MAX —
// справочник и мешки логически разные ресурсы (регистрация ключа — редкое
// событие, на порядок реже, чем опрос списка мешков), общий счётчик заставил
// бы всплеск одного голодать другой без единого нападающего, тот же урок,
// что И-4 (ревью Задачи 3, см. комментарий у BAG_PASS_RATE_MAX и соседей)
// уже поймал для трёх видов бюджетов мешков.
const KEYS_WRITE_RATE_MAX = readPositiveInt('KEYS_WRITE_RATE_MAX', 20);
// Один общий IP-бюджет на оба маршрута справочника (не разбит по
// чтение/запись, как адресный) — то же обоснование, что у BAG_IP_RATE_MAX:
// грубая сетевая защита "не заваливай нас отсюда", GET не имеет
// авторизованного адреса вызывающего вообще (правило 4), так что адресный
// бюджет для него физически нечем ключевать.
const KEYS_IP_RATE_MAX = readPositiveInt('KEYS_IP_RATE_MAX', 120);

function keysWriteRateKey(address) { return `keys-write:${address}`; }
function keysIpRateKey(ip)         { return `keys-ip:${ip}`;         }

const KEY_NOT_FOUND = { error: 'No chat key on file for this address', code: 'key_not_found' };

// bagRateLimited() (объявлена выше, у маршрутов мешков) — форма ответа
// generic ({error, code} на 429 с Retry-After), не специфична для мешков
// несмотря на имя; переиспользуется здесь буквально, а не копируется.
app.post('/keys', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(keysIpRateKey(ip), KEYS_IP_RATE_MAX)) return bagRateLimited(res, 'rate_limited_ip');

  const address = requireBagPass(req, res);
  if (!address) return;

  if (!checkRateLimit(keysWriteRateKey(address), KEYS_WRITE_RATE_MAX)) return bagRateLimited(res, 'rate_limited_write');

  // signKey — ключ проверки подписи звеньев (Ed25519, выводится отдельным
  // под-ключом в chatConversation.ts). Клиент чата передаёт его ВСЕГДА;
  // необязательным поле осталось по форме, чтобы старое тело без него
  // по-прежнему клало только boxKey и не отвергалось.
  //
  // attestation — заверение связки «адрес ↔ ключи» подписью КОШЕЛЬКА (4в-1).
  // Сервер его хранит и отдаёт, подпись не проверяет (разбор — directory.js).
  const { boxKey, signKey, attestation } = req.body || {};
  try {
    const stored = putKey(address, { boxKey, signKey, attestation }, Date.now());
    res.json(stored);
  } catch (e) {
    if (e.code === 'invalid_key') {
      return res.status(400).json({ error: e.message, code: 'invalid_key' });
    }
    if (e.code === 'invalid_attestation') {
      // Отдельный код, а не invalid_key: клиент по нему повторяет запрос БЕЗ
      // заверения, чтобы негодная улика не стоила человеку самого объявления
      // ключа (publishChatKeys). Слитые в один код, эти два случая заставили бы
      // его повторять и то, что повторять бессмысленно.
      return res.status(400).json({ error: e.message, code: 'invalid_attestation' });
    }
    if (e.code === 'directory_unavailable') {
      return res.status(503).json({ error: e.message, code: 'directory_unavailable' });
    }
    console.error('[keys] POST /keys failed:', e.message);
    return res.status(500).json({ error: 'Failed to store chat key', code: 'internal_error' });
  }
});

app.get('/keys/:address', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(keysIpRateKey(ip), KEYS_IP_RATE_MAX)) return bagRateLimited(res, 'rate_limited_ip');

  // Тот же приём, что PUT /bags/:recipient уже применяет к req.params.recipient
  // (app.js, выше) — сырой URL-параметр приходит из жизни как угодно
  // (кошелёк отдаёт чексуммированный, смешанного регистра, адрес), лоуэркейс
  // до проверки формы, а не отдельная ветка "не нашли, потому что не тот регистр".
  const address = String(req.params.address || '').toLowerCase();
  if (!ETH_ADDR_RE.test(address)) {
    return res.status(400).json({ error: 'Invalid address', code: 'invalid_address' });
  }

  let record;
  try {
    record = getKeyRecord(address);
  } catch (e) {
    if (e.code === 'directory_unavailable') {
      return res.status(503).json({ error: e.message, code: 'directory_unavailable' });
    }
    console.error('[keys] GET /keys failed:', e.message);
    return res.status(500).json({ error: 'Failed to read chat key', code: 'internal_error' });
  }

  // Правило 5: незнакомый адрес — 404 с кодом, не пустой 200. "Не заходил"
  // и "что-то сломалось" не должны выглядеть одинаково — заявленная порча
  // всего справочника (ветка выше) уже отдельно отвечает 503, так что 404
  // здесь однозначно означает именно "этот адрес никогда не регистрировал
  // ключ", а не "искали и не нашли по неизвестной причине".
  if (!record) return res.status(404).json(KEY_NOT_FOUND);

  res.json(record);
});

// Мелочь (ревью координатора, round 3): "413 — единственный ответ этих
// маршрутов без кода. Раунд закрыл 500, соседа пропустил." Тело сверх
// express.json({limit:'64kb'}) (app.js, глобально, у самого верха файла)
// бросает ДО того, как управление доходит до тела маршрута — Express без
// собственного обработчика ошибок отвечает HTML-страницей со стеком
// вызовов, не JSON, что нарушает то же правило, которому подчиняются
// 400/401/404/503/500 этого маршрута ("каждый замок сверяет код, не
// только статус"). Путь-скоупнутый error-handling middleware (4 аргумента
// — Express распознаёт это как обработчик ошибок только по арности
// функции, не по имени) — ловит ТОЛЬКО ошибки, всплывшие при обработке
// запроса на /keys*, не трогает остальные маршруты (у которых своя,
// общепроектная договорённость про эту дыру — не эта задача).
// Задача 6 (план «Клиент чата»): тот же обработчик теперь стоит и на /bags,
// и знает вторую ошибку тела — `entity.parse.failed` (битый JSON). Обе
// уходили в дефолтный обработчик Express, то есть приезжали клиенту HTML-
// страницей со стеком: `parseErrorBody()` в frontend/src/lib/chatTransport.ts
// не находит в такой странице ни `error`, ни `code`, и отказ становится
// БЕЗЫМЯННЫМ ровно там, где вся задача про имена отказов. Вопрос «пришёл
// мусор — вердикт или падение»: теперь вердикт с кодом.
//
// Скоуп по-прежнему путевой (`/keys`, `/bags`), не глобальный: у остальных
// маршрутов проекта своя договорённость про эту дыру, и менять её здесь
// значило бы тронуть /relay, /files и /push заодно — не эта задача.
function bodyParserErrorHandler(err, req, res, next) {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large (max 64kb)', code: 'payload_too_large' });
  }
  if (err && (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported')) {
    return res.status(400).json({ error: 'Malformed JSON body', code: 'malformed_json' });
  }
  next(err);
}
app.use('/keys', bodyParserErrorHandler);
app.use('/bags', bodyParserErrorHandler);
// Тело в 64 КБ с content-type: application/json приезжает в маршруты ящика
// тем же путём, что и в /bags: без этой строки переполнение отдало бы
// HTML-страницу дефолтного обработчика express вместо {error, code}.
app.use('/disputes', bodyParserErrorHandler);

// ─── Push notification endpoints ──────────────────────────────────────────────

app.get('/push/vapid-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// POST /push/subscribe — requires ownership proof.
// Client signs: "hexseal:push-subscribe:<address>:<endpoint>"
app.post('/push/subscribe', async (req, res) => {
  try {
    const { address, subscription, sig } = req.body || {};
    if (!address || !subscription?.endpoint) {
      return res.status(400).json({ error: 'address and subscription required' });
    }
    if (!sig) return res.status(401).json({ error: 'Missing sig — sign hexseal:push-subscribe:<address>:<endpoint>' });

    const addr = address.toLowerCase();
    const message  = `hexseal:push-subscribe:${addr}:${subscription.endpoint}`;
    let recovered;
    try { recovered = ethers.verifyMessage(message, sig).toLowerCase(); }
    catch { return res.status(400).json({ error: 'Invalid signature' }); }

    if (recovered !== addr) return res.status(403).json({ error: 'Signature mismatch' });

    if (!isKnownPushServiceEndpoint(subscription.endpoint)) {
      return res.status(400).json({ error: 'Unrecognized push service endpoint' });
    }

    const existing = _pushSubs.get(addr) ?? [];
    if (!existing.some(s => s.endpoint === subscription.endpoint)) {
      _pushSubs.set(addr, [...existing, subscription]);
      savePushSubs();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /push/unsubscribe — requires ownership proof, mirroring /push/subscribe.
// Client signs: "hexseal:push-unsubscribe:<address>:<endpoint>"
app.post('/push/unsubscribe', async (req, res) => {
  try {
    const { address, endpoint, sig } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });
    if (!sig) return res.status(401).json({ error: 'Missing sig — sign hexseal:push-unsubscribe:<address>:<endpoint>' });

    const key = address.toLowerCase();
    const message = `hexseal:push-unsubscribe:${key}:${endpoint || 'all'}`;
    let recovered;
    try { recovered = ethers.verifyMessage(message, sig).toLowerCase(); }
    catch { return res.status(400).json({ error: 'Invalid signature' }); }
    if (recovered !== key) return res.status(403).json({ error: 'Signature mismatch' });

    if (endpoint) {
      _pushSubs.set(key, (_pushSubs.get(key) ?? []).filter(s => s.endpoint !== endpoint));
    } else {
      _pushSubs.delete(key);
    }
    savePushSubs();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PUSH_SECRET = process.env.PUSH_SECRET ?? '';

// Resolve a display name for a wallet address: profile displayName → short address.
// Only called when the request has been authenticated via X-Push-Secret.
function resolveDisplayName(addr) {
  if (!addr || !ethers.isAddress(addr)) return null;
  try {
    const profilePath = path.join(DIR_PUBLIC, `profile-${addr.toLowerCase()}.json`);
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      if (profile?.displayName?.trim()) return profile.displayName.trim();
    }
  } catch {}
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─── К-2: чем доказывается право послать уведомление ─────────────────────
//
// `X-Push-Secret` доказывает «пришло с нашего сервера» — и НИЧЕГО БОЛЬШЕ.
// Наш собственный `/api/push` подставлял его сам, никого ни о чём не
// спрашивая, так что посторонний без кошелька и без подписи слал настоящее
// уведомление от Hexseal любому адресу — с текстом и, что хуже, СО ССЫЛКОЙ
// по своему выбору. Служебный работник уводил по ней открытую вкладку
// (замер — test/pushSenderProof.test.js и frontend/src/lib/
// swNotificationTarget.test.ts).
//
// Теперь право доказывается ТЕМ ЖЕ пропуском, что и склад мешков: один
// способ на две двери, а не второй, изобретённый рядом. Секрет остался —
// он отвечает на другой вопрос («из интернета или изнутри»), и снимать его
// незачем.
//
// ⚠️ ССЫЛКА, ТЕКСТ, МЕТКА И ЗАГОЛОВОК ИЗ ЗАПРОСА НЕ БЕРУТСЯ ВООБЩЕ. Не
// «проверяются», не «санируются» — не берутся. Их строит сервер из
// доказанного отправителя. Проверять пришедшую ссылку по списку разрешённых
// форм означало бы держать этот список верным вечно; не брать её вовсе
// нечему протухнуть.
//
// Родов ровно два, и оба ведут на НАШ экран:
//   chat    — «вам написали»: /chat?peer=<отправитель из пропуска>
//   dispute — «открыт спор» арбитрам: /arbiter?deal=<проверенный адрес>
//
// Заголовок и текст — постоянные. Имя отправителя НЕ подставляется, хотя
// теперь оно доказано и подставить было бы можно: экран чата обещает, что
// в шторке ОС видно «пришло сообщение» и не видно, от кого и о чём
// (usePairChat.ts, PUSH_BODY). Доказанность отправителя — не повод нарушить
// это обещание.
// ─── К-3: чей бюджет тратит уведомление ──────────────────────────────────
//
// Здесь стоял `checkRateLimit(clientIp(req))` — бюджет по адресу ИСТОЧНИКА
// ЗАПРОСА. А источник тут всегда один: наш собственный Next-сервер, потому
// что гейт `X-Push-Secret` другого вызывающего не пускает вовсе. Значит ключ
// у всей площадки был один, а потолок — общий десяток (RATE_MAX), который
// вообще-то рассчитан на одного человека у /relay.
//
// Замерено на БОЕВЫХ умолчаниях (test/pushBudgetLiveDefaults.test.js),
// без единого переопределения:
//   40 сообщений одной пары                     → 30 отказов
//   веер по спору на 50 арбитров                → 50 отказов (о споре не
//                                                 узнавал НИ ОДИН арбитр)
//   200 подряд от одного, затем посторонний     → посторонний 429
//
// TRUST_PROXY этого не лечит и не при чём: сервер-серверный запрос
// заголовков источника не шлёт, адрес проваливается в адрес контейнера. Это
// НЕ экземпляр уже признанного хвоста 28.1.
//
// Считаем по тому, ЗА КОГО шлём — по адресу из пропуска. Тогда исчерпавший
// бюджет мешает только себе, и «долбят нарочно» болит нападающему, а не
// соседу.
//
// Почему НЕ по получателю: бюджет получателя означал бы, что чужой человек
// выключает уведомления жертве, потратив их за неё. Больно должно быть тому,
// кто шлёт.
//
// Два разных бюджета, а не один: полный веер по спору (ARBITER_FANOUT_CAP=50
// в frontend/src/lib/webpush.ts) — это 50 запросов подряд от одного адреса.
// В общем бюджете он съедал бы переписку того же человека целиком, и цена
// открытия спора была бы «минута без уведомлений в чате».
const PUSH_SEND_RATE_MAX    = readPositiveInt('PUSH_SEND_RATE_MAX',    60);
// Бюджет веера по спору ключуется СДЕЛКОЙ, не отправителем (см. ниже, у
// dealIsDisputed): у этой дороги отправителя нет вовсе. 120 — два полных
// веера на 50 арбитров в минуту.
const PUSH_DISPUTE_RATE_MAX = readPositiveInt('PUSH_DISPUTE_RATE_MAX', 120);

// ─── Блокер сквозной проверки: чем доказывается право звать арбитров ─────
//
// ЧТО Я СЛОМАЛ СВОЕЙ ЖЕ ПРАВКОЙ. Веер по спору я посадил за пропуск склада
// вместе с уведомлениями чата. Для чата это верно — там отправитель по
// определению участник переписки. Для СПОРА неверно, и цена не «неудобно»:
// спор открывает человек, который мог не заходить в чат ни разу, пропуска у
// него нет, запрос не уходит, и арбитры о споре НЕ УЗНАЮТ. Молча. Замер —
// test/pushDisputeChainProof.test.js: 401 и ноль отправленных.
//
// Правильное доказательство для этой дороги — не «кто ты», а «спор
// действительно есть». Оно лежит в цепи и не зависит от того, пользуется ли
// человек чатом.
//
// Почему этого ДОСТАТОЧНО, а не «дыра поменьше»: единственное, чего добьётся
// посторонний, дёргая эту дорогу, — арбитры узнают о НАСТОЯЩЕМ споре, то
// есть ровно то, что и должно произойти. Текст постоянный, ссылка ведёт на
// наш экран арбитра, метка одна на сделку (повторы ЗАМЕЩАЮТ друг друга в
// шторке, а не копятся). Исчерпать бюджет сделки можно только реально
// разослав эти уведомления — «злоупотребление» и «желаемое поведение» тут
// буквально одно действие.
//
// Кэш нужен не для скорости, а чтобы веер на 50 арбитров стоил ОДНО чтение
// цепи, а не пятьдесят: пятьдесят чтений на каждый спор — это сам по себе
// способ выжечь наш узел.
const DISPUTE_PROOF_TTL_MS = Number(process.env.DISPUTE_PROOF_TTL_MS || 60_000);
const DISPUTE_PROOF_MAX_ENTRIES = 500;
const _disputeProof = new Map();   // deal → { disputed, at }

// ─── Усиление обращений к узлу: замер, а не рассуждение ──────────────────
//
// Кэш выше держит ОТВЕТ («спор есть» / «спора нет»), и только его. Неудачное
// чтение ответом не становится и в кэш не попадает — намеренно: «узел
// молчит» и «по адресу нет агримента» неразличимы, и, закэшировав молчание
// узла, мы на весь TTL закрыли бы дорогу настоящему спору.
//
// ⚠️ ЦЕНА ЭТОГО РЕШЕНИЯ ЗАМЕРЕНА (test/disputeProofChainLoad.test.js), и она
// оказалась ровно такой, как предположил координатор:
//
//   50 РАЗНЫХ выдуманных адресов        → 50 обращений к узлу   (1:1)
//   ОДИН выдуманный адрес ×50           → 50 обращений          (кэша нет)
//   настоящий неспорный адрес ×50       → 1  обращение          (кэш работает)
//   400 запросов разными адресами       → 400 обращений         (без границы)
//
// По выдуманному адресу вызов агримента ревертит — то есть попадает в ветку
// неудачи, мимо кэша. А бюджет ключевался СДЕЛКОЙ, и у выдуманных адресов
// ключи всегда новые, поэтому он не срабатывал НИ РАЗУ. Единственной
// границей был потолок Next-прокси (120/мин с источника), а он снимается
// набором источников.
//
// Границы теперь две, и ни одна из них не кэширует неудачу как ответ:
//
// 1. ОБЩИЙ потолок обращений к цепи по этой дороге — один на всех. Законная
//    нагрузка тут крошечная: спор — событие штучное, а веер на 50 арбитров
//    стоит ОДНОГО чтения (дальше отвечает кэш). Поэтому щедрый общий потолок
//    не режет ничего живого, но ограничивает расход независимо от того,
//    сколько РАЗНЫХ адресов спросили.
//
//    Да, общий потолок — это форма того самого «один на всю площадку», за
//    который я чинил К-3. Разница в том, ЧТО он ограничивает: там это был
//    бюджет полезного действия (уведомления людям), здесь — бюджет ЗАПРОСОВ К
//    ЧУЖОМУ УЗЛУ, у которого и так один общий кран на всех. Ограничивать
//    общий ресурс общим потолком — не та же ошибка.
//
// 2. Придержка ПО АДРЕСУ, который только что не прочитался. Это не кэш
//    ответа: ответа мы не запоминаем и на следующем запросе снова пойдём в
//    цепь — просто не чаще, чем раз в DISPUTE_RETRY_COOLDOWN_MS. Настоящая
//    сделка, чтение которой сорвалось из-за узла, повторится через несколько
//    секунд, а не будет закрыта на минуту.
const DISPUTE_PROOF_CHAIN_MAX  = readPositiveInt('DISPUTE_PROOF_CHAIN_MAX', 120);
const DISPUTE_RETRY_COOLDOWN_MS = readPositiveInt('DISPUTE_RETRY_COOLDOWN_MS', 10_000);
const _disputeReadFailedAt = new Map();   // deal → момент последней неудачи

function disputeChainRateKey() { return 'dispute-proof-chain'; }

// Запасная дорога на случай исчерпанного потолка: список ВСЕХ спорных сделок
// разом. Одно обращение отвечает про любое число адресов, поэтому поток
// мусора её не выест — но и свежесть у неё хуже, чем у чтения одной сделки
// (спор, поднятый секунду назад, попадёт в список на следующем обновлении).
// Отсюда короткий срок годности: 15 секунд, а не минута.
const DISPUTE_SET_TTL_MS = readPositiveInt('DISPUTE_SET_TTL_MS', 15_000);
let _disputedSet = { addresses: null, at: 0 };

/** `Set` адресов спорных сделок, или `null` — если и это прочитать не вышло. */
async function disputedSetSnapshot() {
  const now = Date.now();
  if (_disputedSet.addresses && now - _disputedSet.at < DISPUTE_SET_TTL_MS) {
    return _disputedSet.addresses;
  }
  // fetchDisputedRecords() уже есть в этом файле (ею живёт ночная чистка) и
  // сама глушит отказ, возвращая пустой массив. Пустой массив здесь принять
  // за «спорных нет» нельзя — это ровно та ошибка «не знаем значит нет»,
  // которую в чистке уже чинили. Поэтому читаем реестр здесь напрямую и
  // отличаем отказ от пустоты.
  try {
    const registry = new ethers.Contract(DIAMOND_ADDR, REGISTRY_MINI_ABI, provider);
    const records = await registry.getDisputed();
    const addresses = new Set(
      (records ?? []).map(r => String(r.agreement ?? r[0] ?? '').toLowerCase()).filter(Boolean),
    );
    _disputedSet = { addresses, at: now };
    return addresses;
  } catch (e) {
    console.error('[push] dispute proof: registry fallback failed -', e.message);
    return null;
  }
}

/** Только для тестов. */
export function _resetDisputedSetCache() { _disputedSet = { addresses: null, at: 0 }; }

// ⚠️ ЕДИНСТВЕННАЯ КОПИЯ ЭТОГО ЧИСЛА В РЕЛЕЕРЕ, и она заперта на исходник
// контракта: `test/agreementStatusEnum.test.js` читает `src/Agreement.sol` и
// берёт ПОЗИЦИЮ члена в `enum Status`. Экспортируется ради этого замка —
// иначе сверять было бы нечего, а прежняя проверка на фронте сверяла
// константу саму с собой (итоговое ревью ветки 4в-2, правка 2).
// Близнец на фронте — `frontend/src/lib/agreementStatus.ts`, у него свой
// такой же замок: общего кода у двух рантаймов быть не может.
export const AGREEMENT_STATUS_DISPUTED = 4;   // src/Agreement.sol, enum Status

/**
 * Правда ли, что по `deal` открыт спор.
 *
 * `true` / `false` — вердикт цепи; `null` — вердикта НЕТ.
 *
 * Третий исход обязан отличаться от второго ровно по той же причине, что и у
 * подписи контрактного кошелька: «спора нет» и «мы не смогли посмотреть» —
 * разные вещи, и молчаливо считать второе первым значит терять оповещение
 * о настоящем споре при первом же чихе узла.
 *
 * ⚠️ ЧТО ИМЕННО КЭШИРУЕТСЯ (докстринг раньше обещал больше, чем делал).
 * Кэшируется ТОЛЬКО вердикт — «есть» и «нет». Неудача не кэшируется никогда:
 * ни как «нет», ни как «есть». Вместо этого у адреса, чтение которого
 * сорвалось, заводится ПРИДЕРЖКА: следующий поход в цепь по нему возможен, но
 * не раньше чем через DISPUTE_RETRY_COOLDOWN_MS. Это не ответ и не память об
 * ответе — это только частота повторов.
 *
 * `null` возвращается в трёх случаях, и вызывающий не обязан их различать:
 * чтение сорвалось; по адресу недавно уже срывалось (придержка); общий
 * потолок обращений к цепи на эту минуту исчерпан.
 */
async function dealIsDisputed(deal) {
  const key = deal.toLowerCase();
  const now = Date.now();

  const hit = _disputeProof.get(key);
  if (hit && now - hit.at < DISPUTE_PROOF_TTL_MS) return hit.disputed;

  // Придержка по адресу, который только что не прочитался. Замер до неё:
  // один выдуманный адрес ×50 стоил 50 обращений к узлу.
  const failedAt = _disputeReadFailedAt.get(key);
  if (failedAt !== undefined && now - failedAt < DISPUTE_RETRY_COOLDOWN_MS) return null;

  // Общий потолок — один на всех. Он тратится ТОЛЬКО когда мы собираемся
  // реально пойти в цепь: ответ из кэша и отказ по придержке (обе ветки выше)
  // ничего не стоят, поэтому веер на 50 арбитров по уже проверенному спору
  // расходует ровно единицу, а не пятьдесят.
  if (!checkRateLimit(disputeChainRateKey(), DISPUTE_PROOF_CHAIN_MAX)) {
    console.warn('[push] dispute proof: global chain-read budget exhausted for', key, '- falling back to the registry set');
    // ⚠️ БЕЗ ЭТОЙ ВЕТКИ ПОТОЛОК БЫЛ БЫ ПОЧИНКОЙ ХУЖЕ ДЕФЕКТА, и это замерено,
    // а не предположено: с одним лишь потолком веер на 50 арбитров по
    // НАСТОЯЩЕМУ спору, поданный после мусорного потока, доставлял 0 из 50.
    // То есть нападающий выключал арбитраж целиком — ровно то молчание, ради
    // которого чинился блокер.
    //
    // Запасная дорога спрашивает не про ОДНУ сделку, а сразу про ВСЕ спорные
    // (реестр, `getDisputed()` — та же функция, которой пользуется ночная
    // чистка, второго способа не заводим). Стоит она одного обращения на
    // весь список, поэтому её собственный запас поток мусора выесть не может:
    // сколько бы разных адресов ни спросили, список читается не чаще раза в
    // DISPUTE_SET_TTL_MS.
    //
    // Зовём её ТОЛЬКО когда основной потолок исчерпан, то есть фактически
    // только под нападением: в обычный день это ноль лишних обращений.
    // `getDisputed()` дважды проходит по истории ВСЕХ когда-либо созданных
    // сделок (RegistryFacet.sol) — вызов не из дешёвых, и звать его на каждый
    // запрос было бы заменой одного усиления другим.
    const set = await disputedSetSnapshot();
    if (set) return set.has(key);
    return null;
  }

  let disputed;
  try {
    const agr = new ethers.Contract(deal, AGREEMENT_MINI_ABI, provider);
    const details = await agr.getDetails();
    disputed = Number(details.status_) === AGREEMENT_STATUS_DISPUTED;
  } catch (e) {
    // Сюда попадает и «узел молчит», и «по этому адресу нет агримента»
    // (вызов ревертит). Разделить их нечем, и обе — «вердикта нет»:
    // уведомление не уходит, но и «спора нет» мы не утверждаем.
    console.error('[push] dispute proof read failed for', key, '-', e.message);
    if (_disputeReadFailedAt.size >= DISPUTE_PROOF_MAX_ENTRIES) {
      const oldest = [..._disputeReadFailedAt.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) _disputeReadFailedAt.delete(oldest[0]);
    }
    _disputeReadFailedAt.set(key, now);
    return null;
  }

  // Чтение удалось — прежняя неудача по этому адресу больше не актуальна.
  _disputeReadFailedAt.delete(key);

  // Отрицательный ответ кэшируется наравне с положительным: иначе поток
  // запросов по неспорной сделке жёг бы узел на каждом.
  if (_disputeProof.size >= DISPUTE_PROOF_MAX_ENTRIES) {
    // Простейшее вытеснение — самая старая запись. Карта нужна маленькой:
    // одновременно спорных сделок на площадке единицы, а пятьсот — это уже
    // след нападения, а не работы.
    const oldest = [..._disputeProof.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _disputeProof.delete(oldest[0]);
  }
  _disputeProof.set(key, { disputed, at: now });
  return disputed;
}

/** Только для тестов: забыть доказательства между кейсами. */
export function _resetDisputeProofCache() { _disputeProof.clear(); _disputeReadFailedAt.clear(); }

// Префикс `push-`, как `ip:`/`bag-`/`chain:` выше: ключ одного бюджета не
// может совпасть с ключом другого по форме, а не по вере в заголовки.
function pushSendRateKey(kind, address) { return `push-${kind}:${address}`; }

const PUSH_KINDS = {
  chat: (sender) => ({
    title: 'New message',
    body:  'New message',
    url:   `/chat?peer=${sender}`,
  }),
  dispute: (_sender, { deal }) => ({
    title: 'A dispute was opened',
    body:  'A dispute is waiting for an arbiter.',
    url:   `/arbiter?deal=${deal}`,
  }),
};

app.post('/push/send', async (req, res) => {
  try {
    // Первый гейт — «изнутри, не из интернета». Он НЕ про то, кто человек.
    if (!PUSH_SECRET || req.headers['x-push-secret'] !== PUSH_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // Бюджета по IP здесь БОЛЬШЕ НЕТ — см. длинный разбор у
    // PUSH_SEND_RATE_MAX. Он был не строгостью, а неисправностью: ключ у всей
    // площадки один. Ограничитель переехал ниже, за проверку пропуска, где
    // впервые известно, ЗА КОГО шлём.

    const { to, kind = 'chat', deal } = req.body || {};
    if (!to || !ethers.isAddress(to)) {
      return res.status(400).json({ error: 'Invalid address', code: 'invalid_address' });
    }
    const build = Object.prototype.hasOwnProperty.call(PUSH_KINDS, kind) ? PUSH_KINDS[kind] : null;
    if (!build) {
      // 400, а не тихая подстановка чата: неизвестный род — это рассинхрон
      // фронта и сервера, и молча слать «вам написали» вместо того, что
      // просили, значит врать человеку о причине уведомления.
      return res.status(400).json({ error: 'Unknown notification kind', code: 'unknown_kind' });
    }
    const recipient = to.toLowerCase();

    // ── Веер по спору: доказывает ЦЕПЬ, а не человек ────────────────────
    //
    // Пропуска здесь нет и не требуется — иначе спор, открытый человеком без
    // сеанса чата, не доехал бы до арбитров вообще (блокер сквозной
    // проверки, разбор у dealIsDisputed выше).
    if (kind === 'dispute') {
      if (typeof deal !== 'string' || !ETH_ADDR_RE.test(deal.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid deal address', code: 'invalid_deal' });
      }
      const dealLc = deal.toLowerCase();

      // Бюджет — ПЕРЕД чтением цепи: он ограничивает именно чтения. Ключ —
      // сделка: отправителя у этой дороги нет, а исчерпать бюджет сделки
      // можно только реально разослав по ней уведомления.
      if (!checkRateLimit(pushSendRateKey('dispute', dealLc), PUSH_DISPUTE_RATE_MAX)) {
        return res.status(429).set('Retry-After', '60')
          .json({ error: 'Rate limit exceeded', code: 'rate_limited_push' });
      }

      const disputed = await dealIsDisputed(dealLc);
      if (disputed === null) {
        // Не «спора нет», а «не смогли посмотреть». Разные ответы, потому
        // что молчание здесь означает зависший спор.
        return res.status(503).set('Retry-After', '5')
          .json({ error: 'Could not verify the dispute on-chain right now', code: 'chain_unavailable' });
      }
      if (!disputed) {
        return res.status(403).json({ error: 'No open dispute for this deal', code: 'not_disputed' });
      }

      const payload = build(null, { deal: dealLc });
      await sendPush(recipient, { ...payload, tag: payload.url });
      return res.json({ ok: true });
    }

    // ── Переписка: доказывает пропуск ───────────────────────────────────
    const sender = requireBagPass(req, res);
    if (!sender) return;

    // Эхо собственной отправки: чат зовёт нас на КАЖДОЕ отправленное
    // сообщение, и разговор с самим собой (или ошибка на стороне вызывающего)
    // не должен превращаться в уведомление себе же. Не ошибка — просто нечего
    // делать.
    if (recipient === sender) return res.json({ ok: true, skipped: 'self' });

    // Списывается ПОСЛЕДНИМ — после всех отказов по форме запроса. Иначе
    // двадцать запросов с опечаткой в роде стоили бы человеку его же
    // переписки, ничего никому не отправив.
    if (!checkRateLimit(pushSendRateKey('chat', sender), PUSH_SEND_RATE_MAX)) {
      return res.status(429).set('Retry-After', '60')
        .json({ error: 'Rate limit exceeded', code: 'rate_limited_push' });
    }

    const payload = build(sender, {});
    await sendPush(recipient, { ...payload, tag: payload.url });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Called server-to-server by the Next.js /api/relay after a meta-transaction confirms.
// pushAfterRelay + the push-subscription store live here, so the Next route just hands us
// the tx hash + the target it acted on, and we send the deal-lifecycle OS notifications
// (Funded / Activated / Work Submitted / Complete / Refunded / Dispute). Trusted by
// PUSH_SECRET only. Historically /api/relay never called this, so on-chain OS pushes
// never fired — only in-app (event-watching) notifications did, and only while the app
// was open. This closes that gap.
// ─── Receipt polling for /relay/notify ────────────────────────────────────────
//
// The caller (frontend/src/app/api/relay/route.ts) has ALREADY waited for this
// receipt on ITS connection before calling us. We then look the same tx up on
// OURS — a different URL (RPC_URL || BASE_SEPOLIA_RPC_URL || the free public
// node), and even when it is the same URL a load-balanced endpoint like
// drpc.live fans out over several node providers with independent lag. So the
// block the frontend has already seen may not have reached the replica that
// answers us, and getTransactionReceipt() returns `null` — not an error, just
// nothing. A single attempt therefore drops the push silently, which is how the
// deal-lifecycle OS notifications went missing with no trace anywhere.
//
// Same disease and same cure as the read-after-write guard on the USDC
// allowance in route.ts: poll until the fact is visible instead of assuming one
// read is authoritative.
//
// Ceiling: a Base Sepolia block is 2 s and the replica lag we have actually
// measured on this stack is 2–6 s, so 24 × 500 ms ≈ 11.5 s gives roughly 2× the
// worst observed lag. The step is a quarter of a block — fine enough that we
// notice the replica catching up almost immediately, coarse enough that a full
// exhaustion is 24 RPC calls, not hundreds.
//
// Mutable on purpose: the tests shrink `stepMs` so exhausting the poll takes
// milliseconds instead of eleven seconds, while still exercising the real
// attempt count.
export const RECEIPT_POLL = { attempts: 24, stepMs: 500 };

/**
 * Reads the receipt for `txHash`, retrying while the RPC replica has not caught
 * up. Resolves to the receipt, or to `null` once the attempts are spent — the
 * caller MUST say something about `null`, never swallow it.
 */
export async function waitForReceipt(txHash) {
  const { attempts, stepMs } = RECEIPT_POLL;
  for (let i = 0; i < attempts; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, stepMs));
  }
  return null;
}

app.post('/relay/notify', (req, res) => {
  if (!PUSH_SECRET || req.headers['x-push-secret'] !== PUSH_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { txHash, agreement, calldata } = req.body || {};
  if (!txHash || !agreement) return res.status(400).json({ error: 'txHash and agreement required' });
  // Ack immediately so the caller's relay response isn't delayed; fetch the receipt and
  // fan out the pushes in the background. Best-effort — a push must never block a tx.
  res.json({ ok: true });
  (async () => {
    try {
      const receipt = await waitForReceipt(txHash);
      if (receipt) {
        await pushAfterRelay(receipt, agreement, calldata);
        return;
      }
      // Giving up is a REPORTABLE outcome, not a no-op. Without this line the
      // only symptom of a dropped notification was a user who never heard about
      // his own deal, and nothing on the server said so. The txHash is in the
      // message so the tx can be looked up on the explorer and the pushes
      // reconstructed by hand.
      console.error(
        `[push] relay/notify: no receipt for ${txHash} after ${RECEIPT_POLL.attempts} attempts ` +
        `(~${Math.round((RECEIPT_POLL.attempts - 1) * RECEIPT_POLL.stepMs / 1000)}s) — ` +
        `pushes dropped for agreement ${agreement}`,
      );
    } catch (e) {
      console.error(`[push] relay/notify failed for ${txHash}:`, e.message);
    }
  })();
});

// ─── Dispute Reasons ──────────────────────────────────────────────────────────

const DISPUTE_REASONS_FILE = path.join(STORAGE_DIR, 'dispute-reasons.json');
let _disputeReasons = (() => {
  try { return existsSync(DISPUTE_REASONS_FILE) ? JSON.parse(readFileSync(DISPUTE_REASONS_FILE, 'utf8')) : {}; } catch { return {}; }
})();
function _saveDisputeReasons() {
  try { writeFileSync(DISPUTE_REASONS_FILE, JSON.stringify(_disputeReasons), 'utf8'); } catch {}
}

// ─── File → pair manifest (protects evidence from TTL cleanup mid-dispute) ────
// Chat files carry no association to a deal on their own — chats are one MLS
// group per client/executor pair, not per deal (findOrCreatePairGroup). Tagging
// a file with its pairId lets the nightly cleanup job (see below) check whether
// that pair currently has a disputed agreement before deleting an expired file.

const FILE_PAIRS_FILE = path.join(STORAGE_DIR, 'file-pairs.json');
let _filePairs = (() => {
  try { return existsSync(FILE_PAIRS_FILE) ? JSON.parse(readFileSync(FILE_PAIRS_FILE, 'utf8')) : {}; } catch { return {}; }
})();
function _saveFilePairs() {
  try { writeFileSync(FILE_PAIRS_FILE, JSON.stringify(_filePairs), 'utf8'); } catch {}
}

// В-3 (аудит устойчивости, 6 августа): у записи описи вложений появился
// срок, усыновлённый сделкой — тот же, что уже получает мешок.
//
// Форма записи расширена СОВМЕСТИМО: было `key -> "<pairId>"` (строка),
// стало `key -> { p: "<pairId>", d: <срок|null> }`. Старые строковые записи
// читаются как есть и живут дальше — file-pairs.json на боевом сервере уже
// непустой, а миграция «на старте переписать весь файл» — ровно тот класс
// действий, который в этом проекте уже ломал живое хранилище. Запись
// обновляется до новой формы естественным путём: при первом усыновлении.
function filePairIdOf(key) {
  const rec = _filePairs[key];
  if (typeof rec === 'string') return rec;          // старая форма
  return rec && typeof rec === 'object' ? rec.p : undefined;
}

function fileDealDeadlineOf(key) {
  const rec = _filePairs[key];
  return rec && typeof rec === 'object' && typeof rec.d === 'number' ? rec.d : null;
}

// Усыновление вложений пары — зеркало adoptPairBags() для файлов.
// Вызывается из тех же двух мест и с теми же числами, что усыновление
// мешков, чтобы текст и вложение НИКОГДА не расходились в сроке: расхождение
// и есть тот дефект, ради которого всё это заведено.
//
// Потолок — тот же 90-дневный MAX_PROTECTED_AGE_MS, что уже держит защиту по
// спору, и та же оговорка про оплату, что у мешков: к ОПЛАЧЕННОЙ сделке
// потолок не применяется (деньги в эскроу — хранение оплачено чужим
// капиталом), к неоплаченной применяется. Решается на КАЖДОЕ продление
// отдельно, по статусу именно той сделки, что его выдаёт — не свойство файла
// навсегда (C1 из отчёта Задачи 5, тот же урок).
//
// Отсчёт потолка — от mtime файла: у вложения нет uploadedAt, его «возраст»
// это и есть mtime, по которому уже считает вся остальная чистка.
// Math.max с уже сохранённым — усыновление ПРОДЛЕВАЕТ и никогда не
// обрезает, ровно как у мешков.
function adoptPairFiles(pairId, dealDeadline, nowMs, funded) {
  let adopted = 0;
  for (const key of Object.keys(_filePairs)) {
    if (filePairIdOf(key) !== pairId) continue;
    let mtimeMs;
    try { mtimeMs = fs.statSync(path.join(DIR_FILES, key)).mtimeMs; } catch { continue; }
    const ceiling = mtimeMs + FILE_MAX_PROTECTED_AGE_MS;
    const candidate = funded ? dealDeadline : Math.min(dealDeadline, ceiling);
    const current = fileDealDeadlineOf(key) ?? 0;
    const next = Math.max(current, candidate);
    if (next === current) continue;
    _filePairs[key] = { p: pairId, d: next };
    adopted++;
  }
  if (adopted) _saveFilePairs();
  return adopted;
}

app.get('/dispute-reason', (req, res) => {
  const agreement = String(req.query.agreement || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/i.test(agreement)) return res.status(400).json({ error: 'Invalid agreement address' });
  res.json(_disputeReasons[agreement] ?? { reason: null });
});

// POST /dispute-reason — requires Ethereum signature from the raiser (client or executor).
// Message: "hexseal:dispute-reason:<agreement>:<ts>:<keccak256(reason)>"
// Timestamp must be within ±5 minutes. Signer must be client or executor of the agreement.
app.post('/dispute-reason', async (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded' });
  }

  const { agreement, reason, ts, sig } = req.body ?? {};
  if (!agreement || !/^0x[0-9a-f]{40}$/i.test(agreement)) return res.status(400).json({ error: 'Invalid agreement address' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason is required' });
  if (reason.length > 2000) return res.status(400).json({ error: 'Reason too long (max 2000 chars)' });
  if (!ts || !sig) return res.status(401).json({ error: 'Missing ts or sig' });

  // Replay protection: timestamp must be within ±5 minutes
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(ts)) > 300) {
    return res.status(401).json({ error: 'Timestamp out of window' });
  }

  try {
    // Recover signer from EIP-191 signed message
    const reasonHash = ethers.keccak256(ethers.toUtf8Bytes(reason.trim()));
    const message    = `hexseal:dispute-reason:${agreement.toLowerCase()}:${ts}:${reasonHash}`;
    const raiser     = ethers.verifyMessage(message, sig).toLowerCase();

    // Verify on-chain: signer must be client or executor of this agreement
    const agr        = new ethers.Contract(agreement, AGREEMENT_MINI_ABI, provider);
    const details    = await agr.getDetails();
    const onChainClient   = details.client_?.toLowerCase();
    const onChainExecutor = details.executor_?.toLowerCase();

    if (raiser !== onChainClient && raiser !== onChainExecutor) {
      return res.status(403).json({ error: 'Not a party to this agreement' });
    }

    _disputeReasons[agreement.toLowerCase()] = {
      agreement: agreement.toLowerCase(),
      raiser,
      reason: reason.trim(),
      timestamp: Date.now(),
    };
    _saveDisputeReasons();
    res.json({ ok: true });
  } catch (err) {
    console.error('[dispute-reason] error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Exports for the bootstrap entrypoint (index.js) and for tests ───────────

export const relayerInfo = {
  relayerAddress: relayer.address,
  forwarderAddr:  FORWARDER_ADDR,
  diamondAddr:    DIAMOND_ADDR,
  allowedOrigins: ALLOWED_ORIGINS,
  baseUrl:        BASE_URL,
  storageDir:     STORAGE_DIR,
  dirFiles:       DIR_FILES,
  dirPublic:      DIR_PUBLIC,
  // Каталог незавершённых многокусочных заливок — тестам нужно смотреть
  // на РЕАЛЬНЫЕ байты кусков, а не на то, что мы о них думаем.
  dirTemp:        DIR_TEMP,
  port:           PORT,
  // Задача 5, мелочь (таймаут RPC): provider — для проверки, что таймаут
  // реально дошёл до объекта, которым пользуется ethers
  // (provider._getConnection().timeout), не просто лежит неиспользуемой
  // переменной.
  provider:       provider,
  rpcTimeoutMs:   RPC_TIMEOUT_MS,
};

export { app };

// ─── Treasury keeper ──────────────────────────────────────────────────────────
//
// The treasury is pull-based by necessity: ERC-20 has no callback, so it cannot
// learn that a fee arrived. Nothing distributes itself — without something
// calling distribute(), fees just pile up on the contract and the arbiter vault
// is never funded. This is that something.
//
// Exported as a plain function, like runFileCleanup above: importing this module
// from a test must never schedule a real recurring job. index.js is the only
// place that wraps it in cron.schedule().
//
// Gas is paid by the relayer wallet. A full pass is three transactions at worst,
// a few hundred thousand gas each — on Base that is a rounding error against the
// fees it moves.

const TREASURY_ABI = [
  'function pendingDistribution() view returns (uint256)',
  'function vaultShortfall() view returns (uint256)',
  'function reserveBalance() view returns (uint256)',
  'function foundationOwed() view returns (uint256)',
  'function distribute()',
  'function topUpVault()',
  'function withdrawFoundation()',
  'event Distributed(uint256 toVault, uint256 toFoundation, uint256 toReserve)',
];

const DIAMOND_VAULT_ABI = ['function getVaultBalance() view returns (uint256)'];

// Built from the ABI rather than taken off the contract instance: parsing a
// receipt is a pure decode and has no business depending on which object the
// call happened to come back through.
const treasuryIface = new ethers.Interface(TREASURY_ABI);

// USDC has 6 decimals. These floors exist so the keeper never spends a
// transaction to move dust — fees trickle in continuously, and distributing
// three cents every hour costs more than it accomplishes.
const KEEPER_MIN_DISTRIBUTE = 1_000_000n;   // 1 USDC of undistributed income
const KEEPER_MIN_TOP_UP     = 1_000_000n;   // 1 USDC of vault shortfall
const KEEPER_MIN_WITHDRAW   = 10_000_000n;  // 10 USDC owed to the foundation

const usdc6 = (v) => `${(Number(v) / 1e6).toFixed(6)} USDC`;

export async function runTreasuryKeeper() {
  // Not deployed, or deployed but not yet wired in via setFeeRecipient. Staying
  // silent is correct: this is the normal state until someone decides to route
  // protocol income here, and a warning every hour would train people to ignore
  // the log.
  // Read at call time, not at import: the treasury does not exist yet, and an
  // operator who sets TREASURY_ADDRESS should not have to reason about whether
  // this module had already been imported when they did it.
  const treasuryAddr = process.env.TREASURY_ADDRESS;
  if (!treasuryAddr) return;

  const treasury = new ethers.Contract(treasuryAddr, TREASURY_ABI, relayer);
  const diamond  = new ethers.Contract(DIAMOND_ADDR, DIAMOND_VAULT_ABI, provider);

  // ── 1. Distribute income ────────────────────────────────────────────────────
  try {
    const pending = await treasury.pendingDistribution();
    if (pending >= KEEPER_MIN_DISTRIBUTE) {
      const vaultBefore = await diamond.getVaultBalance();

      const tx = await treasury.distribute();
      const receipt = await tx.wait();

      // The treasury deliberately has NO postcondition that the vault actually
      // credited what it received — one there would revert the whole waterfall
      // and let a broken facet freeze all income, which is the failure mode the
      // contract spends most of its design avoiding. The check lives here
      // instead: money left the treasury, so the vault must have grown by at
      // least as much. If it did not, a facet upgrade took the transfer without
      // recording it, and every subsequent pass will quietly feed the same hole.
      let toVault = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = treasuryIface.parseLog(log);
          if (parsed?.name === 'Distributed') toVault = parsed.args.toVault;
        } catch { /* not ours */ }
      }

      if (toVault > 0n) {
        const vaultAfter = await diamond.getVaultBalance();
        if (vaultAfter - vaultBefore < toVault) {
          console.error(
            `[keeper] ALARM: treasury sent ${usdc6(toVault)} to the vault but the vault ` +
            `only grew by ${usdc6(vaultAfter - vaultBefore)}. Money is leaving the treasury ` +
            `without being credited — stop the keeper and check fundVault on the diamond.`
          );
        }
      }

      console.log(`[keeper] distributed ${usdc6(pending)} (tx ${receipt.hash})`);
    }
  } catch (err) {
    console.warn('[keeper] distribute failed:', err.shortMessage || err.message);
  }

  // ── 2. Top the arbiter vault up from the reserve ────────────────────────────
  // Strictly after step 1, and not merely for tidiness: topUpVault() reverts
  // with DistributeFirst() while anything is undistributed. That gate exists
  // because otherwise the call ORDER decided who paid for the vault — calling
  // top-up first made the reserve pay, and up to 70% of that ended up as
  // foundation share instead. Distribute first, then let the reserve cover
  // whatever income could not.
  // Reading the state and acting on it are reported separately on purpose. Both
  // used to share one catch, so an RPC hiccup on the reads logged "topUpVault
  // failed" — which reads as "the chain refused the call" when in fact nothing
  // was ever attempted. Seen in the wild on the first live run.
  let topUpAmount = null;
  try {
    const [shortfall, reserve, pending] = await Promise.all([
      treasury.vaultShortfall(),
      treasury.reserveBalance(),
      treasury.pendingDistribution(),
    ]);
    if (shortfall >= KEEPER_MIN_TOP_UP && reserve > 0n && pending === 0n) {
      topUpAmount = shortfall < reserve ? shortfall : reserve;
    }
  } catch (err) {
    console.warn(
      '[keeper] could not read the treasury to decide on a vault top-up (nothing was attempted):',
      err.shortMessage || err.message
    );
  }

  if (topUpAmount !== null) {
    try {
      const tx = await treasury.topUpVault();
      const receipt = await tx.wait();
      console.log(
        `[keeper] topped the vault up by ${usdc6(topUpAmount)} from the reserve (tx ${receipt.hash})`
      );
    } catch (err) {
      console.warn('[keeper] topUpVault failed:', err.shortMessage || err.message);
    }
  }

  // ── 3. Push the foundation's accrued share out ──────────────────────────────
  // distribute() only accrues foundationOwed; the transfer is a separate call
  // so that a blacklisted or reverting foundation address cannot brick the
  // whole waterfall. Anyone may trigger it and the money can only ever go to
  // the immutable foundation address, so the keeper doing it is safe.
  try {
    const owed = await treasury.foundationOwed();
    if (owed >= KEEPER_MIN_WITHDRAW) {
      const tx = await treasury.withdrawFoundation();
      const receipt = await tx.wait();
      console.log(`[keeper] paid the foundation ${usdc6(owed)} (tx ${receipt.hash})`);
    }
  } catch (err) {
    console.warn('[keeper] withdrawFoundation failed:', err.shortMessage || err.message);
  }
}
