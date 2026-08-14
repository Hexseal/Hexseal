"use client";

/**
 * ArbiterPresentations.tsx — пятая вкладка арбитра.
 *
 * ⚠️ КОШЕЛЬКА ЭТОТ ФАЙЛ НЕ ТРОГАЕТ. `signChatKey` и `getBoxPass` приезжают
 * пропсами из `app/arbiter/page.tsx`, где подписи уже стоят под общим
 * мьютексом. Причина не косметическая: `lib/signaturePaths.test.ts`
 * перечисляет файлы с вызовом подписи ПОИМЁННО, и новый файл в списке — повод
 * осознанно решать, по нажатию ли там подпись. Замер — мутации 13 и 15.
 *
 * ⚠️ НИЧЕГО НЕ ЧИТАЕТСЯ САМО. Ни описи, ни мешков, ни ключа — только по
 * нажатию: чтение стоит КЛИЕНТСКОГО адресного бюджета (100/мин на весь склад,
 * один на переписку и ящик — `BAG_READ_BUDGET_PER_MIN`; серверные потолки у
 * них при этом РАЗНЫЕ — у ящика свой `DISPUTE_BOX_READ_RATE_MAX`), а ключ
 * может стоить окна подписи.
 *
 * ⚠️ ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ, А ЧТО НЕТ — НАЗЫВАЮ В САМОМ ФАЙЛЕ, а не только в
 * отчёте. У фронта нет ни jsdom, ни `@testing-library` (`environment: 'node'`):
 * нажатие кнопки не проверяется ничем, и что кнопка дошла ДО ГЛАЗ — не
 * замеряется вовсе. Поэтому здесь два разных рода кода и два разных рода
 * доверия:
 *   — ТРИ ЧИСТЫЕ ЧАСТИ РАЗМЕТКИ (`BoxSummaryView`, `PresentationBagView`,
 *     `BoxFailureView`) экспортируются наружу и запираются СТРУКТУРНО —
 *     `components/arbiterPresentationsRender.test.tsx` рендерит их
 *     `renderToStaticMarkup` и меряет, что решённое доехало до разметки, а
 *     запрещённое в ней не появилось. Это проверка ТЕКСТА РАЗМЕТКИ, не
 *     поведения;
 *   — ВСЁ, ЧТО РЕШАЕТ, живёт в `lib/arbiterPresentations.ts` и запирается
 *     по-настоящему, вызовом. В `DisputeBoxCard` ниже остаётся склейка:
 *     последовательность вызовов и раскладка состояния. Она не сторожится
 *     ничем, и это сказано вслух, а не выдано за проверенное.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { PublicClient } from 'viem';
import { Loader2, AlertTriangle, Inbox, MessageCircle, FileText, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shortAddr } from '@/lib/utils';
import { claimKeysFromSession, runGatedKeyAction, type GatedSignChatKey } from '@/lib/arbiterClaimKeys';
import type { ChainChatKeys } from '@/lib/arbiterChatKey';
import { listDisputeBox, fetchDisputeBag } from '@/lib/disputeBox';
import { arbiterTurnOf } from '@/lib/arbiterTurn';
import {
  readDisputeBox, openArbiterBoxSession, openDisputeBoxImpl,
  arbitersBefore, deviceKeyVerdict, BOX_READ_REFUSAL_KEYS,
  attestationDateLabel,
  type BoxOpenState, type BoxReadRefusal, type DeviceKeyVerdict, type DisputeBoxReading,
  type PresentedBag, type PresentedMessageView,
} from '@/lib/arbiterPresentations';
import { anchorOrder, firstNoResponse, type ChainAnchors } from '@/lib/presentationAnchor';

/** Пока `getDetails` дела не приехал, стороны неизвестны — ссылок в чат не рисуем. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface ArbiterCase {
  agreement: `0x${string}`;
  client: `0x${string}`;
  executor: `0x${string}`;
}

export interface ArbiterPresentationsTabProps {
  cases: ArbiterCase[];
  me?: `0x${string}`;
  chainKeys: ChainChatKeys | null;
  publicClient: PublicClient | undefined;
  signChatKey: () => GatedSignChatKey | null;
  getBoxPass: () => Promise<string>;
}

// ⚠️ ЧЕТЫРЕ ИСХОДА НАЖАТИЯ ОБЪЯВЛЕНЫ В МОДУЛЕ (`BoxOpenState`), а не здесь:
// там же они и решаются. Экран добавляет к ним ровно один — `idle`, «ещё не
// нажимали», которого решение не производит никогда.
//
// ⚠️ Отказ едет РАЗОБРАННОЙ причиной, не строкой: текст ошибки транспорта на
// английском, он про HTTP и ничего не советует. У каждой причины свой ключ
// локали и свой совет.
type BoxState = { kind: 'idle' } | BoxOpenState;

/* ─────────────────────────── чистая разметка ──────────────────────────── */

