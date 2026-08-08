"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { toast } from "react-hot-toast";
import {
  type AppNotification,
  type NotifType,
  loadNotifs,
  pushNotif,
  markReadById,
  markAllAsRead,
  clearAllNotifs,
  fmtUSDC,
} from "@/lib/notifications";
import {
  CONTRACTS,
  DIAMOND_ABI,
  ARBITER_REGISTRY_ABI,
} from "@/config/contracts";
// `refundNotifCopy` нужен достройке ленты ниже: она читает состояние из реестра,
// а не из логов, и разводкой не проходит.
import { classifySettledRefund, refundNotifCopy } from "@/lib/settledRefund";
import { refreshFromLogs } from "@/lib/subgraphSync";
import { routeNotifLogs, type Viewer } from "@/lib/notifRouter";
import { NOTIF_EVENTS, NOTIF_POLL_MS } from "@/lib/notifEvents";
import {
  runChainWatch,
  type ChainWatchCursor,
  type ChainWatchIO,
} from "@/lib/chainWatchGate";
import type { Abi } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

type DealRole = { role: "client" | "executor"; amount: bigint };

// Событие докатывается не только до колокольчика, но и до ДАННЫХ — через
// `refreshFromLogs` (lib/subgraphSync). Это чинит то, чего не чинит ничто
// другое: ЧУЖИЕ действия. Своё нажатие обновляет экран из обработчика кнопки;
// когда же контрагент оплатил, активировал или сдал работу, до этой правки
// приходило уведомление, а экран под ним оставался старым до возвращения во
// вкладку.
//
// ⚠️ ОДИН НАБЛЮДАТЕЛЬ ВМЕСТО ТРИНАДЦАТИ. Здесь стояло тринадцать
// `useWatchContractEvent` — тринадцать фильтров на узле и тринадцать
// `eth_getFilterChanges` за такт. Замер с живого телефона: 135 запросов в минуту
// на ПРОСТАИВАЮЩЕЙ странице, 8 100 в час с одной вкладки (`docs/OPEN-ITEMS.md`,
// пункт 38). Стало: один фильтр по набору из девяти родов событий
// (`lib/notifEvents`), такт `NOTIF_POLL_MS`, и опрос идёт только пока на страницу
// смотрят (`lib/chainWatchGate`); пропущенное за время отсутствия добирается
// одной выборкой при возврате.
//
// Отбор «моё / не моё», который делали `args` тринадцати фильтров, теперь
// делается в коде — `lib/notifRouter`, там же перечислены все тринадцать
// назначений и все они под замером.

