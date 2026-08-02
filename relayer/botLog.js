/**
 * botLog.js — как переписка пары попадает в журнал спора.
 *
 * ЧТО БЫЛО СЛОМАНО. Бот жил ТОЛЬКО на живом потоке: узнал о группе через
 * `conversations.stream()` → подписался на `group.stream()` → пишет то, что
 * приходит дальше. Историю он не читал нигде и никогда. Отсюда две дыры, и обе
 * молчаливые:
 *
 *  1. ПЕРВОЕ СООБЩЕНИЕ ПЕРЕПИСКИ. Группа создаётся и почти сразу получает
 *     первое сообщение — а бот в этот момент ещё только узнаёт о группе.
 *     Поток начинается «с этого момента», и бриф — обычно самое содержательное
 *     сообщение всей переписки — в журнал не попадал никогда.
 *  2. КАЖДЫЙ ПЕРЕЗАПУСК РЕЛЕЕРА. Всё, что написали, пока процесс поднимался,
 *     терялось насовсем.
 *
 * Почему это не косметика: журнал — доказательная база для решения о деньгах.
 * Арбитр читает его и решает, кому уходит эскроу. Дыры означают, что он судит
 * по неполной переписке И НЕ ЗНАЕТ ОБ ЭТОМ — журнал выглядит целым.
 *
 * ЧТО СТАЛО. При подхвате группы — и новой, и уже существующей после
 * перезапуска — бот сначала ДОЧИТЫВАЕТ историю, дописывает всё, чего в журнале
 * ещё нет, и только потом переходит на живой поток. Порядок в файле остаётся
 * хронологическим, потому что:
 *
 *   • подписка открывается ПЕРВОЙ, но её сообщения складываются в буфер, а не
 *     пишутся (иначе между концом дочитывания и началом подписки осталась бы
 *     ровно та же дыра, только уже);
 *   • затем пишется история;
 *   • затем буфер сливается через ту же воронку — дубли режет дедупликация;
 *   • дальше поток идёт напрямую.
 *
 * ГЛУБИНА ДОЧИТЫВАНИЯ. У переписки пары нет ограничения по возрасту, а тянуть
 * её целиком на каждом перезапуске — своя цена, и она растёт вместе с треду.
 * Поэтому глубина зависит от того, что уже есть в журнале:
 *
 *   • журнала для пары ещё нет → читаем историю ЦЕЛИКОМ (с потолком
 *     `HISTORY_MAX_PAGES × HISTORY_PAGE_SIZE`). Это бывает один раз за жизнь
 *     пары, и это единственный момент, когда полное чтение вообще возможно
 *     дёшево — тред только начался;
 *   • журнал есть → читаем всё, что новее последней записи, отступив назад на
 *     `CATCHUP_OVERLAP_MS`. Нижняя граница задана, верхней нет: если релеер
 *     лежал три часа, в окно попадут все три часа. Отступ нужен не для объёма,
 *     а против сообщений, доставленных с опозданием и вне порядка — перечитать
 *     их бесплатно, дедупликация всё равно не даст задвоить.
 *
 * То есть стоимость перезапуска привязана к длительности простоя, а не к
 * возрасту переписки. Тред двухлетней давности с молчащей парой перечитывается
 * ровно один раз.
 *
 * ДЕДУПЛИКАЦИЯ — ПО ИДЕНТИФИКАТОРУ СООБЩЕНИЯ. У сообщения XMTP есть свой `id`,
 * и опорой служит именно он, а не время и не текст: одинаковый текст в один и
 * тот же миллисекунд — это нормальная переписка, а не дубль. Записи журнала
 * теперь несут `id`.
 *
 * Отдельно — записи, сделанные СТАРЫМ кодом: у них `id` нет вовсе. Для них (и
 * только для них) держится вторая, слабая опора: счётчик отпечатков
 * `ts|from|text`. Без неё первое же дочитывание на живом сервере задвоило бы
 * весь накопленный журнал целиком. Отпечаток расходуется по одному разу, так
 * что два действительно одинаковых старых сообщения схлопнутся в одно — это
 * единственная неточность, и она уходит навсегда, как только пара напишет
 * что-нибудь новое.
 *
 * МАРКЕР `deal_ctx` — тоже сообщение, и при дочитывании он обязан отработать в
 * том же порядке, что и в живом потоке, иначе записи привяжутся не к той
 * сделке. Поэтому маркер разбирается ДО проверки на дубль (повторное
 * применение идемпотентно), а курсор при старте засевается `dealId` последней
 * записи журнала — это ровно то состояние, на котором журнал оборвался.
 *
 * Модуль намеренно не импортирует `@xmtp/node-sdk`: ему хватает структурных
 * типов группы (`name`, `id`, `sync`, `messages`, `members`, `stream`), зато
 * его можно проверить тестами без сети и без настоящего XMTP.
 */

