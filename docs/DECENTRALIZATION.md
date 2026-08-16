# Path to Autonomy

Hexseal is **not fully autonomous today, and we say so plainly.** This document
states exactly what a single key can still do, why that key exists, and the
specific events on which each power is given up.

We publish this because the alternative — claiming full autonomy while an
`onlyOwner` function can overturn an arbiter — is the kind of claim any reader
disproves in one minute by opening the contract.

---

## What one key controls today

All of these live behind `onlyOwner` (or `onlyOwnerOrDAO`, where the DAO address
is itself set by the owner) on the Diamond at Base Sepolia.

| Power | Where | What it means in practice |
|---|---|---|
| **Replace any facet** | `diamondCut` (EIP-2535) | The strongest one, and it subsumes the rest: escrow, arbitration and fee logic can all be swapped. Every other guarantee below holds only while this is not used. |
| **Overturn an arbiter's verdict** | `ArbiterRegistryFacet.overturnVerdict` | A decided dispute can be decided differently. |
| **Freeze a verdict** | `ArbiterRegistryFacet.freezeVerdict` / `unfreezeVerdict` | A verdict can be held unexecuted, without a deadline. |
| **Reserve withdrawal gate is bypassable** | `Treasury` + Diamond owner | The gate holds against a manually flipped "DAO is active" flag, but not against the Diamond owner — three routes, the cheapest costing ~31,700 gas, and not visible through the Diamond's own function list. Found by our own review; recorded in `docs/OPEN-ITEMS.md`. |
| **Protocol settings** | `setFeeRecipient`, `setTrustedForwarder`, `setAgreementDeployer`, `setDAOAddress` | Where fees go, which forwarder is trusted, which deployer clones agreements. |
| **Arbiter roster at launch** | `ArbiterRegistryFacet` | Arbiters are curated by hand for now. This is not a backdoor — it is the absence of population. A dispute needs someone to judge it, and the self-service path (`applyAsArbiter`) is switched off entirely until governance is active: it reverts on its first line, before it ever reaches the reputation and bond gates behind it. Hand-seating (`addArbiter`) is the owner's; a chief arbiter may seat as well, but never past the point where his own bloc — the arbiters he seated, plus himself if he judges — could cast the votes that decide an appeal, which today means at most one. Today, putting an arbiter who was removed for cause back into the roster is the owner's alone — once governance is active, the removed arbiter's own way back is the self-service path, and the history of his removals survives it. |
| **Suspend or remove an arbiter** | `ArbiterAccountabilityFacet` | `suspendArbiter` stops an arbiter for 72 hours; it is reversible and expires on its own. `removeArbiterForCause` is not: it takes the seat, forfeits whatever bond the arbiter has posted into the arbiter vault, and writes a permanent public accusation against a real address. **Today that bond is zero for everyone who can actually be removed.** The only code path that posts a bond is the self-service `applyAsArbiter`, which is switched off until governance is active, and the hand-seated arbiters of the launch phase post none — the same fact `README.md` states, and the same zero the `bondForfeited` field of the removal event carries on every removal that can be performed today. Removal also suspends, so the removed arbiter cannot rush his pending verdicts through while the owner is still looking at them; that particular suspension is lifted only by whoever holds the removal power. A chief arbiter, if one is appointed, may suspend an arbiter, lift an *ordinary* suspension and *propose* a removal — but never execute one, and never lift the suspension a removal left behind. |

**And one half that is not on-chain at all.** The presentation box, the chat key
directory and encrypted attachments live on our relayer. If that server is lost,
presentations are lost with it — only the on-chain facts and the copy on the
presenting party's own device survive. The software now says this out loud rather
than showing an empty box as if nothing had been presented.

---

## Why the upgrade key still exists

Removing `diamondCut` today would not make the protocol safer; it would make the
first serious bug permanent, with user funds behind it. Upgradeability is the
means of repair, and it is given up **after** the code stops changing weekly and
after an external audit — not before.