/** Сводка по ящику. Чистая: всё решённое приезжает готовым. */
export function BoxSummaryView({ reading, before, deviceKey }: {
  reading: DisputeBoxReading; before: number | null; deviceKey: DeviceKeyVerdict;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-2 text-xs text-white/50">
      {/* ⚠️ «Спор ведёт другой» и «спор не ведёт никто» — РАЗНЫЕ новости, и
          прочерк вместо адреса был бы третьей, несуществующей. После
          развязки `_clearDisputeClaim` обнуляет клеймо, и у старого дела
          арбитра в цепи нет вовсе — это законный конец, а не поломка.
          ⚠️ И ОБЕ ГОВОРЯТ ПРО СЛОВО СЕРВЕРА, А НЕ ПРО ЦЕПЬ СИЮ СЕКУНДУ:
          `arbiterNow` приезжает из кэша фактов релеера (15 с). Поэтому обе
          надписи названы словом сервера и обе зовут вернуться через
          полминуты — иначе арбитр, только что взявший спор, прочтёт «спор
          ведёте не вы» как утверждение цепи и решит, что дело у него
          отняли. */}
      {!reading.mine && (
        <p className="text-amber-300/85">
          {reading.arbiterNow
            ? t('arbiter.presentations_not_mine', { arbiter: shortAddr(reading.arbiterNow) })
            : t('arbiter.presentations_box_closed')}
        </p>
      )}
      {/* Сколько арбитров ДО него — факт цепи, и честное «не знаем» рядом. */}
      <p>{before === null
        ? t('arbiter.presentations_turn_unknown')
        : t('arbiter.presentations_turn_known', { count: before })}</p>
      {/* ⚠️ ЧЕТЫРЕ ВЕРДИКТА — ЧЕТЫРЕ ИСХОДА, А НЕ ОДИН ГОВОРЯЩИЙ И ТРИ НЕМЫХ
          (ревью круг 1). `chain_missing` («ключа в цепи у вас нет вовсе») и
          `chain_unread` («цепь не ответила, сверить нечем») молчали, а оба —
          законные причины, по которым ящик выглядит пустым не из-за стороны.
          `agree` молчит намеренно: это отсутствие новости, а не новость. */}
      {deviceKey === 'differs' && (
        <p className="text-amber-300/85">{t('arbiter.presentations_device_key_differs')}</p>
      )}
      {deviceKey === 'chain_missing' && (
        <p className="text-amber-300/85">{t('arbiter.presentations_device_key_chain_missing')}</p>
      )}
      {deviceKey === 'chain_unread' && (
        <p>{t('arbiter.presentations_device_key_chain_unread')}</p>
      )}
      {/* Слово СЕРВЕРА, не цепи, — и это сказано в самой строке. */}
      {reading.sealedForOthersDeclared > 0 && (
        <p>{t('arbiter.presentations_sealed_for_others', { count: reading.sealedForOthersDeclared })}</p>
      )}
      {/* ⚠️ А ЭТО — ПОСЧИТАННОЕ, и без него «пусто» врало бы. Заголовка
          `x-sealed-for` могло не быть вовсе (он законно необязателен), тогда
          заявленных на других ноль, а нечитаемых — полный ящик. Два числа
          стоят порознь и подписаны порознь: одно заявлено, другое измерено. */}
      {reading.notOurs > 0 && (
        <p>{t('arbiter.presentations_not_ours', { count: reading.notOurs })}</p>
      )}
      {reading.notOursFetched > 0 && (
        <p>{t('arbiter.presentations_not_ours_fetched', { count: reading.notOursFetched })}</p>
      )}
      {/* ⚠️ МЕШКИ, НЕ ДОЕХАВШИЕ ДО ВЕРДИКТА ВООБЩЕ (ревью круг 1, Important 1).
          Это число считалось моделью, было заперто тестами — и не показывалось
          никому. Острее всего `not_presentation`: контейнер от клиента другой
          версии отсеивается ДО читалки, и без этой строки арбитр читал бы
          «вам сюда ничего не предъявили» над ящиком, в котором мешок лежал.
          `notOurs` сюда НЕ входит — он назван своей строкой выше, и сложить их
          значило бы посчитать один мешок дважды. */}
      {reading.notParsed > 0 && (
        <p className="text-amber-300/85">
          {t('arbiter.presentations_not_parsed', { count: reading.notParsed })}
        </p>
      )}
      {/* ⚠️ ПРИЧИНУ НЕДОЧИТАННОГО НЕ УГАДЫВАЕМ (ревью круг 1, Important 2).
          Прежняя единственная строка утверждала «бюджет чтения кончился»
          ВСЕГДА — в том числе когда оборвалась связь (и совет «вернитесь через
          минуту» тогда неверен) и когда бюджет не тратился вовсе, а мешки
          отсеялись до забора по толщине или чужому ключу. Тот же экран
          отказывается угадывать причину отказа по классу статуса — угадывать
          её здесь было бы той же ошибкой на соседней строке. */}
      {reading.tried < reading.listed && reading.stop !== 'not_mine' && (
        <p className="text-amber-300/85">
          {reading.stop === 'read_budget'
            ? t('arbiter.presentations_partial_budget', { read: reading.tried, total: reading.listed })
            : reading.stop === 'transport'
              ? t('arbiter.presentations_partial_transport', { read: reading.tried, total: reading.listed })
              : t('arbiter.presentations_partial_unread', { read: reading.tried, total: reading.listed })}
        </p>
      )}
      {/* ⚠️ ТРЕТИЙ ОХРАННИК, ОБЯЗАТЕЛЬНЫЙ (ревью Задачи 1, круг 2).
          `indexTrusted === false` значит: опись релеера терялась и
          восстанавливалась с диска, восстановленные записи ящика НЕ несут
          `deal`/`sealedFor` (взять неоткуда), выпадают из `listDisputeBags()`
          насовсем — то есть `bags` мог прийти пустым (а с ним и
          `notOurs === 0`, `sealedForOthersDeclared === 0`) НЕ потому, что
          сторона ничего не предъявляла, а потому что опись перестраивалась.
          Оба посчитанных стража молчат в этом случае одинаково — они меряют
          то, что ВИДНО в ответе, а не то, что могло из него выпасть. */}
      {reading.mine && !reading.indexTrusted && (
        <p className="text-amber-300/85">{t('arbiter.presentations_index_rebuilt')}</p>
      )}
      {/* ⚠️ ЗАПИСЬ О МОЛЧАНИИ НАЗЫВАЕТСЯ НОМЕРОМ БЛОКА, А НЕ ФАКТОМ. Ради
          порядка всё и затевалось: без блока сравнить «предъявили» и «записал,
          что не ответили» нечем. Строка стоит и тогда, когда предъявлений в
          ящике нет вовсе, — это ровно тот случай, о котором спор и пойдёт. */}
      {firstNoResponse(reading.anchors) !== null && (
        <p>{t('arbiter.presentations_no_response_record', {
          block: firstNoResponse(reading.anchors)!.block.toString(),
          count: reading.anchors ? reading.anchors.noResponse.length : 0,
        })}</p>
      )}
      {/* ⚠️ ПРЕДЕЛ ПОИСКА НАЗЫВАЕТСЯ ЧИСЛАМИ (правка круга 1). Лента смотрит на
          сутки назад, а спор с апелляцией живёт восемь; без этой строки арбитр
          читал бы отсутствие порядка как отсутствие фактов. «Не знаю» и «не
          смотрел так далеко» — разные вещи. */}
      {reading.anchors && !reading.anchors.logsComplete && (
        <p className="text-amber-300/85">
          {t('arbiter.presentations_anchor_window', {
            from: reading.anchors.window ? reading.anchors.window.fromBlock.toString() : '—',
            to: reading.anchors.window ? reading.anchors.window.toBlock.toString() : '—',
          })}
        </p>
      )}
      {/* ⚠️ И ВТОРОЙ ПРЕДЕЛ — ДЛИНА СПИСКА. Он честно превращает несовпадение в
          «не знаем» (вердикт `unread`), но САМ факт обрезки прежде не доезжал
          до глаз: арбитр видел «не знаем» и не понимал, чего именно мы не
          дочитали. */}
      {reading.anchors && !reading.anchors.digestsComplete && (
        <p className="text-amber-300/85">
          {t('arbiter.presentations_anchor_truncated', { count: reading.anchors.digests.length })}
        </p>
      )}
      {/* ⚠️ «Вам ничего не предъявили» — самая опасная надпись экрана: сказанная
          не вовремя, она превращает «мы не смогли открыть» в «сторона молчала»
          (§2.3 замысла запрещает это прямым текстом). Поэтому она подавляется,
          если ящик пуст НЕ по обоим счётам: и по посчитанному (`notOurs`), и по
          заявленному (`sealedForOthersDeclared`) — И ЕСЛИ ОПИСИ МОЖНО ДОВЕРЯТЬ
          (`indexTrusted`): восстановленная с диска опись МОЛЧА даёт оба
          посчитанных нуля, и без третьего условия «пусто» прозвучало бы там,
          где сервер сам не уверен, что видит всё.
          ⚠️ ЧЕТВЁРТЫЙ ОХРАННИК — `skipped` (ревью круг 1, Important 1). Мешок,
          не доехавший до вердикта (чужая версия контейнера, пропал со склада,
          слишком толст), молчит во всех трёх числах выше: `sealed_for_other`
          из него вычтен, `tried` у половины причин успел вырасти, а
          `indexTrusted` про это не знает вовсе. Без него самая опасная надпись
          экрана произносилась бы над ящиком, в котором мешок ЛЕЖАЛ. */}
      {reading.mine && reading.presentations.length === 0 && reading.stop === 'read_all'
        && reading.notOurs === 0 && reading.sealedForOthersDeclared === 0
        && reading.skipped.length === 0
        && reading.indexTrusted && (
        <p>{t('arbiter.presentations_empty')}</p>
      )}
    </div>
  );
}

