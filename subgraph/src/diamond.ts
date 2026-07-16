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
  RequestRejected,
  RequestCancelled,
  AgreementDeployed,
} from '../generated/Diamond/Diamond'
import { Job, Service, ServiceRequest, Agreement } from '../generated/schema'
import { AgreementContract } from '../generated/templates'

export function handleJobPosted(event: JobPosted): void {
  let job = new Job(event.params.jobId.toString())
  job.client = event.params.client
  job.amount = event.params.amount
  job.region = event.params.region
  job.title = event.params.title
  job.description = event.params.description
  job.deadlineDays = event.params.deadlineDays
  job.terms = event.params.terms
  job.status = 'open'
  job.applicants = []
  job.createdAt = event.block.timestamp
  job.updatedAt = event.block.timestamp
  job.save()
}

export function handleJobEdited(event: JobEdited): void {
  let job = Job.load(event.params.jobId.toString())
  if (!job) return
  job.title = event.params.title
  job.description = event.params.description
  job.deadlineDays = event.params.deadlineDays
  job.terms = event.params.terms
  job.region = event.params.region
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
  let filtered: Array<Bytes> = []
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

  // AgreementDeployed fires before JobAccepted in the same tx — entity exists
  let agreement = Agreement.load(event.params.agreement.toHexString())
  if (agreement) {
    agreement.jobId = event.params.jobId.toString()
    agreement.save()
  }
}

export function handleJobCancelled(event: JobCancelled): void {
  let job = Job.load(event.params.jobId.toString())
  if (!job) return
  job.status = 'cancelled'
  job.updatedAt = event.block.timestamp
  job.save()
}

export function handleServicePosted(event: ServicePosted): void {
  let service = new Service(event.params.serviceId.toString())
  service.executor = event.params.executor
  service.price = event.params.price
  service.region = event.params.region
  service.title = event.params.title
  service.description = event.params.description
  service.deadlineDays = event.params.deadlineDays
  service.status = 'active'
  service.hiresCount = BigInt.fromI32(0)
  service.createdAt = event.block.timestamp
  service.updatedAt = event.block.timestamp
  service.save()
}

export function handleServiceEdited(event: ServiceEdited): void {
  let service = Service.load(event.params.serviceId.toString())
  if (!service) return
  service.title = event.params.title
  service.description = event.params.description
  service.price = event.params.price
  service.deadlineDays = event.params.deadlineDays
  service.region = event.params.region
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
  req.client = event.params.client
  req.amount = event.params.amount
  req.status = 'pending'
  req.createdAt = event.block.timestamp
  req.save()
}

export function handleRequestAccepted(event: RequestAccepted): void {
  let req = ServiceRequest.load(event.params.requestId.toString())
  if (!req) return
  req.status = 'accepted'
  req.save()
  let service = Service.load(req.serviceId)
  if (!service) return
  service.hiresCount = service.hiresCount.plus(BigInt.fromI32(1))
  service.updatedAt = event.block.timestamp
  service.save()

  // AgreementDeployed fires before RequestAccepted in the same tx — entity exists
  let agreement = Agreement.load(event.params.agreement.toHexString())
  if (agreement) {
    agreement.serviceId = req.serviceId
    agreement.requestId = event.params.requestId.toString()
    agreement.save()
  }
}

export function handleRequestRejected(event: RequestRejected): void {
  let req = ServiceRequest.load(event.params.requestId.toString())
  if (!req) return
  req.status = 'rejected'
  req.save()
}

export function handleRequestCancelled(event: RequestCancelled): void {
  let req = ServiceRequest.load(event.params.requestId.toString())
  if (!req) return
  req.status = 'cancelled'
  req.save()
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
