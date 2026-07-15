"use client";

import React, { useState, useEffect } from "react";
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
import { isPushSupported, enablePush } from "@/lib/webpush";
import { NotificationsProvider } from "@/contexts/NotificationsContext";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chains = [appChain] as any;
// Official Base public RPC — always works, no auth required.
const publicRpc = isMainnet ? "https://mainnet.base.org" : "https://sepolia.base.org";
// /api/rpc proxies through Next.js (uses server-side RPC_URL with API key).
// On the server (SSR) relative URLs don't work — fall back to publicRpc directly.
const clientRpc = typeof window !== "undefined" ? "/api/rpc" : publicRpc;
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
      appUrl: typeof window !== "undefined" ? window.location.origin : "https://hexseal.com",
      appIcon: typeof window !== "undefined"
        ? `${window.location.origin}/hexseal-app-icon.svg`
        : "https://hexseal.com/hexseal-app-icon.svg",
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
