import { Address, ethereum, log } from '@graphprotocol/graph-ts'
import {
  ArbiterSeated,
  ArbiterResigned,
  ArbiterDemoted,
  ArbiterSuspended,
  ArbiterSuspensionLifted,
  ArbiterRemovedForCause,
  RemovalProposed,
  RemovalProposalWithdrawn,
  RemovalProposalConsumed,
  RemovalAnswered,
} from '../generated/DiamondArbiter/Diamond'
import {
  Arbiter,
  ArbiterSeating,
  ArbiterResignation,
  ArbiterDemotion,
  ArbiterRemoval,
  ArbiterSuspension,
  ArbiterSuspensionLift,
  RemovalProposal,
  RemovalAnswer,
} from '../generated/schema'

// Arbiter accountability, the outside half. What is worth knowing before
// reading anything below:
//
//   • The chain already answers "who was removed, when, on what cause, how
//     many times" through getArbiterStanding(). It does NOT answer when the
//     accused replied — getRemovalReply() is a digest with no moment. That
//     moment is the reason these handlers exist; the rest is history the card
//     view cannot hold.
//   • No cause is named here and no verification is inferred. `cause` and
//     `path` are stored as the raw numbers the log carries, and
//     verifiedByChain is copied from the event rather than computed. The
//     naming lives in the frontend, where the table is held against both .sol
//     sources by a lock.
//   • These events do not exist on chain yet — the cut is not made. Handlers
//     that are never called are the expected state until it is.

function recordId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + '-' + event.logIndex.toString()
}

function loadOrCreateArbiter(addr: Address, event: ethereum.Event): Arbiter {
  let id = addr.toHexString()
  let existing = Arbiter.load(id)
  if (existing !== null) {
    existing.updatedAt = event.block.timestamp
    return existing as Arbiter
  }

  let created = new Arbiter(id)
  created.address = addr
  created.seated = false
  created.selfSeated = false
  created.firstSeenAt = event.block.timestamp
  created.updatedAt = event.block.timestamp
  created.seatingCount = 0
  created.resignationCount = 0
  created.demotionCount = 0
  created.removalForCauseCount = 0
  created.suspensionCount = 0
  created.suspensionLiftCount = 0
  created.removalProposalCount = 0
  created.answerCount = 0
  return created
}

// A proposal the chain has thrown away without saying so.
//
// ArbiterRegistryStorage.clearSeat wipes removalProposals on every exit door,
// and two of those doors — resignAsArbiter and the automatic demotion — emit
// nothing about it. Leaving the record open would put a standing accusation on
// a card next to getArbiterStanding().hasLiveRemovalProposal reading false.
// This is a copy of contract behaviour and is marked as one in schema.graphql:
// the fix is an event, not a better copy.
//
// The third caller, `superseded`, is not a copy of anything hidden: a second
// RemovalProposed for the same arbiter overwrites the first in storage, and
// that is visible in the log stream itself.
function voidOpenProposal(arbiter: Arbiter, reason: string, event: ethereum.Event): void {
  let proposalId = arbiter.latestProposal
  if (proposalId === null) return

  let proposal = RemovalProposal.load(proposalId as string)
  if (proposal === null) return
  if (proposal.withdrawnAt !== null || proposal.consumedAt !== null || proposal.voidedAt !== null) return

  proposal.voidedAt = event.block.timestamp
  proposal.voidedReason = reason
  proposal.save()
}

export function handleArbiterSeated(event: ArbiterSeated): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.seated = true
  arbiter.seatedAt = event.block.timestamp
  arbiter.seatedBy = event.params.by
  arbiter.selfSeated = event.params.selfService
  arbiter.exitKind = null
  arbiter.exitAt = null
  // Both entry doors call ArbiterRegistryStorage.clearRemovalRecord, so the
  // standing accusation against this address is gone from the chain and the
  // pointers have to go with it. The removal and demotion records themselves
  // stay — history is not erased, only the "currently answerable" link.
  arbiter.openRemoval = null
  arbiter.openDemotion = null
  arbiter.seatingCount = arbiter.seatingCount + 1
  arbiter.save()

  let seating = new ArbiterSeating(recordId(event))
  seating.arbiter = arbiter.id
  seating.kind = 'seated'
  seating.by = event.params.by
  seating.timestamp = event.block.timestamp
  seating.blockNumber = event.block.number
  seating.txHash = event.transaction.hash
  seating.selfService = event.params.selfService
  seating.save()
}

