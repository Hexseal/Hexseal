"use client";

import { useRef, useEffect, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, Trash2, X, ExternalLink, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotificationsCtx } from "@/contexts/NotificationsContext";
import { useAccount } from "wagmi";
import { type AppNotification, notifIcon } from "@/lib/notifications";
import { useTranslations } from "next-intl";

function timeAgo(ts: number): string {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function NotifRow({
  notif,
  onRead,
  onClose,
}: {
  notif: AppNotification;
  onRead: (id: string) => void;
  onClose: () => void;
}) {
  const content = (
    <div
      className={cn(
        "flex gap-3 px-4 py-3 hover:bg-white/5 transition-colors cursor-pointer border-b border-white/5 last:border-0",
        !notif.read && "bg-white/[0.03]"
      )}
      onClick={() => onRead(notif.id)}
    >
      <span className="text-lg leading-none mt-0.5 flex-shrink-0">{notifIcon(notif.type)}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className={cn("text-sm font-medium truncate", notif.read ? "text-white/60" : "text-white")}>
            {notif.title}
          </p>
          <span className="text-[10px] text-white/30 flex-shrink-0">{timeAgo(notif.timestamp)}</span>
        </div>
        <p className="text-xs text-white/40 mt-0.5 line-clamp-2">{notif.body}</p>
      </div>
      {!notif.read && <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 mt-2" />}
    </div>
  );

  if (notif.link) {
    return (
      <Link href={notif.link} onClick={onClose}>
        {content}
      </Link>
    );
  }
  return content;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function NotificationCenter({ open, onOpenChange }: Props) {
  const { notifications, unreadCount, markRead, markAll, clearAll } = useNotificationsCtx();
  const { address } = useAccount();
  const ref = useRef<HTMLDivElement>(null);
  const t = useTranslations();

  const [xmtpEnabled, setXmtpEnabled] = useState(true);
  useEffect(() => {
    if (!address) return;
    setXmtpEnabled(localStorage.getItem(`xmtp-registered-${address.toLowerCase()}`) === '1');
  }, [address, open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onOpenChange]);

  return (
    <>
      {/* Mobile: link to full notifications page */}
      <Link
        href="/notifications"
        className="md:hidden inline-flex items-center justify-center relative p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-0.5 rounded-full bg-primary text-[9px] font-bold text-white flex items-center justify-center leading-none">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Link>

      {/* Desktop: dropdown */}
      <div ref={ref} className="hidden md:block relative">
        <button
          onClick={() => onOpenChange(!open)}
          className="relative p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
          title="Notifications"
          aria-label="Notifications"
        >
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 min-w-[16px] h-4 px-0.5 rounded-full bg-primary text-[9px] font-bold text-white flex items-center justify-center leading-none">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>

        {open && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-150 absolute right-0 top-full mt-2 w-80 max-h-[480px] flex flex-col rounded-xl border border-white/10 bg-black shadow-2xl shadow-black/50 overflow-hidden z-50">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Bell className="w-3.5 h-3.5 text-white/50" />
                <span className="text-sm font-semibold">{t("notifications.title")}</span>
                {unreadCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-primary/20 text-primary text-[10px] font-bold">
                    {unreadCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={markAll}
                    title={t("notifications.mark_all_read")}
                    className="p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/5 transition-colors"
                  >
                    <CheckCheck className="w-3.5 h-3.5" />
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    onClick={clearAll}
                    title={t("notifications.clear_all")}
                    className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-white/5 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => onOpenChange(false)}
                  className="p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/5 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* List */}
            <div className="overflow-y-auto flex-1 overscroll-contain">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-white/30">
                  <Bell className="w-8 h-8 opacity-30" />
                  <p className="text-sm">{t("notifications.empty")}</p>
                </div>
              ) : (
                notifications.map((n) => (
                  <NotifRow
                    key={n.id}
                    notif={n}
                    onRead={markRead}
                    onClose={() => onOpenChange(false)}
                  />
                ))
              )}
            </div>

            {/* Hint: enable XMTP for message notifications */}
            {address && !xmtpEnabled && (
              <Link
                href="/chat"
                onClick={() => onOpenChange(false)}
                className="flex items-center gap-2 px-4 py-2.5 border-t border-white/[0.06] text-xs text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
              >
                <MessageCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {t("notifications.enable_messaging_hint")}
              </Link>
            )}

            {/* Footer */}
            <div className="border-t border-white/10 flex-shrink-0">
              <Link
                href="/notifications"
                onClick={() => onOpenChange(false)}
                className="flex items-center justify-center gap-1.5 py-2.5 text-xs text-white/35 hover:text-white/60 hover:bg-white/5 transition-colors w-full"
              >
                {t("notifications.title")}
                <ExternalLink className="w-3 h-3" />
              </Link>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
