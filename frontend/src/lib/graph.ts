import { createClient, cacheExchange, fetchExchange } from '@urql/core'

// Browser: /api/subgraph proxy (same-origin, URL never baked into client bundle).
// SSR: direct URL (relative paths don't work server-side).
// To change subgraph version set SUBGRAPH_URL (no NEXT_PUBLIC_ prefix) in Vercel —
// it's read at runtime by the proxy, no redeploy needed.
export const SUBGRAPH_URL =
  typeof window !== 'undefined'
    ? '/api/subgraph'
    : 'https://api.studio.thegraph.com/query/1755241/hexseal/v0.0.3'

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
