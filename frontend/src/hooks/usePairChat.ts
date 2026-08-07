'use client';

/**
 * usePairChat.ts — одна переписка: опрос, приём, порядок, отправка.
 *
 * Внутренности заменены целиком (Задача 6 плана «Клиент чата»): вместо XMTP
 * — наш склад мешков (`chatTransport.ts`), наш конверт (`chatEnvelope.ts`),
 * наш сеанс (`chatSession.ts`) и наш разговор (`chatConversation.ts`).
 * НАРУЖНЫЙ ВИД СОХРАНЁН: `ChatPanel.tsx` не должен заметить подмены —
 * пересадка вида это Задача 7.
 *
 * ─── ПОЧЕМУ ДВИЖОК ОТДЕЛЬНО ОТ ХУКА ─────────────────────────────────────
 *
 * У фронта нет ни jsdom, ни @testing-library: `npm test` берёт vitest у
 * релеера, окружение `node`. Отрисовать хук и проверить его эффекты НЕЧЕМ.
 * Поэтому вся логика живёт в `startPairChat()` — обычной функции без React,
 * запертой замерами (`usePairChat.test.ts`), а хук сведён к состоянию и
 * ОДНОМУ вызову `stop()` в уборке эффекта. Всё, что нельзя проверить,
 * обязано быть тривиальным — не наоборот.
 *
 * ─── ЧТО ДЕЛАЕТ ДВИЖОК ЗА ОДИН ТИК ──────────────────────────────────────
 *
 *   опрос склада (курсор двигается сам) → скачать ТОЛЬКО новые мешки →
 *   разобрать ВСЁ накопленное (`receiveBags`) → отдать наверх
 *
 * Разбирается всегда весь накопленный набор, а не только новинки: цепочка
 * проверяется целиком, и вердикт по половине переписки — не вердикт.
 * Скачивается при этом каждый мешок ровно один раз — на этом и стоит смысл
 * курсора.
 *
 * ─── ГАЛОЧКА «ДОШЛО» НАКАПЛИВАЕТСЯ, А НЕ ПЕРЕЧИТЫВАЕТСЯ ─────────────────
 *
 * `sent[]` сервер фильтрует тем же `since`, что и `inbox`. Значит мешок,
 * забранный собеседником ДАВНО, из ответа со временем уходит. Если бы
 * галочка бралась из последнего ответа как есть, она бы ПРОПАДАЛА у старых
 * сообщений — «дошло» превращалось бы в «неизвестно» само собой. Поэтому
 * множество доставленных только пополняется.
 *
 * ─── ЧЕГО ДВИЖОК НЕ ДЕЛАЕТ ──────────────────────────────────────────────
 *
 *  - НЕ ходит за пропуском сам: `getPass` приходит снаружи. Уметь ходить
 *    значило бы уметь открывать окно кошелька из глубины опроса.
 *  - НЕ грузит вложения: файл шифруется и кладётся на склад ВЫШЕ (хук),
 *    сюда приезжает уже готовым `ChatPayload.file`. Так `fileStorage.ts` не
 *    попадает в движок, а движок остаётся проверяемым в `node`.
 *  - НЕ отменяет отправку на `stop()`. Разбор — в докстринге `putBag`:
 *    оборванная отправка оставляет сгоревший номер, то есть дыру, которую
 *    собеседник видит как утаивание. Экономия одного запроса того не стоит.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import {
  fetchBag, pollBags,
  BagTransportError,
  type BagPollHandle, type BagPollIntervalsMs, type ListBagsResult, type BagSummary,
} from '@/lib/chatTransport';
import {
  sendMessage, receiveBags, listBurnedSeqs,
  readConversationArchive, archiveConversationFrames,
  type IncomingBag, type SentMessage, type ConversationTrouble,
} from '@/lib/chatConversation';
import type { ChainLink } from '@/lib/chatChain';
import type { ChatPayload } from '@/lib/chatPayloadForm';
import type { ChatSession } from '@/lib/chatSession';
import {
  useChatSession, fetchPeerChatKeys, publishChatKeys, getBagPass,
  ChatDirectoryError, type PeerChatKeys,
} from './useChatSession';
import { uploadFileWithEncryption } from '@/lib/fileStorage';
import { notifyPush } from '@/lib/webpush';

/* ─────────────────────────── наружная форма ───────────────────────────── */

/**
 * Сообщение в том виде, в каком его рисует `ChatPanel.tsx`. Форма выросла из
 * прежнего `ChatMessage` XMTP-обвязки (файл удалён в Задаче 7) и добавила два
 * поля, которых у XMTP не было и быть не могло:
 *
 *  - `seq` — номер звена в цепочке ОТПРАВИТЕЛЯ. По нему панель ставит значок
 *    разрыва: `gapAfterSeq` называет номера, а не идентификаторы.
 *  - `delivered` — «дошло до устройства». Одна галочка, не две: прочтение
 *    глазами сервер не видит и видеть не должен (§3.3 спеки плана).
 */
export interface PairChatMessage {
  id: string;
  from: string;
  text: string;
  timestamp: number;
  isFromMe: boolean;
  /** Номер звена в цепочке отправителя. */
  seq: number;
  /** Мешок забран получателем. У ЧУЖИХ сообщений всегда `true` — они уже у
   *  нас; у своих — по ответу склада. «Неизвестно» и «дошло» не смешиваются:
   *  всё, чего склад не подтвердил, остаётся недошедшим. */
  delivered: boolean;
  attachment?: {
    name: string;
    url: string;
    fileKey?: string;
    size?: number;
    mime?: string;
    key?: string;
    iv?: string;
    chunked?: boolean;
    chunkCount?: number;
    chunkSize?: number;
  };
}

/**
 * Претензия движка в той форме, которая нужна разбору ниже. Своя структурная
 * форма, а не импорт `ConversationTrouble`: разбору важен ТОЛЬКО род, и
 * привязка к полному типу заставляла бы тест собирать поля, на которые никто
 * не смотрит.
 */
export interface ConversationTroubleLike {
  kind: string;
  /** Чей мешок вызвал претензию, засвидетельствованный складом. `undefined` —
   *  мешок не разобрался настолько, что автора не установить. */
  from?: string;
}