import { PAIR_ID_RE, appendLogEntry, readLog } from './app.js';

/** Префикс имени парной группы. Совпадает с `PAIR_PREFIX` во фронтенде
 *  (`lib/xmtpPairGroup.ts`) — имя строит фронт, читает бот. */
export const PAIR_GROUP_PREFIX = 'HSEAL-PAIR-';

/** Сколько сообщений просим за один запрос истории. */
export const HISTORY_PAGE_SIZE = 100;

/** Потолок страниц на один подхват. 100 × 50 = 5000 сообщений — граница есть
 *  не потому, что переписка столько не наберёт, а потому что подхват не должен
 *  уметь висеть неограниченно долго. Упёрлись в потолок — пишем в консоль. */
export const HISTORY_MAX_PAGES = 50;

/** Насколько отступаем назад от последней записи журнала при дочитывании.
 *  Десять минут — с запасом перекрывают доставку с опозданием; перечитанное
 *  режется дедупликацией и в журнал не попадает. */
export const CATCHUP_OVERLAP_MS = 10 * 60 * 1000;

const NS_PER_MS = 1_000_000n;

/**
 * Достаёт `pairId` из имени группы. `null` — «это не парная группа Hexseal».
 */
export function pairIdFromGroupName(name) {
  if (typeof name !== 'string' || !name.startsWith(PAIR_GROUP_PREFIX)) return null;
  const pairId = name.slice(PAIR_GROUP_PREFIX.length).toLowerCase();
  return PAIR_ID_RE.test(pairId) ? pairId : null;
}

function fingerprintOf(ts, from, text) {
  return `${ts} ${from} ${text}`;
}

function sentAtMs(msg) {
  const d = msg?.sentAt;
  if (d && typeof d.getTime === 'function') {
    const t = d.getTime();
    if (Number.isFinite(t)) return t;
  }
  if (typeof msg?.sentAtNs === 'bigint') return Number(msg.sentAtNs / NS_PER_MS);
  return Date.now();
}

function sentAtNs(msg) {
  if (typeof msg?.sentAtNs === 'bigint') return msg.sentAtNs;
  return BigInt(Math.max(0, Math.floor(sentAtMs(msg)))) * NS_PER_MS;
}

/**
 * Воронка «сообщение → запись журнала» для одной пары.
 *
 * Держит три вещи: курсор `deal_ctx`, множество уже записанных `id` и счётчик
 * отпечатков старых записей без `id`. Одна и та же воронка обслуживает и
 * дочитанную историю, и живой поток — именно поэтому дубль между ними
 * невозможен в принципе, а не «маловероятен».
 */
