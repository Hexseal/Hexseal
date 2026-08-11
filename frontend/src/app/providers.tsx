"use client";

import React, { useState, useEffect, useRef } from "react";
import { Provider as UrqlProvider } from 'urql'
import { createGraphClient } from '@/lib/graph'

const graphClient = createGraphClient()
import { WagmiProvider, createStorage, useAccount } from "wagmi";
import { http, fallback } from "viem";
import { toast } from "react-hot-toast";
import { createRpcGateSignal } from "@/lib/rpcProxy";
import {
  RainbowKitProvider,
  darkTheme,
  lightTheme,
  getDefaultConfig,
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
import { LocaleProvider } from "@/components/LocaleProvider";
import { PushProvider } from "@/contexts/PushContext";
import { NotificationsProvider } from "@/contexts/NotificationsContext";
import { buildWalletGroups, isMobileClient } from "@/lib/walletList";
import { QueryRefreshBridge } from "@/components/QueryRefreshBridge";
import { sweepLegacyStorage } from "@/lib/staleStorage";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// ── Debug breadcrumb trail (temporary Android diagnostic) ──────────────────────
// A localStorage trail the wallet-connect tracer (below) appends to. localStorage
// survives a tab crash *and* a tab kill+recreate, so after the tester returns from
// the wallet app we can read the exact sequence — and, via the per-load id, tell
// whether Android threw the whole tab away and recreated it (trail restarts with a
// new load id) or kept it alive (same id, more lines appended).
//
// Второй писатель этой тропы (инициализация XMTP, `xmtpCrumb`) исчез вместе с
// XMTP 6 августа 2026 — вместе с ним переименованы ключ и флаг (`?walletdebug=1`
// вместо `?walletdebug=1`). Тропа и так стирается на каждой загрузке, так что
// переименование ключа ничего не теряет; заново вооружить оверлей придётся.
const WALLET_CRUMB_KEY = "hexseal-wallet-crumb";
const WALLET_DEBUG_KEY = "hexseal-wallet-debug";
function dbgCrumb(step: string): void {
  try {
    const t = new Date().toISOString().slice(11, 23);
    const prev = localStorage.getItem(WALLET_CRUMB_KEY);
    const trail = (prev ? prev.split("\n") : []).concat(`${t} ${step}`).slice(-28);
    localStorage.setItem(WALLET_CRUMB_KEY, trail.join("\n"));
  } catch { /* localStorage unavailable */ }
}
// Runs at module eval — before any React effect — so it always beats the app's own
// crumbs. Snapshots the previous load's trail to "-prev" (survives a crash), then
// starts this load's trail with a fresh random id.
if (typeof window !== "undefined") {
  // Мусор снесённого мессенджера: `hexseal-xmtp-crumb` и `-prev` не читает
  // ничто с 6 августа, а на устройствах они лежат (замер с живого телефона,
  // 9 августа). Отбор и замок «наши ключи не трогать» — `lib/staleStorage.ts`.
  try { sweepLegacyStorage(window.localStorage); } catch { /* уборка не важнее работы */ }
  try {
    const live = localStorage.getItem(WALLET_CRUMB_KEY);
    if (live) localStorage.setItem(`${WALLET_CRUMB_KEY}-prev`, live);
    localStorage.removeItem(WALLET_CRUMB_KEY);
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

/**
 * НАХОДКА РЕВЬЮ по разрезу «/api/rpc: потолок пачки/тела, список методов,
 * лимитер, происхождение». Гейты того разреза отвечают честной JSON-RPC-
 * ошибкой, но НИКТО из потребителей на неё не смотрит: `DealCard.tsx` зовёт
 * `useReadContracts` без `isError`, `useNotifications`/`useDealLiveRefresh`
 * на отказ только логируют и ждут следующего такта — экран просто
 * ЗАСТЫВАЕТ, и это неотличимо от факта (см. `hooks/useWarnFailedReads.ts`).
 *
 * Чинится ЗДЕСЬ, на транспорте — не на трёх экранах: один перехват
 * `onFetchResponse` закрывает все поверхности разом, существующие и
 * будущие. Классификация/троттлинг — чистые функции в `lib/rpcProxy.ts`
 * (`createRpcGateSignal`), тестируемые без DOM; здесь только подстановка
 * настоящего `toast()`.
 *
 * Экспортирован (а не держится в замыкании модуля) РОВНО ради мутационного
 * замка: `providers.rpcGateSignal.test.ts` зовёт эту же функцию напрямую и
 * подтверждает, что снятие строки `onFetchResponse: onRpcGateSignal` ниже
 * красит тест — иначе провод мог бы существовать в `rpcProxy.ts` и никогда
 * не быть подключённым, и никто бы не заметил.
 */
export const onRpcGateSignal = createRpcGateSignal({
  raise: (message) => toast(message, {
    id: "rpc-gate-signal", // тот же id — новый вызов ЗАМЕНЯЕТ предыдущий тост, а не громоздит второй
    duration: 6000,
    style: {
      background: "#050505",
      color: "#f0f0f0",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: "12px",
      fontSize: "13px",
      maxWidth: "320px",
    },
  }),
});

// Вынесен отдельной переменной (а не собран инлайн внутри `fallback([...])`
// ниже) РОВНО ради мутационного замка: `providers.rpcGateSignal.test.ts`
// зовёт `clientRpcTransport({...})` и гонит через него настоящий
// EIP-1193-запрос с подменённым `fetch`, чтобы доказать, что
// `onFetchResponse: onRpcGateSignal` не потерялся при сборке `transports`
// — а не просто существует где-то как экспорт, которым никто не пользуется.
//
// onFetchResponse — ТОЛЬКО здесь, не на publicRpc ниже (у него своя история,
// официальный узел Base, к нашим гейтам отношения не имеет — вешать сигнал
// туда означало бы либо не сработает никогда, либо сработает по чужому 4xx,
// который вовсе не «мы ограничили»).
//
// ⚠️ ТОЧНЕЕ: «нога, что говорит с НАШИМ /api/rpc» — это правда только в
// БРАУЗЕРЕ. `clientRpc` (выше) на СЕРВЕРЕ (`typeof window === "undefined"`,
// SSR) сам схлопывается в `publicRpc` — значит на сервере ЭТА ЖЕ константа
// `clientRpcTransport` фактически указывает на публичный узел, а перехватчик
// всё равно к ней приклеен. Сегодня это безвредно ДВОЙНО: чтения идут из
// React-эффектов и на сервере не стреляют вовсе, а даже если бы выстрелили —
// коды публичного узла `isGateRejectionBody` не пропустит (наши гейты
// НИКОГДА их не вернут), так что тост не поднимется. Но если однажды кто-то
// заведёт серверный предзапрос через тот же `config`/`clientRpcTransport`,
// это перестанет быть безвредной случайностью и станет тихим несоответствием
// комментария факту — тогда поведение здесь стоит пересмотреть.
export const clientRpcTransport = http(clientRpc, { timeout: 20_000, onFetchResponse: onRpcGateSignal }); // /api/rpc → private RPC with key

const transports = {
  [appChainId]: fallback([
    clientRpcTransport,
    http(publicRpc,  { timeout: 20_000 }), // sepolia.base.org — official fallback
  ]),
};

const safeStorage = createStorage({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
});

// Мобильный ли это клиент. Считается один раз на eval модуля — ровно там же,
// где собирается сам конфиг wagmi, менять его после создания всё равно нельзя.
// На сервере (SSR) navigator'а нет и здесь честный false: серверный рендер
// кошелёк не подключает, а разметку список коннекторов не задаёт — модал
// RainbowKit рисуется только на клиенте и только по нажатию.
//
// Сама проверка живёт в `lib/walletList.ts` и ОДНА на всё приложение: тот же
// `isMobileClient()` решает, звать ли на нажатии коннектор WalletConnect
// напрямую (`hooks/useConnectWallet.ts`) вместо модалки RainbowKit.
const IS_MOBILE_CLIENT = isMobileClient();

// Полный набор — он же десктопный. Мобильный получается из него вычитанием
// (см. MOBILE_EXCLUDED ниже и шапку lib/walletList.ts).
const WALLET_GROUPS = [
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
];

// На мобильном коннектор MetaMask идёт через MetaMask SDK (RainbowKit 2.2.8),
// а тот на Android/Chrome залипает незакрываемым 'personal_sign already
// pending' с UUID-origin'ом. Убираем именно его: WalletConnect (группа "More")
// доводит до того же MetaMask другим транспортом, а injectedWallet покрывает
// встроенный браузер кошелька, где диплинка нет вовсе. Десктоп не задет —
// там MetaMask инжектированный и работает.
const MOBILE_EXCLUDED = [metaMaskWallet];

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
      wallets: buildWalletGroups(WALLET_GROUPS, IS_MOBILE_CLIENT, MOBILE_EXCLUDED),
    })
  : createConfig({
      chains,
      transports,
      connectors: [injected({ shimDisconnect: true })],
      storage: safeStorage,
      ssr: true,
      pollingInterval: 6_000,
    });

// ⚠️ ЗДЕСЬ БЫЛ `XmtpNotificationsMount`, И ВМЕСТЕ С НИМ УШЛА ОДНА ВОЗМОЖНОСТЬ.
//
// Он слушал поток XMTP по всему приложению и на каждое входящее сообщение
// клал запись в колокольчик (центр уведомлений) плюс поднимал тост или
// системное уведомление. Работал он ровно потому, что XMTP держал открытую
// подписку на любой странице.
//
// У переписки на нашем складе такого фона нет и не может быть дёшево: чтобы
// узнать о новом сообщении, надо иметь ПРОПУСК СКЛАДА, а пропуск — это
// подпись кошелька. Держать такой опрос на каждой странице означало бы
// спрашивать подпись у человека, который зашёл посмотреть свой профиль.
//
// Что осталось работать: пуш-уведомления ОС (`notifyPush` → `/api/push` →
// релеер → служба доставки) — отправитель шлёт получателю сигнал «новое
// сообщение» без содержимого. Что перестало: строка в колокольчике и
// внутренний тост про новое сообщение, пока чат не открыт.
//
// Это НЕ доделано и НЕ спрятано: отдельная задача — фоновый опрос, который
// не требует пропуска (например, счётчик непрочитанного по адресу).

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

// Temporary Android diagnostic overlay. Arm once with ?walletdebug=1 (?walletdebug=0 to
// disarm). While armed it shows, live (refreshing every second, no reload needed),
// this load's trail plus the previous load's trail — so both the no-reload connect
// flow AND the crash-on-reload are visible on the device with no USB / debugger.
//
// Stored as an expiry timestamp, not a plain "1" flag — a tester device that was
// armed once and never explicitly revisited with ?walletdebug=0 used to run the 1s
// poll loop (and show the panel, if the trail is non-empty) forever. Auto-expires
// instead so a forgotten test device doesn't stay armed indefinitely.
const WALLET_DEBUG_TTL = 48 * 60 * 60 * 1000; // 48h — long enough to cover a test session
function WalletDebugOverlay() {
  const [armed, setArmed] = useState(false);
  const [text, setText] = useState("");
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let iv: ReturnType<typeof setInterval> | undefined;
    try {
      const q = new URLSearchParams(window.location.search).get("walletdebug");
      if (q === "1") localStorage.setItem(WALLET_DEBUG_KEY, String(Date.now() + WALLET_DEBUG_TTL));
      if (q === "0") localStorage.removeItem(WALLET_DEBUG_KEY);
      const expiry = Number(localStorage.getItem(WALLET_DEBUG_KEY));
      if (!expiry || Date.now() > expiry) {
        localStorage.removeItem(WALLET_DEBUG_KEY);
        return;
      }
      setArmed(true);
      const read = () => {
        try {
          const prev = localStorage.getItem(`${WALLET_CRUMB_KEY}-prev`) || "";
          const cur = localStorage.getItem(WALLET_CRUMB_KEY) || "(no steps yet)";
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
        <button onClick={() => { try { localStorage.removeItem(WALLET_CRUMB_KEY); localStorage.removeItem(`${WALLET_CRUMB_KEY}-prev`); } catch {} }} style={{ color: "#ff8", background: "none", border: "1px solid #663", padding: "2px 10px", borderRadius: 4 }}>clear</button>
        <button onClick={() => setDismissed(true)} style={{ color: "#8ff", background: "none", border: "1px solid #366", padding: "2px 10px", borderRadius: 4 }}>close</button>
      </div>
    </div>
  );
}

// Forces all queries to refetch when user returns to the tab/PWA.
// React Query's built-in refetchOnWindowFocus is unreliable in iOS standalone mode.
const VISIBILITY_REFRESH_MIN_GAP = 8_000; // matches the QueryClient's own staleTime below

function VisibilityRefresher({ queryClient }: { queryClient: QueryClient }) {
  const lastRef = useRef(0);
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      // Unfiltered invalidateQueries() force-refetches every active query, bypassing
      // staleTime entirely. Without this gap check, any two real tab-resume events
      // within staleTime — e.g. backgrounding the tab for two wallet signatures in a
      // row (approve, then confirm) — refetch everything twice back to back, defeating
      // the staleTime setting's whole purpose.
      const now = Date.now();
      if (now - lastRef.current < VISIBILITY_REFRESH_MIN_GAP) return;
      lastRef.current = now;
      queryClient.invalidateQueries();
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
          {/* Событийное обновление — точечное, по темам. VisibilityRefresher выше
              остаётся: он ловит истечение времени (таймауты сделки, окно спора),
              которое событий не эмитит. */}
          <QueryRefreshBridge queryClient={queryClient} />
          <WalletConnectTracer />
          <WalletDebugOverlay />
          <NextThemesProvider attribute="class" forcedTheme="dark">
            <LocaleProvider>
              <NotificationsProvider>
                <PushProvider>
                  <RainbowKitProviders>{children}</RainbowKitProviders>
                </PushProvider>
              </NotificationsProvider>
            </LocaleProvider>
          </NextThemesProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </UrqlProvider>
  );
}

export default Providers;
