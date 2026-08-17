// handleRemovalProposed, handleRemovalProposalWithdrawn, handleRemovalProposalConsumed.
//
// A proposal is an accusation nobody has acted on yet, and it has three ways to
// end: withdrawn by the director who made it, consumed by the removal it
// argued for, or voided in silence when the arbiter leaves through another
// door. The card shows whichever it is, so all three have to arrive.
//
// The addresses here are the pair most easily confused in the whole file: the
// accused and the accuser. RemovalProposalConsumed makes it worse by naming the
// proposer `proposedBy` and putting it AFTER a uint8, so the positions differ
// from every other event.

import { assert, describe, test, afterEach, clearStore } from 'matchstick-as/assembly/index'
import { Arbiter, RemovalProposal } from '../generated/schema'
import {
  handleRemovalProposed,
  handleRemovalProposalWithdrawn,
  handleRemovalProposalConsumed,
  handleArbiterRemovedForCause,
  handleArbiterDemoted,
} from '../src/arbiter'
import {
  ARBITER,
  DIRECTOR,
  OWNER,
  AGREEMENT,
  ZERO,
  TS,
  TS2,
  BLOCK,
  BLOCK2,
  BOND_FORFEITED,
  PROPOSED_AT,
  TX,
  TX2,
  EVIDENCE,
  EVIDENCE2,
  recordId,
  removalProposedEvent,
  removalWithdrawnEvent,
  removalConsumedEvent,
  removedForCauseEvent,
  demotedEvent,
} from './helpers'

const CAUSE_COLLUSION = 3
const CAUSE_LEAK = 4
const PATH_AGREEMENT_TIMEOUT = 2

describe('RemovalProposed', () => {
  afterEach(() => {
    clearStore()
  })

  test('proposed: the accused is the subject and the director who proposed is `by`', () => {
    handleRemovalProposed(removalProposedEvent(ARBITER, DIRECTOR, CAUSE_LEAK, EVIDENCE, TS, TS, BLOCK, TX, 1))

    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'by', DIRECTOR.toHexString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'cause', CAUSE_LEAK.toString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'evidenceDigest', EVIDENCE.toHexString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'kind', 'removalProposed')
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'reconstructed', 'false')
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'timestamp', TS.toString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'blockNumber', BLOCK.toString())

    // A proposal is not a removal: the seat is untouched and the accuser has no
    // card of their own.
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'removalProposalCount', '1')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'latestProposal', recordId(TX, 1))
    assert.entityCount('Arbiter', 1)
    assert.notInStore('Arbiter', DIRECTOR.toHexString())

    let arbiter = Arbiter.load(ARBITER.toHexString())!
    assert.assertTrue(arbiter.exitKind === null, 'a proposal does not end a seat')
  })

  // One live proposal per arbiter on chain: a second overwrites the first in
  // storage. Two open records here would put two standing accusations on a card
  // where the chain holds one.
  test('proposed: a second proposal supersedes the first rather than standing beside it', () => {
    handleRemovalProposed(removalProposedEvent(ARBITER, DIRECTOR, CAUSE_LEAK, EVIDENCE, TS, TS, BLOCK, TX, 1))
    handleRemovalProposed(removalProposedEvent(ARBITER, OWNER, CAUSE_COLLUSION, EVIDENCE2, TS2, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'voidedAt', TS2.toString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'voidedReason', 'superseded')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'latestProposal', recordId(TX2, 1))
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'removalProposalCount', '2')

    let second = RemovalProposal.load(recordId(TX2, 1))!
    assert.assertTrue(second.voidedAt === null, 'the newest proposal is the one still standing')
  })

  test('proposed: a demotion voids the standing proposal the chain wiped in silence', () => {
    handleRemovalProposed(removalProposedEvent(ARBITER, DIRECTOR, CAUSE_LEAK, EVIDENCE, TS, TS, BLOCK, TX, 1))
    handleArbiterDemoted(demotedEvent(ARBITER, ZERO, PATH_AGREEMENT_TIMEOUT, AGREEMENT, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'voidedAt', TS2.toString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'voidedReason', 'demoted')
  })
})

