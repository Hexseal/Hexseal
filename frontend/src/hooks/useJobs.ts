import { useMemo } from 'react'
import { useQuery } from 'urql'
import { OPEN_JOBS_QUERY, SUBGRAPH_URL } from '@/lib/graph'

export interface GraphJob {
  id: string
  client: string
  title: string
  description: string
  amount: string
  deadlineDays: string
  termsHash: string
  region: number
  status: string
  applicants: string[]
  createdAt: string
}

const PAGE_SIZE = 20
const EMPTY_JOBS: GraphJob[] = []

export function useJobs({ region, page = 0 }: { region?: number; page?: number } = {}) {
  const variables = useMemo(() => {
    const where: Record<string, unknown> = { status: 'open' }
    if (region !== undefined && region >= 0) where.region = region
    return { where, first: PAGE_SIZE, skip: page * PAGE_SIZE }
  }, [region, page])

  const [{ data, fetching, error }] = useQuery<{ jobs: GraphJob[] }>({
    query: OPEN_JOBS_QUERY,
    variables,
    pause: !SUBGRAPH_URL,
  })

  return {
    jobs: data?.jobs ?? EMPTY_JOBS,
    isLoading: fetching && !data,
    isFetching: fetching,
    hasMore: (data?.jobs.length ?? 0) === PAGE_SIZE,
    error: error?.message ?? null,
  }
}
