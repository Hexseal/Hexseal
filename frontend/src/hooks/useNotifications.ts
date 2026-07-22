"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useAccount, useReadContract, useWatchContractEvent } from "wagmi";
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
        // REFUNDED
        notif = {
          type: "deal_refunded",
          title: "Deal Refunded",
          body: deal.myRole === "client" ? "Funds returned to your wallet." : "The deal was refunded to the client.",
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

    if (hasNew) setNotifications(loadNotifs(address));
  }, [clientDeals, executorDeals, address]);

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

  // ─── AgreementRegistered as client ──────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "AgreementRegistered",
    args: { client: address ?? ZERO },
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── AgreementRegistered as executor ────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "AgreementRegistered",
    args: { executor: address ?? ZERO },
    enabled: !!address,
    onLogs(logs) {
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
    },
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
    onLogs(logs) {
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
        push({
          type: entry[0],
          title: entry[1],
          body: entry[2],
          link: `/deal/${agreement}`,
          txHash: (log as { transactionHash?: string }).transactionHash ?? undefined,
        });
      }
    },
  });

  // ─── JobAccepted as executor ─────────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "JobAccepted",
    args: { executor: address ?? ZERO },
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── JobAccepted as client ────────────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "JobAccepted",
    args: { client: address ?? ZERO },
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── JobCancelled as client ──────────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "JobCancelled",
    args: { client: address ?? ZERO },
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── RequestAccepted as client ───────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: SERVICE_BOARD_ABI,
    eventName: "RequestAccepted",
    args: { client: address ?? ZERO },
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── RequestAccepted as executor ─────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: SERVICE_BOARD_ABI,
    eventName: "RequestAccepted",
    args: { executor: address ?? ZERO },
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── RequestRejected as client ───────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: SERVICE_BOARD_ABI,
    eventName: "RequestRejected",
    args: { client: address ?? ZERO },
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── DisputeClaimed as arbiter ───────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI,
    eventName: "DisputeClaimed",
    args: { arbiter: address ?? ZERO },
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── DisputeClaimed — notify deal parties (client/executor) ─────────────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI,
    eventName: "DisputeClaimed",
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── JobApplied — notify client (new applicant) + executor (submitted) ───
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    eventName: "JobApplied",
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── ServiceRequested — notify executor (new request) + client (sent) ────
  useWatchContractEvent({
    address: CONTRACTS.diamond,
    abi: SERVICE_BOARD_ABI,
    eventName: "ServiceRequested",
    enabled: !!address,
    onLogs(logs) {
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
    },
  });

  // ─── Public API ───────────────────────────────────────────────────────────
  const unreadCount = notifications.filter((n) => !n.read).length;
  const unreadMessageCount = notifications.filter((n) => !n.read && n.type === 'message_new').length;

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