describe('RemovalProposalWithdrawn', () => {
  afterEach(() => {
    clearStore()
  })

  // The withdrawal is half of what the feed is for: an accusation that was
  // dropped has to be visibly dropped, and dated, or the card keeps showing it.
  test('withdrawn: the drop reaches the feed with its moment and the director who dropped it', () => {
    handleRemovalProposed(removalProposedEvent(ARBITER, DIRECTOR, CAUSE_LEAK, EVIDENCE, TS, TS, BLOCK, TX, 1))
    handleRemovalProposalWithdrawn(removalWithdrawnEvent(ARBITER, DIRECTOR, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'withdrawnAt', TS2.toString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'withdrawnBy', DIRECTOR.toHexString())

    // The proposal is closed by withdrawal and by nothing else.
    let proposal = RemovalProposal.load(recordId(TX, 1))!
    assert.assertTrue(proposal.consumedAt === null, 'a withdrawal is not a consumption')
    assert.assertTrue(proposal.voidedAt === null, 'a withdrawal is not a silent void')
  })

  test('withdrawn: one arbiter dropping their accusation leaves another arbiter alone', () => {
    handleRemovalProposed(removalProposedEvent(ARBITER, DIRECTOR, CAUSE_LEAK, EVIDENCE, TS, TS, BLOCK, TX, 1))
    handleRemovalProposalWithdrawn(removalWithdrawnEvent(ARBITER, OWNER, TS2, BLOCK2, TX2, 1))

    // Whoever pressed withdraw is recorded as the presser — the accused never is.
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'withdrawnBy', OWNER.toHexString())
    assert.entityCount('Arbiter', 1)
    assert.notInStore('Arbiter', OWNER.toHexString())
  })

  // The contract only emits a withdrawal when a live proposal was really there,
  // so finding a closed one means the mirror drifted. Stamping a withdrawal
  // over a consumption would erase the fact that the removal happened.
  test('withdrawn: a withdrawal never stamps itself over an already consumed proposal', () => {
    handleRemovalProposed(removalProposedEvent(ARBITER, DIRECTOR, CAUSE_LEAK, EVIDENCE, TS, TS, BLOCK, TX, 1))
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_LEAK, false, EVIDENCE, BOND_FORFEITED, TS2, BLOCK2, TX2, 1)
    )
    handleRemovalProposalConsumed(removalConsumedEvent(ARBITER, CAUSE_LEAK, DIRECTOR, EVIDENCE, TS, TS2, BLOCK2, TX2, 2))
    handleRemovalProposalWithdrawn(removalWithdrawnEvent(ARBITER, DIRECTOR, TS2, BLOCK2, TX2, 3))

    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'consumedAt', TS2.toString())
    let proposal = RemovalProposal.load(recordId(TX, 1))!
    assert.assertTrue(proposal.withdrawnAt === null, 'a consumed proposal was not withdrawn')
    assert.assertTrue(proposal.withdrawnBy === null, 'and nobody withdrew it')
  })
})

describe('RemovalProposalConsumed', () => {
  afterEach(() => {
    clearStore()
  })

  test('consumed: the removal and the proposal it ate point at each other', () => {
    handleRemovalProposed(removalProposedEvent(ARBITER, DIRECTOR, CAUSE_LEAK, EVIDENCE, TS, TS, BLOCK, TX, 1))
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_COLLUSION, false, EVIDENCE2, BOND_FORFEITED, TS2, BLOCK2, TX2, 1)
    )
    handleRemovalProposalConsumed(removalConsumedEvent(ARBITER, CAUSE_LEAK, DIRECTOR, EVIDENCE, TS, TS2, BLOCK2, TX2, 2))

    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'consumedAt', TS2.toString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'consumedByRemoval', recordId(TX2, 1))
    assert.fieldEquals('ArbiterRemoval', recordId(TX2, 1), 'consumedProposal', recordId(TX, 1))
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'reconstructed', 'false')

    // "Proposed for one thing, removed for another" has to stay readable: the
    // two causes are kept apart, and so are the two digests.
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'cause', CAUSE_LEAK.toString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX2, 1), 'cause', CAUSE_COLLUSION.toString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'evidenceDigest', EVIDENCE.toHexString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX2, 1), 'evidenceDigest', EVIDENCE2.toHexString())
    assert.entityCount('RemovalProposal', 1)
  })

  // The snapshot wins on disagreement, because it is the only copy of a
  // proposal this indexer never saw. Dropping it would lose the accusation
  // entirely; overwriting the indexed one would forge it.
  test('consumed: a snapshot naming a different proposer becomes a record of its own', () => {
    handleRemovalProposed(removalProposedEvent(ARBITER, DIRECTOR, CAUSE_LEAK, EVIDENCE, TS, TS, BLOCK, TX, 1))
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_COLLUSION, false, EVIDENCE2, BOND_FORFEITED, TS2, BLOCK2, TX2, 1)
    )
    handleRemovalProposalConsumed(
      removalConsumedEvent(ARBITER, CAUSE_COLLUSION, OWNER, EVIDENCE2, PROPOSED_AT, TS2, BLOCK2, TX2, 2)
    )

    // The rebuilt record carries the snapshot's own proposer, cause and moment.
    assert.fieldEquals('RemovalProposal', recordId(TX2, 2), 'reconstructed', 'true')
    assert.fieldEquals('RemovalProposal', recordId(TX2, 2), 'by', OWNER.toHexString())
    assert.fieldEquals('RemovalProposal', recordId(TX2, 2), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('RemovalProposal', recordId(TX2, 2), 'timestamp', PROPOSED_AT.toString())
    assert.fieldEquals('RemovalProposal', recordId(TX2, 2), 'cause', CAUSE_COLLUSION.toString())
    assert.fieldEquals('RemovalProposal', recordId(TX2, 2), 'consumedAt', TS2.toString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX2, 1), 'consumedProposal', recordId(TX2, 2))

    // And the proposal that was really seen is left untouched rather than
    // overwritten with the snapshot's contents.
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'by', DIRECTOR.toHexString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'reconstructed', 'false')
    let seen = RemovalProposal.load(recordId(TX, 1))!
    assert.assertTrue(seen.consumedAt === null, 'the indexed proposal was not the one consumed')
    assert.entityCount('RemovalProposal', 2)
  })

  test('consumed: a consumption with no removal in the same transaction still closes the proposal', () => {
    handleRemovalProposed(removalProposedEvent(ARBITER, DIRECTOR, CAUSE_LEAK, EVIDENCE, TS, TS, BLOCK, TX, 1))
    handleRemovalProposalConsumed(removalConsumedEvent(ARBITER, CAUSE_LEAK, DIRECTOR, EVIDENCE, TS, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'consumedAt', TS2.toString())
    let proposal = RemovalProposal.load(recordId(TX, 1))!
    assert.assertTrue(proposal.consumedByRemoval === null, 'there was no removal to point at')
  })
})
