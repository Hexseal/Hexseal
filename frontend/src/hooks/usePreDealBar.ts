'use client';

import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { CONTRACTS, DIAMOND_ABI } from '@/config/contracts';
import type { Abi } from 'viem';

export type PreDealType = 'job_as_client' | 'job_as_executor' | 'service_as_client';

export interface PreDealCtx {
  type: PreDealType;
  title: string;
  amount: bigint;
  deadlineDays: bigint;
  jobId?: bigint;
  serviceId?: bigint;
  hasApplied: boolean;
}

interface RawJob {
  title: string;
  amount: bigint;
  deadlineDays: bigint;
  status: number;
}

interface RawService {
  title: string;
  price: bigint;
  deadlineDays: bigint;
  status: number;
}

const DIA = CONTRACTS.diamond;
const ABI = DIAMOND_ABI as Abi;

export function usePreDealBar(
  address: string | undefined,
  recipientAddress: string,
  skip: boolean,
): PreDealCtx | null {
  const on = !skip && !!address;

  // ── Round 1: ID lists ─────────────────────────────────────────────────────
  const { data: myJobIds }       = useReadContract({ address: DIA, abi: ABI, functionName: 'getClientJobs',      args: [address as `0x${string}`],           query: { enabled: on } });
  const { data: peerJobIds }     = useReadContract({ address: DIA, abi: ABI, functionName: 'getClientJobs',      args: [recipientAddress as `0x${string}`],   query: { enabled: on } });
  const { data: peerServiceIds } = useReadContract({ address: DIA, abi: ABI, functionName: 'getExecutorServices', args: [recipientAddress as `0x${string}`],  query: { enabled: on } });

  const myIds   = useMemo(() => (myJobIds       as bigint[] | undefined) ?? [], [myJobIds]);
  const peerIds = useMemo(() => (peerJobIds     as bigint[] | undefined) ?? [], [peerJobIds]);
  const svcIds  = useMemo(() => (peerServiceIds as bigint[] | undefined) ?? [], [peerServiceIds]);

  // ── Round 2: job & service details ────────────────────────────────────────
  const myJobContracts = useMemo(() =>
    myIds.map(id => ({ address: DIA, abi: ABI, functionName: 'getJob' as const, args: [id] as [bigint] })),
    [myIds]
  );
  const peerJobContracts = useMemo(() =>
    peerIds.map(id => ({ address: DIA, abi: ABI, functionName: 'getJob' as const, args: [id] as [bigint] })),
    [peerIds]
  );
  const peerSvcContracts = useMemo(() =>
    svcIds.map(id => ({ address: DIA, abi: ABI, functionName: 'getService' as const, args: [id] as [bigint] })),
    [svcIds]
  );

  const { data: myJobsData }   = useReadContracts({ contracts: myJobContracts,   query: { enabled: on && myJobContracts.length > 0 } });
  const { data: peerJobsData } = useReadContracts({ contracts: peerJobContracts, query: { enabled: on && peerJobContracts.length > 0 } });
  const { data: peerSvcsData } = useReadContracts({ contracts: peerSvcContracts, query: { enabled: on && peerSvcContracts.length > 0 } });

  // ── Round 3: applicants for open jobs only ────────────────────────────────
  const openMyIds = useMemo(() =>
    myIds.filter((_, i) => (myJobsData?.[i]?.result as RawJob | undefined)?.status === 0),
    [myIds, myJobsData]
  );
  const openPeerIds = useMemo(() =>
    peerIds.filter((_, i) => (peerJobsData?.[i]?.result as RawJob | undefined)?.status === 0),
    [peerIds, peerJobsData]
  );

  const myOpenApplicantContracts = useMemo(() =>
    openMyIds.map(id => ({ address: DIA, abi: ABI, functionName: 'getApplicants' as const, args: [id] as [bigint] })),
    [openMyIds]
  );
  const peerOpenApplicantContracts = useMemo(() =>
    openPeerIds.map(id => ({ address: DIA, abi: ABI, functionName: 'getApplicants' as const, args: [id] as [bigint] })),
    [openPeerIds]
  );

  const { data: myApplicantsData }   = useReadContracts({ contracts: myOpenApplicantContracts,   query: { enabled: on && myOpenApplicantContracts.length > 0 } });
  const { data: peerApplicantsData } = useReadContracts({ contracts: peerOpenApplicantContracts, query: { enabled: on && peerOpenApplicantContracts.length > 0 } });

  // ── Final result ──────────────────────────────────────────────────────────
  return useMemo(() => {
    if (!on || !address) return null;

    const me   = address.toLowerCase();
    const peer = recipientAddress.toLowerCase();

    // Still loading — prevent flicker
    if (myIds.length > 0 && myJobsData === undefined) return null;
    if (peerIds.length > 0 && peerJobsData === undefined) return null;
    if (openMyIds.length > 0 && myApplicantsData === undefined) return null;
    if (openPeerIds.length > 0 && peerApplicantsData === undefined) return null;

    // Priority 1: job_as_client — peer applied to one of my open jobs
    for (let i = 0; i < openMyIds.length; i++) {
      const applicants = (myApplicantsData?.[i]?.result as string[] | undefined) ?? [];
      if (applicants.some(a => a.toLowerCase() === peer)) {
        const jobId   = openMyIds[i];
        const origIdx = myIds.findIndex(id => id === jobId);
        const job     = myJobsData?.[origIdx]?.result as RawJob | undefined;
        return { type: 'job_as_client', title: job?.title ?? '', amount: job?.amount ?? 0n, deadlineDays: job?.deadlineDays ?? 0n, jobId, hasApplied: false };
      }
    }

    // Priority 2: job_as_executor — peer has open jobs I can interact with
    if (openPeerIds.length > 0) {
      // Prefer a job I already applied to
      for (let i = 0; i < openPeerIds.length; i++) {
        const applicants = (peerApplicantsData?.[i]?.result as string[] | undefined) ?? [];
        if (applicants.some(a => a.toLowerCase() === me)) {
          const jobId   = openPeerIds[i];
          const origIdx = peerIds.findIndex(id => id === jobId);
          const job     = peerJobsData?.[origIdx]?.result as RawJob | undefined;
          return { type: 'job_as_executor', title: job?.title ?? '', amount: job?.amount ?? 0n, deadlineDays: job?.deadlineDays ?? 0n, jobId, hasApplied: true };
        }
      }
      // Not applied anywhere — show first open job
      const jobId   = openPeerIds[0];
      const origIdx = peerIds.findIndex(id => id === jobId);
      const job     = peerJobsData?.[origIdx]?.result as RawJob | undefined;
      return { type: 'job_as_executor', title: job?.title ?? '', amount: job?.amount ?? 0n, deadlineDays: job?.deadlineDays ?? 0n, jobId, hasApplied: false };
    }

    // Priority 3: service_as_client — peer has an active service (status=0)
    for (let i = 0; i < svcIds.length; i++) {
      const svc = peerSvcsData?.[i]?.result as RawService | undefined;
      if (svc?.status === 0) {
        return { type: 'service_as_client', title: svc.title, amount: svc.price, deadlineDays: svc.deadlineDays, serviceId: svcIds[i], hasApplied: false };
      }
    }

    return null;
  }, [on, address, recipientAddress, myIds, peerIds, svcIds, myJobsData, peerJobsData, peerSvcsData, openMyIds, openPeerIds, myApplicantsData, peerApplicantsData]);
}
