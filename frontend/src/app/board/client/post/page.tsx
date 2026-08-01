"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  useAccount, useWalletClient, usePublicClient,
  useBalance, useSwitchChain,
} from "wagmi";
import { CONTRACTS } from "@/config/contracts";
import { CHAIN_ID, MAX_DEAL_AMOUNT, MAX_DEADLINE_DAYS } from "@/config/constants";
import { explorerUrl } from "@/config/chain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "react-hot-toast";
import { parseUnits, parseEventLogs } from "viem";
import { mintJobGasless } from "@/lib/relay";
import { refreshAfterBlock } from "@/lib/subgraphSync";
import { useFeeConfig } from "@/hooks/useFeeConfig";
import { quoteFeeLocal, fmtUsdc } from "@/lib/fee";
import {
  Loader2, CheckCircle, AlertCircle, Globe, Shield, Zap, Briefcase,
  ExternalLink, Sparkles, Receipt,
} from "lucide-react";
import Link from "next/link";
import { pushNotif } from "@/lib/notifications";
import { useTranslations } from "next-intl";
import { CATEGORIES, DEFAULT_CATEGORY, type CategoryKey, withCategory } from "@/config/categories";
import { PageCenter } from "@/components/PageCenter";

interface RegionData { region: number; label: string; }

const EXPECTED_CHAIN_ID = CHAIN_ID;
const MAX_AMOUNT  = MAX_DEAL_AMOUNT;
const MAX_DEADLINE = MAX_DEADLINE_DAYS;

