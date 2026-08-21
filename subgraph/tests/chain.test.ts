// The chain as accuser, and the evidence underneath the accusation.
//
// handleRemovalProposedByChain, handleChainAccusationCleared, and the four
// verdict handlers that exist only to make the accusation readable.
//
// WHY THIS FILE IS THE ONE THAT MATTERS. On the third judicial mistake the
// chain suspends the arbiter and accuses him in its own name; forty-eight hours
// later anyone may execute that accusation. Until 21 August 2026 the accusation
// was not indexed at all, so the removal that followed it appeared in the feed
// as a seat taken away with no accuser, no pause and no right of reply — the
// exact appearance the whole branch was built to get rid of.
//
// AND THE HARD HALF IS THE SERIES. The accusation names ONE dispute, the one
// that tipped him over, and it stands on three (owner decision 15a, 20 August
// 2026: the accused must see all of them). The other two are in the log and
// nowhere else, so they are recovered here — which means the RESETS have to be
// recovered as well. A streak is mistakes in an unbroken ROW: get the breaks
// wrong and the record either shows disputes the accusation does not stand on,
// or loses the ones it does.

import { Address, BigInt, Bytes } from '@graphprotocol/graph-ts'
import { assert, describe, test, afterEach, clearStore } from 'matchstick-as/assembly/index'
import {
  handleRemovalProposedByChain,
  handleChainAccusationCleared,
  handleVerdictSubmitted,
  handleVerdictOverturned,
  handleVerdictFinalized,
  handleAppealResolved,
  handleArbiterDemoted,
  handleArbiterResigned,
  handleRemovalAnswered,
  handleRemovalProposalWithdrawn,
  handleArbiterTimeoutRecorded,
} from '../src/arbiter'
import {
  ARBITER,
  OTHER_ARBITER,
  OWNER,
  APPELLANT,
  AGREEMENT,
  AGREEMENT2,
  AGREEMENT3,
  ZERO,
  TS,
  TS2,
  TS3,
  TS4,
  BLOCK,
  BLOCK2,
  BLOCK3,
  BLOCK4,
  BOND_REFUNDED,
  CHAIN_PROPOSED_AT,
  TX,
  TX2,
  REPLY,
  recordId,
  chainProposedEvent,
  chainClearedEvent,
  verdictSubmittedEvent,
  verdictOverturnedEvent,
  verdictFinalizedEvent,
  appealResolvedEvent,
  demotedEvent,
  resignedEvent,
  removalAnsweredEvent,
  removalWithdrawnEvent,
  timeoutRecordedEvent,
} from './helpers'

// Raw ArbiterRegistryFacet.DemotionPath, as the log carries it. Not decoded
// anywhere in the mapping — only carried through — so these are here to name
// the scene, not to be relied on.
const PATH_OWNER_OVERTURN = 1
const PATH_AGREEMENT_TIMEOUT = 2
const PATH_APPEAL_VOTE = 3

/** One overturn by hand: the verdict, then the press. */
function handOverturn(agreement: Address, ts: BigInt, block: BigInt, tx: Bytes, logIndex: i32): void {
  handleVerdictSubmitted(verdictSubmittedEvent(agreement, ARBITER, true, ts, block, tx, logIndex))
  handleVerdictOverturned(verdictOverturnedEvent(agreement, ARBITER, false, ts, block, tx, logIndex + 1))
}


