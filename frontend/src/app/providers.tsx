"use client";

import React, { useState, useEffect, useRef } from "react";
import { Provider as UrqlProvider } from 'urql'
import { createGraphClient } from '@/lib/graph'

const graphClient = createGraphClient()
import { WagmiProvider, createStorage, useAccount, useWalletClient, useReconnect } from "wagmi";
import { http, fallback } from "viem";
import {
  RainbowKitProvider,
  darkTheme,
  lightTheme,
  getDefaultConfig,
  connectorsForWallets,
} from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  coinbaseWallet,
  walletConnectWallet,
  rainbowWallet,
  trustWallet,
  ledgerWallet,
  braveWallet,
  okxWallet,
  phantomWallet,
  injectedWallet,
  rabbyWallet,
  safepalWallet,
  zerionWallet,
  bitgetWallet,
  oneKeyWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { appChain, appChainId, isMainnet } from "@/config/chain";
import { useXmtpNotifications } from "@/hooks/useXmtpNotifications";
import { LocaleProvider } from "@/components/LocaleProvider";
import { isPushSupported, enablePush } from "@/lib/webpush";
import { NotificationsProvider } from "@/contexts/NotificationsContext";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// Snapshot last load's XMTP breadcrumb trail *before* this load's XMTP code starts
// overwriting it. Module eval runs during hydration — before any React effect, so
// it always beats initXmtpClient()'s crumbs. After a crash-reload, the "-prev" copy
// holds exactly what ran right before the tab died (see xmtpCrumb in lib/xmtp.ts).
const XMTP_CRUMB_KEY = "hexseal-xmtp-crumb";
const XMTP_DEBUG_KEY = "hexseal-xmtp-debug";
if (typeof window !== "undefined") {
  try {
    const live = localStorage.getItem(XMTP_CRUMB_KEY);
    if (live) localStorage.setItem(`${XMTP_CRUMB_KEY}-prev`, live);
    localStorage.removeItem(XMTP_CRUMB_KEY);
  } catch { /* localStorage unavailable */ }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chains = [appChain] as any;
// Official Base public RPC — always works, no auth required.
const publicRpc = isMainnet ? "https://mainnet.base.org" : "https://sepolia.base.org";
// /api/rpc proxies through Next.js (uses server-side RPC_URL with API key).
// On the server (SSR) relative URLs don't work — fall back to publicRpc directly.
const clientRpc = typeof window !== "undefined" ? `${window.location.origin}/api/rpc` : publicRpc;
const transports = {
  [appChainId]: fallback([
    http(clientRpc,  { timeout: 20_000 }), // /api/rpc → private RPC with key
    http(publicRpc,  { timeout: 20_000 }), // sepolia.base.org — official fallback
  ]),
};

const safeStorage = createStorage({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
});

// Full wallet list when WalletConnect projectId is available.
// Falls back to injected-only to avoid WC API errors when projectId is missing.
const config = projectId
  ? getDefaultConfig({
      appName: "Hexseal",
      appDescription: "Decentralized freelance protocol on Base",
      appUrl: typeof window !== "undefined" ? window.location.origin : "https://hexseal.net",
      appIcon: typeof window !== "undefined"
        ? `${window.location.origin}/hexseal-app-icon.svg`
        : "https://hexseal.net/hexseal-app-icon.svg",
      projectId,
      chains,
      transports,
      storage: safeStorage,
      ssr: true,
      pollingInterval: 6_000,
      wallets: [
        {
          groupName: "Popular",
          wallets: [
            metaMaskWallet,
            rabbyWallet,
            coinbaseWallet,
            rainbowWallet,
            trustWallet,
            okxWallet,
          ],
        },
        {
          groupName: "More",
          wallets: [
            walletConnectWallet,
            phantomWallet,
            braveWallet,
            zerionWallet,
            bitgetWallet,
            safepalWallet,
            oneKeyWallet,
            ledgerWallet,
            injectedWallet,
          ],
        },
      ],
    })
  : createConfig({
      chains,
      transports,
      connectors: [injected({ shimDisconnect: true })],
      storage: safeStorage,
      ssr: true,
      pollingInterval: 6_000,
    });

function XmtpNotificationsMount() {
  useXmtpNotifications();
  return null;
}

// Re-registers push subscription with the relayer at most once per 24 h.
// Keeps the relayer's subscription list fresh after restarts without
// prompting a wallet signature on every page load.
const PUSH_REG_KEY = (addr: string) => `hexseal-push-reg-${addr.toLowerCase()}`;
const PUSH_REG_TTL = 24 * 60 * 60 * 1000; // 24 h

function PushAutoMount() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  useEffect(() => {
    if (!address || !isPushSupported() || !walletClient) return;
    if (Notification.permission !== 'granted') return;
    // Rate-limit: skip if re-registered within the last 24 h
    try {
      const last = Number(localStorage.getItem(PUSH_REG_KEY(address)) ?? 0);
      if (Date.now() - last < PUSH_REG_TTL) return;
    } catch { /* localStorage unavailable */ }
    const signMsg = (msg: string) =>
      walletClient.signMessage({ account: address as `0x${string}`, message: msg });
    enablePush(address, signMsg)
      .then(result => {
        if (result === 'ok') {
          try { localStorage.setItem(PUSH_REG_KEY(address), String(Date.now())); } catch {}
        }
      })
      .catch(() => {});
  }, [address, walletClient]);
  return null;
}


