"use client";

import { useState, useCallback, useEffect } from "react";
import { useAccount, useReadContract, useWalletClient, usePublicClient, useWriteContract } from "wagmi";
import { isAddress } from "viem";
import { DIAMOND_ABI, ARBITER_REGISTRY_ABI, AGREEMENT_ABI, CONTRACTS } from "@/config/contracts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Loader2, AlertTriangle, CheckCircle, History, ShieldCheck, Scale, UserCheck, UserX, MessageSquare, Search,
  Crown, UserPlus, UserMinus,
} from "lucide-react";
import { toast } from "react-hot-toast";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { commitDisputeClaimGasless, claimDisputeGasless, releaseDisputeGasless, sendAgreementGasless } from "@/lib/relay";
import { keccak256, encodePacked, parseAbi } from "viem";
import type { Abi, Address, Hex } from "viem";

// Agreement.Status (on-chain): 0=CREATED 1=FUNDED 2=ACTIVE 3=COMPLETED 4=DISPUTED 5=RESOLVED 6=REFUNDED
// RegistryStorage.AgreementStatus: 0=ACTIVE 1=COMPLETED 2=REFUNDED 3=DISPUTED 4=RESOLVED
// getDisputed() returns registry records — status field is registry enum (DISPUTED=3)
// MyCaseRow reads status from Agreement contract directly — uses Agreement enum (DISPUTED=4)
const AGREEMENT_STATUS_DISPUTED = 4;
const TERMINAL = new Set([3, 5, 6]);

const STATUS_KEYS: Record<number, string> = {
  0: "arbiter.status_created", 1: "arbiter.status_funded", 2: "arbiter.status_active",
  3: "arbiter.status_completed", 4: "arbiter.status_disputed", 5: "arbiter.status_resolved",
  6: "arbiter.status_refunded",
};

const HIST_DETAIL_ABI = parseAbi([
  'function getDetails() view returns (address,address,address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint8)',
]);
interface HistDetail { client: string; executor: string; amount: bigint; resolvedAt: bigint; status: number; }

type AgreementRecord = {
  agreement: string;
  client: string;
  executor: string;
  amount: bigint;
  status: number;
  createdAt: bigint;
  resolvedAt: bigint;
};

function shortAddr(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }
function fmtUSDC(v: bigint)   { return (Number(v) / 1e6).toFixed(2); }

