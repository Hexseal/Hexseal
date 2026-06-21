import { useMemo } from 'react'
import { useQuery } from 'urql'
import { MY_JOBS_QUERY, SUBGRAPH_URL } from '@/lib/graph'

export interface MyJobEntry {
  id: string
  title: string
  amount: string
  deadlineDays: string
  status: string
  createdAt: string
}

const EMPTY: MyJobEntry[] = []

export function useMyJobs(address: string | undefined) {
  const client = address?.toLowerCase() ?? ''
  const variables = useMemo(() => ({ client }), [client])

  const [{ data, fetching }] = useQuery<{ jobs: MyJobEntry[] }>({
    query: MY_JOBS_QUERY,
    variables,
    pause: !client || !SUBGRAPH_URL,
  })

  return {
    jobs: data?.jobs ?? EMPTY,
    isLoading: fetching && !data,
  }
}