Hexseal currently runs on **Base Sepolia**, a testnet. There is no real money at
stake, and there has been no external audit. A single key at this stage is a
deliberate trade of decentralization for the ability to fix things quickly — and
it is stated, not hidden.

---

## The four stages

Each stage is triggered by an **event**, not a date. Dates slip; events do not.

**Stage 1 — today. Testnet, one key, disclosed.**
Everything above is true and written down. Users risk no real funds.

**Stage 2 — before mainnet. Multisig with a timelock.**
The owner key moves to a multisig, and privileged calls execute only after a
delay. The delay matters more than the multisig: it is what lets anyone see a
change coming and leave if they disagree with it. No mainnet launch without this.

**Stage 3 — with population. Arbiter removal goes first, and it is already wired.**
The first power that actually leaves the owner's key is the ability to remove an
arbiter for cause (`ArbiterAccountabilityFacet.removeArbiterForCause`) — and,
travelling with it, the ability to lift the suspension a removal imposes. Once
governance is active and a successor address has been named, only that address
may call it; the owner gets the same rejection as a stranger, and cannot take the
power back — after handover, `setDAOAddress` accepts calls only from the sitting
DAO address. Seating a new arbiter by hand (`addArbiter`) closes at that same
moment; the only remaining way into the roster is the reputation-and-bond-gated
`applyAsArbiter`.

Naming a chief arbiter (`setChiefArbiter`) closes **earlier** — the instant
governance becomes active, whether or not a successor has been named yet. That
is deliberate and not a copy of the rule above: the chief-arbiter role stops
existing the moment governance is active, because every check that admits him
(`onlyOwnerOrChief`, in both arbiter facets) stops seeing him then. Writing the
slot in that window would have named a chief with no powers at all, and
`getChiefArbiter()` would have reported him to readers as if he had them.

**`overturnVerdict` and `freezeVerdict` are not in that first handover**, and an
earlier version of this document said they were. They sit behind `onlyOwnerOrDAO`
— a modifier that admits the owner *always*. It puts a DAO address *beside* the
owner, not in place of him, so no event hands those two over on its own. Doing it
means replacing the modifier, which is Stage 4 work. Until then the honest
statement is the one in the table above: a single key can still overturn a
verdict.

The trigger is measured, not declared: the protocol counts unique settled
counterparties (`getUniqueActiveUsers`) against a threshold (`DAO_THRESHOLD`),
and the same earned number gates reserve withdrawal. There is also a manual
switch, and it is described honestly two sections down.

**Stage 4 — last. Settings, then the upgrade key itself.**
Fee recipient, forwarder and deployer move under governance; `diamondCut` is the
final power to go, once the contracts have been audited and have stopped changing.

---

## What we will not do

- **We will not claim autonomy we do not have.** If a claim in our documentation
  is contradicted by a line of code, the documentation is wrong and gets fixed.
- **We will not remove the upgrade key before an audit**, to avoid trading a
  fixable bug for an unfixable one.
- **We will not call a flag "the community deciding".** This bullet used to read
  "we will not activate governance on a flag", and the code contradicts it:
  `ArbiterRegistryFacet.activateDAO()` is exactly such a flag, the owner can flip
  it, and flipping it hands over arbiter removal and closes the seating doors —
  governance, in the sense this document uses the word. It exists so that a real
  governance contract can take over before the earned count arrives, it refuses
  to fire until a successor address has been named, and it is one-way: no
  function anywhere in `src/` clears it. What stands is the narrower claim: the
  trigger we consider legitimate is the earned count of real counterparties
  (`getUniqueActiveUsers` against `DAO_THRESHOLD`), the same number that gates
  reserve withdrawal — and while a successor exists, the earned count closes the
  same doors by itself, with no transaction from us at all.

---

*Status: Base Sepolia (chain 84532). No external audit. Known open issues are
tracked in [`docs/OPEN-ITEMS.md`](OPEN-ITEMS.md); items whose details would help
an attacker before they are fixed are listed by class without a reproduction.*
