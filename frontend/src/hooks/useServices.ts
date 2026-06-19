import { useMemo } from 'react'
import { useQuery } from 'urql'
import { OPEN_SERVICES_QUERY } from '@/lib/graph'

export interface GraphService {
  id: string
  executor: string
  title: string
  description: string
  price: string
  deadlineDays: string
  region: number
  status: string
  hiresCount: string
  createdAt: string
}

const PAGE_SIZE = 20
const EMPTY_SERVICES: GraphService[] = []

export function useServices({ region, page = 0 }: { region?: number; page?: number } = {}) {
  const variables = useMemo(() => {
    const where: Record<string, unknown> = { status: 'active' }
    if (region !== undefined && region >= 0) where.region = region
    return { where, first: PAGE_SIZE, skip: page * PAGE_SIZE }
  }, [region, page])

  const [{ data, fetching, error }] = useQuery<{ services: GraphService[] }>({
    query: OPEN_SERVICES_QUERY,
    variables,
  })

  return {
    services: data?.services ?? EMPTY_SERVICES,
    isLoading: fetching && !data,
    isFetching: fetching,
    hasMore: (data?.services.length ?? 0) === PAGE_SIZE,
    error: error?.message ?? null,
  }
}
