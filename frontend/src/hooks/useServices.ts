import { useMemo, useCallback } from 'react'
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

  const [{ data, fetching, error }, reexecuteQuery] = useQuery<{ services: GraphService[] }>({
    query: OPEN_SERVICES_QUERY,
    variables,
  })

  const refetch = useCallback(() => {
    // x-fresh makes the /api/subgraph proxy bypass its server-side cache
    reexecuteQuery({ requestPolicy: 'network-only', fetchOptions: { headers: { 'x-fresh': '1' } } });
  }, [reexecuteQuery]);

  // ПОДПИСКИ НА КАНАЛ `graph` ЗДЕСЬ НАМЕРЕННО НЕТ — в отличие от парных
  // `useMyJobs`/`useMyServices`. Доска постраничная, страницы склеиваются
  // накопительно (`lib/boardPaging`, фикс d04b8cc «доска услуг двоит строки при
  // обновлении со второй страницы»): самопроизвольное перечитывание в
  // произвольный момент — ровно тот сценарий, из которого тот баг и вырос.
  // Сброс кэша прокси действия доски всё равно запускают (`app/board/page.tsx`),
  // так что следующий заход и соседние вкладки получают свежее; не обновляется
  // только этот список и только пока его листают. Уговор общий для обоих
  // хуков — правь оба.

  return {
    services: data?.services ?? EMPTY_SERVICES,
    isLoading: fetching && !data,
    isFetching: fetching,
    hasMore: (data?.services.length ?? 0) === PAGE_SIZE,
    error: error?.message ?? null,
    refetch,
  }
}
