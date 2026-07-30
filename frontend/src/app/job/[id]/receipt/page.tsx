"use client";

import React, { use } from "react";
import { motion } from "framer-motion";
import { useReadContract } from "wagmi";
import type { Abi } from "viem";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { DIAMOND_ABI, JOB_RECEIPT_FACET_ABI, CONTRACTS } from "@/config/contracts";
import { explorerUrl } from "@/config/chain";
import { shortAddr } from "@/lib/utils";

// ── Region helpers (mirrors SVGRenderer._regionLabel) ─────────────────────────

const REGION_LABEL: Record<number, string> = {
  0: "CIS",
  1: "ASIA",
  2: "EUROPE",
  3: "US",
  4: "LATAM",
  5: "CA",
  6: "AU",
};

function fmt(raw: bigint | number): string {
  const n = Number(raw);
  const whole = Math.floor(n / 1_000_000);
  const frac  = String(Math.floor((n % 1_000_000) / 10_000)).padStart(2, "0");
  return `${whole}.${frac}`;
}

function fmtDate(ts: bigint): string {
  const d = new Date(Number(ts) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  return `${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}  ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function padId(id: bigint): string {
  return String(id).padStart(4, "0");
}


// ── Job status ──────────────────────────────────────────────────────────────

const STATUS_MAP: Record<number, { label: string; color: string; dot: string }> = {
  0: { label: "FUNDS ESCROWED",    color: "text-emerald-400", dot: "bg-emerald-400" },
  1: { label: "DEAL IN PROGRESS",  color: "text-violet-400",  dot: "bg-violet-400"  },
  2: { label: "REFUNDED",          color: "text-white/30",    dot: "bg-white/20"    },
};

// ── Receipt card ────────────────────────────────────────────────────────────

interface ReceiptData {
  tokenId: bigint;
  jobId:   bigint;
  client:  string;
  title:   string;
  amount:  bigint;
  deadlineDays: bigint;
  region:  number;
  createdAt: bigint;
  jobStatus: number;
}

function ReceiptRow({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="flex justify-between items-baseline py-[3px]">
      <span className={`font-mono text-[11px] tracking-widest ${dim ? "text-white/20" : "text-white/40"}`}>{label}</span>
      <span className={`font-mono text-[11px] ${dim ? "text-white/25" : "text-white/70"}`}>{value}</span>
    </div>
  );
}

function Dashes() {
  return <div className="border-t border-dashed border-white/[0.08] my-3" />;
}

function Receipt({ data }: { data: ReceiptData }) {
  const st       = STATUS_MAP[data.jobStatus] ?? STATUS_MAP[0];
  const isCancelled = data.jobStatus === 2;

  return (
    <div
      className={`relative mx-auto font-mono transition-opacity ${isCancelled ? "opacity-60" : ""}`}
      style={{ width: 360, background: "#080808" }}
    >
      {/* Void stamp — shown only when CANCELLED */}
      {isCancelled && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 10 }}>
          <div
            className="font-mono font-bold tracking-[6px] text-red-400/25 border-[3px] border-red-400/20 rounded px-5 py-2"
            style={{ fontSize: 34, transform: "rotate(-22deg)" }}
          >
            VOIDED
          </div>
        </div>
      )}
      {/* Top bar */}
      <div style={{ height: 4, background: "#ffffff", borderRadius: "2px 2px 0 0" }} />

      {/* Header */}
      <div className="px-6 pt-5 pb-2 text-center">
        <div className="text-[15px] font-bold tracking-[3px] text-white">HEXSEAL</div>
        <div className="text-[8px] tracking-[4px] text-white/25 mt-0.5">JOB RECEIPT</div>
      </div>

      <Dashes />

      {/* Order meta */}
      <div className="px-6">
        <div className="flex justify-between items-center">
          <span className="text-[9px] tracking-widest text-white/30">ORDER</span>
          <span className="text-[9px] text-white/40">#{padId(data.tokenId)}</span>
        </div>
        <div className="text-[9px] text-white/20 mt-0.5">{fmtDate(data.createdAt)}</div>
      </div>

      <Dashes />

      {/* Items */}
      <div className="px-6">
        <ReceiptRow label="TITLE"    value={data.title.length > 22 ? data.title.slice(0, 22) + "…" : data.title} />
        <ReceiptRow label="BUDGET"   value={`${fmt(data.amount)} USDC`} />
        <ReceiptRow label="DEADLINE" value={`${data.deadlineDays} DAYS`} />
        <ReceiptRow label="REGION"   value={REGION_LABEL[data.region] ?? `${data.region}`} />
      </div>

      <Dashes />

      {/* Escrow total */}
      <div className="px-6 pb-2">
        <div className="border-t border-white/[0.12] mt-1 mb-3" />
        <div className="flex justify-between items-end">
          <span className="text-[9px] tracking-widest text-white/30">ESCROW</span>
          <div className="text-right">
            <div className="text-[28px] font-bold text-white leading-none">{fmt(data.amount)}</div>
            <div className="text-[11px] text-white/25 mt-0.5">USDC</div>
          </div>
        </div>
      </div>

      <Dashes />

      {/* Status */}
      <div className="px-6 pb-3">
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
          <span className={`text-[9px] tracking-widest font-bold ${st.color}`}>{st.label}</span>
        </div>
      </div>

      <Dashes />

      {/* Footer */}
      <div className="px-6 pb-4">
        <div className="text-[8px] tracking-widest text-white/25 mb-1">CLIENT</div>
        <div className="text-[11px] text-white/50">{shortAddr(data.client)}</div>
        <div className="flex gap-2 mt-3">
          <span className="text-[8px] tracking-widest text-white/20 border border-white/10 rounded px-2 py-0.5">GASLESS TX</span>
          <span className="text-[8px] tracking-widest text-white/20 border border-white/10 rounded px-2 py-0.5">BASE NETWORK</span>
        </div>
      </div>

      {/* Torn edge */}
      <div className="relative flex items-center overflow-hidden" style={{ height: 20 }}>
        <div
          className="absolute left-0 w-4 h-4 rounded-full"
          style={{ background: "#000", marginLeft: -8 }}
        />
        <div className="flex-1 border-t border-dashed border-white/[0.08] mx-3" />
        <div
          className="absolute right-0 w-4 h-4 rounded-full"
          style={{ background: "#000", marginRight: -8 }}
        />
      </div>

      {/* Soulbound note */}
      <div className="px-6 py-4 text-center">
        <div className="text-[8px] tracking-[2px] text-white/15">
          SOULBOUND NFT · NON-TRANSFERABLE
        </div>
        <div className="text-[8px] tracking-[2px] text-white/10 mt-1">hexseal.net</div>
      </div>

      {/* Bottom bar */}
      <div style={{ height: 4, background: "#ffffff", borderRadius: "0 0 2px 2px" }} />
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const jobId  = BigInt(id);

  // jobId → tokenId via on-chain mapping. The old getLogs(earliest→latest) scan
  // was rejected by the RPC (free-plan 10k-block range cap) → receipt never loaded.
  const { data: tokenLookup, isLoading: lookupLoading } = useReadContract({
    address:      CONTRACTS.diamond,
    abi:          JOB_RECEIPT_FACET_ABI as Abi,
    functionName: "getTokenIdByJobId",
    args:         [jobId],
  }) as { data: readonly [bigint, boolean] | undefined; isLoading: boolean };

  const tokenId: bigint | null = tokenLookup && tokenLookup[1] ? tokenLookup[0] : null;

  // Receipt data
  const { data: receiptData } = useReadContract({
    address:      CONTRACTS.diamond,
    abi:          JOB_RECEIPT_FACET_ABI as Abi,
    functionName: "getJobReceiptData",
    args:         [tokenId!],
    query:        { enabled: tokenId !== null },
  }) as { data: { client: string; title: string; amount: bigint; deadlineDays: bigint; region: number; createdAt: bigint } | undefined };

  // Job status (for receipt status line)
  const { data: job } = useReadContract({
    address:      CONTRACTS.diamond,
    abi:          DIAMOND_ABI as Abi,
    functionName: "getJob",
    args:         [jobId],
  }) as { data: { status: number } | undefined };

  const isLoading = lookupLoading || (tokenId !== null && !receiptData);

  const receiptProps: ReceiptData | null = receiptData && tokenId !== null
    ? {
        tokenId,
        jobId,
        client:       receiptData.client,
        title:        receiptData.title,
        amount:       receiptData.amount,
        deadlineDays: receiptData.deadlineDays,
        region:       receiptData.region,
        createdAt:    receiptData.createdAt,
        jobStatus:    job?.status ?? 0,
      }
    : null;

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-8">
      {/* Nav */}
      <div className="w-full max-w-sm mb-6">
        <Link
          href={`/job/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white/70 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to job
        </Link>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-white/30 py-20">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm font-mono">Loading receipt…</span>
        </div>
      ) : !receiptProps ? (
        <div className="text-center py-20">
          <p className="text-sm text-white/30 font-mono">Receipt not found for job #{id}</p>
          <Link href={`/job/${id}`} className="text-xs text-white/20 hover:text-white/40 mt-2 block">
            ← Back to job
          </Link>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="flex flex-col items-center gap-6 w-full"
        >
          <Receipt data={receiptProps} />

          {/* Links */}
          <div className="flex flex-col items-center gap-2 text-center">
            <a
              href={explorerUrl("address", CONTRACTS.diamond)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-mono text-white/20 hover:text-white/45 transition-colors"
            >
              NFT #{tokenId!.toString()} on explorer
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="text-[10px] text-white/10 font-mono tracking-wider">
              SOULBOUND · CANNOT BE TRANSFERRED OR SOLD
            </p>
          </div>
        </motion.div>
      )}
    </div>
  );
}
