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
  DisputeSplitNoVerdict,
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
  a.clientWon = event.params.clientWins
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

// Спор закрылся без вердикта, потому что за него никто не взялся: котёл поделен
// пополам. Статус тот же терминальный, что у ArbiterTimedOut — расширять
// перечисление нельзя, оно совпадает с enum Status агримента, чья раскладка
// заморожена. Различают эти два исхода суммы: у полного возврата они пустые.
//
// Агримент в этой ветке ArbiterTimedOut намеренно НЕ эмитит (наказывать некого),
// так что без этого хендлера сделка висела бы в статусе «спор» вечно.
export function handleDisputeSplitNoVerdict(event: DisputeSplitNoVerdict): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 6
  a.splitToClient = event.params.toClient
  a.splitToExecutor = event.params.toExecutor
  a.resolvedAt = event.block.timestamp
  a.updatedAt = event.block.timestamp
  a.save()
}
