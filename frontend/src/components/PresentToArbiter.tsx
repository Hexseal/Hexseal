'use client';

/**
 * PresentToArbiter.tsx — кнопка стороны: выбор, предупреждение, согласие,
 * отправка (план 4в-2, Задача 6).
 *
 * ⚠️ ЧТО ЗДЕСЬ РАЗМЕТКА, А ЧТО РЕШЕНИЕ. Все решения — в
 * `@/lib/presentToArbiter` и зовутся тестами напрямую; здесь только показ и
 * состояние. Нажатие в этом проекте замком не проверяется вовсе (нет ни
 * jsdom, ни @testing-library), поэтому разделение не стилистическое: всё, что
 * останется только внутри обработчика, не проверяется ничем.
 *
 * ⚠️ ЧЕТЫРЕ ЧАСТИ ЭКСПОРТИРОВАНЫ ОТДЕЛЬНО и берут ЧИСТЫЕ пропсы (единственный
 * хук — `useTranslations`): две модалки, строка о смене арбитра и строка
 * «положено · забрали». Это единственный способ отрисовать их тем же кодом,
 * которым их видит человек, не поднимая wagmi.
 *
 * ⚠️ ВЫБОР ЖИВЁТ В МОДАЛКЕ, А НЕ ЧЕКБОКСАМИ НА ПУЗЫРЯХ. Цена названа в
 * «Возражениях»: для длинного разговора список хуже потока. Выгода — панель
 * чата меняется на ОДНУ вставку, а не на состояние выбора в 2112 строках.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, usePublicClient, useReadContract, useWalletClient } from 'wagmi';
import { useTranslations } from 'next-intl';
import { toast } from 'react-hot-toast';
import { Loader2, Scale } from 'lucide-react';
import type { Abi } from 'viem';
import { AGREEMENT_ABI } from '@/config/contracts';
import type { ChatSession } from '@/lib/chatSession';
import { arbiterTurnOf, type ArbiterTurn } from '@/lib/arbiterTurn';
import {
  arbiterChangeWatchIO, comparePresentedWith, readDisputeArbiterKey, watchDisputeArbiter,
  type ArbiterChangeSignal, type PresentedTo,
} from '@/lib/disputeArbiter';
import {
  ensureChatKeyAttestation, type ChatKeyAttestation,
} from '@/lib/chatKeyAttestation';
import { fetchPeerChatKeys } from '@/hooks/useChatSession';
import { peekBagPass, requestBagPass } from '@/lib/chatTransport';
import { listDisputeBox, putDisputeBag } from '@/lib/disputeBox';
import { withWalletLock } from '@/lib/walletLock';
import { fittingMessageCount } from '@/lib/presentationBag';
// ⚠️ `arbiterBoxKeyBytes` не импортируется и здесь: байты печати приезжают
// готовыми в снимке Задачи 5 (`presentedFromKey`).
import { toPeerBoxKeyBytes, type ArbiterBoxKeyBytes } from '@/lib/presentation';
// ⚠️ `readPresentationDrafts`, А НЕ `unsentPresentationDrafts`: вход «вернуть
// отметки» обязан предлагать и УЖЕ ОТПРАВЛЕННОЕ — иначе сцены §2.3
// (арбитра сменили, просят предъявить заново) не существует вовсе.
import { readPresentationDrafts, type PresentationDraft } from '@/lib/presentationDraft';
import {
  BOX_POLL_MS, PRESENT_REFUSAL_KEYS, canSend, countLegacyExposed, draftKeepNotice,
  fitNotice, lastDraftOfDeal, otherAttestationsOf, pickingPrep, presentButtonVisible,
  presentWarning, presentedFromKey, readAgreementStatus, restoreMountImpl,
  selectableMessages, selectionFromContainer, sendPresentation, shouldPollBox,
  tickBoxImpl,
  type FitNotice, type PrepVerdict, type PresentableMessage, type SelectableMessage,
  type SentBagState, type WarnLine,
} from '@/lib/presentToArbiter';

export interface PresentToArbiterProps {
  agreement: `0x${string}`;
  peer: `0x${string}`;
  messages: readonly PresentableMessage[];
  session: ChatSession;
}

const idOf = (m: { sender: string; seq: number }): string => `${m.sender}|${m.seq}`;

/* ───────────────────────────── выбор ───────────────────────────── */

/**
 * Черновик, который можно предложить вернуть. ⚠️ `sent` — не украшение:
 * «собрано и не отправлено» и «предъявлялось, соберётся заново на нынешнем
 * ключе» — разные новости, и слова у них разные (C9).
 */
export interface PickerDraft { count: number; sent: boolean }

