'use client';

import { usePushCtx } from '@/contexts/PushContext';

// Thin re-export kept for existing call sites (WalletMenu.tsx, notifications/page.tsx).
// Both used to call a standalone hook with its OWN useState — two independent
// instances of "is push on" that could disagree, which is exactly what caused the
// enable/disable buttons to vanish simultaneously (each side hid its own control
// based on its own, possibly-wrong belief about the other's state). PushContext is
// the single shared source of truth now; this just forwards it.
export function usePushNotifications() {
  return usePushCtx();
}
