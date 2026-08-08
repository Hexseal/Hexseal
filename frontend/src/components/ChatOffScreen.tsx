"use client";

/**
 * ChatOffScreen.tsx — ОДИН экран «чат не открылся» на оба места.
 *
 * ⚠️ ЗАЧЕМ ОБЩИЙ. Разводка шести причин (К-2) была сделана в панели и
 * СКОПИРОВАНА нигде: страница списка переписок рисовала «Мессенджер выключен»
 * на все семь причин. То есть обвиняющий экран, который К-2 убирала, остался
 * жить там, куда человек попадает ЧАЩЕ ВСЕГО — а тест этого не увидел,
 * потому что проверял чистую функцию, а не разметку.
 *
 * Две копии одного экрана расходятся молча. Поэтому он один, и оба места
 * обязаны его звать: `ChatPanel` и `app/chat/page.tsx`.
 *
 * ⚠️ ДВЕРЬ К КОДУ ВОССТАНОВЛЕНИЯ ЗДЕСЬ ВСЕГДА. Любой из этих экранов значит
 * «рабочего сеанса нет», а это ровно то состояние, в котором человек и
 * приходит с двенадцатью словами: сменил устройство, почистил хранилище,
 * потерял ключ. Раньше вход показывался только там, где сеанс УЖЕ был, — то
 * есть там, где он не нужен. Мы показали код, заставили доказать, что он
 * записан, и спрятали дверь.
 */

import React from 'react';
import { useTranslations } from 'next-intl';
import { MessageCircle } from 'lucide-react';
import { offScreenFor } from '@/lib/chatSessionOff';
import { RESTORE_RECOVERY_EVENT } from '@/components/RecoveryCodeGate';

export interface ChatOffScreenProps {
  /** Причина отказа сеанса или `null` — человек выключил чат сам. */
  errorCode: string | null;
  /** «Повторить» / «включить» — своё у каждого места. */
  onRetry: () => void;
  /** `compact` — колонка списка, `full` — центр панели. */
  variant?: 'compact' | 'full';
}

export function ChatOffScreen({ errorCode, onRetry, variant = 'full' }: ChatOffScreenProps): React.ReactElement {
  const t = useTranslations();
  const screen = offScreenFor(errorCode as Parameters<typeof offScreenFor>[0]);

  const actionLabel =
    screen.action === 'close-tabs' ? t('chat.off_close_tabs')
      : screen.action === 'retry' ? t('chat.enable_messaging')
        : null;

  const outer = variant === 'compact'
    ? 'px-4 py-10 text-center flex flex-col items-center gap-3'
    : 'flex flex-col items-center justify-center py-16 gap-3 px-4 text-center';

  return (
    <div className={outer}>
      {variant === 'full' ? (
        <div className="w-12 h-12 rounded-[16px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
          <MessageCircle className="w-5 h-5 text-white/[0.15]" />
        </div>
      ) : (
        <MessageCircle className="w-8 h-8 text-white/[0.12]" />
      )}

      <div>
        <p className="text-sm text-white/45 mb-1">{t(screen.titleKey as Parameters<typeof t>[0])}</p>
        <p className="text-white/25 text-xs max-w-[240px] leading-relaxed">
          {t(screen.hintKey as Parameters<typeof t>[0])}
        </p>
        {/* Ключа на устройстве нет — обычному кошельку хватит подписи, и вернётся
            ТОТ ЖЕ ключ. Разбор и замер с прибора — `sameKeyNote`. */}
        {screen.sameKeyNote && (
          <p className="text-white/25 text-xs max-w-[240px] leading-relaxed mt-1">
            {t('chat.messaging_off_same_key')}
          </p>
        )}
      </div>

      {/* Действие — половина дела, и оно РАЗНОЕ. «Повторить» на базе, занятой
          соседней вкладкой, не даст ничего; у незнакомой версии записи
          действия нет вовсе, и кнопки нет тоже — рисовать её значило бы
          врать. */}
      {screen.action === 'restore' ? (
        <button
          onClick={() => window.dispatchEvent(new Event(RESTORE_RECOVERY_EVENT))}
          className="flex items-center gap-2 px-4 py-2 rounded-[12px] border border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113] transition-colors text-xs text-white/50"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          {t('chat.restore_menu')}
        </button>
      ) : actionLabel ? (
        <button
          onClick={onRetry}
          className="flex items-center gap-2 px-4 py-2 rounded-[12px] border border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113] transition-colors text-xs text-white/50"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          {actionLabel}
        </button>
      ) : null}

      {/* Дверь к коду — ВСЕГДА, кроме случая, когда она уже главная кнопка
          выше. Ставится тише основного действия: это запасной выход, а не
          то, что человек должен пробовать первым. */}
      {screen.action !== 'restore' && (
        <button
          onClick={() => window.dispatchEvent(new Event(RESTORE_RECOVERY_EVENT))}
          className="text-[11px] text-white/25 hover:text-white/50 underline underline-offset-2 transition-colors"
        >
          {t('chat.restore_menu')}
        </button>
      )}

      {/* ⚠️ ДВЕРЬ ОБЯЗАНА НАЗВАТЬ, КОМУ ОНА, И СКАЗАТЬ ЭТО ДО ВХОДА.
          Замер с живого телефона (9 августа): у обычного кошелька дороги по
          коду НЕ СУЩЕСТВУЕТ — восстановление отказывает
          `recovery_not_applicable`, — а владелец прочёл кнопку как требование
          к себе: «волетконнект просит восстановиться по коду». Слова у отказа
          верные, но человек видел их ПОСЛЕ ввода двенадцати слов.

          Кнопка не спрятана НАРОЧНО: род кошелька до подписи не определить.
          Признак «есть ли код на цепи» ошибается на двух родах из четырёх
          (замерено 6 августа), и пустой код — ровно неоднозначный случай:
          обычный кошелёк ИЛИ счётный смарт-кошелёк, у которого код нужен.
          Спрятав дверь по этому признаку, мы отняли бы её у того, кому она
          единственный выход. Поэтому дверь остаётся, а рядом сказано, кому. */}
      <p className="text-white/20 text-[10px] max-w-[240px] leading-relaxed">
        {t('chat.restore_who_for')}
      </p>
    </div>
  );
}
