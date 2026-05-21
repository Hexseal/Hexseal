"use client";

import React, { useState, useEffect } from "react";
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
import { parseUnits, type Abi, parseEventLogs } from "viem";
import { mintServiceGasless } from "@/lib/relay";
import {
  Loader2, CheckCircle, AlertCircle, Globe, Shield, Zap,
  ExternalLink, User,
} from "lucide-react";
import Link from "next/link";
import { pushNotif } from "@/lib/notifications";
import { useTranslations } from "next-intl";
import { CATEGORIES, DEFAULT_CATEGORY, type CategoryKey, withCategory } from "@/config/categories";

interface RegionData { region: number; fee: bigint; label: string; }

const EXPECTED_CHAIN_ID = CHAIN_ID;
const MAX_PRICE   = MAX_DEAL_AMOUNT;
const MAX_DEADLINE = MAX_DEADLINE_DAYS;

const SERVICE_POSTED_ABI = [{
  anonymous: false,
  inputs: [
    { indexed: true,  internalType: "uint256", name: "serviceId", type: "uint256" },
    { indexed: true,  internalType: "address", name: "executor",  type: "address" },
    { indexed: false, internalType: "uint256", name: "price",     type: "uint256" },
    { indexed: false, internalType: "uint8",   name: "region",    type: "uint8"   },
  ],
  name: "ServicePosted",
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

export default function PostServicePage() {
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
    abi: DIAMOND_ABI as Abi,
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

  const [title,       setTitle]       = useState("");
  const [description, setDescription] = useState("");
  const [price,       setPrice]       = useState("");
  const [deadline,    setDeadline]    = useState("7");
  const [category,    setCategory]    = useState<CategoryKey>(DEFAULT_CATEGORY);
  const [step,        setStep]        = useState<Step>("form");
  const [errorMsg,    setErrorMsg]    = useState("");
  const [txHash,      setTxHash]      = useState("");
  const [serviceId,   setServiceId]   = useState<string | null>(null);

  const parsedPrice = parseFloat(price || "0");
  const hasBalance  = usdcBalance >= feeAmount;
  const isWrongChain = chainId !== EXPECTED_CHAIN_ID;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isWrongChain) { switchChain?.({ chainId: EXPECTED_CHAIN_ID }); return; }
    if (!isConnected || !walletClient || !publicClient) { toast.error("Connect your wallet"); return; }

    const trimmedTitle = title.trim();
    if (!trimmedTitle || trimmedTitle.length > 100) { toast.error("Title required (max 100 chars)"); return; }
    if (!description.trim()) { toast.error("Description required"); return; }
    if (!price || isNaN(parsedPrice) || parsedPrice < 1 || parsedPrice > MAX_PRICE) {
      toast.error("Invalid price"); return;
    }
    const parsedDeadline = parseInt(deadline, 10);
    if (isNaN(parsedDeadline) || parsedDeadline < 1 || parsedDeadline > MAX_DEADLINE) {
      toast.error("Deadline must be 1–365 days"); return;
    }
    if (!hasBalance) { toast.error(`Need ${feeAmount.toFixed(2)} USDC for PPP fee, have ${usdcBalance.toFixed(2)}`); return; }

    setStep("pending");
    try {
      toast("Sign: USDC permit in wallet…");
      const { txHash: hash } = await mintServiceGasless(walletClient, publicClient, {
        title:        sanitizeHtml(trimmedTitle),
        description:  withCategory(category, sanitizeHtml(description.trim())),
        price:        parseUnits(price, 6),
        deadlineDays: BigInt(parsedDeadline),
        region:       regionData?.region ?? 1,
        fee:          effectiveFee,
      });

      let parsedServiceId: string | null = null;
      try {
        const txReceipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
        const logs = parseEventLogs({ abi: SERVICE_POSTED_ABI, eventName: "ServicePosted", logs: txReceipt.logs });
        if (logs.length > 0) {
          parsedServiceId = logs[0].args.serviceId?.toString() ?? null;
          setServiceId(parsedServiceId);
        }
      } catch { /* non-fatal */ }

      setTxHash(hash);
      setStep("success");
      toast.success("Service published!");
      if (address) {
        pushNotif(address, {
          type: "service_posted",
          title: "Service Published! 🛎️",
          body: `Your service${parsedServiceId ? ` #${parsedServiceId}` : ""} is live — clients can now request you.`,
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
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <User className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("board.post_service.title")}</h1>
          <p className="text-muted-foreground text-sm mb-6">{t("common.connect_wallet")}</p>
          <Link href="/"><Button variant="outline">Go Home</Button></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-white/[0.06]">
        <div className="container mx-auto px-4 py-5 max-w-2xl">
<h1 className="text-xl font-bold font-syne">{t("board.post_service.title")}</h1>
          <p className="text-sm text-white/40 mt-0.5">Clients request you — you accept or decline.</p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8 max-w-2xl space-y-4">
        {isWrongChain && (
          <div className="flex items-center justify-between p-3 rounded-2xl bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-300">
            Wrong network — switch to Base Sepolia
            <button className="underline text-xs" onClick={() => switchChain?.({ chainId: EXPECTED_CHAIN_ID })}>Switch</button>
          </div>
        )}

        {step === "form" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Service details */}
            <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4 space-y-4" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
              <h2 className="text-sm font-semibold text-white/60">{t("board.post_service.section_details")}</h2>

              <div className="space-y-1.5">
                <Label htmlFor="title" className="text-sm text-white/70">{t("board.post_service.field_title")}</Label>
                <Input id="title" placeholder="e.g. Smart Contract Audit for DeFi Protocol" value={title}
                  onChange={e => setTitle(e.target.value)} maxLength={100}
                  className="bg-[#0d0d0f] border-white/[0.08] placeholder:text-white/20 rounded-xl" required />
                <p className="text-xs text-white/25 text-right">{title.length}/100</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description" className="text-sm text-white/70">{t("board.post_service.field_description")}</Label>
                <Textarea id="description" placeholder="Describe your service, deliverables, tech stack, requirements…" value={description}
                  onChange={e => setDescription(e.target.value)} rows={4} maxLength={500}
                  className="bg-[#0d0d0f] border-white/[0.08] placeholder:text-white/20 resize-none rounded-xl" required />
                <p className="text-xs text-white/25 text-right">{description.length}/500</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="price" className="text-sm text-white/70">{t("board.post_service.field_price")}</Label>
                  <Input id="price" type="number" step="1" min="1" placeholder="100" value={price}
                    onChange={e => setPrice(e.target.value)}
                    className="bg-[#0d0d0f] border-white/[0.08] placeholder:text-white/20 rounded-xl" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="deadline" className="text-sm text-white/70">{t("board.post_service.field_delivery")}</Label>
                  <Input id="deadline" type="number" min="1" max={MAX_DEADLINE} value={deadline}
                    onChange={e => setDeadline(e.target.value)}
                    className="bg-[#0d0d0f] border-white/[0.08] rounded-xl" required />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm text-white/70">{t("board.post_service.field_category")}</Label>
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
            </div>

            {/* Summary */}
            <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4 space-y-2.5 text-sm" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
              <div className="flex items-center gap-2 text-white/40">
                <Globe className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Region: {regionData?.label ?? "Detecting…"}</span>
              </div>
              <div className="flex items-center gap-2 text-white/40">
                <Shield className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Arbiter: Protocol (auto-assigned on hire)</span>
              </div>
              <div className="flex items-center gap-2 text-white/40">
                <Zap className="w-3.5 h-3.5 flex-shrink-0 text-primary" />
                <span>Gasless — relay pays gas, you only sign</span>
              </div>
              <div className="border-t border-white/8 pt-2.5 space-y-1">
                <div className="flex justify-between text-white/50">
                  <span>Your price (shown to clients)</span><span className="font-mono">{price || "0"} USDC</span>
                </div>
                <div className="flex justify-between text-white/50">
                  <span>{t("board.post_service.fee_label")}</span><span className="font-mono">{feeAmount.toFixed(2)} USDC</span>
                </div>
                <div className="flex justify-between font-semibold text-white border-t border-white/8 pt-1.5 mt-1.5">
                  <span>{t("board.post_service.sign_label")}</span><span className="font-mono">{feeAmount.toFixed(2)} USDC</span>
                </div>
                <p className={`text-xs font-mono ${hasBalance ? "text-emerald-400" : "text-red-400"}`}>
                  Balance: {usdcBalance.toFixed(2)} USDC
                </p>
              </div>
            </div>

            <Button type="submit" className="w-full" size="lg" disabled={!hasBalance || isWrongChain}>
              <User className="w-4 h-4 mr-2" />{t("board.post_service.submit_btn")}
            </Button>
          </form>
        )}

        {step === "pending" && (
          <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-6 py-16 text-center" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
            <Loader2 className="w-10 h-10 animate-spin mx-auto mb-5 text-primary" />
            <h2 className="text-lg font-semibold mb-2">Sending gasless transaction…</h2>
            <p className="text-sm text-white/40">Sign the USDC permit in your wallet — no ETH needed</p>
          </div>
        )}

        {step === "success" && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 px-6 py-8 text-center">
              <div className="w-14 h-14 rounded-2xl bg-emerald-400/10 border border-emerald-400/20 flex items-center justify-center mx-auto mb-5">
                <CheckCircle className="w-7 h-7 text-emerald-400" />
              </div>
              <h2 className="text-xl font-bold font-syne mb-1">{t("board.post_service.success")}</h2>
              <p className="text-sm text-white/50 mb-2">Your service is live. Clients can now request you.</p>
              {serviceId && (
                <p className="text-xs font-mono text-white/30 mb-4">Service #{serviceId}</p>
              )}
              {txHash && (
                <a href={explorerUrl('tx', txHash)} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline mb-5">
                  View on Basescan <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <div className="flex gap-3 justify-center mt-4">
                <Link href="/dashboard"><Button>Dashboard</Button></Link>
                <Link href="/board/executor"><Button variant="outline" className="border-white/15 text-white/60">Board</Button></Link>
              </div>
            </div>

          </div>
        )}

        {step === "error" && (
          <div className="rounded-2xl border border-red-400/20 bg-red-400/5 px-6 py-12 text-center">
            <div className="w-14 h-14 rounded-2xl bg-red-400/10 border border-red-400/20 flex items-center justify-center mx-auto mb-5">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <h2 className="text-xl font-bold font-syne mb-2">Transaction Failed</h2>
            <p className="text-sm text-white/40 mb-5 max-w-sm mx-auto break-words">{errorMsg}</p>
            <Button onClick={() => { setStep("form"); setErrorMsg(""); }}>Try Again</Button>
          </div>
        )}
      </div>
    </div>
  );
}
