import { Agreement } from '../generated/schema'
import {
  Funded,
  Activated,
  Released,
  AutoApproved,
  DisputeRaised,
  DisputeResolved,
  TimedOut,
  ArbiterTimedOut,
} from '../generated/templates/AgreementContract/Agreement'

export function handleFunded(event: Funded): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 1
  a.updatedAt = event.block.timestamp
  a.save()
}

export function handleActivated(event: Activated): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 2
  a.updatedAt = event.block.timestamp
  a.save()
}

export function handleReleased(event: Released): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 3
  a.resolvedAt = event.block.timestamp
  a.updatedAt = event.block.timestamp
  a.save()
}

export function handleAutoApproved(event: AutoApproved): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 3
  a.resolvedAt = event.block.timestamp
  a.updatedAt = event.block.timestamp
  a.save()
}

export function handleDisputeRaised(event: DisputeRaised): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 4
  a.updatedAt = event.block.timestamp
  a.save()
}

export function handleDisputeResolved(event: DisputeResolved): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 5
  a.resolvedAt = event.block.timestamp
  a.updatedAt = event.block.timestamp
  a.save()
}

export function handleTimedOut(event: TimedOut): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 6
  a.resolvedAt = event.block.timestamp
  a.updatedAt = event.block.timestamp
  a.save()
}

export function handleArbiterTimedOut(event: ArbiterTimedOut): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 6
  a.resolvedAt = event.block.timestamp
  a.updatedAt = event.block.timestamp
  a.save()
}
