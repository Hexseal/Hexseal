"use client";

/**
 * RecoveryCodeModal.tsx — окно с кодом восстановления и плашка-напоминание.
 *
 * ─── ПОЧЕМУ ОНО УПРАВЛЯЕМОЕ СНАРУЖИ ────────────────────────────────────
 *
 * Ни шага, ни ответов, ни вердикта внутри себя окно не хранит: всё приезжает
 * пропсами, всё решает `lib/chatRecovery.ts`, состояние держит
 * `RecoveryCodeGate.tsx`. Причина не в красоте, а в проверяемости: у фронта
 * нет ни jsdom, ни @testing-library (шапка `vitest.config.mjs`) — нажать
 * кнопку в тесте нечем. Управляемое окно отрисовывается тем же кодом, каким
 * его видит человек (`recoveryCode.test.tsx`), а всё, что можно ошибиться,
 * заперто чистыми функциями отдельно.
 *
 * ─── ДВА ШАГА, И ВТОРОЙ НЕ УКРАШЕНИЕ ───────────────────────────────────
 *
 * `show` — двенадцать слов на экране. `check` — три случайных номера и три
 * поля, и КОДА НА ЭТОМ ШАГЕ НЕТ. Если оставить слова рядом с полями, человек
 * спишет с экрана, и проверка докажет ровно ничего. Заперто тестом, который
 * ищет каждое из двенадцати слов в разметке шага проверки.
 *
 * ⚠️ ПОЛЯ НЕ ПОДСКАЗЫВАЮТ. `autocomplete="off"` мало: менеджеры паролей его
 * игнорируют, поэтому рядом стоят их собственные признаки (`data-1p-ignore`,
 * `data-lpignore`). Браузер, помнящий прошлый ввод, подставил бы правильное
 * слово подсказкой — и проверялась бы память браузера, а не человека.
 *
 * ─── ЧТО ЭТО ОКНО НЕ ДЕЛАЕТ ────────────────────────────────────────────
 *
 *  - НЕ закрывается кликом мимо и по Escape: на подложке нет обработчика, и
 *    это единственная защита от «смахнул, не прочитав». Но и наглухо оно не
 *    заперто — «пропустить, запишу позже» есть на обоих шагах, а рядом
 *    сказано, где взять код потом.
 *  - НЕ пишет код никуда: ни в журнал, ни в `localStorage`, ни в `value`
 *    поля ввода. Слова показаны ТЕКСТОМ узла — `value` браузер помнит и
 *    подставляет, текст узла не помнит никто. Заперто гейтом
 *    `lib/chatRecoveryHygiene.test.ts`.
 */

import React from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound, Copy, Check, AlertTriangle } from 'lucide-react';

export interface RecoveryCodeModalProps {
  open: boolean;
  /** Двенадцать слов. Разбирает и проверяет `lib/chatRecovery.ts`. */
  words: string[];
  /** Номера слов, которые спрашиваются на шаге `check`, 1-based. */
  positions: number[];
  step: 'show' | 'check';
  /** Вписанное человеком, по номеру слова. */
  answers: Record<number, string>;
  /** Номер первого несошедшегося слова или `null`. */
  failed: number | null;
  copied: boolean;
  /** Ключ не лёг на устройство (`session.persisted === false`). */
  notSaved: boolean;
  onCopy: () => void;
  onAnswer: (position: number, value: string) => void;
  onProceed: () => void;
  onConfirm: () => void;
  onSkip: () => void;
}

const BTN_GHOST =
  'px-3.5 py-1.5 rounded-[10px] text-xs text-white/45 hover:text-white/70 ' +
  'border border-white/[0.08] hover:bg-white/[0.05] transition-colors';
const BTN_PRIMARY =
  'px-3.5 py-1.5 rounded-[10px] text-xs font-medium text-white bg-primary ' +
  'hover:bg-primary/80 transition-colors';