function RainbowKitProviders({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  const rkTheme =
    mounted && resolvedTheme === "light"
      ? lightTheme({
          accentColor: "#000000",
          accentColorForeground: "#ffffff",
          borderRadius: "small",
          fontStack: "system",
          overlayBlur: "small",
        })
      : darkTheme({
          accentColor: "#ffffff",
          accentColorForeground: "#000000",
          borderRadius: "small",
          fontStack: "system",
          overlayBlur: "small",
        });

  return (
    <RainbowKitProvider theme={rkTheme}>
      <XmtpNotificationsMount />
      <PushAutoMount />
      {children}
    </RainbowKitProvider>
  );
}

// On Android, connecting via WalletConnect deep-links out to the wallet app, which
// backgrounds this tab. Mobile browsers suspend the WC relay WebSocket while
// backgrounded, so the wallet's approval arrives on a dead socket and wagmi's
// connector never fires "connect" — useAccount() stays 'disconnected' even though
// WalletConnect Core has already persisted the session to IndexedDB. That's why a
// full page reload "fixes" it: reconnectOnMount re-reads the persisted session.
// This does the same reconnect the moment the tab returns to the foreground, so the
// user never has to reload. reconnect() is a no-op when there's nothing persisted,
// so firing it on every foreground-while-disconnected is safe.
function WalletReconnector() {
  const { status } = useAccount();
  const { reconnect } = useReconnect();
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => {
    const tryReconnect = () => {
      if (document.visibilityState !== "visible") return;
      if (statusRef.current === "disconnected") reconnect();
    };
    document.addEventListener("visibilitychange", tryReconnect);
    window.addEventListener("focus", tryReconnect);
    return () => {
      document.removeEventListener("visibilitychange", tryReconnect);
      window.removeEventListener("focus", tryReconnect);
    };
  }, [reconnect]);
  return null;
}

// Temporary Android crash diagnostic. Open the app once with ?xmtpdebug=1 to arm it
// (?xmtpdebug=0 to disarm). While armed, every page load shows the XMTP breadcrumb
// trail from the *previous* load in a fixed banner — so after the tab crashes and
// reloads, the tester can read which XMTP operation was in flight when it died,
// with no USB / remote debugger needed. Remove once the crash is diagnosed.
function XmtpDebugOverlay() {
  const [trail, setTrail] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("xmtpdebug");
      if (q === "1") localStorage.setItem(XMTP_DEBUG_KEY, "1");
      if (q === "0") localStorage.removeItem(XMTP_DEBUG_KEY);
      if (localStorage.getItem(XMTP_DEBUG_KEY) === "1") {
        setTrail(localStorage.getItem(`${XMTP_CRUMB_KEY}-prev`) || "(no XMTP steps recorded before this load)");
      }
    } catch { /* localStorage unavailable */ }
  }, []);
  if (!trail || dismissed) return null;
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 99999, background: "rgba(0,0,0,0.92)", color: "#9f9", font: "11px/1.45 monospace", padding: "8px 10px", borderTop: "1px solid #2a2", whiteSpace: "pre-wrap", maxHeight: "45vh", overflowY: "auto" }}>
      <div style={{ color: "#fff", marginBottom: 4 }}>XMTP trail — last steps before this load (crash lands on the last line):</div>
      {trail}
      <div style={{ marginTop: 8, display: "flex", gap: 12 }}>
        <button onClick={() => { try { localStorage.removeItem(`${XMTP_CRUMB_KEY}-prev`); } catch {} setTrail("(cleared)"); }} style={{ color: "#ff8", background: "none", border: "1px solid #663", padding: "2px 10px", borderRadius: 4 }}>clear</button>
        <button onClick={() => setDismissed(true)} style={{ color: "#8ff", background: "none", border: "1px solid #366", padding: "2px 10px", borderRadius: 4 }}>close</button>
      </div>
    </div>
  );
}

// Forces all queries to refetch when user returns to the tab/PWA.
// React Query's built-in refetchOnWindowFocus is unreliable in iOS standalone mode.
function VisibilityRefresher({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        queryClient.invalidateQueries();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [queryClient]);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // wagmi already polls for new blocks via pollingInterval and
            // invalidates its own queries — don't add a second independent timer.
            refetchInterval: false,
            // Treat data as fresh for 8 s to avoid back-to-back fetches.
            staleTime: 8_000,
            // Handled by VisibilityRefresher below — don't double-trigger.
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <UrqlProvider value={graphClient}>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <VisibilityRefresher queryClient={queryClient} />
          <WalletReconnector />
          <XmtpDebugOverlay />
          <NextThemesProvider attribute="class" forcedTheme="dark">
            <LocaleProvider>
              <NotificationsProvider>
                <RainbowKitProviders>{children}</RainbowKitProviders>
              </NotificationsProvider>
            </LocaleProvider>
          </NextThemesProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </UrqlProvider>
  );
}

export default Providers;
