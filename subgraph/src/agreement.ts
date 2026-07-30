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
  DisputeResponded,
  DisputeUnanswered,
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

// Флаги явки ставят ДВА писателя, не один: raiseDispute отмечает поднявшего на
// месте (src/Agreement.sol), а respondToDispute — второго участника. Индексировать
// только второго значит оставить поднявшему null там, где на цепи стоит true, и
// первый, кто подключит эти поля по комментарию схемы, получит ПЕРЕВЁРНУТОЕ
// предупреждение: поднявшему покажут, что молчит он.
export function handleDisputeRaised(event: DisputeRaised): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 4
  if (event.params.by.equals(a.client)) {
    a.clientResponded = true
  } else if (event.params.by.equals(a.executor)) {
    a.executorResponded = true
  }
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

export function handleDisputeResponded(event: DisputeResponded): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  // Bytes.equals, а не сравнение hex-строк: побайтово идиоматичнее и дешевле при
  // индексации — toHexString() на каждое сравнение аллоцирует строку.
  if (event.params.party.equals(a.client)) {
    a.clientResponded = true
  } else if (event.params.party.equals(a.executor)) {
    a.executorResponded = true
  }
  a.updatedAt = event.block.timestamp
  a.save()
}

// Спор закрылся таймаутом, а одна сторона на него не откликнулась: ей четверть
// котла, явившемуся остаток. Статус тот же терминальный, что у ArbiterTimedOut
// и дележа пополам — перечисление совпадает с enum Status агримента, чья
// раскладка заморожена, расширять нельзя. Исходы различают суммы.
export function handleDisputeUnanswered(event: DisputeUnanswered): void {
  let a = Agreement.load(event.address.toHexString())
  if (!a) return
  a.status = 6
  a.unansweredResponder = event.params.responder
  a.unansweredToResponder = event.params.toResponder
  a.unansweredToSilent = event.params.toSilent
  a.resolvedAt = event.block.timestamp
  a.updatedAt = event.block.timestamp
  a.save()
}