/**
 * Два признака, и они РАЗНЫЕ ПО СМЫСЛУ — смешивать их нельзя.
 *
 *  - `chainUnverified` — предъявленное НЕ ЗАСЛУЖИВАЕТ ДОВЕРИЯ: подпись не
 *    сходится, отпечаток тела не сходится, подписной ключ не тот, отправитель
 *    не тот, номер задвоен, кадр не разбирается. Это про подлинность.
 *  - `undecryptable` — звено ЧЕСТНОЕ, но наш ключ его не открывает
 *    (собеседник запечатал на прежний открытый ключ). Это про нас, а не про
 *    него, и говорить тут «подделка» значило бы обвинить человека в чужой
 *    беде.
 *
 * ⚠️ ЗАЧЕМ ЭТО ВООБЩЕ ВЫВЕДЕНО НАВЕРХ. Замерено до правки: цепочка
 * собеседника, переписанная чужим ключом, отвергается ЦЕЛИКОМ — ноль
 * сообщений, пустой `gapAfterSeq`. Панель в этом состоянии рисовала
 * «Сообщений пока нет», то есть УТВЕРЖДАЛА обратное тому, что произошло.
 */
export interface TroubleSummary {
  chainUnverified: boolean;
  undecryptable: boolean;
  /**
   * НАША вкладка потеряла голову разговора и начала нумерацию заново.
   *
   * Третий признак, а не молчание и не обвинение. До этого замок запирал
   * именно МОЛЧАНИЕ: `own_numbering_reset` не попадал ни в один из двух
   * признаков, а комментарий рядом с самим родом обещал «показать человеку
   * надо». Собеседник в этот момент видит разрыв — и если мы не скажем, он
   * узнает о нём первым, при споре.
   */
  ownNumberingReset: boolean;
}

/**
 * Оба признака — ТОЛЬКО про мешки собеседника.
 *
 * ⚠️ Б-3 финальной проверки. С тех пор как своя половина переписки пошла через
 * тот же разбор, ЛЮБАЯ претензия к своему мешку поднимала баннер про чужую
 * подделку. Замерено: четыре претензии, авторы всех четырёх — мы сами,
 * `chainUnverified: true`. Прежняя правка вырезала РОВНО ОДИН род из семи
 * (`own_numbering_reset`), то есть чинила случай, а не причину.
 *
 * Причина одна: разбор смотрел на РОД претензии и никогда — на её АВТОРА.
 * Поэтому отсев по автору стоит ПЕРВЫМ и не знает ни одного рода: новый род,
 * которого сегодня нет, приедет отнесённым правильно сам по себе. Перечисление
 * родов осталось ниже и решает другой вопрос — «подделка или наша беда», — а
 * не «чья это беда».
 *
 * `ownAddress` необязателен: вызывающий, который своего адреса не знает,
 * получает прежнее поведение (обвинение по роду) вместо тихого молчания —
 * молчание здесь было бы хуже ошибки.
 *
 * Претензия БЕЗ автора (мешок не разобрался настолько, что отправителя не
 * установить) считается чужой. Это выбор в пользу громкости: сказать «что-то
 * не сходится» на своём мусоре — неприятно, промолчать на чужой подделке —
 * опасно.
 */
export function troubleSummary(
  troubles: readonly ConversationTroubleLike[],
  ownAddress?: string,
): TroubleSummary {
  const own = ownAddress?.toLowerCase();
  let chainUnverified = false;
  let undecryptable = false;
  let ownNumberingReset = false;
  for (const t of troubles) {
    // ⚠️ Своя перенумерация — единственное, что снимается ДО отсева по автору:
    // она про нас по определению, и отсев «это наше, молчим» проглотил бы
    // ровно то, что надо сказать.
    if (t.kind === 'own_numbering_reset') { ownNumberingReset = true; continue; }
    // Дальше — ПЕРВЫМ и без единого упоминания рода, в этом вся правка Б-3.
    if (own !== undefined && t.from !== undefined && t.from.toLowerCase() === own) continue;
    // Мягкие исходы названы ПОИМЁННО, громкий — по остатку, а не наоборот.
    // Раньше было наоборот: список «верить нельзя» перечислялся руками, и
    // род, которого в нём нет, не попадал НИ В ОДИН признак — то есть новый
    // род означал полное молчание, ещё мягче самой мягкой формулировки.
    // Комментарий рядом обещал ровно противоположное тому, что делал код.
    //
    // `own_numbering_reset` молчит ДАЖЕ БЕЗ адреса владельца: этот род
    // `chatConversation.ts` выдаёт ТОЛЬКО на свой мешок (`from ===
    // ownAddress` в самом условии), то есть автора он несёт в собственном
    // имени. Отсев по автору выше его и так поймает, когда адрес передан;
    // здесь — тот же вывод для вызывающего, который адреса не знает.
    if (t.kind === 'undecryptable') undecryptable = true;
    else chainUnverified = true;
  }
  return { chainUnverified, undecryptable, ownNumberingReset };
}

export interface PairChatState {
  messages: PairChatMessage[];
  /** Номера, ПОСЛЕ которых чего-то не хватает; `-1` — не предъявлено начало. */
  gapAfterSeq: number[];
  troubles: ConversationTrouble[];
  /**
   * Номера, занятые под наши сообщения, которые НЕ ДОЕХАЛИ до склада
   * (вкладку закрыли посреди отправки, склад отказал по неизвестной причине).
   *
   * У собеседника на их месте разрыв, неотличимый от утаивания. У нас — вот
   * этот список, и он существует ровно затем, чтобы человек узнал о своей
   * беде от нас, а не от собеседника при споре. До этой правки вызывающих у
   * `listBurnedSeqs` не было ни одного вне тестов: человек нажимал отправить,
   * сообщение не уходило, и на экране не появлялось НИЧЕГО.
   */
  burnedSeqs: number[];
  /** `false` — собеседник ни разу не заходил, писать ему некуда. */
  peerKnown: boolean;
  /**
   * Мешки, которые склад ПОКАЗАЛ в описи и которые относятся к этой переписке,
   * но которых мы ещё НЕ ВЗЯЛИ: очередь за потолком бюджета плюс те, на
   * которых скачивание отказало.
   *
   * ⚠️ К-2 враждебной проверки. Раньше «показано складом» и «есть у нас» были
   * для интерфейса одним и тем же, и разница не выражалась НИЧЕМ: замер —
   * десять мешков, один обрыв сети на третьем, показано два сообщения, выдач
   * состояния, назвавших пропажу, ноль. Человек с восемью пропавшими
   * сообщениями видел ровно то же, что человек, у которого не пропало ничего,
   * — а у собеседника на этом месте наша дыра, неотличимая от утаивания.
   */
  pendingBags: number;
  /** Хотя бы одно скачивание отказало, и мешок так и остался невзятым. Отдельно
   *  от `pendingBags`: «ещё качаем» и «не смогли скачать» — разные новости, и
   *  сводить их в одно число значило бы пугать очередью или молчать об отказе. */
  bagsFailed: boolean;
}

