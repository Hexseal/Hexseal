"use client";

import { useState, useCallback, useEffect, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAccount, useReadContract, useWalletClient, usePublicClient, useWriteContract } from "wagmi";
import { isAddress } from "viem";
import { DIAMOND_ABI, ARBITER_REGISTRY_ABI, AGREEMENT_ABI, CONTRACTS } from "@/config/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2, AlertTriangle, CheckCircle, History, ShieldCheck, Scale,
  UserCheck, UserX, Search, Crown, UserPlus, UserMinus, MessageCircle,
  Coins, Lock,
} from "lucide-react";
import { toast } from "react-hot-toast";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { commitDisputeClaimGasless, claimDisputeGasless, releaseDisputeGasless } from "@/lib/relay";
import { keccak256, encodePacked, parseAbi } from "viem";
import type { Abi, Address, Hex } from "viem";
import { shortAddr } from "@/lib/utils";

// Agreement.Status: 0=CREATED 1=FUNDED 2=ACTIVE 3=COMPLETED 4=DISPUTED 5=RESOLVED 6=REFUNDED
const AGREEMENT_STATUS_DISPUTED = 4;
const TERMINAL = new Set([3, 5, 6]);

const STATUS_KEYS: Record<number, string> = {
  0: "arbiter.status_created", 1: "arbiter.status_funded",  2: "arbiter.status_active",
  3: "arbiter.status_completed", 4: "arbiter.status_disputed", 5: "arbiter.status_resolved",
  6: "arbiter.status_refunded",
};

const HIST_DETAIL_ABI = parseAbi([
  'function getDetails() view returns (address,address,address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint8)',
]);
interface HistDetail { client: string; executor: string; amount: bigint; resolvedAt: bigint; status: number; }

type AgreementRecord = {
  agreement: string; client: string; executor: string;
  amount: bigint; status: number; createdAt: bigint; resolvedAt: bigint;
};

type PendingVerdict = {
  arbiter: string; clientWins: boolean; submittedAt: bigint;
  frozen: boolean; finalized: boolean; overturned: boolean;
};

