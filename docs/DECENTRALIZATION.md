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
| **Arbiter roster at launch** | `ArbiterRegistryFacet` | Arbiters are curated by hand for now. This is not a backdoor — it is the absence of population. A dispute needs someone to judge it, and self-service registration is gated on reputation nobody has yet. |

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

**Stage 3 — with population. `overturnVerdict` goes first.**
The first power handed to community governance is the ability to overturn an
arbiter, because while one person holds it, arbitration is not real arbitration.
Freezing follows. The trigger is measured, not declared: the protocol already
counts unique settled counterparties (`getUniqueActiveUsers`) against a threshold
(`DAO_THRESHOLD`), and the same earned number already gates reserve withdrawal.
Governance activates on that count — on people who actually completed deals, not
on a flag someone flips.

**Stage 4 — last. Settings, then the upgrade key itself.**
Fee recipient, forwarder and deployer move under governance; `diamondCut` is the
final power to go, once the contracts have been audited and have stopped changing.

---

## What we will not do

- **We will not claim autonomy we do not have.** If a claim in our documentation
  is contradicted by a line of code, the documentation is wrong and gets fixed.
- **We will not remove the upgrade key before an audit**, to avoid trading a
  fixable bug for an unfixable one.
- **We will not activate governance on a flag.** The threshold is an earned count
  of real counterparties, and the code already works that way.

---

*Status: Base Sepolia (chain 84532). No external audit. Known open issues are
tracked in [`docs/OPEN-ITEMS.md`](OPEN-ITEMS.md); items whose details would help
an attacker before they are fixed are listed by class without a reproduction.*
