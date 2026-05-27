"use client";

import { use, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount, useReadContract } from "wagmi";
import { isAddress } from "viem";
import { Loader2 } from "lucide-react";
import { AGREEMENT_ABI } from "@/config/contracts";

// Redirects to the correct DM chat with the counterparty.
// Old group-chat route kept to avoid dead links.
export default function DealChatRedirect() {
  const params      = useParams();
  const router      = useRouter();
  const dealAddress = params?.address as string | undefined;
  const { address } = useAccount();

  const isValidDeal = useMemo(
    () => !!dealAddress && isAddress(dealAddress),
    [dealAddress]
  );

  const { data: details } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "getDetails",
    query: { enabled: isValidDeal },
  }) as { data: readonly unknown[] | undefined };

  useEffect(() => {
    if (!details || !address) return;
    const obj = details as unknown as Record<string, unknown>;
    const arr = details as unknown as readonly unknown[];
    const get = (name: string, idx: number) => (obj[name] ?? arr[idx]) as string;
    const client   = get("client_",   0);
    const executor = get("executor_", 1);
    const peer = address.toLowerCase() === client?.toLowerCase() ? executor : client;
    if (peer) {
      router.replace(`/chat?peer=${peer.toLowerCase()}`);
    } else {
      router.replace(`/deal/${dealAddress}`);
    }
  }, [details, address, dealAddress, router]);

  return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-white/30" />
    </div>
  );
}
