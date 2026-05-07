"use client";

import React, { useState, useEffect } from "react";
import { WagmiProvider, http, createConfig, createStorage } from "wagmi";
import { fallback } from "viem";
import { RainbowKitProvider, darkTheme, lightTheme, getDefaultConfig } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { injected } from "wagmi/connectors";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { appChain, appChainId, appRpcUrl, isMainnet } from "@/config/chain";
import { useXmtpNotifications } from "@/hooks/useXmtpNotifications";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chains = [appChain] as any;
const publicRpc = isMainnet ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
const transports = {
  [appChainId]: fallback([
    http(appRpcUrl, { timeout: 20_000 }),
    http(publicRpc,  { timeout: 20_000 }),
  ]),
};

// Use localStorage instead of IndexedDB — prevents iOS Safari from killing the
// DB connection mid-transaction when the app is backgrounded.
const safeStorage = createStorage({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
});

// Use RainbowKit default setup when WalletConnect projectId is provided (full wallet list + QR).
// Otherwise, fall back to injected-only to avoid WC API errors.
const config = projectId
  ? getDefaultConfig({
      appName: "Signature404",
      projectId,
      chains,
      transports,
      storage: safeStorage,
      ssr: true,
    })
  : createConfig({
      chains,
      transports,
      connectors: [injected({ shimDisconnect: true })],
      storage: safeStorage,
      ssr: true,
    });

const queryClient = new QueryClient();

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

  const rkTheme = mounted && resolvedTheme === 'light'
    ? lightTheme({
        accentColor: "#000000",
        accentColorForeground: "#ffffff",
        borderRadius: 'small',
        fontStack: 'system',
        overlayBlur: 'small',
      })
    : darkTheme({
        accentColor: "#ffffff",
        accentColorForeground: "#000000",
        borderRadius: 'small',
        fontStack: 'system',
        overlayBlur: 'small',
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
        <NextThemesProvider
          attribute="class"
          forcedTheme="dark"
        >
          <RainbowKitProviders>
            {children}
          </RainbowKitProviders>
        </NextThemesProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default Providers;