export function handleArbiterResigned(event: ArbiterResigned): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.seated = false
  arbiter.exitKind = 'resigned'
  arbiter.exitAt = event.block.timestamp
  arbiter.resignationCount = arbiter.resignationCount + 1
  voidOpenProposal(arbiter, 'resigned', event)
  arbiter.save()

  let resignation = new ArbiterResignation(recordId(event))
  resignation.arbiter = arbiter.id
  resignation.kind = 'resigned'
  // resignAsArbiter is gasless and takes _msgSender(); the only address it can
  // ever act on is the caller's own, so the arbiter is the presser.
  resignation.by = event.params.arbiter
  resignation.timestamp = event.block.timestamp
  resignation.blockNumber = event.block.number
  resignation.txHash = event.transaction.hash
  resignation.bondRefunded = event.params.bondRefunded
  resignation.save()
}

export function handleArbiterDemoted(event: ArbiterDemoted): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.seated = false
  arbiter.exitKind = 'demoted'
  arbiter.exitAt = event.block.timestamp
  arbiter.demotionCount = arbiter.demotionCount + 1

  let demotion = new ArbiterDemotion(recordId(event))
  demotion.arbiter = arbiter.id
  demotion.kind = 'demoted'
  // Zero here is the contract's assertion that nobody pressed: the
  // AgreementTimeout and AppealVote paths have no person behind them.
  demotion.by = event.params.by
  demotion.timestamp = event.block.timestamp
  demotion.blockNumber = event.block.number
  demotion.txHash = event.transaction.hash
  demotion.path = event.params.path
  demotion.agreement = event.params.agreement
  demotion.ordinal = arbiter.demotionCount
  demotion.save()

  // An automatic demotion sets removedAt exactly as a removal for cause does,
  // so respondToRemoval is open to this person and the reply must have
  // something to hang off.
  arbiter.openDemotion = demotion.id
  arbiter.openRemoval = null
  voidOpenProposal(arbiter, 'demoted', event)
  arbiter.save()
}

export function handleArbiterSuspended(event: ArbiterSuspended): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.suspensionCount = arbiter.suspensionCount + 1

  let suspension = new ArbiterSuspension(recordId(event))
  suspension.arbiter = arbiter.id
  suspension.kind = 'suspended'
  suspension.by = event.params.by
  suspension.timestamp = event.block.timestamp
  suspension.blockNumber = event.block.number
  suspension.txHash = event.transaction.hash
  suspension.until = event.params.until
  suspension.save()

  arbiter.latestSuspension = suspension.id
  arbiter.save()
}

export function handleArbiterSuspensionLifted(event: ArbiterSuspensionLifted): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.suspensionLiftCount = arbiter.suspensionLiftCount + 1
  arbiter.save()

  let lift = new ArbiterSuspensionLift(recordId(event))
  lift.arbiter = arbiter.id
  lift.kind = 'suspensionLifted'
  lift.by = event.params.by
  lift.timestamp = event.block.timestamp
  lift.blockNumber = event.block.number
  lift.txHash = event.transaction.hash

  // Attach to the announced suspension when there is one still open. There
  // need not be: liftSuspension emits unconditionally and is reachable against
  // the window a removal opened silently, and against an address with no
  // window at all. The lift is recorded either way — that case is the one a
  // reader most wants to see.
  let suspensionId = arbiter.latestSuspension
  if (suspensionId !== null) {
    let suspension = ArbiterSuspension.load(suspensionId as string)
    if (suspension !== null && suspension.liftedAt === null) {
      suspension.liftedAt = event.block.timestamp
      suspension.liftedBy = event.params.by
      suspension.lift = lift.id
      suspension.save()
      lift.suspension = suspension.id
    }
  }

  lift.save()
}

