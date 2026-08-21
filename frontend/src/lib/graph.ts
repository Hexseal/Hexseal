import { createClient, cacheExchange, fetchExchange } from '@urql/core'

// Browser always uses the /api/subgraph proxy — URL never baked into the client bundle.
// SSR uses SUBGRAPH_URL env var (server-only, no NEXT_PUBLIC_ prefix).
// To change subgraph version: update SUBGRAPH_URL in Vercel env vars, no code change needed.
export const SUBGRAPH_URL =
  typeof window !== 'undefined' ? '/api/subgraph' : (process.env.SUBGRAPH_URL ?? '')

export function createGraphClient() {
  return createClient({
    url: SUBGRAPH_URL,
    exchanges: [cacheExchange, fetchExchange],
    requestPolicy: 'cache-and-network',
    // urql v6 defaults to GET ('within-url-limit') — our proxy only handles POST
    preferGetMethod: false,
  })
}

export const OPEN_JOBS_QUERY = `
  query OpenJobs($where: Job_filter!, $first: Int!, $skip: Int!) {
    jobs(
      where: $where
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      client
      title
      description
      amount
      deadlineDays
      terms
      region
      status
      applicants
      createdAt
    }
  }
`

export const OPEN_SERVICES_QUERY = `
  query OpenServices($where: Service_filter!, $first: Int!, $skip: Int!) {
    services(
      where: $where
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      executor
      title
      description
      price
      deadlineDays
      region
      status
      hiresCount
      createdAt
    }
  }
`

export const MY_JOBS_QUERY = `
  query MyJobs($client: Bytes!) {
    jobs(where: { client: $client }, first: 100, orderBy: createdAt, orderDirection: desc) {
      id
      title
      amount
      deadlineDays
      status
      createdAt
    }
  }
`

export const MY_SERVICES_QUERY = `
  query MyServices($executor: Bytes!) {
    services(where: { executor: $executor }, first: 100, orderBy: createdAt, orderDirection: desc) {
      id
      title
      price
      deadlineDays
      status
      createdAt
    }
  }
`

export const MY_AGREEMENTS_QUERY = `
  query MyAgreements($client: Bytes!, $executor: Bytes!) {
    asClient: agreements(where: { client: $client }) {
      id
      client
      executor
      amount
      status
      createdAt
      resolvedAt
      jobId
      serviceId
      clientWon
    }
    asExecutor: agreements(where: { executor: $executor }) {
      id
      client
      executor
      amount
      status
      createdAt
      resolvedAt
      jobId
      serviceId
      clientWon
    }
  }
`

// jobId/serviceId on Agreement are set (via handleJobAccepted/handleRequestAccepted) in the
// same tx as AgreementDeployed, so they're already resolvable straight off the rows above —
// no need to reverse-lookup through getClientJobs/getExecutorServices on-chain.
export const AGREEMENT_JOB_TITLES_QUERY = `
  query AgreementJobTitles($ids: [String!]!) {
    jobs(where: { id_in: $ids }) {
      id
      title
    }
  }
`

export const AGREEMENT_SERVICE_TITLES_QUERY = `
  query AgreementServiceTitles($ids: [String!]!) {
    services(where: { id_in: $ids }) {
      id
      title
    }
  }
`

/**
 * Обвинение, которое цепь положила САМА, и ВСЕ споры, на которых оно стоит.
 *
 * ⚠️ ПОЧЕМУ СПОРЫ БЕРУТСЯ У САБГРАФА, А НЕ У ЦЕПИ. Решение владельца 15а
 * (замысел сноса): обвиняемый обязан видеть КАЖДЫЙ спор, на котором стоит
 * обвинение, а не последний из них. Событие `RemovalProposedByChain` несёт
 * ОДИН договор — тот, что перевесил, — а обвинение стоит на трёх; остальные
 * лежат в журнале и больше нигде, потому что хранить их массивом стоило бы
 * записи на каждом из пяти писателей счётчика в фасете, у которого осталось 6%
 * бюджета байткода. `ChainAccusation.disputes` — этот список, замороженный на
 * момент обвинения (`Arbiter.currentSeries` продолжает ехать, этот — нет).
 *
 * ⚠️ `disputeCount` НИЖЕ ПОРОГА ЦЕПИ ЗНАЧИТ «ЛЕНТА ЧТО-ТО ПРОПУСТИЛА», а не
 * «споров было меньше» — так сказано в самой схеме. Экран обязан различать: это
 * повод посмотреть, а не пожать плечами.
 *
 * ⚠️ СЕГОДНЯ ЭТОТ ЗАПРОС НЕ ОТВЕТИТ. В цепи работает сабграф v2.3.0, где
 * сущности `ChainAccusation` нет вовсе; версия с ней в репозитории и не
 * выкачена. Значит потребитель обязан пережить отказ и сказать про него
 * человеческими словами — так же, как экран говорит про несмонтированный фасет.
 */
export const CHAIN_ACCUSATION_QUERY = `
  query ChainAccusation($arbiter: ID!) {
    arbiter(id: $arbiter) {
      id
      chainAccusationCount
      openChainAccusation {
        id
        path
        agreement
        proposedAt
        disputes
        disputeCount
        answeredAt
        clearedAt
        withdrawnAt
        voidedAt
      }
    }
  }
`
