import { Address, Bytes, ethereum, log } from '@graphprotocol/graph-ts'
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
  RemovalReasonGiven,
  RemovalReplyGiven,
  RemovalProposedByChain,
  ChainAccusationCleared,
  VerdictSubmitted,
  VerdictOverturned,
  VerdictFinalized,
  AppealResolved,
  ArbiterTimeoutRecorded,
} from '../generated/Diamond/Diamond'
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
  ChainAccusation,
  RemovalReason,
  RemovalReply,
  Verdict,
  VerdictOverturn,
  ArbiterTimeout,
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
  created.timeoutCount = 0
  created.chainAccusationCount = 0
  created.currentSeries = []
  created.cleanVerdicts = 0
  created.overturnedVerdicts = 0
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

// The chain's own accusation, thrown away by the same silent line. clearSeat
// deletes removalProposals whichever exit door was taken, and the chain's
// accusation lives in that same slot — so a resignation and the removal that
// the accusation itself led to both erase it without a word. Same copy of
// contract behaviour as voidOpenProposal above, same warning in schema.graphql,
// same way out: an event.
function voidOpenChainAccusation(arbiter: Arbiter, reason: string, event: ethereum.Event): void {
  let id = arbiter.openChainAccusation
  if (id === null) return

  arbiter.openChainAccusation = null

  let accusation = ChainAccusation.load(id as string)
  if (accusation === null) return
  if (accusation.clearedAt !== null || accusation.withdrawnAt !== null || accusation.voidedAt !== null) return

  accusation.voidedAt = event.block.timestamp
  accusation.voidedReason = reason
  accusation.save()
}

// The proposal an answer given DURING THE PAUSE is answering, or null.
//
// "Live" is a weaker word here than in the contract, on purpose: hasLiveProposal
// also compares against PROPOSAL_TTL, and an indexer has no clock of its own —
// see the note on Arbiter.latestProposal. What is checked is what a log can
// state: nothing has withdrawn, consumed or voided it.
function liveProposal(arbiter: Arbiter): RemovalProposal | null {
  let id = arbiter.latestProposal
  if (id === null) return null

  let proposal = RemovalProposal.load(id as string)
  if (proposal === null) return null
  if (proposal.withdrawnAt !== null || proposal.consumedAt !== null || proposal.voidedAt !== null) return null
  return proposal
}

// ── THE RUNNING MISTAKE STREAK ───────────────────────────────────────────────
//
// Three operations, each mirroring one the contract performs on
// arbiterMistakeStreak, and nothing else touches the list.

/** One more judicial mistake, on this dispute. */
function pushSeries(arbiter: Arbiter, agreement: Address): void {
  let series = arbiter.currentSeries
  series.push(agreement)
  arbiter.currentSeries = series
}

/** The streak is broken: `d.arbiterMistakeStreak[x] = 0`. */
function clearSeries(arbiter: Arbiter): void {
  arbiter.currentSeries = []
}

