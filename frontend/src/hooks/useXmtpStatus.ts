'use client';

// Backward-compat wrapper — keeps call sites compiling while they migrate to useXmtp().
import { useXmtp } from '@/contexts/XmtpContext';

export function useXmtpStatus() {
  const { status, error, retry, disable } = useXmtp();
  return {
    isEnabled:       status === 'ready',
    isAutoRestoring: status === 'loading',
    isEnabling:      false,
    signStep:        0,
    error,
    enable:          retry,
    disable,
  };
}