function fmtUSDC(v: bigint)   { return (Number(v) / 1e6).toFixed(2); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fmtTimeLeft(seconds: bigint | number | undefined, t: (k: any, v?: any) => string): string {
  if (!seconds) return "—";
  const s = Number(BigInt(seconds));
  if (s <= 0) return t("arbiter.time_expired");
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return t("arbiter.time_left_dhm", { d, h });
  if (h > 0) return t("arbiter.time_left_hm", { h, m });
  return t("arbiter.time_left_m", { m });
}

// ─── Tab component ────────────────────────────────────────────────────────────

function Tab({ active, onClick, children, count }: {
  active: boolean; onClick: () => void; children: ReactNode; count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium rounded-[10px] transition-colors flex items-center gap-1.5 flex-shrink-0 ${
        active ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70 hover:bg-white/5"
      }`}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className={`text-[11px] px-1.5 py-0.5 rounded-md font-mono ${
          active ? "bg-white/15 text-white/80" : "bg-white/8 text-white/35"
        }`}>{count}</span>
      )}
    </button>
  );
}

function SectionEmpty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="text-center py-10">
      <div className="w-10 h-10 rounded-[12px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mx-auto mb-3">
        {icon}
      </div>
      <p className="text-sm text-white/30">{text}</p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type TabKey = "disputes" | "mine" | "history" | "manage";

export default function ArbiterPage() {
  const t = useTranslations();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy]           = useState<string | null>(null);
  const [refresh, setRefresh]     = useState(0);
  const [tab, setTab]             = useState<TabKey>("disputes");
  const [historyQ, setHistoryQ]   = useState("");
  const [histDetails, setHistDetails] = useState<Record<string, HistDetail>>({});
  const bump = useCallback(() => setRefresh(k => k + 1), []);

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

  const { data: ownerAddr } = useReadContract({
    address: CONTRACTS.diamond, abi: DIAMOND_ABI as Abi,
    functionName: "owner", query: { enabled: !!address },
  }) as { data: string | undefined };

  const { data: chiefArbiterAddr } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getChiefArbiter", query: { enabled: !!address },
  }) as { data: string | undefined };

  const { data: isArbiter } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "isRegisteredArbiter", args: [address ?? ZERO_ADDR as Address],
    query: { enabled: !!address },
  }) as { data: boolean | undefined };

  const { data: myReward, refetch: refetchReward } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getArbiterReward", args: [address ?? ZERO_ADDR as Address],
    scopeKey: `arbiter-${refresh}`,
    query: { enabled: !!address && !!isArbiter },
  }) as { data: bigint | undefined; refetch: () => void };

  const isOwner       = !!address && !!ownerAddr && ownerAddr.toLowerCase() === address.toLowerCase();
  const isChiefArbiter = !!address && !!chiefArbiterAddr &&
    chiefArbiterAddr !== ZERO_ADDR &&
    chiefArbiterAddr.toLowerCase() === address.toLowerCase();
  const showManage = isOwner || isChiefArbiter;

  const { data: disputed, isLoading: loadingDisputed } = useReadContract({
    address: CONTRACTS.diamond, abi: DIAMOND_ABI as Abi,
    functionName: "getDisputed",
    scopeKey: `arbiter-${refresh}`, query: { gcTime: 0, staleTime: 0 },
  }) as { data: AgreementRecord[] | undefined; isLoading: boolean };

  const { data: myHistory, isLoading: loadingMine } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getArbiterDeals",
    args: [address ?? ZERO_ADDR as Address],
    scopeKey: `arbiter-${refresh}`,
    query: { enabled: !!address, gcTime: 0, staleTime: 0 },
  }) as { data: string[] | undefined; isLoading: boolean };

  useEffect(() => {
    if (!myHistory?.length || !publicClient) return;
    Promise.all(myHistory.map(addr =>
      publicClient.readContract({
        address: addr as `0x${string}`, abi: HIST_DETAIL_ABI, functionName: "getDetails",
      }).then((r: any) => [addr, {
        client: r[0] as string, executor: r[1] as string,
        amount: r[3] as bigint, resolvedAt: r[10] as bigint, status: Number(r[11]),
      }] as const).catch(() => null)
    )).then(pairs => {
      const map: Record<string, HistDetail> = {};
      pairs.forEach(p => { if (p) map[p[0]] = p[1]; });
      setHistDetails(map);
    });
  }, [myHistory, publicClient]);

  const disputedList = disputed ?? [];

  const handleClaim = async (agreement: string) => {
    if (!walletClient || !publicClient || !address) { toast.error(t("common.error")); return; }
    setBusy(agreement);
    try {
      const saltBytes = crypto.getRandomValues(new Uint8Array(32));
      const salt = ("0x" + Array.from(saltBytes).map(b => b.toString(16).padStart(2, "0")).join("")) as Hex;
      const commitment = keccak256(encodePacked(
        ["address", "address", "bytes32"],
        [agreement as Address, address as Address, salt],
      ));
      const commitToast = toast.loading(t("arbiter.claim_step1"));
      const { txHash: commitTx } = await commitDisputeClaimGasless(walletClient, publicClient, commitment);
      toast.loading(t("arbiter.claim_confirming"), { id: commitToast });
      await publicClient.waitForTransactionReceipt({ hash: commitTx as `0x${string}` });
      toast.loading(t("arbiter.claim_step2"), { id: commitToast });
      await claimDisputeGasless(walletClient, publicClient, agreement as Address, salt);
      toast.success(t("arbiter.claim_success"), { id: commitToast });
      bump();
    } catch (err: any) {
      toast.error(err?.message || t("common.error"));
    } finally { setBusy(null); }
  };

  const handleRelease = async (agreement: string) => {
    if (!walletClient || !publicClient) { toast.error(t("common.error")); return; }
    setBusy(agreement);
    try {
      toast(t("arbiter.releasing"));
      await releaseDisputeGasless(walletClient, publicClient, agreement as Address);
      toast.success(t("arbiter.release_success"));
      bump();
    } catch (err: any) {
      toast.error(err?.message || t("common.error"));
    } finally { setBusy(null); }
  };

  // New verdict flow: submitVerdict → auto finalizeVerdict
  const handleSubmitVerdict = async (agreement: string, clientWins: boolean) => {
    if (!publicClient) { toast.error(t("common.error")); return; }
    setBusy(agreement);
    const id = toast.loading(clientWins ? t("arbiter.submitting_refund") : t("arbiter.submitting_pay"));
    try {
      const hash1 = await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "submitVerdict", args: [agreement as Address, clientWins],
      });
      await publicClient.waitForTransactionReceipt({ hash: hash1 });

      toast.loading(t("arbiter.finalizing"), { id });
      const hash2 = await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "finalizeVerdict", args: [agreement as Address],
      });
      await publicClient.waitForTransactionReceipt({ hash: hash2 });

      toast.success(clientWins ? t("arbiter.refund_success") : t("arbiter.pay_success"), { id });
      bump();
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || t("arbiter.resolve_failed"), { id });
    } finally { setBusy(null); }
  };

  // Finalize an already-submitted verdict (e.g. if first attempt failed)
  const handleFinalizeVerdict = async (agreement: string) => {
    if (!publicClient) { toast.error(t("common.error")); return; }
    setBusy(agreement);
    const id = toast.loading(t("arbiter.finalizing"));
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "finalizeVerdict", args: [agreement as Address],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(t("arbiter.pay_success"), { id });
      bump();
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || t("arbiter.resolve_failed"), { id });
    } finally { setBusy(null); }
  };

  const handleWithdraw = async () => {
    if (!publicClient) return;
    setBusy("reward");
    const id = toast.loading(t("arbiter.withdrawing"));
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "withdrawArbiterReward",
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(t("arbiter.reward_withdrawn"), { id });
      refetchReward();
      bump();
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || t("common.error"), { id });
    } finally { setBusy(null); }
  };

  return (
    <div className="mx-auto px-4 py-5 max-w-6xl space-y-4">

      {/* ── Page header ── */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-[14px] bg-white/[0.06] border border-white/[0.06] flex items-center justify-center flex-shrink-0">
          <ShieldCheck className="w-5 h-5 text-white/50" />
        </div>
        <div>
          <h1 className="text-2xl font-bold font-syne leading-tight">{t("arbiter.title")}</h1>
          <p className="text-xs text-white/40 mt-0.5">{t("arbiter.subtitle")}</p>
        </div>
      </div>

      {/* ── Reward strip ── */}
      {isArbiter && myReward !== undefined && myReward > 0n && (
        <div
          className="rounded-[16px] border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-3 flex items-center justify-between gap-3"
          style={{ boxShadow: "0 0 0 1px rgba(16,185,129,0.06) inset" }}
        >
          <div className="flex items-center gap-2.5">
            <Coins className="w-4 h-4 text-emerald-400/70 shrink-0" />
            <div>
              <p className="text-[11px] text-emerald-400/60 uppercase tracking-wider font-semibold">{t("arbiter.reward_title")}</p>
              <p className="text-lg font-bold font-mono text-emerald-300">${fmtUSDC(myReward)} USDC</p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={handleWithdraw}
            disabled={busy === "reward"}
            className="bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/25 shrink-0"
          >
            {busy === "reward" ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            {t("arbiter.withdraw_btn")}
          </Button>
        </div>
      )}

      {/* ── Main panel ── */}
      <div
        className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] overflow-hidden"
        style={{ boxShadow: "0 4px 24px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)" }}
      >
        {/* Tab bar */}
        <div className="flex gap-1 p-2 border-b border-white/[0.06] overflow-x-auto scrollbar-none">
          <Tab active={tab === "disputes"} onClick={() => setTab("disputes")} count={disputedList.length}>
            <AlertTriangle className="w-3.5 h-3.5" />
            {t("arbiter.tab_disputes")}
          </Tab>
          <Tab active={tab === "mine"} onClick={() => setTab("mine")}>
            <Scale className="w-3.5 h-3.5" />
            {t("arbiter.tab_my_cases")}
          </Tab>
          <Tab active={tab === "history"} onClick={() => setTab("history")}>
            <History className="w-3.5 h-3.5" />
            {t("arbiter.tab_history")}
          </Tab>
          {showManage && (
            <Tab active={tab === "manage"} onClick={() => setTab("manage")}>
              <Crown className="w-3.5 h-3.5 text-amber-400" />
              {t("arbiter.tab_manage")}
            </Tab>
          )}
        </div>

        {/* ── Tab content ── */}
        <div className="p-3 sm:p-4">
          <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >

          {/* ── Open Disputes ── */}
          {tab === "disputes" && (
            loadingDisputed ? (
              <div className="flex items-center justify-center py-12 gap-2 text-white/30">
                <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">{t("common.loading")}</span>
              </div>
            ) : disputedList.length === 0 ? (
              <SectionEmpty
                icon={<CheckCircle className="w-5 h-5 text-white/15" />}
                text={t("arbiter.no_disputes")}
              />
            ) : (
              <div className="space-y-3">
                {disputedList.map(rec => (
                  <DisputeCard
                    key={`${rec.agreement}-${refresh}`}
                    rec={rec}
                    myAddress={address}
                    busy={busy}
                    onClaim={handleClaim}
                    onRelease={handleRelease}
                  />
                ))}
              </div>
            )
          )}

          {/* ── My Active Cases ── */}
          {tab === "mine" && (
            loadingMine ? (
              <div className="flex items-center justify-center py-12 gap-2 text-white/30">
                <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">{t("common.loading")}</span>
              </div>
            ) : !myHistory || myHistory.length === 0 ? (
              <SectionEmpty
                icon={<Scale className="w-5 h-5 text-white/15" />}
                text={t("arbiter.no_cases")}
              />
            ) : (
              <div className="space-y-3">
                {myHistory.map(addr => (
                  <MyCaseCard
                    key={`${addr}-${refresh}`}
                    agreement={addr}
                    myAddress={address}
                    busy={busy}
                    onRelease={handleRelease}
                    onSubmitVerdict={handleSubmitVerdict}
                    onFinalizeVerdict={handleFinalizeVerdict}
                  />
                ))}
              </div>
            )
          )}

          {/* ── History ── */}
          {tab === "history" && (
            loadingMine ? (
              <div className="flex items-center justify-center py-12 gap-2 text-white/30">
                <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">{t("common.loading")}</span>
              </div>
            ) : !myHistory || myHistory.length === 0 ? (
              <SectionEmpty
                icon={<History className="w-5 h-5 text-white/15" />}
                text={t("arbiter.no_history")}
              />
            ) : (
              <>
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
                  <Input
                    placeholder={t("arbiter.search_placeholder")}
                    value={historyQ}
                    onChange={e => setHistoryQ(e.target.value)}
                    className="pl-9 bg-transparent border-white/[0.08] placeholder:text-white/20 rounded-[14px] text-sm"
                  />
                </div>
                <p className="text-xs text-white/25 font-mono mb-3">{t("arbiter.total_cases", { count: myHistory.length })}</p>
                <div>
                  {myHistory
                    .filter(addr => {
                      if (!historyQ) return true;
                      const q = historyQ.toLowerCase();
                      const d = histDetails[addr];
                      return addr.toLowerCase().includes(q) ||
                        d?.client.toLowerCase().includes(q) ||
                        d?.executor.toLowerCase().includes(q);
                    })
                    .map(addr => (
                      <HistoryRow key={`${addr}-${refresh}`} agreement={addr} prefetched={histDetails[addr]} />
                    ))
                  }
                </div>
              </>
            )
          )}

          {/* ── Manage ── */}
          {tab === "manage" && showManage && <ManagePanel isOwner={isOwner} />}

          </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// ─── DisputeCard ─────────────────────────────────────────────────────────────

function DisputeCard({
  rec, myAddress, busy, onClaim, onRelease,
}: {
  rec: AgreementRecord; myAddress?: string;
  busy: string | null; onClaim: (a: string) => void; onRelease: (a: string) => void;
}) {
  const t = useTranslations();
  const { data: claimer } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getDisputeClaimer", args: [rec.agreement as Address],
  }) as { data: string | undefined };

  const { data: timeLeft } = useReadContract({
    address: rec.agreement as Address, abi: AGREEMENT_ABI as Abi,
    functionName: "arbiterTimeLeft",
  }) as { data: bigint | undefined };

  const [disputeReason, setDisputeReason] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/dispute-reason?agreement=${rec.agreement.toLowerCase()}`)
      .then(r => r.json())
      .then((d: { reason?: string | null }) => { if (d.reason) setDisputeReason(d.reason); })
      .catch(() => {});
  }, [rec.agreement]);

  const ZERO = "0x0000000000000000000000000000000000000000";
  const isClaimed   = claimer && claimer !== ZERO;
  const isMineClaim = isClaimed && claimer?.toLowerCase() === myAddress?.toLowerCase();
  const isBusy      = busy === rec.agreement;
  const urgent      = timeLeft !== undefined && timeLeft > 0n && Number(timeLeft) < 86400;

  return (
    <div
      className="rounded-[18px] border border-white/[0.07] bg-white/[0.02] overflow-hidden"
      style={{ boxShadow: "0 1px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.025)" }}
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <Link href={`/deal/${rec.agreement}`} className="font-mono text-sm text-primary hover:underline">
            {shortAddr(rec.agreement)}
          </Link>
          {isClaimed ? (
            <Badge variant="secondary" className="text-[11px] h-5 px-1.5">
              {isMineClaim ? t("arbiter.claimed_by_you") : t("arbiter.claimed_by", { address: shortAddr(claimer!) })}
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-[11px] h-5 px-1.5">{t("arbiter.unclaimed")}</Badge>
          )}
          {timeLeft !== undefined && timeLeft > 0n && (
            <span className={`text-xs font-mono ${urgent ? "text-red-400" : "text-orange-400"}`}>
              {fmtTimeLeft(timeLeft, t)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/40">
          <span>{t("arbiter.client_label")} <span className="font-mono text-white/55">{shortAddr(rec.client)}</span></span>
          <span>{t("arbiter.executor_label")} <span className="font-mono text-white/55">{shortAddr(rec.executor)}</span></span>
          <span className="font-mono text-emerald-400/70">${fmtUSDC(rec.amount)} USDC</span>
        </div>
      </div>

      {disputeReason ? (
        <div className="mx-3 mb-3 rounded-[12px] border border-red-500/20 bg-red-500/[0.04] px-3 py-2.5">
          <p className="text-[10px] text-red-400/60 font-semibold uppercase tracking-wider mb-1">
            {t("arbiter.dispute_reason_title")}
          </p>
          <p className="text-xs text-white/65 leading-relaxed">{disputeReason}</p>
        </div>
      ) : (
        <p className="text-xs text-white/20 px-4 pb-3 italic">{t("arbiter.no_reason")}</p>
      )}

      <div className="px-3 pb-3 flex items-center gap-3">
        {!isClaimed && (
          <p className="text-[11px] text-white/25 leading-tight flex-1">{t("arbiter.claim_hint")}</p>
        )}
        <div className="flex gap-2 ml-auto">
          {!isClaimed && (
            <Button size="sm" onClick={() => onClaim(rec.agreement)} disabled={!!busy}>
              {isBusy ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
              {t("arbiter.claim_btn")}
            </Button>
          )}
          {isMineClaim && (
            <Button size="sm" variant="outline" onClick={() => onRelease(rec.agreement)} disabled={!!busy}
              className="border-white/15 text-white/60 hover:text-white hover:border-white/30">
              {isBusy ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
              {t("arbiter.release_btn")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── DisputeLog ───────────────────────────────────────────────────────────────

const RELAYER_URL_ARB = process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001';
type LogEntry = { ts: number; from: string; text: string; dealId: string | null };

// Module-level cache, keyed by dealId — survives DisputeLog remounting. The parent
// page bakes a single page-wide `refresh` counter into every card's React key so
// ANY action anywhere on the page (release, submit/finalize verdict, withdraw
// reward — not just an action on this specific case) remounts every card,
// including this one, collapsing an already-fetched log back to its "View
// history" button. Without this cache, re-viewing it demands a brand-new
// hexseal:dispute-log:... signature caused by unrelated page activity rather
// than the arbiter's own intent to re-view.
const _disputeLogCache = new Map<string, LogEntry[]>();

function DisputeLog({ dealId, client, executor }: { dealId: string; client?: string; executor?: string }) {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const [entries, setEntries] = useState<LogEntry[] | null>(() => _disputeLogCache.get(dealId) ?? null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);
  const t = useTranslations();

  const fetchLog = async () => {
    if (!walletClient || !address) return;
    setLoading(true); setErr(null);
    try {
      const ts = String(Math.floor(Date.now() / 1000));
      const message = `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`;
      const sig = await walletClient.signMessage({ account: address, message });
      const res = await fetch(`${RELAYER_URL_ARB}/dispute-log/${dealId}`, {
        headers: { 'x-ts': ts, 'x-sig': sig },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { entries: LogEntry[] };
      _disputeLogCache.set(dealId, data.entries ?? []);
      setEntries(data.entries ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    } finally { setLoading(false); }
  };

  const roleOf = (from: string): 'client' | 'executor' | 'bot' => {
    const f = from.toLowerCase();
    if (client && f === client.toLowerCase()) return 'client';
    if (executor && f === executor.toLowerCase()) return 'executor';
    return 'bot';
  };

  if (entries === null) {
    // `err` can only ever be set while entries is still null — a failed fetchLog()
    // never populates entries, so the (err) branch that used to follow this one was
    // unreachable dead code: on failure, the button just silently reverted to idle
    // with zero explanation, including for a signature that arrived too late for the
    // server's 5-minute replay window. Render the error alongside the (still
    // clickable, to retry) button instead of only after it.
    return (
      <div className="space-y-1">
        <button
          onClick={fetchLog}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-xs font-medium border border-white/15 text-white/50 hover:bg-white/[0.06] transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <MessageCircle className="w-3 h-3" />}
          {t("arbiter.view_history_btn")}
        </button>
        {err && (
          <p className="text-xs text-red-400/70 px-1">
            {err.toLowerCase().includes('timestamp out of window')
              ? t("arbiter.dispute_log_sign_timeout")
              : err}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-1 rounded-[14px] border border-white/[0.07] bg-[#080809] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05]">
        <div className="flex items-center gap-2">
          <MessageCircle className="w-3.5 h-3.5 text-white/25" />
          <span className="text-[11px] text-white/35 font-medium">{t("arbiter.view_history_btn")}</span>
          {entries.length > 0 && <span className="text-[10px] text-white/20 font-mono">{entries.length}</span>}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/20">
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sky-400/60 inline-block" />{t("arbiter.client_label")}</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-violet-400/60 inline-block" />{t("arbiter.executor_label")}</span>
        </div>
        <button onClick={() => setEntries(null)} className="text-white/20 hover:text-white/50 transition-colors text-[10px]">✕</button>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-white/25 px-3 py-4 italic text-center">{t("arbiter.no_history_log")}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto px-3 py-3 space-y-2 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.08)_transparent]">
          {entries.map((e, i) => {
            const role = roleOf(e.from);
            const time = new Date(e.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
            // Entries whose deal_ctx tag doesn't match the deal being viewed are
            // context from another deal (or from before any deal existed) between
            // this same pair — shown, but visually de-emphasized and labeled.
            const isOtherContext = (e.dealId ?? '').toLowerCase() !== dealId.toLowerCase();
            const contextLabel = !isOtherContext ? null
              : e.dealId ? `#${e.dealId.slice(2, 8).toUpperCase()}`
              : t("arbiter.general_chat_label");
            if (role === 'bot') {
              return (
                <div key={i} className="flex justify-center">
                  <span className="text-[10px] text-white/20 italic px-2">{e.text} · {time}</span>
                </div>
              );
            }
            const isClient = role === 'client';
            return (
              <div key={i} className={`flex flex-col gap-0.5 ${isClient ? 'items-start' : 'items-end'} ${isOtherContext ? 'opacity-40' : ''}`}>
                <span className={`text-[10px] font-medium px-0.5 ${isClient ? 'text-sky-400/50' : 'text-violet-400/50'}`}>
                  {isClient ? t("arbiter.client_label") : t("arbiter.executor_label")}
                  {' · '}<span className="font-mono font-normal">{e.from.slice(0, 6)}…{e.from.slice(-4)}</span>
                </span>
                <div className={`max-w-[85%] rounded-[10px] px-3 py-2 text-xs leading-relaxed ${
                  isClient
                    ? 'bg-sky-500/[0.08] border border-sky-500/15 text-white/80 rounded-tl-[3px]'
                    : 'bg-violet-500/[0.08] border border-violet-500/15 text-white/80 rounded-tr-[3px]'
                }`}>{e.text}</div>
                <span className="text-[10px] text-white/15 px-0.5">
                  {time}{contextLabel && <span className="ml-1 text-white/25">· {contextLabel}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── MyCaseCard ───────────────────────────────────────────────────────────────

function MyCaseCard({
  agreement, myAddress, busy, onRelease, onSubmitVerdict, onFinalizeVerdict,
}: {
  agreement: string; myAddress?: string; busy: string | null;
  onRelease: (a: string) => void;
  onSubmitVerdict: (a: string, clientWins: boolean) => void;
  onFinalizeVerdict: (a: string) => void;
}) {
  const t = useTranslations();
  const MINI_ABI = [
    { inputs: [], name: "status",          outputs: [{ internalType: "uint8",   name: "", type: "uint8" }],   stateMutability: "view", type: "function" },
    { inputs: [], name: "amount",          outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "client",          outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "executor",        outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "arbiterTimeLeft", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "disputedAt",      outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  ] as const;

  const { data: statusVal  } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "status" })          as { data: number  | undefined };
  const { data: amount     } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "amount" })          as { data: bigint  | undefined };
  const { data: client     } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "client" })          as { data: string  | undefined };
  const { data: executor   } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "executor" })        as { data: string  | undefined };
  const { data: timeLeft   } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "arbiterTimeLeft" }) as { data: bigint  | undefined };
  const { data: disputedAt } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "disputedAt" })      as { data: bigint  | undefined };

  const { data: claimer } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getDisputeClaimer", args: [agreement as Address],
  }) as { data: string | undefined };

  const { data: pendingVerdict } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getPendingVerdict", args: [agreement as Address],
  }) as { data: PendingVerdict | undefined };

  const [disputeReason, setDisputeReason] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/dispute-reason?agreement=${agreement.toLowerCase()}`)
      .then(r => r.json())
      .then((d: { reason?: string | null }) => { if (d.reason) setDisputeReason(d.reason); })
      .catch(() => {});
  }, [agreement]);

  const ZERO        = "0x0000000000000000000000000000000000000000";
  const isDisputed  = statusVal === AGREEMENT_STATUS_DISPUTED;
  const isTerminal  = statusVal !== undefined && TERMINAL.has(statusVal);
  const isMineClaim = claimer?.toLowerCase() === myAddress?.toLowerCase() && claimer !== ZERO;
  const isBusy      = busy === agreement;
  const expired     = timeLeft !== undefined && timeLeft === 0n && disputedAt && disputedAt > 0n;
  const urgent      = timeLeft !== undefined && timeLeft > 0n && Number(timeLeft) < 86400;

  // Verdict state
  const hasVerdict   = pendingVerdict && pendingVerdict.submittedAt > 0n;
  const verdictReady = hasVerdict && !pendingVerdict!.finalized && !pendingVerdict!.frozen;
  const verdictFrozen = hasVerdict && pendingVerdict!.frozen && !pendingVerdict!.finalized;

  if (!isMineClaim && !isDisputed) return null;
  if (isTerminal) return null;

  const statusLabel = statusVal !== undefined ? t(STATUS_KEYS[statusVal] ?? "arbiter.status_unknown") : "…";

  return (
    <div
      className="rounded-[18px] border border-white/[0.07] bg-white/[0.02] overflow-hidden"
      style={{ boxShadow: "0 1px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.025)" }}
    >
      {/* Case info */}
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/deal/${agreement}`} className="font-mono text-sm text-primary hover:underline">
              {shortAddr(agreement)}
            </Link>
            <Badge variant={isDisputed ? "destructive" : "secondary"} className="text-[11px] h-5 px-1.5">
              {statusLabel}
            </Badge>
            {timeLeft !== undefined && timeLeft > 0n && (
              <span className={`text-xs font-mono ${urgent ? "text-red-400" : "text-orange-400"}`}>
                {fmtTimeLeft(timeLeft, t)}
              </span>
            )}
            {expired && (
              <span className="text-xs font-semibold text-red-400">{t("arbiter.window_expired")}</span>
            )}
          </div>
          <Link href={`/deal/${agreement}`}>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-white/40 hover:text-white shrink-0">
              {t("common.details")}
            </Button>
          </Link>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/40 mt-2">
          <span>{t("arbiter.client_label")} <span className="font-mono text-white/55">{client ? shortAddr(client) : "…"}</span></span>
          <span>{t("arbiter.executor_label")} <span className="font-mono text-white/55">{executor ? shortAddr(executor) : "…"}</span></span>
          <span className="font-mono text-emerald-400/70">${amount ? fmtUSDC(amount) : "…"} USDC</span>
          {disputedAt && disputedAt > 0n && (
            <span>{new Date(Number(disputedAt) * 1000).toLocaleString()}</span>
          )}
        </div>
      </div>

      {/* Dispute reason */}
      {disputeReason ? (
        <div className="mx-3 mb-3 rounded-[12px] border border-red-500/20 bg-red-500/[0.04] px-3 py-2.5">
          <p className="text-[10px] text-red-400/60 font-semibold uppercase tracking-wider mb-1">
            {t("arbiter.dispute_reason_title")}
          </p>
          <p className="text-xs text-white/65 leading-relaxed">{disputeReason}</p>
        </div>
      ) : (
        <p className="text-xs text-white/20 px-4 pb-3 italic">{t("arbiter.no_reason")}</p>
      )}

      {/* Communication */}
      {(client || executor) && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {client && (
              <Link href={`/chat?peer=${client.toLowerCase()}`}>
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-xs font-medium border border-sky-500/25 text-sky-400/80 hover:bg-sky-500/[0.12] transition-colors">
                  {t("arbiter.chat_client_btn")}
                </button>
              </Link>
            )}
            {executor && (
              <Link href={`/chat?peer=${executor.toLowerCase()}`}>
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-xs font-medium border border-violet-500/25 text-violet-400/80 hover:bg-violet-500/[0.12] transition-colors">
                  {t("arbiter.chat_executor_btn")}
                </button>
              </Link>
            )}
          </div>
          <DisputeLog dealId={agreement} client={client ?? undefined} executor={executor ?? undefined} />
        </div>
      )}

      {/* Verdict panel */}
      {isDisputed && isMineClaim && (
        <div className="mx-3 mb-3 rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] p-3 space-y-3">

          {/* FROZEN state */}
          {verdictFrozen && (
            <div className="flex items-center gap-2 py-2">
              <Lock className="w-4 h-4 text-amber-400/70 shrink-0" />
              <p className="text-xs text-amber-400/80">{t("arbiter.verdict_frozen")}</p>
            </div>
          )}

          {/* PENDING finalization state */}
          {verdictReady && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                <p className="text-xs text-white/50">{t("arbiter.verdict_pending")}</p>
                <span className="text-[10px] font-mono text-white/25 ml-auto">
                  {pendingVerdict!.clientWins ? t("arbiter.refund_client_btn") : t("arbiter.pay_executor_btn")}
                </span>
              </div>
              <button
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-[10px] text-xs font-semibold border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40"
                disabled={!!busy}
                onClick={() => onFinalizeVerdict(agreement)}
              >
                {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                {t("arbiter.finalize_btn")}
              </button>
            </div>
          )}

          {/* VERDICT SUBMIT state (no verdict yet, not expired) */}
          {!hasVerdict && !expired && (
            <>
              <div className="flex items-center gap-2">
                <Scale className="w-3.5 h-3.5 text-white/30 shrink-0" />
                <p className="text-xs font-semibold text-white/50">{t("arbiter.resolve_hint")}</p>
                <span className="text-[10px] text-red-400/55 ml-auto">{t("arbiter.resolve_irreversible")}</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-[10px] border border-sky-500/20 bg-sky-500/[0.05] px-3 py-2.5">
                  <p className="text-[11px] font-semibold text-sky-400/90 mb-1">{t("arbiter.refund_client_btn")}</p>
                  <p className="text-[10px] text-white/35 leading-relaxed">{t("arbiter.resolve_client_desc")}</p>
                </div>
                <div className="rounded-[10px] border border-violet-500/20 bg-violet-500/[0.05] px-3 py-2.5">
                  <p className="text-[11px] font-semibold text-violet-400/90 mb-1">{t("arbiter.pay_executor_btn")}</p>
                  <p className="text-[10px] text-white/35 leading-relaxed">{t("arbiter.resolve_executor_desc")}</p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-[10px] text-xs font-semibold border border-sky-500/30 text-sky-400 hover:bg-sky-500/10 transition-colors disabled:opacity-40"
                  disabled={!!busy}
                  onClick={() => onSubmitVerdict(agreement, true)}
                >
                  {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCheck className="w-3.5 h-3.5" />}
                  {t("arbiter.refund_client_btn")}
                </button>
                <button
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-[10px] text-xs font-semibold border border-violet-500/30 text-violet-400 hover:bg-violet-500/10 transition-colors disabled:opacity-40"
                  disabled={!!busy}
                  onClick={() => onSubmitVerdict(agreement, false)}
                >
                  {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserX className="w-3.5 h-3.5" />}
                  {t("arbiter.pay_executor_btn")}
                </button>
              </div>

              <button
                className="w-full text-xs text-white/25 hover:text-white/50 transition-colors py-0.5"
                disabled={!!busy}
                onClick={() => onRelease(agreement)}
              >
                {t("arbiter.release_claim_btn")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── HistoryRow ───────────────────────────────────────────────────────────────

function HistoryRow({ agreement, prefetched }: { agreement: string; prefetched?: HistDetail }) {
  const t = useTranslations();
  const skip = prefetched !== undefined;
  const MINI_ABI = [
    { inputs: [], name: "status",     outputs: [{ internalType: "uint8",   name: "", type: "uint8" }],   stateMutability: "view", type: "function" },
    { inputs: [], name: "amount",     outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "resolvedAt", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  ] as const;

  const { data: statusRaw     } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "status",     query: { enabled: !skip } }) as { data: number  | undefined };
  const { data: amountRaw     } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "amount",     query: { enabled: !skip } }) as { data: bigint  | undefined };
  const { data: resolvedAtRaw } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "resolvedAt", query: { enabled: !skip } }) as { data: bigint  | undefined };

  const statusVal  = skip ? prefetched.status     : (statusRaw !== undefined ? Number(statusRaw) : undefined);
  const amount     = skip ? prefetched.amount     : amountRaw;
  const resolvedAt = skip ? prefetched.resolvedAt : resolvedAtRaw;

  if (statusVal === undefined || !TERMINAL.has(statusVal)) return null;

  const isResolved = statusVal === 5;
  const isRefunded = statusVal === 6;
  const verdictLabel = isResolved ? t("arbiter.verdict_executor_paid")
    : isRefunded ? t("arbiter.verdict_client_refunded")
    : (t(STATUS_KEYS[statusVal] ?? "arbiter.status_unknown"));
  const verdictCls = isResolved ? "border-violet-500/30 text-violet-400"
    : isRefunded ? "border-sky-500/30 text-sky-400"
    : "border-white/15 text-white/40";

  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/[0.04] last:border-0">
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        <Link href={`/deal/${agreement}`} className="font-mono text-sm text-primary hover:underline shrink-0">
          {shortAddr(agreement)}
        </Link>
        <Badge variant="outline" className={`text-[11px] h-5 px-1.5 ${verdictCls}`}>
          {verdictLabel}
        </Badge>
        <span className="text-xs text-white/35 font-mono shrink-0">
          ${amount ? fmtUSDC(amount) : "…"}
        </span>
        {resolvedAt && resolvedAt > 0n && (
          <span className="text-[11px] text-white/20 shrink-0">
            {new Date(Number(resolvedAt) * 1000).toLocaleDateString()}
          </span>
        )}
      </div>
      <Link href={`/deal/${agreement}`}>
        <Button size="sm" variant="ghost" className="h-6 text-xs px-2 shrink-0 text-white/35 hover:text-white">
          {t("common.open")}
        </Button>
      </Link>
    </div>
  );
}

// ─── ManagePanel ─────────────────────────────────────────────────────────────

function ManagePanel({ isOwner }: { isOwner: boolean }) {
  const t = useTranslations();
  const { data: arbiters, refetch } = useReadContract({
    address: CONTRACTS.diamond as Address,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getArbiters",
  }) as { data: string[] | undefined; refetch: () => void };

  const { writeContractAsync, isPending } = useWriteContract();
  const [newArbiter,   setNewArbiter]   = useState("");
  const [removingAddr, setRemovingAddr] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!isAddress(newArbiter)) { toast.error(t("profile.invalid_address")); return; }
    try {
      await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "addArbiter", args: [newArbiter as Address], gas: BigInt(120_000),
      });
      toast.success(t("arbiter.added_success"));
      setNewArbiter("");
      refetch();
    } catch (err: any) { toast.error(err?.shortMessage || err?.message || t("common.error")); }
  };

  const handleRemove = async (addr: string) => {
    setRemovingAddr(addr);
    try {
      await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "removeArbiter", args: [addr as Address], gas: BigInt(120_000),
      });
      toast.success(t("arbiter.removed_success"));
      refetch();
    } catch (err: any) { toast.error(err?.shortMessage || err?.message || t("common.error")); }
    finally { setRemovingAddr(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Crown className="w-4 h-4 text-amber-400 shrink-0" />
        <p className="text-sm font-semibold text-white/70">{t("arbiter.manage_title")}</p>
      </div>
      <p className="text-xs text-white/35 -mt-2">{t("arbiter.chief_desc")}</p>

      {!arbiters || arbiters.length === 0 ? (
        <p className="text-sm text-white/30 py-4 text-center">{t("arbiter.no_arbiters")}</p>
      ) : (
        <div className="space-y-2">
          {arbiters.map(addr => (
            <div key={addr} className="flex items-center justify-between gap-3 rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] px-3 py-2.5">
              <span className="font-mono text-xs text-white/60 truncate">{addr}</span>
              {isOwner && (
                <button
                  className="flex items-center gap-1 text-xs text-red-400/60 hover:text-red-400 transition-colors shrink-0 disabled:opacity-40"
                  disabled={removingAddr === addr || isPending}
                  onClick={() => handleRemove(addr)}
                >
                  {removingAddr === addr
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <UserMinus className="w-3.5 h-3.5" />}
                  {t("arbiter.remove_btn")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {isOwner && (
        <>
          <div className="h-px bg-white/[0.06]" />
          <div className="space-y-2">
            <Label className="text-xs text-white/40 uppercase tracking-wider">{t("arbiter.add_arbiter")}</Label>
            <div className="flex gap-2">
              <Input
                placeholder="0x..."
                value={newArbiter}
                onChange={e => setNewArbiter(e.target.value)}
                className="font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]"
              />
              <Button onClick={handleAdd} disabled={isPending || !newArbiter} className="gap-1 shrink-0">
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                {t("arbiter.add_btn")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