export function useNotifications() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const myDeals = useRef<Map<string, DealRole>>(new Map());
  const myJobIds = useRef<Set<string>>(new Set());
  const myServiceIds = useRef<Set<string>>(new Set());
  const backfilled = useRef(false);

  // Load persisted notifications on address change
  useEffect(() => {
    if (!address) { setNotifications([]); return; }
    setNotifications(loadNotifs(address));
    backfilled.current = false;
  }, [address]);

  // Re-sync when another component (e.g. board post page) calls pushNotif directly
  //
  // Плюс ДВЕ ДРУГИЕ причины перечитать хранилище, обе ценой ноль запросов к цепи:
  //
  //  - `storage` — запись сделала ДРУГАЯ вкладка. С тех пор как опрос идёт
  //    только на видимой странице, живые логи приходят той вкладке, на которую
  //    смотрят, а остальные узнают о них отсюда. Событие `hexseal-notif-update`
  //    для этого не годится: оно не покидает своё окно;
  //  - возврат во вкладку — на случай, если запись сделана, пока эта вкладка
  //    была выгружена и слушателя не существовало вовсе.
  useEffect(() => {
    if (!address) return;
    const handler = () => setNotifications(loadNotifs(address));
    const onVisible = () => { if (document.visibilityState === 'visible') handler(); };
    window.addEventListener('hexseal-notif-update', handler);
    window.addEventListener('storage', handler);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('hexseal-notif-update', handler);
      window.removeEventListener('storage', handler);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [address]);

  // Check if current user is a registered arbiter
  const { data: isArbiterData } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "isRegisteredArbiter",
    args: [address ?? ZERO],
    query: { enabled: !!address },
  });
  const isArbiter = isArbiterData as boolean | undefined;

  // Fetch existing deals to seed myDeals map
  const { data: clientDeals } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    functionName: "getByClient",
    args: [address ?? ZERO],
    query: { enabled: !!address },
  });
  const { data: executorDeals } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    functionName: "getByExecutor",
    args: [address ?? ZERO],
    query: { enabled: !!address },
  });
  const { data: clientJobIds } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    functionName: "getClientJobs",
    args: [address ?? ZERO],
    query: { enabled: !!address },
  });
  const { data: executorServiceIds } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    functionName: "getExecutorServices",
    args: [address ?? ZERO],
    query: { enabled: !!address },
  });

  useEffect(() => {
    const map = myDeals.current;
    map.clear();
    if (clientDeals) {
      (clientDeals as { agreement: `0x${string}`; amount: bigint }[]).forEach(
        (d) => map.set(d.agreement.toLowerCase(), { role: "client", amount: d.amount })
      );
    }
    if (executorDeals) {
      (executorDeals as { agreement: `0x${string}`; amount: bigint }[]).forEach(
        (d) => map.set(d.agreement.toLowerCase(), { role: "executor", amount: d.amount })
      );
    }
  }, [clientDeals, executorDeals]);

  useEffect(() => {
    const set = myJobIds.current;
    set.clear();
    if (clientJobIds) (clientJobIds as bigint[]).forEach(id => set.add(id.toString()));
  }, [clientJobIds]);

  useEffect(() => {
    const set = myServiceIds.current;
    set.clear();
    if (executorServiceIds) (executorServiceIds as bigint[]).forEach(id => set.add(id.toString()));
  }, [executorServiceIds]);

  // Backfill notifications from on-chain state on first load (catches events missed while offline)
  useEffect(() => {
    if (!address || !clientDeals || !executorDeals || backfilled.current) return;
    backfilled.current = true;

    const existing = loadNotifs(address);
    const alreadyHas = (link: string, type: NotifType) =>
      existing.some((n) => n.link === link && n.type === type);

    type DealSnap = { agreement: string; amount: bigint; status: number; myRole: "client" | "executor" };
    const allDeals: DealSnap[] = [
      ...(clientDeals as { agreement: string; amount: bigint; status: number }[]).map(
        (d) => ({ ...d, myRole: "client" as const })
      ),
      ...(executorDeals as { agreement: string; amount: bigint; status: number }[]).map(
        (d) => ({ ...d, myRole: "executor" as const })
      ),
    ];

    // REFUNDED(2) has to be read from the agreement, not just the registry, so this
    // pass is async now. Async also means it can outlive the mounted hook — the
    // notification store itself is idempotent (localStorage, `alreadyHas` above),
    // so the only thing worth cancelling is the setState at the end.
    let cancelled = false;
    (async () => {
      // Registry AgreementStatus: 0=ACTIVE, 1=COMPLETED, 2=REFUNDED, 3=DISPUTED, 4=RESOLVED
      let hasNew = false;
      for (const deal of allDeals) {
        const st = Number(deal.status);
        const lnk = `/deal/${deal.agreement}`;

        let notif: Omit<AppNotification, "id" | "timestamp" | "read"> | null = null;

        if (st === 3 && !alreadyHas(lnk, "deal_disputed")) {
          // DISPUTED
          notif = {
            type: "deal_disputed",
            title: "Dispute Raised",
            body: deal.myRole === "client"
              ? "A dispute was opened on your deal."
              : "Client raised a dispute — arbiter will review.",
            link: lnk,
          };
        } else if (st === 4 && !alreadyHas(lnk, "deal_resolved")) {
          // RESOLVED
          notif = {
            type: "deal_resolved",
            title: "Dispute Resolved",
            body: "The arbiter has resolved the dispute.",
            link: lnk,
          };
        } else if (st === 2 && !alreadyHas(lnk, "deal_refunded")) {
          // REFUNDED — or a dispute nobody took, which pays out half the escrow to the
          // executor and lands in the registry under this very same status. There is no
          // tx hash in a registry snapshot, so the outcome is read from the agreement's
          // own state; see lib/settledRefund. The type stays `deal_refunded` in both
          // cases: it is the idempotency key `alreadyHas` uses, so a split notification
          // must occupy the same slot, or this probe would re-run on every cold start.
          const outcome = await classifySettledRefund(
            publicClient,
            deal.agreement as `0x${string}`,
          );
          notif = {
            type: "deal_refunded",
            ...refundNotifCopy(outcome, deal.myRole),
            link: lnk,
          };
        } else if (st === 1 && !alreadyHas(lnk, "deal_completed")) {
          // COMPLETED
          notif = {
            type: "deal_completed",
            title: "Deal Complete",
            body: deal.myRole === "client"
              ? "Payment successfully released to executor."
              : "Payment has been released to your wallet!",
            link: lnk,
          };
        } else if (st === 0 && deal.myRole === "executor" && !alreadyHas(lnk, "deal_active")) {
          // ACTIVE — напоминаем только исполнителю (клиент и так знает)
          notif = {
            type: "deal_active",
            title: "Deal In Progress",
            body: "You have an active deal — time to deliver.",
            link: lnk,
          };
        }

        if (notif) {
          pushNotif(address, notif);
          hasNew = true;
        }
      }

      if (hasNew && !cancelled) setNotifications(loadNotifs(address));
    })();

    return () => { cancelled = true; };
  }, [clientDeals, executorDeals, address, publicClient]);

  // Persist + show toast
  const push = useCallback(
    (notif: Omit<AppNotification, "id" | "timestamp" | "read">) => {
      if (!address) return;
      const saved = pushNotif(address, notif);
      if (!saved) return;
      setNotifications(loadNotifs(address));
      toast(`${notif.title}\n${notif.body}`, {
        duration: 6000,
        style: {
          background: "#050505",
          color: "#f0f0f0",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: "12px",
          fontSize: "13px",
          maxWidth: "320px",
          whiteSpace: "pre-line",
        },
      });
    },
    [address]
  );

  // ─── ОДИН цикл опроса вместо тринадцати ─────────────────────────────────
  //
  // ЧТО ЧИТАЕТСЯ ЧЕРЕЗ ССЫЛКУ И ПОЧЕМУ. `isArbiter` и `push` меняются по ходу
  // жизни страницы. Зависеть от них эффектом означало бы перевзводить фильтр на
  // каждое изменение, а перевзвод — это лишний `eth_newFilter` И щель между
  // снятием старого фильтра и созданием нового, в которую лог проваливается
  // молча. Ровно этот класс бага уже ловили здесь однажды (мемоизация
  // `args`/`onLogs`), и он остаётся в силе: цикл опроса обязан перевзводиться
  // ТОЛЬКО при смене адреса кошелька.
  const isArbiterRef = useRef(false);
  useEffect(() => { isArbiterRef.current = isArbiter === true; }, [isArbiter]);

  const pushRef = useRef(push);
  useEffect(() => { pushRef.current = push; }, [push]);

  const addressRef = useRef(address);
  useEffect(() => { addressRef.current = address; }, [address]);

  const handleChainLogs = useCallback(async (logs: unknown[]) => {
    const me = addressRef.current;
    if (!me) return;
    const viewer: Viewer = {
      address: me,
      isArbiter: isArbiterRef.current,
      // Карты передаются по ссылке намеренно: разводка пополняет их по ходу
      // пачки, и это обязательное свойство при догоне (см. lib/notifRouter).
      deals: myDeals.current,
      jobIds: myJobIds.current,
      serviceIds: myServiceIds.current,
    };
    const routed = await routeNotifLogs(logs, viewer, {
      classifyRefund: (agreement, txHash) =>
        classifySettledRefund(publicClient, agreement, txHash),
    });
    for (const notif of routed.notifs) pushRef.current(notif);
    for (const r of routed.refreshes) {
      if (r.logs.length > 0) refreshFromLogs(r.logs, r.topics);
    }
  }, [publicClient]);

  useEffect(() => {
    if (!address || !publicClient) return;
    if (typeof document === "undefined") return;
    // Набор событий пуст — значит ABI разъехались с разводкой. Взводить фильтр,
    // который ничего не ловит, бессмысленно; замер на это стоит в
    // `lib/notifEvents.test.ts`.
    if (NOTIF_EVENTS.length === 0) return;

    // Курсор догона — на адрес. Общий на все вкладки (localStorage), так что
    // вторая вкладка не платит за уже добранный пропуск повторно.
    const cursorKey = `hexseal_notifblk_${address.toLowerCase()}`;
    const cursor: ChainWatchCursor = {
      read: () => {
        try {
          const v = localStorage.getItem(cursorKey);
          if (!v || !/^[0-9]+$/.test(v)) return null;
          return BigInt(v);
        } catch { return null; }
      },
      write: (block) => {
        try { localStorage.setItem(cursorKey, block.toString()); } catch { /* хранилище недоступно */ }
      },
    };

    const io: ChainWatchIO = {
      watch: (onLogs, onError) =>
        publicClient.watchEvent({
          address: CONTRACTS.diamond,
          events: NOTIF_EVENTS,
          pollingInterval: NOTIF_POLL_MS,
          onLogs: (logs) => onLogs(logs as unknown[]),
          onError,
        }),
      blockNumber: () => publicClient.getBlockNumber(),
      getLogs: (fromBlock, toBlock) =>
        publicClient.getLogs({
          address: CONTRACTS.diamond,
          events: NOTIF_EVENTS,
          fromBlock,
          toBlock,
        }) as Promise<unknown[]>,
    };

    return runChainWatch({
      io,
      cursor,
      doc: document,
      onLogs: handleChainLogs,
      onError: (error, phase) => {
        // Отказ узла не глушится молча: без этого «уведомлений нет» и «узел
        // недоступен» выглядят с экрана одинаково. Курсор при неудачном догоне
        // не двигается, поэтому пропуск добирается следующей попыткой.
        console.warn(`[hexseal] слежение за цепью (${phase}) не удалось:`, error);
      },
      onTruncated: (plan) => {
        console.warn(
          `[hexseal] пропуск длиннее потолка догона: добраны блоки ` +
          `${plan.chunks[0]?.fromBlock}–${plan.chunks[plan.chunks.length - 1]?.toBlock}, ` +
          `более старые события в колокольчик не попадут`,
        );
      },
    });
  }, [address, publicClient, handleChainLogs]);

  // ─── Public API ───────────────────────────────────────────────────────────
  const unreadCount = notifications.filter((n) => !n.read).length;
  const unreadMessageCount = notifications.filter((n) => !n.read && n.type === 'message_new').length;

  // Drive the OS app-icon badge (installed PWA) from the REAL in-app unread count.
  // Previously the badge came only from the service worker counting undismissed push
  // banners (getNotifications().length), so it stuck at a stale number ("always 3")
  // instead of tracking what's actually unread. Here it follows the store and clears
  // to 0 when everything is read; on foreground we also dismiss lingering tray banners
  // so the SW's own badge update can't re-inflate it.
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const syncBadge = () => {
      try {
        if ('setAppBadge' in navigator) {
          if (unreadCount > 0) navigator.setAppBadge(unreadCount);
          else navigator.clearAppBadge?.();
        }
      } catch { /* Badging API unavailable */ }
    };
    syncBadge();
    const onForeground = () => {
      if (document.visibilityState !== 'visible') return;
      syncBadge();
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready
          .then((reg) => reg.getNotifications())
          .then((ns) => ns.forEach((n) => n.close()))
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    return () => {
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
    };
  }, [unreadCount]);

  const markRead = useCallback(
    (id: string) => { if (address) setNotifications(markReadById(address, id)); },
    [address]
  );
  const markAll = useCallback(
    () => { if (address) setNotifications(markAllAsRead(address)); },
    [address]
  );
  const clearAll = useCallback(
    () => { if (address) setNotifications(clearAllNotifs(address)); },
    [address]
  );

  return { notifications, unreadCount, unreadMessageCount, markRead, markAll, clearAll };
}