// One mistake taken back: `if (streak > 0) streak - 1`, the line resolveAppeal
// runs when a panel restores the arbiter's own ruling.
//
// The dispute being vindicated is named, so the entry for it is the one that
// goes. When it is NOT in the list the LAST entry goes instead, and that is a
// deliberate copy of what the contract does rather than a fallback: the chain
// subtracts one from a bare counter without asking which mistake it belongs to,
// so a vindication arriving after the streak has already been broken and
// rebuilt takes one off the NEW streak. Copying the arithmetic keeps the list
// the same length as the counter it mirrors; being cleverer here would make
// them disagree.
function takeBackFromSeries(arbiter: Arbiter, agreement: Address): void {
  let series = arbiter.currentSeries
  if (series.length == 0) return

  let kept: Array<Bytes> = []
  let dropped = false
  for (let i = 0; i < series.length; i++) {
    if (!dropped && series[i] == agreement) {
      dropped = true
      continue
    }
    kept.push(series[i])
  }
  if (!dropped) kept.pop()
  arbiter.currentSeries = kept
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
  // Nulled without stamping anything: a chain accusation cannot reach a
  // re-seating alive. Every exit door runs clearSeat, which deletes the
  // proposal slot the chain writes into, so it was closed on the way out — and
  // an arbiter who never left cannot be seated again (AlreadyArbiter). The line
  // is here so that a future entry door which skips clearSeat leaves no
  // accusation pointing at a seated man.
  arbiter.openChainAccusation = null
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
  voidOpenChainAccusation(arbiter, 'resigned', event)
  // ⚠️ THE STREAK IS NOT CLEARED HERE, and that is the contract's arithmetic
  // rather than an omission: clearSeat erases the proposal and the saved path,
  // and leaves arbiterMistakeStreak exactly where the mistakes left it. A man
  // who resigns under two mistakes and is seated again still carries them.
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

  // The removal for cause and the chain's own removal share one body, so both
  // write removedAt and both open respondToRemoval to this person — the reply
  // must have something to hang off. (The sentence here used to credit the
  // THIRD MISTAKE with setting removedAt; task 12 moved the unseating to
  // executeChainRemoval, which is the event this handler serves.)
  arbiter.openDemotion = demotion.id
  arbiter.openRemoval = null
  voidOpenProposal(arbiter, 'demoted', event)
  // ⚠️ THIS IS THE LINE THE WHOLE CHAIN-ACCUSATION HALF WAS MISSING. The
  // removal this record announces is the EXECUTION of an accusation the chain
  // laid two days earlier, and until RemovalProposedByChain was indexed the
  // feed had never shown that accusation: a reader saw a seat taken away with
  // no accuser, no pause and no answer — which is the exact appearance the
  // branch was built to get rid of.
  voidOpenChainAccusation(arbiter, 'demoted', event)
  // _performRemoval sets arbiterMistakeStreak to zero on its way out: the
  // evidence has been spent on this removal.
  clearSeries(arbiter)
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
  // Unreachable in principle and mirrored anyway: removeArbiterForCause refuses
  // a chain-laid proposal outright (ChainProposalNeedsTheChainDoor), and the two
  // kinds of accusation cannot stand at once because they share one storage
  // slot. If one ever does reach here, clearSeat erases it — so the record must
  // not be left open.
  voidOpenChainAccusation(arbiter, 'removedForCause', event)
  // The same _performRemoval as the demotion above, and the same zeroing.
  clearSeries(arbiter)
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

  // ⚠️ ONE EVENT, TWO KINDS OF ACCUSATION, AND THE LOG DOES NOT SAY WHICH.
  // withdrawProposal emits the same line whether it is clearing a director's
  // proposal or the chain's own; only the storage it read tells them apart, and
  // the storage is gone by then. Here they are told apart by exclusion, which
  // is sound rather than convenient: both live in the SAME slot
  // (d.removalProposals), proposeRemoval refuses to overwrite a standing record
  // and _recordArbiterMistake yields to one, so at most one of the two can be
  // open at a time.
  //
  // The difference is not cosmetic. Withdrawing the CHAIN's accusation zeroes
  // arbiterMistakeStreak — "leave the streak standing and he walks away one
  // overturn short of the same accusation being laid again" — while
  // withdrawing a person's says nothing about his mistakes and clears nothing.
  let chainId = arbiter.openChainAccusation
  if (chainId !== null) {
    let accusation = ChainAccusation.load(chainId as string)
    arbiter.openChainAccusation = null
    clearSeries(arbiter)
    arbiter.save()

    if (accusation === null) {
      log.warning('RemovalProposalWithdrawn for {}: chain accusation {} missing from store', [
        event.params.arbiter.toHexString(),
        chainId as string,
      ])
      return
    }
    accusation.withdrawnAt = event.block.timestamp
    accusation.withdrawnBy = event.params.by
    accusation.save()
    return
  }

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
  // reply per accusation and clears the slot whenever an accusation is laid or
  // taken back, so at most one of the four pointers is set.
  //
  // ⚠️ FOUR, AND UNTIL 21 AUGUST 2026 ONLY TWO OF THEM EXISTED. The line here
  // used to end "for the chain-accused there is nothing to link to at all", and
  // that was true: RemovalProposedByChain was not indexed, so the man the chain
  // accused — the only one who can neither withdraw the accusation nor walk
  // away from it — was also the only one whose answer hung off nothing. The
  // proposal case is the other addition: since 19 August the reply is taken
  // DURING the pause, while he is still seated and nothing has been removed, so
  // the ordinary thing being answered is an accusation, not a removal.
  //
  // Order of the four is the order of the contract's own gate in
  // respondToRemoval — `removedAt != 0` first, a live proposal second — because
  // a removal erases the proposal on its way out and only the removal is left.
  let removalId = arbiter.openRemoval
  let demotionId = arbiter.openDemotion
  let chainId = arbiter.openChainAccusation

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
  } else if (chainId !== null) {
    let accusation = ChainAccusation.load(chainId as string)
    if (accusation !== null) {
      accusation.answer = answer.id
      accusation.answeredAt = event.block.timestamp
      accusation.save()
      answer.chainAccusation = accusation.id
    }
  } else {
    let proposal = liveProposal(arbiter)
    if (proposal !== null) {
      answer.proposal = (proposal as RemovalProposal).id
    } else {
      log.warning('RemovalAnswered by {} with no open accusation indexed (tx {})', [
        event.params.arbiter.toHexString(),
        event.transaction.hash.toHexString(),
      ])
    }
  }

  answer.save()

  // The words of the answer arrive in the next log of the same transaction and
  // have to find this record.
  arbiter.latestAnswer = answer.id
  arbiter.save()
}

