// Event builders and the cast of characters the arbiter tests share.
//
// EVERY VALUE BELOW IS DISTINCT FROM EVERY OTHER VALUE OF ITS TYPE, and that is
// the whole point of this file rather than a tidiness habit. The failure these
// tests exist to catch is a handler reading the wrong field of the right type —
// `event.params.by` where `event.params.arbiter` was meant, `event.block.number`
// where `event.block.timestamp` was meant. The compiler cannot see it: both
// sides are Address, or both are BigInt, or both are Bytes. A test only sees it
// if the two values differ, so:
//
//   • five addresses, none of them equal, none of them zero except ZERO itself;
//   • every BigInt different — the block clock, the block height, the suspension
//     end, the two bond amounts and the proposal moment are five distinct
//     numbers, so putting any of them in another's field is visible;
//   • three distinct bytes32 — the transaction hash, the evidence digest and the
//     reply digest.
//
// If a value is ever reused for two different roles, the swap between those two
// roles stops being measurable and a test that "passes" stops meaning anything.

import { Address, BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { newMockEvent } from 'matchstick-as/assembly/index'
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
} from '../generated/Diamond/Diamond'

// ── the cast ─────────────────────────────────────────────────────────────────

/** The arbiter every record below is about. */
export const ARBITER = Address.fromString('0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1')
/** A second arbiter, so "this one's counter" can be told from "everyone's". */
export const OTHER_ARBITER = Address.fromString('0xf6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6')
/** The owner seating somebody through addArbiter. */
export const SEATER = Address.fromString('0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2')
/** A director: proposes and withdraws, never removes. */
export const DIRECTOR = Address.fromString('0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3')
/** The owner pressing removeForCause / suspend / lift. */
export const OWNER = Address.fromString('0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4')
/** The deal a demotion's last mistake landed on. */
export const AGREEMENT = Address.fromString('0xe5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5')
/** The zero the contract uses to say "nobody pressed this". */
export const ZERO = Address.zero()

// ── the clocks and the counters ──────────────────────────────────────────────

/** Block timestamp of the first transaction in a scene. */
export const TS = BigInt.fromI32(1700000000)
/** Block timestamp of the second — an hour later, never equal to TS. */
export const TS2 = BigInt.fromI32(1700003600)
/** Block height of the first transaction. Deliberately nothing like TS. */
export const BLOCK = BigInt.fromI32(44700123)
/** Block height of the second. */
export const BLOCK2 = BigInt.fromI32(44700423)
/** End of an announced suspension: a moment, but not either block's moment. */
export const UNTIL = BigInt.fromI32(1700259200)
/** Bond handed back on resignation. */
export const BOND_REFUNDED = BigInt.fromI32(6000000)
/** Bond burnt on removal — a different amount from the refunded one. */
export const BOND_FORFEITED = BigInt.fromI32(9000000)
/** When a proposal was made, as the consumed snapshot reports it. */
export const PROPOSED_AT = BigInt.fromI32(1699990000)

// ── the hashes ───────────────────────────────────────────────────────────────

export const TX = Bytes.fromHexString(
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
) as Bytes
export const TX2 = Bytes.fromHexString(
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
) as Bytes
export const EVIDENCE = Bytes.fromHexString(
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
) as Bytes
export const EVIDENCE2 = Bytes.fromHexString(
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
) as Bytes
export const REPLY = Bytes.fromHexString(
  '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
) as Bytes

/** The id every record entity gets: txHash-logIndex. */
export function recordId(tx: Bytes, logIndex: i32): string {
  return tx.toHexString() + '-' + logIndex.toString()
}

// ── builders ─────────────────────────────────────────────────────────────────

// One mock event, stamped with a block and a transaction. Both are always
// passed in: a scene with two logs in one transaction (removal + consumed
// proposal) and a scene with two transactions (accusation, then the answer an
// hour later) are different scenes, and the tests need to build both.
function mockEvent(ts: BigInt, block: BigInt, tx: Bytes, logIndex: i32): ethereum.Event {
  let event = newMockEvent()
  event.parameters = new Array<ethereum.EventParam>()
  event.block.timestamp = ts
  event.block.number = block
  event.transaction.hash = tx
  event.logIndex = BigInt.fromI32(logIndex)
  return event
}

function addr(name: string, value: Address): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromAddress(value))
}

function num(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(value))
}

function small(name: string, value: i32): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(value)))
}

function flag(name: string, value: boolean): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromBoolean(value))
}

function digest(name: string, value: Bytes): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromFixedBytes(value))
}

export function seatedEvent(
  arbiter: Address,
  by: Address,
  selfService: boolean,
  ts: BigInt,
  block: BigInt,
  tx: Bytes,
  logIndex: i32
): ArbiterSeated {
  let event = changetype<ArbiterSeated>(mockEvent(ts, block, tx, logIndex))
  event.parameters.push(addr('arbiter', arbiter))
  event.parameters.push(addr('by', by))
  event.parameters.push(flag('selfService', selfService))
  return event
}

