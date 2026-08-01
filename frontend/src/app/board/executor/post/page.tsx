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
import { mintServiceGasless } from "@/lib/relay";
import { refreshAfterTx } from "@/lib/subgraphSync";
import { useFeeConfig } from "@/hooks/useFeeConfig";
import {
  Loader2, CheckCircle, AlertCircle, Globe, Shield, Zap,
  ExternalLink, User,
} from "lucide-react";
import Link from "next/link";
import { pushNotif } from "@/lib/notifications";
import { useTranslations } from "next-intl";
import { CATEGORIES, DEFAULT_CATEGORY, type CategoryKey, withCategory } from "@/config/categories";
import { PageCenter } from "@/components/PageCenter";

interface RegionData { region: number; label: string; }

const EXPECTED_CHAIN_ID = CHAIN_ID;
const MAX_PRICE   = MAX_DEAL_AMOUNT;
const MAX_DEADLINE = MAX_DEADLINE_DAYS;

// Must match the 7-param event in ServiceBoardFacet.sol exactly,
// otherwise topic0 never matches and serviceId is null
const SERVICE_POSTED_ABI = [{
  anonymous: false,
  inputs: [
    { indexed: true,  internalType: "uint256", name: "serviceId", type: "uint256" },
    { indexed: true,  internalType: "address", name: "executor",  type: "address" },
    { indexed: false, internalType: "uint256", name: "price",     type: "uint256" },
    { indexed: false, internalType: "uint8",   name: "region",    type: "uint8"   },
    { indexed: false, internalType: "string",  name: "title",     type: "string"  },
    { indexed: false, internalType: "string",  name: "description", type: "string" },
    { indexed: false, internalType: "uint256", name: "deadlineDays", type: "uint256" },
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

type Step = "form" | "pending" | "success" | "error";

export default function PostServicePage() {
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

  // Publishing a service has no deal amount yet — price is a non-binding
  // suggestion, so the fee is always exactly the flat floor, never a percentage.
  const { feeFloor, isLoading: feeConfigLoading } = useFeeConfig();
  // A failed read leaves isLoading false with feeFloor still undefined — must
  // gate the same as "still loading", or feeAmount silently falls back to 0
  // and every wallet, including an empty one, reads as having enough balance.
  // Also require feeFloor > 0n: FactoryStorage.quote() reverts
  // FeeNotConfigured() on a zero floor (initFeeModel() not yet called), so a
  // zero read is a defined-but-unconfigured state, not "no fee" — treating it
  // as ready would show "Fee 0.00" and let the real submit die in the revert.
  const feeConfigReady = !feeConfigLoading && feeFloor !== undefined && feeFloor > 0n;
  const feeAmount = feeFloor !== undefined ? Number(feeFloor) / 1e6 : 0;

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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const parsedPrice = parseFloat(price || "0");
  // Gated on feeConfigReady: with the floor unloaded (or its read having
  // failed), feeAmount falls back to 0 and `usdcBalance >= 0` is true for
  // every wallet, including an empty one — the button would let a listing
  // through that then fails the fee permit it can't actually cover.
  const hasBalance  = feeConfigReady && usdcBalance >= feeAmount;
  const isWrongChain = chainId !== EXPECTED_CHAIN_ID;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!isConnected || !walletClient || !publicClient) { toast.error(t("common.connect_wallet")); return; }
    // Ставится ДО ожидания смены сети — ровно та же причина, что в парной
    // форме заказа (board/client/post): до этой правки единственным
    // «занято» здесь был `step === "pending"`, а он выставляется НИЖЕ, уже
    // после `await switchChainAsync()`. Кнопка отправки (гейт только на
    // `hasBalance`) оставалась нажимаемой всё время, пока кошелёк показывает
    // запрос на смену сети, и второй клик запускал независимый прогон,
    // доходивший до `mintServiceGasless` второй раз: две одинаковые услуги на
    // цепи и дважды списанный сбор.
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
    if (!price || isNaN(parsedPrice) || parsedPrice < 1) errs.price = t("form.price_min", { min: 1 });
    else if (parsedPrice > MAX_PRICE) errs.price = t("form.amount_max", { max: MAX_PRICE });
    if (!deadline || isNaN(parsedDeadline) || parsedDeadline < 1 || parsedDeadline > MAX_DEADLINE) errs.deadline = t("form.deadline_range", { min: 1, max: MAX_DEADLINE });
    if (Object.keys(errs).length > 0) { setFieldErrors(errs); setIsSubmitting(false); return; }
    setFieldErrors({});

    if (!hasBalance) { toast.error(t("board.post_common.insufficient_balance", { need: feeAmount.toFixed(2), have: usdcBalance.toFixed(2) })); setIsSubmitting(false); return; }

    setStep("pending");
    try {
      const { txHash: hash } = await mintServiceGasless(walletClient, publicClient, {
        title:        sanitizeHtml(trimmedTitle),
        description:  withCategory(category, sanitizeHtml(description.trim())),
        price:        parseUnits(price, 6),
        deadlineDays: BigInt(parsedDeadline),
        region:       regionData?.region ?? 1,
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
      toast.success(t("board.post_service.success"));
      // Сбросить кэш прокси, чтобы доска показала новую услугу — но НЕ раньше,
      // чем сабграф проиндексирует блок. Сброс в момент майнинга (как было
      // здесь) цементировал непроиндексированный снимок ещё на 120 секунд:
      // следующий заход промахивался мимо кэша и клал в него ответ, в котором
      // услуги ещё нет. См. lib/subgraphSync.
      void refreshAfterTx(publicClient, hash, {
        chain: ["services"],
        graph: ["services"],
      });
      if (address) {
        pushNotif(address, {
          type: "service_posted",
          title: "Service Published!",
          body: `Your service${parsedServiceId ? ` #${parsedServiceId}` : ""} is live — clients can now request you.`,
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
            <User className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("board.post_service.title")}</h1>
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
          <h1 className="text-xl font-bold font-syne">{t("board.post_service.title")}</h1>
          <p className="text-sm text-white/40 mt-0.5">{t("board.post_service.subtitle")}</p>
        </div>
      </div>

      <motion.div
        className="container mx-auto px-4 py-8 max-w-2xl space-y-4"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
      >
        {step === "form" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Service details */}
            <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4 space-y-4" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
              <h2 className="text-sm font-semibold text-white/60">{t("board.post_service.section_details")}</h2>

              <div className="space-y-1.5">
                <Label htmlFor="title" className="text-sm text-white/70">{t("board.post_service.field_title")}</Label>
                <Input id="title" placeholder={t("board.post_service.field_title_ph")} value={title}
                  onChange={e => { setTitle(e.target.value); if (fieldErrors.title) setFieldErrors(p => ({ ...p, title: "" })); }} maxLength={100}
                  className={`bg-[#0d0d0f] placeholder:text-white/20 rounded-xl ${fieldErrors.title ? "border-red-500/60" : "border-white/[0.08]"}`} />
                <div className="flex justify-between">
                  {fieldErrors.title ? <p className="text-xs text-red-400">{fieldErrors.title}</p> : <span />}
                  <p className="text-xs text-white/25">{title.length}/100</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description" className="text-sm text-white/70">{t("board.post_service.field_description")}</Label>
                <Textarea id="description" placeholder={t("board.post_service.field_description_ph")} value={description}
                  onChange={e => { setDescription(e.target.value); if (fieldErrors.description) setFieldErrors(p => ({ ...p, description: "" })); }} rows={4} maxLength={500}
                  className={`bg-[#0d0d0f] placeholder:text-white/20 resize-none rounded-xl ${fieldErrors.description ? "border-red-500/60" : "border-white/[0.08]"}`} />
                <div className="flex justify-between">
                  {fieldErrors.description ? <p className="text-xs text-red-400">{fieldErrors.description}</p> : <span />}
                  <p className="text-xs text-white/25">{description.length}/500</p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="price" className="text-sm text-white/70">{t("board.post_service.field_price")}</Label>
                  <Input id="price" type="number" step="1" min="1" placeholder="100" value={price}
                    onChange={e => { setPrice(e.target.value); if (fieldErrors.price) setFieldErrors(p => ({ ...p, price: "" })); }}
                    className={`bg-[#0d0d0f] placeholder:text-white/20 rounded-xl ${fieldErrors.price ? "border-red-500/60" : "border-white/[0.08]"}`} />
                  {fieldErrors.price && <p className="text-xs text-red-400">{fieldErrors.price}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="deadline" className="text-sm text-white/70">{t("board.post_service.field_delivery")}</Label>
                  <Input id="deadline" type="number" min="1" max={MAX_DEADLINE} value={deadline}
                    onChange={e => { setDeadline(e.target.value); if (fieldErrors.deadline) setFieldErrors(p => ({ ...p, deadline: "" })); }}
                    className={`bg-[#0d0d0f] rounded-xl ${fieldErrors.deadline ? "border-red-500/60" : "border-white/[0.08]"}`} />
                  {fieldErrors.deadline && <p className="text-xs text-red-400">{fieldErrors.deadline}</p>}
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
              <div className="border-t border-white/8 pt-2.5 space-y-1">
                <div className="flex justify-between text-white/50">
                  <span>{t("board.post_service.price_row")}</span><span className="font-mono">{price || "0"} USDC</span>
                </div>
                <div className="flex justify-between text-white/50">
                  <span>{t("board.post_service.fee_label")}</span><span className="font-mono">{feeConfigReady ? `${feeAmount.toFixed(2)} USDC` : "—"}</span>
                </div>
                <div className="flex justify-between font-semibold text-white border-t border-white/8 pt-1.5 mt-1.5">
                  <span>{t("board.post_service.sign_label")}</span><span className="font-mono">{feeConfigReady ? `${feeAmount.toFixed(2)} USDC` : "—"}</span>
                </div>
                <p className={`text-xs font-mono ${hasBalance ? "text-emerald-400" : "text-red-400"}`}>
                  {t("board.post_common.balance_label")}: {usdcBalance.toFixed(2)} USDC
                </p>
              </div>
            </div>

            <Button type="submit" className="w-full" size="lg" disabled={!hasBalance || isSubmitting}>
              {isSubmitting
                ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                : <User className="w-4 h-4 mr-2" />}
              {t("board.post_service.submit_btn")}
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
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 px-6 py-8 text-center">
              <div className="w-14 h-14 rounded-2xl bg-emerald-400/10 border border-emerald-400/20 flex items-center justify-center mx-auto mb-5">
                <CheckCircle className="w-7 h-7 text-emerald-400" />
              </div>
              <h2 className="text-xl font-bold font-syne mb-1">{t("board.post_service.success")}</h2>
              <p className="text-sm text-white/50 mb-2">{t("board.post_service.success_sub")}</p>
              {serviceId && (
                <p className="text-xs font-mono text-white/30 mb-4">{t("board.post_service.service_number", { id: serviceId })}</p>
              )}
              {txHash && (
                <a href={explorerUrl('tx', txHash)} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline mb-5">
                  {t("board.post_common.view_tx")} <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <div className="flex gap-3 justify-center mt-4 flex-wrap">
                {serviceId && <Link href={`/service/${serviceId}`}><Button>{t("board.post_service.open_service_btn")}</Button></Link>}
                <Link href="/dashboard"><Button variant={serviceId ? "outline" : "default"} className={serviceId ? "border-white/15 text-white/60" : undefined}>{t("nav.dashboard")}</Button></Link>
                <Link href="/board/executor"><Button variant="outline" className="border-white/15 text-white/60">{t("nav.board")}</Button></Link>
              </div>
            </div>

          </div>
        )}

        {step === "error" && (
          <div className="rounded-2xl border border-red-400/20 bg-red-400/5 px-6 py-12 text-center">
            <div className="w-14 h-14 rounded-2xl bg-red-400/10 border border-red-400/20 flex items-center justify-center mx-auto mb-5">
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