// ═════════════════════════════════════════════════════════════════════════════
//  THE WORDS
// ═════════════════════════════════════════════════════════════════════════════

// The accuser's words. A record of its own, and linked to the accusation it was
// given with — the two are separate logs of one transaction, emitted in that
// order, so the accusation is already in the store when this runs.
//
// `stage` is read rather than merely stored, and it is the only number in this
// file whose meaning the mapping acts on. The reason it is allowed: it is a
// two-valued discriminator declared beside the emit it serves
// (ArbiterAccountabilityFacet.REASON_STAGE_PROPOSAL / _REMOVAL), not the
// six-valued Cause enum, whose decoder lives in the frontend under a lock
// against both .sol sources. Guessing instead of reading it would be worse, not
// safer: "whatever is open" quietly picks the removal for words that belong to
// the proposal.
const REASON_STAGE_PROPOSAL: i32 = 0
const REASON_STAGE_REMOVAL: i32 = 1

export function handleRemovalReasonGiven(event: RemovalReasonGiven): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.save()

  let reason = new RemovalReason(recordId(event))
  reason.arbiter = arbiter.id
  reason.kind = 'removalReasonGiven'
  // Raw msg.sender, as the contract sends it: the role on both doors was
  // checked against that same address, and _msgSender() here would credit the
  // decision to one party while the record named another.
  reason.by = event.params.by
  reason.timestamp = event.block.timestamp
  reason.blockNumber = event.block.number
  reason.txHash = event.transaction.hash
  reason.stage = event.params.stage
  reason.reason = event.params.reason

  if (event.params.stage == REASON_STAGE_REMOVAL) {
    let removalId = arbiter.openRemoval
    if (removalId !== null) {
      reason.removal = removalId as string
    } else {
      log.warning('RemovalReasonGiven for {} at the removal stage with no removal indexed (tx {})', [
        event.params.arbiter.toHexString(),
        event.transaction.hash.toHexString(),
      ])
    }
  } else if (event.params.stage == REASON_STAGE_PROPOSAL) {
    let proposal = liveProposal(arbiter)
    if (proposal !== null) {
      reason.proposal = (proposal as RemovalProposal).id
    } else {
      log.warning('RemovalReasonGiven for {} at the proposal stage with no proposal indexed (tx {})', [
        event.params.arbiter.toHexString(),
        event.transaction.hash.toHexString(),
      ])
    }
  } else {
    // A third stage would be a contract change this mapping has not been told
    // about. The words are kept — losing them is the one outcome this whole
    // handler exists to prevent — and the stage is kept raw so the reader can
    // see what it was.
    log.warning('RemovalReasonGiven for {} carries an unknown stage {} (tx {})', [
      event.params.arbiter.toHexString(),
      event.params.stage.toString(),
      event.transaction.hash.toHexString(),
    ])
  }

  reason.save()
}

