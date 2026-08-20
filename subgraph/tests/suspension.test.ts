// handleArbiterSuspended and handleArbiterSuspensionLifted.
//
// The suspension carries two moments — when it was announced and when it runs
// out — and they are both BigInt. Putting the block clock where the window end
// belongs produces a card saying the suspension expired the instant it started,
// and nothing about the types would object.
//
// The lift is a record of its own rather than a field on the suspension, and
// these tests hold that shape: liftSuspension emits unconditionally, so a lift
// exists for windows nobody announced. Those are the interesting ones.

import { assert, describe, test, afterEach, clearStore } from 'matchstick-as/assembly/index'
import { Arbiter, ArbiterSuspensionLift } from '../generated/schema'
import { handleArbiterSuspended, handleArbiterSuspensionLifted } from '../src/arbiter'
import {
  ARBITER,
  OWNER,
  TS,
  TS2,
  BLOCK,
  BLOCK2,
  UNTIL,
  TX,
  TX2,
  recordId,
  suspendedEvent,
  suspensionLiftedEvent,
} from './helpers'

describe('ArbiterSuspended', () => {
  afterEach(() => {
    clearStore()
  })

  test('suspended: the end of the window is its own number, not the block clock', () => {
    handleArbiterSuspended(suspendedEvent(ARBITER, OWNER, UNTIL, TS, BLOCK, TX, 1))

    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'until', UNTIL.toString())
    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'timestamp', TS.toString())
    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'blockNumber', BLOCK.toString())
  })

  test('suspended: the record says who was suspended and who pressed', () => {
    handleArbiterSuspended(suspendedEvent(ARBITER, OWNER, UNTIL, TS, BLOCK, TX, 1))

    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'by', OWNER.toHexString())
    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'kind', 'suspended')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'suspensionCount', '1')
    assert.entityCount('Arbiter', 1)
    assert.notInStore('Arbiter', OWNER.toHexString())

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'latestSuspension', recordId(TX, 1))
  })

  // A suspension does not unseat anybody: the seat and the window are separate
  // pieces of state on the chain, and a handler that mixed them would make an
  // arbiter disappear from the corps for three days.
  test('suspended: an announced window does not take the seat away', () => {
    handleArbiterSuspended(suspendedEvent(ARBITER, OWNER, UNTIL, TS, BLOCK, TX, 1))

    let arbiter = Arbiter.load(ARBITER.toHexString())!
    assert.assertTrue(arbiter.exitKind === null, 'a suspension is not an exit')
    assert.assertTrue(arbiter.exitAt === null, 'a suspension is not an exit')
  })
})

describe('ArbiterSuspensionLifted', () => {
  afterEach(() => {
    clearStore()
  })

  test('lifted: the lift closes the announced window and the two point at each other', () => {
    handleArbiterSuspended(suspendedEvent(ARBITER, OWNER, UNTIL, TS, BLOCK, TX, 1))
    handleArbiterSuspensionLifted(suspensionLiftedEvent(ARBITER, OWNER, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'liftedAt', TS2.toString())
    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'liftedBy', OWNER.toHexString())
    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'lift', recordId(TX2, 1))
    assert.fieldEquals('ArbiterSuspensionLift', recordId(TX2, 1), 'suspension', recordId(TX, 1))
    assert.fieldEquals('ArbiterSuspensionLift', recordId(TX2, 1), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('ArbiterSuspensionLift', recordId(TX2, 1), 'by', OWNER.toHexString())
    assert.fieldEquals('ArbiterSuspensionLift', recordId(TX2, 1), 'kind', 'suspensionLifted')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'suspensionLiftCount', '1')
  })

  // Both removal doors open a 72-hour window on the way out and emit nothing
  // about it, so a lift with no announced suspension behind it is a normal
  // event and the one a reader most wants to see. It must not vanish.
  test('lifted: a lift with no announced window is still a record of its own', () => {
    handleArbiterSuspensionLifted(suspensionLiftedEvent(ARBITER, OWNER, TS, BLOCK, TX, 1))

    assert.fieldEquals('ArbiterSuspensionLift', recordId(TX, 1), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('ArbiterSuspensionLift', recordId(TX, 1), 'timestamp', TS.toString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'suspensionLiftCount', '1')
    assert.entityCount('ArbiterSuspension', 0)

    let lift = ArbiterSuspensionLift.load(recordId(TX, 1))!
    assert.assertTrue(lift.suspension === null, 'there was no announced window to attach to')
  })

  test('lifted: a second lift does not re-close a window already closed', () => {
    handleArbiterSuspended(suspendedEvent(ARBITER, OWNER, UNTIL, TS, BLOCK, TX, 1))
    handleArbiterSuspensionLifted(suspensionLiftedEvent(ARBITER, OWNER, TS2, BLOCK2, TX2, 1))
    handleArbiterSuspensionLifted(suspensionLiftedEvent(ARBITER, OWNER, TS2, BLOCK2, TX2, 2))

    // The window keeps the moment of the FIRST lift.
    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'lift', recordId(TX2, 1))
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'suspensionLiftCount', '2')

    let second = ArbiterSuspensionLift.load(recordId(TX2, 2))!
    assert.assertTrue(second.suspension === null, 'the second lift found nothing open')

    assert.fieldEquals('ArbiterSuspension', recordId(TX, 1), 'liftedAt', TS2.toString())
  })
})
