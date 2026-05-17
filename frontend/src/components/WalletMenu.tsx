"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useAccount, useDisconnect, useBalance, useEnsName, useReadContract } from "wagmi";
import { appChainId } from "@/config/chain";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { CONTRACTS, ARBITER_REGISTRY_ABI, DIAMOND_ABI } from "@/config/contracts";
import type { Abi } from "viem";
import { fetchProfile } from "@/lib/profiles-ipfs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { User, LayoutDashboard, Settings, LogOut, Copy, Check, ChevronDown, MessageCircle, Shield, ShieldCheck, HelpCircle, Globe, ChevronRight } from "lucide-react";
import { toast } from "react-hot-toast";
import { useTranslations } from "next-intl";
import { useLocale } from "@/hooks/useLocale";
import { locales, localeNames, type Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

interface Props {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** On mobile: hide Dashboard/Messages/Settings (already in bottom nav) */
  hideNavItems?: boolean;
  /** Hide locale toggle (e.g. on home page) */
  hideLocale?: boolean;
}

export default function WalletMenu({ open, onOpenChange, hideNavItems = false, hideLocale = false }: Props) {
  const t = useTranslations();
  const { locale, setLocale } = useLocale();
  const [langOpen, setLangOpen] = useState(false);
  const { address, isConnected, status } = useAccount();
  const { disconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [profileAvatarUrl, setProfileAvatarUrl] = useState<string | null>(null);

  useEffect(() => { setMounted(true); }, []);

  // Sync "has-wallet" cookie so middleware can redirect "/" → "/board" instantly.
  useEffect(() => {
    if (isConnected) {
      document.cookie = 'has-wallet=1; path=/; max-age=31536000; SameSite=Lax';
    } else if (status === 'disconnected') {
      document.cookie = 'has-wallet=; path=/; max-age=0; SameSite=Lax';
    }
  }, [isConnected, status]);

  // ENS name (only on mainnet, but we try anyway)
  const { data: ensName } = useEnsName({
    address: address as `0x${string}`,
    chainId: appChainId,
    query: { enabled: !!address },
  });

  // Arbiter check
  const { data: isArbiter } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "isRegisteredArbiter",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address },
  }) as { data: boolean | undefined };

  // Owner check
  const { data: diamondOwner } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI as Abi,
    functionName: "owner",
    query: { enabled: !!address },
  }) as { data: string | undefined };
  const isOwner = !!address && !!diamondOwner &&
    address.toLowerCase() === diamondOwner.toLowerCase();

  // USDC balance
  const { data: usdcBalanceData } = useBalance({
    address: address,
    token: CONTRACTS.usdc as `0x${string}`,
    query: { enabled: !!address },
  });
  const usdcBalance = usdcBalanceData?.value ?? BigInt(0);

  // Fetch profile from IPFS (name + avatar)
  useEffect(() => {
    if (!address) return;
    let alive = true;
    const loadProfile = async () => {
      try {
        const profile = await fetchProfile(address);
        if (!alive) return;
        if (profile?.displayName) setDisplayName(profile.displayName);
        if (profile?.avatarCid) {
          const gw = process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://dweb.link";
          setProfileAvatarUrl(`${gw}/ipfs/${profile.avatarCid}`);
        }
      } catch {}
    };
    loadProfile();
    return () => { alive = false; };
  }, [address]);

  // Display name priority: ENS > profile name > truncated address
  const displayText = ensName || displayName || (address ? shortAddr(address) : "");
  // Avatar priority: IPFS profile > effigy identicon
  const avatarUrl = profileAvatarUrl || (address ? `https://effigy.im/a/${address}.svg` : "");

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

  const handleDisconnect = () => {
    disconnect();
    // Clear cookie so middleware won't redirect back to /board
    document.cookie = 'has-wallet=; path=/; max-age=0; SameSite=Lax';
    // Clear wagmi + WalletConnect session storage to prevent auto-reconnect on mobile
    try {
      const keys = Object.keys(localStorage).filter(k =>
        k.startsWith('wagmi') || k.startsWith('wc@') || k.startsWith('@walletconnect') || k === 'wallet-ever-connected'
      );
      keys.forEach(k => localStorage.removeItem(k));
    } catch {}
    window.location.href = "/";
  };

  if (!mounted || !isConnected || !address) {
    return (
      <div className="flex items-center gap-1">
        {!hideLocale && <LocaleToggle locale={locale} setLocale={setLocale} />}
        <button
          onClick={openConnectModal}
          disabled={!mounted}
          className="flex items-center gap-2 h-9 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 transition-colors text-sm text-white/60 hover:text-white/90 disabled:opacity-0"
        >
          {t("wallet.connect")}
        </button>
      </div>
    );
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => { if (!o) setLangOpen(false); onOpenChange?.(o); }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 h-9 px-2.5 rounded-lg border border-white/[0.10] bg-white/[0.06] hover:bg-white/[0.10] transition-colors text-white/75 hover:text-white/90 outline-none focus-visible:ring-1 focus-visible:ring-white/20">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={avatarUrl}
            alt="avatar"
            className="w-5 h-5 rounded-full ring-1 ring-white/[0.08]"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <span className="hidden sm:inline font-mono text-sm">{displayText}</span>
          <ChevronDown className="w-3 h-3 text-white/35" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64 bg-[#0e0e0e] border-white/[0.08] shadow-2xl shadow-black/80 p-0 overflow-hidden z-[200]">

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
              <p className="text-xs font-mono text-white/45 mt-1.5">
                {(Number(usdcBalance) / 1e6).toFixed(2)} USDC
              </p>
            </div>
          </div>
        </div>

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
        {(isArbiter || isOwner) && (
          <>
            <div className="h-px bg-white/[0.06]" />
            <div className="p-1">
              {isArbiter && (
                <DropdownMenuItem asChild>
                  <Link href="/arbiter" className="flex items-center gap-2.5 cursor-pointer text-blue-400 focus:text-blue-400">
                    <Shield className="w-3.5 h-3.5" />
                    {t("wallet.arbiter_panel")}
                  </Link>
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

        {/* ── Help ── */}
        <div className="h-px bg-white/[0.06]" />
        <div className="p-1">
          <DropdownMenuItem
            onClick={() => window.dispatchEvent(new Event('sig404:open-onboarding'))}
            className="flex items-center gap-2.5 cursor-pointer text-white/35 focus:text-white/70"
          >
            <HelpCircle className="w-3.5 h-3.5" />
            {t("wallet.how_it_works")}
          </DropdownMenuItem>
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
          {langOpen && (
            <div className="mt-0.5 overflow-y-auto max-h-52 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.1)_transparent]">
              {locales.map((l) => (
                <button
                  key={l}
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
                </button>
              ))}
            </div>
          )}
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
      {open && (
        <div className="animate-in slide-in-from-top-2 fade-in duration-150 absolute top-full mt-2 right-0 w-44 bg-[#111113]/95 backdrop-blur-2xl border border-white/[0.09] rounded-xl overflow-hidden shadow-2xl shadow-black/70 z-[200]">
          {locales.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => { setLocale(l as Locale); setOpen(false); }}
              className={cn(
                "w-full flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors",
                l === locale ? "text-primary bg-primary/10" : "text-white/70 hover:text-white hover:bg-white/5"
              )}
            >
              <span className="font-mono text-xs opacity-50 w-6">{l.toUpperCase()}</span>
              <span>{localeNames[l as Locale]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