// The accused's words, in the log right after RemovalAnswered — which carries
// the digest and the moment this record hangs off.
export function handleRemovalReplyGiven(event: RemovalReplyGiven): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.save()

  let reply = new RemovalReply(recordId(event))
  reply.arbiter = arbiter.id
  reply.kind = 'removalReplyGiven'
  // respondToRemoval reads _msgSender(), so the address in the log is the human
  // who answered even when a relayer paid the gas.
  reply.by = event.params.arbiter
  reply.timestamp = event.block.timestamp
  reply.blockNumber = event.block.number
  reply.txHash = event.transaction.hash
  reply.reply = event.params.reply

  let answerId = arbiter.latestAnswer
  if (answerId !== null) {
    reply.answer = answerId as string
  } else {
    log.warning('RemovalReplyGiven by {} with no answer indexed (tx {})', [
      event.params.arbiter.toHexString(),
      event.transaction.hash.toHexString(),
    ])
  }

  reply.save()
}

// ═════════════════════════════════════════════════════════════════════════════
//  THE CHAIN AS ACCUSER
// ═════════════════════════════════════════════════════════════════════════════

// The chain accuses in its own name, on the third judicial mistake.
//
// ⚠️ THE STREAK IS NOT CLEARED HERE, deliberately, and it mirrors the contract
// line for line: _recordArbiterMistake leaves arbiterMistakeStreak standing
// when it lays this accusation, because "the arbiter has done nothing to break
// the row by being accused". Two readers still live on that value on chain, and
// one lives on this list — a fourth mistake before the accusation is executed
// belongs to the same run.
export function handleRemovalProposedByChain(event: RemovalProposedByChain): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.chainAccusationCount = arbiter.chainAccusationCount + 1

  // ⚠️ OWNER DECISION 15a, AND THE ONLY PLACE IT CAN BE HONOURED. The event
  // carries ONE dispute — the one that tipped him over — and the accusation
  // stands on three; the other two are in this indexer's running list and
  // nowhere else on chain. Frozen into the record here, because the running
  // list keeps moving and a card read a week later must still show what the
  // accusation was made of.
  //
  // The tipping dispute is appended if the list does not already hold it, and
  // the reason is ORDER rather than absence. Here stood "on the timeout path
  // there is no log naming the arbiter at all", which stopped being true on
  // 21 August 2026 when ArbiterTimeoutRecorded was added to the contract. What
  // still holds: every log that books a mistake — that one and VerdictOverturned
  // alike — is emitted BELOW the booking, so when a mistake is the third of a
  // run this accusation reaches the indexer FIRST and the running list has not
  // learned of the tipping dispute yet.
  let disputes: Array<Bytes> = []
  let series = arbiter.currentSeries
  let seen = false
  for (let i = 0; i < series.length; i++) {
    disputes.push(series[i])
    if (series[i] == event.params.agreement) seen = true
  }
  if (!seen) disputes.push(event.params.agreement)

  let accusation = new ChainAccusation(recordId(event))
  accusation.arbiter = arbiter.id
  accusation.kind = 'removalProposedByChain'
  // Zero, and asserted rather than defaulted: executeChainRemoval refuses to
  // act on any accusation that has an author, so this one provably has none.
  accusation.by = Address.zero()
  accusation.timestamp = event.block.timestamp
  accusation.blockNumber = event.block.number
  accusation.txHash = event.transaction.hash
  accusation.path = event.params.path
  accusation.agreement = event.params.agreement
  accusation.proposedAt = event.params.proposedAt
  accusation.disputes = disputes
  accusation.disputeCount = disputes.length
  accusation.save()

  arbiter.openChainAccusation = accusation.id
  arbiter.save()
}