/* ──────────────────────────────── движок ──────────────────────────────── */

export interface PairChatEngineOptions {
  session: ChatSession;
  peer: `0x${string}`;
  /** Свежий пропуск склада. Обычно обёртка над `requestBagPass`. */
  getPass: () => Promise<string>;
  /** true — чат открыт (5 с), false — фон (30 с). */
  isActive?: () => boolean;
  onState: (state: PairChatState) => void;
  onError?: (err: unknown) => void;
  /** Опрос остановлен, пропуск не восстанавливается. */
  onAuthFailed?: () => void;
  /**
   * Приехало хотя бы одно НОВОЕ входящее сообщение на этом тике. Зовётся
   * только тогда, не на каждом тике.
   *
   * ⚠️ Существует ради списка переписок. Событие `hexseal-conv-update`
   * посылали ровно два файла XMTP, и оба снесены Задачей 7 — то есть
   * мгновенное обновление списка молча выродилось бы в тридцатисекундное
   * ожидание, и заметил бы это только человек, глядя на экран. Обратный
   * вызов, а не `window.dispatchEvent` прямо отсюда: движок про DOM не
   * знает и не должен (иначе его нельзя было бы проверить вне браузера).
   */
  onIncoming?: () => void;
  /**
   * Сделка, в контексте которой открыта переписка. Ставится меткой ВНУТРЬ
   * запечатанного на каждое отправленное сообщение (`ChatPayload.dealId`).
   *
   * Зачем: переписка пары ОДНА на все их сделки — движок ключуется адресом
   * собеседника и только им, — а сделок у пары бывает несколько (панель сама
   * показывает переключатель, когда их больше одной). Без метки предъявить
   * арбитру «кусок про эту сделку», а не весь тред (§7 общей спеки), не из
   * чего: разделить поток будет нечем.
   *
   * ⚠️ Метка ставится ЗДЕСЬ, в одном месте, а не в обработчиках панели: путей
   * отправки два (текст и вложение), и станет больше. Одно место нельзя
   * забыть на новом пути — два можно, и ровно так метка и пропала целиком,
   * оставив мёртвым весь аппарат проверки её формы.
   */
  dealId?: `0x${string}`;
  /** Только тесты. Умолчания и есть боевое поведение. */
  sleep?: (ms: number) => Promise<void>;
  intervals?: BagPollIntervalsMs;
}

export interface PairChatEngine {
  /** Останавливает опрос и обрывает ВСЁ в полёте (список и скачивания). */
  stop(): void;
  /** Отправляет готовый payload. Бросает `ChatConversationError` с `.code`. */
  send(payload: ChatPayload): Promise<PairChatMessage>;
  /** Сколько скачиваний движок начал и ещё не закончил. Для замеров. */
  inFlight(): number;
}

function payloadToMessage(
  payload: ChatPayload, from: string, seq: number, sentAt: number,
  isFromMe: boolean, delivered: boolean,
): PairChatMessage {
  return {
    id: `${from}-${seq}`,
    from,
    text: payload.text ?? payload.file?.name ?? '',
    timestamp: sentAt,
    isFromMe,
    seq,
    delivered,
    // Все девять полей, а не пять (В-3): признак нарезки, число и размер
    // кусков, ключ файла и тип содержимого молча терялись, и файл больше
    // 20 МБ приезжал битым. Необязательные поля кладутся ТОЛЬКО когда они
    // есть — иначе `chunked: undefined` отличалось бы от отсутствия ключа
    // при сравнении формы.
    ...(payload.file
      ? {
        attachment: {
          name: payload.file.name,
          url: payload.file.url,
          size: payload.file.size,
          key: payload.file.keyHex,
          iv: payload.file.ivHex,
          ...(payload.file.fileKey !== undefined ? { fileKey: payload.file.fileKey } : {}),
          ...(payload.file.mime !== undefined ? { mime: payload.file.mime } : {}),
          ...(payload.file.chunked !== undefined ? { chunked: payload.file.chunked } : {}),
          ...(payload.file.chunkCount !== undefined ? { chunkCount: payload.file.chunkCount } : {}),
          ...(payload.file.chunkSize !== undefined ? { chunkSize: payload.file.chunkSize } : {}),
        },
      }
      : {}),
  };
}

/**
 * Из двух голов берётся ТА, ЧТО ДАЛЬШЕ.
 *
 * Память вкладки знает про только что отправленное, склад — про отправленное
 * с прежнего устройства (Б-1). `sendMessage` вдобавок сверяется с диском и
 * тоже берёт максимум, так что все три источника сходятся к одному правилу:
 * ВПЕРЁД, НО НЕ НАЗАД. Шаг назад здесь стоит дороже всего — он выдаёт
 * собеседнику второе звено с тем же номером, то есть обвинение в подделке за
 * наш собственный сбой.
 *
 * Отдельная экспортированная функция, а не строка внутри `send()`: инлайном
 * правило не проверяемо (мутация «пусть склад просто побеждает» проходила
 * зелёной, потому что в живом сеансе склад и память сходятся сами).
 */
export function furtherLink(a: ChainLink | null, b: ChainLink | null): ChainLink | null {
  if (!a) return b;
  if (!b) return a;
  return a.seq >= b.seq ? a : b;
}

/* ───────────────── К-1: отбор ДО скачивания и потолок ─────────────────── */

/**
 * Сколько мешков скачиваем за минуту.
 *
 * ⚠️ ЧИСЛО ВЫВЕДЕНО ИЗ ЧУЖОГО, БОЕВОГО, а не выбрано «на глаз». `relayer/app.js`
 * даёт адресу `BAG_READ_RATE_MAX = 120` чтений в минуту, и этот бюджет ОБЩИЙ у
 * перечисления (`GET /bags`) и скачивания (`GET /bags/:key`). Опрос при
 * открытом чате — 12 перечислений в минуту, остаётся 108. Восемьдесят
 * оставляет запас списку переписок (`usePairConversations.ts`), который ест тот
 * же адресный бюджет, и на повторы после отказов.
 *
 * ⚠️ ЦЕНА НАЗВАНА ВСЛУХ. Переписка, у которой на складе лежит больше
 * восьмидесяти невзятых мешков (вернулись из отпуска, собеседник писал
 * длинно), доедет НЕ ЗА ОДИН ТИК: восемьдесят сейчас, остальные следующими
 * тиками. Человек в это время видит `pendingBags` больше нуля — то есть
 * знает, что показано не всё. Прежнее поведение доезжало «за один тик» ровно
 * до первой тысячи мешков, после чего склад отвечал `429` на СОБСТВЕННЫЙ
 * следующий опрос, и чат вставал целиком.
 */
