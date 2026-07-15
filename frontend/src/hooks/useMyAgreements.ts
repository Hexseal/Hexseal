import { useMemo } from 'react'
import { useQuery } from 'urql'
import { MY_AGREEMENTS_QUERY, SUBGRAPH_URL } from '@/lib/graph'

export interface GraphAgreement {
  id: string
  client: string
  executor: string
  amount: string
  status: number
  createdAt: string
  resolvedAt: string | null
}

interface MyAgreementsData {
  asClient: GraphAgreement[]
  asExecutor: GraphAgreement[]
}

export function useMyAgreements(address: string | undefined) {
  const addr = address?.toLowerCase() ?? ''
  const variables = useMemo(() => ({ client: addr, executor: addr }), [addr])

  const [{ data, fetching, error }, reexecute] = useQuery<MyAgreementsData>({
    query: MY_AGREEMENTS_QUERY,
    variables,
    pause: !addr || !SUBGRAPH_URL,
  })

  const allAgreements = useMemo(() => {
    const map = new Map<string, GraphAgreement>()
    ;[...(data?.asClient ?? []), ...(data?.asExecutor ?? [])].forEach(a =>
      map.set(a.id.toLowerCase(), a)
    )
    return Array.from(map.values())
  }, [data])

  return {
    agreements: allAgreements,
    isLoading: fetching && !data,
    isFetching: fetching,
    error: error?.message ?? null,
    refetch: () => reexecute({ requestPolicy: 'network-only' }),
  }
}