// A panel found the arbiter right, so the chain takes its own accusation back:
// the proposal is erased, the streak is zeroed and the suspension is lifted —
// three writes, one record, because they happen together and mean one thing.
//
// The lift arrives as its own ArbiterSuspensionLifted log with a zero presser
// and is handled where every other lift is.
export function handleChainAccusationCleared(event: ChainAccusationCleared): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)

  let id = arbiter.openChainAccusation
  if (id === null) {
    log.warning('ChainAccusationCleared for {} with no chain accusation indexed (tx {})', [
      event.params.arbiter.toHexString(),
      event.transaction.hash.toHexString(),
    ])
  } else {
    let accusation = ChainAccusation.load(id as string)
    if (accusation !== null) {
      accusation.clearedAt = event.block.timestamp
      accusation.clearedOn = event.params.agreement
      accusation.save()
    }
    arbiter.openChainAccusation = null
  }

  clearSeries(arbiter)
  arbiter.save()
}

// ═════════════════════════════════════════════════════════════════════════════
//  THE EVIDENCE UNDER THE ACCUSATION
//
//  Four handlers that are not about the arbiter corps at all on their own. They
//  are here because a mistake streak is a sentence about SEVERAL logs, and the
//  chain writes none of it down: "three judicial mistakes in an unbroken row"
//  needs both the mistakes and the breaks, and the break is
//  "VerdictFinalized on a verdict that was not overturned" — a fact no single
//  log states.
// ═════════════════════════════════════════════════════════════════════════════

function verdictIdOf(agreement: Address): string {
  return agreement.toHexString()
}

// The verdict as submitted. Overwritten rather than versioned: a stuck verdict
// can be cleared and the dispute claimed by somebody else, and what the rest of
// this file needs is the ruling that stands.
export function handleVerdictSubmitted(event: VerdictSubmitted): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.save()

  let id = verdictIdOf(event.params.agreement)
  let verdict = Verdict.load(id)
  if (verdict === null) {
    verdict = new Verdict(id)
    verdict.reconstructed = false
  }
  verdict.agreement = event.params.agreement
  verdict.arbiter = arbiter.id
  verdict.clientWins = event.params.clientWins
  verdict.submittedAt = event.block.timestamp
  verdict.overturned = false
  verdict.overturnedAt = null
  verdict.finalized = false
  verdict.finalizedAt = null
  verdict.vindicatedAt = null
  verdict.latestOverturn = null
  verdict.save()
}

// A verdict this indexer never saw submitted. Should not happen — the data
// source has been indexing the diamond since its deploy block — and if it does
// the record is built rather than the event dropped, exactly as
// matchConsumedProposal does for a proposal.
function loadOrRebuildVerdict(
  agreement: Address,
  arbiter: Arbiter,
  clientWins: boolean,
  event: ethereum.Event
): Verdict {
  let id = verdictIdOf(agreement)
  let existing = Verdict.load(id)
  if (existing !== null) return existing as Verdict

  log.warning('verdict on {} was never indexed as submitted (tx {})', [
    agreement.toHexString(),
    event.transaction.hash.toHexString(),
  ])
  let rebuilt = new Verdict(id)
  rebuilt.agreement = agreement
  rebuilt.arbiter = arbiter.id
  rebuilt.clientWins = clientWins
  rebuilt.overturned = false
  rebuilt.finalized = false
  rebuilt.reconstructed = true
  return rebuilt
}