export const BAG_DOWNLOAD_BUDGET_PER_MIN = 80;

/** Окно бюджета. Ровно минута — та же, которой считает склад. */
const BAG_BUDGET_WINDOW_MS = 60_000;

/**
 * Отступление перед ПОВТОРОМ скачивания одного мешка: 5 с, 10, 20, … но не
 * дольше пяти минут.
 *
 * ⚠️ ЗАЧЕМ ОТСТУПЛЕНИЕ, А НЕ «ПОВТОРЯТЬ КАЖДЫЙ ТИК» (вопрос «долбят нарочно»).
 * Мешок, который не отдаётся вовсе (склад отвечает 500 на этот файл, диск у
 * него подбит), повторялся бы каждые пять секунд вечно — 12 запросов в минуту
 * из адресного бюджета в 120, за один мешок, до конца сеанса. Отступление
 * превращает это в 12 запросов в ЧАС. База совпадает с интервалом активного
 * опроса намеренно: быстрее всё равно не спросим.
 */
const BAG_RETRY_BASE_MS = 5_000;
const BAG_RETRY_MAX_MS = 5 * 60 * 1000;

const KEY_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * Получатель мешка — из его КЛЮЧА (`<получатель>/<файл>.bin`, см.
 * `relayer/bagStore.js` `bagKeyFor`). Имя получателя присвоил СЕРВЕР при
 * записи, то есть это такое же свидетельство, как `sender`, только с другой
 * стороны. `null` — ключ не той формы.
 */
function recipientOfKey(key: string): string | null {
  const slash = key.indexOf('/');
  if (slash <= 0) return null;
  const addr = key.slice(0, slash).toLowerCase();
  return KEY_ADDRESS_RE.test(addr) ? addr : null;
}

/**
 * Мешок ЭТОЙ переписки — решается ДО скачивания, по одной описи, без единого
 * байта тела.
 *
 * ⚠️ ЗАЧЕМ (К-1 враждебной проверки). Мешок в чужой ящик кладёт КТО УГОДНО, кто
 * знает адрес, — а адреса в цепи публичны. Раньше движок качал КАЖДЫЙ мешок из
 * `inbox` и только потом отдавал `receiveBags`, которая уже отбрасывала чужое:
 * то есть посторонний оплачивал жертве трафик, время и — главное — адресный
 * бюджет чтения склада. Замер: 300 мешков постороннего = 300 скачиваний, и
 * сообщение собеседника показывалось 301-м.
 *
 * Три случая, и каждый обязан быть здесь, иначе теряется своя же половина:
 *  1. мешок ОТ собеседника — очевидный;
 *  2. НАШ мешок, адресованный собеседнику: своя половина переписки, без неё
 *     после перезагрузки вкладки от собственных сообщений не остаётся ничего
 *     (Б-1) и нумерация начинается заново;
 *  3. переписка с самим собой — там обе роли на одном адресе.
 *
 * Отбор своих идёт по ПОЛУЧАТЕЛЮ, не по отправителю: отправитель у всех своих
 * мешков один и тот же (мы сами), и сравнение с собеседником не отсеивало бы
 * ничего — открытая переписка с Бобом качала бы всё написанное Кэрол.
 *
 * Экспортирована намеренно: правило отбора — это ровно то место, где ошибка
 * означает либо пропавшую половину переписки, либо открытый чужой кран, и
 * проверяемо оно должно быть прямо, а не через поднятый движок.
 */
export function bagBelongsToPair(
  summary: { key: string; sender: string }, own: string, peer: string,
): boolean {
  const sender = summary.sender.toLowerCase();
  const ownLc = own.toLowerCase();
  const peerLc = peer.toLowerCase();
  if (sender === peerLc) return true;
  if (sender === ownLc) return peerLc === ownLc || recipientOfKey(summary.key) === peerLc;
  return false;
}

