// handleRemovalAnswered.
//
// This is the handler the whole indexer was written for. getArbiterStanding()
// dates the accusation without any indexer; getRemovalReply() hands back a
// digest and no moment at all. The moment the accused replied exists in exactly
// one place — this log — so a card that shows the accusation and the answer
// level with each other depends entirely on what happens below.
//
// Two things can go wrong quietly. The reply digest and the transaction hash
// are both Bytes, so the wrong one lands in `replyDigest` without a murmur from
// the compiler and the card shows a hash nobody signed. And the answer has to
// find the accusation it answers: a removal for cause and an automatic demotion
// both open the right to reply, and hanging the answer off the wrong one — or
// off nothing — leaves the accusation looking unanswered.

import { assert, describe, test, afterEach, clearStore } from 'matchstick-as/assembly/index'
import { ArbiterRemoval, RemovalAnswer } from '../generated/schema'
import {
  handleRemovalAnswered,
  handleArbiterRemovedForCause,
  handleArbiterDemoted,
  handleArbiterSeated,
} from '../src/arbiter'
import {
  ARBITER,
  SEATER,
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
  REPLY,
  recordId,
  removalAnsweredEvent,
  removedForCauseEvent,
  demotedEvent,
  seatedEvent,
} from './helpers'

const CAUSE_COLLUSION = 3
const PATH_AGREEMENT_TIMEOUT = 2

describe('RemovalAnswered', () => {
  afterEach(() => {
    clearStore()
  })

  // The one the feed exists for: removed on Monday, answered on Tuesday, and
  // both moments readable side by side.
  test('answered: the removed arbiter reply reaches the feed and dates the accusation', () => {
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_COLLUSION, false, EVIDENCE, BOND_FORFEITED, TS, BLOCK, TX, 1)
    )
    handleRemovalAnswered(removalAnsweredEvent(ARBITER, REPLY, TS2, BLOCK2, TX2, 1))

    // The answer as a record in the feed.
    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'by', ARBITER.toHexString())
    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'kind', 'removalAnswered')
    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'timestamp', TS2.toString())
    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'blockNumber', BLOCK2.toString())

    // And the link back, which is what puts the two on one line.
    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'removal', recordId(TX, 1))
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'answer', recordId(TX2, 1))
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'answeredAt', TS2.toString())
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'timestamp', TS.toString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'answerCount', '1')
  })

  test('answered: the reply digest is the one the arbiter signed, not the transaction it rode in', () => {
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_COLLUSION, false, EVIDENCE, BOND_FORFEITED, TS, BLOCK, TX, 1)
    )
    handleRemovalAnswered(removalAnsweredEvent(ARBITER, REPLY, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'replyDigest', REPLY.toHexString())
    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'txHash', TX2.toHexString())
    // …and neither of them is the digest of the accusation being answered.
    assert.fieldEquals('ArbiterRemoval', recordId(TX, 1), 'evidenceDigest', EVIDENCE.toHexString())
  })

  // An automatic demotion sets removedAt exactly as a removal for cause does,
  // so respondToRemoval is open to a demoted arbiter too, and their answer must
  // hang off the demotion rather than off nothing.
  test('answered: a demoted arbiter answers the demotion, not a removal', () => {
    handleArbiterDemoted(demotedEvent(ARBITER, ZERO, PATH_AGREEMENT_TIMEOUT, AGREEMENT, TS, BLOCK, TX, 1))
    handleRemovalAnswered(removalAnsweredEvent(ARBITER, REPLY, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'demotion', recordId(TX, 1))
    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'answer', recordId(TX2, 1))
    assert.fieldEquals('ArbiterDemotion', recordId(TX, 1), 'answeredAt', TS2.toString())

    let answer = RemovalAnswer.load(recordId(TX2, 1))!
    assert.assertTrue(answer.removal === null, 'there was no removal for cause to answer')
  })

  test('answered: an answer with no open accusation is kept rather than dropped', () => {
    handleRemovalAnswered(removalAnsweredEvent(ARBITER, REPLY, TS, BLOCK, TX, 1))

    assert.fieldEquals('RemovalAnswer', recordId(TX, 1), 'replyDigest', REPLY.toHexString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'answerCount', '1')

    let answer = RemovalAnswer.load(recordId(TX, 1))!
    assert.assertTrue(answer.removal === null, 'nothing open to answer')
    assert.assertTrue(answer.demotion === null, 'nothing open to answer')
  })

  // Re-seating clears removedAt and the reply slot on chain, so an answer after
  // a return to the corps has nothing to attach to. The record survives on its
  // own; the old accusation keeps the answer it already had.
  test('answered: re-seating closes the old accusation to any later answer', () => {
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_COLLUSION, false, EVIDENCE, BOND_FORFEITED, TS, BLOCK, TX, 1)
    )
    handleArbiterSeated(seatedEvent(ARBITER, SEATER, false, TS2, BLOCK2, TX2, 1))
    handleRemovalAnswered(removalAnsweredEvent(ARBITER, REPLY, TS2, BLOCK2, TX2, 2))

    let answer = RemovalAnswer.load(recordId(TX2, 2))!
    assert.assertTrue(answer.removal === null, 'the accusation was cleared when the seat came back')

    let removal = ArbiterRemoval.load(recordId(TX, 1))!
    assert.assertTrue(removal.answer === null, 'the old removal was never answered')
    assert.assertTrue(removal.answeredAt === null, 'and carries no answer moment')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'answerCount', '1')
  })
})
