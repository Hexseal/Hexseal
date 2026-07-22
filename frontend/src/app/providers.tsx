"use client";

import React, { useState, useEffect, useRef } from "react";
import { Provider as UrqlProvider } from 'urql'
import { createGraphClient } from '@/lib/graph'

const graphClient = createGraphClient()
import { WagmiProvider, createStorage, useAccount, useWalletClient } from "wagmi";
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
import { isPushSupported, enablePush, getSwRegistration } from "@/lib/webpush";
import { NotificationsProvider } from "@/contexts/NotificationsContext";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// ── Debug breadcrumb trail (temporary Android diagnostic) ──────────────────────
// A shared localStorage trail that both the wallet-connect tracer (below) and the
// XMTP init path (xmtpCrumb in lib/xmtp.ts) append to. localStorage survives a tab
// crash *and* a tab kill+recreate, so after the tester returns from the wallet app
// we can read the exact sequence — and, via the per-load id, tell whether Android
// threw the whole tab away and recreated it (trail restarts with a new load id) or
// kept it alive (same id, more lines appended).
const XMTP_CRUMB_KEY = "hexseal-xmtp-crumb";
const XMTP_DEBUG_KEY = "hexseal-xmtp-debug";
function dbgCrumb(step: string): void {
  try {
    const t = new Date().toISOString().slice(11, 23);
    const prev = localStorage.getItem(XMTP_CRUMB_KEY);
    const trail = (prev ? prev.split("\n") : []).concat(`${t} ${step}`).slice(-28);
    localStorage.setItem(XMTP_CRUMB_KEY, trail.join("\n"));
  } catch { /* localStorage unavailable */ }
}
// Runs at module eval — before any React effect — so it always beats the app's own
// crumbs. Snapshots the previous load's trail to "-prev" (survives a crash), then
// starts this load's trail with a fresh random id.
if (typeof window !== "undefined") {
  try {
    const live = localStorage.getItem(XMTP_CRUMB_KEY);
    if (live) localStorage.setItem(`${XMTP_CRUMB_KEY}-prev`, live);
    localStorage.removeItem(XMTP_CRUMB_KEY);
    dbgCrumb(`load:${Math.random().toString(36).slice(2, 7)} ${location.pathname}`);
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

// NOTE: this MUST be rendered as a descendant of <XmtpProvider> (it lives under it in
// client-layout.tsx), otherwise useXmtp() inside useXmtpNotifications reads the default
// context value and its `status` is frozen at 'loading' forever — the effect then never
// re-runs on ready and the in-app notification store is never fed on a resumed PWA.
export function XmtpNotificationsMount() {
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

  // Register the service worker at app start. It used to be registered lazily, only
  // from lib/webpush's helpers — i.e. only if the user happened to open /notifications.
  // useXmtpNotifications awaits navigator.serviceWorker.ready before showing a native
  // notification while backgrounded, and that promise never resolved for anyone who
  // hadn't visited that page, silently killing the in-app native-notification path too.
  useEffect(() => { void getSwRegistration(); }, []);

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
      {/* XmtpNotificationsMount is NOT rendered here — it must live under <XmtpProvider>
          (see client-layout.tsx) so useXmtp()'s status isn't frozen at 'loading'. */}
      <PushAutoMount />
      {children}
    </RainbowKitProvider>
  );
}

// Traces the wagmi connection state machine into the debug trail so the tester can
// see, on screen, how far the WalletConnect handshake actually got after returning
// from the wallet app: disconnected → connecting → connected (good) vs. bouncing
// back to disconnected (the bug). Combined with the per-load id above, a trail that
// *restarts* with a new load id on return proves Android recreated the whole tab.
function WalletConnectTracer() {
  const { status, address } = useAccount();
  const last = useRef("");
  useEffect(() => {
    const line = `wc:${status}${address ? " " + address.slice(0, 6) : ""}`;
    if (line !== last.current) { last.current = line; dbgCrumb(line); }
  }, [status, address]);
  return null;
}

// Temporary Android diagnostic overlay. Arm once with ?xmtpdebug=1 (?xmtpdebug=0 to
// disarm). While armed it shows, live (refreshing every second, no reload needed),
// this load's trail plus the previous load's trail — so both the no-reload connect
// flow AND the crash-on-reload are visible on the device with no USB / debugger.
function XmtpDebugOverlay() {
  const [armed, setArmed] = useState(false);
  const [text, setText] = useState("");
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let iv: ReturnType<typeof setInterval> | undefined;
    try {
      const q = new URLSearchParams(window.location.search).get("xmtpdebug");
      if (q === "1") localStorage.setItem(XMTP_DEBUG_KEY, "1");
      if (q === "0") localStorage.removeItem(XMTP_DEBUG_KEY);
      if (localStorage.getItem(XMTP_DEBUG_KEY) !== "1") return;
      setArmed(true);
      const read = () => {
        try {
          const prev = localStorage.getItem(`${XMTP_CRUMB_KEY}-prev`) || "";
          const cur = localStorage.getItem(XMTP_CRUMB_KEY) || "(no steps yet)";
          setText((prev ? `── previous load ──\n${prev}\n\n` : "") + `── this load ──\n${cur}`);
        } catch { /* ignore */ }
      };
      read();
      iv = setInterval(read, 1000);
    } catch { /* localStorage unavailable */ }
    return () => { if (iv) clearInterval(iv); };
  }, []);
  if (!armed || dismissed) return null;
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 99999, background: "rgba(0,0,0,0.93)", color: "#9f9", font: "11px/1.45 monospace", padding: "8px 10px", borderTop: "1px solid #2a2", whiteSpace: "pre-wrap", maxHeight: "50vh", overflowY: "auto" }}>
      <div style={{ color: "#fff", marginBottom: 4 }}>Hexseal debug trail (live) — newest at bottom:</div>
      {text}
      <div style={{ marginTop: 8, display: "flex", gap: 12 }}>
        <button onClick={() => { try { localStorage.removeItem(XMTP_CRUMB_KEY); localStorage.removeItem(`${XMTP_CRUMB_KEY}-prev`); } catch {} }} style={{ color: "#ff8", background: "none", border: "1px solid #663", padding: "2px 10px", borderRadius: 4 }}>clear</button>
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
          <WalletConnectTracer />
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