describe('RemovalProposedByChain', () => {
  afterEach(() => {
    clearStore()
  })

  test('accused by the chain: the record reaches the feed with no accuser named', () => {
    handOverturn(AGREEMENT3, TS, BLOCK, TX, 1)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_OWNER_OVERTURN, AGREEMENT3, CHAIN_PROPOSED_AT, TS, BLOCK, TX, 3)
    )

    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'kind', 'removalProposedByChain')
    // The zero is an assertion, not a gap: executeChainRemoval refuses any
    // accusation that has an author.
    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'by', ZERO.toHexString())
    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'path', PATH_OWNER_OVERTURN.toString())
    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'agreement', AGREEMENT3.toHexString())
    // The forty-eight hours run from the chain's own stamp, which is why it is
    // stored instead of the block clock.
    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'proposedAt', CHAIN_PROPOSED_AT.toString())
    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'timestamp', TS.toString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'openChainAccusation', recordId(TX, 3))
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'chainAccusationCount', '1')
  })

  // ⚠️ OWNER DECISION 15a. The record carries every dispute the accusation
  // stands on, not the last of them.
  test('accused by the chain: all three disputes of the series are on the record', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)
    handOverturn(AGREEMENT2, TS2, BLOCK2, TX2, 1)
    handOverturn(AGREEMENT3, TS3, BLOCK3, TX, 5)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_OWNER_OVERTURN, AGREEMENT3, CHAIN_PROPOSED_AT, TS3, BLOCK3, TX, 7)
    )

    assert.fieldEquals('ChainAccusation', recordId(TX, 7), 'disputeCount', '3')
    assert.fieldEquals(
      'ChainAccusation',
      recordId(TX, 7),
      'disputes',
      '[' + AGREEMENT.toHexString() + ', ' + AGREEMENT2.toHexString() + ', ' + AGREEMENT3.toHexString() + ']'
    )
  })

  // The break in the row. A verdict finalized without having been overturned
  // zeroes the streak on chain, so the disputes before it are NOT part of the
  // accusation that comes later, and showing them would be an accusation
  // standing on evidence it does not stand on.
  test('accused by the chain: a clean verdict between the mistakes breaks the row', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)

    handleVerdictSubmitted(verdictSubmittedEvent(AGREEMENT2, ARBITER, true, TS2, BLOCK2, TX2, 1))
    handleVerdictFinalized(verdictFinalizedEvent(AGREEMENT2, ARBITER, true, TS2, BLOCK2, TX2, 2))

    handOverturn(AGREEMENT3, TS3, BLOCK3, TX, 5)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_OWNER_OVERTURN, AGREEMENT3, CHAIN_PROPOSED_AT, TS3, BLOCK3, TX, 7)
    )

    assert.fieldEquals('ChainAccusation', recordId(TX, 7), 'disputeCount', '1')
    assert.fieldEquals('ChainAccusation', recordId(TX, 7), 'disputes', '[' + AGREEMENT3.toHexString() + ']')
    // And the clean one was counted as clean.
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'cleanVerdicts', '1')
  })

  // ⚠️ THE SCENE THE CONTRACT WAS CHANGED FOR. A run of three with a TIMEOUT in
  // the middle, and all three disputes on the record.
  //
  // This test used to be called "a timeout in the run leaves the record short,
  // and countable" and asserted disputeCount 2 — the middle mistake was
  // invisible, because notifyArbiterTimeout emitted nothing naming the arbiter
  // and Agreement's ArbiterTimedOut names the client. The owner refused the
  // shortfall: the accused sees all three or the record is not doing its job.
  // ArbiterTimeoutRecorded was added to the contract on 21 August 2026, and
  // this is what it bought.
  test('accused by the chain: a timeout in the middle of the run is on the record like the rest', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)
    handleArbiterTimeoutRecorded(timeoutRecordedEvent(ARBITER, AGREEMENT2, TS2, BLOCK2, TX2, 1))
    handOverturn(AGREEMENT3, TS3, BLOCK3, TX, 5)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_OWNER_OVERTURN, AGREEMENT3, CHAIN_PROPOSED_AT, TS3, BLOCK3, TX, 7)
    )

    assert.fieldEquals('ChainAccusation', recordId(TX, 7), 'disputeCount', '3')
    assert.fieldEquals(
      'ChainAccusation',
      recordId(TX, 7),
      'disputes',
      '[' + AGREEMENT.toHexString() + ', ' + AGREEMENT2.toHexString() + ', ' + AGREEMENT3.toHexString() + ']'
    )
  })

  // The timeout as the mistake that TIPS him over. The contract emits the
  // accusation from inside the booking and this event after it, so the
  // accusation has to carry the tipping dispute itself rather than wait for the
  // log that names it — the same position VerdictOverturned sits in.
  test('accused by the chain: a timeout that tips him over is on its own accusation', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)
    handOverturn(AGREEMENT3, TS2, BLOCK2, TX2, 1)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_AGREEMENT_TIMEOUT, AGREEMENT2, CHAIN_PROPOSED_AT, TS3, BLOCK3, TX, 7)
    )
    handleArbiterTimeoutRecorded(timeoutRecordedEvent(ARBITER, AGREEMENT2, TS3, BLOCK3, TX, 8))

    assert.fieldEquals('ChainAccusation', recordId(TX, 7), 'disputeCount', '3')
    assert.fieldEquals('ChainAccusation', recordId(TX, 7), 'path', PATH_AGREEMENT_TIMEOUT.toString())
    // And the running list did not gain it twice: the accusation froze a copy,
    // it did not append to the list.
    assert.fieldEquals(
      'Arbiter',
      ARBITER.toHexString(),
      'currentSeries',
      '[' + AGREEMENT.toHexString() + ', ' + AGREEMENT3.toHexString() + ', ' + AGREEMENT2.toHexString() + ']'
    )
  })

  // A timeout is a mistake of the STREAK and not a mark against a verdict: on
  // chain the cumulative count takes an allow-list of demotion paths and the
  // timeout is not on it, because there was no ruling to overturn.
  test('accused by the chain: a timeout grows the row and not the overturn count', () => {
    handleArbiterTimeoutRecorded(timeoutRecordedEvent(ARBITER, AGREEMENT2, TS, BLOCK, TX, 1))

    assert.fieldEquals('ArbiterTimeout', recordId(TX, 1), 'arbiter', ARBITER.toHexString())
    assert.fieldEquals('ArbiterTimeout', recordId(TX, 1), 'kind', 'arbiterTimedOut')
    assert.fieldEquals('ArbiterTimeout', recordId(TX, 1), 'agreement', AGREEMENT2.toHexString())
    // Nobody pressed: notifyArbiterTimeout refuses any caller but the deal.
    assert.fieldEquals('ArbiterTimeout', recordId(TX, 1), 'by', ZERO.toHexString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'timeoutCount', '1')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'overturnedVerdicts', '0')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'currentSeries', '[' + AGREEMENT2.toHexString() + ']')
  })

  // The break in the row works on a timeout exactly as on an overturn.
  test('accused by the chain: a clean verdict after a timeout breaks the row too', () => {
    handleArbiterTimeoutRecorded(timeoutRecordedEvent(ARBITER, AGREEMENT2, TS, BLOCK, TX, 1))
    handleVerdictSubmitted(verdictSubmittedEvent(AGREEMENT, ARBITER, true, TS2, BLOCK2, TX2, 1))
    handleVerdictFinalized(verdictFinalizedEvent(AGREEMENT, ARBITER, true, TS2, BLOCK2, TX2, 2))

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'currentSeries', '[]')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'timeoutCount', '1')
  })

  // The panel overturning a verdict nobody had touched is a judicial mistake
  // that VerdictOverturned never mentions. Left unread, the finalization that
  // follows would look clean and wipe the row.
  test('accused by the chain: an overturn by the panel counts, and the finalization after it does not break the row', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)

    handleVerdictSubmitted(verdictSubmittedEvent(AGREEMENT2, ARBITER, true, TS2, BLOCK2, TX2, 1))
    handleAppealResolved(appealResolvedEvent(AGREEMENT2, APPELLANT, true, TS2, BLOCK2, TX2, 2))
    handleVerdictFinalized(verdictFinalizedEvent(AGREEMENT2, ARBITER, false, TS3, BLOCK3, TX2, 3))

    handOverturn(AGREEMENT3, TS3, BLOCK3, TX, 5)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_APPEAL_VOTE, AGREEMENT3, CHAIN_PROPOSED_AT, TS3, BLOCK3, TX, 7)
    )

    assert.fieldEquals('ChainAccusation', recordId(TX, 7), 'disputeCount', '3')
    assert.fieldEquals(
      'ChainAccusation',
      recordId(TX, 7),
      'disputes',
      '[' + AGREEMENT.toHexString() + ', ' + AGREEMENT2.toHexString() + ', ' + AGREEMENT3.toHexString() + ']'
    )
    // The panel's overturn is a record of its own, and it states no outcome:
    // AppealResolved says only that the vote carried.
    assert.fieldEquals('VerdictOverturn', recordId(TX2, 2), 'byPanel', 'true')
    assert.fieldEquals('VerdictOverturn', recordId(TX2, 2), 'agreement', AGREEMENT2.toHexString())
    // Nothing was counted as a clean verdict: the finalization found it
    // overturned.
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'cleanVerdicts', '0')
  })

  test('accused by the chain: one arbiter series is not another arbiter series', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)

    handleVerdictSubmitted(verdictSubmittedEvent(AGREEMENT2, OTHER_ARBITER, true, TS2, BLOCK2, TX2, 1))
    handleVerdictOverturned(verdictOverturnedEvent(AGREEMENT2, OTHER_ARBITER, false, TS2, BLOCK2, TX2, 2))

    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_OWNER_OVERTURN, AGREEMENT, CHAIN_PROPOSED_AT, TS3, BLOCK3, TX, 7)
    )

    assert.fieldEquals('ChainAccusation', recordId(TX, 7), 'disputeCount', '1')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'overturnedVerdicts', '1')
    assert.fieldEquals('Arbiter', OTHER_ARBITER.toHexString(), 'overturnedVerdicts', '1')
  })

  // The forty-eight hours are his only move, and the answer has to land
  // somewhere. Before the accusation was indexed it landed nowhere at all.
  test('accused by the chain: the answer given during the pause hangs off the accusation', () => {
    handOverturn(AGREEMENT3, TS, BLOCK, TX, 1)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_OWNER_OVERTURN, AGREEMENT3, CHAIN_PROPOSED_AT, TS, BLOCK, TX, 3)
    )
    handleRemovalAnswered(removalAnsweredEvent(ARBITER, REPLY, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'answer', recordId(TX2, 1))
    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'answeredAt', TS2.toString())
    assert.fieldEquals('RemovalAnswer', recordId(TX2, 1), 'chainAccusation', recordId(TX, 3))
  })

  // ⚠️ THE CONSEQUENCE THE WHOLE FILE EXISTS FOR. The demotion is the
  // EXECUTION of this accusation, and the contract erases the accusation on the
  // way out without a word about it. Left open, the feed shows a standing
  // accusation against a man already removed; never shown at all, the removal
  // reads as a seat taken away with nothing said first.
  test('accused by the chain: the demotion closes the accusation it executed', () => {
    handOverturn(AGREEMENT3, TS, BLOCK, TX, 1)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_OWNER_OVERTURN, AGREEMENT3, CHAIN_PROPOSED_AT, TS, BLOCK, TX, 3)
    )
    handleArbiterDemoted(demotedEvent(ARBITER, ZERO, PATH_OWNER_OVERTURN, AGREEMENT3, TS4, BLOCK4, TX2, 1))

    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'voidedAt', TS4.toString())
    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'voidedReason', 'demoted')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'openChainAccusation', 'null')
    // _performRemoval zeroes the streak on the way out: the evidence is spent.
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'currentSeries', '[]')
  })

  // The other silent erasure: clearSeat wipes the accusation when the man
  // resigns, and leaves the mistake counter exactly where it was.
  test('accused by the chain: a resignation voids the accusation and keeps the row', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_OWNER_OVERTURN, AGREEMENT, CHAIN_PROPOSED_AT, TS, BLOCK, TX, 3)
    )
    handleArbiterResigned(resignedEvent(ARBITER, BOND_REFUNDED, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'voidedReason', 'resigned')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'currentSeries', '[' + AGREEMENT.toHexString() + ']')
  })

  // One event, two kinds of accusation. Withdrawing the chain's zeroes the
  // counter; withdrawing a person's says nothing about his mistakes.
  test('accused by the chain: withdrawing the accusation empties the row', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_OWNER_OVERTURN, AGREEMENT, CHAIN_PROPOSED_AT, TS, BLOCK, TX, 3)
    )
    handleRemovalProposalWithdrawn(removalWithdrawnEvent(ARBITER, OWNER, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'withdrawnAt', TS2.toString())
    assert.fieldEquals('ChainAccusation', recordId(TX, 3), 'withdrawnBy', OWNER.toHexString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'currentSeries', '[]')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'openChainAccusation', 'null')
  })
})