// A hand overturned the verdict: DemotionPath.OwnerOverturn, one judicial
// mistake, and one more overturn on the cumulative count.
//
// ⚠️ THE PRESSER IS NOT IN THIS LOG, which is why VerdictOverturn is the one
// entity in this file outside the ArbiterRecord interface. See its docstring.
export function handleVerdictOverturned(event: VerdictOverturned): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)

  let verdict = loadOrRebuildVerdict(
    event.params.agreement,
    arbiter,
    // The standing outcome after the press, which is the best this branch can
    // say about a verdict it never saw submitted. On the ordinary path the
    // value is overwritten below anyway.
    event.params.newClientWins,
    event
  )
  verdict.arbiter = arbiter.id
  verdict.clientWins = event.params.newClientWins
  verdict.overturned = true
  verdict.overturnedAt = event.block.timestamp

  let overturn = new VerdictOverturn(recordId(event))
  overturn.arbiter = arbiter.id
  overturn.agreement = event.params.agreement
  overturn.verdict = verdict.id
  overturn.timestamp = event.block.timestamp
  overturn.blockNumber = event.block.number
  overturn.txHash = event.transaction.hash
  overturn.byPanel = false
  overturn.outcome = event.params.newClientWins ? 'clientWins' : 'executorWins'
  overturn.save()

  verdict.latestOverturn = overturn.id
  verdict.save()

  arbiter.overturnedVerdicts = arbiter.overturnedVerdicts + 1
  pushSeries(arbiter, event.params.agreement)
  arbiter.save()
}

// The verdict reached the end of its road. The event fires whether or not it
// was overturned; the chain resets the streak and counts a clean verdict only
// in the second case, and this handler asks the same question of the same
// verdict.
export function handleVerdictFinalized(event: VerdictFinalized): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)

  let verdict = loadOrRebuildVerdict(event.params.agreement, arbiter, event.params.clientWins, event)
  verdict.arbiter = arbiter.id
  verdict.clientWins = event.params.clientWins
  verdict.finalized = true
  verdict.finalizedAt = event.block.timestamp
  verdict.save()

  if (!verdict.overturned) {
    // `if (!v.overturned) { streak = 0; cleanVerdicts++ }`, both halves, in the
    // order the contract writes them.
    clearSeries(arbiter)
    arbiter.cleanVerdicts = arbiter.cleanVerdicts + 1
  }
  arbiter.save()
}

// The appeal panel has voted, and the same log means two opposite things.
//
// ⚠️ THIS IS THE HANDLER THE SERIES WOULD BE WRONG WITHOUT, and not because of
// what it adds — because of what it stops the finalization handler from doing.
// When a panel overturns a verdict no hand had touched, the arbiter takes a
// judicial mistake that NO log names him in: AppealResolved carries the
// appellant, AppealVoteCast carries the voters, and VerdictOverturned is not
// emitted on this path at all. Leave it unindexed and the finalization that
// follows reads as "finalized, not overturned" — so the indexer would zero a
// streak the chain kept standing, and every earlier dispute of the run would
// vanish off the accused man's card.
//
// The two meanings are told apart the way the contract tells them apart, by
// asking whether a hand had already overturned this verdict BEFORE the vote:
//
//   • it had — the panel has just flipped the ruling back to the arbiter's own
//     and thereby found him right. One mistake comes off the streak and one off
//     the cumulative count.
//   • it had not — the panel is overturning HIM. DemotionPath.AppealVote: one
//     judicial mistake, one more overturn.
//
// A vote that does not carry (overturned == false) is not a judicial anything:
// the deposit goes to the vault and the verdict stands.
export function handleAppealResolved(event: AppealResolved): void {
  if (!event.params.overturned) return

  let verdict = Verdict.load(verdictIdOf(event.params.agreement))
  if (verdict === null) {
    // Nothing here names the arbiter, so an appeal on a verdict this indexer
    // never saw cannot be attributed to anyone. Said out loud rather than
    // swallowed: this is the one shape of drift that makes a series short.
    log.warning('AppealResolved on {} with no verdict indexed (tx {})', [
      event.params.agreement.toHexString(),
      event.transaction.hash.toHexString(),
    ])
    return
  }

  let arbiter = Arbiter.load(verdict.arbiter)
  if (arbiter === null) {
    log.warning('AppealResolved on {}: arbiter {} missing from store', [
      event.params.agreement.toHexString(),
      verdict.arbiter,
    ])
    return
  }
  arbiter.updatedAt = event.block.timestamp

  // Read before the write, exactly as resolveAppeal reads `v.overturned` before
  // setting it: after the line below the two cases are indistinguishable.
  let alreadyOverturned = verdict.overturned

  verdict.clientWins = !verdict.clientWins
  verdict.overturned = true
  verdict.overturnedAt = event.block.timestamp

  if (alreadyOverturned) {
    verdict.vindicatedAt = event.block.timestamp

    let overturnId = verdict.latestOverturn
    if (overturnId !== null) {
      let overturn = VerdictOverturn.load(overturnId as string)
      if (overturn !== null) {
        overturn.takenBackAt = event.block.timestamp
        overturn.save()
      }
    }

    // ONE off the cumulative count, never the whole of it, and never below
    // zero: overturns on OTHER disputes stay his. The floor is the contract's
    // own `if (overturns > 0)`.
    if (arbiter.overturnedVerdicts > 0) {
      arbiter.overturnedVerdicts = arbiter.overturnedVerdicts - 1
    }
    // And one off the streak. When the chain's own accusation was standing,
    // ChainAccusationCleared has already emptied the list in this very
    // transaction — it is emitted earlier in resolveAppeal than this log — so
    // this call finds nothing to take back, which is the right answer: the
    // contract zeroes the streak on that branch instead of decrementing it.
    takeBackFromSeries(arbiter, event.params.agreement)
  } else {
    let overturn = new VerdictOverturn(recordId(event))
    overturn.arbiter = arbiter.id
    overturn.agreement = event.params.agreement
    overturn.verdict = verdict.id
    overturn.timestamp = event.block.timestamp
    overturn.blockNumber = event.block.number
    overturn.txHash = event.transaction.hash
    overturn.byPanel = true
    // Not stated by the log. The flipped value is derivable from the verdict,
    // but deriving it into a field that reads as "what the log said" is how a
    // record starts lying quietly. Left null, which this field can express
    // because it is a String — see its docstring in schema.graphql.
    overturn.outcome = null
    overturn.save()

    verdict.latestOverturn = overturn.id

    arbiter.overturnedVerdicts = arbiter.overturnedVerdicts + 1
    pushSeries(arbiter, event.params.agreement)
  }

  verdict.save()
  arbiter.save()
}