function fmtTimeLeft(seconds: bigint | number | undefined): string {
  if (!seconds) return "—";
  const s = Number(BigInt(seconds));
  if (s <= 0) return "Expired";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ArbiterPage() {
  const t = useTranslations();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [historyQ, setHistoryQ] = useState('');
  const [histDetails, setHistDetails] = useState<Record<string, HistDetail>>({});
  const bump = useCallback(() => setRefresh(k => k + 1), []);

  const { data: chiefArbiterAddr } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'getChiefArbiter',
    query: { enabled: !!address },
  }) as { data: string | undefined };

  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const isChiefArbiter = !!address && !!chiefArbiterAddr &&
    chiefArbiterAddr !== ZERO_ADDR &&
    chiefArbiterAddr.toLowerCase() === address.toLowerCase();

  // All disputed deals (from Diamond Registry)
  const { data: disputed, isLoading: loadingDisputed } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI as Abi,
    functionName: "getDisputed",
    scopeKey: `arbiter-${refresh}`,
    query: { gcTime: 0, staleTime: 0 },
  }) as { data: AgreementRecord[] | undefined; isLoading: boolean };

  // All deals this arbiter ever claimed (historical + active)
  const { data: myHistory, isLoading: loadingMine } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getArbiterDeals",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    scopeKey: `arbiter-${refresh}`,
    query: { enabled: !!address, gcTime: 0, staleTime: 0 },
  }) as { data: string[] | undefined; isLoading: boolean };

  // Pre-load details for all history deals so we can filter by client/executor
  useEffect(() => {
    if (!myHistory?.length || !publicClient) return;
    Promise.all(myHistory.map(addr =>
      publicClient.readContract({
        address: addr as `0x${string}`,
        abi: HIST_DETAIL_ABI,
        functionName: 'getDetails',
      }).then((r: any) => [addr, {
        client:     r[0] as string,
        executor:   r[1] as string,
        amount:     r[3] as bigint,
        resolvedAt: r[10] as bigint,
        status:     Number(r[11]),
      }] as const).catch(() => null)
    )).then(pairs => {
      const map: Record<string, HistDetail> = {};
      pairs.forEach(p => { if (p) map[p[0]] = p[1]; });
      setHistDetails(map);
    });
  }, [myHistory, publicClient]);

  // getDisputed() already returns only DISPUTED registry records (status=3 in registry enum)
  // No secondary filter needed — all returned records are disputed
  const disputedList = disputed ?? [];

  const handleClaim = async (agreement: string) => {
    if (!walletClient || !publicClient || !address) { toast.error(t("common.error")); return; }
    setBusy(agreement);
    try {
      // Step 1/2 — генерируем случайный salt, коммитим хеш (защита от фронтраннинга)
      const saltBytes = crypto.getRandomValues(new Uint8Array(32));
      const salt = ('0x' + Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('')) as Hex;
      const commitment = keccak256(encodePacked(
        ['address', 'address', 'bytes32'],
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

  const handleResolve = async (agreement: string, clientWins: boolean) => {
    if (!walletClient || !publicClient) { toast.error(t("common.error")); return; }
    setBusy(agreement);
    try {
      toast(clientWins ? t("arbiter.resolving_refund") : t("arbiter.resolving_pay"));
      await sendAgreementGasless(
        walletClient, publicClient,
        agreement as Address,
        "resolveDispute",
        AGREEMENT_ABI as Abi,
        [clientWins],
      );
      toast.success(clientWins ? t("arbiter.refund_success") : t("arbiter.pay_success"));
      bump();
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || t("arbiter.resolve_failed"));
    } finally { setBusy(null); }
  };

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold font-mono mb-2 flex items-center gap-2">
          <ShieldCheck className="w-8 h-8" />
          {t("arbiter.title")}
        </h1>
        <p className="text-muted-foreground">
          {t("arbiter.subtitle")}
        </p>
      </div>

      <Tabs defaultValue="disputes">
        <div className="overflow-x-auto scrollbar-none mb-6 -mx-4 px-4">
          <TabsList className="min-w-max">
          <TabsTrigger value="disputes" className="flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4" />
            {t("arbiter.tab_disputes")}
            {disputedList.length > 0 && (
              <Badge variant="destructive" className="ml-1 text-xs px-1.5 py-0">
                {disputedList.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="mine" className="flex items-center gap-1.5">
            <Scale className="w-4 h-4" />
            {t("arbiter.tab_my_cases")}
          </TabsTrigger>
          <TabsTrigger value="history" className="flex items-center gap-1.5">
            <History className="w-4 h-4" />
            {t("arbiter.tab_history")}
          </TabsTrigger>
          {isChiefArbiter && (
            <TabsTrigger value="manage" className="flex items-center gap-1.5 text-amber-400 data-[state=active]:text-amber-400">
              <Crown className="w-4 h-4" />
              {t("arbiter.tab_manage")}
            </TabsTrigger>
          )}
        </TabsList>
        </div>

        {/* ── Open Disputes ──────────────────────────────────────────────── */}
        <TabsContent value="disputes">
          <Card>
            <CardHeader>
              <CardTitle className="font-mono text-base">{t("arbiter.tab_disputes")}</CardTitle>
              <CardDescription>
                {t("arbiter.disputes_desc")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingDisputed ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : disputedList.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-500 opacity-40" />
                  {t("arbiter.no_disputes")}
                </div>
              ) : (
                disputedList.map(rec => (
                  <DisputeRow
                    key={`${rec.agreement}-${refresh}`}
                    rec={rec}
                    myAddress={address}
                    busy={busy}
                    onClaim={handleClaim}
                    onRelease={handleRelease}
                  />
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── My Cases (claimed + active) ────────────────────────────────── */}
        <TabsContent value="mine">
          <Card>
            <CardHeader>
              <CardTitle className="font-mono text-base">{t("arbiter.my_cases_title")}</CardTitle>
              <CardDescription>
                {t("arbiter.my_cases_desc")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingMine ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : !myHistory || myHistory.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground">
                  {t("arbiter.no_cases")}
                </p>
              ) : (
                myHistory.map(addr => (
                  <MyCaseRow
                    key={`${addr}-${refresh}`}
                    agreement={addr}
                    myAddress={address}
                    busy={busy}
                    onRelease={handleRelease}
                    onResolve={handleResolve}
                  />
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── History ───────────────────────────────────────────────────── */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle className="font-mono text-base">{t("arbiter.history_title")}</CardTitle>
              <CardDescription>
                {t("arbiter.history_desc")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingMine ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : !myHistory || myHistory.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground">{t("arbiter.no_history")}</p>
              ) : (
                <>
                  <div className="relative mb-4">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
                    <Input
                      placeholder={t("arbiter.search_placeholder")}
                      value={historyQ}
                      onChange={e => setHistoryQ(e.target.value)}
                      className="pl-9 bg-white/[0.03] border-white/10 placeholder:text-white/25 rounded-xl text-sm"
                    />
                  </div>
                  <p className="text-xs text-white/30 font-mono mb-3">{t("arbiter.total_cases", { count: myHistory.length })}</p>
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
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Manage (chief arbiter only) ────────────────────────────────── */}
        {isChiefArbiter && (
          <TabsContent value="manage">
            <ChiefManagePanel />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ─── ChiefManagePanel — add/remove arbiters (chief arbiter role) ──────────────

function ChiefManagePanel() {
  const t = useTranslations();
  const { data: arbiters, refetch } = useReadContract({
    address: CONTRACTS.diamond as Address,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'getArbiters',
  }) as { data: string[] | undefined; refetch: () => void };

  const { writeContract, isPending } = useWriteContract();
  const [newArbiter,   setNewArbiter]   = useState('');
  const [removingAddr, setRemovingAddr] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!isAddress(newArbiter)) { toast.error(t("profile.invalid_address")); return; }
    try {
      await writeContract({
        address: CONTRACTS.diamond as Address,
        abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: 'addArbiter',
        args: [newArbiter as Address],
        gas: BigInt(120_000),
      });
      toast.success(t("arbiter.added_success"));
      setNewArbiter('');
      refetch();
    } catch (err: any) { toast.error(err?.shortMessage || err?.message || t("common.error")); }
  };

  const handleRemove = async (addr: string) => {
    setRemovingAddr(addr);
    try {
      await writeContract({
        address: CONTRACTS.diamond as Address,
        abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: 'removeArbiter',
        args: [addr as Address],
        gas: BigInt(120_000),
      });
      toast.success(t("arbiter.removed_success"));
      refetch();
    } catch (err: any) { toast.error(err?.shortMessage || err?.message || t("common.error")); }
    finally { setRemovingAddr(null); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono flex items-center gap-2 text-base">
          <Crown className="w-4 h-4 text-amber-400" />
          {t("arbiter.manage_title")}
        </CardTitle>
        <CardDescription>
          {t("arbiter.chief_desc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!arbiters || arbiters.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("arbiter.no_arbiters")}</p>
        ) : (
          <div className="space-y-2">
            {arbiters.map(addr => (
              <div key={addr} className="flex items-center justify-between gap-3 rounded-md border border-white/10 px-3 py-2">
                <span className="font-mono text-xs text-white/70 truncate">{addr}</span>
                <Button
                  size="sm" variant="ghost"
                  className="h-7 gap-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 shrink-0"
                  disabled={removingAddr === addr || isPending}
                  onClick={() => handleRemove(addr)}
                >
                  {removingAddr === addr
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <UserMinus className="w-3.5 h-3.5" />}
                  {t("arbiter.remove_btn")}
                </Button>
              </div>
            ))}
          </div>
        )}
        <Separator />
        <div className="space-y-2">
          <Label>{t("arbiter.add_arbiter")}</Label>
          <div className="flex gap-2">
            <Input
              placeholder="0x..."
              value={newArbiter}
              onChange={e => setNewArbiter(e.target.value)}
              className="font-mono text-sm"
            />
            <Button onClick={handleAdd} disabled={isPending || !newArbiter} className="gap-1">
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              {t("arbiter.add_btn")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── DisputeRow — unclaimed/claimed dispute (before arbiter takes it) ────────

function DisputeRow({
  rec, myAddress, busy, onClaim, onRelease,
}: {
  rec: AgreementRecord;
  myAddress?: string;
  busy: string | null;
  onClaim: (a: string) => void;
  onRelease: (a: string) => void;
}) {
  const t = useTranslations();
  const { data: claimer } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getDisputeClaimer",
    args: [rec.agreement as Address],
  }) as { data: string | undefined };

  const { data: timeLeft } = useReadContract({
    address: rec.agreement as Address,
    abi: AGREEMENT_ABI as Abi,
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
  const isClaimed = claimer && claimer !== ZERO;
  const isMineClaim = isClaimed && claimer?.toLowerCase() === myAddress?.toLowerCase();
  const isBusy = busy === rec.agreement;

  return (
    <div className="py-4 border-b border-border last:border-0">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/deal/${rec.agreement}`} className="font-mono text-sm text-primary hover:underline">
              {shortAddr(rec.agreement)}
            </Link>
            {isClaimed ? (
              <Badge variant="secondary" className="text-xs">
                {isMineClaim ? t("arbiter.claimed_by_you") : t("arbiter.claimed_by", { address: shortAddr(claimer!) })}
              </Badge>
            ) : (
              <Badge variant="destructive" className="text-xs">{t("arbiter.unclaimed")}</Badge>
            )}
            {timeLeft !== undefined && timeLeft > 0n && (
              <span className={`text-xs font-mono ${Number(timeLeft) < 86400 ? "text-red-400" : "text-orange-400"}`}>
                {fmtTimeLeft(timeLeft)}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3">
            <span>{t("arbiter.client_label")}: <span className="font-mono">{shortAddr(rec.client)}</span></span>
            <span>{t("arbiter.executor_label")}: <span className="font-mono">{shortAddr(rec.executor)}</span></span>
            <span className="text-white/60">${fmtUSDC(rec.amount)} USDC</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 shrink-0 items-end">
          {!isClaimed && (
            <Button size="sm" onClick={() => onClaim(rec.agreement)} disabled={!!busy}>
              {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t("arbiter.claim_btn")}
            </Button>
          )}
          {isMineClaim && (
            <Button size="sm" variant="outline" onClick={() => onRelease(rec.agreement)} disabled={!!busy}>
              {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t("arbiter.release_btn")}
            </Button>
          )}
        </div>
      </div>

      {/* Dispute reason */}
      {disputeReason ? (
        <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.04] px-3 py-2.5">
          <p className="text-[11px] text-red-400/70 font-semibold uppercase tracking-wide mb-1">{t("arbiter.dispute_reason_title")}</p>
          <p className="text-xs text-white/70 leading-relaxed">{disputeReason}</p>
        </div>
      ) : (
        <p className="text-xs text-white/25 mt-2 italic">{t("arbiter.no_reason")}</p>
      )}

      {/* Claim hint */}
      {!isClaimed && (
        <p className="text-[11px] text-white/30 mt-2">
          {t("arbiter.claim_hint")}
        </p>
      )}
    </div>
  );
}

// ─── MyCaseRow — claimed active case with resolve actions ─────────────────────

function MyCaseRow({
  agreement, myAddress, busy, onRelease, onResolve,
}: {
  agreement: string;
  myAddress?: string;
  busy: string | null;
  onRelease: (a: string) => void;
  onResolve: (a: string, clientWins: boolean) => void;
}) {
  const t = useTranslations();
  const MINI_ABI = [
    { inputs: [], name: "status",         outputs: [{ internalType: "uint8",    name: "", type: "uint8" }],    stateMutability: "view", type: "function" },
    { inputs: [], name: "amount",         outputs: [{ internalType: "uint256",  name: "", type: "uint256" }],  stateMutability: "view", type: "function" },
    { inputs: [], name: "client",         outputs: [{ internalType: "address",  name: "", type: "address" }],  stateMutability: "view", type: "function" },
    { inputs: [], name: "executor",       outputs: [{ internalType: "address",  name: "", type: "address" }],  stateMutability: "view", type: "function" },
    { inputs: [], name: "arbiterTimeLeft",outputs: [{ internalType: "uint256",  name: "", type: "uint256" }],  stateMutability: "view", type: "function" },
    { inputs: [], name: "disputedAt",     outputs: [{ internalType: "uint256",  name: "", type: "uint256" }],  stateMutability: "view", type: "function" },
  ] as const;

  const { data: statusVal } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "status" }) as { data: number | undefined };
  const { data: amount }    = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "amount" }) as { data: bigint | undefined };
  const { data: client }    = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "client" }) as { data: string | undefined };
  const { data: executor }  = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "executor" }) as { data: string | undefined };
  const { data: timeLeft }  = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "arbiterTimeLeft" }) as { data: bigint | undefined };
  const { data: disputedAt }= useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "disputedAt" }) as { data: bigint | undefined };

  const { data: claimer } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getDisputeClaimer",
    args: [agreement as Address],
  }) as { data: string | undefined };

  const ZERO = "0x0000000000000000000000000000000000000000";
  const isDisputed   = statusVal === AGREEMENT_STATUS_DISPUTED;
  const isTerminal   = statusVal !== undefined && TERMINAL.has(statusVal);
  const isMineClaim  = claimer?.toLowerCase() === myAddress?.toLowerCase() && claimer !== ZERO;
  const isBusy       = busy === agreement;
  const expired      = timeLeft !== undefined && timeLeft === 0n && disputedAt && disputedAt > 0n;

  // Only show in Mine tab if I currently have it claimed and it's still disputed
  if (!isMineClaim && !isDisputed) return null;
  if (isTerminal) return null; // resolved — show in history tab only

  const statusLabel = statusVal !== undefined ? t(STATUS_KEYS[statusVal] ?? "arbiter.status_unknown") : "…";

  return (
    <div className="py-4 border-b border-border last:border-0">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/deal/${agreement}`} className="font-mono text-sm text-primary hover:underline">
              {shortAddr(agreement)}
            </Link>
            <Badge variant={isDisputed ? "destructive" : "secondary"} className="text-xs">
              {statusLabel}
            </Badge>
            {timeLeft !== undefined && timeLeft > 0n && (
              <span className={`text-xs font-mono ${Number(timeLeft) < 86400 ? "text-red-400" : "text-orange-400"}`}>
                {fmtTimeLeft(timeLeft)}
              </span>
            )}
            {expired && (
              <span className="text-xs text-red-400 font-semibold">{t("arbiter.window_expired")}</span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3">
            <span>{t("arbiter.client_label")}: <span className="font-mono">{client ? shortAddr(client) : "…"}</span></span>
            <span>{t("arbiter.executor_label")}: <span className="font-mono">{executor ? shortAddr(executor) : "…"}</span></span>
            <span className="text-white/60">${amount ? fmtUSDC(amount) : "…"} USDC</span>
          </div>
          {disputedAt && disputedAt > 0n && (
            <div className="text-xs text-muted-foreground mt-0.5">
              {t("arbiter.disputed_label")}: {new Date(Number(disputedAt) * 1000).toLocaleString()}
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-2">
            <Link href={`/deal/${agreement}/chat`}>
              <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5 border-green-500/30 text-green-400 hover:bg-green-500/10">
                <MessageSquare className="w-3 h-3" />
                {t("arbiter.deal_chat_btn")}
              </Button>
            </Link>
            {client && (
              <Link href={`/chat?peer=${client.toLowerCase()}`}>
                <Button size="sm" variant="outline" className="text-xs h-7 gap-1 border-blue-500/30 text-blue-400 hover:bg-blue-500/10">
                  {t("arbiter.chat_client_btn")}
                </Button>
              </Link>
            )}
            {executor && (
              <Link href={`/chat?peer=${executor.toLowerCase()}`}>
                <Button size="sm" variant="outline" className="text-xs h-7 gap-1 border-violet-500/30 text-violet-400 hover:bg-violet-500/10">
                  {t("arbiter.chat_executor_btn")}
                </Button>
              </Link>
            )}
          </div>
        </div>
        <Link href={`/deal/${agreement}`}>
          <Button size="sm" variant="ghost">{t("common.details")}</Button>
        </Link>
      </div>

      {/* Resolve actions */}
      {isDisputed && isMineClaim && !expired && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("arbiter.resolve_hint")}
            <span className="text-red-400/80"> {t("arbiter.resolve_irreversible")}</span>
          </p>
          <p className="text-xs text-muted-foreground/70">
            <strong className="text-blue-400">{t("arbiter.refund_client_btn")}</strong> — {t("arbiter.resolve_client_desc")}
            &nbsp;<strong className="text-violet-400">{t("arbiter.pay_executor_btn")}</strong> — {t("arbiter.resolve_executor_desc")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 border-blue-500/30 text-blue-400 hover:bg-blue-500/10"
              disabled={!!busy}
              onClick={() => onResolve(agreement, true)}
            >
              {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
              {t("arbiter.refund_client_btn")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
              disabled={!!busy}
              onClick={() => onResolve(agreement, false)}
            >
              {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserX className="w-4 h-4" />}
              {t("arbiter.pay_executor_btn")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-white ml-auto"
              disabled={!!busy}
              onClick={() => onRelease(agreement)}
            >
              {t("arbiter.release_claim_btn")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── HistoryRow — terminal status ─────────────────────────────────────────────

function HistoryRow({ agreement, prefetched }: { agreement: string; prefetched?: HistDetail }) {
  const t = useTranslations();
  const skip = prefetched !== undefined;
  const MINI_ABI = [
    { inputs: [], name: "status",     outputs: [{ internalType: "uint8",   name: "", type: "uint8" }],   stateMutability: "view", type: "function" },
    { inputs: [], name: "amount",     outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "client",     outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "executor",   outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "resolvedAt", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  ] as const;

  const { data: statusRaw }    = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "status",     query: { enabled: !skip } }) as { data: number | undefined };
  const { data: amountRaw }    = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "amount",     query: { enabled: !skip } }) as { data: bigint | undefined };
  const { data: clientRaw }    = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "client",     query: { enabled: !skip } }) as { data: string | undefined };
  const { data: executorRaw }  = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "executor",   query: { enabled: !skip } }) as { data: string | undefined };
  const { data: resolvedAtRaw }= useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "resolvedAt", query: { enabled: !skip } }) as { data: bigint | undefined };

  const statusVal  = skip ? prefetched.status     : (statusRaw !== undefined ? Number(statusRaw) : undefined);
  const amount     = skip ? prefetched.amount     : amountRaw;
  const client     = skip ? prefetched.client     : clientRaw;
  const executor   = skip ? prefetched.executor   : executorRaw;
  const resolvedAt = skip ? prefetched.resolvedAt : resolvedAtRaw;

  const isTerminal = statusVal !== undefined && TERMINAL.has(statusVal);
  if (!isTerminal) return null;

  const isResolved = statusVal === 5; // executor paid
  const isRefunded = statusVal === 6; // client refunded

  const verdictLabel = isResolved
    ? t("arbiter.verdict_executor_paid")
    : isRefunded
    ? t("arbiter.verdict_client_refunded")
    : (statusVal !== undefined ? t(STATUS_KEYS[statusVal] ?? "arbiter.status_unknown") : "—");
  const verdictCls = isResolved
    ? "border-violet-500/30 text-violet-400"
    : isRefunded
    ? "border-blue-500/30 text-blue-400"
    : "border-white/15 text-white/40";

  return (
    <div className="py-3 border-b border-border last:border-0">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/deal/${agreement}`} className="font-mono text-sm text-primary hover:underline">
              {shortAddr(agreement)}
            </Link>
            <Badge variant="outline" className={`text-xs ${verdictCls}`}>
              {verdictLabel}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3">
            <span>{t("arbiter.client_label")}: <span className="font-mono">{client ? shortAddr(client) : "…"}</span></span>
            <span>{t("arbiter.executor_label")}: <span className="font-mono">{executor ? shortAddr(executor) : "…"}</span></span>
            <span className="text-white/60">${amount ? fmtUSDC(amount) : "…"} USDC</span>
            {resolvedAt && resolvedAt > 0n && (
              <span className="text-white/30">{new Date(Number(resolvedAt) * 1000).toLocaleDateString()}</span>
            )}
          </div>
        </div>
        <Link href={`/deal/${agreement}`}>
          <Button size="sm" variant="ghost" className="text-xs">{t("common.open")}</Button>
        </Link>
      </div>
    </div>
  );
}
