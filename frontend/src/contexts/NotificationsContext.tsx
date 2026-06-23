'use client';

import { createContext, useContext } from 'react';
import { useNotifications } from '@/hooks/useNotifications';

type NotificationsValue = ReturnType<typeof useNotifications>;

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const value = useNotifications();
  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotificationsCtx(): NotificationsValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotificationsCtx used outside NotificationsProvider');
  return ctx;
}
