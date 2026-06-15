import { useQuery } from 'urql'
import { MY_AGREEMENTS_QUERY } from '@/lib/graph'

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

  const [{ data, fetching, error }] = useQuery<MyAgreementsData>({
    query: MY_AGREEMENTS_QUERY,
    variables: { client: addr, executor: addr },
    pause: !addr,
  })

  const allAgreements = (() => {
    const map = new Map<string, GraphAgreement>()
    ;[...(data?.asClient ?? []), ...(data?.asExecutor ?? [])].forEach(a =>
      map.set(a.id.toLowerCase(), a)
    )
    return Array.from(map.values())
  })()

  return {
    agreements: allAgreements,
    isLoading: fetching && !data,
    isFetching: fetching,
    error: error?.message ?? null,
  }
}
