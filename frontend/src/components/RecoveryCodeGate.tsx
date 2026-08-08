"use client";

/**
 * RecoveryCodeGate.tsx — привратник кода восстановления.
 *
 * Держит состояние окна и связывает три вещи, которые иначе не встретились
 * бы: хук сеанса (`useChatSession`), чистую логику (`lib/chatRecovery.ts`) и
 * само окно (`RecoveryCodeModal.tsx`).
 *
 * ─── ПОЧЕМУ РОВНО ОДИН НА ПРИЛОЖЕНИЕ ───────────────────────────────────
 *
 * `useChatSession()` живёт в нескольких компонентах СРАЗУ — меню кошелька,
 * панель чата, страница чата. На первом открытии все они присоединяются к
 * одному вызову `openSession` (`_inFlight` в `chatSession.ts`) и получают
 * ОДИН И ТОТ ЖЕ объект сеанса, то есть у всех `recoveryCode` окажется
 * непустым одновременно. Смонтируй окно в каждом — человек получит три окна
 * поверх друг друга. Поэтому монтируется он ровно один раз, в общей обёртке
 * (`app/client-layout.tsx`), и это заперто `lib/chatRecoveryWiring.test.ts`.
 *
 * ─── ПОЧЕМУ ЧЕРЕЗ СОБЫТИЕ ОКНА, А НЕ ЧЕРЕЗ КОНТЕКСТ ────────────────────
 *
 * Тот же приём, которым в этом проекте открывается онбординг
 * (`hexseal:open-onboarding`, `app/client-layout.tsx`): показать код просят
 * места, которые с привратником не соседствуют в дереве (меню кошелька в
 * шапке, плашка внутри переписки). Контекст ради двух кнопок протянул бы
 * провайдер через всё приложение.
 *
 * ─── ЧЕГО ЗДЕСЬ НЕТ ────────────────────────────────────────────────────
 *
 *  - НЕТ решений. Годен ли код, какие спросить слова, сошлись ли ответы —
 *    всё в `lib/chatRecovery.ts`, где это заперто тестами. Здесь только
 *    состояние и вызовы: у фронта нет jsdom, и то, что нельзя проверить,
 *    обязано быть тривиальным.
 *  - НЕТ кода в журнале, в `localStorage` и в сериализации. Гейт —
 *    `lib/chatRecoveryHygiene.test.ts`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { toast } from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { useChatSession, signChatKeyLocked } from '@/hooks/useChatSession';
import {
  hasRecoveryCode,
  openRecoveryPrompt,
  checkRecoveryAnswers,
  readRecoveryCode,
  markRecoveryConfirmed,
  forgetRecoveryConfirmed,
  isRecoveryConfirmed,
  recoveryReminderVisible,
  restoreErrorKey,
  unknownWordPosition,
} from '@/lib/chatRecovery';
import {
  openSessionFromRecoveryCode, forgetSession, ChatSessionError,
} from '@/lib/chatSession';
import { CHAT_KEY_TYPED_DATA } from '@/lib/chatCrypto';
import { RecoveryCodeModal } from './RecoveryCodeModal';
import { RecoveryRestoreModal } from './RecoveryRestoreModal';
import { DisableChatModal } from './DisableChatModal';

/** Просьба показать код. Слушает привратник, шлют меню кошелька и плашка. */
export const SHOW_RECOVERY_EVENT = 'hexseal:show-recovery-code';
/** Просьба открыть ВВОД кода. Шлют меню кошелька и экран «чат не открылся». */
export const RESTORE_RECOVERY_EVENT = 'hexseal:restore-recovery-code';
/** Просьба ОТКЛЮЧИТЬ чат. Именно просьба: ключ снимается только после
 *  подтверждения, и цена нажатия у двух родов кошелька разная (К-1). */
export const DISABLE_CHAT_EVENT = 'hexseal:disable-chat';
/** Код подтверждён — плашке пора исчезнуть. */
export const RECOVERY_CONFIRMED_EVENT = 'hexseal:recovery-confirmed';

