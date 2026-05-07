"use client";

import React, { useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount, useReadContract } from "wagmi";
import { isAddress } from "viem";
import { Loader2, ArrowLeft } from "lucide-react";
import { DealChat } from "@/components/DealChat";
import { AGREEMENT_ABI } from "@/config/contracts";

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function DealChatPage() {
  const params     = useParams();
  const router     = useRouter();
  const dealAddress = params?.address as string | undefined;
  const { address, isConnected } = useAccount();

  const isValidDeal = useMemo(
    () => !!dealAddress && isAddress(dealAddress),
    [dealAddress]
  );

  const { data: details, isLoading } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "getDetails",
    query: { enabled: isValidDeal },
  }) as {
    data:
      | [string, string, string, bigint, string, bigint, bigint, bigint, bigint, bigint, bigint, number]
      | undefined;
    isLoading: boolean;
  };

  const parsed = useMemo(() => {
    if (!details) return null;
    const obj = details as unknown as Record<string, unknown>;
    const arr = details as unknown as readonly unknown[];
    const get = (name: string, idx: number): unknown => obj[name] ?? arr[idx];
    return {
      client:   get("client_",   0) as string,
      executor: get("executor_", 1) as string,
      arbiter:  get("arbiter_",  2) as string,
    };
  }, [details]);

  if (!isValidDeal) {
    return (
      <main className="h-dvh bg-[#0a0a0a] flex items-center justify-center">
        <p className="text-red-400 text-sm">Invalid deal address</p>
      </main>
    );
  }

  return (
    <main className="h-dvh bg-[#0a0a0a] text-white flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/8 flex-shrink-0">
        <button
          onClick={() => router.back()}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors flex-shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white/80">Deal Chat</p>
          <p className="font-mono text-[11px] text-white/30 truncate">{dealAddress}</p>
        </div>
        {parsed && (
          <div className="hidden sm:flex items-center gap-2 text-[11px] text-white/30 flex-shrink-0">
            <span>Client: <span className="font-mono">{shortAddr(parsed.client)}</span></span>
            <span>·</span>
            <span>Executor: <span className="font-mono">{shortAddr(parsed.executor)}</span></span>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {isLoading && (
          <div className="flex items-center justify-center h-full gap-2 text-white/30">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading deal…</span>
          </div>
        )}

        {!isLoading && !parsed && (
          <div className="flex items-center justify-center h-full text-red-400 text-sm">
            Failed to load deal details.
          </div>
        )}

        {!isLoading && parsed && !isConnected && (
          <div className="flex items-center justify-center h-full">
            <div className="rounded-xl border border-white/10 bg-white/5 px-5 py-8 text-center mx-4">
              <p className="text-xs text-white/30">Connect wallet to access deal chat</p>
            </div>
          </div>
        )}

        {!isLoading && parsed && isConnected && address && (
          <DealChat
            agreementAddress={dealAddress!}
            client={parsed.client}
            executor={parsed.executor}
            arbiter={parsed.arbiter}
            currentUser={address}
            fullHeight
          />
        )}
      </div>
    </main>
  );
}
