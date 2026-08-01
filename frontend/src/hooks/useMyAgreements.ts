import { useMemo, useCallback } from 'react'
import { useQuery } from 'urql'
import { MY_AGREEMENTS_QUERY, SUBGRAPH_URL } from '@/lib/graph'
import { FRESH_HEADERS } from '@/lib/subgraphSync'
import { useGraphRefresh } from '@/hooks/useRefreshSignal'

export interface GraphAgreement {
  id: string
  client: string
  executor: string
  amount: string
  status: number
  createdAt: string
  resolvedAt: string | null
  jobId: string | null
  serviceId: string | null
  clientWon: boolean | null
}

interface MyAgreementsData {
  asClient: GraphAgreement[]
  asExecutor: GraphAgreement[]
}

const GRAPH_TOPICS = ['deals'] as const

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

  // `network-only` обходит только кэш urql в браузере. Дальше стоит прокси
  // `/api/subgraph` со своей записью на 120 секунд, и без `x-fresh` явное
  // обновление возвращало ровно тот же снимок, что и до нажатия, — доски это
  // умели с самого начала (`useJobs`/`useServices`), дашборд не умел.
  const refetch = useCallback(
    () => reexecute({ requestPolicy: 'network-only', fetchOptions: { headers: { ...FRESH_HEADERS } } }),
    [reexecute],
  )

  // Чужое действие: контрагент оплатил, активировал, сдал работу, открыл спор.
  // Сигнал приходит из `useNotifications` уже ПОСЛЕ того, как сабграф догнал
  // блок события (см. `lib/subgraphSync`), поэтому здесь ждать больше нечего.
  useGraphRefresh(GRAPH_TOPICS, refetch)

  return {
    agreements: allAgreements,
    isLoading: fetching && !data,
    isFetching: fetching,
    error: error?.message ?? null,
    refetch,
  }
}
