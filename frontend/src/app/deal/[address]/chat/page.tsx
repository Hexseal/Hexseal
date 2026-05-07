"use client";

import React, { useMemo } from "react";
import { useParams } from "next/navigation";
import { useAccount, useReadContract } from "wagmi";
import { isAddress } from "viem";
import { Loader2 } from "lucide-react";
import { DealChat } from "@/components/DealChat";
import { AGREEMENT_ABI } from "@/config/contracts";

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function DealChatPage() {
  const params = useParams();
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
      | [
          string,
          string,
          string,
          bigint,
          string,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          number
        ]
      | undefined;
    isLoading: boolean;
  };

  const parsed = useMemo(() => {
    if (!details) return null;
    const obj = details as unknown as Record<string, unknown>;
    const arr = details as unknown as readonly unknown[];
    const get = (name: string, idx: number): unknown => obj[name] ?? arr[idx];
    return {
      client: get("client_", 0) as string,
      executor: get("executor_", 1) as string,
      arbiter: get("arbiter_", 2) as string,
    };
  }, [details]);

  if (!isValidDeal) {
    return (
      <main className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <p className="text-red-400 text-sm">Invalid deal address</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-4 py-6 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-white/30 mb-0.5">Deal Chat</p>
            <p className="font-mono text-xs text-white/50 truncate">
              {dealAddress}
            </p>
          </div>
          {parsed && (
            <div className="hidden sm:flex items-center gap-3 text-[11px] text-white/30">
              <span>
                Client:{" "}
                <span className="font-mono">{shortAddr(parsed.client)}</span>
              </span>
              <span>·</span>
              <span>
                Executor:{" "}
                <span className="font-mono">{shortAddr(parsed.executor)}</span>
              </span>
            </div>
          )}
        </div>

        {/* Content */}
        {isLoading && (
          <div className="flex items-center justify-center py-16 gap-2 text-white/30">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading deal…</span>
          </div>
        )}

        {!isLoading && !parsed && (
          <div className="text-center py-16 text-red-400 text-sm">
            Failed to load deal details.
          </div>
        )}

        {!isLoading && parsed && !isConnected && (
          <div className="rounded-xl border border-white/10 bg-white/5 px-5 py-8 text-center">
            <p className="text-xs text-white/30">
              Connect wallet to access deal chat
            </p>
          </div>
        )}

        {!isLoading && parsed && isConnected && address && (
          <DealChat
            agreementAddress={dealAddress!}
            client={parsed.client}
            executor={parsed.executor}
            arbiter={parsed.arbiter}
            currentUser={address}
          />
        )}
      </div>
    </main>
  );
}
