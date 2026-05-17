"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useAccount, useWalletClient, usePublicClient, useReadContract } from "wagmi";
import { DIAMOND_ABI, USDC_ABI, CONTRACTS } from "@/config/contracts";
import type { Abi } from "viem";
import { parseUnits } from "viem";
import { requestServiceGasless } from "@/lib/relay";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search, Loader2, Briefcase, Plus, ArrowRight,
  MessageCircle, RefreshCw, ChevronDown, X, ExternalLink,
  UserCheck,
} from "lucide-react";
import Link from "next/link";
import { UserName } from "@/components/UserName";
import { useTranslations } from "next-intl";
import { BoardRegionFilter, getStoredBoardRegion, storeBoardRegion } from "@/components/BoardRegionFilter";

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
  termsHash: string;
  region: number;
  status: number;   // 0=PENDING 1=ACCEPTED 2=REJECTED 3=CANCELLED
  createdAt: bigint;
  agreement: string;
}

const REGION_LABELS: Record<number, string> = { 0: "CIS", 1: "Asia/LATAM", 2: "Europe", 3: "US/CA" };
const REQUEST_STATUS: Record<number, string> = { 0: "Pending", 1: "Accepted", 2: "Rejected", 3: "Cancelled" };
const DEAL_STATUS: Record<number, string> = { 0: "Created", 1: "Funded", 2: "Active", 3: "Done", 4: "Disputed", 5: "Resolved", 6: "Refunded" };

