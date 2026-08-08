"use client";

/**
 * RecoveryRestoreModal.tsx — ввод кода восстановления.
 *
 * Вторая половина петли. Первая (`RecoveryCodeModal.tsx`) показывает
 * двенадцать слов и требует доказать, что они записаны; без этой половины та
 * была обещанием, которое некуда предъявить.
 *
 * ─── ПОЛЕ ВВОДА НИЧЕГО НЕ ЧИНИТ ────────────────────────────────────────
 *
 * ⚠️ Значение уходит в `openSessionFromRecoveryCode` КАК ЕСТЬ. Ни обрезки,
 * ни свёртки пробелов, ни приведения регистра здесь нет — и это не
 * небрежность, а требование: регистр, лишние пробелы, перенос строки,
 * неразрывный пробел из PDF и полноширинные буквы восточных раскладок УЖЕ
 * работают, потому что их прощает `normalizeRecoveryCode` внутри
 * `chatSession.ts`. Любая своя обработка на этом пути может только сломать
 * то, что уже замерено (`chatRestore.test.ts`, пять форм вставки).
 *
 * Поэтому `<textarea>`, а не `<input>`: вставка из заметки приезжает с
 * переносами строк, и однострочное поле показало бы её как кашу.
 *
 * ─── ЧЕГО ЗДЕСЬ НЕТ ────────────────────────────────────────────────────
 *
 *  - НЕТ решений: годен ли код, какая причина отказа, какой номер у
 *    ошибочного слова — всё снаружи (`lib/chatRecovery.ts`,
 *    `lib/chatSession.ts`). Здесь состояние приезжает пропсами.
 *  - НЕТ кода в журнале, в `localStorage` и в адресе страницы. Гейт —
 *    `lib/chatRecoveryHygiene.test.ts`.
 */

import React from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound, Loader2 } from 'lucide-react';

export interface RecoveryRestoreModalProps {
  open: boolean;
  /** То, что человек набрал. Хранит и передаёт привратник. */
  value: string;
  busy: boolean;
  /** Ключ надписи об отказе или `null`. Считает `restoreErrorKey`. */
  errorKey: string | null;
  /** Номер ошибочного слова для подстановки в надпись, если она его ждёт. */
  errorWord: number | null;
  /** Адрес занят: вместо «повторить» нужен явный выход через забывание. */
  busyAddress: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onForgetAndRestore: () => void;
  onClose: () => void;
}

const BTN_GHOST =
  'px-3.5 py-1.5 rounded-[10px] text-xs text-white/45 hover:text-white/70 ' +
  'border border-white/[0.08] hover:bg-white/[0.05] transition-colors disabled:opacity-40';
const BTN_PRIMARY =
  'px-3.5 py-1.5 rounded-[10px] text-xs font-medium text-white bg-primary ' +
  'hover:bg-primary/80 transition-colors disabled:opacity-40 flex items-center gap-1.5';

export function RecoveryRestoreModal(props: RecoveryRestoreModalProps): React.ReactElement | null {
  const {
    open, value, busy, errorKey, errorWord, busyAddress,
    onChange, onSubmit, onForgetAndRestore, onClose,
  } = props;
  const t = useTranslations();

  if (!open) return null;

  return (
    // Подложка без обработчика: смахнуть мимо посреди ввода двенадцати слов
    // — потерять весь набранный текст. Закрытие только явной кнопкой.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div
        className="border border-white/[0.08] rounded-[22px] p-5 w-full max-w-sm"
        style={{
          background: '#0d0d0f',
          boxShadow: '0 8px 40px rgba(0,0,0,0.7), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5">
          <KeyRound className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
          {t('chat.restore_title')}
        </h3>
        <p className="text-xs text-white/45 leading-relaxed mb-3">{t('chat.restore_hint')}</p>

        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder={t('chat.restore_placeholder')}
          // ⚠️ Те же глушители, что на полях проверки: браузер, помнящий
          // прошлый ввод, подставил бы сюда чужой или прежний код, а
          // менеджер паролей предложил бы его сохранить.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          className="w-full px-3 py-2 rounded-[12px] bg-white/[0.03] text-xs text-white/80 font-mono outline-none border border-white/[0.08] focus:border-white/20 transition-colors resize-none disabled:opacity-50"
        />

        {errorKey && (
          <p className="text-[11px] text-red-400/70 leading-relaxed mt-2">
            {/* Номер подставляется только туда, где надпись его ждёт;
                остальным `{n}` не нужен и в них его нет. */}
            {t(errorKey, errorWord !== null ? { n: errorWord } : undefined)}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 mt-4">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_GHOST}>
            {t('common.cancel')}
          </button>
          {busyAddress ? (
            // Занятый адрес — не «повторить», а другое действие с другой
            // ценой: прежний ключ будет снят с устройства. Кнопка называет
            // эту цену своим текстом, а не прячет её за «ок».
            <button type="button" onClick={onForgetAndRestore} disabled={busy} className={BTN_PRIMARY}>
              {busy && <Loader2 className="w-3 h-3 animate-spin" />}
              {t('chat.restore_forget_first')}
            </button>
          ) : (
            <button type="button" onClick={onSubmit} disabled={busy} className={BTN_PRIMARY}>
              {busy && <Loader2 className="w-3 h-3 animate-spin" />}
              {t('chat.restore_submit')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
