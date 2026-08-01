'use client';

import { useTranslations } from 'next-intl';
import { useXmtp } from '@/contexts/XmtpContext';

/**
 * Текст отказа мессенджера НА ЯЗЫКЕ ЧЕЛОВЕКА.
 *
 * `XmtpContext` отдаёт разобранный класс отказа (`errorCode`) и — только для
 * неразобранных случаев — сырой текст. Перевод живёт здесь, в одном месте на
 * все поверхности: полоса под чатом, экран ошибки, список переписок. Раньше
 * формулировку собирал сам контекст и всегда по-русски, поэтому в остальных
 * тринадцати локалях человек читал русский.
 *
 * `null` — отказа нет либо он намеренно молчаливый (автоматическая попытка,
 * которую человек не запрашивал).
 */
export function useXmtpFailureText(): string | null {
  const { error, errorCode } = useXmtp();
  const t = useTranslations();
  if (errorCode) return t(`xmtp_error.${errorCode}` as Parameters<typeof t>[0]);
  return error;
}