/** Почему ящик не прочитался. Чистая: причина приезжает уже разобранной. */
export function BoxFailureView({ refusal }: { refusal: BoxReadRefusal }) {
  const t = useTranslations();
  return (
    <p className="text-xs text-red-300/85 flex items-start gap-1.5">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      {t(BOX_READ_REFUSAL_KEYS[refusal])}
    </p>
  );
}

function MessageRow({ m }: { m: PresentedMessageView }) {
  const t = useTranslations();
  return (
    <li className="rounded-[10px] border border-white/[0.06] px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 text-[11px] text-white/35 font-mono">
        <span>#{m.seq}</span><span>{shortAddr(m.sender)}</span>
      </div>
      {m.read && m.text !== null && <p className="text-sm text-white/80 whitespace-pre-wrap">{m.text}</p>}
      {/* Имя, размер и ТИП — ровно то, что стороне обещано в предупреждении
          Задачи 6 («уедут имя, размер и тип»). Не показать здесь тип значило
          бы разойтись с тем, на что человек соглашался. Тип неизвестен —
          прочерк, а не пустое место: пустое читается как «типа нет». */}
      {m.file && (
        <p className="text-[11px] text-white/45 flex items-center gap-1.5">
          <FileText className="w-3 h-3" />
          {t('arbiter.msg_file_fact', { name: m.file.name, size: m.file.size, mime: m.file.mime ?? '—' })}
        </p>
      )}
      {m.legacyAttachmentExposed && (
        <p className="text-[11px] text-amber-300/85">{t('arbiter.msg_legacy_key_exposed')}</p>
      )}
      {!m.read && (
        <p className="text-[11px] text-white/45">
          {t('arbiter.msg_unopened', { reason: m.openFailure ?? '—' })}
        </p>
      )}
      {m.frameFailure && (
        <p className="text-[11px] text-red-300/85">{t('arbiter.msg_frame_broken', { reason: m.frameFailure })}</p>
      )}
      {/* ⚠️ НАХОДКА 51: «АВТОР ПОДТВЕРЖДЁН» ОДНО, БЕЗ ДАТЫ, ЗДЕСЬ НЕ ПИШЕТСЯ И
          НЕ БУДЕТ. Заверение ключей отозвать нечем — поля отзыва в нём нет, а
          срок ему год. Сцена: у человека украли устройство с сохранённым
          сеансом, он восстановился по коду и заверил новую пару; прежнее
          заверение осталось годным, и вор подписывает прежним ключом. Арбитр
          получает `ok` и на словах человека, и на словах вора вперемешку, и
          развести их может ТОЛЬКО по дате заверения — он-то из спора знает,
          когда устройство украли. Поэтому подтверждённый автор приезжает
          датой, а не бейджем.
          Дата — `ГГГГ-ММ-ДД` по UTC (`attestationDateLabel`): она работает
          уликой, и расхождение часовых поясов между арбитром и стороной
          здесь стоило бы вердикта. */}
      {m.authorConfirmed && attestationDateLabel(m.attestedAt) !== null && (
        <p className="text-[11px] text-white/45">
          {t('arbiter.msg_author_attested', { date: attestationDateLabel(m.attestedAt)! })}
        </p>
      )}
      {!m.authorConfirmed && (
        <p className="text-[11px] text-amber-300/85">
          {t('arbiter.msg_author_unconfirmed', { verdict: m.attestation })}
        </p>
      )}
    </li>
  );
}

