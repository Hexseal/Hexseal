"use client";

import React, { useState, useEffect } from "react";
import { WagmiProvider, createStorage } from "wagmi";
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
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { appChain, appChainId, appRpcUrl, isMainnet } from "@/config/chain";
import { useXmtpNotifications } from "@/hooks/useXmtpNotifications";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chains = [appChain] as any;
const publicRpc = isMainnet ? "https://mainnet.base.org" : "https://sepolia.base.org";
const transports = {
  [appChainId]: fallback([
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
            coinbaseWallet,
            walletConnectWallet,
            rainbowWallet,
            trustWallet,
            braveWallet,
          ],
        },
        {
          groupName: "More",
          wallets: [
            okxWallet,
            phantomWallet,
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
      {children}
    </RainbowKitProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <NextThemesProvider attribute="class" forcedTheme="dark">
          <RainbowKitProviders>{children}</RainbowKitProviders>
        </NextThemesProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default Providers;