export function startPairChat(opts: PairChatEngineOptions): PairChatEngine {
  const own = opts.session.address.toLowerCase();
  const peer = opts.peer.toLowerCase() as `0x${string}`;

  // ОДИН контроллер на всю жизнь движка. Он и есть ответ на «уход со
  // страницы отменяет всё в полёте»: и перечисление (через pollBags), и
  // каждое скачивание держат ЭТОТ сигнал, а не свой собственный.
  const abort = new AbortController();
  let stopped = false;

  /** Всё скачанное за жизнь движка, по ключу мешка. Цепочка проверяется
   *  целиком — вердикт по половине переписки не вердикт. */
  const bags = new Map<string, IncomingBag>();
  /** Свои отправленные — чтобы разговор был разговором, а не половиной. */
  const ownSent: SentMessage[] = [];

  /**
   * СВОЯ КОПИЯ ПЕРЕПИСКИ С УСТРОЙСТВА (В-3).
   *
   * Читается один раз при заводе движка и кладётся в тот же набор, что и
   * скачанное. Без этого архив был бы возможностью, а не поведением: кадры
   * лежали бы на диске, а на экране их не было бы — ровно та ошибка, на
   * которой уже поймали `listBurnedSeqs`.
   *
   * Отказ чтения не мешает ничему: переписка покажется со склада.
   */
  const seeded = (async () => {
    try {
      const archived = await readConversationArchive(own as `0x${string}`, peer);
      for (const f of archived) {
        if (bags.has(f.key)) continue;
        bags.set(f.key, { key: f.key, sender: f.from, uploadedAt: f.receivedAt, body: f.frame });
      }
      return archived.length;
    } catch {
      return 0;
    }
  })();
  /**
   * Голова СВОЕЙ цепочки, восстановленная со склада.
   *
   * ⚠️ Б-1 финальной проверки, и это самая дорогая из находок. Человек
   * заходит с чистого браузера ТЕМ ЖЕ обычным кошельком: ключ выводится тот
   * же (подпись детерминированная), а головы разговора нет — она живёт только
   * в хранилище браузера. Нумерация начиналась с нуля и сталкивалась со
   * старой: у собеседника сообщение НЕ ПОКАЗЫВАЛОСЬ ВОВСЕ, а панель говорила
   * «часть сообщений собеседника не прошла проверку подлинности». Отправитель
   * при этом не узнавал ничего — свой повтор номера ему же невидим.
   *
   * Чинится тем, что своя половина переписки со склада УЖЕ достижима (задача
   * 7 научила `GET /bags` отдавать обе половины, а скачиванию — пускать
   * отправителя к своему мешку): разобрав её, мы знаем свой последний номер.
   *
   * Это НИЖНЯЯ ГРАНИЦА, а не источник истины: если голова на устройстве есть
   * и она свежее — побеждает она (`sendMessage` сравнивает сам). Иначе два
   * сообщения подряд в одном сеансе получили бы один номер, потому что склад
   * ещё не знает про первое.
   */
  let recoveredHead: ChainLink | null = null;
  /** Только пополняется, см. шапку файла. */
  const delivered = new Set<string>();

  let peerKeys: PeerChatKeys | null = null;
  let peerKnown = true;
  let keysPublished = false;
  let downloads = 0;

  /**
   * ОПИСЬ НЕВЗЯТОГО: мешки, которые склад показал в описи, которые относятся к
   * этой переписке — и которых мы ещё не взяли.
   *
   * Живёт ровно затем, чтобы «показано складом» и «взято нами» перестали быть
   * одним и тем же. Курсор `pollBags` двигается на весь ответ сразу, ещё до
   * первого скачивания, — значит без этой описи всё, что не взято на своём
   * тике (потолок бюджета, отказ сети), не приедет больше НИКОГДА.
   */
  const pending = new Map<string, BagSummary>();

  /** Моменты НАЧАТЫХ скачиваний — окно бюджета (К-1). */
  const downloadStamps: number[] = [];

  /**
   * Мешки, на которых скачивание уже отказывало: сколько раз и когда можно
   * пробовать снова (К-2). Ключ уходит отсюда, как только мешок взят, — то
   * есть счётчик считает ПОДРЯД идущие неудачи, а не всю историю.
   */
  const failures = new Map<string, { tries: number; nextAt: number }>();

  function noteFailure(key: string): void {
    const prev = failures.get(key);
    const tries = (prev?.tries ?? 0) + 1;
    failures.set(key, {
      tries,
      nextAt: Date.now() + Math.min(BAG_RETRY_BASE_MS * 2 ** (tries - 1), BAG_RETRY_MAX_MS),
    });
  }

  /** Сколько скачиваний ещё разрешает минутный бюджет. */
  function budgetLeft(): number {
    const cutoff = Date.now() - BAG_BUDGET_WINDOW_MS;
    while (downloadStamps.length > 0 && downloadStamps[0] <= cutoff) downloadStamps.shift();
    return BAG_DOWNLOAD_BUDGET_PER_MIN - downloadStamps.length;
  }

  /** Ключи собеседника — один раз за жизнь движка, дальше из памяти. */
  async function ensurePeerKeys(): Promise<PeerChatKeys | null> {
    if (peerKeys) return peerKeys;
    try {
      peerKeys = await fetchPeerChatKeys(peer, abort.signal);
      peerKnown = true;
      return peerKeys;
    } catch (err) {
      if (err instanceof ChatDirectoryError && err.code === 'peer_unknown') {
        // Не поломка: у этой причины есть человеческое действие («пришлите
        // ему ссылку»). Смешать её с сетевым отказом значило бы показать
        // «что-то сломалось» там, где всё работает.
        peerKnown = false;
        return null;
      }
      throw err;
    }
  }

  /** Свои ключи в справочник — один раз. Повтор байт-в-байт сервер и так
   *  отбрасывает ранним возвратом, но лишний запрос каждые пять секунд
   *  незачем. */
  async function ensureOwnKeysPublished(pass: string): Promise<void> {
    if (keysPublished) return;
    await publishChatKeys(pass, opts.session, abort.signal);
    keysPublished = true;
  }

  async function emit(): Promise<void> {
    // Своя копия обязана доехать ДО первой выдачи состояния: иначе первый
    // экран показывал бы пустую переписку, а через секунду — полную.
    //
    // ⚠️ Честно: эта строка НЕ заперта замером, и мутация «убрать её» проходит
    // зелёной. Причина не в том, что она лишняя, а в том, что подделка диска в
    // замерах отвечает микрозадачами и всегда успевает раньше первого ответа
    // сети. На настоящем устройстве с тысячами кадров чтение архива идёт
    // дольше сетевого запроса, и порядок перестаёт быть случайностью. Сказано
    // прямо, а не выдано за проверенное.
    await seeded;
    // ВСЕ ключи собеседника, а не только нынешний (Б-2): справочник хранит
    // историю ради того, чтобы честная смена ключа не читалась как подделка.
    const pinned = peerKeys && peerKeys.signKeyHistory.length > 0
      ? { [peer]: peerKeys.signKeyHistory }
      : undefined;
    const state = await receiveBags(opts.session, [...bags.values()], {
      peer,
      ...(pinned ? { peerSigningPublicKeys: pinned } : {}),
      own: ownSent,
      deliveredKeys: [...delivered],
    });
    if (stopped) return;
    // Свой последний номер — по РАЗОБРАННОЙ переписке, а не по памяти вкладки:
    // на чистом устройстве память пуста, а склад помнит (Б-1).
    for (const m of state.messages) {
      if (m.from.toLowerCase() !== own || !m.proof) continue;
      if (!recoveredHead || m.proof.link.seq > recoveredHead.seq) recoveredHead = m.proof.link;
    }
    // Сгоревшие номера — с устройства, на каждой выдаче состояния. Чтение
    // дешёвое (одна запись в IndexedDB) и обязано быть свежим: номер сгорает
    // ровно в момент неудачной отправки, а не на следующем заходе. Отказ
    // чтения не повод молчать обо всём остальном — тогда просто нечего
    // сказать про эту беду.
    let burnedSeqs: number[] = [];
    try {
      burnedSeqs = await listBurnedSeqs(own as `0x${string}`, peer);
    } catch {
      // Хранилище не ответило. Своя беда останется неназванной — но переписка
      // покажется, а это важнее.
    }
    if (stopped) return;

    opts.onState({
      messages: state.messages.map(m =>
        // В-2: на экране — засвидетельствованное складом время, а не то, что
        // написал отправитель. Своё утверждение отправителя не потеряно, оно
        // в `ChatMessage.sentAt` и нужно арбитру.
        payloadToMessage(m.payload, m.from, m.seq, m.receivedAt, m.from.toLowerCase() === own, m.delivered)),
      gapAfterSeq: state.gapAfterSeq,
      troubles: state.troubles,
      burnedSeqs,
      peerKnown,
      // К-2: «показано складом» и «есть у нас» — разные вещи, и разница
      // выражается здесь, а не остаётся внутри движка.
      pendingBags: pending.size,
      bagsFailed: failures.size > 0,
    });
  }

  /** Тики сериализуются: медленный разбор не должен наложиться на следующий
   *  и удвоить скачивания. */
  let chain: Promise<void> = Promise.resolve();

  async function handleTick(result: ListBagsResult, pass: string): Promise<void> {
    for (const s of result.sent) if (s.fetched) delivered.add(s.key);
    let arrived = 0;

    // ─── К-1: ОТБОР ДО СКАЧИВАНИЯ ────────────────────────────────────────
    // Опись мешка (кто отправитель, кому адресован) приезжает в `inbox` и не
    // стоит ни байта тела. Всё, что не относится к ЭТОЙ переписке, отсеивается
    // здесь и не попадает в опись невзятого вовсе: посторонний не должен уметь
    // занять у жертвы ни скачивания, ни строчки памяти.
    for (const summary of result.inbox) {
      // ⚠️ Честно: сегодня эта строка ничего не меняет — `pollBags` уже
      // отдаёт только новое (курсор плюс дедуп на границе миллисекунды), и
      // мутация «убрать её» не красит ни один замок. Оставлена вторым слоем
      // сознательно: настоящий дедуп заперт замерами уровнем ниже
      // (`chatTransportCursor.test.ts`), а здесь она стоит копейку и
      // страхует от регресса там. Утверждать, что она заперта, было бы
      // неправдой — поэтому сказано прямо.
      if (bags.has(summary.key)) continue;
      if (!bagBelongsToPair(summary, own, peer)) continue;
      pending.set(summary.key, summary);
    }

    // ─── СКАЧИВАНИЕ: СТАРОЕ ВПЕРЁД, В ПРЕДЕЛАХ БЮДЖЕТА ───────────────────
    // Старое вперёд, а не свежее: цепочка растёт от начала, и показанный
    // хвост без начала дал бы `gapAfterSeq: [-1]` — то есть значок разрыва и
    // молчаливое обвинение собеседника в том, что он чего-то не предъявил,
    // ровно там, где не предъявили МЫ САМИ СЕБЕ.
    const queue = [...pending.values()].sort((a, b) => a.uploadedAt - b.uploadedAt);
    for (const summary of queue) {
      if (stopped) return;
      if (budgetLeft() <= 0) break;
      // Мешок под отступлением — пропускаем, но из описи НЕ убираем: он
      // по-прежнему невзят, и человеку об этом по-прежнему говорят.
      const failed = failures.get(summary.key);
      if (failed && Date.now() < failed.nextAt) continue;
      downloadStamps.push(Date.now());
      downloads++;
      try {
        const body = await fetchBag(pass, summary.key, abort.signal);
        // Взято — из описи невзятого уходит. `null` (мешка нет: истёк,
        // забрали, чужой ключ) — тоже уходит: повторять запрос за тем, чего у
        // склада нет, значит долбить его вечно. Место такого мешка в цепочке
        // всё равно окажется дырой, и это честный вердикт.
        pending.delete(summary.key);
        failures.delete(summary.key);
        if (body) {
          bags.set(summary.key, {
            key: summary.key, sender: summary.sender,
            uploadedAt: summary.uploadedAt, body,
          });
          arrived++;
        }
      } catch (err) {
        // ⚠️ К-2: ОДИН ОТКАЗ НЕ УНОСИТ ПАЧКУ. Раньше отказ вылетал из тика
        // целиком: остаток очереди не качался, `emit()` не звался вовсе — то
        // есть уже приехавшие мешки тоже не показывались, — а курсор опроса
        // при этом ушёл вперёд всей пачки. Замер: десять мешков, один обрыв на
        // третьем, показано ДВА сообщения, и больше никогда ничего.
        //
        // Уход со страницы — не отказ склада: обрывать себя самому и записывать
        // это себе в беду значило бы врать про то, что мешок «не отдался».
        if (stopped) return;
        if ((err as { name?: string })?.name === 'AbortError') throw err;
        noteFailure(summary.key);
      } finally {
        downloads--;
      }
    }
    if (stopped) return;

    // ─── В-3: СВОЯ КОПИЯ ПОПОЛНЯЕТСЯ ТЕМ, ЧТО ПРИЕХАЛО ───────────────────
    // Кладём ВСЁ, что лежит в наборе, а не только новинки: уже лежащее
    // отсеется по ключу мешка внутри. Так после перезагрузки вкладки на
    // диск доедет и то, что приехало ДО заведения архива.
    //
    // Кадр архивируется НЕ РАЗБИРАЯСЬ в его подлинности: подлинность
    // проверяет `receiveBags` на каждом чтении заново, а архив хранит то,
    // что склад отдал. Отбросив здесь неподписанное, мы потеряли бы ровно то,
    // что нужно предъявить, когда собеседник прислал подделку.
    if (arrived > 0) {
      try {
        await archiveConversationFrames(own as `0x${string}`, peer, [...bags.values()].map(b => ({
          key: b.key, from: b.sender, seq: 0,
          sentAt: b.uploadedAt, receivedAt: b.uploadedAt, frame: b.body,
        })));
      } catch { /* архив — страховка, а не условие работы переписки */ }
    }

    await emit();
    // ПОСЛЕ выдачи состояния: список переписок пойдёт перечитывать превью, и
    // делать это раньше, чем сама переписка обновилась, незачем.
    if (arrived > 0) {
      try { opts.onIncoming?.(); } catch { /* чужой обработчик не должен ронять тик */ }
    }
  }

  const handle: BagPollHandle = pollBags({
    getPass: async () => {
      const pass = await opts.getPass();
      // Публикация своих ключей и добор чужих идут ВНУТРИ тика опроса
      // намеренно: у них тот же пропуск, та же отмена и тот же откат при
      // отказе, что у самого опроса — отдельная лестница повторов рядом с
      // существующей была бы вторым, несогласованным механизмом.
      await ensureOwnKeysPublished(pass);
      await ensurePeerKeys();
      return pass;
    },
    isActive: opts.isActive ?? (() => true),
    onBags: (result) => {
      chain = chain.then(async () => {
        if (stopped) return;
        const pass = await opts.getPass();
        await handleTick(result, pass);
      }).catch((err) => { if (!stopped) opts.onError?.(err); });
    },
    onError: (err) => { opts.onError?.(err); },
    onBagsError: (err) => { opts.onError?.(err); },
    ...(opts.onAuthFailed ? { onAuthFailed: opts.onAuthFailed } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.intervals ? { intervals: opts.intervals } : {}),
  });

  return {
    stop() {
      stopped = true;
      handle.stop();
      abort.abort();
    },
    inFlight: () => downloads,
    async send(payload: ChatPayload): Promise<PairChatMessage> {
      // Метка сделки — ДОБАВЛЯЕТСЯ, а не переписывает: если вызывающий указал
      // сделку сам (план 4, предъявление), его слово старше.
      if (opts.dealId !== undefined && payload.dealId === undefined) {
        payload = { ...payload, dealId: opts.dealId };
      }
      const pass = await opts.getPass();
      const keys = await ensurePeerKeys();
      if (!keys) {
        throw new ChatDirectoryError(
          'Собеседник ещё не заходил в переписку — писать ему пока некуда',
          'peer_unknown',
        );
      }
      const fromMemory = ownSent.length > 0 ? ownSent[ownSent.length - 1].link : null;
      const prev = furtherLink(recoveredHead, fromMemory);
      const sent = await sendMessage(opts.session, peer, keys.boxKey, payload, prev, { pass });
      ownSent.push(sent);
      await emit();
      // `delivered: false` — мешок только что положен, склад ещё не сказал,
      // что его забрали. Ставить здесь `true` значило бы рисовать галочку
      // «дошло» по факту УСПЕШНОЙ ОТПРАВКИ, то есть обещать за собеседника.
      return payloadToMessage(payload, own, sent.link.seq, sent.link.sentAt, true, false);
    },
  };
}

