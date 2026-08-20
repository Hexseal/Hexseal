// handleArbiterSeated and handleArbiterResigned — the two doors that are not an
// accusation.
//
// What these tests are for: not "the handler ran", but "the handler put each
// value in the field that means it". ArbiterSeated carries two addresses and
// they are not interchangeable — one is the person the record is about, the
// other is the person who put them there. Swap the two and the store grows a
// standing record about the owner of the protocol.

import { assert, describe, test, afterEach, clearStore } from 'matchstick-as/assembly/index'
import { Arbiter } from '../generated/schema'
import { handleArbiterSeated, handleArbiterResigned, handleRemovalProposed } from '../src/arbiter'
import {
  ARBITER,
  SEATER,
  DIRECTOR,
  ZERO,
  TS,
  TS2,
  BLOCK,
  BLOCK2,
  BOND_REFUNDED,
  TX,
  TX2,
  EVIDENCE,
  PROPOSED_AT,
  recordId,
  seatedEvent,
  resignedEvent,
  removalProposedEvent,
} from './helpers'

describe('ArbiterSeated', () => {
  afterEach(() => {
    clearStore()
  })

  test('seated: the record is about the arbiter, and `by` is whoever seated them', () => {
    handleArbiterSeated(seatedEvent(ARBITER, SEATER, false, TS, BLOCK, TX, 1))

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seated', 'true')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seatedBy', SEATER.toHexString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seatedAt', TS.toString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seatingCount', '1')

    assert.fieldEquals('ArbiterSeating', recordId(TX, 1), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('ArbiterSeating', recordId(TX, 1), 'by', SEATER.toHexString())
    assert.fieldEquals('ArbiterSeating', recordId(TX, 1), 'kind', 'seated')

    // The seater is not an arbiter and must not have grown a card of their own.
    assert.notInStore('Arbiter', SEATER.toHexString())
    assert.entityCount('Arbiter', 1)
  })

  test('seated: a self-service seat says so and names no seater', () => {
    handleArbiterSeated(seatedEvent(ARBITER, ZERO, true, TS, BLOCK, TX, 1))

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'selfSeated', 'true')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seatedBy', ZERO.toHexString())
    assert.fieldEquals('ArbiterSeating', recordId(TX, 1), 'selfService', 'true')
    assert.fieldEquals('ArbiterSeating', recordId(TX, 1), 'by', ZERO.toHexString())
  })

  test('seated: the moment and the height are two different numbers', () => {
    handleArbiterSeated(seatedEvent(ARBITER, SEATER, false, TS, BLOCK, TX, 1))

    assert.fieldEquals('ArbiterSeating', recordId(TX, 1), 'timestamp', TS.toString())
    assert.fieldEquals('ArbiterSeating', recordId(TX, 1), 'blockNumber', BLOCK.toString())
    assert.fieldEquals('ArbiterSeating', recordId(TX, 1), 'txHash', TX.toHexString())
  })

  test('seated: a second seat is counted and the exit is cleared', () => {
    handleArbiterSeated(seatedEvent(ARBITER, SEATER, false, TS, BLOCK, TX, 1))
    handleArbiterResigned(resignedEvent(ARBITER, BOND_REFUNDED, TS, BLOCK, TX, 2))
    handleArbiterSeated(seatedEvent(ARBITER, SEATER, false, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seatingCount', '2')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seated', 'true')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seatedAt', TS2.toString())

    // `x === null` and not assert.assertNull(x): assertNull is generic, and
    // instantiating it with a nullable BigInt crashes the AssemblyScript
    // compiler outright — BigInt carries an operator overload for `!=` and the
    // compiler asserts on it (compileBinaryOverload). Measured, not guessed:
    // the same test with assertNull ends in "🆘 Please attend to the compilation
    // errors above!". `===` is a reference comparison and needs no overload.
    let arbiter = Arbiter.load(ARBITER.toHexString())!
    assert.assertTrue(arbiter.exitKind === null, 'a re-seated arbiter has no exit')
    assert.assertTrue(arbiter.exitAt === null, 'a re-seated arbiter has no exit moment')
    assert.entityCount('ArbiterSeating', 2)
  })
})

describe('ArbiterResigned', () => {
  afterEach(() => {
    clearStore()
  })

  test('resigned: the exit is dated and the returned bond is the amount, not the clock', () => {
    handleArbiterSeated(seatedEvent(ARBITER, SEATER, false, TS, BLOCK, TX, 1))
    handleArbiterResigned(resignedEvent(ARBITER, BOND_REFUNDED, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'seated', 'false')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'exitKind', 'resigned')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'exitAt', TS2.toString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'resignationCount', '1')

    assert.fieldEquals('ArbiterResignation', recordId(TX2, 1), 'bondRefunded', BOND_REFUNDED.toString())
    assert.fieldEquals('ArbiterResignation', recordId(TX2, 1), 'timestamp', TS2.toString())
    assert.fieldEquals('ArbiterResignation', recordId(TX2, 1), 'blockNumber', BLOCK2.toString())
  })

  test('resigned: nobody but the arbiter can be the presser of their own resignation', () => {
    handleArbiterResigned(resignedEvent(ARBITER, BOND_REFUNDED, TS, BLOCK, TX, 1))

    assert.fieldEquals('ArbiterResignation', recordId(TX, 1), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('ArbiterResignation', recordId(TX, 1), 'by', ARBITER.toHexString())
    assert.fieldEquals('ArbiterResignation', recordId(TX, 1), 'kind', 'resigned')
  })

  // The chain wipes a live proposal on the way out of the seat and says nothing
  // about it. If the mirror in the mapping misses that, a card shows a standing
  // accusation against somebody the chain no longer holds one against.
  test('resigned: a proposal still standing is voided with the reason, not left open', () => {
    handleRemovalProposed(removalProposedEvent(ARBITER, DIRECTOR, 4, EVIDENCE, PROPOSED_AT, TS, BLOCK, TX, 1))
    handleArbiterResigned(resignedEvent(ARBITER, BOND_REFUNDED, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'voidedAt', TS2.toString())
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'voidedReason', 'resigned')
  })
})