export interface PickerProps {
  open: boolean;
  rows: readonly SelectableMessage[];
  dropped: number;
  picked: ReadonlySet<string>;
  notice: FitNotice | null;
  /** Последний черновик ЭТОЙ сделки — отправленный или нет. `null` — нет такого. */
  draft: PickerDraft | null;
  onToggle: (id: string) => void;
  onUseDraft: () => void;
  onNext: () => void;
  onCancel: () => void;
}

export function PresentPickerModal(props: PickerProps) {
  const t = useTranslations();
  if (!props.open) return null;
  const n = props.notice;
  // «Дальше» заперта, пока выбор не влезает: сами НИЧЕГО не режем.
  const blocked = props.picked.size === 0
    || n === null || n.kind === 'unknown' || n.kind === 'partial' || n.kind === 'refused';
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 px-3 py-6">
      <div className="w-full max-w-lg rounded-[18px] border border-white/[0.08] bg-[#111113] p-4 space-y-3">
        <p className="text-sm font-semibold text-white/85">{t('chat.present_pick_title')}</p>
        <p className="text-[11px] text-white/45 leading-relaxed">{t('chat.present_pick_hint')}</p>

        {/* ⚠️ ВХОД В СОБРАННОЕ РАНЬШЕ. До этой задачи черновики не читал
            никто: 4в-1 научился переживать перезапуск, и записанное не
            читалось никогда. Здесь возвращается ВЫБОР, а не мешок: переслать
            сохранённое нельзя — разовые ключи запечатаны на прежнего
            арбитра, и текст говорит именно это.
            ⚠️ ДВА ТЕКСТА, А НЕ ОДИН: «собрано и не отправлено» — это одна
            новость, «уже предъявлялось — соберётся заново на нынешнем
            ключе» (сцена §2.3) совсем другая. Один на оба случая либо соврал
            бы «вы не отправляли», либо обещал бы пересылку запечатанного. */}
        {props.draft !== null && props.draft.count > 0 && (
          <div data-pick-draft className="rounded-[12px] border border-white/[0.08] px-3 py-2 space-y-1">
            <p className="text-[11px] text-white/55 leading-relaxed">
              {t(
                (props.draft.sent ? 'chat.present_draft_sent' : 'chat.present_draft_found') as Parameters<typeof t>[0],
                { n: props.draft.count } as never,
              )}
            </p>
            <button onClick={props.onUseDraft}
              className="text-[11px] text-primary hover:underline">
              {t('chat.present_draft_use')}
            </button>
          </div>
        )}

        <div className="max-h-[45vh] overflow-y-auto space-y-1 pr-1">
          {props.rows.map((m) => (
            <label key={idOf(m)} data-pick-row
              className="flex items-start gap-2 rounded-[10px] px-2 py-1.5 hover:bg-white/[0.04]">
              <input
                type="checkbox"
                checked={props.picked.has(idOf(m))}
                onChange={() => props.onToggle(idOf(m))}
                className="mt-0.5 flex-shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-[10px] text-white/30 font-mono">
                  {m.mine ? t('common.you') : `${m.sender.slice(0, 8)}…`} · #{m.seq}
                </span>
                <span className="block text-xs text-white/70 break-words">{m.text}</span>
                {/* ⚠️ ПОМЕТКА ВИДНА ДО ОТМЕТКИ, И ЭТО ГЛАВНОЕ (ревью, круг 2).
                    Человек должен понимать, КАКИЕ ИМЕННО его сообщения
                    открывают арбитру вложение, пока ещё выбирает, — а не
                    узнавать общее число уже в окне согласия. Ничего не
                    запрещаем: отметить такое сообщение он вправе, в споре
                    файл часто и есть суть дела. */}
                {m.legacyAttachmentExposed && (
                  <span data-pick-legacy className="block text-[10px] text-amber-400/80">
                    {t('chat.present_pick_legacy_mark')}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>

        {props.dropped > 0 && (
          <p className="text-[11px] text-amber-400/70" data-pick-dropped>
            {t('chat.present_pick_dropped', { n: props.dropped })}
          </p>
        )}
        {n?.kind === 'partial' && (
          <p className="text-[11px] text-amber-400/70" data-pick-fits>
            {t('chat.present_pick_fits', { n: n.fits, m: n.total })}
          </p>
        )}
        {n?.kind === 'unknown' && (
          <p className="text-[11px] text-amber-400/70" data-pick-fits>
            {t('chat.present_pick_fits_unknown')}
          </p>
        )}
        {n?.kind === 'refused' && (
          <p className="text-[11px] text-red-400/70" data-pick-fits>
            {t(PRESENT_REFUSAL_KEYS[n.reason] as Parameters<typeof t>[0])}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={props.onCancel}
            className="px-3 py-2 rounded-[10px] text-xs text-white/45 hover:text-white/75">
            {t('common.cancel')}
          </button>
          <button onClick={props.onNext} disabled={blocked}
            className="px-3 py-2 rounded-[10px] text-xs bg-primary text-white font-semibold disabled:opacity-40">
            {t('chat.present_pick_next')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── предупреждение и согласие ─────────────────────── */

export interface WarningProps {
  open: boolean;
  lines: readonly WarnLine[];
  consent: boolean;
  busy: boolean;
  canSendNow: boolean;
  onConsent: (v: boolean) => void;
  onSend: () => void;
  onCancel: () => void;
}

/**
 * ⚠️ СТРОКИ ПРЕДУПРЕЖДЕНИЯ ПРИХОДЯТ СПИСКОМ, а не пишутся здесь. Тест C3
 * сверяет разметку с тем, что назвала `presentWarning`: и число строк
 * (`data-warn-line`), и текст каждой. Поэтому «убрали строку из разметки при
 * живой функции» краснеет — ровно тот случай, который на текстовом замке
 * давал ноль.
 */
export function PresentWarningModal(props: WarningProps) {
  const t = useTranslations();
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 px-3 py-6">
      <div className="w-full max-w-lg rounded-[18px] border border-white/[0.08] bg-[#111113] p-4 space-y-3">
        <p className="text-sm font-semibold text-white/85">{t('chat.present_warn_title')}</p>
        <div className="space-y-2">
          {props.lines.map((l) => (
            <p key={l.key} data-warn-line className="text-[11px] text-white/55 leading-relaxed">
              {t(l.key as Parameters<typeof t>[0], l.params as never)}
            </p>
          ))}
        </div>
        <label className="flex items-start gap-2 pt-1">
          <input
            type="checkbox"
            checked={props.consent}
            onChange={(e) => props.onConsent(e.target.checked)}
            className="mt-0.5 flex-shrink-0"
          />
          <span className="text-[11px] text-white/70 leading-relaxed">{t('chat.present_consent')}</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={props.onCancel}
            className="px-3 py-2 rounded-[10px] text-xs text-white/45 hover:text-white/75">
            {t('common.cancel')}
          </button>
          <button onClick={props.onSend} disabled={!props.canSendNow}
            className="px-3 py-2 rounded-[10px] text-xs bg-primary text-white font-semibold disabled:opacity-40 inline-flex items-center gap-1.5">
            {props.busy && <Loader2 className="w-3 h-3 animate-spin" />}
            {t('chat.present_send')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────── смена арбитра и судьба мешка — чистые ───────────────── */

/**
 * ⚠️ ТРИ СИГНАЛА — ТРИ РАЗНЫХ ТЕКСТА, и это не украшение: «сменился арбитр»
 * (собирать заново), «повернул ключ» (тот же человек, но прежняя печать
 * мертва) и «спор бросили» (предъявлять пока некому) лечатся по-разному.
 * Ключи те же, что у отказов отправки: событие одно, словарь один.
 */
export function PresentChangeNotice(props: { signal: ArbiterChangeSignal | null }) {
  const t = useTranslations();
  if (!props.signal) return null;
  return (
    <span data-present-change className="text-[10px] text-amber-400/70">
      {t(PRESENT_REFUSAL_KEYS[props.signal.reason] as Parameters<typeof t>[0])}
    </span>
  );
}

/**
 * «Положено … · забрали …» — ВРЕМЕНЕМ СЕРВЕРА.
 *
 * ⚠️ Три состояния, и третье не молчание: `unknown` — это «узнать не
 * удалось» (описи не дали, или мешка в ней уже нет), и говорить в этом случае
 * «не забрали» значило бы соврать. Слов «прочитал» и «понял» здесь нет:
 * «забрали» — про байты (см. `DisputeBoxBag.fetchedAt`), и без имени
 * забравшего.
 * ⚠️ Строка рисуется и после ПЕРЕЗАГРУЗКИ вкладки: `sent` и время
 * поднимаются из черновика (`restoreSentBag`), а не живут в памяти вкладки.
 */
export function PresentSentLine(props: { state: SentBagState }) {
  const t = useTranslations();
  const s = props.state;
  if (s.kind === 'unknown') {
    return (
      <span data-present-sent className="text-[10px] text-white/40">
        {t('chat.present_fetch_unknown')}
      </span>
    );
  }
  return (
    <span data-present-sent className="text-[10px] text-emerald-400/60">
      {t('chat.present_sent')} · {new Date(s.uploadedAt).toLocaleTimeString()}
      {s.kind === 'fetched' && (
        <> · {t('chat.present_fetched', { time: new Date(s.fetchedAt).toLocaleTimeString() })}</>
      )}
    </span>
  );
}

/* ─────────────────────────────── кнопка ─────────────────────────────── */

/** Снимок, показанный человеку. ⚠️ ОДИН на предъявление: и в предупреждении,
 *  и в сборке, и в сверке перед складом участвует ОН, а не свежее чтение. */
interface Snapshot {
  presented: PresentedTo;
  /** ⚠️ Байты печати ИЗ ТОГО ЖЕ чтения цепи, готовыми. Своего перехода
   *  `arbiterBoxKeyBytes` в этой задаче нет ни одного. */
  arbiterBoxKey: ArbiterBoxKeyBytes;
  turn: ArbiterTurn;
  peerBoxKey: Uint8Array;
  otherAttestations: ChatKeyAttestation[];
  ownAttestation: ChatKeyAttestation;
}

export function PresentToArbiter({ agreement, peer, messages, session }: PresentToArbiterProps) {
  const t = useTranslations();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [stage, setStage] = useState<'idle' | 'picking' | 'warning'>('idle');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<FitNotice | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<PresentationDraft | null>(null);
  const [sent, setSent] = useState<{ key: string } | null>(null);
  const [boxState, setBoxState] = useState<SentBagState>({ kind: 'unknown' });
  const [change, setChange] = useState<ArbiterChangeSignal | null>(null);
  /** Кому предъявляли/собирались предъявить — для слежения. */
  const presentedRef = useRef<PresentedTo | null>(null);
  /**
   * Сеанс выбора: дешёвый снимок, взятый ОДИН раз на открытие модалки.
   * ⚠️ В `useRef`, а не в состоянии, намеренно: сеанс — не то, что рисуется,
   * а хранилище одного обещания. Через состояние он пересоздавался бы на
   * каждой перерисовке (то есть на каждой отметке), и вся правка свелась бы
   * к переносу той же беды на этаж ниже.
   */
  const prepSession = useRef<{ get: () => Promise<PrepVerdict> } | null>(null);
  /** Порядковый номер пересчёта. ⚠️ Человек щёлкает быстрее, чем считает
   *  крипто: без номера ответ ПРЕЖНЕГО набора, вернувшийся позже свежего,
   *  оставлял бы на экране «влезает N» от отменённого выбора. */
  const recountSeq = useRef(0);

  // Статус — СВОЁ чтение цепи, а не число из родителя: `dealContexts`
  // живёт столько, сколько живёт его запрос, а отправлять по устаревшему
  // числу значит показать «отправлено» там, где ничего не произошло.
  const { data: statusNum } = useReadContract({
    address: agreement, abi: AGREEMENT_ABI as Abi, functionName: 'status',
  }) as { data: number | undefined };

  const { data: details } = useReadContract({
    address: agreement, abi: AGREEMENT_ABI as Abi, functionName: 'getDetails',
  }) as { data: unknown };
  const isParty = useMemo(() => {
    const me = address?.toLowerCase();
    if (!me || !details) return false;
    // ⚠️ ТА ЖЕ РАЗВИЛКА, ЧТО В `DealActionBar.tsx:131-137`: viem отдаёт кортеж
    // то именованным объектом, то массивом — в зависимости от ABI. Читать
    // только по индексу значит уронить признак стороны на половине сборок.
    const obj = details as Record<string, unknown>;
    const arr = details as readonly unknown[];
    const get = (name: string, idx: number): unknown => obj[name] ?? arr[idx];
    const client = String(get('client_', 0) ?? '').toLowerCase();
    const executor = String(get('executor_', 1) ?? '').toLowerCase();
    return me === client || me === executor;
  }, [address, details]);

  const { rows, dropped } = useMemo(() => selectableMessages(messages), [messages]);
  /** Отмеченные СТРОКАМИ — из них же считается и выбор, и число старых
   *  вложений: два прохода по одному набору вместо двух разных наборов. */
  const selectedRows = useMemo(
    () => rows.filter(r => picked.has(idOf(r))), [rows, picked]);
  const selected = useMemo(
    () => selectedRows.map(r => ({ seq: r.seq, sender: r.sender })), [selectedRows]);

  /**
   * ДОРОГОЙ СНИМОК: кто ведёт спор, чем его печатать, КАКОЙ ПО СЧЁТУ, чем
   * заверены ключи.
   *
   * ⚠️ ЗОВЁТСЯ РОВНО В ОДНОМ МЕСТЕ — `toWarning()`, где результат КЛАДЁТСЯ В
   * СОСТОЯНИЕ и дальше используется как есть. В `doSend` его НЕ
   * пересобирают: иначе человек соглашается про одного арбитра, а мешок
   * уезжает другому. И в пересчёте «сколько влезает» его НЕТ: там дешёвый
   * снимок сеанса (`pickingPrep`), потому что здесь живёт `arbiterTurnOf` —
   * до 64 кусков `eth_getLogs` на вызов, а зовётся пересчёт на каждую
   * отметку.
   */
  const takeSnapshot = useCallback(async (): Promise<Snapshot | null> => {
    if (!publicClient || !walletClient || !address) return null;
    // Кто ведёт спор и чем печатать — ЗАДАЧА 5, одно правило на фронт и релеер.
    const key = await readDisputeArbiterKey(publicClient, agreement);
    if (key.state !== 'ready') {
      if (key.state === 'no_arbiter') toast.error(t('chat.present_err_arbiter_left'));
      else if (key.state === 'no_key') toast.error(t('chat.present_err_arbiter_has_no_key'));
      else toast.error(t('chat.present_err_chain_unavailable'));
      return null;
    }
    const peerKeys = await fetchPeerChatKeys(peer);
    // ⚠️ ЗОВЁТСЯ ТОЛЬКО ПО ЧЕЛОВЕЧЕСКОМУ ДЕЙСТВИЮ (докстринг
    // `ensureChatKeyAttestation`): нажали «предъявить арбитру».
    const ownAttestation = await withWalletLock(address, () =>
      ensureChatKeyAttestation(walletClient, session, publicClient));
    return {
      // ⚠️ АДРЕС, КЛЮЧ И БАЙТЫ ПЕЧАТИ — ИЗ ОДНОГО ЧТЕНИЯ, и раскладывает их
      // `presentedFromKey`, а не выражение здесь: у «того же самого объекта»
      // должен быть вызываемый тестом хозяин (T28).
      ...presentedFromKey(key),
      turn: await arbiterTurnOf(publicClient, agreement),
      peerBoxKey: peerKeys.boxKey,
      // ⚠️ СПИСКОМ: нынешнее заверение собеседника И вся его история
      // (пункт 48). Одно нынешнее превратило бы честные прежние сообщения в
      // `wrong_keys` у арбитра.
      otherAttestations: otherAttestationsOf(peerKeys),
      ownAttestation,
    };
  }, [address, agreement, peer, publicClient, session, t, walletClient]);

  const openPicker = useCallback(async () => {
    setPicked(new Set());
    setNotice(null);
    setConsent(false);        // согласие — ЗАНОВО на каждое предъявление
    setChange(null);
    setStage('picking');
    // ⚠️ Сеанс гасится ДО раннего выхода: комментарий ниже обещает «сеанс
    // сменяется на каждое открытие», а на ветке «кошелька нет» прежний сеанс
    // прежде доживал до следующего захода — с ключом печати прошлого арбитра.
    prepSession.current = null;
    if (!address) return;
    /**
     * ⚠️ ДЕШЁВЫЙ СНИМОК — ОДИН НА ОТКРЫТИЕ ВЫБОРА. Сеанс заводится здесь, а
     * добывает лениво, при первом обращении из пересчёта: окно кошелька за
     * то, что человек просто заглянул в список и закрыл его, платить не
     * должен. Счёта арбитров в сеансе нет вовсе — он в `takeSnapshot`.
     */
    // ⚠️ Сеанс СМЕНЯЕТСЯ на каждое открытие, а не переиспользуется: между
    // двумя заходами арбитра могли сменить, и прошлый ключ печати — прошлый.
    prepSession.current = (publicClient && walletClient)
      ? pickingPrep({
        readArbiterKey: () => readDisputeArbiterKey(publicClient, agreement),
        readPeerKeys: () => fetchPeerChatKeys(peer),
        ensureAttestation: () => withWalletLock(address, () =>
          ensureChatKeyAttestation(walletClient, session, publicClient)),
      })
      : null;
    // Собранное раньше по ЭТОЙ сделке — самое свежее, ОТПРАВЛЕННОЕ ИЛИ НЕТ.
    // ⚠️ `[0]`, а не `[длина − 1]`: список отсортирован по `issuedAt`
    // убыванию, и отбор живёт в `lastDraftOfDeal` (T31, T32).
    setDraft(lastDraftOfDeal(
      await readPresentationDrafts(address.toLowerCase() as `0x${string}`), agreement));
  }, [address, agreement, peer, publicClient, session, walletClient]);

  /** Выбор по набору отметок. ⚠️ Берёт набор АРГУМЕНТОМ, а не из состояния:
   *  `setPicked` не меняет `picked` в текущем проходе, и пересчёт по
   *  состоянию считал бы прошлый выбор — на один чекбокс всегда отстающий. */
  const selectionOf = useCallback(
    (ids: ReadonlySet<string>) => rows.filter(r => ids.has(idOf(r)))
      .map(r => ({ seq: r.seq, sender: r.sender })),
    [rows],
  );

  /**
   * Пересчёт «сколько влезает».
   *
   * ⚠️ НИ ОДНОГО ОБРАЩЕНИЯ К ЦЕПИ, СПРАВОЧНИКУ И КОШЕЛЬКУ НА ОТМЕТКУ.
   * Прежняя редакция брала здесь `snap ?? await takeSnapshot()`, а `snap` во
   * время выбора ВСЕГДА `null` (его ставит только `toWarning`) — то есть
   * каждая галочка стоила чтения цепи, обхода логов `arbiterTurnOf` и захода
   * в кошелёк. Теперь снимок берёт сеанс, и он помнит своё обещание: двадцать
   * отметок — один поход (T30).
   * ⚠️ Что осталось дорогим и осталось намеренно: сама `fittingMessageCount`
   * пересобирает предъявление, то есть тратит крипто-операцию на кадр. Это
   * названо в «Возражениях» (п. 3) и не чинится здесь — оценка по верхним
   * границам живёт внутри сборщика, наружу её выводит Задача 4.
   */
  const recount = useCallback(async (
    sel: { seq: number; sender: `0x${string}` }[],
  ) => {
    const seq = ++recountSeq.current;
    if (sel.length === 0) { setNotice(null); return; }
    const picking = prepSession.current;
    // ⚠️ Причина, а не пустота: сеанса нет, когда нет кошелька или узла, и
    // человек иначе смотрел бы на запертую кнопку «Дальше» без единого слова.
    if (!picking) { setNotice({ kind: 'refused', reason: 'chain_unavailable' }); return; }
    const got = await picking.get();
    if (seq !== recountSeq.current) return;   // отметки успели поменяться
    // Снимка нет — говорим ПОЧЕМУ, а не оставляем пустое место у запертой
    // кнопки: «цепь молчит», «арбитра нет», «ключи не заверены» лечатся
    // по-разному, и слова у них разные.
    if (!got.ok) { setNotice({ kind: 'refused', reason: got.reason }); return; }
    const prep = got.prep;
    const verdict = await fittingMessageCount({
      dealId: agreement.toLowerCase() as `0x${string}`,
      presenter: (address ?? '0x').toLowerCase() as `0x${string}`,
      peer,
      arbiterBoxKey: prep.arbiterBoxKey,
      peerBoxKey: toPeerBoxKeyBytes(prep.peerBoxKey),
      selected: sel,
      session,
      ownAttestation: prep.ownAttestation,
      otherAttestations: prep.otherAttestations,
      publicClient: publicClient ?? undefined,
    });
    if (seq !== recountSeq.current) return;   // пока считали, набор сменился
    setNotice(fitNotice(verdict, sel.length));
  }, [address, agreement, peer, publicClient, session]);

  /** Вернуть отметки из собранного раньше. ⚠️ ВЫБОР, А НЕ МЕШОК.
   *  ⚠️ Имя НЕ начинается с `use`: `useDraft` гейт хуков счёл бы своим хуком,
   *  и число его ошибок выросло бы сверх двух, которые красны и на чистом
   *  `main`. */
  const applyDraft = useCallback(() => {
    if (!draft) return;
    const wanted = new Set(selectionFromContainer(draft.container).map(idOf));
    // ⚠️ Отметится только то, что есть в ЗАГРУЖЕННОМ куске переписки; выпало
    // сообщение из окна — отметка не вернётся. Названо в «Возражениях», п. 6.
    const next = new Set(rows.map(idOf).filter(id => wanted.has(id)));
    setPicked(next);
    setNotice(null);
    void recount(selectionOf(next));
  }, [draft, recount, rows, selectionOf]);

  const toWarning = useCallback(async () => {
    const prep = await takeSnapshot();
    if (!prep) return;
    setSnap(prep);
    presentedRef.current = prep.presented;   // с этого момента следим за ним
    setStage('warning');
  }, [takeSnapshot]);

  /** ⚠️ ОБРАБОТЧИК — ТОНКИЙ, И СНИМОК В НЁМ НЕ ПЕРЕСОБИРАЕТСЯ. */
  const doSend = useCallback(async () => {
    if (!publicClient || !walletClient || !address || !snap) return;
    setBusy(true);
    try {
      const verdict = await sendPresentation({
        agreement,
        presenter: address.toLowerCase() as `0x${string}`,
        peer,
        // ⚠️ ТОТ ЖЕ СНИМОК, что показан в предупреждении, — и адрес, и ключ,
        // и байты печати из него же.
        presented: snap.presented,
        arbiterBoxKey: snap.arbiterBoxKey,
        peerBoxKey: snap.peerBoxKey,
        selected,
        session,
        ownAttestation: snap.ownAttestation,
        otherAttestations: snap.otherAttestations,
        consent,
        publicClient,
        readStatus: () => readAgreementStatus(publicClient, agreement),
        readArbiterNow: () => readDisputeArbiterKey(publicClient, agreement),
        getPass: () => withWalletLock(address, async () => (await requestBagPass(
          (m) => walletClient.signMessage({ account: walletClient.account!, message: m }),
          address.toLowerCase() as `0x${string}`,
        )).pass),
        put: (pass, box, sealed, sealedFor) => putDisputeBag(pass, box, sealed, sealedFor),
      });
      if (!verdict.ok) {
        toast.error(t(PRESENT_REFUSAL_KEYS[verdict.reason] as Parameters<typeof t>[0]));
        // Сменился арбитр или ключ — снимок мёртв, согласие спрашивается заново.
        if (verdict.reason === 'arbiter_changed' || verdict.reason === 'key_changed'
          || verdict.reason === 'arbiter_left') {
          setSnap(null); setConsent(false); setStage('idle');
        }
        return;
      }
      setSent({ key: verdict.bagKey });
      // Время — СЕРВЕРНОЕ, из ответа склада; опись потом уточнит и «забрали».
      setBoxState({ kind: 'placed', uploadedAt: verdict.uploadedAt });
      setDraft(null);
      setStage('idle');
      setConsent(false);   // следующее предъявление спросит заново
      toast.success(t('chat.present_sent'));
      // ⚠️ ЗАПИСЬ НА УСТРОЙСТВЕ МОГЛА НЕ ЛЕЧЬ, и человек об этом узнаёт
      // (ревью, круг 1, I-4). Мешок при этом в ящике — отправка удалась;
      // не удалась память вкладки, и последствие у неё заметное.
      const kept = draftKeepNotice(verdict);
      if (kept) toast(t(kept as Parameters<typeof t>[0]));
    } finally {
      setBusy(false);
    }
  }, [address, agreement, consent, peer, publicClient, selected, session, snap, t, walletClient]);

  const visible = presentButtonVisible({ status: statusNum, isParty });

  /**
   * СЛЕЖЕНИЕ ЗА СМЕНОЙ АРБИТРА И КЛЮЧА (пункт 3 Выкатки 1).
   *
   * ⚠️ Логи — ПОВОД перечитать, а не авторитет: `routeArbiterChangeLogs`
   * Задачи 5 так и написана. Поэтому на каждый сигнал делается свежее чтение
   * и сверка со СНИМКОМ через `comparePresentedWith` — та же дверь, что перед
   * отправкой. Без этого сторона узнавала бы о смене арбитра только отказом в
   * момент, когда уже всё собрала и нажала «Отправить».
   */
  useEffect(() => {
    if (!visible || !publicClient || typeof document === 'undefined') return;
    return watchDisputeArbiter({
      io: arbiterChangeWatchIO(publicClient),
      doc: document,
      agreement,
      presentedTo: () => presentedRef.current?.arbiter ?? null,
      onChange: () => {
        void (async () => {
          const presented = presentedRef.current;
          if (!presented) return;
          const now = await readDisputeArbiterKey(publicClient, agreement);
          if (now.state === 'unreadable') return;      // не спросили ≠ сменился
          const signal = comparePresentedWith(presented, now);
          if (!signal) return;                          // лог сказал, цепь не подтвердила
          setChange(signal);
          setSnap(null); setConsent(false); setStage('idle');
        })();
      },
      onError: (e) => { console.warn('[present] слежение за арбитром:', e); },
    });
  }, [agreement, publicClient, visible]);

  /**
   * ПЕРЕЗАГРУЗИЛИ ВКЛАДКУ — «положено» поднимается из ЧЕРНОВИКА.
   *
   * ⚠️ БЕЗ ЭТОГО ЧЕЛОВЕК ВИДИТ ПУСТОЕ МЕСТО ТАМ, ГДЕ МЕШОК ЛЕЖИТ. «Положено»
   * и «забрали» — единственное, что сторона получает взамен отправленной
   * переписки; держать их только в состоянии React значит терять их при
   * закрытии вкладки, а вместе с ними и такт описи (он гейтится тем же
   * `sent`). Черновик это помнит: `markPresentationSent` пишет `bagKey` и
   * СЕРВЕРНЫЙ `sentAt`.
   *
   * ⚠️ ФУНКЦИОНАЛЬНОЕ ОБНОВЛЕНИЕ, А НЕ ПРЯМАЯ ЗАПИСЬ: чтение диска
   * асинхронное, и если человек успел отправить заново раньше, чем оно
   * вернулось, восстановленное СТАРОЕ не должно затирать свежее.
   *
   * ⚠️ ТЕЛО ЭФФЕКТА ВЫНЕСЕНО ЦЕЛИКОМ — `restoreMountImpl` (ревью, круг 1,
   * I-1), и вместе с ним вынесены ОБА правила слияния, которых прежде не
   * сторожило ничто: «восстановленное старое не затирает свежее» и «известное
   * не понижаем». Node-тест зовёт её напрямую и меряет работу. Здесь остаётся
   * только проводка — её сторожит второй, ТЕКСТОВЫЙ слой
   * (`components/presentToArbiter.test.tsx`, C11), и его природа названа там
   * вслух. Само нажатие по-прежнему не проверяется ничем.
   */
  useEffect(() => {
    if (!address) return;
    let alive = true;
    void restoreMountImpl({
      presenter: address.toLowerCase() as `0x${string}`,
      agreement,
      alive: () => alive,
      applySent: (fn) => setSent(fn),
      applyBox: (fn) => setBoxState(fn),
    });
    return () => { alive = false; };
  }, [address, agreement]);

  /**
   * «ЗАБРАЛИ» + ВРЕМЯ — из описи, по такту.
   *
   * ⚠️ КОШЕЛЁК НЕ БУДИМ: пропуск берётся из кэша (`peekBagPass`). Нет
   * пропуска — не опрашиваем вовсе и остаёмся с тем, что знаем («положено» +
   * время из ответа склада или из черновика). Такт `BOX_POLL_MS` тратит общий
   * адресный бюджет чтения (тот же, что у склада), своего счёта у ящика нет.
   *
   * ⚠️ ОТКАЗ ОПИСИ НЕ СТИРАЕТ ТОГО, ЧТО УЖЕ ИЗВЕСТНО, и `unknown` при
   * НЕДОВЕРЕННОЙ описи не понижает «положено» (ревью, круг 1, I-3). Оба
   * правила живут в `tickBoxImpl`/`boxStateFromList` и меряются node-тестами;
   * здесь остаётся такт и проводка.
   *
   * ⚠️ ПОСЛЕ «ЗАБРАЛИ» ОПРОС ПРЕКРАЩАЕТСЯ (`shouldPollBox`): состояние
   * конечное, узнавать больше нечего, а бюджет чтения общий со складом. Гейта
   * по видимости вкладки здесь НЕТ — это открытый пункт 38, и он назван, а не
   * сделан молча.
   */
  useEffect(() => {
    if (!sent || !address) return;
    if (!shouldPollBox(boxState)) return;
    let alive = true;
    const io = {
      presenter: address.toLowerCase() as `0x${string}`,
      agreement,
      bagKey: sent.key,
      alive: () => alive,
      peekPass: peekBagPass,
      list: listDisputeBox,
      applyBox: (fn: (prev: SentBagState) => SentBagState) => setBoxState(fn),
    };
    const tick = (): void => { void tickBoxImpl(io); };
    tick();
    const id = setInterval(tick, BOX_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [address, agreement, sent, boxState]);

  if (!visible) return null;

  return (
    <>
      <button
        data-present-btn
        onClick={() => { void openPicker(); }}
        className="flex items-center gap-1 text-[11px] rounded-[8px] px-1.5 py-1 text-white/30 hover:text-white/60 hover:bg-white/[0.05] transition-colors"
        title={t('chat.present_btn')}
      >
        <Scale className="w-3 h-3 flex-shrink-0" />
        <span className="hidden sm:inline">{t('chat.present_btn')}</span>
      </button>
      {sent !== null && <PresentSentLine state={boxState} />}
      <PresentChangeNotice signal={change} />
      <PresentPickerModal
        open={stage === 'picking'}
        rows={rows}
        dropped={dropped}
        picked={picked}
        notice={notice}
        draft={draft
          ? { count: selectionFromContainer(draft.container).length, sent: draft.state === 'sent' }
          : null}
        onToggle={(id) => {
          // ⚠️ Набор считается ЗДЕСЬ и передаётся дальше значением: после
          // `setPicked` состояние в этом проходе прежнее, и пересчёт «из
          // состояния» отставал бы ровно на одну отметку — надпись «влезает
          // N» врала бы каждый раз.
          const next = new Set(picked);
          if (next.has(id)) next.delete(id); else next.add(id);
          setPicked(next);
          setNotice(null);
          void recount(selectionOf(next));
        }}
        onUseDraft={applyDraft}
        onNext={() => { void toWarning(); }}
        onCancel={() => setStage('idle')}
      />
      {/* ⚠️ ПРЕДУПРЕЖДЕНИЕ РИСУЕТСЯ ТОЛЬКО ПО СНИМКУ. Нет снимка — нет и
          модалки: показывать «Получит арбитр 0x0000…» значит спрашивать
          согласие про никого. */}
      {snap && (
        <PresentWarningModal
          open={stage === 'warning'}
          lines={presentWarning({
            count: selected.length,
            arbiter: snap.presented.arbiter,
            turn: snap.turn,
            // ⚠️ ПО ОТМЕЧЕННЫМ, а не по всей переписке (ревью, круг 2).
            legacyExposed: countLegacyExposed(selectedRows),
          }).lines}
          consent={consent}
          busy={busy}
          canSendNow={canSend({ consent, selected: selected.length, busy, status: statusNum })}
          onConsent={setConsent}
          onSend={() => { void doSend(); }}
          onCancel={() => { setStage('idle'); setConsent(false); }}
        />
      )}
    </>
  );
}
