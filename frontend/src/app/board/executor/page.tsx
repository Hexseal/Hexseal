"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { ContextHint } from "@/components/ContextHint";
import { useAccount, useWalletClient, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { useServices, type GraphService } from "@/hooks/useServices";
import { DIAMOND_ABI, USDC_ABI, CONTRACTS } from "@/config/contracts";
import type { Abi } from "viem";
import { parseUnits } from "viem";
import { requestServiceGasless, sendGasless } from "@/lib/relay";
import { notifyPush } from "@/lib/webpush";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search, Loader2, Briefcase, Plus,
  MessageCircle, RefreshCw, ChevronDown, ExternalLink,
  UserCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserName, UserAvatar } from "@/components/UserName";
import { useTranslations } from "next-intl";
import { BoardRegionFilter, REGION_LABELS, getStoredBoardRegion, storeBoardRegion } from "@/components/BoardRegionFilter";
import { CATEGORIES, CATEGORY_BADGE, type CategoryKey, extractCategory, stripCategory, extractCustomTag, stripCustomTag } from "@/config/categories";
import { shortAddr } from "@/lib/utils";
import { RequestServiceModal } from "@/components/RequestServiceModal";

function useTimeAgo() {
  const t = useTranslations();
  return (ts: bigint): string => {
    const diff = Math.floor(Date.now() / 1000) - Number(ts);
    if (diff < 60) return t("common.just_now");
    if (diff < 3600) return t("common.minutes_ago", { count: Math.floor(diff / 60) });
    if (diff < 86400) return t("common.hours_ago", { count: Math.floor(diff / 3600) });
    return t("common.days_ago", { count: Math.floor(diff / 86400) });
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Service {
  serviceId: string;
  executor: string;
  title: string;
  description: string;
  price: bigint;
  deadlineDays: bigint;
  region: number;
  status: number;   // 0=ACTIVE 1=PAUSED 2=REMOVED
  createdAt: bigint;
  hiresCount: bigint;
}

interface HireRequest {
  requestId: string;
  client: string;
  serviceId: bigint;
  amount: bigint;
  deadlineDays: bigint;
  terms: string;
  region: number;
  status: number;   // 0=PENDING 1=ACCEPTED 2=REJECTED 3=CANCELLED
  createdAt: bigint;
  agreement: string;
}

const REQUEST_STATUS: Record<number, string> = { 0: "Pending", 1: "Accepted", 2: "Rejected", 3: "Cancelled", 4: "Superseded" };
const DEAL_STATUS: Record<number, string> = { 0: "Created", 1: "Funded", 2: "Active", 3: "Done", 4: "Disputed", 5: "Resolved", 6: "Refunded" };

function fmtUSDC(val: bigint) { return (Number(val) / 1e6).toFixed(2); }

// ─── Incoming Requests Panel ──────────────────────────────────────────────────

function IncomingRequestsPanel({
  address,
  services,
  onRefresh,
}: {
  address: string;
  services: Service[];
  onRefresh: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const [acting, setActing] = useState<string | null>(null);

  const { data: myServiceIds } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: "getExecutorServices",
    args: [address as `0x${string}`],
    query: { enabled: !!address },
  }) as { data: bigint[] | undefined };

  const pendingContracts = useMemo(() =>
    (myServiceIds ?? []).map(id => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: "getPendingRequests" as const,
      args: [id] as const,
    })),
    [myServiceIds]
  );

  const { data: pendingData, refetch } = useReadContracts({
    contracts: pendingContracts,
    query: { enabled: pendingContracts.length > 0 },
  });

  const pendingRequests = useMemo(() => {
    if (!pendingData || !myServiceIds) return [];
    const result: Array<{
      requestId: bigint;
      serviceId: bigint;
      serviceTitle: string;
      client: string;
      amount: bigint;
      deadlineDays: bigint;
    }> = [];
    pendingData.forEach((d, i) => {
      if (d.status === "success") {
        const [reqIds, reqs] = d.result as [bigint[], any[]];
        reqIds.forEach((reqId, j) => {
          const svcId = myServiceIds[i];
          const svc = services.find(s => s.serviceId === String(svcId));
          result.push({
            requestId: reqId,
            serviceId: svcId,
            serviceTitle: svc?.title ?? `#${String(svcId)}`,
            client: reqs[j].client,
            amount: reqs[j].amount,
            deadlineDays: reqs[j].deadlineDays,
          });
        });
      }
    });
    return result;
  }, [pendingData, myServiceIds, services]);

  const handleAccept = async (requestId: bigint) => {
    if (!walletClient || !publicClient) return;
    const key = `accept-${requestId}`;
    setActing(key);
    try {
      const result = await sendGasless(walletClient, publicClient, "acceptRequest", [requestId], DIAMOND_ABI as Abi);
      toast.success(t("board.services.accepted_msg"));
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (result.agreementAddr && result.agreementAddr !== ZERO) {
        setTimeout(() => router.push(`/deal/${result.agreementAddr}`), 1500);
      } else {
        setTimeout(() => { refetch(); onRefresh(); }, 2000);
      }
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || "Failed");
    } finally {
      setActing(null);
    }
  };

  const handleReject = async (requestId: bigint) => {
    if (!walletClient || !publicClient) return;
    const key = `reject-${requestId}`;
    setActing(key);
    try {
      await sendGasless(walletClient, publicClient, "rejectRequest", [requestId], DIAMOND_ABI as Abi);
      toast.success(t("board.services.rejected_msg"));
      setTimeout(() => { refetch(); }, 1500);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || "Failed");
    } finally {
      setActing(null);
    }
  };

  if (!pendingRequests.length) return null;

  return (
    <div className="mb-5 rounded-[22px] border border-violet-400/20 bg-violet-400/[0.03] px-4 py-4"
      style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.3), inset 0 1px 0 rgba(139,92,246,0.06)" }}>
      <p className="text-[10px] text-violet-400/50 uppercase tracking-widest mb-3 font-medium">
        {t("board.services.incoming_title")} · {pendingRequests.length}
      </p>
      <div className="space-y-2">
        {pendingRequests.map(req => (
          <div
            key={req.requestId.toString()}
            className="flex items-center justify-between gap-3 rounded-[14px] bg-white/[0.04] border border-white/[0.07] px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="text-xs text-white/60 font-medium truncate">{req.serviceTitle}</p>
              <div className="flex items-center gap-2 text-[11px] text-white/30 mt-0.5">
                <span className="font-mono">{req.client.slice(0, 6)}…{req.client.slice(-4)}</span>
                <span className="text-white/15">·</span>
                <span className="font-mono text-white/50">{fmtUSDC(req.amount)} USDC</span>
                <span className="text-white/15">·</span>
                <span>{Number(req.deadlineDays)}d</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleReject(req.requestId)}
                disabled={!!acting}
                className="h-8 px-2.5 text-xs text-red-400/50 hover:text-red-400 hover:bg-red-400/10"
              >
                {acting === `reject-${req.requestId}` ? <Loader2 className="w-3 h-3 animate-spin" /> : t("board.services.reject_btn")}
              </Button>
              <Button
                size="sm"
                onClick={() => handleAccept(req.requestId)}
                disabled={!!acting}
                className="h-8 px-2.5 text-xs gap-1"
              >
                {acting === `accept-${req.requestId}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCheck className="w-3 h-3" />}
                {t("board.jobs.accept_btn")}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Service Card ─────────────────────────────────────────────────────────────

function ServiceCard({
  service,
  address,
  isConnected,
  myRequests,
  onRequest,
  isRequesting,
  onCancelRequest,
  isCancelling,
  expanded,
  onToggle,
}: {
  service: Service;
  address?: string;
  isConnected: boolean;
  myRequests: HireRequest[];
  onRequest: (service: Service) => void;
  isRequesting: boolean;
  onCancelRequest: (requestId: string) => void;
  isCancelling: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isMyService = address?.toLowerCase() === service.executor.toLowerCase();
  const t = useTranslations();
  const timeAgo = useTimeAgo();
  const catKey = extractCategory(service.description);
  const displayDesc = stripCategory(service.description);

  // On-chain status re-check when card is expanded — catches subgraph lag
  const { data: onChainService } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getService',
    args: [BigInt(service.serviceId)],
    query: { enabled: expanded },
  }) as { data: { status: number } | undefined };
  const onChainStatus = onChainService ? Number(onChainService.status) : service.status;
  const isPaused  = onChainStatus === 1;
  const isRemoved = onChainStatus === 2;
  const isUnavailable = isPaused || isRemoved;

  const myPending   = myRequests.find(r => String(r.serviceId) === service.serviceId && r.status === 0);
  const myAccepted  = myRequests.find(r => String(r.serviceId) === service.serviceId && r.status === 1);
  const myActive    = myPending ?? myAccepted;

  return (
    <div
      className={`rounded-[22px] border cursor-pointer transition-all duration-200 ${
        expanded
          ? "border-white/[0.12] bg-[#111113]"
          : "border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113] hover:border-white/[0.13]"
      }`}
      style={{
        boxShadow: expanded
          ? "0 8px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)"
          : "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)",
      }}
      onClick={onToggle}
    >
      {/* Row */}
      <div className="flex items-start gap-3 px-4 py-3.5">
        <UserAvatar address={service.executor} size={40} link />

        <div className="flex-1 min-w-0 pt-0.5">
          <p className="text-[15px] font-semibold text-white/90 leading-snug line-clamp-2 mb-2">{service.title}</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              myAccepted ? 'bg-emerald-400' : myPending ? 'bg-amber-400' : 'bg-violet-400/60'
            }`} />
            <span className="px-2 py-0.5 rounded-full text-xs font-mono font-semibold bg-primary/15 text-sky-400">
              {fmtUSDC(service.price)} USDC
            </span>
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-white/[0.06] text-white/50">
              {Number(service.deadlineDays)}d deadline
            </span>
            <span className="text-xs text-white/25">{timeAgo(service.createdAt)}</span>
            {Number(service.hiresCount) > 0 && (
              <span className="text-xs font-medium text-emerald-400/60">{Number(service.hiresCount)}×</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0 pt-1" onClick={e => e.stopPropagation()}>
          <ChevronDown className={`w-3.5 h-3.5 text-white/20 transition-transform ml-0.5 ${expanded ? "rotate-180" : ""}`} />
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-white/8 px-4 pb-4 pt-3" onClick={e => e.stopPropagation()}>
          {/* Unavailable notice */}
          {isUnavailable && (
            <div className="rounded-[12px] border border-orange-400/20 bg-orange-400/5 px-3 py-2 mb-3">
              <p className="text-xs text-orange-300/80 font-medium">
                {isRemoved ? t("board.services.service_removed_notice") : t("board.services.service_paused_notice")}
              </p>
            </div>
          )}
          {/* Full title */}
          {service.title && (
            <p className="font-semibold text-white/90 text-sm mb-2 leading-snug">{service.title}</p>
          )}

          <div className="flex items-center gap-2 text-xs text-white/30 mb-3">
            <span>{t("common.by")}</span>
            <UserName address={service.executor} link className="font-mono hover:text-white/60 transition-colors" />
          </div>

          {displayDesc && (
            <p className="text-sm text-white/60 leading-relaxed mb-4">{displayDesc}</p>
          )}

          {/* Meta recap: category · deadline · region · hires */}
          <div className="flex items-center gap-1.5 flex-wrap mb-3 pb-3 border-b border-white/6">
            {catKey && (
              <span className={`px-2 py-0.5 rounded-full border text-[11px] font-medium flex-shrink-0 ${CATEGORY_BADGE[catKey]}`}>
                {t(`categories.${catKey}`)}
              </span>
            )}
            <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-white/[0.06] text-white/50">{Number(service.deadlineDays)}d</span>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-white/[0.06] text-white/50">{REGION_LABELS[service.region]}</span>
            {Number(service.hiresCount) > 0 && (
              <span className="text-[11px] font-medium text-emerald-400/60">{t("board.services.hired", { count: Number(service.hiresCount) })}</span>
            )}
            {isMyService && <span className="text-[11px] text-white/20">{t("board.jobs.yours")}</span>}
          </div>

          {myActive && (
            <div className="mb-3 rounded-[14px] bg-white/[0.04] border border-white/[0.07] px-3 py-2.5">
              <p className="text-[10px] text-white/25 uppercase tracking-widest mb-1.5">{t("board.services.your_request", { id: myActive.requestId })}</p>
              <p className="text-xs text-white/50 font-mono">
                {fmtUSDC(myActive.amount)} USDC · {REQUEST_STATUS[myActive.status]}
              </p>
              {myAccepted && myAccepted.agreement !== "0x0000000000000000000000000000000000000000" && (
                <Link href={`/deal/${myAccepted.agreement}`}>
                  <Button size="sm" variant="outline" className="mt-2 h-7 px-2.5 text-xs gap-1 border-emerald-400/30 text-emerald-400/80">
                    {t("board.services.open_deal")} <ExternalLink className="w-3.5 h-3.5" />
                  </Button>
                </Link>
              )}
            </div>
          )}

          {/* Footer: chat + primary action + full-page link */}
          <div className="pt-2.5 border-t border-white/6 flex items-center gap-1.5">
            {isConnected && !isMyService && (
              <Link href={`/chat?peer=${service.executor}`}>
                <button className="w-8 h-8 flex items-center justify-center text-white/25 hover:text-white/60 transition-colors">
                  <MessageCircle className="w-3.5 h-3.5" />
                </button>
              </Link>
            )}
            {isConnected && !isMyService && myAccepted && myAccepted.agreement !== "0x0000000000000000000000000000000000000000" && (
              <Link href={`/deal/${myAccepted.agreement}`}>
                <Button size="sm" variant="outline" className="h-8 px-2.5 text-xs gap-1 border-emerald-400/30 text-emerald-400/80">
                  {t("board.services.deal_btn")} <ExternalLink className="w-3 h-3" />
                </Button>
              </Link>
            )}
            {isConnected && !isMyService && myPending && (
              <Button
                size="sm" variant="ghost" onClick={() => onCancelRequest(myPending.requestId)}
                disabled={isCancelling}
                className="h-8 px-2.5 text-xs text-red-400/60 hover:text-red-400 hover:bg-red-400/10"
              >
                {isCancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("board.services.cancel_request_btn")}
              </Button>
            )}
            {isConnected && !isMyService && !myActive && service.status === 0 && (
              <Button size="sm" onClick={() => onRequest(service)} disabled={isRequesting || isUnavailable} className="h-8 px-3 text-xs gap-1">
                {isRequesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {t("board.services.request_btn")}
              </Button>
            )}
            <Link href={`/service/${service.serviceId}`} onClick={e => e.stopPropagation()} className="ml-auto">
              <Button size="sm" variant="ghost" className="text-xs text-white/30 hover:text-white/60 h-8 px-2 gap-1.5">
                <ExternalLink className="w-3 h-3" /> {t("board.service_page.full_page")}
              </Button>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ExecutorBoardPage() {
  const { address, isConnected, status } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const t = useTranslations();

  const [regionFilter, setRegionFilter] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategoryKey | null>(null);
  const [customTagFilter, setCustomTagFilter] = useState<string | null>(null);
  const catScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = catScrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => { e.preventDefault(); el.scrollLeft += e.deltaY; };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);
  const [userRegion, setUserRegion]     = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [allServices, setAllServices] = useState<GraphService[]>([]);

  const PAGE_SIZE = 20;
  type SortKey = 'newest' | 'oldest' | 'highest' | 'lowest';
  const [sortBy, setSortBy] = useState<SortKey>('newest');
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedServiceId, setExpandedServiceId] = useState<string | null>(null);
  const [requestModal, setRequestModal] = useState<Service | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);

  const { data: totalServicesData } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'totalServices',
  }) as { data: bigint | undefined };

  const { data: totalRequestsData } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'totalRequests',
  }) as { data: bigint | undefined };

  const { data: userUsdcBalance } = useReadContract({
    address: CONTRACTS.usdc as `0x${string}`,
    abi: USDC_ABI as Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!requestModal },
  }) as { data: bigint | undefined };

  // My outgoing requests (as client) — batched via multicall
  const { data: myRequestIds, refetch: refetchMyRequests } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getClientRequests',
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: !!address },
  }) as { data: bigint[] | undefined; refetch: () => void };

  const myRequestContracts = useMemo(() =>
    (myRequestIds ?? []).map(id => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: 'getRequest' as const,
      args: [id] as const,
    })),
    [myRequestIds]
  );

  const { data: myRequestsData } = useReadContracts({
    contracts: myRequestContracts,
    query: { enabled: myRequestContracts.length > 0 },
  });

  const myRequests = useMemo<HireRequest[]>(() => {
    if (!myRequestsData || !myRequestIds) return [];
    return myRequestsData
      .map((d, i) => {
        if (d.status !== 'success') return null;
        const r = d.result as any;
        return {
          requestId: String(myRequestIds[i]),
          client: r.client,
          serviceId: r.serviceId,
          amount: r.amount,
          deadlineDays: r.deadlineDays,
          terms: r.terms,
          region: r.region,
          status: r.status,
          createdAt: r.createdAt,
          agreement: r.agreement,
        } as HireRequest;
      })
      .filter(Boolean) as HireRequest[];
  }, [myRequestsData, myRequestIds]);

  useEffect(() => {
    const stored = getStoredBoardRegion();
    fetch("/api/region")
      .then(r => r.json())
      .then(data => {
        const detected = data.region as number;
        setUserRegion(detected);
        // Use stored preference if user explicitly set one; otherwise default to Global (null)
        if (localStorage.getItem("hexseal_board_region") !== null) {
          setRegionFilter(stored);
        }
        // If no stored preference: leave regionFilter as null (show all jobs)
      })
      .catch(() => {
        if (stored !== null) setRegionFilter(stored);
      });
  }, []);

  const handleRegionChange = (v: number | null) => {
    setRegionFilter(v);
    storeBoardRegion(v);
  };

  const { services: pageServices, isLoading: loadingList, isFetching, hasMore, error: svcError, refetch: refetchServices } = useServices({
    region: regionFilter ?? undefined,
    page,
  });

  useEffect(() => {
    if (svcError) console.error('[Board/executor] subgraph error:', svcError);
  }, [svcError]);

  useEffect(() => {
    if (page === 0) {
      setAllServices(pageServices);
    } else if (pageServices.length > 0) {
      setAllServices(prev => [...prev, ...pageServices]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageServices]);

  useEffect(() => {
    setPage(0);
    setAllServices([]);
  }, [regionFilter]);

  // page=0: use pageServices directly so urql cache renders immediately on mount/remount.
  // page>0: use the accumulated array (Load More appends to allServices via effect).
  const displayServices = page === 0 ? pageServices : allServices;

  const services: Service[] = useMemo(() => displayServices.map(gs => ({
    serviceId: gs.id,
    executor: gs.executor,
    title: gs.title,
    description: gs.description,
    price: BigInt(gs.price),
    deadlineDays: BigInt(gs.deadlineDays),
    region: gs.region,
    status: gs.status === 'active' ? 0 : gs.status === 'paused' ? 1 : 2,
    createdAt: BigInt(gs.createdAt),
    hiresCount: BigInt(gs.hiresCount),
  })), [displayServices]);

  const popularCustomTags = useMemo(() => {
    const counts = new Map<string, number>();
    displayServices.forEach(gs => {
      if (extractCategory(gs.description ?? '') !== 'other') return;
      const tag = extractCustomTag(stripCategory(gs.description ?? ''));
      if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([tag]) => tag);
  }, [displayServices]);

  const filtered = useMemo(() => {
    let list = services.filter(s => s.status === 0);
    if (regionFilter !== null) {
      list = list.filter(s => s.region === regionFilter);
    }
    if (categoryFilter !== null) {
      list = list.filter(s => extractCategory(s.description) === categoryFilter);
    }
    if (customTagFilter) {
      list = list.filter(s =>
        extractCategory(s.description) === 'other' &&
        stripCategory(s.description).startsWith(`[${customTagFilter}] `)
      );
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(s => {
        const catKey = extractCategory(s.description ?? '') ?? '';
        const stripped = stripCategory(s.description ?? '');
        const tag = catKey === 'other' ? (extractCustomTag(stripped) ?? '') : '';
        const cleanDesc = catKey === 'other' ? stripCustomTag(stripped) : stripped;
        const hay = `${s.title} ${cleanDesc} ${catKey} ${tag}`.toLowerCase();
        return hay.includes(q);
      });
    }
    switch (sortBy) {
      case 'oldest':  return [...list].sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
      case 'highest': return [...list].sort((a, b) => Number(b.price) - Number(a.price));
      case 'lowest':  return [...list].sort((a, b) => Number(a.price) - Number(b.price));
      default:        return [...list].sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    }
  }, [services, searchQuery, regionFilter, categoryFilter, customTagFilter, sortBy]);

  const handleRequest = async (amountStr: string, daysStr: string, termsText: string) => {
    if (!requestModal || !walletClient || !publicClient || !address) return;
    if (requestModal.status !== 0) {
      toast.error("This service is no longer active.");
      setRequestModal(null);
      return;
    }
    setIsRequesting(true);
    try {
      const amount = parseUnits(amountStr, 6);
      const days   = BigInt(daysStr);

      toast(t("board.services.sign_permit"));
      await requestServiceGasless(walletClient, publicClient, {
        serviceId:    BigInt(requestModal.serviceId),
        amount,
        deadlineDays: days,
        terms:        termsText.trim(),
        region:       requestModal.region,
      });

      toast.success(t("board.services.request_sent"));
      // Live in-app notifications only fire while the executor happens to have
      // the site open at that exact moment — a push is the only way this
      // reaches them if they're away (mirrors the job-board apply push).
      notifyPush(
        requestModal.executor,
        `Someone requested your service: ${requestModal.title || `Service #${requestModal.serviceId}`}`,
        `/service/${requestModal.serviceId}`,
        `/service/${requestModal.serviceId}`,
      );
      setRequestModal(null);
      setTimeout(() => { refetchMyRequests(); }, 2000);
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || "Transaction failed");
    } finally {
      setIsRequesting(false);
    }
  };

  const [isCancelling, setIsCancelling] = useState(false);

  const handleCancelRequest = async (requestId: string) => {
    if (!walletClient || !publicClient) return;
    setIsCancelling(true);
    try {
      await sendGasless(walletClient, publicClient, "cancelRequest", [BigInt(requestId)], DIAMOND_ABI as Abi);
      toast.success(t("board.services.request_cancelled"));
      setTimeout(() => { refetchMyRequests(); }, 2000);
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || "Failed");
    } finally {
      setIsCancelling(false);
    }
  };

  // Wallet reconnecting on page reload — show skeleton to avoid flash of "connect" screen
  if (status === 'reconnecting' || status === 'connecting') {
    return (
      <div className="container mx-auto px-4 pt-4 pb-6 max-w-6xl space-y-3">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className="animate-pulse rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] min-h-[72px]"
          >
            <div className="flex items-center gap-3 px-4 py-4">
              <div className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-white/[0.06]" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-40 rounded-md bg-white/[0.06]" />
                <div className="flex gap-2">
                  <div className="h-2.5 w-16 rounded-md bg-white/[0.06]" />
                  <div className="h-2.5 w-12 rounded-md bg-white/[0.06]" />
                </div>
              </div>
              <div className="h-8 w-24 rounded-[10px] bg-white/[0.06] flex-shrink-0" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ minHeight: 'calc(100dvh - var(--content-top-offset))' }}
      >
        <div className="text-center max-w-sm px-6">
          <h1 className="text-2xl font-bold font-syne mb-2">{t("board.services.title")}</h1>
          <p className="text-muted-foreground mb-6 text-sm">{t("board.services.connect_prompt")}</p>
          <Link href="/"><Button>{t("common.go_home")}</Button></Link>
        </div>
      </div>
    );
  }

  return (
    <>
      {requestModal && (
        <RequestServiceModal
          service={requestModal}
          onClose={() => setRequestModal(null)}
          onSubmit={handleRequest}
          loading={isRequesting}
          userUsdcBalance={userUsdcBalance}
        />
      )}

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
      >
        <div className="container mx-auto px-4 pt-4 pb-6 max-w-6xl">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold font-syne mb-0.5">{t("board.services.title")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("board.services.subtitle")}{" "}
                <Link href="/board/executor/post" className="text-primary hover:underline">{t("board.services.post_own_link")}</Link>
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 self-start">
              <Button variant="ghost" size="sm" onClick={() => { setAllServices([]); setPage(0); refetchServices(); }} disabled={isFetching} className="text-white/40 hover:text-white/70">
                <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
              </Button>
              <Link href="/board/executor/post">
                <Button size="sm"><Plus className="w-4 h-4 mr-1" />{t("board.post_service.submit_btn")}</Button>
              </Link>
            </div>
          </div>
        </div>
      </motion.div>

      <div className="container mx-auto px-4 pt-0 pb-6 max-w-6xl">
        {/* Incoming requests for executor */}
        {isConnected && address && (
          <IncomingRequestsPanel
            address={address}
            services={services}
            onRefresh={() => { setAllServices([]); setPage(0); refetchServices(); }}
          />
        )}

        {/* Region filter */}
        <div className="mb-4">
          <BoardRegionFilter
            value={regionFilter}
            onChange={handleRegionChange}
            userRegion={userRegion}
          />
        </div>

        {/* Category filter — horizontal scroll strip */}
        <div
          ref={catScrollRef}
          className="flex overflow-x-auto gap-1.5 mb-5 pb-0.5 -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            onClick={() => { setCategoryFilter(null); setCustomTagFilter(null); }}
            className={`flex-shrink-0 px-3 py-1 rounded-full text-xs border transition-colors ${
              categoryFilter === null
                ? "bg-white/10 border-white/20 text-white/80"
                : "border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50"
            }`}
          >
            {t("common.all")}
          </button>
          {CATEGORIES.map(({ key, badge }) => (
            <button
              key={key}
              onClick={() => { setCategoryFilter(categoryFilter === key ? null : key); setCustomTagFilter(null); }}
              className={`flex-shrink-0 px-3 py-1 rounded-full text-xs border transition-colors ${
                categoryFilter === key && !customTagFilter ? badge : "border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50"
              }`}
            >
              {t(`categories.${key}`)}
            </button>
          ))}
          {popularCustomTags.map(tag => (
            <button
              key={`ctag-${tag}`}
              onClick={() => {
                if (customTagFilter === tag) { setCustomTagFilter(null); setCategoryFilter(null); }
                else { setCategoryFilter('other'); setCustomTagFilter(tag); }
              }}
              className={`flex-shrink-0 px-3 py-1 rounded-full text-xs border transition-colors ${
                customTagFilter === tag
                  ? CATEGORY_BADGE['other']
                  : "border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50"
              }`}
            >
              #{tag}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative mb-5">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
          <Input
            placeholder={t("board.services.search_placeholder")}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9 bg-[#0d0d0f] border-white/[0.08] placeholder:text-white/20 rounded-[14px]"
          />
        </div>


        {/* Sort controls */}
        {!loadingList && filtered.length > 0 && (
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            <span className="text-xs text-white/25 mr-1">{t("common.sort")}:</span>
            {(['newest','oldest','highest','lowest'] as const).map(key => (
              <button key={key} onClick={() => setSortBy(key)}
                className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                  sortBy === key ? 'bg-white/10 border-white/20 text-white/80' : 'border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50'
                }`}>
                {key === 'newest' ? t("board.sort.newest") : key === 'oldest' ? t("board.sort.oldest") : key === 'highest' ? t("board.sort.highest") : t("board.sort.lowest")}
              </button>
            ))}
            <span className="ml-auto text-xs text-white/20">{filtered.length}{hasMore ? '+' : ''}</span>
          </div>
        )}

        {!loadingList && filtered.length > 0 && (
          <div className="mb-4">
            <ContextHint hintKey="executor_board_request">{t("hints.executor_board_request")}</ContextHint>
          </div>
        )}

        {svcError && (
          <div className="mb-4 rounded-[14px] border border-red-400/20 bg-red-400/5 px-4 py-3 text-xs text-red-400/80">
            {t("common.error")}
          </div>
        )}

        {loadingList ? (
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map(i => (
              <div
                key={i}
                className="animate-pulse rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] min-h-[80px]"
                style={{ animationDelay: `${i * 0.07}s` }}
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-[18px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4">
              <Briefcase className="w-6 h-6 text-white/20" />
            </div>
            <p className="text-white/40 text-sm mb-1">
              {searchQuery
                ? t("board.services.no_results")
                : regionFilter !== null
                  ? t("board.services.no_region_results", { region: REGION_LABELS[regionFilter] ?? '' })
                  : t("board.services.empty")}
            </p>
            {!searchQuery && regionFilter !== null ? (
              <Button size="sm" variant="outline" className="mt-4 border-white/15 text-white/60" onClick={() => handleRegionChange(null)}>
                {t("board.services.show_global")}
              </Button>
            ) : !searchQuery && (
              <Link href="/board/executor/post">
                <Button size="sm" variant="outline" className="mt-4 border-white/15 text-white/60">
                  <Plus className="w-3.5 h-3.5 mr-1" />{t("board.post_service.submit_btn")}
                </Button>
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {filtered.map((svc, index) => (
                <div key={svc.serviceId} className="card-enter active:scale-[0.993] transition-transform duration-100" style={{ animationDelay: `${Math.min(index, 8) * 0.04}s` }}>
                  <ServiceCard
                    service={svc}
                    address={address}
                    isConnected={isConnected}
                    myRequests={myRequests.filter(r => String(r.serviceId) === svc.serviceId)}
                    onRequest={() => setRequestModal(svc)}
                    isRequesting={isRequesting}
                    onCancelRequest={handleCancelRequest}
                    isCancelling={isCancelling}
                    expanded={expandedServiceId === svc.serviceId}
                    onToggle={() => setExpandedServiceId(prev => prev === svc.serviceId ? null : svc.serviceId)}
                  />
                </div>
              ))}
            </div>
            {hasMore && (
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={isFetching}
                className="w-full mt-4 py-2.5 rounded-[14px] border border-white/[0.08] text-sm text-white/40 hover:text-white/70 hover:border-white/15 hover:bg-white/[0.03] transition-colors disabled:opacity-50"
              >
                {isFetching ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : t("common.load_more")}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