export function RecoveryCodeModal(props: RecoveryCodeModalProps): React.ReactElement | null {
  const {
    open, words, positions, step, answers, failed, copied, notSaved,
    onCopy, onAnswer, onProceed, onConfirm, onSkip,
  } = props;
  const t = useTranslations();

  // Закрытое окно не рисуется ВОВСЕ, а не прячется стилем: спрятанное
  // держало бы двенадцать слов в разметке страницы.
  if (!open) return null;

  return (
    // ⚠️ На подложке НЕТ onClick — намеренно. Разбор в шапке файла.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div
        className="border border-white/[0.08] rounded-[22px] p-5 w-full max-w-sm"
        style={{
          background: '#0d0d0f',
          boxShadow: '0 8px 40px rgba(0,0,0,0.7), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5">
          <KeyRound className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0" />
          {step === 'show' ? t('chat.recovery_warning_title') : t('chat.recovery_check_title')}
        </h3>

        {step === 'show' ? (
          <ShowStep
            words={words}
            copied={copied}
            notSaved={notSaved}
            onCopy={onCopy}
            onProceed={onProceed}
            onSkip={onSkip}
          />
        ) : (
          <CheckStep
            positions={positions}
            answers={answers}
            failed={failed}
            onAnswer={onAnswer}
            onConfirm={onConfirm}
            onSkip={onSkip}
          />
        )}
      </div>
    </div>
  );
}

function ShowStep({
  words, copied, notSaved, onCopy, onProceed, onSkip,
}: {
  words: string[];
  copied: boolean;
  notSaved: boolean;
  onCopy: () => void;
  onProceed: () => void;
  onSkip: () => void;
}) {
  const t = useTranslations();
  return (
    <>
      {/* Утверждённый владельцем текст. Три отдельные строки, а не абзац:
          правка одной не требует правки кода. */}
      <p className="text-xs text-white/55 leading-relaxed mb-1.5">{t('chat.recovery_warning_access')}</p>
      <p className="text-xs text-white/55 leading-relaxed mb-1.5">{t('chat.recovery_warning_loss')}</p>
      <p className="text-xs text-white/75 leading-relaxed mb-3">{t('chat.recovery_warning_keep')}</p>

      {notSaved && (
        // Ключ не лёг на устройство. Молчать нельзя: этот код — единственное,
        // чем человек вернёт себе переписку, второго показа может не быть.
        <div className="px-3 py-2 mb-3 rounded-[12px] bg-amber-500/[0.07] border border-amber-500/15 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0 mt-px" />
          <p className="text-[11px] text-amber-400/70 leading-relaxed">{t('chat.key_not_saved')}</p>
        </div>
      )}

      {/* Слова — ТЕКСТОМ узла, не значением поля: `value` браузер помнит. */}
      <ol className="grid grid-cols-2 gap-x-3 gap-y-1 mb-3 rounded-[14px] border border-white/[0.07] bg-white/[0.03] px-3.5 py-3">
        {words.map((word, i) => (
          <li key={i} className="flex items-baseline gap-2 text-xs">
            <span className="text-white/25 tabular-nums w-4 text-right flex-shrink-0">{i + 1}</span>
            <span className="text-white/80 font-mono break-all">{word}</span>
          </li>
        ))}
      </ol>

      <div className="flex items-center justify-between gap-2 mb-4">
        <button type="button" onClick={onCopy} className={`${BTN_GHOST} flex items-center gap-1.5`}>
          {copied
            ? <><Check className="w-3 h-3" />{t('common.copied')}</>
            : <><Copy className="w-3 h-3" />{t('common.copy')}</>}
        </button>
        <button type="button" onClick={onProceed} className={BTN_PRIMARY}>
          {t('chat.recovery_written')}
        </button>
      </div>

      <SkipRow onSkip={onSkip} />
    </>
  );
}

function CheckStep({
  positions, answers, failed, onAnswer, onConfirm, onSkip,
}: {
  positions: number[];
  answers: Record<number, string>;
  failed: number | null;
  onAnswer: (position: number, value: string) => void;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  const t = useTranslations();
  return (
    <>
      <p className="text-xs text-white/55 leading-relaxed mb-3">{t('chat.recovery_check_hint')}</p>

      <div className="space-y-2 mb-4">
        {positions.map(n => (
          <label key={n} className="block">
            <span className="text-[11px] text-white/35">{t('chat.recovery_check_word', { n })}</span>
            <input
              type="text"
              value={answers[n] ?? ''}
              onChange={e => onAnswer(n, e.target.value)}
              // ⚠️ Ни одной подсказки: иначе проверяется память браузера, а
              // не человека. Менеджеры паролей `autocomplete="off"`
              // игнорируют — отсюда их собственные признаки.
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              className={`w-full mt-1 px-3 py-1.5 rounded-[10px] bg-white/[0.03] text-xs text-white/80 font-mono outline-none border transition-colors ${
                failed === n ? 'border-red-500/40' : 'border-white/[0.08] focus:border-white/20'
              }`}
            />
          </label>
        ))}
      </div>

      {failed !== null && (
        <p className="text-[11px] text-red-400/70 mb-3">
          {t('chat.recovery_check_failed', { n: failed })}
        </p>
      )}

      <div className="flex justify-end mb-4">
        <button type="button" onClick={onConfirm} className={BTN_PRIMARY}>
          {t('chat.recovery_check_done')}
        </button>
      </div>

      <SkipRow onSkip={onSkip} />
    </>
  );
}

/**
 * Честный выход. Наглухо запертое окно даёт дефект хуже чинимого: человек в
 * дороге, записывать нечем — и он не может начать пользоваться чатом вовсе.
 * Рядом ОБЯЗАТЕЛЬНО сказано, где взять код потом, иначе «пропустить»
 * читается как «отказаться навсегда».
 */
function SkipRow({ onSkip }: { onSkip: () => void }) {
  const t = useTranslations();
  return (
    <div className="pt-3 border-t border-white/[0.06]">
      <button
        type="button"
        onClick={onSkip}
        className="text-[11px] text-white/35 hover:text-white/60 underline underline-offset-2 transition-colors"
      >
        {t('chat.recovery_skip')}
      </button>
      <p className="text-[11px] text-white/25 leading-relaxed mt-1.5">{t('chat.recovery_where')}</p>
    </div>
  );
}

/**
 * Неброская плашка в чате: код выдан, но человек не подтвердил, что записал.
 *
 * Уходит РОВНО после успешной проверки — не после закрытия окна и не по
 * таймеру. Решает `recoveryReminderVisible` (`lib/chatRecovery.ts`), здесь
 * только показ. Кода в плашке нет: она напоминает, а не показывает.
 */
export function RecoveryReminder({
  visible, onShow,
}: {
  visible: boolean;
  onShow: () => void;
}): React.ReactElement | null {
  const t = useTranslations();
  if (!visible) return null;
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 mx-1 mb-1 rounded-[12px] bg-amber-500/[0.07] border border-amber-500/15">
      <p className="text-xs text-amber-400/70">{t('chat.recovery_reminder')}</p>
      <button
        type="button"
        onClick={onShow}
        className="flex-shrink-0 text-xs font-medium text-amber-400 hover:text-amber-300 transition-colors"
      >
        {t('chat.recovery_show')}
      </button>
    </div>
  );
}
