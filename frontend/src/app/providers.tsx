"use client";

import React, { useState, useEffect } from "react";
import { WagmiProvider, createStorage, useAccount, useChainId, useSwitchChain } from "wagmi";
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
import { appChain, appChainId, appRpcUrl, isMainnet } from "@/config/chain";
import { useXmtpNotifications } from "@/hooks/useXmtpNotifications";
import { LocaleProvider } from "@/components/LocaleProvider";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chains = [appChain] as any;
const publicRpc = isMainnet ? "https://mainnet.base.org" : "https://sepolia.base.org";
// /api/rpc routes all RPC calls through the Next.js server so geo-blocked users
// (CIS, VPN exit nodes) don't lose access to the blockchain.
// On the server (SSR), relative URLs don't work — fall back to direct RPC there.
const clientRpc = typeof window !== "undefined" ? "/api/rpc" : appRpcUrl;
const transports = {
  [appChainId]: fallback([
    http(clientRpc, { timeout: 20_000 }),
    http(appRpcUrl, { timeout: 20_000 }),
    http(publicRpc, { timeout: 20_000 }),
  ]),
};

const safeStorage = createStorage({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
});

// Full wallet list when WalletConnect projectId is available.
// Falls back to injected-only to avoid WC API errors when projectId is missing.
const config = projectId
  ? getDefaultConfig({
      appName: "Signature404",
      appDescription: "Decentralized freelance protocol on Base",
      appUrl: typeof window !== "undefined" ? window.location.origin : "https://signature404.vercel.app",
      appIcon: "/icon.png",
      projectId,
      chains,
      transports,
      storage: safeStorage,
      ssr: true,
      pollingInterval: 15_000,
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
      pollingInterval: 15_000,
    });

function XmtpNotificationsMount() {
  useXmtpNotifications();
  return null;
}

function ChainEnforcer() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync, isPending } = useSwitchChain();

  useEffect(() => {
    if (isConnected && chainId !== appChainId && !isPending) {
      switchChainAsync({ chainId: appChainId }).catch(() => {});
    }
  }, [isConnected, chainId, isPending, switchChainAsync]);

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
      <ChainEnforcer />
      <XmtpNotificationsMount />
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
            // Poll every 15 s so on-chain changes appear without manual refresh.
            refetchInterval: 15_000,
            // Treat data as fresh for 10 s to avoid redundant back-to-back fetches.
            staleTime: 10_000,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <VisibilityRefresher queryClient={queryClient} />
        <NextThemesProvider attribute="class" forcedTheme="dark">
          <LocaleProvider>
            <RainbowKitProviders>{children}</RainbowKitProviders>
          </LocaleProvider>
        </NextThemesProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default Providers;
