"use client";

import { use, useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useAccount, useReadContract, useWalletClient, usePublicClient } from "wagmi";
import { DIAMOND_ABI, USDC_ABI, CONTRACTS } from "@/config/contracts";
import { parseUnits, type Abi } from "viem";
import { requestServiceGasless, sendGasless } from "@/lib/relay";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RequestServiceModal } from "@/components/RequestServiceModal";
import { toast } from "react-hot-toast";
import {
  DollarSign, Calendar, Globe, Users2,
  Loader2, ArrowRight, MessageCircle,
  CheckCircle, ExternalLink, PauseCircle, PlayCircle, Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { UserName, UserAvatar } from "@/components/UserName";
import { extractCategory, stripCategory, CATEGORY_BADGE } from "@/config/categories";
import { PageCenter } from "@/components/PageCenter";
import { useFeeConfig } from "@/hooks/useFeeConfig";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Service {
  executor: string;
  title: string;
  description: string;
  price: bigint;
  deadlineDays: bigint;
  region: number;
  status: number; // 0=ACTIVE 1=PAUSED 2=REMOVED
  createdAt: bigint;
  hiresCount: bigint;
}

const REGION_LABELS: Record<number, string> = {
  0: "CIS", 1: "Asia", 2: "Europe", 3: "US", 4: "LATAM", 5: "CA", 6: "AU",
};

const SERVICE_STATUS: Record<number, { label: string; color: string }> = {
  0: { label: "Active",   color: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20" },
  1: { label: "Paused",   color: "bg-amber-400/10 text-amber-400 border-amber-400/20" },
  2: { label: "Removed",  color: "bg-gray-400/10 text-gray-400 border-gray-400/20" },
};

const REQUEST_STATUS: Record<number, { label: string; color: string }> = {
  0: { label: "Pending",    color: "text-yellow-400" },
  1: { label: "Accepted",   color: "text-emerald-400" },
  2: { label: "Rejected",   color: "text-red-400" },
  3: { label: "Cancelled",  color: "text-gray-400" },
  4: { label: "Superseded", color: "text-gray-400" },
};

function fmtUSDC(v: bigint) { return (Number(v) / 1e6).toFixed(2); }

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const serviceId = BigInt(id);
  const t = useTranslations();
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  // Live floor, for the honest "only the floor is non-refundable" cancel toast —
  // cancelRequest (src/facets/ServiceBoardFacet.sol) now burns it, so the old
  // unqualified "funds refunded" text overstated what actually comes back.
  const { feeFloor } = useFeeConfig();

  // ── Service data ────────────────────────────────────────────────────────────

  const { data: rawService, isLoading, isError: serviceError, refetch: refetchService } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: "getService",
    args: [serviceId],
  });
  const service = rawService as Service | undefined;

  // ── Client's requests for this service ─────────────────────────────────────

  const { data: myRequestIds, refetch: refetchRequests } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: "getClientRequests",
    args: [address as `0x${string}`],
    query: { enabled: !!address },
  }) as { data: bigint[] | undefined; refetch: () => void };

  const [myRequest, setMyRequest] = useState<{
    id: bigint; status: number; amount: bigint; agreement: string;
  } | null>(null);

  useEffect(() => {
    if (!myRequestIds?.length || !publicClient) { setMyRequest(null); return; }
    Promise.all(
      myRequestIds.map(rid =>
        publicClient.readContract({
          address: CONTRACTS.diamond as `0x${string}`,
          abi: DIAMOND_ABI as Abi,
          functionName: "getRequest",
          args: [rid],
        }).then(r => ({ ...(r as any), id: rid })).catch(() => null)
      )
    ).then(results => {
      const forThis = results.filter(r => r && String(r.serviceId) === String(serviceId));
      const active = forThis.find(r => r!.status === 0 || r!.status === 1);
      const latest = active ?? (forThis.length ? forThis[forThis.length - 1] : null);
      setMyRequest(
        latest
          ? { id: latest.id, status: latest.status, amount: latest.amount, agreement: latest.agreement }
          : null
      );
    });
  }, [myRequestIds, publicClient, serviceId]);

  // ── USDC balance ────────────────────────────────────────────────────────────

  const { data: usdcBalance } = useReadContract({
    address: CONTRACTS.usdc as `0x${string}`,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
    query: { enabled: !!address },
  }) as { data: bigint | undefined };

  // ── Actions ─────────────────────────────────────────────────────────────────

  const [requestModal, setRequestModal] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isBusy, setIsBusy]             = useState(false);

  const handleRequest = async (
    amountStr: string, daysStr: string, termsText: string,
  ) => {
    if (!walletClient || !publicClient || !address || !service) return;
    setIsRequesting(true);
    try {
      const amount = parseUnits(amountStr, 6);
      const days   = BigInt(daysStr);

      toast(t("board.services.sign_permit"));
      await requestServiceGasless(walletClient, publicClient, {
        serviceId, amount, deadlineDays: days, terms: termsText.trim(), region: service.region,
      });

      toast.success(t("board.services.request_sent"));
      setRequestModal(false);
      setTimeout(() => refetchRequests(), 2000);
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || "Transaction failed");
    } finally {
      setIsRequesting(false);
    }
  };

  const handleCancelRequest = async () => {
    if (!walletClient || !publicClient || !myRequest) return;
    setIsCancelling(true);
    try {
      await sendGasless(walletClient, publicClient, "cancelRequest", [myRequest.id], DIAMOND_ABI as Abi);
      toast.success(t("board.services.request_cancelled", { floor: fmtUSDC(feeFloor ?? 0n) }));
      setTimeout(() => { refetchRequests(); setIsCancelling(false); }, 2000);
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || "Failed");
      setIsCancelling(false);
    }
  };

  const handleServiceAction = async (
    fn: "pauseService" | "unpauseService" | "removeService",
  ) => {
    if (!walletClient || !publicClient) return;
    setIsBusy(true);
    try {
      const msgs: Record<string, string> = {
        pauseService:   "Service paused",
        unpauseService: "Service resumed",
        removeService:  "Service removed",
      };
      await sendGasless(walletClient, publicClient, fn, [serviceId], DIAMOND_ABI as Abi);
      toast.success(msgs[fn]);
      if (fn === "removeService") {
        router.push("/board/executor");
        return;
      }
      // Wait for the refetch to actually land before re-enabling the buttons —
      // otherwise the badge and Pause/Resume button kept showing the PRE-action
      // state, so a click here would look like it did nothing, and a same-action
      // re-click reverted with a raw "Call failed: Inner call reverted"
      // (ServiceNotActive isn't in the relay's known-error map) right after the
      // FIRST click's success toast.
      await refetchService();
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || "Failed");
    } finally {
      setIsBusy(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 pt-4 pb-6 max-w-4xl space-y-4 animate-pulse">
        <div className="space-y-2">
          <div className="h-3 w-24 rounded bg-white/[0.06]" />
          <div className="h-7 w-3/4 rounded-lg bg-white/[0.06]" />
        </div>
        <div className="rounded-[22px] border border-white/[0.06] bg-[#0d0d0f] p-5 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-2.5 w-12 rounded bg-white/[0.05]" />
                <div className="h-4 w-20 rounded bg-white/[0.06]" />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 pt-3 border-t border-white/[0.05]">
            <div className="w-9 h-9 rounded-full bg-white/[0.06]" />
            <div className="h-3 w-32 rounded bg-white/[0.06]" />
          </div>
          <div className="space-y-2">
            <div className="h-2.5 w-16 rounded bg-white/[0.05]" />
            <div className="h-3 w-full rounded bg-white/[0.06]" />
            <div className="h-3 w-5/6 rounded bg-white/[0.06]" />
          </div>
        </div>
      </div>
    );
  }

  if (serviceError) {
    return (
      <PageCenter>
        <div className="text-center space-y-4">
          <p className="text-white/40 text-sm">{t("common.error")}</p>
          <Button variant="outline" size="sm" onClick={() => refetchService()}>{t("common.retry")}</Button>
        </div>
      </PageCenter>
    );
  }

  const ZERO = "0x0000000000000000000000000000000000000000";
  if (!service || !service.executor || service.executor === ZERO) {
    return (
      <PageCenter>
        <div className="text-center space-y-4">
          <p className="text-white/40 text-sm">{t("board.service_page.not_found")}</p>
          <Link href="/board/executor">
            <Button variant="outline" size="sm">{t("board.services.title")}</Button>
          </Link>
        </div>
      </PageCenter>
    );
  }

  const isMyService  = !!address && service.executor.toLowerCase() === address.toLowerCase();
  const catKey       = extractCategory(service.description);
  const displayDesc  = stripCategory(service.description);
  const statusInfo   = SERVICE_STATUS[service.status] ?? SERVICE_STATUS[0];
  const canRequest   = isConnected && !isMyService && service.status === 0 &&
    (!myRequest || (myRequest.status !== 0 && myRequest.status !== 1));

  return (
    <>
      {requestModal && service && (
        <RequestServiceModal
          service={service}
          onClose={() => setRequestModal(false)}
          onSubmit={handleRequest}
          loading={isRequesting}
          userUsdcBalance={usdcBalance}
        />
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div>
        <div className="container mx-auto px-4 pt-4 pb-3 max-w-4xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-xs font-mono text-white/30">#{id}</span>
                <Badge className={`text-xs border font-medium ${statusInfo.color}`}>
                  {statusInfo.label}
                </Badge>
                {catKey && (
                  <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${CATEGORY_BADGE[catKey]}`}>
                    {t(`categories.${catKey}`)}
                  </span>
                )}
              </div>
              <h1 className="text-2xl font-bold font-syne leading-tight">
                {service.title || `Service #${id}`}
              </h1>
            </div>

            {/* Executor controls */}
            {isMyService && service.status !== 2 && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {service.status === 0 && (
                  <Button
                    variant="ghost" size="sm" disabled={isBusy}
                    onClick={() => handleServiceAction("pauseService")}
                    className="text-amber-400/60 hover:text-amber-400 hover:bg-amber-400/10 gap-1"
                  >
                    <PauseCircle className="w-3.5 h-3.5" /> Pause
                  </Button>
                )}
                {service.status === 1 && (
                  <Button
                    variant="ghost" size="sm" disabled={isBusy}
                    onClick={() => handleServiceAction("unpauseService")}
                    className="text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-400/10 gap-1"
                  >
                    <PlayCircle className="w-3.5 h-3.5" /> Resume
                  </Button>
                )}
                <Button
                  variant="ghost" size="sm" disabled={isBusy}
                  onClick={() => handleServiceAction("removeService")}
                  className="text-red-400/60 hover:text-red-400 hover:bg-red-400/10 gap-1"
                >
                  {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Remove
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <motion.div
        className="container mx-auto px-4 pt-0 pb-6 max-w-4xl space-y-4"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
      >

        {/* ── Status banners ─────────────────────────────────────────────── */}
        {service.status === 1 && !isMyService && (
          <div className="rounded-[22px] border border-amber-400/20 bg-amber-400/5 px-4 py-3 flex items-center gap-3">
            <PauseCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <p className="text-sm text-amber-300/80">{t("board.service_page.paused_notice")}</p>
          </div>
        )}
        {service.status === 2 && !isMyService && (
          <div className="rounded-[22px] border border-white/10 bg-white/[0.02] px-4 py-3 flex items-center gap-3">
            <Trash2 className="w-4 h-4 text-white/30 flex-shrink-0" />
            <p className="text-sm text-white/40">{t("board.service_page.removed_notice")}</p>
          </div>
        )}

        {/* ── Client request status ───────────────────────────────────────── */}
        {myRequest && (
          <div className={`rounded-[22px] border px-4 py-3 flex items-center justify-between gap-3 ${
            myRequest.status === 0 ? "border-yellow-400/20 bg-yellow-400/5" :
            myRequest.status === 1 ? "border-emerald-400/20 bg-emerald-400/5" :
            "border-white/[0.08] bg-white/[0.03]"
          }`}>
            <div className="flex items-center gap-2.5 min-w-0">
              <CheckCircle className={`w-4 h-4 flex-shrink-0 ${REQUEST_STATUS[myRequest.status]?.color}`} />
              <div className="min-w-0">
                <p className={`text-sm font-medium ${REQUEST_STATUS[myRequest.status]?.color}`}>
                  {t("board.services.your_request", { id: myRequest.id.toString() })}
                  {" · "}{REQUEST_STATUS[myRequest.status]?.label}
                </p>
                <p className="text-xs text-white/35 mt-0.5">{fmtUSDC(myRequest.amount)} USDC</p>
              </div>
            </div>
            {myRequest.status === 1 && myRequest.agreement && myRequest.agreement !== ZERO && (
              <Link href={`/deal/${myRequest.agreement}`} className="flex-shrink-0">
                <Button size="sm" className="gap-1">
                  {t("board.services.deal_btn")} <ExternalLink className="w-3 h-3" />
                </Button>
              </Link>
            )}
            {myRequest.status === 0 && (
              <Button
                size="sm" variant="ghost" onClick={handleCancelRequest} disabled={isCancelling}
                className="flex-shrink-0 text-red-400/60 hover:text-red-400 hover:bg-red-400/10"
              >
                {isCancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("board.services.cancel_request_btn")}
              </Button>
            )}
          </div>
        )}

        {/* ── Main service card ───────────────────────────────────────────── */}
        <div
          className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] p-5"
          style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
        >
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
            <div>
              <p className="text-xs text-white/30 mb-1">{t("board.post_service.field_price")}</p>
              <div className="flex items-center gap-1">
                <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                <span className="font-mono font-semibold text-white">{fmtUSDC(service.price)} USDC</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-white/30 mb-1">{t("board.post_service.field_delivery")}</p>
              <div className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-white/40" />
                <span className="text-white/80">{Number(service.deadlineDays)} days</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-white/30 mb-1">{t("board.service_page.hires_label")}</p>
              <div className="flex items-center gap-1">
                <Users2 className="w-3.5 h-3.5 text-white/40" />
                <span className="text-white/80">{Number(service.hiresCount)}</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-white/30 mb-1">{t("job.region_label")}</p>
              <div className="flex items-center gap-1">
                <Globe className="w-3.5 h-3.5 text-white/40" />
                <span className="text-white/80">{REGION_LABELS[service.region] ?? "—"}</span>
              </div>
            </div>
          </div>

          {/* Executor row */}
          <div className="flex items-center gap-3 mb-5 pb-5 border-b border-white/8">
            <UserAvatar address={service.executor} size={36} link />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-white/30 mb-0.5">{t("common.by")}</p>
              <UserName
                address={service.executor}
                link
                className="text-sm font-medium text-white/80 hover:text-white transition-colors"
              />
            </div>
            {address && !isMyService && (
              <Link href={`/chat/${service.executor}`} className="flex-shrink-0">
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-white/30 hover:text-primary">
                  <MessageCircle className="w-3.5 h-3.5" />
                </Button>
              </Link>
            )}
          </div>

          {/* Description */}
          {displayDesc && (
            <div className="mb-0">
              <p className="text-xs text-white/30 mb-1.5">{t("board.post_service.field_description")}</p>
              <p className="text-sm text-white/70 leading-relaxed whitespace-pre-wrap">{displayDesc}</p>
            </div>
          )}

          {/* Action row — inside card, mirrors job/[id] style */}
          <div className="flex items-center gap-2 mt-5 pt-4 border-t border-white/8">
            <Link href="/board/executor">
              <Button variant="ghost" size="sm" className="text-white/40 hover:text-white/70 gap-1.5">
                ← {t("board.services.title")}
              </Button>
            </Link>

            {canRequest && (
              <Button onClick={() => setRequestModal(true)} disabled={isRequesting} className="gap-1.5 ml-auto">
                {isRequesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                {t("board.services.request_btn")}
              </Button>
            )}

            {!isConnected && service.status === 0 && (
              <Link href="/" className="ml-auto">
                <Button variant="outline" size="sm">{t("common.go_home")}</Button>
              </Link>
            )}
          </div>
        </div>

      </motion.div>
    </>
  );
}