export function createPairLogger(pairId, opts = {}) {
  const { append = appendLogEntry } = opts;
  // Нечитаемый журнал не должен мешать вести новый: без записей мы всего лишь
  // теряем дедупликацию и засев курсора, а вот отказ подхватить группу означал
  // бы, что переписка не пишется вообще.
  let existingEntries = opts.existingEntries;
  if (existingEntries === undefined) {
    try { existingEntries = readLog(pairId); } catch { existingEntries = []; }
  }

  const seenIds = new Set();
  const legacyFingerprints = new Map();
  let lastTs = null;
  let currentDealId = null;

  for (const e of existingEntries) {
    if (!e) continue;
    const id = typeof e.id === 'string' && e.id ? e.id : null;
    if (id) {
      seenIds.add(id);
    } else {
      const fp = fingerprintOf(e.ts, e.from, e.text);
      legacyFingerprints.set(fp, (legacyFingerprints.get(fp) ?? 0) + 1);
    }
    // Курсор сделки — из ПОСЛЕДНЕЙ по времени записи: каждая запись несёт тот
    // `dealId`, который был активен в момент её появления, значит последняя и
    // есть состояние курсора на момент обрыва журнала.
    if (typeof e.ts === 'number' && (lastTs === null || e.ts >= lastTs)) {
      lastTs = e.ts;
      currentDealId = typeof e.dealId === 'string' ? e.dealId : null;
    }
  }

  return {
    /** Время последней записи журнала (мс) или `null`, если журнала нет. */
    get lastTs() { return lastTs; },
    /** Текущий курсор `deal_ctx` — для тестов и диагностики. */
    get dealId() { return currentDealId; },

    /**
     * Пропускает одно сообщение через воронку.
     *
     * @param msg сообщение XMTP (нужны `content`, `id`, `sentAt`, `senderInboxId`)
     * @param resolveFrom (inboxId) => Promise<адрес> — разрешение отправителя,
     *        зовётся только когда сообщение действительно пойдёт в журнал
     * @returns 'logged' | 'duplicate' | 'marker' | 'skipped'
     */
    async consume(msg, resolveFrom) {
      if (typeof msg?.content !== 'string' || !msg.content) return 'skipped';

      // Маркер контекста сделки разбирается ДО дедупликации — он двигает
      // курсор и сам записью не становится. Повторное применение того же
      // маркера идемпотентно, поэтому перечитанное окно ничего не ломает.
      if (msg.content.startsWith('{')) {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed && parsed._type === 'deal_ctx') {
            currentDealId = typeof parsed.dealId === 'string' ? parsed.dealId.toLowerCase() : null;
            return 'marker';
          }
        } catch { /* не JSON — обычная запись, проваливаемся ниже */ }
      }

      const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
      if (id && seenIds.has(id)) return 'duplicate';

      const ts = sentAtMs(msg);
      const from = await resolveFrom(msg.senderInboxId);

      // Вторая опора — только для записей, сделанных до появления `id`.
      const fp = fingerprintOf(ts, from, msg.content);
      const legacyCount = legacyFingerprints.get(fp) ?? 0;
      if (legacyCount > 0) {
        legacyFingerprints.set(fp, legacyCount - 1);
        if (id) seenIds.add(id);
        return 'duplicate';
      }

      append(pairId, { ts, from, text: msg.content, dealId: currentDealId, id });
      if (id) seenIds.add(id);
      if (lastTs === null || ts > lastTs) lastTs = ts;
      return 'logged';
    },
  };
}

/**
 * Разрешение `senderInboxId` → адрес с кэшем на один подхват.
 *
 * Старый код звал `group.members()` НА КАЖДОЕ сообщение. На живом потоке это
 * незаметно, а при дочитывании тысячи сообщений превратилось бы в тысячу
 * запросов состава. Состав перечитывается только когда встретился незнакомый
 * inboxId (в группу кто-то вошёл), и не чаще одного раза подряд.
 */
export function createMemberResolver(group) {
  let map = null;
  let refreshing = null;

  async function load() {
    const members = await group.members();
    const next = new Map();
    for (const m of members ?? []) {
      const addr = m?.accountIdentifiers?.[0]?.identifier;
      if (m?.inboxId && addr) next.set(m.inboxId, addr.toLowerCase());
    }
    return next;
  }

  return async function resolveFrom(inboxId) {
    if (map === null) {
      try { map = await load(); } catch { map = new Map(); }
    }
    if (!map.has(inboxId)) {
      // Незнакомый отправитель — состав мог измениться. Одна попытка обновить,
      // не параллельная сама себе.
      if (!refreshing) refreshing = load().catch(() => null).finally(() => { refreshing = null; });
      const fresh = await refreshing;
      if (fresh) map = fresh;
    }
    // Не разрешилось — пишем inboxId. Он бесполезнее адреса, но это по-прежнему
    // устойчивый идентификатор отправителя: потерять сообщение хуже.
    return map.get(inboxId) ?? inboxId;
  };
}

/**
 * Читает историю группы страницами, старые первыми.
 *
 * @param sinceMs нижняя граница (мс) или `null` — «с самого начала»
 */
