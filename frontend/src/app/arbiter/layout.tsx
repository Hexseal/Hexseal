"use client";

import { useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { useRouter } from "next/navigation";
import { ARBITER_REGISTRY_ABI, DIAMOND_ABI, CONTRACTS } from "@/config/contracts";
import { Loader2 } from "lucide-react";
import type { Abi } from "viem";

export default function ArbiterLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const [checked, setChecked] = useState(false);

  const { data: ownerAddr } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI as Abi,
    functionName: "owner",
  }) as { data: string | undefined };

  const { data: isArbiter, isLoading } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "isRegisteredArbiter",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address },
  }) as { data: boolean | undefined; isLoading: boolean };

  useEffect(() => {
    if (!isConnected) {
      router.replace("/");
      return;
    }
    if (isLoading || ownerAddr === undefined) return;

    const isOwner = !!address && !!ownerAddr &&
      address.toLowerCase() === ownerAddr.toLowerCase();

    if (!isArbiter && !isOwner) {
      router.replace("/");
      return;
    }
    setChecked(true);
  }, [isConnected, isArbiter, isLoading, address, ownerAddr, router]);

  if (!checked || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
