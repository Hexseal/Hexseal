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
import { useAccount } from 'wagmi';
import { toast } from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { useChatSession } from '@/hooks/useChatSession';
import {
  openRecoveryPrompt,
  checkRecoveryAnswers,
  readRecoveryCode,
  markRecoveryConfirmed,
  forgetRecoveryConfirmed,
  isRecoveryConfirmed,
  recoveryReminderVisible,
} from '@/lib/chatRecovery';
import { RecoveryCodeModal } from './RecoveryCodeModal';

/** Просьба показать код. Слушает привратник, шлют меню кошелька и плашка. */
export const SHOW_RECOVERY_EVENT = 'hexseal:show-recovery-code';
/** Код подтверждён — плашке пора исчезнуть. */
export const RECOVERY_CONFIRMED_EVENT = 'hexseal:recovery-confirmed';

export function RecoveryCodeGate(): React.ReactElement | null {
  const { address } = useAccount();
  const { session, recoveryCode } = useChatSession();

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

  if (!prompt) return null;

  return (
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
