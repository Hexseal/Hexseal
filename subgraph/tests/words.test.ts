// handleRemovalReasonGiven and handleRemovalReplyGiven.
//
// The two logs this branch was built for, and the two that reached nobody
// outside the chain until 21 August 2026. Without them the public record of a
// removal was a cause code and two digests: an accusation nobody had to
// explain, answered by a hash. The words exist on chain — they just were not
// read.
//
// What can go wrong quietly here. Both events carry a `string` in the same
// transaction as the record they belong to, so the accusation's words landing
// in the answer's field, or the other way round, is invisible to the compiler
// and produces a feed where the accused appears to have confessed. And the
// words have to find the right half of the accusation: `stage` says whether
// they were given with the PROPOSAL or with the REMOVAL, and picking "whatever
// is open" instead of reading it attaches the proposal's words to a removal
// that happened for a different reason.

import { assert, describe, test, afterEach, clearStore } from 'matchstick-as/assembly/index'
import {
  handleRemovalReasonGiven,
  handleRemovalReplyGiven,
  handleRemovalProposed,
  handleRemovalAnswered,
  handleArbiterRemovedForCause,
} from '../src/arbiter'
import {
  ARBITER,
  DIRECTOR,
  OWNER,
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
  REPLY,
  REASON_TEXT,
  REPLY_TEXT,
  recordId,
  reasonGivenEvent,
  replyGivenEvent,
  removalProposedEvent,
  removalAnsweredEvent,
  removedForCauseEvent,
} from './helpers'

const CAUSE_COLLUSION = 3
const STAGE_PROPOSAL = 0
const STAGE_REMOVAL = 1

describe('RemovalReasonGiven', () => {
  afterEach(() => {
    clearStore()
  })

  // The scene of the design: the director says what he is accusing the man of,
  // in the same transaction as the accusation, and the words hang off it.
  test('reason: the words of a proposal reach the feed and point at the proposal', () => {
    handleRemovalProposed(
      removalProposedEvent(ARBITER, DIRECTOR, CAUSE_COLLUSION, EVIDENCE, PROPOSED_AT, TS, BLOCK, TX, 1)
    )
    handleRemovalReasonGiven(
      reasonGivenEvent(ARBITER, DIRECTOR, STAGE_PROPOSAL, REASON_TEXT, TS, BLOCK, TX, 2)
    )

    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'by', DIRECTOR.toHexString())
    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'kind', 'removalReasonGiven')
    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'stage', STAGE_PROPOSAL.toString())
    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'reason', REASON_TEXT)
    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'timestamp', TS.toString())
    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'blockNumber', BLOCK.toString())

    // The link is what puts the cause code and the words on one line.
    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'proposal', recordId(TX, 1))
  })

  test('reason: the words of a removal point at the removal, not at the proposal', () => {
    handleRemovalProposed(
      removalProposedEvent(ARBITER, DIRECTOR, CAUSE_COLLUSION, EVIDENCE, PROPOSED_AT, TS, BLOCK, TX, 1)
    )
    handleArbiterRemovedForCause(
      removedForCauseEvent(ARBITER, OWNER, CAUSE_COLLUSION, false, EVIDENCE, BOND_FORFEITED, TS2, BLOCK2, TX2, 1)
    )
    handleRemovalReasonGiven(
      reasonGivenEvent(ARBITER, OWNER, STAGE_REMOVAL, REASON_TEXT, TS2, BLOCK2, TX2, 3)
    )

    assert.fieldEquals('RemovalReason', recordId(TX2, 3), 'removal', recordId(TX2, 1))
    assert.fieldEquals('RemovalReason', recordId(TX2, 3), 'stage', STAGE_REMOVAL.toString())
    // The accuser at the removal is the owner, not the director who proposed —
    // the whole reason the two records carry two addresses.
    assert.fieldEquals('RemovalReason', recordId(TX2, 3), 'by', OWNER.toHexString())
  })

  // The stage is READ, not guessed. With the proposal still standing and no
  // removal anywhere, words stamped `stage = 1` must not be quietly filed under
  // the proposal that happens to be open.
  test('reason: a stage the store cannot match still keeps the words', () => {
    handleRemovalProposed(
      removalProposedEvent(ARBITER, DIRECTOR, CAUSE_COLLUSION, EVIDENCE, PROPOSED_AT, TS, BLOCK, TX, 1)
    )
    handleRemovalReasonGiven(
      reasonGivenEvent(ARBITER, OWNER, STAGE_REMOVAL, REASON_TEXT, TS, BLOCK, TX, 2)
    )

    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'reason', REASON_TEXT)
    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'stage', STAGE_REMOVAL.toString())
  })
})

describe('RemovalReplyGiven', () => {
  afterEach(() => {
    clearStore()
  })

  // The other half of owner decision 2, and the one the chain keeps worst: the
  // digest is in storage with no moment, the words are in the log with no
  // storage at all.
  test('reply: the words of the answer reach the feed and point at the answer', () => {
    handleRemovalProposed(
      removalProposedEvent(ARBITER, DIRECTOR, CAUSE_COLLUSION, EVIDENCE, PROPOSED_AT, TS, BLOCK, TX, 1)
    )
    handleRemovalAnswered(removalAnsweredEvent(ARBITER, REPLY, TS2, BLOCK2, TX2, 1))
    handleRemovalReplyGiven(replyGivenEvent(ARBITER, REPLY_TEXT, TS2, BLOCK2, TX2, 2))

    assert.fieldEquals('RemovalReply', recordId(TX2, 2), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('RemovalReply', recordId(TX2, 2), 'kind', 'removalReplyGiven')
    assert.fieldEquals('RemovalReply', recordId(TX2, 2), 'reply', REPLY_TEXT)
    assert.fieldEquals('RemovalReply', recordId(TX2, 2), 'answer', recordId(TX2, 1))
    // The presser is the arbiter himself: respondToRemoval reads _msgSender().
    assert.fieldEquals('RemovalReply', recordId(TX2, 2), 'by', ARBITER.toHexString())
    assert.fieldEquals('RemovalReply', recordId(TX2, 2), 'timestamp', TS2.toString())
  })

  // The scene the whole branch is about: accusation with words, answer with
  // words, both on chain, both readable, and neither wearing the other's text.
  test('reply: accusation and answer stand level, each in its own words', () => {
    handleRemovalProposed(
      removalProposedEvent(ARBITER, DIRECTOR, CAUSE_COLLUSION, EVIDENCE, PROPOSED_AT, TS, BLOCK, TX, 1)
    )
    handleRemovalReasonGiven(
      reasonGivenEvent(ARBITER, DIRECTOR, STAGE_PROPOSAL, REASON_TEXT, TS, BLOCK, TX, 2)
    )
    handleRemovalAnswered(removalAnsweredEvent(ARBITER, REPLY, TS2, BLOCK2, TX2, 1))
    handleRemovalReplyGiven(replyGivenEvent(ARBITER, REPLY_TEXT, TS2, BLOCK2, TX2, 2))

    assert.fieldEquals('RemovalReason', recordId(TX, 2), 'reason', REASON_TEXT)
    assert.fieldEquals('RemovalReply', recordId(TX2, 2), 'reply', REPLY_TEXT)
    // The answer was given during the pause, so it is the PROPOSAL it answers —
    // nothing has been removed, and neither of the removal pointers is set.
    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'proposal', recordId(TX, 1))
    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'timestamp', TS2.toString())
    // The moment of the accusation and the moment of the answer are two
    // different numbers, which is the one thing the contract cannot say.
    assert.fieldEquals('RemovalProposal', recordId(TX, 1), 'timestamp', TS.toString())
  })
})
