'use client';

/**
 * useKeyAnnouncement.ts — объявлен ли наш ключ, и кнопка, которая это лечит.
 *
 * ─── ЧТО ЗДЕСЬ И ЧЕГО ЗДЕСЬ НЕТ ─────────────────────────────────────────────
 *
 * Все решения — в `lib/chatAnnounce.ts`, чистыми функциями, и заперты замками
 * там же (`chatAnnounce.test.ts` — таблица, `__stand__/chatAnnounceKey.test.ts`
 * — настоящий справочник). Здесь только состояние и его проводка: у фронта нет
 * ни jsdom, ни testing-library, отрисовать хук и проверить его эффекты НЕЧЕМ.
 * Значит всё, что нельзя проверить, обязано быть тривиальным.
 *
 * ─── ПОЧЕМУ СКЛАД ОБЩИЙ, А НЕ СВОЙ У КАЖДОГО ЭКЗЕМПЛЯРА ─────────────────────
 *
 * `useKeyAnnouncement()` живёт в нескольких местах страницы сразу: в панели
 * переписки, в списке переписок и внутри `usePairChat`. Свой склад у каждого
 * означал бы три чтения справочника на одно открытие чата и — хуже — ТРИ
 * одновременных попытки объявить ключ, то есть три окна кошелька. Второе
 * одновременное окно прилетает как `-32002`, и в мобильном MetaMask его нечем
 * отменить.
 *
 * Поэтому склад — на модуль, по адресу, с дедупом в полёте. Ровно та же
 * дисциплина, что у просьбы завести ключ (`armChatSession`) и у пропуска
 * (`requestBagPass`), и по той же причине.
 *
 * ⚠️ НЕ ЗОВЁТСЯ ИЗ ШАПКИ. Хук ходит в справочник, а шапка живёт на каждой
 * странице — там это был бы лишний запрос на каждый переход. Зовут его только
 * половины чата, то есть ровно те места, попадание в которые и означает
 * «человек пришёл в чат».
 */

import { useCallback, useEffect, useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { announceNeedsPress, announceMayAuto } from '@/lib/chatAnnounce';
import {
  readStandingInto, announceInto, keyAnnouncementState, ownKeyStanding,
  subscribeKeyAnnouncement,
} from '@/lib/chatAnnounceStore';
import { checkSignatureGate, clearWalletHandoff } from '@/lib/chatSignatureGate';
import { useChatSession, fetchPeerChatKeys, publishChatKeys, getBagPass } from '@/hooks/useChatSession';
import type { ChatSession } from '@/lib/chatSession';
import type { KeyStanding, AnnounceAttempt } from '@/lib/chatAnnounce';
import { RESTORE_RECOVERY_EVENT } from '@/components/RecoveryCodeGate';

/* Склад переехал в `@/lib/chatAnnounceStore` — он обязан быть без React, иначе
 * порог пропуска в `getBagPass` замыкает кольцо импортов. Здесь переэкспорт для
 * прежних импортов. */
export {
  ownKeyStanding, mailboxWorthPollingFor, keyAnnouncementState,
  _resetKeyAnnouncementForTest,
} from '@/lib/chatAnnounceStore';

/** Настоящие зависимости объявления: пропуск РАДИ ЗАПИСИ и сама запись. */
function announceDeps(
  address: `0x${string}`,
  signMessageAsync: (args: { message: string }) => Promise<string>,
) {
  return {
    // `purpose: 'announce'` — иначе порог ящика отказал бы ровно тому вызову,
    // который его и снимает (объявиться нельзя без пропуска, пропуск нельзя без
    // объявления). Разбор — докстринг `getBagPass`.
    getPass: (opts: { humanAsked: boolean }) =>
      getBagPass(address, signMessageAsync, undefined, { ...opts, purpose: 'announce' as const }),
    publish: publishChatKeys,
  };
}

export interface KeyAnnouncementValue {
  standing: KeyStanding;
  attempt: AnnounceAttempt;
  /**
   * Показать «Вам пока не могут писать» и кнопку. Уже готовое решение, а не
   * сырые признаки: собирать его в разметке значило бы дать ему разъехаться
   * между панелью и списком — что в этом проекте уже случалось (находка К-2).
   */
  needsPress: boolean;
  /** Объявление идёт прямо сейчас — кнопка обязана быть занята. */
  busy: boolean;
  /** Нажатие человека. Только отсюда объявление проходит порог. */
  announce: () => void;
  /**
   * Позвать вход по коду восстановления.
   *
   * ⚠️ ЕДИНСТВЕННЫЙ ВЫХОД ПРИ ЧУЖОМ КЛЮЧЕ, КОТОРЫЙ НИЧЕГО НЕ ЛОМАЕТ. Код даёт тот
   * же ключ, что на другом устройстве, — значит справочник менять не надо вовсе.
   * Привратник (`RecoveryCodeGate`) уже слушает это событие и уже смонтирован
   * ровно один раз на приложение; здесь только зов, своей модалки не заводим.
   */
  restoreFromCode: () => void;
  errorCode: string | null;
}

export function useKeyAnnouncement(): KeyAnnouncementValue {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { session } = useChatSession();
  const [, bump] = useState(0);

  // Подписка на общий склад: любое изменение перерисовывает всех, кто спрашивал,
  // а не только того, кто спросил последним.
  useEffect(() => subscribeKeyAnnouncement(() => bump(n => n + 1)), []);

  // Возвращение страницы в глаза меняет ВЕРДИКТ ПОРОГА, а значит и то, что видно
  // на экране: свёрнутое приложение кнопки не показывало (показывать некому), и
  // без этой перерисовки она не появилась бы и после возврата.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const fn = () => bump(n => n + 1);
    document.addEventListener('visibilitychange', fn);
    return () => { document.removeEventListener('visibilitychange', fn); };
  }, []);

  const st = keyAnnouncementState(address);
  const gate = checkSignatureGate(false);
  const input = { keyOnDevice: !!session, standing: st.standing, attempt: st.attempt, gate };

  // Спросить справочник — один раз на адрес, как только ключ на устройстве есть.
  useEffect(() => {
    if (!address || !session) return;
    if (ownKeyStanding(address) !== 'unknown') return;
    void readStandingInto(address as `0x${string}`, session as ChatSession, fetchPeerChatKeys);
  }, [address, session]);

  // Объявить самим — там, где это разрешено (десктоп: страница не пропадала).
  // Отдельным эффектом, а не внутри чтения: разрешение зависит от порога, а он
  // меняется во времени.
  useEffect(() => {
    if (!address || !session) return;
    if (!announceMayAuto({ keyOnDevice: true, standing: st.standing, attempt: st.attempt, gate })) return;
    void announceInto(address as `0x${string}`, session as ChatSession, false,
      announceDeps(address as `0x${string}`, signMessageAsync));
  }, [address, session, st.standing, st.attempt, gate, signMessageAsync]);

  const restoreFromCode = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new Event(RESTORE_RECOVERY_EVENT));
  }, []);

  const announce = useCallback(() => {
    if (!address || !session) return;
    // Нажатие обнуляет память об уходе к кошельку: иначе второе нажатие после
    // успешной подписи упиралось бы в отметку, оставленную первым.
    clearWalletHandoff();
    void announceInto(address as `0x${string}`, session as ChatSession, true,
      announceDeps(address as `0x${string}`, signMessageAsync));
  }, [address, session, signMessageAsync]);

  return {
    standing: st.standing, attempt: st.attempt,
    needsPress: announceNeedsPress(input),
    busy: st.attempt === 'busy',
    announce,
    restoreFromCode,
    errorCode: st.errorCode,
  };
}
