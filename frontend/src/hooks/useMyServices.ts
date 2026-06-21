import { useMemo } from 'react'
import { useQuery } from 'urql'
import { MY_SERVICES_QUERY, SUBGRAPH_URL } from '@/lib/graph'

export interface MyServiceEntry {
  id: string
  title: string
  price: string
  deadlineDays: string
  status: string
  createdAt: string
}

const EMPTY: MyServiceEntry[] = []

export function useMyServices(address: string | undefined) {
  const executor = address?.toLowerCase() ?? ''
  const variables = useMemo(() => ({ executor }), [executor])

  const [{ data, fetching }] = useQuery<{ services: MyServiceEntry[] }>({
    query: MY_SERVICES_QUERY,
    variables,
    pause: !executor || !SUBGRAPH_URL,
  })

  return {
    services: data?.services ?? EMPTY,
    isLoading: fetching && !data,
  }
}
