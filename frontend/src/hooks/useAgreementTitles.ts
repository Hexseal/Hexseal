'use client';
import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { DIAMOND_ABI, CONTRACTS } from '@/config/contracts';
import type { Abi } from 'viem';

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Resolves human-readable titles for agreement addresses by reverse-looking up
 * the job/service boards:
 *  - Client-posted jobs  (getClientJobs → getJob)
 *  - Client service requests (getClientRequests → getRequest → getService)
 *  - Executor service deals (getExecutorServices → getService + getServiceRequests → getRequest)
 */
export function useAgreementTitles(address: string | undefined): Map<string, string> {
  const addr = address?.toLowerCase() as `0x${string}` | undefined;
  const enabled = !!addr;

  // ── Client jobs ───────────────────────────────────────────────────────────

  const { data: clientJobIds } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getClientJobs',
    args: addr ? [addr] : undefined,
    query: { enabled },
  }) as { data: bigint[] | undefined };

  const jobContracts = useMemo(() =>
    (clientJobIds ?? []).map(id => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: 'getJob' as const,
      args: [id] as const,
    })), [clientJobIds]);

  const { data: jobResults } = useReadContracts({
    contracts: jobContracts,
    query: { enabled: jobContracts.length > 0 },
  });

  // ── Client service requests ───────────────────────────────────────────────

  const { data: clientRequestIds } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getClientRequests',
    args: addr ? [addr] : undefined,
    query: { enabled },
  }) as { data: bigint[] | undefined };

  const reqContracts = useMemo(() =>
    (clientRequestIds ?? []).map(id => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: 'getRequest' as const,
      args: [id] as const,
    })), [clientRequestIds]);

  const { data: reqResults } = useReadContracts({
    contracts: reqContracts,
    query: { enabled: reqContracts.length > 0 },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reqPairs = useMemo(() => (reqResults ?? []).filter(r => r.status === 'success').map(r => r.result as any)
    .map((d: any) => ({ serviceId: d.serviceId as bigint, agreement: (d.agreement as string)?.toLowerCase() }))
    .filter((p: any) => p.agreement && p.agreement !== ZERO), [reqResults]);

  const uniqueSvcIds = useMemo(() =>
    [...new Set(reqPairs.map(p => p.serviceId.toString()))].map(BigInt), [reqPairs]);

  const svcContracts = useMemo(() =>
    uniqueSvcIds.map(id => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: 'getService' as const,
      args: [id] as const,
    })), [uniqueSvcIds]);

  const { data: svcResults } = useReadContracts({
    contracts: svcContracts,
    query: { enabled: svcContracts.length > 0 },
  });

  // ── Executor service deals ────────────────────────────────────────────────

  const { data: executorServiceIds } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getExecutorServices',
    args: addr ? [addr] : undefined,
    query: { enabled },
  }) as { data: bigint[] | undefined };

  // Batch: getService + getServiceRequests for each executor service (interleaved)
  const execBatch = useMemo(() => [
    ...(executorServiceIds ?? []).map(id => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: 'getService' as const,
      args: [id] as const,
    })),
    ...(executorServiceIds ?? []).map(id => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: 'getServiceRequests' as const,
      args: [id] as const,
    })),
  ], [executorServiceIds]);

  const { data: execBatchData } = useReadContracts({
    contracts: execBatch,
    query: { enabled: execBatch.length > 0 },
  });

  const numExecSvcs = executorServiceIds?.length ?? 0;

  const { execSvcTitles, execReqEntries } = useMemo(() => {
    const titles = new Map<string, string>();
    const entries: { reqId: bigint; svcId: bigint }[] = [];
    if (!execBatchData || !executorServiceIds) return { execSvcTitles: titles, execReqEntries: entries };
    for (let i = 0; i < numExecSvcs; i++) {
      const svcRes = execBatchData[i];
      const svcId  = executorServiceIds[i];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (svcRes?.status === 'success') titles.set(svcId.toString(), (svcRes.result as any).title as string);
      const reqRes = execBatchData[numExecSvcs + i];
      if (reqRes?.status === 'success') (reqRes.result as bigint[]).forEach(reqId => entries.push({ reqId, svcId }));
    }
    return { execSvcTitles: titles, execReqEntries: entries };
  }, [execBatchData, executorServiceIds, numExecSvcs]);

  const execReqContracts = useMemo(() =>
    execReqEntries.map(e => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: 'getRequest' as const,
      args: [e.reqId] as const,
    })), [execReqEntries]);

  const { data: execReqData } = useReadContracts({
    contracts: execReqContracts,
    query: { enabled: execReqContracts.length > 0 },
  });

  // ── Build map ─────────────────────────────────────────────────────────────

  return useMemo(() => {
    const map = new Map<string, string>();

    // Client jobs
    jobResults?.forEach(r => {
      if (r.status !== 'success') return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = r.result as any;
      const agr = (j.agreement as string)?.toLowerCase();
      if (agr && agr !== ZERO) map.set(agr, j.title as string);
    });

    // Client service requests
    const svcById = new Map<string, string>();
    svcResults?.forEach((r, i) => {
      if (r.status !== 'success') return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svcById.set(uniqueSvcIds[i].toString(), (r.result as any).title as string);
    });
    reqPairs.forEach(p => {
      const title = svcById.get(p.serviceId.toString());
      if (title) map.set(p.agreement, title);
    });

    // Executor service deals
    execReqData?.forEach((r, i) => {
      if (r.status !== 'success') return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = r.result as any;
      const agr = (req.agreement as string)?.toLowerCase();
      if (!agr || agr === ZERO) return;
      const title = execSvcTitles.get(execReqEntries[i].svcId.toString());
      if (title) map.set(agr, title);
    });

    return map;
  }, [jobResults, svcResults, uniqueSvcIds, reqPairs, execReqData, execSvcTitles, execReqEntries]);
}