/**
 * Сверка отпечатка — чистая разметка над готовым вердиктом.
 *
 * ⚠️ ЧЕТЫРЕ СТРОКИ, И ТРЕТЬЯ НЕ ОШИБКА. «Сходится» / «не сходится» / «в цепи не
 * отмечено» — три состояния из задания; четвёртое, «цепь не ответила», добавлено
 * по тому же правилу, по которому у ключа устройства четыре вердикта, а не один
 * говорящий и три немых: «не знаем» и «не отмечено» — разные новости, и вторая,
 * сказанная вместо первой, обвиняет сторону молчанием узла.
 *
 * ⚠️ ПОРЯДОК — ЭТО И ЕСТЬ ПРЕДМЕТ. Отпечаток лёг на блоке N, запись арбитра
 * «просил, ответа нет» — на блоке M; доверия к нашему серверу для такого
 * сравнения не нужно, а без него отпечаток остаётся украшением.
 */
export function BagAnchorView({ bag, anchors }: {
  bag: PresentedBag; anchors: ChainAnchors | null;
}) {
  const t = useTranslations();
  const a = bag.anchor;
  const noResponse = firstNoResponse(anchors);
  const order = anchorOrder(a, anchors);
  return (
    <>
      {a.verdict === 'match' && (a.block !== null
        ? (
          <p className="text-[11px] text-emerald-300/85">
            {t('arbiter.presentation_anchor_match', { block: a.block.toString() })}
          </p>
        )
        : (
          // Отметка есть (её назвал геттер), а номера блока нет: лента смотрит
          // на сутки назад. Сказать «не отмечено» здесь было бы враньём.
          <p className="text-[11px] text-emerald-300/85">
            {t('arbiter.presentation_anchor_match_no_block')}
          </p>
        ))}
      {a.verdict === 'mismatch' && (
        <p className="text-[11px] text-red-300/85 flex items-start gap-1.5">
          <ShieldAlert className="w-3 h-3 shrink-0 mt-0.5" />
          {t('arbiter.presentation_anchor_mismatch', { count: a.total })}
        </p>
      )}
      {a.verdict === 'absent' && (
        <p className="text-[11px] text-white/45">{t('arbiter.presentation_anchor_absent')}</p>
      )}
      {a.verdict === 'unread' && (
        <p className="text-[11px] text-white/45">{t('arbiter.presentation_anchor_unread')}</p>
      )}
      {/* ⚠️ ДУБЛЬ НЕ ПРЯЧЕТСЯ. Строка одна (схлопнута), но число записей
          названо: повтор «отметить» после обрыва — честное поведение, а не
          подделка, и решать это арбитру, а не нам за него. */}
      {a.records > 1 && (
        <p className="text-[11px] text-white/45">
          {t('arbiter.presentation_anchor_dupes', { count: a.records })}
        </p>
      )}
      {order === 'digest_first' && noResponse && a.block !== null && (
        <p className="text-[11px] text-amber-300/85">
          {t('arbiter.presentation_anchor_order_digest_first',
            { digest: a.block.toString(), record: noResponse.block.toString() })}
        </p>
      )}
      {order === 'record_first' && noResponse && a.block !== null && (
        <p className="text-[11px] text-white/45">
          {t('arbiter.presentation_anchor_order_record_first',
            { digest: a.block.toString(), record: noResponse.block.toString() })}
        </p>
      )}
      {order === 'same_block' && a.block !== null && (
        <p className="text-[11px] text-white/45">
          {t('arbiter.presentation_anchor_order_same', { block: a.block.toString() })}
        </p>
      )}
      {/* ⚠️ ГРОМКАЯ ПОТЕРЯ (правка круга 1). Прежде этот случай молчал, и
          «порядок показать нечем, потому что мы не смотрели так далеко» было
          на экране НЕОТЛИЧИМО от «отпечатка нет». Разница принципиальная:
          второе человек обходит сам, попросив разбор. Окно ленты — сутки, окно
          спора — четверо, с апелляцией восемь; настоящее лечение (сабграф)
          идёт отдельной работой, а до него потеря обязана звучать. */}
      {order === 'out_of_window' && (
        <p className="text-[11px] text-amber-300/85 flex items-start gap-1.5">
          <ShieldAlert className="w-3 h-3 shrink-0 mt-0.5" />
          {t('arbiter.presentation_anchor_order_out_of_window')}
        </p>
      )}
    </>
  );
}

