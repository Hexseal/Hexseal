"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  useAccount, useReadContract, useWalletClient, usePublicClient,
  useBalance, useSwitchChain,
} from "wagmi";
import { DIAMOND_ABI, CONTRACTS } from "@/config/contracts";
import { CHAIN_ID, MAX_DEAL_AMOUNT, MAX_DEADLINE_DAYS, DEFAULT_REGION_FEE } from "@/config/constants";
import { explorerUrl } from "@/config/chain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "react-hot-toast";
import { parseUnits, type Hex, parseEventLogs, keccak256 } from "viem";
import { mintJobGasless } from "@/lib/relay";
import {
  Loader2, CheckCircle, AlertCircle, Globe, Shield, Zap, Briefcase,
  ExternalLink, Sparkles, Receipt,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { pushNotif } from "@/lib/notifications";
import { useTranslations } from "next-intl";
import { CATEGORIES, DEFAULT_CATEGORY, type CategoryKey, withCategory } from "@/config/categories";

interface RegionData { region: number; fee: bigint; label: string; }

const EXPECTED_CHAIN_ID = CHAIN_ID;
const MAX_AMOUNT  = MAX_DEAL_AMOUNT;
const MAX_DEADLINE = MAX_DEADLINE_DAYS;

// JobPosted event ABI (для парсинга jobId из receipt)
const JOB_POSTED_ABI = [{
  anonymous: false,
  inputs: [
    { indexed: true,  internalType: "uint256", name: "jobId",  type: "uint256" },
    { indexed: true,  internalType: "address", name: "client", type: "address" },
    { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    { indexed: false, internalType: "uint8",   name: "region", type: "uint8"   },
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

type Step = "form" | "uploading" | "pending" | "success" | "error";

export default function PostJobPage() {
  const router = useRouter();
  const { address, isConnected, chainId } = useAccount();
  const t = useTranslations();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [regionData, setRegionData] = useState<RegionData | null>(null);
  useEffect(() => {
    fetch("/api/region")
      .then(r => r.json())
      .then(data => setRegionData({ region: data.region, fee: BigInt(data.fee), label: data.label }))
      .catch(() => setRegionData({ region: 1, fee: DEFAULT_REGION_FEE, label: "Asia/LATAM · $4" }));
  }, []);

  const { data: regionFee } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: "getRegionFee",
    args: [regionData?.region ?? 1],
    query: { enabled: !!regionData },
  }) as { data: bigint | undefined };

  const effectiveFee = regionFee ?? regionData?.fee ?? DEFAULT_REGION_FEE;
  const feeAmount    = Number(effectiveFee) / 1e6;

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
  const [step,       setStep]       = useState<Step>("form");
  const [errorMsg,   setErrorMsg]   = useState("");
  const [txHash,     setTxHash]     = useState("");
  const [jobId,      setJobId]      = useState<string | null>(null);

  const parsedAmount = parseFloat(amount || "0");
  const totalNeeded  = parsedAmount + feeAmount;
  const hasBalance   = usdcBalance >= totalNeeded;
  const isWrongChain = chainId !== EXPECTED_CHAIN_ID;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isWrongChain) { switchChain?.({ chainId: EXPECTED_CHAIN_ID }); return; }
    if (!isConnected || !walletClient || !publicClient) { toast.error("Connect your wallet"); return; }

    const trimmedTitle = title.trim();
    if (!trimmedTitle || trimmedTitle.length > 100) { toast.error("Title required (max 100 chars)"); return; }
    if (!description.trim()) { toast.error("Description required"); return; }
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > MAX_AMOUNT) {
      toast.error("Invalid budget"); return;
    }
    const parsedDeadline = parseInt(deadline, 10);
    if (isNaN(parsedDeadline) || parsedDeadline < 1 || parsedDeadline > MAX_DEADLINE) {
      toast.error("Deadline must be 1–365 days"); return;
    }
    if (!hasBalance) { toast.error(`Need ${totalNeeded.toFixed(2)} USDC, have ${usdcBalance.toFixed(2)}`); return; }

    let termsHash: Hex = `0x${"0".repeat(64)}` as Hex;
    if (jobTerms.trim()) {
      setStep("uploading");
      const termsText = sanitizeHtml(jobTerms.trim());
      termsHash = keccak256(new TextEncoder().encode(termsText)) as Hex;
      try {
        await fetch('/api/job-terms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hash: termsHash, text: termsText }),
        });
      } catch {
        toast("Terms save failed — continuing", { icon: "⚠️" });
      }
    }

    setStep("pending");
    try {
      toast("Sign: USDC permit in wallet…");
      const { txHash: hash } = await mintJobGasless(walletClient, publicClient, {
        title:        sanitizeHtml(trimmedTitle),
        description:  withCategory(category, description.trim()),
        amount:       parseUnits(amount, 6),
        deadlineDays: BigInt(parsedDeadline),
        termsHash,
        region:       regionData?.region ?? 1,
        fee:          effectiveFee,
      });

      // Parse jobId from transaction receipt
      let parsedJobId: string | null = null;
      try {
        const txReceipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
        const logs = parseEventLogs({ abi: JOB_POSTED_ABI, eventName: "JobPosted", logs: txReceipt.logs });
        if (logs.length > 0) {
          parsedJobId = logs[0].args.jobId?.toString() ?? null;
          setJobId(parsedJobId);
          // Persist CID so the poster can view terms later on board/job pages
        }
      } catch { /* non-fatal */ }

      setTxHash(hash);
      setStep("success");
      toast.success("Job posted!");
      if (address) {
        pushNotif(address, {
          type: "job_posted",
          title: "Job Posted! 📋",
          body: `Your job${parsedJobId ? ` #${parsedJobId}` : ""} is live — executors can now apply.`,
          link: "/dashboard",
          txHash: hash,
        });
      }
    } catch (err: any) {
      setErrorMsg(err?.message || "Transaction failed");
      setStep("error");
    }
  };

  if (!isConnected) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <Briefcase className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("board.post_job.title")}</h1>
          <p className="text-muted-foreground text-sm mb-6">{t("common.connect_wallet")}</p>
          <Link href="/"><Button variant="outline">Go Home</Button></Link>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      <div>
        <div className="container mx-auto px-4 pt-4 pb-3 max-w-2xl">
