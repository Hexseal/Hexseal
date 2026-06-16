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

export function useJobs({ region, page = 0 }: { region?: number; page?: number } = {}) {
  const where: Record<string, unknown> = { status: 'open' }
  if (region !== undefined && region >= 0) where.region = region

  const [{ data, fetching, error }] = useQuery<{ jobs: GraphJob[] }>({
    query: OPEN_JOBS_QUERY,
    variables: { where, first: PAGE_SIZE, skip: page * PAGE_SIZE },
    pause: !SUBGRAPH_URL,
  })

  return {
    jobs: data?.jobs ?? [],
    isLoading: fetching && !data,
    isFetching: fetching,
    hasMore: (data?.jobs.length ?? 0) === PAGE_SIZE,
    error: error?.message ?? null,
  }
}
