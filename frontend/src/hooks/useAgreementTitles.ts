'use client';
import { useMemo } from 'react';
import { useQuery } from 'urql';
import { AGREEMENT_JOB_TITLES_QUERY, AGREEMENT_SERVICE_TITLES_QUERY, SUBGRAPH_URL } from '@/lib/graph';
import type { GraphAgreement } from '@/hooks/useMyAgreements';

/**
 * Resolves human-readable titles for agreements from the subgraph: Agreement.jobId /
 * Agreement.serviceId are already indexed (set in the same tx as AgreementDeployed), and
 * Job.title / Service.title are already indexed too — so this is just two batched lookups
 * against ids already present on the agreements passed in, no on-chain reads needed.
 */
export function useAgreementTitles(agreements: GraphAgreement[]): Map<string, string> {
  const jobIds = useMemo(
    () => [...new Set(agreements.map(a => a.jobId).filter((id): id is string => !!id))],
    [agreements],
  );
  const serviceIds = useMemo(
    () => [...new Set(agreements.map(a => a.serviceId).filter((id): id is string => !!id))],
    [agreements],
  );

  const [{ data: jobData }] = useQuery<{ jobs: { id: string; title: string }[] }>({
    query: AGREEMENT_JOB_TITLES_QUERY,
    variables: { ids: jobIds },
    pause: jobIds.length === 0 || !SUBGRAPH_URL,
  });

  const [{ data: serviceData }] = useQuery<{ services: { id: string; title: string }[] }>({
    query: AGREEMENT_SERVICE_TITLES_QUERY,
    variables: { ids: serviceIds },
    pause: serviceIds.length === 0 || !SUBGRAPH_URL,
  });

  return useMemo(() => {
    const jobTitleById = new Map((jobData?.jobs ?? []).map(j => [j.id, j.title]));
    const serviceTitleById = new Map((serviceData?.services ?? []).map(s => [s.id, s.title]));

    const map = new Map<string, string>();
    agreements.forEach(a => {
      const title = (a.jobId && jobTitleById.get(a.jobId)) || (a.serviceId && serviceTitleById.get(a.serviceId));
      if (title) map.set(a.id.toLowerCase(), title);
    });
    return map;
  }, [agreements, jobData, serviceData]);
}