describe('ChainAccusationCleared', () => {
  afterEach(() => {
    clearStore()
  })

  // The panel found him right, so the chain takes its own accusation back. His
  // real defence is not the words, it is the review.
  test('vindicated: the accusation is closed, dated, and the row is emptied', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)
    handOverturn(AGREEMENT3, TS2, BLOCK2, TX2, 1)
    handleRemovalProposedByChain(
      chainProposedEvent(ARBITER, PATH_OWNER_OVERTURN, AGREEMENT3, CHAIN_PROPOSED_AT, TS2, BLOCK2, TX2, 3)
    )
    handleChainAccusationCleared(chainClearedEvent(ARBITER, AGREEMENT3, TS3, BLOCK3, TX, 9))

    assert.fieldEquals('ChainAccusation', recordId(TX2, 3), 'clearedAt', TS3.toString())
    assert.fieldEquals('ChainAccusation', recordId(TX2, 3), 'clearedOn', AGREEMENT3.toHexString())
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'openChainAccusation', 'null')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'currentSeries', '[]')
    // The frozen copy of the evidence is NOT erased with the accusation: it
    // happened, and the feed's whole purpose is that what happened stays
    // readable.
    assert.fieldEquals('ChainAccusation', recordId(TX2, 3), 'disputeCount', '2')
  })
})