export function resignedEvent(
  arbiter: Address,
  bondRefunded: BigInt,
  ts: BigInt,
  block: BigInt,
  tx: Bytes,
  logIndex: i32
): ArbiterResigned {
  let event = changetype<ArbiterResigned>(mockEvent(ts, block, tx, logIndex))
  event.parameters.push(addr('arbiter', arbiter))
  event.parameters.push(num('bondRefunded', bondRefunded))
  return event
}

export function demotedEvent(
  arbiter: Address,
  by: Address,
  path: i32,
  agreement: Address,
  ts: BigInt,
  block: BigInt,
  tx: Bytes,
  logIndex: i32
): ArbiterDemoted {
  let event = changetype<ArbiterDemoted>(mockEvent(ts, block, tx, logIndex))
  event.parameters.push(addr('arbiter', arbiter))
  event.parameters.push(addr('by', by))
  event.parameters.push(small('path', path))
  event.parameters.push(addr('agreement', agreement))
  return event
}

export function suspendedEvent(
  arbiter: Address,
  by: Address,
  until: BigInt,
  ts: BigInt,
  block: BigInt,
  tx: Bytes,
  logIndex: i32
): ArbiterSuspended {
  let event = changetype<ArbiterSuspended>(mockEvent(ts, block, tx, logIndex))
  event.parameters.push(addr('arbiter', arbiter))
  event.parameters.push(addr('by', by))
  event.parameters.push(num('until', until))
  return event
}

export function suspensionLiftedEvent(
  arbiter: Address,
  by: Address,
  ts: BigInt,
  block: BigInt,
  tx: Bytes,
  logIndex: i32
): ArbiterSuspensionLifted {
  let event = changetype<ArbiterSuspensionLifted>(mockEvent(ts, block, tx, logIndex))
  event.parameters.push(addr('arbiter', arbiter))
  event.parameters.push(addr('by', by))
  return event
}

export function removedForCauseEvent(
  arbiter: Address,
  by: Address,
  cause: i32,
  verifiedByChain: boolean,
  evidenceDigest: Bytes,
  bondForfeited: BigInt,
  ts: BigInt,
  block: BigInt,
  tx: Bytes,
  logIndex: i32
): ArbiterRemovedForCause {
  let event = changetype<ArbiterRemovedForCause>(mockEvent(ts, block, tx, logIndex))
  event.parameters.push(addr('arbiter', arbiter))
  event.parameters.push(addr('by', by))
  event.parameters.push(small('cause', cause))
  event.parameters.push(flag('verifiedByChain', verifiedByChain))
  event.parameters.push(digest('evidenceDigest', evidenceDigest))
  event.parameters.push(num('bondForfeited', bondForfeited))
  return event
}

export function removalProposedEvent(
  arbiter: Address,
  by: Address,
  cause: i32,
  evidenceDigest: Bytes,
  at: BigInt,
  ts: BigInt,
  block: BigInt,
  tx: Bytes,
  logIndex: i32
): RemovalProposed {
  let event = changetype<RemovalProposed>(mockEvent(ts, block, tx, logIndex))
  event.parameters.push(addr('arbiter', arbiter))
  event.parameters.push(addr('by', by))
  event.parameters.push(small('cause', cause))
  event.parameters.push(digest('evidenceDigest', evidenceDigest))
  event.parameters.push(num('at', at))
  return event
}

export function removalWithdrawnEvent(
  arbiter: Address,
  by: Address,
  ts: BigInt,
  block: BigInt,
  tx: Bytes,
  logIndex: i32
): RemovalProposalWithdrawn {
  let event = changetype<RemovalProposalWithdrawn>(mockEvent(ts, block, tx, logIndex))
  event.parameters.push(addr('arbiter', arbiter))
  event.parameters.push(addr('by', by))
  return event
}

export function removalConsumedEvent(
  arbiter: Address,
  proposedCause: i32,
  proposedBy: Address,
  evidenceDigest: Bytes,
  proposedAt: BigInt,
  ts: BigInt,
  block: BigInt,
  tx: Bytes,
  logIndex: i32
): RemovalProposalConsumed {
  let event = changetype<RemovalProposalConsumed>(mockEvent(ts, block, tx, logIndex))
  event.parameters.push(addr('arbiter', arbiter))
  event.parameters.push(small('proposedCause', proposedCause))
  event.parameters.push(addr('proposedBy', proposedBy))
  event.parameters.push(digest('evidenceDigest', evidenceDigest))
  event.parameters.push(num('proposedAt', proposedAt))
  return event
}

export function removalAnsweredEvent(
  arbiter: Address,
  replyDigest: Bytes,
  ts: BigInt,
  block: BigInt,
  tx: Bytes,
  logIndex: i32
): RemovalAnswered {
  let event = changetype<RemovalAnswered>(mockEvent(ts, block, tx, logIndex))
  event.parameters.push(addr('arbiter', arbiter))
  event.parameters.push(digest('replyDigest', replyDigest))
  return event
}