// A judicial mistake booked on the timeout: the arbiter took the dispute and
// let the window run out without ruling.
//
// ⚠️ THE ONE HANDLER HERE WHOSE EVENT WAS WRITTEN FOR IT. Everything else in
// this file reads a log the contracts already emitted; the timeout emitted
// nothing naming the arbiter, so a mistake run containing one could not be
// rebuilt by any reading whatever, and the accused saw two of the three
// disputes his removal stood on. ArbiterTimeoutRecorded was added to
// notifyArbiterTimeout for this line.
//
// ⚠️ IT ARRIVES AFTER THE ACCUSATION IT MAY HAVE CAUSED, which is why
// handleRemovalProposedByChain appends the tipping dispute itself instead of
// trusting the running list. The contract emits this below the booking, the
// same way overturnVerdict emits VerdictOverturned below its own, so both outer
// events sit after any RemovalProposedByChain of the same transaction.
//
// No overturn is counted. On chain the cumulative count takes an allow-list of
// demotion paths and the timeout is not on it — "the timeout is a judicial
// mistake that overturned NOTHING, there was no ruling to overturn" — and the
// absence is mirrored here by there being no line to mirror.
export function handleArbiterTimeoutRecorded(event: ArbiterTimeoutRecorded): void {
  let arbiter = loadOrCreateArbiter(event.params.arbiter, event)
  arbiter.timeoutCount = arbiter.timeoutCount + 1

  let timeout = new ArbiterTimeout(recordId(event))
  timeout.arbiter = arbiter.id
  timeout.kind = 'arbiterTimedOut'
  // Zero, and an assertion rather than a gap: notifyArbiterTimeout refuses any
  // caller but the deal contract itself, so there is provably no person behind
  // this record.
  timeout.by = Address.zero()
  timeout.timestamp = event.block.timestamp
  timeout.blockNumber = event.block.number
  timeout.txHash = event.transaction.hash
  timeout.agreement = event.params.agreement
  timeout.save()

  pushSeries(arbiter, event.params.agreement)
  arbiter.save()
}