/** Одно предъявление. Чистая. */
export function PresentationBagView({ bag, anchors = null }: {
  bag: PresentedBag; anchors?: ChainAnchors | null;
}) {
  const t = useTranslations();
  return (
    <div className="rounded-[16px] border border-white/[0.08] bg-white/[0.02] p-3 space-y-2">
      {bag.view.container === 'bad_signature' && (
        <p className="text-xs text-red-300/85">{t('arbiter.presentation_bad_signature')}</p>
      )}
      {bag.view.container === 'malformed' && (
        <p className="text-xs text-red-300/85">{t('arbiter.presentation_malformed')}</p>
      )}
      {bag.uploaderIsPresenter === false && (
        <p className="text-xs text-amber-300/85">
          {t('arbiter.presentation_uploader_differs', {
            uploader: shortAddr(bag.uploadedBy),
            presenter: bag.view.presenter ? shortAddr(bag.view.presenter) : '—',
          })}
        </p>
      )}

      {/* ⚠️ ДВЕ РАЗНЫЕ СТРОКИ, И СКЛАДЫВАТЬ ИХ ЗАПРЕЩЕНО. Первая — СЛОВО
          стороны (три числа, из контейнера), вторая — СЧЁТ читалки (четыре).
          Слова стороны нет вовсе, когда неизвестно, чьё оно. */}
      {bag.declared && (
        <p className="text-[11px] text-white/40 font-mono">
          {t('arbiter.presentation_counts_declared', {
            read: bag.declared.read, hidden: bag.declared.hidden, notPrepared: bag.declared.notPrepared,
          })}
        </p>
      )}
      <p className="text-[11px] text-white/60 font-mono">
        {t('arbiter.presentation_counts_measured', {
          read: bag.measured.read, unopened: bag.measured.unopened,
          hidden: bag.measured.hidden, notPrepared: bag.measured.notPrepared,
        })}
      </p>
      {bag.countsDisagree.length > 0 && (
        <p className="text-[11px] text-amber-300/85 flex items-center gap-1.5">
          <ShieldAlert className="w-3 h-3" />
          {t('arbiter.presentation_counts_disagree')}
        </p>
      )}

      <BagAnchorView bag={bag} anchors={anchors} />

      <ul className="space-y-1.5">
        {bag.messages.map(m => <MessageRow key={`${m.sender}-${m.seq}`} m={m} />)}
      </ul>
    </div>
  );
}