// JobPosted event ABI (для парсинга jobId из receipt) — must match the 8-param
// event in JobBoardFacet.sol exactly, otherwise topic0 never matches and jobId is null
const JOB_POSTED_ABI = [{
  anonymous: false,
  inputs: [
    { indexed: true,  internalType: "uint256", name: "jobId",  type: "uint256" },
    { indexed: true,  internalType: "address", name: "client", type: "address" },
    { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    { indexed: false, internalType: "uint8",   name: "region", type: "uint8"   },
    { indexed: false, internalType: "string",  name: "title",  type: "string"  },
    { indexed: false, internalType: "string",  name: "description", type: "string" },
    { indexed: false, internalType: "uint256", name: "deadlineDays", type: "uint256" },
    { indexed: false, internalType: "string",  name: "terms",  type: "string"  },
  ],
  name: "JobPosted",
  type: "event",
}] as const;

function sanitizeHtml(text: string): string {
  if (typeof document !== "undefined") {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const REGION_LABELS: Record<number, string> = {
  0: "CIS",
  1: "Asia",
  2: "Europe",
  3: "US",
  4: "LATAM",
  5: "CA",
  6: "AU",
};

type Step = "form" | "pending" | "success" | "error";

export default function PostJobPage() {
  const { address, isConnected, chainId, status } = useAccount();
  const t = useTranslations();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [regionData, setRegionData] = useState<RegionData | null>(null);
  useEffect(() => {
    fetch("/api/region")
      .then(r => r.json())
      .then(data => setRegionData({ region: data.region, label: data.label }))
      .catch(() => setRegionData({ region: 1, label: "Asia" }));
  }, []);

  const { feeBps, feeFloor, isLoading: feeConfigLoading } = useFeeConfig();
  // True once both the bps and the floor are actually in hand — not just once
  // wagmi stops fetching. A failed read also leaves isLoading false with the
  // values still undefined, and that must gate exactly like "still loading":
  // showing 0.00/— and letting the balance check pass on amount alone (no fee
  // added in) is the same "signed one thing, chain wants another" failure the
  // rest of this plan removes, just reached from an empty read instead of a
  // stale argument. Also require feeFloor > 0n: FactoryStorage.quote()
  // (src/FactoryFacet.sol) reverts FeeNotConfigured() on a zero floor, so a
  // freshly-mounted diamond that hasn't had initFeeModel() called yet reads
  // back feeFloor === 0n — a defined value, not undefined — and would
  // otherwise sail through this gate showing "Fee 0.00" right up until the
  // real submit dies inside readQuotedFee's revert.
  const feeConfigReady = !feeConfigLoading && feeBps !== undefined && feeFloor !== undefined && feeFloor > 0n;

  const { data: usdcBalanceData } = useBalance({
    address,
    token: CONTRACTS.usdc as `0x${string}`,
    query: { enabled: !!address },
  });
  const usdcBalance = Number(usdcBalanceData?.value ?? 0n) / 1e6;

  const [title,      setTitle]      = useState("");
  const [description,setDescription]= useState("");
  const [amount,     setAmount]     = useState("");
  const [deadline,   setDeadline]   = useState("7");
  const [jobTerms,   setJobTerms]   = useState("");
  const [category,   setCategory]   = useState<CategoryKey>(DEFAULT_CATEGORY);
  const [customTag,  setCustomTag]  = useState("");
  const [step,       setStep]       = useState<Step>("form");
  const [errorMsg,   setErrorMsg]   = useState("");
  const [txHash,     setTxHash]     = useState("");
  const [jobId,      setJobId]      = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Comes from useFeeConfig() above — declared here (after the `amount` state
  // it reads) rather than alongside that hook, since the fee now depends on
  // the entered amount and can't be computed before the input exists.
  // parseUnits throws on a not-yet-valid intermediate value — "1e5" (valid
  // per <input type="number">, invalid per viem), a bare "-" or "." mid-edit —
  // and this runs on every render, not inside a submit handler, so an
  // uncaught throw here replaces the whole page with the client-error screen
  // (no error.tsx in this app) and wipes whatever the user had typed. Fall
  // back to 0n for display purposes only; submission re-validates amount
  // separately in handleSubmit before ever calling parseUnits again there.
  let parsedAmountRaw = 0n;
  try { parsedAmountRaw = parseUnits(amount || "0", 6); } catch { /* intermediate input, e.g. "1e5", "-", "." */ }
  const feeRaw = feeBps !== undefined && feeFloor !== undefined
    ? quoteFeeLocal(parsedAmountRaw, feeBps, feeFloor)
    : 0n;
  const feeAmount = Number(feeRaw) / 1e6;

  const parsedAmount = parseFloat(amount || "0");
  const totalNeeded  = parsedAmount + feeAmount;
  // Gated on feeConfigReady, not just the balance math: with the fee config
  // still unloaded (or its read having failed) feeAmount is 0, so comparing
  // balance to totalNeeded alone would pass a wallet that can't actually
  // cover the fee. That's the same "signed one amount, chain wants another"
  // failure this whole plan removes — just entered through an unready read
  // instead of a stale local computation.
  const hasBalance   = feeConfigReady && usdcBalance >= totalNeeded;
  const isWrongChain = chainId !== EXPECTED_CHAIN_ID;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!isConnected || !walletClient || !publicClient) { toast.error(t("common.connect_wallet")); return; }
    // Set BEFORE the chain-switch await below — otherwise the submit button
    // (gated only on hasBalance) stays enabled for the whole duration of the
    // wallet's network-switch prompt, and a second click starts a fully
    // independent run that reaches mintJobGasless a second time.
    setIsSubmitting(true);
    if (isWrongChain) {
      try { await switchChainAsync({ chainId: EXPECTED_CHAIN_ID }); }
      catch { toast.error(t("board.post_common.switch_network")); setIsSubmitting(false); return; }
    }

    const trimmedTitle = title.trim();
    const parsedDeadline = parseInt(deadline, 10);
    const errs: Record<string, string> = {};
    if (!trimmedTitle) errs.title = t("form.required");
    else if (trimmedTitle.length > 100) errs.title = t("form.max_chars", { count: 100 });
    if (!description.trim()) errs.description = t("form.required");
    if (!jobTerms.trim()) errs.terms = t("form.required");
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) errs.amount = t("form.amount_positive");
    else if (parsedAmount > MAX_AMOUNT) errs.amount = t("form.amount_max", { max: MAX_AMOUNT });
    if (!deadline || isNaN(parsedDeadline) || parsedDeadline < 1 || parsedDeadline > MAX_DEADLINE) errs.deadline = t("form.deadline_range", { min: 1, max: MAX_DEADLINE });
    if (Object.keys(errs).length > 0) { setFieldErrors(errs); setIsSubmitting(false); return; }
    setFieldErrors({});

    if (!hasBalance) { toast.error(t("board.post_common.insufficient_balance", { need: totalNeeded.toFixed(2), have: usdcBalance.toFixed(2) })); setIsSubmitting(false); return; }

    setStep("pending");
    try {
      const { txHash: hash } = await mintJobGasless(walletClient, publicClient, {
        title:        sanitizeHtml(trimmedTitle),
        description:  withCategory(category,
          category === 'other' && customTag.trim()
            ? `[${customTag.trim()}] ${description.trim()}`
            : description.trim()
        ),
        amount:       parseUnits(amount, 6),
        deadlineDays: BigInt(parsedDeadline),
        terms:        sanitizeHtml(jobTerms.trim()),
        region:       regionData?.region ?? 1,
      });

      // Parse jobId from transaction receipt
      let parsedJobId: string | null = null;
      // Номер блока из той же квитанции — его же ждёт refreshAfterTx ниже.
      // Держим снаружи try, чтобы не читать квитанцию второй раз.
      let minedBlock: bigint | undefined;
      try {
        const txReceipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
        minedBlock = txReceipt.blockNumber;
        const logs = parseEventLogs({ abi: JOB_POSTED_ABI, eventName: "JobPosted", logs: txReceipt.logs });
        if (logs.length > 0) {
          parsedJobId = logs[0].args.jobId?.toString() ?? null;
          setJobId(parsedJobId);
          // Persist CID so the poster can view terms later on board/job pages
        }
      } catch { /* non-fatal */ }

      setTxHash(hash);
      setStep("success");
      toast.success(t("board.post_job.success"));
      // Сбросить кэш прокси, чтобы доска показала новый заказ — но НЕ раньше,
      // чем сабграф проиндексирует блок. Сброс в момент майнинга (как было
      // здесь) цементировал непроиндексированный снимок ещё на 120 секунд.
      // См. lib/subgraphSync.
      void refreshAfterBlock(minedBlock, {
        chain: ["jobs", "wallet"],
        graph: ["jobs"],
      });
      if (address) {
        pushNotif(address, {
          type: "job_posted",
          title: "Job Posted!",
          body: `Your job${parsedJobId ? ` #${parsedJobId}` : ""} is live — executors can now apply.`,
          link: "/dashboard",
          txHash: hash,
        });
      }
    } catch (err: any) {
      setErrorMsg(err?.message || "Transaction failed");
      setStep("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (status === 'reconnecting' || status === 'connecting') {
    return (
      <div className="container mx-auto px-4 pt-4 pb-8 max-w-2xl space-y-4 animate-pulse">
        <div className="h-7 w-48 rounded-lg bg-white/[0.06]" />
        <div className="h-4 w-72 rounded bg-white/[0.04]" />
        <div className="rounded-[22px] border border-white/[0.06] bg-[#0d0d0f] px-5 py-4 space-y-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 w-20 rounded bg-white/[0.05]" />
              <div className="h-10 rounded-[14px] bg-white/[0.04]" />
            </div>
          ))}
        </div>
        <div className="rounded-[22px] border border-white/[0.06] bg-[#0d0d0f] px-5 py-4 h-32" />
        <div className="h-11 rounded-lg bg-white/[0.05]" />
      </div>
    );
  }

  if (!isConnected) {
    return (
      <PageCenter>
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <Briefcase className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("board.post_job.title")}</h1>
          <p className="text-muted-foreground text-sm mb-6">{t("common.connect_wallet")}</p>
          <Link href="/"><Button variant="outline">{t("common.go_home")}</Button></Link>
        </div>
      </PageCenter>
    );
  }

  return (
    <>
      {/* Header */}
      <div>
        <div className="container mx-auto px-4 pt-4 pb-3 max-w-2xl">
          <h1 className="text-2xl font-bold font-syne">{t("board.post_job.title")}</h1>
          <p className="text-sm text-white/40 mt-0.5">{t("board.post_job.subtitle")}</p>
        </div>
      </div>

      <motion.div
        className="container mx-auto px-4 pt-3 pb-8 max-w-2xl space-y-4"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
      >
        {step === "form" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Job info */}
            <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4 space-y-4" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
              <h2 className="text-sm font-semibold text-white/60">{t("board.post_job.section_details")}</h2>

              <div className="space-y-1.5">
                <Label htmlFor="title" className="text-sm text-white/70">{t("board.post_job.field_title")}</Label>
                <Input id="title" placeholder={t("board.post_job.field_title_ph")} value={title}
                  onChange={e => { setTitle(e.target.value); if (fieldErrors.title) setFieldErrors(p => ({ ...p, title: "" })); }} maxLength={100}
                  className={`bg-[#0d0d0f] placeholder:text-white/20 rounded-[14px] ${fieldErrors.title ? "border-red-500/60" : "border-white/[0.08]"}`} />
                <div className="flex justify-between">
                  {fieldErrors.title ? <p className="text-xs text-red-400">{fieldErrors.title}</p> : <span />}
                  <p className="text-xs text-white/25">{title.length}/100</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description" className="text-sm text-white/70">{t("board.post_job.field_description")}</Label>
                <Textarea id="description" placeholder={t("board.post_job.field_description_ph")} value={description}
                  onChange={e => { setDescription(e.target.value); if (fieldErrors.description) setFieldErrors(p => ({ ...p, description: "" })); }} rows={4} maxLength={500}
                  className={`bg-[#0d0d0f] placeholder:text-white/20 resize-none rounded-[14px] ${fieldErrors.description ? "border-red-500/60" : "border-white/[0.08]"}`} />
                {fieldErrors.description && <p className="text-xs text-red-400">{fieldErrors.description}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="terms" className="text-sm text-white/70">{t("board.post_job.field_brief")}</Label>
                <Textarea id="terms" placeholder={t("board.post_job.field_brief_hint")} value={jobTerms}
                  onChange={e => { setJobTerms(e.target.value); if (fieldErrors.terms) setFieldErrors(p => ({ ...p, terms: "" })); }} rows={3} maxLength={2000}
                  className={`bg-[#0d0d0f] placeholder:text-white/20 resize-none rounded-[14px] ${fieldErrors.terms ? "border-red-500/60" : "border-white/[0.08]"}`} />
                {fieldErrors.terms
                  ? <p className="text-xs text-red-400">{fieldErrors.terms}</p>
                  : <p className="text-xs text-white/25">{t("board.post_job.field_brief_note")}</p>}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="amount" className="text-sm text-white/70">{t("board.post_job.field_budget")}</Label>
                  <Input id="amount" type="number" step="0.01" min="0" placeholder="100" value={amount}
                    onChange={e => { setAmount(e.target.value); if (fieldErrors.amount) setFieldErrors(p => ({ ...p, amount: "" })); }}
                    className={`bg-[#0d0d0f] placeholder:text-white/20 rounded-[14px] ${fieldErrors.amount ? "border-red-500/60" : "border-white/[0.08]"}`} />
                  {fieldErrors.amount && <p className="text-xs text-red-400">{fieldErrors.amount}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="deadline" className="text-sm text-white/70">{t("board.post_job.field_deadline")}</Label>
                  <Input id="deadline" type="number" min="1" max={MAX_DEADLINE} value={deadline}
                    onChange={e => { setDeadline(e.target.value); if (fieldErrors.deadline) setFieldErrors(p => ({ ...p, deadline: "" })); }}
                    className={`bg-[#0d0d0f] rounded-[14px] ${fieldErrors.deadline ? "border-red-500/60" : "border-white/[0.08]"}`} />
                  {fieldErrors.deadline && <p className="text-xs text-red-400">{fieldErrors.deadline}</p>}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm text-white/70">{t("board.post_job.field_category")}</Label>
                <div className="flex flex-wrap gap-2">
                  {CATEGORIES.map(({ key, badge }) => (
                    <button key={key} type="button"
                      onClick={() => { setCategory(key); if (key !== 'other') setCustomTag(""); }}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                        category === key ? badge : "border-white/8 text-white/40 hover:text-white/60 hover:border-white/15"
                      }`}
                    >{t(`categories.${key}`)}</button>
                  ))}
                </div>
                {category === 'other' && (
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-white/30 text-xs flex-shrink-0">#</span>
                    <Input
                      placeholder={t("board.post_job.custom_tag_ph")}
                      value={customTag}
                      onChange={e => setCustomTag(e.target.value.slice(0, 40))}
                      maxLength={40}
                      className="bg-[#0d0d0f] border-white/[0.08] placeholder:text-white/20 rounded-[14px] text-sm h-8"
                    />
                  </div>
                )}
              </div>

            </div>

            {/* Summary */}
            <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4 space-y-2.5 text-sm" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
              <div className="flex items-center gap-2 text-white/40">
                <Globe className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{t("board.post_job.field_region")}: {regionData?.label ?? t("board.post_common.detecting")}</span>
              </div>
              <div className="flex items-center gap-2 text-white/40">
                <Shield className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{t("board.post_common.arbiter_row")}</span>
              </div>
              <div className="flex items-center gap-2 text-white/40">
                <Zap className="w-3.5 h-3.5 flex-shrink-0 text-primary" />
                <span>{t("board.post_common.gasless_row")}</span>
              </div>
              <div className="flex items-center gap-2 text-white/40">
                <Receipt className="w-3.5 h-3.5 flex-shrink-0 text-emerald-400/60" />
                <span>{t("board.post_common.receipt_row")}</span>
              </div>
              <div className="border-t border-white/8 pt-2.5 space-y-1">
                <div className="flex justify-between text-white/50">
                  <span>{t("board.post_common.budget_label")}</span><span className="font-mono">{amount || "0"} USDC</span>
                </div>
                <div className="flex justify-between text-white/50">
                  <span>{t("board.post_job.fee_label")}</span><span className="font-mono">{feeConfigReady ? `${feeAmount.toFixed(2)} USDC` : "—"}</span>
                </div>
                <div className="flex justify-between font-semibold text-white border-t border-white/8 pt-1.5 mt-1.5">
                  <span>{t("board.post_common.total_label")}</span><span className="font-mono">{feeConfigReady ? `${totalNeeded.toFixed(2)} USDC` : "—"}</span>
                </div>
                {/* feeFloor !== undefined repeated here (redundant with
                    feeConfigReady at runtime) purely so TS narrows it to
                    bigint for fmtUsdc — feeConfigReady is a plain boolean,
                    its own feeFloor > 0n check doesn't carry through. */}
                {feeConfigReady && feeFloor !== undefined && (
                  <p className="text-xs text-white/35">
                    {t("board.post_common.refund_note", { floor: fmtUsdc(feeFloor) })}
                  </p>
                )}
                <p className={`text-xs font-mono ${hasBalance ? "text-emerald-400" : "text-red-400"}`}>
                  {t("board.post_common.balance_label")}: {usdcBalance.toFixed(2)} USDC
                </p>
              </div>
            </div>

            <Button type="submit" className="w-full" size="lg" disabled={!hasBalance || isSubmitting}>
              <Briefcase className="w-4 h-4 mr-2" />{t("board.post_job.submit_btn")}
            </Button>
          </form>
        )}

        {step === "pending" && (
          <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-6 py-16 text-center" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
            <Loader2 className="w-10 h-10 animate-spin mx-auto mb-5 text-primary" />
            <h2 className="text-lg font-semibold mb-2">{t("board.post_common.pending_title")}</h2>
            <p className="text-sm text-white/40">{t("board.post_common.pending_hint")}</p>
          </div>
        )}

        {step === "success" && (
          <div className="space-y-4">
            {/* Success header */}
            <div className="rounded-[22px] border border-emerald-400/20 bg-emerald-400/5 px-6 py-8 text-center">
              <div className="w-14 h-14 rounded-[18px] bg-emerald-400/10 border border-emerald-400/20 flex items-center justify-center mx-auto mb-5">
                <CheckCircle className="w-7 h-7 text-emerald-400" />
              </div>
              <h2 className="text-xl font-bold font-syne mb-1">{t("board.post_job.success")}</h2>
              <p className="text-sm text-white/50 mb-2">{t("board.post_job.success_sub")}</p>
              {jobId && (
                <p className="text-xs font-mono text-white/30 mb-4">{t("board.post_job.job_number", { id: jobId })}</p>
              )}
              {txHash && (
                <a href={explorerUrl('tx', txHash)} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline mb-5">
                  {t("board.post_common.view_tx")} <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <div className="flex gap-3 justify-center mt-4 flex-wrap">
                {jobId && <Link href={`/job/${jobId}`}><Button>{t("board.post_job.open_job_btn")}</Button></Link>}
                <Link href="/dashboard"><Button variant={jobId ? "outline" : "default"} className={jobId ? "border-white/15 text-white/60" : undefined}>{t("nav.dashboard")}</Button></Link>
                <Link href="/board"><Button variant="outline" className="border-white/15 text-white/60">{t("nav.board")}</Button></Link>
              </div>
            </div>

            {/* Receipt NFT */}
            {jobId && (
              <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
                {/* Receipt card preview */}
                <div className="rounded-[14px] bg-[#0d0d1f] border border-white/5 p-5 mb-4 font-mono text-xs">
                  {/* Green top bar */}
                  <div className="h-0.5 bg-emerald-500 rounded-full mb-4" />
                  <p className="text-emerald-400 font-bold text-sm tracking-widest text-center mb-0.5">HEXSEAL</p>
                  <p className="text-white/20 text-[9px] tracking-widest text-center mb-3">JOB POSTING RECEIPT</p>
                  <div className="border-t border-dashed border-white/10 pt-2.5 mb-2.5 space-y-1.5">
                    <div className="flex justify-between text-white/40">
                      <span>ORDER</span><span className="text-white/30">#{jobId?.padStart(4, "0")}</span>
                    </div>
                    <div className="border-t border-dashed border-white/8 pt-1.5 space-y-1">
                      <div className="flex justify-between">
                        <span className="text-white/30">TITLE</span>
                        <span className="text-white/70 truncate max-w-[140px]">{title.slice(0, 20)}{title.length > 20 ? "…" : ""}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-white/30">BUDGET</span>
                        <span className="text-white/70">{amount} USDC</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-white/30">DEADLINE</span>
                        <span className="text-white/70">{deadline} DAYS</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-white/30">REGION</span>
                        <span className="text-white/70">{REGION_LABELS[regionData?.region ?? 1]}</span>
                      </div>
                    </div>
                  </div>
                  <div className="border-t border-dashed border-white/10 pt-2 mb-2">
                    <div className="flex justify-between text-white/30">
                      <span>FEE</span><span>{feeAmount.toFixed(2)} USDC</span>
                    </div>
                  </div>
                  <div className="border-t border-white/15 pt-2 flex justify-between items-baseline">
                    <span className="text-white/50 text-[10px] tracking-wider">TOTAL</span>
                    <span className="text-emerald-400 font-bold text-base">{totalNeeded.toFixed(2)} <span className="text-xs">USDC</span></span>
                  </div>
                  <div className="border-t border-dashed border-white/8 mt-3 pt-2 text-center space-y-0.5">
                    <p className="text-white/15 text-[8px] tracking-widest">GASLESS TX · BASE SEPOLIA</p>
                    <p className="text-white/10 text-[8px] tracking-widest">SOULBOUND NFT · NON-TRANSFERABLE</p>
                  </div>
                  {/* Green bottom bar */}
                  <div className="h-0.5 bg-emerald-500 rounded-full mt-4" />
                </div>

                {/* Auto-minted indicator */}
                <div className="flex items-center gap-2 text-xs text-emerald-400/70">
                  <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{t("board.post_job.receipt_minted_note")}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {step === "error" && (
          <div className="rounded-[22px] border border-red-400/20 bg-red-400/5 px-6 py-12 text-center">
            <div className="w-14 h-14 rounded-[18px] bg-red-400/10 border border-red-400/20 flex items-center justify-center mx-auto mb-5">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <h2 className="text-xl font-bold font-syne mb-2">{t("common.transaction_failed")}</h2>
            <p className="text-sm text-white/40 mb-5 max-w-sm mx-auto break-words">{errorMsg}</p>
            <Button onClick={() => { setStep("form"); setErrorMsg(""); }}>{t("common.retry")}</Button>
          </div>
        )}
      </motion.div>
    </>
  );
}
