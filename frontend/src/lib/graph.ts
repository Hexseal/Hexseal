import { createClient, cacheExchange, fetchExchange } from '@urql/core'

export function createGraphClient() {
  return createClient({
    url: process.env.NEXT_PUBLIC_SUBGRAPH_URL!,
    exchanges: [cacheExchange, fetchExchange],
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