describe('the pair of numbers', () => {
  afterEach(() => {
    clearStore()
  })

  // Owner decision 16: judged and overturned, both counted, no threshold
  // reading either. The sum alone punishes long service; the pair is what a
  // reader can divide.
  test('counted: clean verdicts and overturned ones are two different numbers', () => {
    handleVerdictSubmitted(verdictSubmittedEvent(AGREEMENT, ARBITER, true, TS, BLOCK, TX, 1))
    handleVerdictFinalized(verdictFinalizedEvent(AGREEMENT, ARBITER, true, TS, BLOCK, TX, 2))

    handleVerdictSubmitted(verdictSubmittedEvent(AGREEMENT2, ARBITER, true, TS2, BLOCK2, TX2, 1))
    handleVerdictFinalized(verdictFinalizedEvent(AGREEMENT2, ARBITER, true, TS2, BLOCK2, TX2, 2))

    handOverturn(AGREEMENT3, TS3, BLOCK3, TX, 5)

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'cleanVerdicts', '2')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'overturnedVerdicts', '1')
  })

  // A panel restoring the arbiter's own ruling takes the mistake back — one off
  // the row and one off the count, never the whole count: overturns on other
  // disputes stay his.
  test('counted: a vindication gives back exactly one, on the dispute it was about', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)
    handOverturn(AGREEMENT2, TS2, BLOCK2, TX2, 1)
    handleAppealResolved(appealResolvedEvent(AGREEMENT, APPELLANT, true, TS3, BLOCK3, TX, 9))

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'overturnedVerdicts', '1')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'currentSeries', '[' + AGREEMENT2.toHexString() + ']')
    assert.fieldEquals('VerdictOverturn', recordId(TX, 2), 'takenBackAt', TS3.toString())
    assert.fieldEquals('Verdict', AGREEMENT.toHexString(), 'vindicatedAt', TS3.toString())
  })

  // A vote that does not carry is not a judicial anything: the deposit goes to
  // the vault and the verdict stands.
  test('counted: an appeal that fails changes nothing about the arbiter', () => {
    handOverturn(AGREEMENT, TS, BLOCK, TX, 1)
    handleAppealResolved(appealResolvedEvent(AGREEMENT, APPELLANT, false, TS2, BLOCK2, TX2, 1))

    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'overturnedVerdicts', '1')
    assert.fieldEquals('Arbiter', ARBITER.toHexString(), 'currentSeries', '[' + AGREEMENT.toHexString() + ']')
  })
})
