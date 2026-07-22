"use client";

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, CheckCheck, Trash2, ExternalLink, BellRing, BellOff, Loader2 } from "lucide-react";
import { useNotificationsCtx } from "@/contexts/NotificationsContext";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useAccount } from "wagmi";
import { cn } from "@/lib/utils";
import { type AppNotification, notifIcon } from "@/lib/notifications";
import { useTranslations } from "next-intl";

function timeAgo(ts: number): string {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function NotifEntry({ notif, onRead }: { notif: AppNotification; onRead: (id: string) => void }) {
  const inner = (
    <div
      className={cn(
        "flex gap-3.5 px-4 py-4 active:bg-white/8 transition-colors",
        !notif.read && "bg-white/[0.025]"
      )}
      onClick={() => onRead(notif.id)}
    >
      <span className="text-2xl leading-none mt-0.5 flex-shrink-0 w-8 text-center">
        {notifIcon(notif.type)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2 mb-1">
          <p className={cn(
            "text-sm font-semibold leading-snug",
            notif.read ? "text-white/55" : "text-white"
          )}>
            {notif.title}
          </p>
          <span className="text-xs text-white/25 flex-shrink-0 mt-0.5">{timeAgo(notif.timestamp)}</span>
        </div>
        <p className="text-sm text-white/45 leading-relaxed">{notif.body}</p>
        {notif.txHash && (
          <a
            href={`https://sepolia.basescan.org/tx/${notif.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 mt-2 text-xs font-mono text-white/25 hover:text-white/50 transition-colors"
          >
            <ExternalLink className="w-2.5 h-2.5" />
            {notif.txHash.slice(0, 12)}…
          </a>
        )}
      </div>
      {!notif.read && (
        <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0 mt-2" />
      )}
    </div>
  );

  if (notif.link) {
    return (
      <Link href={notif.link} className="block border-b border-white/[0.05] last:border-0 hover:bg-white/[0.04] transition-colors">
        {inner}
      </Link>
    );
  }
  return (
    <div className="border-b border-white/[0.05] last:border-0 cursor-pointer hover:bg-white/[0.04] transition-colors">
      {inner}
    </div>
  );
}

export default function NotificationsPage() {
  const { isConnected, status } = useAccount();
  const { notifications, unreadCount, markRead, markAll, clearAll } = useNotificationsCtx();
  const { supported, subscribed, permission, loading: pushLoading, error: pushError, enable: enablePush, disable: disablePush } = usePushNotifications();
  const t = useTranslations();

  if (status === 'reconnecting' || status === 'connecting') return null;

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-white/35 text-sm">{t("notifications.wallet_required")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-xl mx-auto px-4 py-6">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-white/40" />
              <h1 className="text-sm font-semibold">{t("notifications.title")}</h1>
              {unreadCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-primary/20 text-primary text-[10px] font-bold">
                  {unreadCount}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-0.5">
            {unreadCount > 0 && (
              <button
                onClick={markAll}
                title={t("notifications.mark_all_read")}
                className="p-2 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/5 transition-colors"
              >
                <CheckCheck className="w-4 h-4" />
              </button>
            )}
            {notifications.length > 0 && (
              <button
                onClick={clearAll}
                title={t("notifications.clear_all")}
                className="p-2 rounded-lg text-white/30 hover:text-red-400 hover:bg-white/5 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Push notification toggle — shown only while OFF; turn it back off from the wallet menu */}
        {supported && permission !== 'denied' && !subscribed && (
          <div className="flex items-center justify-between px-4 py-3 rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] mb-4">
            <div className="flex items-center gap-3">
              {subscribed
                ? <BellRing className="w-4 h-4 text-primary/70" />
                : <BellOff className="w-4 h-4 text-white/30" />
              }
              <div>
                <p className="text-sm font-medium text-white/80">
                  {subscribed ? 'Push notifications on' : 'Push notifications off'}
                </p>
                <p className="text-xs text-white/35">
                  {subscribed ? 'You\'ll be notified about deal updates even when the app is closed.' : 'Enable to get deal alerts when you\'re away.'}
                </p>
              </div>
            </div>
            <button
              onClick={subscribed ? disablePush : enablePush}
              disabled={pushLoading}
              className={cn(
                'flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40',
                subscribed
                  ? 'border border-white/15 text-white/50 hover:border-white/25 hover:text-white/70'
                  : 'bg-primary text-white hover:bg-primary/80'
              )}
            >
              {pushLoading
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : subscribed ? 'Turn off' : 'Enable'
              }
            </button>
          </div>
        )}

        {supported && permission === 'denied' && (
          <div className="px-4 py-3 rounded-[14px] border border-amber-500/20 bg-amber-500/5 mb-4">
            <p className="text-xs text-amber-400/70">
              {t("notifications.push_blocked")}
            </p>
          </div>
        )}

        {pushError === 'enable_failed' && (
          <div className="px-4 py-3 rounded-[14px] border border-red-500/20 bg-red-500/5 mb-4">
            <p className="text-xs text-red-400/70">
              {t("notifications.push_enable_failed")}
            </p>
          </div>
        )}

        {/* Empty state */}
        {notifications.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <div className="w-16 h-16 rounded-[18px] bg-white/[0.03] border border-white/[0.08] flex items-center justify-center">
              <Bell className="w-6 h-6 text-white/15" />
            </div>
            <div>
              <p className="text-white/50 text-sm font-medium mb-1">{t("notifications.all_caught_up")}</p>
              <p className="text-white/25 text-xs leading-relaxed max-w-xs">
                {t("notifications.empty_hint")}
              </p>
            </div>
          </div>
        )}

        {/* Notification list */}
        {notifications.length > 0 && (
          <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] overflow-hidden divide-y divide-white/[0.05]" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
            <AnimatePresence mode="popLayout">
              {notifications.map((n, index) => (
                <motion.div
                  key={n.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  transition={{ duration: 0.22, delay: Math.min(index, 6) * 0.04 }}
                >
                  <NotifEntry notif={n} onRead={markRead} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

      </div>
    </div>
  );
}
