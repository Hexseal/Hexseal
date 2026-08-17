// handleArbiterDemoted and handleArbiterRemovedForCause — the two doors that
// ARE an accusation.
//
// ArbiterDemoted carries three addresses (the arbiter, the presser, the deal)
// and ArbiterRemovedForCause carries two plus the mark that says whether the
// chain checked the grounds itself. Nothing in the type system keeps them
// apart, and the cost of getting it wrong is a public record accusing the wrong
// address, or an unproven accusation shown as proven.

import { assert, describe, test, afterEach, clearStore } from 'matchstick-as/assembly/index'
import { Arbiter } from '../generated/schema'
import { handleArbiterDemoted, handleArbiterRemovedForCause } from '../src/arbiter'
import {
  ARBITER,
  OTHER_ARBITER,
  OWNER,
  AGREEMENT,
  ZERO,
  TS,
  TS2,
  BLOCK,
  BLOCK2,
  BOND_FORFEITED,
  TX,
  TX2,
  EVIDENCE,
  recordId,
  demotedEvent,
  removedForCauseEvent,
} from './helpers'

// ArbiterRegistryFacet.DemotionPath
const PATH_OWNER_OVERTURN = 1
const PATH_AGREEMENT_TIMEOUT = 2

// ArbiterAccountabilityFacet.Cause
const CAUSE_OVERTURNED_VERDICTS = 0 // the chain checks this one against its own state
const CAUSE_SILENCE = 2 // likewise
const CAUSE_COLLUSION = 3 // the chain only notarises a digest it never read
const CAUSE_OTHER = 5 // likewise

describe('ArbiterDemoted', () => {
  afterEach(() => {
    clearStore()
  })

  test('demoted: the presser and the deal are different addresses in different fields', () => {
    handleArbiterDemoted(demotedEvent(ARBITER, OWNER, PATH_OWNER_OVERTURN, AGREEMENT, TS, BLOCK, TX, 1))

    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'by', OWNER.toHexString())
    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'agreement', AGREEMENT.toHexString())
    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'path', PATH_OWNER_OVERTURN.toString())
    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'kind', 'demoted')

    // Neither the presser nor the deal is an arbiter.
    assert.entityCount('Arbiter', 1)
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seated', 'false')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'exitKind', 'demoted')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'exitAt', TS.toString())
  })

  // The zero here is the contract's assertion that no person was behind the
  // call, and it has to survive as a zero. A handler that quietly filled it
  // with the deal address would be inventing a culprit.
  test('demoted: the automatic path names no presser and still names the deal', () => {
    handleArbiterDemoted(demotedEvent(ARBITER, ZERO, PATH_AGREEMENT_TIMEOUT, AGREEMENT, TS, BLOCK, TX, 1))

    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'by', ZERO.toHexString())
    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'agreement', AGREEMENT.toHexString())
    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'path', PATH_AGREEMENT_TIMEOUT.toString())
  })

  test('demoted: the demotion becomes the accusation an answer can hang off', () => {
    handleArbiterDemoted(demotedEvent(ARBITER, ZERO, PATH_AGREEMENT_TIMEOUT, AGREEMENT, TS, BLOCK, TX, 1))

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'openDemotion', recordId(TX, 1))
    let arbiter = Arbiter.load(ARBITER.toHexString())!
    assert.assertTrue(arbiter.openRemoval === null, 'a demotion is not a removal for cause')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'demotionCount', '1')
  })

  test('demoted: the ordinal counts this arbiter, not the corps', () => {
    handleArbiterDemoted(demotedEvent(ARBITER, ZERO, PATH_AGREEMENT_TIMEOUT, AGREEMENT, TS, BLOCK, TX, 1))
    handleArbiterDemoted(demotedEvent(OTHER_ARBITER, ZERO, PATH_AGREEMENT_TIMEOUT, AGREEMENT, TS, BLOCK, TX, 2))
    handleArbiterDemoted(demotedEvent(ARBITER, ZERO, PATH_AGREEMENT_TIMEOUT, AGREEMENT, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'ordinal', '1')
    assert.fieldEquals('ArbiterDemotion', recordId(TX, 2), 'ordinal', '1')
    assert.fieldEquals('ArbiterDemotion', recordId(TX2, 1), 'ordinal', '2')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'demotionCount', '2')
    assert.fieldEquals('Arbiter', OTHER_ARBITER.toHexString(), 'demotionCount', '1')
  })
})

describe('ArbiterRemovedForCause', () => {
  afterEach(() => {
    clearStore()
  })

  // THE REASON THE WHOLE ENTITY EXISTS. Three of the six causes the chain
  // checks against its own state; the other three it only notarises with a
  // digest it never read. The contract says which it was, in the log, and the
  // mapping copies that word — it does not re-derive it from the cause code.
  //
  // The two logs below are deliberately built the wrong way round: a
  // chain-checked cause carrying verifiedByChain = false, and a notarised-only
  // cause carrying true. Today's ArbiterAccountabilityFacet would never emit
  // either — its `verified` is _isChainVerifiable(cause), so the two always
  // agree — and that is exactly why this test is written against logs and not
  // against today's contract. Any handler that recomputes the mark from the
  // cause passes on real logs and starts lying on the day a cause changes
  // sides. This test fails on that handler now, before the change.
  test('removed for cause: the verified mark is copied from the log, never derived from the cause', () => {
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_OVERTURNED_VERDICTS, false, EVIDENCE, BOND_FORFEITED, TS, BLOCK, TX, 1)
    )
    handleArbiterRemovedForCause(
      removedForCauseEvent(OTHER_ARBITER, OWNER, CAUSE_OTHER, true, EVIDENCE, BOND_FORFEITED, TS, BLOCK, TX, 2)
    )

    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'cause', CAUSE_OVERTURNED_VERDICTS.toString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'verifiedByChain', 'false')
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 2), 'cause', CAUSE_OTHER.toString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 2), 'verifiedByChain', 'true')
  })

  test('removed for cause: a chain-checked removal keeps its mark true', () => {
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_SILENCE, true, EVIDENCE, BOND_FORFEITED, TS, BLOCK, TX, 1)
    )

    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'cause', CAUSE_SILENCE.toString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'verifiedByChain', 'true')
  })

  test('removed for cause: the presser, the digest and the burnt bond land in their own fields', () => {
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_COLLUSION, false, EVIDENCE, BOND_FORFEITED, TS, BLOCK, TX, 1)
    )

    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'by', OWNER.toHexString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'evidenceDigest', EVIDENCE.toHexString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'bondForfeited', BOND_FORFEITED.toString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'ordinal', '1')
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'timestamp', TS.toString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'blockNumber', BLOCK.toString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'txHash', TX.toHexString())

    // The owner pressed a button; that does not make the owner an arbiter.
    assert.entityCount('Arbiter', 1)
    assert.notInStore('Arbiter', OWNER.toHexString())
  })

  test('removed for cause: the removal becomes the open accusation and closes the seat', () => {
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_COLLUSION, false, EVIDENCE, BOND_FORFEITED, TS, BLOCK, TX, 1)
    )

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seated', 'false')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'exitKind', 'removedForCause')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'exitAt', TS.toString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'removalForCauseCount', '1')

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'openRemoval', recordId(TX, 1))
    let arbiter = Arbiter.load(ARBITER.toHexString())!
    assert.assertTrue(arbiter.openDemotion === null, 'a removal is not a demotion')
  })
})
