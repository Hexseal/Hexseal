"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useDisconnect, useSwitchChain } from "wagmi";
import { appChainId, appChain } from "@/config/chain";
import { useConnectWallet } from "@/hooks/useConnectWallet";
import type { WalletAccountData } from "@/hooks/useWalletAccountData";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { User, LayoutDashboard, Settings, LogOut, Copy, Check, ChevronDown, MessageCircle, MessageCircleOff, BellOff, BellRing, Shield, ShieldCheck, ShieldPlus, ShieldQuestion, HelpCircle, Globe, ChevronRight, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "react-hot-toast";
import { useTranslations } from "next-intl";
import { useLocale } from "@/hooks/useLocale";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { locales, localeNames, type Locale } from "@/i18n/config";
import { cn, shortAddr } from "@/lib/utils";
import { useXmtp } from "@/contexts/XmtpContext";


interface Props {
  /** Account/profile/contract data — computed once by Header via useWalletAccountData()
   *  and shared between the mobile and desktop instances, so neither this component
   *  nor its sibling re-runs the same balance/XP/role reads independently. */
  data: WalletAccountData;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** On mobile: hide Dashboard/Messages/Settings (already in bottom nav) */
  hideNavItems?: boolean;
  /** Hide locale toggle (e.g. on home page) */
  hideLocale?: boolean;
}

export default function WalletMenu({ data, open, onOpenChange, hideNavItems = false, hideLocale = false }: Props) {
  const t = useTranslations();
  const { locale, setLocale } = useLocale();
  const [langOpen, setLangOpen] = useState(false);
  const { status: xmtpStatus, disable: disableXmtp, retry: retryXmtp } = useXmtp();
  const { subscribed: pushOn, stale: pushStale, disable: disablePushNotif, loading: pushLoading } = usePushNotifications();
  const {
    address, isConnected, status, isWrongChain,
    displayText, avatarUrl, usdcBalance, usdcBalanceUnavailable,
    isArbiter, isOwner, canApplyAsArbiter, applyPending, handleApplyAsArbiter,
    rolesUnreadable, rolesRechecking, recheckRoles,
  } = data;
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  // Единая точка запуска подключения: на мобильном она зовёт WalletConnect
  // напрямую, на десктопе открывает модалку RainbowKit (см. хук).
  const { connect: connectWallet, connecting } = useConnectWallet();
  const [mounted, setMounted] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  // Sync "has-wallet" cookie so middleware can redirect "/" → "/board" instantly.
  useEffect(() => {
    if (isConnected) {
      document.cookie = 'has-wallet=1; path=/; max-age=31536000; SameSite=Lax';
    } else if (status === 'disconnected') {
      document.cookie = 'has-wallet=; path=/; max-age=0; SameSite=Lax';
    }
  }, [isConnected, status]);

  const handleCopy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast.success(t("wallet.copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("wallet.copy_failed"));
    }
  };

  const handleSwitchChain = async () => {
    try {
      await switchChainAsync({ chainId: appChainId });
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      // Silently ignore the user closing the wallet's network-switch prompt —
      // only surface genuine failures (unsupported chain, RPC error, etc.),
      // which previously vanished with no feedback at all.
      if (e?.name === 'UserRejectedRequestError' || /user rejected/i.test(e?.message ?? '')) return;
      toast.error(e?.message || t("common.error"));
    }
  };

  const handleDisconnect = useCallback(() => {
    setDisconnecting(true);
    // Brief fade-out, then hard-navigate.
    //
    // This MUST be a real navigation, not router.push(). Wagmi's WalletConnect
    // connector caches its EthereumProvider in a module-level closure variable
    // that lives for the tab's lifetime — disconnect() never resets it (it even
    // silently swallows "No matching key", the exact error a stale session
    // throws, without clearing the cached provider's in-memory session). A soft
    // SPA navigation leaves that stale provider alive, so the next connect()
    // call reuses its dead session instead of starting a fresh handshake — that
    // mismatch is what makes reconnect hang forever waiting on WalletConnect.
    // Only a full reload tears down the module and forces a clean provider.
    setTimeout(async () => {
      try {
        await disconnectAsync();
      } catch {}
      document.cookie = 'has-wallet=; path=/; max-age=0; SameSite=Lax';
      try {
        const keys = Object.keys(localStorage).filter(k =>
          k.startsWith('wagmi') || k.startsWith('wc@') || k.startsWith('@walletconnect') || k === 'wallet-ever-connected'
        );
        keys.forEach(k => localStorage.removeItem(k));
      } catch {}
      // WalletConnect's Core also keeps its session/pairing/keychain state in
      // IndexedDB (WALLET_CONNECT_V2_INDEXED_DB), not localStorage — clear that
      // too so a fresh provider (after the reload below) has nothing stale to resume.
      try {
        indexedDB.deleteDatabase('WALLET_CONNECT_V2_INDEXED_DB');
      } catch {}
      window.location.assign('/');
    }, 280);
  }, [disconnectAsync]);

  // While mounting or wagmi is reconnecting a saved session: show a fixed-size
  // skeleton so the header right column doesn't shift when the wallet button appears.
  const btnH = hideNavItems ? 'h-8' : 'h-9';

  if (!mounted || status === 'reconnecting') {
    return <div className={`${btnH} ${hideNavItems ? 'w-[80px]' : 'w-[130px]'} rounded-lg bg-white/[0.06]`} />;
  }

  if (!isConnected || !address) {
    return (
      <div className="flex items-center gap-1">
        {!hideLocale && <LocaleToggle locale={locale} setLocale={setLocale} />}
        <button
          onClick={connectWallet}
          disabled={connecting}
          className={`flex items-center gap-2 ${btnH} px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 transition-colors text-sm text-white/60 hover:text-white/90 whitespace-nowrap disabled:opacity-60`}
        >
          {connecting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {connecting ? t("wallet.connecting") : t("wallet.connect")}
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Full-screen fade-out overlay on disconnect */}
      <AnimatePresence>
        {disconnecting && (
          <motion.div
            className="fixed inset-0 bg-black z-[9999] pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
          />
        )}
      </AnimatePresence>

    <DropdownMenu
      open={open}
      onOpenChange={(o) => { if (!o) setLangOpen(false); onOpenChange?.(o); }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        {hideNavItems ? (
          // Mobile pill: icon-style, matches the Bell button (transparent p-2, no border)
          <button className="relative flex items-center gap-0.5 p-2 rounded-lg hover:bg-white/5 transition-colors outline-none">
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatarUrl}
                alt="avatar"
                className="w-4 h-4 rounded-full ring-1 ring-white/[0.08]"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              {isWrongChain && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-orange-500 rounded-full border border-[#111113]" />
              )}
            </div>
            <ChevronDown className="w-3 h-3 text-white/35" />
          </button>
        ) : (
          <button className={`flex items-center gap-2 ${btnH} px-2.5 rounded-lg border ${isWrongChain ? 'border-orange-500/40 bg-orange-500/5' : 'border-white/[0.10] bg-white/[0.06]'} hover:bg-white/[0.10] transition-colors text-white/75 hover:text-white/90 outline-none focus-visible:ring-1 focus-visible:ring-white/20`}>
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatarUrl}
                alt="avatar"
                className="w-5 h-5 rounded-full ring-1 ring-white/[0.08]"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              {isWrongChain && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-orange-500 rounded-full border border-[#111113]" />
              )}
            </div>
            <span className="hidden sm:inline font-mono text-sm">{isWrongChain ? 'Wrong Network' : displayText}</span>
            <ChevronDown className="w-3 h-3 text-white/35" />
          </button>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64 bg-[#111113] border-white/[0.08] shadow-2xl shadow-black/80 p-0 overflow-hidden z-[200]">

        {/* ── Profile header ── */}
        <div className="px-4 py-3.5 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={avatarUrl}
              alt="avatar"
              className="w-10 h-10 rounded-full ring-1 ring-white/[0.08] flex-shrink-0"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-white/90 truncate">{displayText}</p>
              <div className="flex items-center gap-1 mt-0.5">
                <p className="text-xs text-white/35 font-mono">{shortAddr(address)}</p>
                <button
                  onClick={handleCopy}
                  className="text-white/25 hover:text-white/60 transition-colors"
                  aria-label="Copy address"
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
              {/* Прочерк, а не «0.00»: непрочитанный баланс — это отсутствие
                  данных, а не пустой кошелёк. Тот же приём, что в
                  `AgreementsStats` для оборота при сбое сабграфа. */}
              <p className={`text-xs font-mono mt-1.5 ${usdcBalanceUnavailable ? 'text-white/25' : 'text-white/45'}`}>
                {usdcBalanceUnavailable ? '— USDC' : `${(Number(usdcBalance) / 1e6).toFixed(2)} USDC`}
              </p>
            </div>
          </div>
        </div>

        {/* ── Wrong network banner ── */}
        {isWrongChain && (
          <>
            <div className="h-px bg-white/[0.06]" />
            <div className="p-2">
              <button
                type="button"
                onClick={handleSwitchChain}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 transition-colors"
              >
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                Switch to {appChain.name}
              </button>
            </div>
          </>
        )}

        {/* ── Navigation (hidden on mobile — bottom nav handles these) ── */}
        {!hideNavItems && (
          <div className="p-1">
            <DropdownMenuItem asChild>
              <Link href={`/profile/${address}`} className="flex items-center gap-2.5 cursor-pointer">
                <User className="w-3.5 h-3.5 text-white/40" />
                {t("wallet.my_profile")}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/dashboard" className="flex items-center gap-2.5 cursor-pointer">
                <LayoutDashboard className="w-3.5 h-3.5 text-white/40" />
                {t("wallet.dashboard")}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/chat" className="flex items-center gap-2.5 cursor-pointer">
                <MessageCircle className="w-3.5 h-3.5 text-white/40" />
                {t("wallet.messages")}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/profile/edit" className="flex items-center gap-2.5 cursor-pointer">
                <Settings className="w-3.5 h-3.5 text-white/40" />
                {t("wallet.settings")}
              </Link>
            </DropdownMenuItem>
          </div>
        )}

        {/* ── Mobile-only nav shortcut (profile) ── */}
        {hideNavItems && (
          <div className="p-1">
            <DropdownMenuItem asChild>
              <Link href={`/profile/${address}`} className="flex items-center gap-2.5 cursor-pointer">
                <User className="w-3.5 h-3.5 text-white/40" />
                {t("wallet.my_profile")}
              </Link>
            </DropdownMenuItem>
          </div>
        )}

        {/* ── Role-specific ── */}
        {/* `rolesUnreadable` обязан быть в этом условии: иначе строка «не смогли
            проверить» размонтируется вместе с секцией и разделителем — ровно то
            молчаливое исчезновение, которое чинится. */}
        {(isArbiter || isOwner || canApplyAsArbiter || rolesUnreadable) && (
          <>
            <div className="h-px bg-white/[0.06]" />
            <div className="p-1">
              {/* ТРЕТЬЕ СОСТОЯНИЕ РОЛИ. Не «арбитр» и не «не арбитр»: роль не
                  прочиталась. Панелей не открываем (прав при неизвестном
                  состоянии не выдаём), но и обратного не утверждаем — говорим
                  прямо и даём переспросить. */}
              {rolesUnreadable && (
                <DropdownMenuItem
                  onSelect={(e) => { e.preventDefault(); recheckRoles(); }}
                  disabled={rolesRechecking}
                  className="flex items-start gap-2.5 cursor-pointer text-amber-400/80 focus:text-amber-300 disabled:opacity-50"
                >
                  {rolesRechecking
                    ? <Loader2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 animate-spin" />
                    : <ShieldQuestion className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
                  <span className="text-xs leading-snug whitespace-normal">
                    {t("wallet.roles_unreadable")}
                    <span className="block mt-0.5 text-amber-400/60">
                      {rolesRechecking ? t("common.loading") : t("common.retry")}
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
              {isArbiter && (
                <DropdownMenuItem asChild>
                  <Link href="/arbiter" className="flex items-center gap-2.5 cursor-pointer text-blue-400 hover:text-white focus:text-white">
                    <Shield className="w-3.5 h-3.5" />
                    {t("wallet.arbiter_panel")}
                  </Link>
                </DropdownMenuItem>
              )}
              {canApplyAsArbiter && (
                <DropdownMenuItem
                  onClick={handleApplyAsArbiter}
                  disabled={applyPending}
                  className="flex items-center gap-2.5 cursor-pointer text-emerald-400 focus:text-emerald-400 disabled:opacity-50"
                >
                  <ShieldPlus className="w-3.5 h-3.5" />
                  {applyPending ? t("wallet.applying_arbiter") : t("wallet.become_arbiter")}
                </DropdownMenuItem>
              )}
              {isOwner && (
                <DropdownMenuItem asChild>
                  <Link href="/admin" className="flex items-center gap-2.5 cursor-pointer text-amber-400 focus:text-amber-400">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    {t("wallet.admin_panel")}
                  </Link>
                </DropdownMenuItem>
              )}
            </div>
          </>
        )}

        {/* ── Help + messaging toggle ── */}
        <div className="h-px bg-white/[0.06]" />
        <div className="p-1">
          <DropdownMenuItem
            onClick={() => window.dispatchEvent(new Event('hexseal:open-onboarding'))}
            className="flex items-center gap-2.5 cursor-pointer text-white/35 focus:text-white/70"
          >
            <HelpCircle className="w-3.5 h-3.5" />
            {t("wallet.how_it_works")}
          </DropdownMenuItem>
          {xmtpStatus === 'loading' && (
            <DropdownMenuItem
              disabled
              className="flex items-center gap-2.5 text-white/25"
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t("wallet.connecting_messaging")}
            </DropdownMenuItem>
          )}
          {xmtpStatus === 'ready' && (
            <DropdownMenuItem
              onClick={disableXmtp}
              className="flex items-center gap-2.5 cursor-pointer text-white/35 focus:text-white/70"
            >
              <MessageCircleOff className="w-3.5 h-3.5" />
              {t("wallet.disable_messaging")}
            </DropdownMenuItem>
          )}
          {xmtpStatus === 'error' && (
            <DropdownMenuItem
              onClick={retryXmtp}
              className="flex items-center gap-2.5 cursor-pointer text-white/35 focus:text-white/70"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              {t("wallet.enable_messaging")}
            </DropdownMenuItem>
          )}
          {/* Протухшая подписка — это НЕ «уведомления включены».
              Признак `stale` заведён специально для того, чтобы протухание было
              видно (суточная фоновая перерегистрация убрана: она раз в сутки
              сама уводила человека в кошелёк за подписью). Меню его не читало
              и показывало «Отключить уведомления» тому, кому уже сутки ничего
              не доходит: единственное доступное действие — выключить то, что и
              так не работает. Включение живёт на странице уведомлений (правило
              владельца, см. lib/pushPrompt.ts) — туда и ведём. */}
          {pushOn && pushStale && (
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link href="/notifications" className="flex items-center gap-2.5 text-amber-400/70 focus:text-amber-300">
                <BellRing className="w-3.5 h-3.5" />
                {t("wallet.notifications_stale")}
              </Link>
            </DropdownMenuItem>
          )}
          {/* Пункт «Отключить» остаётся и у протухшей подписки: выключать её
              всё ещё есть чем (живая подписка устройства + запись отказа), и
              отнимать единственный способ выключить ради честности было бы
              обменом одной поломки на другую. */}
          {pushOn && (
            <DropdownMenuItem
              disabled={pushLoading}
              onSelect={(e) => {
                // Отключение уходит в сеть и в кошелёк за подписью: пункт меню
                // закрывается сам, а нам нужно дождаться исхода и сказать о
                // провале. Раньше результат не смотрели вовсе — неудавшееся
                // выключение выглядело точно так же, как удавшееся.
                e.preventDefault();
                if (pushLoading) return;
                void disablePushNotif().then(ok => {
                  if (!ok) toast.error(t("wallet.disable_notifications_failed"));
                });
              }}
              className="flex items-center gap-2.5 cursor-pointer text-white/35 focus:text-white/70"
            >
              {pushLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellOff className="w-3.5 h-3.5" />}
              {t("wallet.disable_notifications")}
            </DropdownMenuItem>
          )}
        </div>

        {/* ── Language ── */}
        <div className="h-px bg-white/[0.06]" />
        <div className="p-1">
          <button
            type="button"
            onClick={() => setLangOpen(v => !v)}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-white/50 hover:text-white/80 hover:bg-white/5 transition-colors"
          >
            <Globe className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="flex-1 text-left">{localeNames[locale as Locale]}</span>
            <ChevronRight className={cn("w-3.5 h-3.5 transition-transform duration-150", langOpen && "rotate-90")} />
          </button>
          <AnimatePresence>
            {langOpen && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="mt-0.5 overflow-y-auto max-h-52 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.1)_transparent]">
                  {locales.map((l, i) => (
                    <motion.button
                      key={l}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.03, duration: 0.15 }}
                      type="button"
                      onClick={() => { setLocale(l as Locale); setLangOpen(false); }}
                      className={cn(
                        "w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors",
                        l === locale
                          ? "text-primary bg-primary/10"
                          : "text-white/50 hover:text-white/80 hover:bg-white/5"
                      )}
                    >
                      <span className="font-mono text-[10px] opacity-40 w-7 flex-shrink-0">{l.toUpperCase()}</span>
                      <span>{localeNames[l as Locale]}</span>
                    </motion.button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Disconnect ── */}
        <div className="h-px bg-white/[0.06]" />
        <div className="p-1">
          <DropdownMenuItem onClick={handleDisconnect} className="flex items-center gap-2.5 cursor-pointer text-destructive focus:text-destructive">
            <LogOut className="w-3.5 h-3.5" />
            {t("wallet.disconnect")}
          </DropdownMenuItem>
        </div>

      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}

function LocaleToggle({ locale, setLocale }: { locale: Locale; setLocale: (l: Locale) => void }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onOut(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onOut);
    return () => document.removeEventListener("mousedown", onOut);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 h-9 px-2.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 transition-colors text-xs text-white/50 hover:text-white/80 font-mono"
        aria-label="Switch language"
      >
        <Globe className="w-3.5 h-3.5" />
        {locale.toUpperCase()}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -8 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute top-full mt-2 right-0 w-44 bg-[#111113]/95 backdrop-blur-2xl border border-white/[0.09] rounded-xl overflow-hidden shadow-2xl shadow-black/70 z-[200]"
          >
            {locales.map((l, i) => (
              <motion.button
                key={l}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.03, duration: 0.15 }}
                type="button"
                onClick={() => { setLocale(l as Locale); setOpen(false); }}
                className={cn(
                  "w-full flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors",
                  l === locale ? "text-primary bg-primary/10" : "text-white/70 hover:text-white hover:bg-white/5"
                )}
              >
                <span className="font-mono text-xs opacity-50 w-6">{l.toUpperCase()}</span>
                <span>{localeNames[l as Locale]}</span>
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
