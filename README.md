# Hexseal

> **Decentralized freelance escrow on Base.** A deal's money sits in a contract of its own; the only ways out are the two parties, the clock, an arbiter's verdict, and the protocol's arbitration fee.

[![Base Sepolia](https://img.shields.io/badge/Base-Sepolia%20testnet-0052FF?logo=coinbase)](https://sepolia.basescan.org)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-363636?logo=solidity)](https://soliditylang.org)
[![EIP-2535](https://img.shields.io/badge/EIP--2535-Diamond-blueviolet)](https://eips.ethereum.org/EIPS/eip-2535)

## Status: testnet, unaudited

- Deployed on **Base Sepolia only** (chainId `84532`). Every USDC figure you see in the app is **test USDC** — no real money is at risk.
- **No external audit** has been done. Slither runs in CI and its report is in `docs/audits/`; that is not an audit.
- **Decentralized in its logic, not yet in its governance.** One key can upgrade the protocol and overturn a pending arbiter verdict. What exactly that key can do, what is planned instead (a multisig with a timelock before mainnet) and why it is like this today — [see below](#progressive-decentralization-stated-plainly), in full in [`docs/DECENTRALIZATION.md`](docs/DECENTRALIZATION.md).
- Known weaknesses are tracked in the open in [`docs/OPEN-ITEMS.md`](docs/OPEN-ITEMS.md), including the ones still unfixed.
- Do not point this at mainnet funds.

## What it is

A two-sided marketplace with per-deal escrow:

- a **client** posts a job, or an **executor** lists a service — both boards live on chain;
- when the two agree, the factory deploys an **Agreement** contract for that single deal (an EIP-1167 clone, so it is cheap);
- USDC sits in that Agreement until it is released by client approval, by timeout, by refund, or by an arbiter's verdict;
- disputes go to **arbiters**, who claim cases through commit-reveal so that nobody can shop for the case they want. There is a self-service path behind a clean-streak gate and a forfeitable USDC bond (`src/facets/ArbiterRegistryFacet.sol:326-345`), but it is switched off at launch — it reverts while the DAO flag is off — and the first arbiters are seated by hand with `addArbiter`, which posts **no** bond (`:391-396`);
- reputation (XP) is awarded by the contract on completion — not claimed, not granted;
- transactions are **gasless**: you sign an EIP-712 message, a relayer pays the ETH. If the relayer is down the app falls back to a normal transaction from your own wallet.

Chat between the parties is **end-to-end encrypted by our own transport** (no third-party messenger, no bot in the conversation); the server stores sealed blobs it cannot read.

## What the contracts decide, and what a key still can

The interesting question about an "autonomous" protocol is not what it automates but what it still lets a human override. The honest split — the same one shown to auditors in [`docs/hexseal-one-pager.html`](docs/hexseal-one-pager.html):

| Decision | Who holds it | Where to check |
|---|---|---|
| Release of escrowed funds | **Contract** | Client approval, timeout approval, refund, or an arbiter verdict; a settled dispute also takes the 3 % arbitration fee (capped at $500) out of the pot. No key moves a deal's money outside those paths — `src/Agreement.sol:285-286,629-661,740-811,815-852` |
| Raising a dispute | **Contract** | Only the client or the executor of that deal — `src/Agreement.sol:665-668` |
| Reputation | **Contract** | Awarded inside the completion call, not mintable — `src/facets/ReputationFacet.sol` |
| Fee split and treasury ladder | **Contract** | Percentages are compile-time constants; changing them means replacing the contract — `src/Treasury.sol` |
| **Which code runs (upgrade authority)** | **Owner key** | The known centralization point. The Diamond owner can replace any facet through `diamondCut`. Our own review measured the cheapest bypass of the treasury's reserve gate at **31 717 gas**, invisible to standard Diamond introspection — written down in `src/Treasury.sol:114-170` |
| **A pending dispute verdict** | **Owner key** (or the DAO address, once set) | `overturnVerdict` flips an unfinalized verdict, `freezeVerdict`/`unfreezeVerdict` stall it — `src/facets/ArbiterRegistryFacet.sol:759,848,858`. The Diamond is authorized to settle a disputed Agreement directly — `src/Agreement.sol:744` |
| Who the first arbiters are | **Owner key** | Deliberate launch decision: seated by hand via `addArbiter` — which, unlike the self-service path, posts no bond, so there is nothing to forfeit — `src/facets/ArbiterRegistryFacet.sol:391-396` vs `:326-345` |
| Relayer, file storage, notifications | **Our servers** | Liveness only, never custody |

A protocol fee (5 % of the deal amount, floor $1) is likewise an owner-settable parameter — `src/FactoryFacet.sol:85,191-192,373,380`.

### Progressive decentralization, stated plainly

**Today.** The protocol is decentralized in its logic and not yet in its governance. One key — the Diamond owner — can replace any facet (`diamondCut`), can overturn a pending arbiter verdict (`src/facets/ArbiterRegistryFacet.sol:759`), can freeze one (`:848`), and gets past the treasury's own reserve gate for about **31 717 gas** without that showing up in Diamond introspection (`src/Treasury.sol:114-170`). Those are facts about the code as it stands, not accusations someone still has to find.

**Planned.** Governance moves to a **multisig with a timelock before mainnet**, and the powers above are handed over in a fixed order after that — `overturnVerdict` first, `diamondCut` last. The full staging, with the event that triggers each step, is in [`docs/DECENTRALIZATION.md`](docs/DECENTRALIZATION.md). This is the one forward-looking statement on this page: it is a plan, not a property the code enforces today, and nothing in this repository implements it yet.

**Why it is like this now.** The deployment is Base Sepolia testnet, the USDC is test USDC, and there is no external audit. At that stage a single key buys speed: a money bug can be fixed the same day instead of waiting on a quorum. Handing the key to a multisig before there is anything to protect would cost that speed and protect nothing. This is the usual staged path — the same one Uniswap and Compound took — and we would rather write it down than let a reviewer discover it in the diff.

## Architecture

```
DiamondProxy (EIP-2535)          — one address, never changes; facets are upgraded under it
├── DiamondCut / Loupe / Ownership   — src/DiamondProxy.sol
├── FactoryFacet                     — creates Agreement contracts, holds the fee model
├── RegistryFacet                    — indexes every agreement and its status
├── JobBoardFacet                    — client job postings
├── ServiceBoardFacet                — executor service listings
├── ArbiterRegistryFacet             — arbiter roster, commit-reveal claims and verdicts,
│                                      appeals, timeout recovery, on-chain arbiter chat keys
├── ReputationFacet                  — XP, clean streaks, unique active users
├── JobReceiptFacet                  — soulbound receipt NFT (rendered by SVGRenderer)
└── DealMetadataFacet                — on-chain SVG/JSON metadata for the deal NFT

Standalone contracts (not facets)
├── Agreement.sol                — one escrow contract per deal, cloned via EIP-1167
├── AgreementDeployer.sol        — clones the Agreement implementation for the factory
├── MinimalForwarder.sol         — EIP-712 forwarder for meta-transactions (ERC-2771)
├── Treasury.sol                 — protocol treasury, immutable after deploy
└── SVGRenderer.sol              — on-chain SVG/JSON rendering, kept out of the facet
```

### Deal lifecycle

```
CREATED → FUNDED → ACTIVE → [COMPLETED | DISPUTED]
                                         ↓
                                     RESOLVED / REFUNDED
```

| Step | Who triggers | Window |
|---|---|---|
| Created | client | — |
| Funded | client deposits USDC | — |
| Active | executor accepts the work | `ACTIVATION_WINDOW` = 2 days, then the client can refund |
| Marked done | executor | before the deadline (+1 day `DEADLINE_GRACE`) |
| Completed | client releases — or, after the window, **anyone** can push the auto-release to the executor (`src/Agreement.sol:649-661`) | `AUTO_APPROVE_WINDOW` = 2 days of client silence |
| Disputed | client or executor | while the deal is active, or within the auto-approve window |
| Resolved | arbiter verdict, or a timeout split | `DISPUTE_WINDOW` = 4 days for the arbiter |

Windows are constants in `src/Agreement.sol:276-279`; the dispute fee (3 %, capped at $500) is `src/Agreement.sol:285-286`.

## Repository layout

| Path | What |
|---|---|
| `src/` | Solidity contracts (the list above) |
| `test/` | Foundry tests |
| `script/` | Deploy/upgrade scripts and the five CI gates (`check-*.sh`) |
| `frontend/` | Next.js app (wagmi/viem), including the encrypted chat client |
| `relayer/` | Node/Express relayer: meta-transactions, file storage, notifications |
| `subgraph/` | The Graph subgraph |
| `docs/` | Design docs, runbooks, audit output, open-item register (mostly in Russian) |

## Getting started

**Prerequisites:** [Foundry](https://book.getfoundry.sh/getting-started/installation), Node.js 18+, a Base Sepolia wallet with test ETH, and test USDC from [faucet.circle.com](https://faucet.circle.com).

```bash
git clone https://github.com/Hexseal/Hexseal.git
cd Hexseal

# Contracts
forge build
forge test
```

### Relayer

```bash
cd relayer
npm ci
cp .env.example .env      # then fill it in — see the table below
node index.js
```

### Frontend

The frontend borrows the relayer's test runner, so **install the relayer first**.

```bash
cd frontend
npm ci --legacy-peer-deps    # the flag is required, not optional
cp .env.example .env.local   # then fill it in — see the table below
npm run dev
```

### Environment

`frontend/.env.example` and `relayer/.env.example` list **every** variable the code
actually reads, with no real values in either. The tables below are the short
version — the ones you cannot skip.

⚠️ In `frontend/.env.local` an **empty** value is not the same as an absent one:
most of the frontend reads with `??`, which passes an empty string through as a
legitimate value. That is why everything optional in the template is commented
out — uncomment a line only together with a value.

`frontend/.env.local`:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `84532` |
| `NEXT_PUBLIC_DIAMOND_ADDRESS` | Diamond proxy address (below) — required, the app refuses to start without it |
| `NEXT_PUBLIC_FORWARDER_ADDRESS` | `MinimalForwarder` address (below) — required |
| `NEXT_PUBLIC_USDC_ADDRESS` | test USDC (below) — required |
| `NEXT_PUBLIC_RELAYER_URL` | where your relayer listens, e.g. `http://localhost:3001` |
| `NEXT_PUBLIC_RPC_URL` | your Base Sepolia RPC endpoint |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect Cloud project id — without it only injected wallets are offered |

`relayer/.env`:

| Variable | Value |
|---|---|
| `RELAYER_PRIVATE_KEY` | key of the wallet that pays gas for meta-transactions (server-side only) |
| `TRUSTED_FORWARDER` | `MinimalForwarder` address |
| `DIAMOND_ADDRESS` | Diamond proxy address |
| `BASE_SEPOLIA_RPC_URL` | your Base Sepolia RPC endpoint |
| `ALLOWED_ORIGINS` | origins allowed to call the relayer |
| `STORAGE_DIR` | where uploaded (encrypted) files live |

`.env.vps.example` in the repository root is the full operational template (it covers deployment, limits and TTLs as well).

## Tests and gates

Order matters — the frontend has no test runner of its own:

```bash
forge test                                   # contracts
cd relayer   && npm ci && npm test           # relayer
cd ../frontend && npm ci --legacy-peer-deps && npm test
```

Five shell gates must be green; CI runs all of them (`.github/workflows/ci.yml:48-60`):

| Gate | Catches |
|---|---|
| `script/check-storage-layout.sh` | namespace slots of Diamond storage |
| `script/check-storage-structs.sh` | a changed field **type** inside an existing slot — the bug that once broke the job board |
| `script/check-agreement-layout.sh` | the same append-only rule for `Agreement` (clones share the implementation's layout) |
| `script/check-gasless-sender.sh` | `msg.sender` used on a meta-transaction path, where it is the forwarder and not the person (parsed from the compiler's AST) |
| `script/check-appeal-window.sh` | the relayer's copies of the appeal windows drifting from the contract's — if they drift, evidence gets deleted before an appeal ends |

## Deploying from scratch

Order is rigid — the forwarder must exist before `DeployFull` reads `TRUSTED_FORWARDER`:

```bash
forge script script/DeployForwarder.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast --verify

# put the printed address into TRUSTED_FORWARDER, then:
forge script script/DeployFull.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast --verify
```

`DeployFull` also requires `FEE_RECIPIENT`, `INITIAL_ARBITER` and `USDC_ADDRESS`; it reverts pre-flight if any of them is zero. `script/DeployTreasury.s.sol` deploys the treasury separately, and pointing the protocol's income at it is a deliberate separate transaction:

```bash
cast send $DIAMOND_ADDRESS "setFeeRecipient(address)" <treasury> \
  --private-key $PRIVATE_KEY --rpc-url $BASE_SEPOLIA_RPC_URL
```

## Deployed contracts (Base Sepolia)

| Contract | Address |
|---|---|
| DiamondProxy (Hexseal) | [`0x760F07367888C62f7c2Dfb619A5e534132855ce5`](https://sepolia.basescan.org/address/0x760F07367888C62f7c2Dfb619A5e534132855ce5) |
| MinimalForwarder | `0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f` |
| Treasury | `0x2e7a7A0515bfDC0006A812EBb3E55d32800Bc660` |
| USDC (test) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

**Facet addresses are deliberately not listed here.** They change with every upgrade and a stale table sends people to abandoned deployments. Ask the chain instead — `facets()` on the proxy (EIP-2535 loupe) is the source of truth; the app itself reads the proxy address from configuration for the same reason.

## Documentation

- [`docs/DECENTRALIZATION.md`](docs/DECENTRALIZATION.md) — what one key can still do, why it exists, and the event that ends each power (English)
- [`docs/CONTRACT_GUIDE.md`](docs/CONTRACT_GUIDE.md) — how the contracts fit together, storage rules, incident history (Russian)
- [`docs/hexseal-one-pager.html`](docs/hexseal-one-pager.html) — external overview, including the trust model above (English)
- [`docs/OPEN-ITEMS.md`](docs/OPEN-ITEMS.md) — the open-defect register we keep in public (Russian)
- [FAQ](https://hexseal.net/docs/faq) — the in-app help
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to build, test and not lose an evening to `npx vitest` (English)
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability, and what is in scope (English)

## Reporting a security issue

See [`SECURITY.md`](SECURITY.md). Reports go through GitHub's **private vulnerability reporting** (Security → Report a vulnerability), never a public issue. There is no bug bounty, the deployment is a testnet one, and it holds no real funds.

## License

[**BUSL-1.1**](LICENSE) — Business Source License 1.1, converting to **MIT** on
**2030-08-12**.

- The Licensed Work is the Solidity source in `src/` and nothing else.
- The Additional Use Grant permits any **non-commercial** use, and deploying and
  running the code on any **public test network**. Studying it, forking it,
  auditing it, security-testing it, running your own instance and contributing
  back are all explicitly allowed and need no permission from us.
- What it does not permit before the change date is running the contracts as a
  commercial, revenue-generating service on a production network.
- BUSL is **not** an OSI-approved open-source licence, and the licence text says
  so itself. We would rather say that than call this "open source" and be
  corrected.

Third-party code vendored under `lib/` (OpenZeppelin, forge-std) keeps its own
MIT / Apache-2.0 terms and is not covered by the above — see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