/* ──────────────────────────────── хук ─────────────────────────────────── */

/** Пережимает переходы между страницами — тот же приём, что был у прежней
 *  версии на XMTP. Ключ — `${мой}:${собеседник}`, не только собеседник:
 *  голый ключ собеседника однажды показал расшифрованную переписку одного
 *  аккаунта под другим после смены кошелька на том же устройстве. */
const _msgCache = new Map<string, PairChatMessage[]>();

/**
 * Тело пуш-уведомления. НЕ текст сообщения и НЕ имя файла — намеренно.
 *
 * ⚠️ ЭТО БЫЛА ДЫРА, И ОНА ПРОТИВОРЕЧИЛА БЕЙДЖУ. До 6 августа 2026 сюда
 * уезжал `text.trim()` и `📎 ${file.name}`: пуш идёт `POST /api/push` →
 * релеер → служба доставки, то есть содержимое сообщения покидало браузер
 * ОТКРЫТЫМ ТЕКСТОМ — по пути, к мешкам отношения не имеющему. Всё остальное
 * в этом плане пряталось от сервера, а превью уведомления отдавало его
 * добровольно.
 *
 * Экран теперь говорит «сервер не имеет ключей». Пока превью ехало открытым,
 * это было бы правдой про склад и ложью про человека.
 *
 * Цена честная и названная: в шторке ОС видно, что сообщение пришло, и не
 * видно, от кого и о чём. Так же поступает Signal по умолчанию. Английский
 * без перевода — язык получателя отправителю неизвестен, а придумать его за
 * него хуже, чем не угадать.
 */