export async function readGroupHistory(group, opts = {}) {
  const {
    sinceMs = null,
    pageSize = HISTORY_PAGE_SIZE,
    maxPages = HISTORY_MAX_PAGES,
  } = opts;

  const out = [];
  let cursorNs = sinceMs === null ? null : BigInt(Math.max(0, Math.floor(sinceMs))) * NS_PER_MS;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const query = { limit: pageSize, direction: 0 /* SortDirection.Ascending */ };
    if (cursorNs !== null) query.sentAfterNs = cursorNs;

    const batch = await group.messages(query);
    if (!Array.isArray(batch) || batch.length === 0) break;

    // Сортируем сами: порядок внутри страницы нам никто не обещал, а журнал
    // обязан быть хронологическим.
    const sorted = [...batch].sort((a, b) => {
      const an = sentAtNs(a), bn = sentAtNs(b);
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    out.push(...sorted);

    if (batch.length < pageSize) break;

    const nextNs = sentAtNs(sorted[sorted.length - 1]);
    // Курсор не сдвинулся — вся страница в одну наносекунду. Дальше двигаться
    // нечем, и без этой проверки цикл крутил бы одну и ту же страницу.
    if (cursorNs !== null && nextNs <= cursorNs) break;
    cursorNs = nextNs;
    if (page === maxPages - 1) truncated = true;
  }

  return { messages: out, truncated };
}

/** Группы, за которыми уже следим, — по `id`. `conversations.stream()` умеет
 *  отдать группу, которая уже пришла из `listGroups()`; без этой карты на неё
 *  повесились бы два потока и два дочитывания. */
const _watched = new Map();

/** Только для тестов: забыть, за чем следим. */
export function resetWatchRegistry() {
  _watched.clear();
}

/**
 * Подхватывает парную группу: дочитывает историю, затем слушает поток.
 *
 * Возвращает промис, который резолвится ПОСЛЕ дочитывания и слива буфера —
 * дальше поток живёт сам. `null` — группа не парная, следить не за чем.
 *
 * Умерший поток снимает группу с учёта. Это третий случай той же болезни, что
 * и две в шапке файла: `group.stream()` умеет просто закончиться (сеть моргнула,
 * iterator завершился), и раньше это значило «эта переписка больше не пишется в
 * журнал, до перезапуска и молча». Снятие с учёта делает группу пригодной для
 * повторного подхвата — `rescanPairGroups()` подберёт её и дочитает всё, что
 * прошло мимо мёртвого потока.
 */
export function watchPairGroup(group, opts = {}) {
  const groupId = typeof group?.id === 'string' ? group.id : null;
  if (groupId && _watched.has(groupId)) return _watched.get(groupId);

  let release = () => {};
  const started = _watchPairGroup(group, { ...opts, onStreamClosed: () => release() });
  if (groupId) {
    _watched.set(groupId, started);
    // Присваивание — в том же синхронном такте, что и `set`: тело потока может
    // выполниться только в следующем микротаске, значит опередить постановку
    // на учёт снятие с учёта не может.
    release = () => { if (_watched.get(groupId) === started) _watched.delete(groupId); };
    started.then(
      (res) => { if (res === null) release(); },
      () => { release(); },
    );
  }
  return started;
}

/**
 * Пересматривает список групп и подхватывает всё, за чем ещё не следим.
 *
 * Зачем при живом `conversations.stream()`: приглашение в группу можно
 * пропустить (поток моргнул), а поток отдельной группы — потерять. И то и
 * другое молча превращает переписку в непишущуюся. Повторный проход —
 * единственное, что возвращает такую пару в журнал без перезапуска процесса;
 * стоит он один `sync()` и один `listGroups()`, а уже подхваченные группы
 * отсекает карта `_watched`.
 */
export async function rescanPairGroups(client, opts = {}) {
  const { logger: out = console } = opts;
  try {
    await client.conversations.sync();
    const groups = await client.conversations.listGroups();
    let picked = 0;
    for (const g of groups ?? []) {
      const groupId = typeof g?.id === 'string' ? g.id : null;
      if (groupId && _watched.has(groupId)) continue;
      if (!pairIdFromGroupName(g?.name ?? '')) continue;
      picked++;
      watchPairGroup(g, opts).catch(err => out.warn?.(`[bot] rescan watch failed: ${err.message}`));
    }
    if (picked > 0) out.log?.(`[bot] rescan picked up ${picked} unwatched pair group(s)`);
    return picked;
  } catch (err) {
    out.warn?.(`[bot] rescan failed: ${err.message}`);
    return 0;
  }
}

async function _watchPairGroup(group, opts = {}) {
  const {
    logger: out = console,
    pageSize = HISTORY_PAGE_SIZE,
    maxPages = HISTORY_MAX_PAGES,
    overlapMs = CATCHUP_OVERLAP_MS,
    onStreamClosed = () => {},
  } = opts;

  const pairId = pairIdFromGroupName(group?.name ?? '');
  if (!pairId) return null;

  const pairLog = createPairLogger(pairId, opts);
  const resolveFrom = createMemberResolver(group);

  // ── 1. Подписка ПЕРВОЙ, в буфер ────────────────────────────────────────────
  // Сначала подписка, потом история — иначе между концом дочитывания и началом
  // подписки осталась бы дыра ровно того же рода, что чиним.
  const pending = [];
  let buffering = true;
  let stream = null;
  try {
    stream = await group.stream();
  } catch (err) {
    // Поток не поднялся — дочитывание всё равно должно случиться. Старое
    // поведение в этом месте не писало вообще ничего.
    out.warn?.(`[bot] stream error for ${pairId}: ${err.message}`);
    onStreamClosed();
  }

  const consume = async (msg) => {
    try { await pairLog.consume(msg, resolveFrom); }
    catch (err) { out.warn?.(`[bot] log error for ${pairId}: ${err.message}`); }
  };

  if (stream) {
    // Намеренно без await: качает поток до конца жизни процесса.
    (async () => {
      try {
        for await (const msg of stream) {
          if (buffering) { pending.push(msg); continue; }
          await consume(msg);
        }
      } catch (err) {
        out.warn?.(`[bot] stream error for ${pairId}: ${err.message}`);
      } finally {
        // Поток кончился — эта переписка больше не пишется. Снимаем группу с
        // учёта, чтобы `rescanPairGroups()` подхватил её заново и дочитал всё,
        // что прошло мимо. Молчаливая потеря доказательств — ровно то, от чего
        // весь этот модуль.
        out.warn?.(`[bot] stream for ${pairId} closed — will be re-picked on the next rescan`);
        onStreamClosed();
      }
    })();
  }

  // ── 2. Дочитывание истории ─────────────────────────────────────────────────
  // Целиком в try/catch: пустая или порченая история не должна ронять подписку
  // — старое поведение (только поток) не хуже нового и обязано остаться.
  let caughtUp = 0;
  try {
    try { await group.sync(); } catch { /* локальная база и так что-то знает */ }

    const sinceMs = pairLog.lastTs === null ? null : Math.max(0, pairLog.lastTs - overlapMs);
    const { messages, truncated } = await readGroupHistory(group, { sinceMs, pageSize, maxPages });
    if (truncated) {
      out.warn?.(`[bot] history for ${pairId} hit the ${maxPages * pageSize}-message ceiling — older messages not backfilled`);
    }
    for (const msg of messages) {
      try {
        if (await pairLog.consume(msg, resolveFrom) === 'logged') caughtUp++;
      } catch (err) {
        out.warn?.(`[bot] log error for ${pairId}: ${err.message}`);
      }
    }
    if (caughtUp > 0) {
      out.log?.(`[bot] backfilled ${caughtUp} message(s) into the ${pairId} log`);
    }
  } catch (err) {
    out.warn?.(`[bot] history catch-up failed for ${pairId}: ${err.message}`);
  }

  // ── 3. Слив буфера, затем живой режим ──────────────────────────────────────
  // Условие цикла и снятие флага стоят в одном синхронном такте: между
  // «буфер пуст» и `buffering = false` вставить сообщение физически некуда,
  // иначе оно осталось бы в буфере, который уже никто не сливает.
  while (pending.length > 0) {
    await consume(pending.shift());
  }
  buffering = false;

  return { pairId, caughtUp, streaming: stream !== null };
}