export function RecoveryCodeGate(): React.ReactElement | null {
  const { address } = useAccount();
  const { session, recoveryCode, retry, disable } = useChatSession();

  const [prompt, setPrompt] = useState<{ words: string[]; positions: number[] } | null>(null);
  const [step, setStep] = useState<'show' | 'check'>('show');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [failed, setFailed] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  /** Открывала ли эта вкладка окно САМА. Голый признак, без кода: хук отдаёт
   *  `recoveryCode` непустым всё время, пока сеанс жив, а показать его сам
   *  собой полагается один раз — иначе окно возвращалось бы на каждый
   *  перерендер после «пропустить». */
  const autoShown = useRef(false);

  const open = useCallback((code: string | null) => {
    const next = openRecoveryPrompt(code);
    if (!next) return; // негодный код — окна не будет, экран цел
    setPrompt(next);
    setStep('show');
    setAnswers({});
    setFailed(null);
    setCopied(false);
  }, []);

  // ── Сам собой: код только что заведён ──
  // `recoveryCode` непуст ТОЛЬКО когда код есть и его надо показать
  // (`origin === 'recovery' && !restored` — решает хук). Отметка «записал»
  // здесь НЕ спрашивается и снимается: раз выдан новый код, прежняя отметка
  // относится к коду, которого больше нет.
  useEffect(() => {
    if (!recoveryCode || autoShown.current) return;
    autoShown.current = true;
    forgetRecoveryConfirmed(address);
    open(recoveryCode);
  }, [recoveryCode, address, open]);

  // Смена кошелька — новый человек, новый разговор про код.
  useEffect(() => {
    autoShown.current = false;
    setPrompt(null);
  }, [address]);

  // ── По просьбе: меню кошелька или плашка в чате ──
  useEffect(() => {
    const handler = () => open(readRecoveryCode(session));
    window.addEventListener(SHOW_RECOVERY_EVENT, handler);
    return () => window.removeEventListener(SHOW_RECOVERY_EVENT, handler);
  }, [session, open]);

  const t = useTranslations();

  const handleCopy = useCallback(() => {
    if (!prompt) return;
    // Та же связка, что у копирования адреса в меню кошелька: буфер может
    // быть недоступен (нет разрешения, небезопасный источник) — и молчать об
    // этом нельзя, человек решит, что скопировалось.
    navigator.clipboard.writeText(prompt.words.join(' ')).then(
      () => {
        setCopied(true);
        toast.success(t('common.copied'));
        setTimeout(() => setCopied(false), 2000);
      },
      () => { toast.error(t('common.error')); },
    );
  }, [prompt, t]);

  const handleConfirm = useCallback(() => {
    if (!prompt) return;
    const verdict = checkRecoveryAnswers(prompt.words, prompt.positions, answers);
    if (!verdict.ok) { setFailed(verdict.failed); return; }
    markRecoveryConfirmed(address);
    setPrompt(null);
    window.dispatchEvent(new Event(RECOVERY_CONFIRMED_EVENT));
  }, [prompt, answers, address]);

  /* ───────────────────── ввод кода: вторая половина ────────────────────── */

  const { signTypedDataAsync } = useSignTypedData();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreErr, setRestoreErr] = useState<string | null>(null);
  const [restoreWord, setRestoreWord] = useState<number | null>(null);
  const [addressBusy, setAddressBusy] = useState(false);

  const closeRestore = useCallback(() => {
    setRestoreOpen(false);
    // ⚠️ Набранное СТИРАЕТСЯ при закрытии. Обстоятельство 1: человек закрыл
    // окно на середине — двенадцать слов не должны остаться висеть в памяти
    // вкладки до конца сеанса ради удобства, которого он не просил.
    setTyped('');
    setRestoreErr(null);
    setRestoreWord(null);
    setAddressBusy(false);
  }, []);

  useEffect(() => {
    const handler = () => {
      setTyped('');
      setRestoreErr(null);
      setRestoreWord(null);
      setAddressBusy(false);
      setRestoreOpen(true);
    };
    window.addEventListener(RESTORE_RECOVERY_EVENT, handler);
    return () => window.removeEventListener(RESTORE_RECOVERY_EVENT, handler);
  }, []);

  const runRestore = useCallback(async (forgetFirst: boolean) => {
    if (!address || restoreBusy) return;
    setRestoreBusy(true);
    setRestoreErr(null);
    setRestoreWord(null);
    try {
      // Забывание — ОТДЕЛЬНОЕ явное действие и только по отдельной кнопке:
      // `chatSession` намеренно не даёт коду затирать лежащий сеанс, и
      // обходить это молча значило бы вернуть находку К-2.
      if (forgetFirst) await forgetSession(address, { acknowledged: true });

      // Значение уходит КАК ЕСТЬ — разбор и прощение форм вставки живут в
      // `chatSession.ts`, и второй копии этих правил быть не должно.
      await openSessionFromRecoveryCode(address, typed, (typedData) => {
        if (typedData !== CHAT_KEY_TYPED_DATA) {
          throw new Error('RecoveryCodeGate: сеанс попросил подписать не свои же данные');
        }
        return signChatKeyLocked(
          address,
          (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]) as Promise<`0x${string}`>,
        );
      });

      // Восстановленный код человек уже держит в руках — заново требовать
      // «докажи, что записал» незачем.
      markRecoveryConfirmed(address);
      window.dispatchEvent(new Event(RECOVERY_CONFIRMED_EVENT));
      toast.success(t('chat.restore_done'));
      closeRestore();
      // Хук сам не узнает, что на диске появился ключ: перечитывание сеанса
      // — единственное, что заставит переписку открыться прямо сейчас.
      retry();
    } catch (err) {
      const code = err instanceof ChatSessionError ? err.code : null;
      setAddressBusy(code === 'session_already_present');
      setRestoreErr(restoreErrorKey(code));
      // Номер ошибочного слова — только для той единственной надписи,
      // которая его ждёт. Считается ПОСЛЕ вердикта, а не вместо него.
      setRestoreWord(code === 'recovery_code_unknown_word' ? await unknownWordPosition(typed) : null);
    } finally {
      setRestoreBusy(false);
    }
  }, [address, typed, restoreBusy, signTypedDataAsync, t, closeRestore, retry]);

  /* ────────────── отключение чата: подтверждение (К-1) ─────────────────── */

  const [disableAsking, setDisableAsking] = useState(false);

  useEffect(() => {
    const handler = () => setDisableAsking(true);
    window.addEventListener(DISABLE_CHAT_EVENT, handler);
    return () => window.removeEventListener(DISABLE_CHAT_EVENT, handler);
  }, []);

  const disableModal = (
    <DisableChatModal
      open={disableAsking}
      // Род кошелька решает чистая функция, а не привратник на глаз: тот же
      // признак, под которым показывается и сам код.
      losesEverything={hasRecoveryCode(session)}
      onConfirm={() => { setDisableAsking(false); disable({ acknowledged: true }); }}
      onShowCode={() => {
        // Не «и то и другое»: показать код и НЕ снимать ключ. Человек пришёл
        // сюда отключать, но выяснилось, что ему есть что терять — пусть
        // сперва запишет, а решение примет потом.
        setDisableAsking(false);
        open(readRecoveryCode(session));
      }}
      onCancel={() => setDisableAsking(false)}
    />
  );

  const restoreModal = (
    <RecoveryRestoreModal
      open={restoreOpen}
      value={typed}
      busy={restoreBusy}
      errorKey={restoreErr}
      errorWord={restoreWord}
      busyAddress={addressBusy}
      onChange={(next) => { setTyped(next); setRestoreErr(null); setRestoreWord(null); setAddressBusy(false); }}
      onSubmit={() => { void runRestore(false); }}
      onForgetAndRestore={() => { void runRestore(true); }}
      onClose={closeRestore}
    />
  );

  if (!prompt) return <>{restoreModal}{disableModal}</>;

  return (
    <>
    {restoreModal}
    {disableModal}
    <RecoveryCodeModal
      open
      words={prompt.words}
      positions={prompt.positions}
      step={step}
      answers={answers}
      failed={failed}
      copied={copied}
      // Ключ не лёг на устройство: второго показа может не быть вовсе, и
      // человек обязан это знать, пока код перед ним.
      notSaved={session ? !session.persisted : false}
      onCopy={handleCopy}
      onAnswer={(position, value) => {
        setAnswers(prev => ({ ...prev, [position]: value }));
        setFailed(null);
      }}
      onProceed={() => { setStep('check'); setFailed(null); }}
      onConfirm={handleConfirm}
      onSkip={() => setPrompt(null)}
    />
    </>
  );
}

/**
 * Плашка-напоминание: видна, пока код выдан и не подтверждён.
 *
 * Отметка перечитывается по событию, а не на каждом рендере: `localStorage`
 * читается синхронно, и делать это в теле компонента значило бы трогать диск
 * на каждую перерисовку переписки.
 */
export function useRecoveryReminder(): { visible: boolean; show: () => void } {
  const { address } = useAccount();
  const { session } = useChatSession();
  // До первого чтения — «подтверждено»: иначе плашка мигала бы на каждой
  // загрузке страницы у того, кто давно всё записал.
  const [confirmed, setConfirmed] = useState(true);

  useEffect(() => {
    const reread = () => setConfirmed(isRecoveryConfirmed(address));
    reread();
    window.addEventListener(RECOVERY_CONFIRMED_EVENT, reread);
    return () => window.removeEventListener(RECOVERY_CONFIRMED_EVENT, reread);
  }, [address]);

  return {
    visible: recoveryReminderVisible(session, confirmed),
    show: useCallback(() => window.dispatchEvent(new Event(SHOW_RECOVERY_EVENT)), []),
  };
}
