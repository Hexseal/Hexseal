import { useMemo, useCallback } from 'react'
import { useQuery } from 'urql'
import { MY_SERVICES_QUERY, SUBGRAPH_URL } from '@/lib/graph'
import { FRESH_HEADERS } from '@/lib/subgraphSync'
import { useGraphRefresh } from '@/hooks/useRefreshSignal'

export interface MyServiceEntry {
  id: string
  title: string
  price: string
  deadlineDays: string
  status: string
  createdAt: string
}

const EMPTY: MyServiceEntry[] = []
const GRAPH_TOPICS = ['services'] as const

export function useMyServices(address: string | undefined) {
  const executor = address?.toLowerCase() ?? ''
  const variables = useMemo(() => ({ executor }), [executor])

  const [{ data, fetching }, reexecute] = useQuery<{ services: MyServiceEntry[] }>({
    query: MY_SERVICES_QUERY,
    variables,
    pause: !executor || !SUBGRAPH_URL,
  })

  // `x-fresh` обязателен: без него прокси отдаёт свою запись возрастом до
  // 120 секунд и перечитывание ничего не меняет.
  const refetch = useCallback(
    () => reexecute({ requestPolicy: 'network-only', fetchOptions: { headers: { ...FRESH_HEADERS } } }),
    [reexecute],
  )

  useGraphRefresh(GRAPH_TOPICS, refetch)

  return {
    services: data?.services ?? EMPTY,
    isLoading: fetching && !data,
    refetch,
  }
}