export function handleArbiterRemovedForCause(event: ArbiterRemovedForCause): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.seated = false
  arbiter.exitKind = 'removedForCause'
  arbiter.exitAt = event.block.timestamp
  arbiter.removalForCauseCount = arbiter.removalForCauseCount + 1

  let removal = new ArbiterRemoval(recordId(event))
  removal.arbiter = arbiter.id
  removal.kind = 'removedForCause'
  removal.by = event.params.by
  removal.timestamp = event.block.timestamp
  removal.blockNumber = event.block.number
  removal.txHash = event.transaction.hash
  removal.cause = event.params.cause
  // Straight from the log, never recomputed: this boolean is the whole point
  // of the record. Three of the six causes the chain checks against its own
  // state; the other three it only notarises with a digest it never read.
  removal.verifiedByChain = event.params.verifiedByChain
  removal.evidenceDigest = event.params.evidenceDigest
  removal.bondForfeited = event.params.bondForfeited
  removal.ordinal = arbiter.removalForCauseCount
  removal.save()

  arbiter.openRemoval = removal.id
  arbiter.openDemotion = null
  arbiter.save()
}

export function handleRemovalProposed(event: RemovalProposed): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.removalProposalCount = arbiter.removalProposalCount + 1
  // One live proposal per arbiter: a second one overwrites the first in
  // storage, so the record it replaces is closed here.
  voidOpenProposal(arbiter, 'superseded', event)

  let proposal = new RemovalProposal(recordId(event))
  proposal.arbiter = arbiter.id
  proposal.kind = 'removalProposed'
  proposal.by = event.params.by
  proposal.timestamp = event.block.timestamp
  proposal.blockNumber = event.block.number
  proposal.txHash = event.transaction.hash
  proposal.cause = event.params.cause
  proposal.evidenceDigest = event.params.evidenceDigest
  proposal.reconstructed = false
  proposal.save()

  arbiter.latestProposal = proposal.id
  arbiter.save()
}

// No record of its own, unlike the suspension lift: withdrawProposal only
// emits when a proposal was actually there (Minor 3 of the first revision
// round — an empty withdrawal in the feed reads as "something was held against
// them and it was dropped"). So a withdrawal always has a proposal to close,
// and closing it is the whole of the news.
export function handleRemovalProposalWithdrawn(event: RemovalProposalWithdrawn): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.save()

  let proposalId = arbiter.latestProposal
  if (proposalId === null) {
    log.warning('RemovalProposalWithdrawn for {} with no proposal indexed (tx {})', [
      event.params.arbiter.toHexString(),
      event.transaction.hash.toHexString(),
    ])
    return
  }

  let proposal = RemovalProposal.load(proposalId as string)
  if (proposal === null) {
    log.warning('RemovalProposalWithdrawn for {}: proposal {} missing from store', [
      event.params.arbiter.toHexString(),
      proposalId as string,
    ])
    return
  }

  // The chain only emits this when a live proposal was actually in storage, so
  // finding an already closed one means the mirror has drifted. Say so rather
  // than stamping a withdrawal over a consumption.
  if (proposal.consumedAt !== null || proposal.voidedAt !== null || proposal.withdrawnAt !== null) {
    log.warning('RemovalProposalWithdrawn for {}: proposal {} was already closed', [
      event.params.arbiter.toHexString(),
      proposalId as string,
    ])
    return
  }

  proposal.withdrawnAt = event.block.timestamp
  proposal.withdrawnBy = event.params.by
  proposal.save()
}

