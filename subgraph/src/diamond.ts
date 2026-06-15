import { BigInt, Bytes } from '@graphprotocol/graph-ts'
import {
  JobPosted,
  JobEdited,
  JobApplied,
  JobWithdrawn,
  JobAccepted,
  JobCancelled,
  ServicePosted,
  ServiceEdited,
  ServicePaused,
  ServiceUnpaused,
  ServiceRemoved,
  ServiceRequested,
  RequestAccepted,
  AgreementDeployed,
  Diamond,
} from '../generated/Diamond/Diamond'
import { Job, Service, ServiceRequest, Agreement } from '../generated/schema'
import { AgreementContract } from '../generated/templates'

export function handleJobPosted(event: JobPosted): void {
  let id = event.params.jobId.toString()
  let job = new Job(id)

  let contract = Diamond.bind(event.address)
  let result = contract.try_getJob(event.params.jobId)

  job.client = event.params.client
  job.amount = event.params.amount
  job.region = event.params.region
  job.status = 'open'
  job.applicants = []
  job.createdAt = event.block.timestamp
  job.updatedAt = event.block.timestamp

  if (!result.reverted) {
    job.title = result.value.title
    job.description = result.value.description
    job.deadlineDays = result.value.deadlineDays
    job.termsHash = result.value.termsHash
  } else {
    job.title = ''
    job.description = ''
    job.deadlineDays = BigInt.fromI32(0)
    job.termsHash = Bytes.fromHexString('0x0000000000000000000000000000000000000000000000000000000000000000')
  }

  job.save()
}

export function handleJobEdited(event: JobEdited): void {
  let job = Job.load(event.params.jobId.toString())
  if (!job) return

  let contract = Diamond.bind(event.address)
  let result = contract.try_getJob(event.params.jobId)
  if (!result.reverted) {
    job.title = result.value.title
    job.description = result.value.description
    job.deadlineDays = result.value.deadlineDays
    job.amount = result.value.amount
    job.termsHash = result.value.termsHash
  }

  job.updatedAt = event.block.timestamp
  job.save()
}

export function handleJobApplied(event: JobApplied): void {
  let job = Job.load(event.params.jobId.toString())
  if (!job) return
  let applicants = job.applicants
  applicants.push(event.params.executor)
  job.applicants = applicants
  job.updatedAt = event.block.timestamp
  job.save()
}

export function handleJobWithdrawn(event: JobWithdrawn): void {
  let job = Job.load(event.params.jobId.toString())
  if (!job) return
  let filtered: Bytes[] = []
  let applicants = job.applicants
  for (let i = 0; i < applicants.length; i++) {
    if (applicants[i] != event.params.executor) {
      filtered.push(applicants[i])
    }
  }
  job.applicants = filtered
  job.updatedAt = event.block.timestamp
  job.save()
}

export function handleJobAccepted(event: JobAccepted): void {
  let job = Job.load(event.params.jobId.toString())
  if (!job) return
  job.status = 'accepted'
  job.executor = event.params.executor
  job.agreement = event.params.agreement
  job.updatedAt = event.block.timestamp
  job.save()
}

export function handleJobCancelled(event: JobCancelled): void {
  let job = Job.load(event.params.jobId.toString())
  if (!job) return
  job.status = 'cancelled'
  job.updatedAt = event.block.timestamp
  job.save()
}

export function handleServicePosted(event: ServicePosted): void {
  let id = event.params.serviceId.toString()
  let service = new Service(id)

  let contract = Diamond.bind(event.address)
  let result = contract.try_getService(event.params.serviceId)

  service.executor = event.params.executor
  service.price = event.params.price
  service.region = event.params.region
  service.status = 'active'
  service.hiresCount = BigInt.fromI32(0)
  service.createdAt = event.block.timestamp
  service.updatedAt = event.block.timestamp

  if (!result.reverted) {
    service.title = result.value.title
    service.description = result.value.description
    service.deadlineDays = result.value.deadlineDays
  } else {
    service.title = ''
    service.description = ''
    service.deadlineDays = BigInt.fromI32(0)
  }

  service.save()
}

export function handleServiceEdited(event: ServiceEdited): void {
  let service = Service.load(event.params.serviceId.toString())
  if (!service) return

  let contract = Diamond.bind(event.address)
  let result = contract.try_getService(event.params.serviceId)
  if (!result.reverted) {
    service.title = result.value.title
    service.description = result.value.description
    service.price = result.value.price
    service.deadlineDays = result.value.deadlineDays
  }

  service.updatedAt = event.block.timestamp
  service.save()
}

export function handleServicePaused(event: ServicePaused): void {
  let service = Service.load(event.params.serviceId.toString())
  if (!service) return
  service.status = 'paused'
  service.updatedAt = event.block.timestamp
  service.save()
}

export function handleServiceUnpaused(event: ServiceUnpaused): void {
  let service = Service.load(event.params.serviceId.toString())
  if (!service) return
  service.status = 'active'
  service.updatedAt = event.block.timestamp
  service.save()
}

export function handleServiceRemoved(event: ServiceRemoved): void {
  let service = Service.load(event.params.serviceId.toString())
  if (!service) return
  service.status = 'removed'
  service.updatedAt = event.block.timestamp
  service.save()
}

export function handleServiceRequested(event: ServiceRequested): void {
  let req = new ServiceRequest(event.params.requestId.toString())
  req.serviceId = event.params.serviceId.toString()
  req.save()
}

export function handleRequestAccepted(event: RequestAccepted): void {
  let req = ServiceRequest.load(event.params.requestId.toString())
  if (!req) return
  let service = Service.load(req.serviceId)
  if (!service) return
  service.hiresCount = service.hiresCount.plus(BigInt.fromI32(1))
  service.updatedAt = event.block.timestamp
  service.save()
}

export function handleAgreementDeployed(event: AgreementDeployed): void {
  let agreement = new Agreement(event.params.agreement.toHexString())
  agreement.client = event.params.client
  agreement.executor = event.params.executor
  agreement.amount = event.params.amount
  agreement.region = event.params.region
  agreement.fee = event.params.fee
  agreement.status = 0
  agreement.createdAt = event.block.timestamp
  agreement.updatedAt = event.block.timestamp
  agreement.save()

  AgreementContract.create(event.params.agreement)
}
