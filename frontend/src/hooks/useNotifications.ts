"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAccount, usePublicClient, useReadContract, useWatchContractEvent } from "wagmi";
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
  SERVICE_BOARD_ABI,
} from "@/config/contracts";
import { classifySettledRefund, refundNotifCopy } from "@/lib/settledRefund";
import type { Abi } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

type DealRole = { role: "client" | "executor"; amount: bigint };

// Helper: pull args from any wagmi log safely
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function a(log: unknown): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (log as any)?.args ?? {};
}

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
  useEffect(() => {
    if (!address) return;
    const handler = () => setNotifications(loadNotifs(address));
    window.addEventListener('hexseal-notif-update', handler);
    return () => window.removeEventListener('hexseal-notif-update', handler);
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

  // ─── Stable args/onLogs for every useWatchContractEvent below ───────────
  //
  // Passing inline object/function literals as `args`/`onLogs` used to mean a NEW
  // reference on every render of this hook (e.g. every single push() call, since
  // that updates `notifications` state and re-renders whatever mounts
  // useNotifications — NotificationsProvider, at the app root). wagmi's
  // useWatchContractEvent depends on both by reference, so each render was tearing
  // down and re-establishing all 13 watchers' underlying filters/poll loops, not
  // just when address/deal-set actually changed. Since polling (not websocket) is
  // used here, that teardown+recreate has a real async gap (uninstall the old
  // filter, then create a new one) during which a log from a *different* event can
  // land and be silently dropped — most of these notification types have no
  // backfill to recover it. Memoizing both closes that gap: watchers now only
  // rebuild when address (or the specific ref/state they read) actually changes.
  const clientArgs   = useMemo(() => ({ client:   address ?? ZERO }), [address]);
  const executorArgs = useMemo(() => ({ executor: address ?? ZERO }), [address]);
  const arbiterArgs  = useMemo(() => ({ arbiter:  address ?? ZERO }), [address]);

  const onAgreementRegisteredAsClient = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { agreement, amount } = a(log);
      if (!agreement) continue;
      myDeals.current.set(agreement.toLowerCase(), { role: "client", amount: amount ?? BigInt(0) });
      push({
        type: "deal_new",
        title: "Deal Created",
        body: `Deal funded for $${fmtUSDC(amount)} USDC — the executor can now activate to start.`,
        link: `/deal/${agreement}`,
        txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
      });
    }
  }, [push]);

  const onAgreementRegisteredAsExecutor = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { agreement, amount } = a(log);
      if (!agreement) continue;
      myDeals.current.set(agreement.toLowerCase(), { role: "executor", amount: amount ?? BigInt(0) });
      push({
        type: "deal_new",
        title: "You've Been Hired!",
        body: `New deal for $${fmtUSDC(amount)} USDC. Activate to start working.`,
        link: `/deal/${agreement}`,
        txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
      });
    }
  }, [push]);

  const onAgreementStatusUpdated = useCallback(async (logs: unknown[]) => {
    for (const log of logs) {
      const { agreement, newStatus } = a(log);
      if (!agreement) continue;
      const dealInfo = myDeals.current.get(agreement.toLowerCase());

      // Notify registered arbiters about new disputes on deals they're not party to
      if (!dealInfo) {
        const status = Number(newStatus);
        if (isArbiter && status === 3) { // 3 = DISPUTED
          push({
            type: "dispute_new",
            title: "New Dispute Available",
            body: "A dispute is open — be the first to claim and resolve it.",
            link: "/arbiter",
            txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
          });
        }
        continue;
      }

      const status = Number(newStatus);
      const { role } = dealInfo;

      // Registry enum: ACTIVE=0, COMPLETED=1, REFUNDED=2, DISPUTED=3, RESOLVED=4
      const msgMap: Partial<Record<number, [NotifType, string, string]>> = {
        1: ["deal_completed", "Deal Complete", role === "client" ? "Payment successfully released to executor." : "Payment has been released to your wallet!"],
        2: ["deal_refunded", "Deal Refunded", role === "client" ? "Funds returned to your wallet." : "The deal was refunded to the client."],
        3: ["deal_disputed", "Dispute Raised", role === "client" ? "A dispute was opened on your deal." : "Client raised a dispute — arbiter will review."],
        4: ["deal_resolved", "Dispute Resolved", "The arbiter has resolved the dispute."],
      };

      const entry = msgMap[status];
      if (!entry) continue;
      const txHash = (log as { transactionHash?: string }).transactionHash ?? undefined;

      let [, title, body] = entry;
      // REFUNDED(2) is two outcomes wearing one status: a real refund, and a dispute
      // nobody claimed, which splits the escrow and pays the executor half of it.
      // The registry cannot tell them apart (the enum mirrors the agreement's frozen
      // `enum Status`), so the agreement's own DisputeSplitNoVerdict in this very
      // transaction does — see lib/settledRefund.
      if (status === 2) {
        const outcome = await classifySettledRefund(
          publicClient,
          agreement as `0x${string}`,
          txHash as `0x${string}` | undefined,
        );
        ({ title, body } = refundNotifCopy(outcome, role));
      }

      push({
        type: entry[0],
        title,
        body,
        link: `/deal/${agreement}`,
        txHash,
      });
    }
  }, [isArbiter, push, publicClient]);

  const onJobAcceptedAsExecutor = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { jobId, agreement } = a(log);
      push({
        type: "deal_new",
        title: "Application Accepted",
        body: `Your application for Job #${jobId} was accepted.`,
        link: agreement ? `/deal/${agreement}` : "/dashboard",
        txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
      });
    }
  }, [push]);

  const onJobAcceptedAsClient = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { jobId, agreement } = a(log);
      push({
        type: "deal_new",
        title: "Executor Accepted",
        body: `Executor confirmed for Job #${jobId}. Deal is ready.`,
        link: agreement ? `/deal/${agreement}` : "/dashboard",
        txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
      });
    }
  }, [push]);

  const onJobCancelledAsClient = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { jobId, refundAmount } = a(log);
      push({
        type: "job_cancelled",
        title: "Job Cancelled",
        body: `Job #${jobId} cancelled. $${fmtUSDC(refundAmount)} USDC refunded.`,
        link: `/job/${jobId}`,
        txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
      });
    }
  }, [push]);

  const onRequestAcceptedAsClient = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { agreement } = a(log);
      push({
        type: "deal_new",
        title: "Request Accepted",
        body: "Your service request was accepted. Deal has been created.",
        link: agreement ? `/deal/${agreement}` : "/dashboard",
        txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
      });
    }
  }, [push]);

  const onRequestAcceptedAsExecutor = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { agreement } = a(log);
      push({
        type: "deal_new",
        title: "Request Accepted",
        body: "You accepted a service request. Deal has been created.",
        link: agreement ? `/deal/${agreement}` : "/dashboard",
        txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
      });
    }
  }, [push]);

  const onRequestRejectedAsClient = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { requestId } = a(log);
      push({
        type: "service_rejected",
        title: "Request Declined",
        body: "The executor declined your service request.",
        link: requestId !== undefined ? `/request/${requestId}` : "/dashboard",
        txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
      });
    }
  }, [push]);

  const onDisputeClaimedAsArbiter = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { agreement } = a(log);
      if (agreement) {
        myDeals.current.set(agreement.toLowerCase(), { role: "client", amount: BigInt(0) });
      }
      push({
        type: "dispute_claimed",
        title: "Dispute Claimed",
        body: "You have 7 days to review and resolve this case.",
        link: "/arbiter",
        txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
      });
    }
  }, [push]);

  const onDisputeClaimedNotifyParties = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { agreement, arbiter } = a(log);
      if (!agreement) continue;
      // Skip: the arbiter themselves already get notified by the watcher above
      if (arbiter?.toLowerCase() === address?.toLowerCase()) continue;
      const dealInfo = myDeals.current.get(agreement.toLowerCase());
      if (!dealInfo) continue;
      push({
        type: "dispute_arbiter_claimed",
        title: "Arbiter Assigned",
        body: "An arbiter has taken your dispute. Resolution expected within 7 days.",
        link: `/deal/${agreement}`,
        txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
      });
    }
  }, [address, push]);

  const onJobApplied = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { jobId, executor } = a(log);
      const txHash = (log as { transactionHash?: string }).transactionHash ?? undefined;
      // Executor applied — confirm to them
      if (executor?.toLowerCase() === address?.toLowerCase()) {
        push({
          type: "job_applied",
          title: "Application Submitted",
          body: `Applied to Job #${jobId}. Waiting for client to review.`,
          link: `/job/${jobId}`,
          txHash,
        });
        continue;
      }
      // Notify client if this is their job
      if (jobId !== undefined && myJobIds.current.has(jobId.toString())) {
        push({
          type: "job_applied",
          title: "New Applicant",
          body: `Someone applied to your Job #${jobId}. Review on the job page.`,
          link: `/job/${jobId}`,
          txHash,
        });
      }
    }
  }, [address, push]);

  const onServiceRequested = useCallback((logs: unknown[]) => {
    for (const log of logs) {
      const { requestId, serviceId, client, amount } = a(log);
      const txHash = (log as { transactionHash?: string }).transactionHash ?? undefined;
      const link = requestId !== undefined ? `/request/${requestId}` : "/dashboard";
      // Client sent the request — confirm to them
      if (client?.toLowerCase() === address?.toLowerCase()) {
        push({
          type: "service_requested",
          title: "Request Sent",
          body: `Your request for $${fmtUSDC(amount)} USDC has been sent. Waiting for executor.`,
          link,
          txHash,
        });
        continue;
      }
      // Notify executor if this is their service
      if (serviceId !== undefined && myServiceIds.current.has(serviceId.toString())) {
        push({
          type: "service_requested",
          title: "New Service Request",
          body: `A client requested your service for $${fmtUSDC(amount)} USDC.`,
          link,
          txHash,
        });
      }
    }
  }, [address, push]);

  // ─── AgreementRegistered as client ──────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "AgreementRegistered",
    args: clientArgs,
    enabled: !!address,
    onLogs: onAgreementRegisteredAsClient,
  });

  // ─── AgreementRegistered as executor ────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "AgreementRegistered",
    args: executorArgs,
    enabled: !!address,
    onLogs: onAgreementRegisteredAsExecutor,
  });

  // ─── AgreementStatusUpdated — filter by myDeals ─────────────────────────
  //
  // RegistryFacet.AgreementStatus: ACTIVE=0, COMPLETED=1, REFUNDED=2, DISPUTED=3, RESOLVED=4
  //
  // Important: activate() and markDone() do NOT call updateStatus, so this event
  // only fires for terminal state changes: COMPLETED, REFUNDED, DISPUTED, RESOLVED.
  // "Deal activated" and "Work submitted" toasts must come from other sources (XMTP bot).
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "AgreementStatusUpdated",
    enabled: !!address,
    onLogs: onAgreementStatusUpdated,
  });

  // ─── JobAccepted as executor ─────────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "JobAccepted",
    args: executorArgs,
    enabled: !!address,
    onLogs: onJobAcceptedAsExecutor,
  });

  // ─── JobAccepted as client ────────────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "JobAccepted",
    args: clientArgs,
    enabled: !!address,
    onLogs: onJobAcceptedAsClient,
  });

  // ─── JobCancelled as client ──────────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "JobCancelled",
    args: clientArgs,
    enabled: !!address,
    onLogs: onJobCancelledAsClient,
  });

  // ─── RequestAccepted as client ───────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: SERVICE_BOARD_ABI,
    eventName: "RequestAccepted",
    args: clientArgs,
    enabled: !!address,
    onLogs: onRequestAcceptedAsClient,
  });

  // ─── RequestAccepted as executor ─────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: SERVICE_BOARD_ABI,
    eventName: "RequestAccepted",
    args: executorArgs,
    enabled: !!address,
    onLogs: onRequestAcceptedAsExecutor,
  });

  // ─── RequestRejected as client ───────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: SERVICE_BOARD_ABI,
    eventName: "RequestRejected",
    args: clientArgs,
    enabled: !!address,
    onLogs: onRequestRejectedAsClient,
  });

  // ─── DisputeClaimed as arbiter ───────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI,
    eventName: "DisputeClaimed",
    args: arbiterArgs,
    enabled: !!address,
    onLogs: onDisputeClaimedAsArbiter,
  });

  // ─── DisputeClaimed — notify deal parties (client/executor) ─────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI,
    eventName: "DisputeClaimed",
    enabled: !!address,
    onLogs: onDisputeClaimedNotifyParties,
  });

  // ─── JobApplied — notify client (new applicant) + executor (submitted) ───
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "JobApplied",
    enabled: !!address,
    onLogs: onJobApplied,
  });

  // ─── ServiceRequested — notify executor (new request) + client (sent) ────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: SERVICE_BOARD_ABI,
    eventName: "ServiceRequested",
    enabled: !!address,
    onLogs: onServiceRequested,
  });

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