// Fires in the same transaction as ArbiterRemovedForCause and after it — the
// contract emits the removal first, then this. That ordering is what lets the
// removal already be in the store here.
export function handleRemovalProposalConsumed(event: RemovalProposalConsumed): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.save()

  let proposal = matchConsumedProposal(arbiter, event)
  proposal.consumedAt = event.block.timestamp

  let removalId = arbiter.openRemoval
  if (removalId === null) {
    log.warning('RemovalProposalConsumed for {} with no removal in the same tx {}', [
      event.params.arbiter.toHexString(),
      event.transaction.hash.toHexString(),
    ])
    proposal.save()
    return
  }

  let removal = ArbiterRemoval.load(removalId as string)
  if (removal === null) {
    log.warning('RemovalProposalConsumed for {}: removal {} missing from store', [
      event.params.arbiter.toHexString(),
      removalId as string,
    ])
    proposal.save()
    return
  }

  proposal.consumedByRemoval = removal.id
  proposal.save()
  removal.consumedProposal = proposal.id
  removal.save()
}

// The consumed snapshot names the proposal it erased: cause, digest, proposer
// and the moment it was made. Held against the proposal this indexer thinks is
// the live one, because agreeing with the chain is the only thing that makes
// the link worth having. On disagreement the snapshot wins and becomes a
// record of its own — dropping it would lose the one copy that exists.
function matchConsumedProposal(arbiter: Arbiter, event: RemovalProposalConsumed): RemovalProposal {
  let proposalId = arbiter.latestProposal
  if (proposalId !== null) {
    let held = RemovalProposal.load(proposalId as string)
    if (
      held !== null &&
      held.timestamp.equals(event.params.proposedAt) &&
      held.by.equals(event.params.proposedBy) &&
      held.cause == event.params.proposedCause
    ) {
      return held as RemovalProposal
    }
    log.warning('RemovalProposalConsumed for {} does not match indexed proposal (tx {})', [
      event.params.arbiter.toHexString(),
      event.transaction.hash.toHexString(),
    ])
  }

  let rebuilt = new RemovalProposal(recordId(event))
  rebuilt.arbiter = arbiter.id
  rebuilt.kind = 'removalProposed'
  rebuilt.by = event.params.proposedBy
  rebuilt.timestamp = event.params.proposedAt
  rebuilt.blockNumber = event.block.number
  rebuilt.txHash = event.transaction.hash
  rebuilt.cause = event.params.proposedCause
  rebuilt.evidenceDigest = event.params.evidenceDigest
  rebuilt.reconstructed = true
  return rebuilt
}

export function handleRemovalAnswered(event: RemovalAnswered): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.answerCount = arbiter.answerCount + 1
  arbiter.save()

  let answer = new RemovalAnswer(recordId(event))
  answer.arbiter = arbiter.id
  answer.kind = 'removalAnswered'
  // respondToRemoval reads _msgSender(), so the address in the log is the
  // human who answered even when a relayer paid the gas.
  answer.by = event.params.arbiter
  answer.timestamp = event.block.timestamp
  answer.blockNumber = event.block.number
  answer.txHash = event.transaction.hash
  answer.replyDigest = event.params.replyDigest

  // Hang the answer off whichever accusation is open. The contract allows one
  // reply per removal record and clears the slot on re-seating, so at most one
  // of the two pointers is set.
  let removalId = arbiter.openRemoval
  let demotionId = arbiter.openDemotion

  if (removalId !== null) {
    let removal = ArbiterRemoval.load(removalId as string)
    if (removal !== null) {
      removal.answer = answer.id
      removal.answeredAt = event.block.timestamp
      removal.save()
      answer.removal = removal.id
    }
  } else if (demotionId !== null) {
    let demotion = ArbiterDemotion.load(demotionId as string)
    if (demotion !== null) {
      demotion.answer = answer.id
      demotion.answeredAt = event.block.timestamp
      demotion.save()
      answer.demotion = demotion.id
    }
  } else {
    log.warning('RemovalAnswered by {} with no open accusation indexed (tx {})', [
      event.params.arbiter.toHexString(),
      event.transaction.hash.toHexString(),
    ])
  }

  answer.save()
}
