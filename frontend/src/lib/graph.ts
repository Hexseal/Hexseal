import { createClient, cacheExchange, fetchExchange } from '@urql/core'

// Browser: route through /api/subgraph (same-origin, bypasses ad blockers & CORS issues)
// Server (SSR): use direct URL (relative URLs don't work server-side)
const DIRECT_SUBGRAPH_URL =
  process.env.NEXT_PUBLIC_SUBGRAPH_URL ||
  'https://api.studio.thegraph.com/query/1755241/hexseal/v0.0.3'

export const SUBGRAPH_URL =
  typeof window !== 'undefined' ? '/api/subgraph' : DIRECT_SUBGRAPH_URL

export function createGraphClient() {
  return createClient({
    url: SUBGRAPH_URL,
    exchanges: [cacheExchange, fetchExchange],
    requestPolicy: 'cache-and-network',
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
      termsHash
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
    }
    asExecutor: agreements(where: { executor: $executor }) {
      id
      client
      executor
      amount
      status
      createdAt
      resolvedAt
    }
  }
`