function shortAddr(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}`; }
function fmtUSDC(val: bigint) { return (Number(val) / 1e6).toFixed(2); }

// ─── Request Modal ─────────────────────────────────────────────────────────

function RequestModal({
  service,
  onClose,
  onSubmit,
  loading,
  userUsdcBalance,
}: {
  service: Service;
  onClose: () => void;
  onSubmit: (amount: string, days: string, region: number) => void;
  loading: boolean;
  userUsdcBalance?: bigint;
}) {
  const [amount, setAmount] = useState(fmtUSDC(service.price));
  const [days, setDays]     = useState(String(Number(service.deadlineDays)));
  const [region, setRegion] = useState(service.region);
  const t = useTranslations();

  const parsedAmount = parseFloat(amount || "0");
  const requiredRaw  = parsedAmount > 0 ? BigInt(Math.round(parsedAmount * 1e6)) : 0n;
  const hasEnough    = userUsdcBalance === undefined || userUsdcBalance >= requiredRaw;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/12 bg-[#111] p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-syne font-bold text-lg">{t("board.services.request_btn")}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-white/50 mb-5 border-b border-white/8 pb-4">
          <span className="text-white/80 font-medium">{service.title}</span>
          <br />
          <UserName address={service.executor} link className="font-mono text-xs text-white/30 hover:text-white/60 transition-colors" />
        </p>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-white/40 block mb-1.5">{t("board.services.amount_label")}</label>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="bg-white/[0.04] border-white/10 text-white"
              placeholder="10.00"
            />
            <p className="text-xs text-white/25 mt-1">Suggested: {fmtUSDC(service.price)} USDC</p>
          </div>

          <div>
            <label className="text-xs text-white/40 block mb-1.5">Deadline (days)</label>
            <Input
              type="number"
              min="1"
              max="365"
              value={days}
              onChange={e => setDays(e.target.value)}
              className="bg-white/[0.04] border-white/10 text-white"
            />
          </div>

          <div>
            <label className="text-xs text-white/40 block mb-1.5">Your Region (sets platform fee)</label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(REGION_LABELS).map(([k, v]) => (
                <button
                  key={k}
                  onClick={() => setRegion(Number(k))}
                  className={`rounded-lg border py-2 text-xs transition-colors ${
                    region === Number(k)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-white/10 text-white/40 hover:border-white/20"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-2">
          <Button variant="ghost" className="flex-1 border border-white/10 text-white/50" onClick={onClose} disabled={loading}>
            {t("common.cancel")}
          </Button>
          <Button
            className="flex-1 gap-1.5"
            disabled={loading || !amount || !days || !hasEnough}
            onClick={() => onSubmit(amount, days, region)}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            {t("board.services.request_confirm")}
          </Button>
        </div>

        {!hasEnough && userUsdcBalance !== undefined && (
          <p className="text-xs text-red-400 text-center mt-2">
            Insufficient USDC — have {fmtUSDC(userUsdcBalance)}, need {parsedAmount.toFixed(2)}
          </p>
        )}
        {hasEnough && (
          <p className="text-xs text-white/25 text-center mt-3">
            Platform fee will be charged on submit. Amount is locked until executor responds.
          </p>
        )}
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
}: {
  service: Service;
  address?: string;
  isConnected: boolean;
  myRequests: HireRequest[];
  onRequest: (service: Service) => void;
  isRequesting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isMyService = address?.toLowerCase() === service.executor.toLowerCase();
  const t = useTranslations();

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
      onClick={() => setExpanded(v => !v)}
    >
      {/* Row */}
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-400/80 mt-0.5" />

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="font-semibold text-white/90 text-sm truncate">{service.title}</span>
            {isMyService && <span className="text-[10px] text-white/25 font-mono flex-shrink-0">{t("board.jobs.yours")}</span>}
          </div>
          <div className="flex items-center gap-2.5 text-xs flex-wrap">
            <span className="font-bold text-white/75 font-mono">{fmtUSDC(service.price)} USDC</span>
            <span className="text-white/25">·</span>
            <span className="text-white/35">{Number(service.deadlineDays)}d</span>
            <span className="text-white/25">·</span>
            <span className="text-white/25">{REGION_LABELS[service.region]}</span>
            {Number(service.hiresCount) > 0 && (
              <>
                <span className="text-white/25">·</span>
                <span className="text-white/25">{Number(service.hiresCount)} hired</span>
              </>
            )}
            {myPending && <span className="text-yellow-400/70 font-mono text-[11px]">awaiting response</span>}
            {myAccepted && <span className="text-emerald-400/70 font-mono text-[11px]">accepted</span>}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
          {isConnected && !isMyService && (
            <Link href={`/chat/${service.executor}`}>
              <Button size="sm" variant="ghost" className="h-9 w-9 p-0 text-white/30 hover:text-primary">
                <MessageCircle className="w-3.5 h-3.5" />
              </Button>
            </Link>
          )}
          {isConnected && !isMyService && myAccepted && myAccepted.agreement !== "0x0000000000000000000000000000000000000000" && (
            <Link href={`/deal/${myAccepted.agreement}`}>
              <Button size="sm" variant="outline" className="h-9 px-3 text-xs gap-1 border-emerald-400/30 text-emerald-400/80">
                Deal <ExternalLink className="w-3 h-3" />
              </Button>
            </Link>
          )}
          {isConnected && !isMyService && !myActive && (
            <Button size="sm" onClick={() => onRequest(service)} disabled={isRequesting} className="h-9 px-3 text-xs gap-1">
              {isRequesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {t("board.services.request_btn")}
            </Button>
          )}
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-white/20 transition-transform flex-shrink-0 ${expanded ? "rotate-180" : ""}`} />
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-white/8 px-4 pb-4 pt-3" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-2 text-xs text-white/30 mb-3">
            <span>by</span>
            <UserName address={service.executor} link className="font-mono hover:text-white/60 transition-colors" />
            <span className="text-white/20">· #{service.serviceId}</span>
          </div>

          {service.description && (
            <p className="text-sm text-white/60 leading-relaxed mb-3">{service.description}</p>
          )}

          {myActive && (
            <div className="mb-3 rounded-[14px] bg-white/[0.04] border border-white/[0.07] px-3 py-2.5">
              <p className="text-[10px] text-white/25 uppercase tracking-widest mb-1.5">Your Request #{myActive.requestId}</p>
              <p className="text-xs text-white/50 font-mono">
                {fmtUSDC(myActive.amount)} USDC · {REQUEST_STATUS[myActive.status]}
              </p>
              {myAccepted && myAccepted.agreement !== "0x0000000000000000000000000000000000000000" && (
                <Link href={`/deal/${myAccepted.agreement}`}>
                  <Button size="sm" variant="outline" className="mt-2 h-7 px-2.5 text-xs gap-1 border-emerald-400/30 text-emerald-400/80">
                    Open Deal <ExternalLink className="w-3.5 h-3.5" />
                  </Button>
                </Link>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ExecutorBoardPage() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const t = useTranslations();

  const [mounted, setMounted]         = useState(false);
  const [regionFilter, setRegionFilter] = useState<number | null>(null);
  const [userRegion, setUserRegion]     = useState<number | null>(null);
  const [services, setServices]       = useState<Service[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
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

  // My outgoing requests (as client)
  const { data: myRequestIds, refetch: refetchMyRequests } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getClientRequests',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: bigint[] | undefined; refetch: () => void };

  const [myRequests, setMyRequests] = useState<HireRequest[]>([]);

  // Load request details when IDs change
  useEffect(() => {
    if (!myRequestIds || !publicClient || myRequestIds.length === 0) { setMyRequests([]); return; }
    Promise.all(
      myRequestIds.map(id =>
        publicClient.readContract({
          address: CONTRACTS.diamond as `0x${string}`,
          abi: DIAMOND_ABI as Abi,
          functionName: 'getRequest',
          args: [id],
        }).then((r: any) => ({
          requestId: String(id),
          client: r.client,
          serviceId: r.serviceId,
          amount: r.amount,
          deadlineDays: r.deadlineDays,
          termsHash: r.termsHash,
          region: r.region,
          status: r.status,
          createdAt: r.createdAt,
          agreement: r.agreement,
        } as HireRequest)).catch(() => null)
      )
    ).then(results => setMyRequests(results.filter(Boolean) as HireRequest[]));
  }, [myRequestIds, publicClient]);

  const loadServices = useCallback(async () => {
    if (!publicClient) return;
    setLoadingList(true);
    try {
      const result = await publicClient.readContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI as Abi,
        functionName: 'getActiveServices',
      }) as [bigint[], any[]];

      const [ids, svcs] = result;
      setServices(ids.map((id, i) => ({
        serviceId: String(id),
        executor:     svcs[i].executor,
        title:        svcs[i].title,
        description:  svcs[i].description,
        price:        svcs[i].price,
        deadlineDays: svcs[i].deadlineDays,
        region:       svcs[i].region,
        status:       svcs[i].status,
        createdAt:    svcs[i].createdAt,
        hiresCount:   svcs[i].hiresCount,
      })));
    } catch (err) {
      console.error("Failed to load services:", err);
    } finally {
      setLoadingList(false);
    }
  }, [publicClient]);

  useEffect(() => {
    setMounted(true);
    const stored = getStoredBoardRegion();
    fetch("/api/region")
      .then(r => r.json())
      .then(data => {
        const detected = data.region as number;
        setUserRegion(detected);
        if (stored !== null || localStorage.getItem("sig404_board_region") !== null) {
          setRegionFilter(stored);
        } else {
          setRegionFilter(detected);
          storeBoardRegion(detected);
        }
      })
      .catch(() => {
        if (stored !== null) setRegionFilter(stored);
      });
  }, []);

  const handleRegionChange = (v: number | null) => {
    setRegionFilter(v);
    storeBoardRegion(v);
  };

  useEffect(() => {
    if (mounted && publicClient) loadServices();
  }, [mounted, publicClient, loadServices]);


  const filtered = useMemo(() => {
    let list = services;
    if (regionFilter !== null) {
      list = list.filter(s => s.region === regionFilter);
    }
    if (!searchQuery) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(s =>
      s.title.toLowerCase().includes(q) || s.executor.toLowerCase().includes(q)
    );
  }, [services, searchQuery, regionFilter]);

  const handleRequest = async (amountStr: string, daysStr: string, region: number) => {
    if (!requestModal || !walletClient || !publicClient || !address) return;
    setIsRequesting(true);
    try {
      const amount    = parseUnits(amountStr, 6);
      const days      = BigInt(daysStr);
      const termsHash = ("0x" + "0".repeat(64)) as `0x${string}`;

      toast("Sign: USDC permit in wallet…");
      await requestServiceGasless(walletClient, publicClient, {
        serviceId:    BigInt(requestModal.serviceId),
        amount,
        deadlineDays: days,
        termsHash,
        region,
      });

      toast.success("Request sent! Waiting for executor to accept.");
      setRequestModal(null);
      setTimeout(() => { refetchMyRequests(); loadServices(); }, 2000);
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || "Transaction failed");
    } finally {
      setIsRequesting(false);
    }
  };

  if (!mounted || !isConnected) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <Briefcase className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("board.services.title")}</h1>
          <p className="text-muted-foreground mb-6 text-sm">{t("board.services.connect_prompt")}</p>
          <Link href="/"><Button>Go Home</Button></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {requestModal && (
        <RequestModal
          service={requestModal}
          onClose={() => setRequestModal(null)}
          onSubmit={handleRequest}
          loading={isRequesting}
          userUsdcBalance={userUsdcBalance}
        />
      )}

      {/* Header */}
      <div className="border-b border-white/[0.06]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold font-syne mb-0.5">{t("board.services.title")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("board.services.subtitle")}{" "}
                <Link href="/board/executor/post" className="text-primary hover:underline">{t("board.services.post_own_link")}</Link>
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 self-start">
              <Button variant="ghost" size="sm" onClick={loadServices} disabled={loadingList} className="text-white/40 hover:text-white/70">
                <RefreshCw className={`w-4 h-4 ${loadingList ? "animate-spin" : ""}`} />
              </Button>
              <Link href="/board/executor/post">
                <Button size="sm"><Plus className="w-4 h-4 mr-1" />{t("board.post_service.submit_btn")}</Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6 max-w-4xl">
        {/* Region filter */}
        <div className="mb-4">
          <BoardRegionFilter
            value={regionFilter}
            onChange={handleRegionChange}
            userRegion={userRegion}
          />
        </div>

        {/* Flow hint */}
        <div className="rounded-[14px] border border-white/[0.07] px-4 py-3 flex items-start gap-3 mb-5">
          <UserCheck className="w-4 h-4 text-white/25 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-white/40 leading-relaxed">{t("board.services.flow_hint")}</p>
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

        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-white/30 font-mono">
            {loadingList ? t("board.jobs.loading_short") : `${filtered.length} active service${filtered.length !== 1 ? "s" : ""}`}
          </span>
          {totalServicesData !== undefined && (
            <span className="text-xs text-white/15 font-mono">/ {totalServicesData.toString()} total</span>
          )}
          {totalRequestsData !== undefined && (
            <span className="text-xs text-white/15 font-mono">· {totalRequestsData.toString()} requests</span>
          )}
        </div>

        {loadingList ? (
          <div className="flex items-center justify-center py-24 gap-2 text-white/30">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">{t("board.services.loading")}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mb-4">
              <Briefcase className="w-6 h-6 text-white/25" />
            </div>
            <p className="text-white/40 text-sm mb-1">
              {searchQuery ? t("board.services.no_results") : t("board.services.empty")}
            </p>
            <Link href="/board/executor/post">
              <Button size="sm" variant="outline" className="mt-4 border-white/15 text-white/60">
                <Plus className="w-3.5 h-3.5 mr-1" />{t("board.post_service.submit_btn")}
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(svc => (
              <ServiceCard
                key={svc.serviceId}
                service={svc}
                address={address}
                isConnected={isConnected}
                myRequests={myRequests.filter(r => String(r.serviceId) === svc.serviceId)}
                onRequest={() => setRequestModal(svc)}
                isRequesting={isRequesting}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