/* ────────────────────────── ящик одного спора ─────────────────────────── */

function DisputeBoxCard({ deal, me, chainKeys, publicClient, signChatKey, getBoxPass }: {
  deal: ArbiterCase; me?: `0x${string}`; chainKeys: ChainChatKeys | null;
  publicClient: PublicClient | undefined;
  signChatKey: () => GatedSignChatKey | null;
  getBoxPass: () => Promise<string>;
}) {
  const t = useTranslations();
  const [state, setState] = useState<BoxState>({ kind: 'idle' });
  /** Чтение ящика — секунды и два окна кошелька; вкладку за это время
   *  закрывают, а вкладки арбитра переключают между спорами. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /**
   * ⚠️ РЕШЕНИЕ ПО НАЖАТИЮ ВЫНЕСЕНО ЦЕЛИКОМ — `openDisputeBoxImpl` (правка
   * круга 1). Здесь остаётся только сборка зависимостей: что читать и куда
   * применять. Три исхода («ключа нет» → своя кнопка, разобранный отказ,
   * успех), гейт «не с чем идти» и проверка «жив ли ещё» живут в модуле и
   * меряются node-тестами (O1-O6), а не замком на текст исходника.
   */
  const open = useCallback(async (mayCreate: boolean) => {
    const sign = signChatKey();
    await openDisputeBoxImpl({
      ready: Boolean(me && sign),
      alive: () => mounted.current,
      apply: (next) => setState(next),
      // Одно нажатие — два обращения к кошельку подряд (ключ, потом пропуск).
      // Между ними обязан стоять гейт: на телефоне кошелёк уводит страницу, и
      // вторая подпись улетела бы в замёрзшую вкладку.
      read: () => runGatedKeyAction(
        () => openArbiterBoxSession(me!, sign!, { mayCreate }),
        async ({ session }) => {
          const pass = await getBoxPass();
          const agreement = deal.agreement;
          const r = await readDisputeBox({
            source: {
              list: () => listDisputeBox(pass, agreement),
              // ⚠️ КЛЮЧ ЕДЕТ ЦЕЛИКОМ, ДВУМЯ СЕГМЕНТАМИ — так объявила Задача 6
              // (договор шапки). Резать его на имя здесь нельзя: `fetchDisputeBag`
              // сама сверяет префикс с ящиком и на голом имени бросает TypeError.
              // Ключ из ЧУЖОГО ящика до неё не доезжает вовсе — `readDisputeBox`
              // отбраковывает такой `bagNameFromKey` ДО обращения, не тратя бюджет.
              fetch: (key) => fetchDisputeBag(pass, agreement, key),
            },
            own: session.keypair,
            agreement,
            me: me!,
            publicClient,
          });
          const keys = await claimKeysFromSession(session);
          const turn = publicClient ? await arbiterTurnOf(publicClient, agreement) : { known: false as const };
          return {
            reading: r,
            before: arbitersBefore(turn),
            deviceKey: deviceKeyVerdict(keys.boxKey, chainKeys),
          };
        },
      ),
    });
  }, [me, signChatKey, getBoxPass, deal.agreement, publicClient, chainKeys]);

  return (
    <div className="rounded-[18px] border border-white/[0.08] bg-[#0f0f11] p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-mono text-white/45">{shortAddr(deal.agreement)}</p>
        <div className="flex items-center gap-2">
          {/* Просьба предъявить — обычным сообщением в чат, и обеим сторонам:
              предъявляет любая, а просить арбитру бывает нужно именно ту, что
              молчит. Кнопки «записать, что просил и не ответили» в этой выкатке
              НЕТ (это Выкатка 2), и рисовать её нельзя.
              Стороны берутся из `getDetails`, который приезжает отдельным
              эффектом; пока не приехал — адрес нулевой, и ссылка не рисуется
              вовсе, вместо того чтобы вести в чат с `0x0000…`. */}
          {deal.client !== ZERO_ADDRESS && (
            <Link href={`/chat?peer=${deal.client}`} className="text-[11px] text-white/40 hover:text-white/70 flex items-center gap-1">
              <MessageCircle className="w-3 h-3" />{t('arbiter.presentations_ask_client')}
            </Link>
          )}
          {deal.executor !== ZERO_ADDRESS && (
            <Link href={`/chat?peer=${deal.executor}`} className="text-[11px] text-white/40 hover:text-white/70 flex items-center gap-1">
              <MessageCircle className="w-3 h-3" />{t('arbiter.presentations_ask_executor')}
            </Link>
          )}
          <Button size="sm" onClick={() => void open(false)} disabled={state.kind === 'reading'}>
            {state.kind === 'reading' ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            {t('arbiter.presentations_open_box')}
          </Button>
        </div>
      </div>

      {state.kind === 'key_needed' && (
        <div className="space-y-2">
          <p className="text-xs text-amber-300/85">{t('arbiter.presentations_key_needed')}</p>
          <Button size="sm" onClick={() => void open(true)}>{t('arbiter.presentations_key_button')}</Button>
        </div>
      )}
      {state.kind === 'failed' && <BoxFailureView refusal={state.refusal} />}
      {state.kind === 'reading' && <p className="text-xs text-white/40">{t('arbiter.presentations_reading')}</p>}
      {state.kind === 'done' && (
        <>
          <BoxSummaryView reading={state.reading} before={state.before} deviceKey={state.deviceKey} />
          <div className="space-y-2">
            {state.reading.presentations.map(b => (
              <PresentationBagView
                key={b.bagKey}
                bag={b}
                // Ответ цепи едет ЦЕЛИКОМ: порядок решает `anchorOrder`, и ему
                // нужна не только первая запись о молчании, но и то, накрыла ли
                // лента окно — иначе «записи нет» и «не смотрели так далеко»
                // на экране сольются.
                anchors={state.reading.anchors}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ArbiterPresentationsTab(props: ArbiterPresentationsTabProps) {
  const t = useTranslations();
  if (props.cases.length === 0) {
    return <p className="text-sm text-white/30 text-center py-10">{t('arbiter.presentations_no_cases')}</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-white/30 leading-relaxed flex items-start gap-1.5">
        <Inbox className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        {t('arbiter.presentations_desc')}
      </p>
      {props.cases.map(deal => (
        <DisputeBoxCard
          key={deal.agreement}
          deal={deal}
          me={props.me}
          chainKeys={props.chainKeys}
          publicClient={props.publicClient}
          signChatKey={props.signChatKey}
          getBoxPass={props.getBoxPass}
        />
      ))}
    </div>
  );
}
