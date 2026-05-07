"use client";

import Link from "next/link";
import { Bell, CheckCheck, Trash2, ExternalLink } from "lucide-react";
import { useNotifications } from "@/hooks/useNotifications";
import { useAccount } from "wagmi";
import { cn } from "@/lib/utils";
import { type AppNotification, notifIcon } from "@/lib/notifications";

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
  const { isConnected } = useAccount();
  const { notifications, unreadCount, markRead, markAll, clearAll } = useNotifications();

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-white/35 text-sm">Connect wallet to view notifications</p>
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
              <h1 className="text-sm font-semibold">Notifications</h1>
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
                title="Mark all read"
                className="p-2 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/5 transition-colors"
              >
                <CheckCheck className="w-4 h-4" />
              </button>
            )}
            {notifications.length > 0 && (
              <button
                onClick={clearAll}
                title="Clear all"
                className="p-2 rounded-lg text-white/30 hover:text-red-400 hover:bg-white/5 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Empty state */}
        {notifications.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/8 flex items-center justify-center">
              <Bell className="w-6 h-6 text-white/15" />
            </div>
            <div>
              <p className="text-white/50 text-sm font-medium mb-1">All caught up</p>
              <p className="text-white/25 text-xs leading-relaxed max-w-xs">
                Notifications about your deals, jobs, and services will appear here
              </p>
            </div>
          </div>
        )}

        {/* Notification list */}
        {notifications.length > 0 && (
          <div className="rounded-xl border border-white/8 overflow-hidden divide-y divide-white/[0.05]">
            {notifications.map((n) => (
              <NotifEntry key={n.id} notif={n} onRead={markRead} />
            ))}
          </div>
        )}

      </div>
    </div>
  );
}
