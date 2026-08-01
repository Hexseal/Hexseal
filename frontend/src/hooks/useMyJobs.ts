import { useMemo, useCallback } from 'react'
import { useQuery } from 'urql'
import { MY_JOBS_QUERY, SUBGRAPH_URL } from '@/lib/graph'
import { FRESH_HEADERS } from '@/lib/subgraphSync'
import { useGraphRefresh } from '@/hooks/useRefreshSignal'

export interface MyJobEntry {
  id: string
  title: string
  amount: string
  deadlineDays: string
  status: string
  createdAt: string
}

const EMPTY: MyJobEntry[] = []
const GRAPH_TOPICS = ['jobs'] as const

export function useMyJobs(address: string | undefined) {
  const client = address?.toLowerCase() ?? ''
  const variables = useMemo(() => ({ client }), [client])

  const [{ data, fetching }, reexecute] = useQuery<{ jobs: MyJobEntry[] }>({
    query: MY_JOBS_QUERY,
    variables,
    pause: !client || !SUBGRAPH_URL,
  })

  // `x-fresh` обязателен: без него прокси отдаёт свою запись возрастом до
  // 120 секунд и перечитывание ничего не меняет.
  const refetch = useCallback(
    () => reexecute({ requestPolicy: 'network-only', fetchOptions: { headers: { ...FRESH_HEADERS } } }),
    [reexecute],
  )

  useGraphRefresh(GRAPH_TOPICS, refetch)

  return {
    jobs: data?.jobs ?? EMPTY,
    isLoading: fetching && !data,
    refetch,
  }
}