const PUSH_BODY = 'New message';

export function usePairChat(peerAddress: string, dealId?: string) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { status, session, storageNotice } = useChatSession();

  const peerLc = peerAddress.toLowerCase();
  const myLc = address?.toLowerCase() ?? '';
  const pairKey = `${myLc}:${peerLc}`;

  const [isLoading, setIsLoading] = useState(() => (_msgCache.get(pairKey) ?? []).length === 0);
  const [isInitialized, setIsInitialized] = useState(() => (_msgCache.get(pairKey) ?? []).length > 0);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  /**
   * ВСЁ, что движок отдаёт, — ОДНИМ снимком, а не полем на `useState`.
   *
   * ⚠️ Это не стиль. Раньше каждое поле состояния переписывалось отдельной
   * строкой `setX(s.y)`, и мутация «убрать одну такую строку» не красила
   * ничего: React-обёртку в этом окружении отрисовать нечем (ни jsdom, ни
   * @testing-library), а замки кормят состояние руками. То есть на каждое
   * новое поле движка заводился шанс молча его потерять — и этот шанс уже
   * реализовался бы на `burnedSeqs`, найденный мутацией.
   *
   * Один снимок убирает КЛАСС: терять нечего, копирования по полям нет вовсе.
   * Признаки, которые нужны панели, выводятся ниже из этого же снимка.
   */
  const [engineState, setEngineState] = useState<PairChatState>({
    messages: _msgCache.get(pairKey) ?? [], gapAfterSeq: [], troubles: [],
    burnedSeqs: [], peerKnown: true, pendingBags: 0, bagsFailed: false,
  });
  const [streamDead, setStreamDead] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  /** Окно кошелька за пропуском склада открыто ПРЯМО СЕЙЧАС. Ставится из
   *  `getBagPass`, вокруг самого вызова кошелька — см. его докстринг. */
  const [passSignaturePending, setPassSignaturePending] = useState(false);

  // Выводится из того же снимка, а не хранится вторым состоянием: два
  // состояния про одно и то же расходятся рано или поздно.
  const troubles = troubleSummary(engineState.troubles, address);

  const engineRef = useRef<PairChatEngine | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    if (!address || !peerAddress || status !== 'ready' || !session) {
      setError(null);
      setIsLoading(false);
      return;
    }
    setError(null);
    setStreamDead(false);
    if (!_msgCache.has(pairKey)) setIsLoading(true);

    const engine = startPairChat({
      session,
      peer: peerAddress as `0x${string}`,
      // Единственное место подписи во всём чате — и оно под общим мьютексом
      // кошелька (`getBagPass`, см. его докстринг).
      getPass: () => getBagPass(address, signMessageAsync, setPassSignaturePending),
      isActive: () => activeRef.current,
      // Сделка, в контексте которой открыт чат. Метку на каждое сообщение
      // ставит движок — см. `dealId` в его опциях и почему это одно место.
      ...(dealId ? { dealId: dealId.toLowerCase() as `0x${string}` } : {}),
      onState: (s) => {
        _msgCache.set(pairKey, s.messages);
        setEngineState(s);
        setIsInitialized(true);
        setIsLoading(false);
      },
      onError: (err) => {
        // Код отказа — отдельным полем, текст только как запасной вариант:
        // разбор английского запрещён прямым требованием плана.
        setError(err instanceof BagTransportError || err instanceof ChatDirectoryError
          ? (err.code ?? err.message)
          : err instanceof Error ? err.message : 'Chat error');
        setIsLoading(false);
      },
      onAuthFailed: () => { setStreamDead(true); },
      // Список переписок слушает это событие и перечитывает превью сразу, а
      // не через тридцать секунд. Его посылали два файла XMTP, снесённые
      // Задачей 7; движок обязан взять эту обязанность на себя, иначе
      // отзывчивость теряется молча.
      onIncoming: () => {
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('hexseal-conv-update'));
      },
    });
    engineRef.current = engine;

    // Единственная строка уборки — и она же весь смысл того, что движок
    // отдельный: одна отмена, обрывающая и перечисление, и скачивания.
    return () => { engine.stop(); engineRef.current = null; };
  }, [address, peerAddress, status, session, pairKey, signMessageAsync, retryKey, dealId]);

  // Вкладка ушла в фон — опрос переходит на 30 секунд. Читается на КАЖДОМ
  // тике (`isActive`), поэтому хватает ссылки: перезапускать движок ради
  // смены интервала незачем.
  useEffect(() => {
    const onVisibility = () => { activeRef.current = document.visibilityState === 'visible'; };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const sendMessageText = useCallback(async (text: string) => {
    const engine = engineRef.current;
    if (!engine || !text.trim()) return;
    await engine.send({ text: text.trim() });
    notifyPush(peerLc, PUSH_BODY, `/chat?peer=${myLc}`, `/chat?peer=${peerLc}`);
  }, [peerLc, myLc]);

  const sendFile = useCallback(async (file: File, signal?: AbortSignal) => {
    const engine = engineRef.current;
    if (!engine) throw new Error('Chat is not ready');
    setUploadProgress(0);
    let result: Awaited<ReturnType<typeof uploadFileWithEncryption>>;
    try {
      result = await uploadFileWithEncryption(
        file, file.name, setUploadProgress, signal,
        address ? { self: address, peer: peerAddress } : undefined,
      );
    } finally {
      setUploadProgress(null);
    }
    signal?.throwIfAborted();
    await engine.send({
      file: {
        url: result.url, name: file.name, size: file.size,
        keyHex: result.keyHex, ivHex: result.ivHex,
        // В-3: без этих пяти большой файл приезжает битым, картинка теряет
        // превью, а протухший адрес нечем обновить. `fileKey` кладём всегда
        // — он единственный способ обновить `url`, запечатанный в конверте.
        fileKey: result.fileKey,
        ...(file.type ? { mime: file.type } : {}),
        chunked: result.chunked === true,
        ...(result.chunkCount !== undefined ? { chunkCount: result.chunkCount } : {}),
        ...(result.chunkSize !== undefined ? { chunkSize: result.chunkSize } : {}),
      },
    });
    notifyPush(peerLc, PUSH_BODY, `/chat?peer=${myLc}`, `/chat?peer=${peerLc}`);
  }, [address, peerAddress, peerLc, myLc]);

  // ─── ЧЕГО ЗДЕСЬ БОЛЬШЕ НЕТ И ПОЧЕМУ ───────────────────────────────────
  //
  // Задача 6 оставила три пустышки ради того, чтобы `ChatPanel.tsx` собрался
  // без правок. Задача 7 их УБРАЛА, а не доделала — по каждой есть причина,
  // и ни одна из них не «руки не дошли»:
  //
  //  - `loadMore`/`hasMore` — склад отдаёт всё, что у него есть, ОДНИМ
  //    списком (`GET /bags`), страниц не существует. Пустая функция, которую
  //    зовёт кнопка, выглядит как работа: человек жмёт «загрузить старые» и
  //    не получает ничего, а винит связь. Кнопка убрана вместе с функцией.
  //  - `markDealContext` — метка сделки уезжала отдельным сообщением боту;
  //    теперь она едет ВНУТРИ запечатанного каждого сообщения
  //    (`ChatPayload.dealId`, ставит движок — см. `dealId` в его опциях), и
  //    звать отдельно нечего. ⚠️ До финальной проверки это было НЕПРАВДОЙ:
  //    комментарий стоял, а метку не ставил никто, и весь аппарат проверки её
  //    формы был мёртвым кодом.
  //  - `peerLastReadAt` — «прочитано глазами» серверу неизвестно и не должно
  //    быть известно. Осталась ОДНА галочка, и она в самих сообщениях
  //    (`PairChatMessage.delivered`).

  const reconnect = useCallback(() => {
    setStreamDead(false);
    setIsInitialized(false);
    setRetryKey(k => k + 1);
  }, []);

  return {
    messages: engineState.messages, sendMessage: sendMessageText, sendFile,
    isLoading, isInitialized, error, uploadProgress,
    streamDead, reconnect, needsSetup: status !== 'ready',
    /** Разрывы в цепочке собеседника и «собеседник ещё не заходил». */
    gapAfterSeq: engineState.gapAfterSeq, peerKnown: engineState.peerKnown,
    /** Предъявленному верить нельзя (подпись, отпечаток, ключ, номер). */
    chainUnverified: troubles.chainUnverified,
    /** Честное звено, которое не открывается нашим ключом. */
    undecryptable: troubles.undecryptable,
    /** НАША вкладка начала нумерацию заново — собеседник увидит разрыв. */
    ownNumberingReset: troubles.ownNumberingReset,
    /** Наши сообщения, не доехавшие до склада. У собеседника на их месте
     *  разрыв, и сказать об этом обязаны мы. */
    burnedSeqs: engineState.burnedSeqs,
    /**
     * Мешки, которые склад показал, а мы ещё не взяли, и признак «взять не
     * вышло» (К-2).
     *
     * ⚠️ ЧЕСТНО О ТОМ, ЧТО ИЗ ЭТОГО СБЫЛОСЬ. Движок эти два числа считает и
     * отдаёт; довести их до экрана — работа слоя интерфейса, и она НЕ сделана
     * здесь (панель в чужой зоне этого круга). Пока `ChatPanel.tsx` их не
     * читает, свойство «человек узнаёт о недоехавшем» существует как
     * ВОЗМОЖНОСТЬ, а не как поведение — ровно то различие, на котором уже
     * поймали `listBurnedSeqs` (у неё был ноль вызывающих вне тестов, а
     * докстринг обещал «интерфейс обязан сказать»). Второй раз выдавать
     * замысел за поведение нельзя.
     */
    pendingBags: engineState.pendingBags,
    bagsFailed: engineState.bagsFailed,
    /** Окно кошелька за пропуском склада открыто прямо сейчас. */
    passSignaturePending,
    /** Ключ переписки не лёг на устройство — см. `sessionStorageNotice`. */
    storageNotice,
  };
}
