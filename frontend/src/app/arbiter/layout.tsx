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

  const { data: isArbiter, isLoading: loadingArbiter } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "isRegisteredArbiter",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address },
  }) as { data: boolean | undefined; isLoading: boolean };

  const { data: chiefArbiterAddr, isLoading: loadingChief } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getChiefArbiter",
    query: { enabled: !!address },
  }) as { data: string | undefined; isLoading: boolean };

  const isLoading = loadingArbiter || loadingChief;

  useEffect(() => {
    if (!isConnected) {
      router.replace("/");
      return;
    }
    if (isLoading || ownerAddr === undefined) return;

    const ZERO = "0x0000000000000000000000000000000000000000";
    const isOwner = !!address && !!ownerAddr &&
      address.toLowerCase() === ownerAddr.toLowerCase();
    const isChief = !!address && !!chiefArbiterAddr &&
      chiefArbiterAddr !== ZERO &&
      chiefArbiterAddr.toLowerCase() === address.toLowerCase();

    if (!isArbiter && !isOwner && !isChief) {
      // `checked` is otherwise never reset to false — if the wallet switches from
      // an authorized address to one that isn't (no reload needed, wagmi updates
      // reactively), the stale `checked===true` from the previous address let
      // children render for one commit before router.replace() took effect. Clear
      // it here so the render guard below correctly falls back to the spinner for
      // this newly-rejected address instead.
      setChecked(false);
      router.replace("/");
      return;
    }
    setChecked(true);
  }, [isConnected, isArbiter, isLoading, address, ownerAddr, chiefArbiterAddr, router]);

  if (!checked || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
