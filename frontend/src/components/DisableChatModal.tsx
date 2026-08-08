"use client";

/**
 * DisableChatModal.tsx — подтверждение снятия ключа с устройства (К-1).
 *
 * ⚠️ ЧЕМ ЭТО БЫЛО. Пункт меню звал `disable()` прямо: одно нажатие —
 * `forgetSession`, ключ снят. Цена нажатия РАЗНАЯ у двух родов кошелька, и
 * разница здесь не в оттенке, а в том, вернётся переписка или нет:
 *
 *   обычный кошелёк   — ключ выводится из подписи. Подписал те же данные —
 *                       получил тот же ключ. Потеря нулевая, неудобство одно
 *                       окно кошелька;
 *   кошелёк-контракт  — ключ СЛУЧАЙНЫЙ, второго источника нет. Единственный
 *                       путь назад — двенадцать слов, которые человек мог не
 *                       записать. Это потеря НАВСЕГДА.
 *
 * Поэтому надписи две, и тому, кому есть что терять, предложено сперва
 * посмотреть код. Одна надпись на оба рода была бы неправдой для одного из
 * них при любой формулировке.
 *
 * Окно управляемое: род кошелька решает `hasRecoveryCode` в привратнике, сюда
 * приезжает готовым признаком. У фронта нет jsdom — всё, что можно ошибиться,
 * живёт там, где его можно проверить.
 */

import React from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, KeyRound } from 'lucide-react';

export interface DisableChatModalProps {
  open: boolean;
  /** `true` — кошелёк-контракт: ключ случайный, назад только по коду. */
  losesEverything: boolean;
  onConfirm: () => void;
  onShowCode: () => void;
  onCancel: () => void;
}

const BTN_GHOST =
  'px-3.5 py-1.5 rounded-[10px] text-xs text-white/45 hover:text-white/70 ' +
  'border border-white/[0.08] hover:bg-white/[0.05] transition-colors';

export function DisableChatModal(props: DisableChatModalProps): React.ReactElement | null {
  const { open, losesEverything, onConfirm, onShowCode, onCancel } = props;
  const t = useTranslations();

  if (!open) return null;

  return (
    // Подложка без обработчика: случайный клик мимо не должен стирать ключ.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div
        className="border border-white/[0.08] rounded-[22px] p-5 w-full max-w-sm"
        style={{
          background: '#0d0d0f',
          boxShadow: '0 8px 40px rgba(0,0,0,0.7), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5">
          <AlertTriangle className={`w-3.5 h-3.5 flex-shrink-0 ${losesEverything ? 'text-red-400/80' : 'text-amber-400/70'}`} />
          {t('chat.disable_title')}
        </h3>

        <p className={`text-xs leading-relaxed mb-4 ${losesEverything ? 'text-white/70' : 'text-white/50'}`}>
          {losesEverything ? t('chat.disable_contract') : t('chat.disable_eoa')}
        </p>

        {losesEverything && (
          // Единственное место, где показ кода и его снятие встречаются. Без
          // этой кнопки человек, не записавший код, узнал бы о своей потере
          // только когда она уже случилась.
          <button
            type="button"
            onClick={onShowCode}
            className="w-full mb-4 px-3.5 py-2 rounded-[12px] text-xs font-medium text-white bg-primary hover:bg-primary/80 transition-colors flex items-center justify-center gap-1.5"
          >
            <KeyRound className="w-3.5 h-3.5" />
            {t('chat.disable_show_code_first')}
          </button>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className={BTN_GHOST}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3.5 py-1.5 rounded-[10px] text-xs font-medium text-white bg-red-600 hover:bg-red-500 transition-colors"
          >
            {t('chat.disable_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