<h1 className="text-2xl font-bold font-syne">{t("board.post_job.title")}</h1>
          <p className="text-sm text-white/40 mt-0.5">Executors apply — you pick who to hire.</p>
        </div>
      </div>

      <motion.div
        className="container mx-auto px-4 py-8 max-w-2xl space-y-4"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
      >
        {isWrongChain && (
          <div className="flex items-center justify-between p-3 rounded-[22px] bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-300">
            Wrong network — switch to Base Sepolia
            <button className="underline text-xs" onClick={() => switchChain?.({ chainId: EXPECTED_CHAIN_ID })}>Switch</button>
          </div>
        )}

        {step === "form" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Job info */}
            <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4 space-y-4" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
              <h2 className="text-sm font-semibold text-white/60">{t("board.post_job.field_title")} Details</h2>

              <div className="space-y-1.5">
                <Label htmlFor="title" className="text-sm text-white/70">{t("board.post_job.field_title")}</Label>
                <Input id="title" placeholder="e.g. Build a React Web Application" value={title}
                  onChange={e => setTitle(e.target.value)} maxLength={100}
                  className="bg-[#0d0d0f] border-white/[0.08] placeholder:text-white/20 rounded-[14px]" required />
                <p className="text-xs text-white/25 text-right">{title.length}/100</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description" className="text-sm text-white/70">{t("board.post_job.field_description")}</Label>
                <Textarea id="description" placeholder="Describe requirements, deliverables…" value={description}
                  onChange={e => setDescription(e.target.value)} rows={4}
                  className="bg-[#0d0d0f] border-white/[0.08] placeholder:text-white/20 resize-none rounded-[14px]" required />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="amount" className="text-sm text-white/70">{t("board.post_job.field_budget")}</Label>
                  <Input id="amount" type="number" step="0.01" min="0" placeholder="100" value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className="bg-[#0d0d0f] border-white/[0.08] placeholder:text-white/20 rounded-[14px]" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="deadline" className="text-sm text-white/70">{t("board.post_job.field_deadline")}</Label>
                  <Input id="deadline" type="number" min="1" max={MAX_DEADLINE} value={deadline}
                    onChange={e => setDeadline(e.target.value)}
                    className="bg-[#0d0d0f] border-white/[0.08] rounded-[14px]" required />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm text-white/70">{t("board.post_job.field_category")}</Label>
                <div className="flex flex-wrap gap-2">
                  {CATEGORIES.map(({ key, badge }) => (
                    <button key={key} type="button" onClick={() => setCategory(key)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                        category === key ? badge : "border-white/8 text-white/40 hover:text-white/60 hover:border-white/15"
                      }`}
                    >{t(`categories.${key}`)}</button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="terms" className="text-sm text-white/70">
                  {t("board.post_job.field_brief")} <span className="text-white/25">(optional)</span>
                </Label>
                <Textarea id="terms" placeholder={t("board.post_job.field_brief_hint")} value={jobTerms}
                  onChange={e => setJobTerms(e.target.value)} rows={3}
                  className="bg-[#0d0d0f] border-white/[0.08] placeholder:text-white/20 resize-none rounded-[14px]" />
                <p className="text-xs text-white/25">Uploaded to IPFS — visible only after match</p>
              </div>
            </div>

            {/* Summary */}
            <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4 space-y-2.5 text-sm" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
              <div className="flex items-center gap-2 text-white/40">
                <Globe className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Region: {regionData?.label ?? "Detecting…"}</span>
              </div>
              <div className="flex items-center gap-2 text-white/40">
                <Shield className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Arbiter: Protocol (auto-assigned)</span>
              </div>
              <div className="flex items-center gap-2 text-white/40">
                <Zap className="w-3.5 h-3.5 flex-shrink-0 text-primary" />
                <span>Gasless — relay pays gas, you only sign</span>
              </div>
              <div className="flex items-center gap-2 text-white/40">
                <Receipt className="w-3.5 h-3.5 flex-shrink-0 text-emerald-400/60" />
                <span>Receipt NFT minted on posting</span>
              </div>
              <div className="border-t border-white/8 pt-2.5 space-y-1">
                <div className="flex justify-between text-white/50">
                  <span>Budget</span><span className="font-mono">{amount || "0"} USDC</span>
                </div>
                <div className="flex justify-between text-white/50">
                  <span>{t("board.post_job.fee_label")}</span><span className="font-mono">{feeAmount.toFixed(2)} USDC</span>
                </div>
                <div className="flex justify-between font-semibold text-white border-t border-white/8 pt-1.5 mt-1.5">
                  <span>{t("board.post_job.submit_btn")}</span><span className="font-mono">{totalNeeded.toFixed(2)} USDC</span>
                </div>
                <p className={`text-xs font-mono ${hasBalance ? "text-emerald-400" : "text-red-400"}`}>
                  Balance: {usdcBalance.toFixed(2)} USDC
                </p>
              </div>
            </div>

            <Button type="submit" className="w-full" size="lg" disabled={!hasBalance || isWrongChain}>
              <Briefcase className="w-4 h-4 mr-2" />{t("board.post_job.submit_btn")}
            </Button>
          </form>
        )}

        {(step === "uploading" || step === "pending") && (
          <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-6 py-16 text-center" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
            <Loader2 className="w-10 h-10 animate-spin mx-auto mb-5 text-primary" />
            <h2 className="text-lg font-semibold mb-2">
              {step === "uploading" ? "Uploading to IPFS…" : "Sending gasless transaction…"}
            </h2>
            <p className="text-sm text-white/40">
              {step === "pending" ? "Sign the USDC permit in your wallet — no ETH needed" : "Pinning terms to IPFS…"}
            </p>
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
              <p className="text-sm text-white/50 mb-2">Your job is live. Executors can now apply.</p>
              {jobId && (
                <p className="text-xs font-mono text-white/30 mb-4">Job #{jobId}</p>
              )}
              {txHash && (
                <a href={explorerUrl('tx', txHash)} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline mb-5">
                  View on Basescan <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <div className="flex gap-3 justify-center mt-4">
                <Link href="/dashboard"><Button>Dashboard</Button></Link>
                <Link href="/board"><Button variant="outline" className="border-white/15 text-white/60">Board</Button></Link>
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
                      <span>PPP FEE</span><span>{feeAmount.toFixed(2)} USDC</span>
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
                  <span>Receipt NFT auto-minted to your wallet — soulbound, non-transferable</span>
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
            <h2 className="text-xl font-bold font-syne mb-2">Transaction Failed</h2>
            <p className="text-sm text-white/40 mb-5 max-w-sm mx-auto break-words">{errorMsg}</p>
            <Button onClick={() => { setStep("form"); setErrorMsg(""); }}>Try Again</Button>
          </div>
        )}
      </motion.div>
    </>
  );
}
