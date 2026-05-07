# Signature404

> **Decentralized freelance protocol on Base.** No middlemen, no trust required — the deal is the contract.

[![Base Sepolia](https://img.shields.io/badge/Base-Sepolia-0052FF?logo=coinbase)](https://sepolia.basescan.org)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-363636?logo=solidity)](https://soliditylang.org)
[![EIP-2535](https://img.shields.io/badge/EIP--2535-Diamond-blueviolet)](https://eips.ethereum.org/EIPS/eip-2535)

## What is Signature404?

Signature404 is a trustless freelance marketplace built on Base. Clients post jobs, executors submit work, funds are held in escrow — and everything is enforced by smart contracts, not platform rules.

- **No admins** making decisions over your money
- **Gasless** — users sign messages, a relayer pays the gas
- **Escrow** — USDC locked on-chain until work is accepted or disputed
- **Arbitration** — neutral arbiters resolve disputes via commit-reveal
- **NFT receipts** — soulbound proof of completed work

---

## Architecture

```
Diamond EIP-2535
├── FactoryFacet            — creates Agreement contracts
├── RegistryFacet           — indexes all agreements by address
├── ArbiterRegistryFacet    — arbiter roster + commit-reveal dispute claiming
├── JobBoardFacet           — client job postings
├── ServiceBoardFacet       — executor service listings
├── OfferNFTFacet           — executor offer NFTs
├── JobReceiptFacet         — soulbound NFT receipts
└── Agreement.sol           — per-deal escrow contract (deployed by Factory)

MinimalForwarder.sol        — EIP-712 meta-transaction forwarder (ERC-2771)
```

### Deal lifecycle

```
CREATED → FUNDED → ACTIVE → [COMPLETED | DISPUTED]
                                         ↓
                                     RESOLVED / REFUNDED
```

| Status | Who triggers |
|--------|-------------|
| Created | Client creates deal |
| Funded | Client deposits USDC |
| Active | Executor activates (accepts work) |
| Mark Done | Executor submits deliverable |
| Completed | Client releases payment (or auto-approve after 5d) |
| Disputed | Either party raises dispute |
| Resolved | Arbiter decides client or executor wins |

---

## Deployed Contracts (Base Sepolia)

| Contract | Address |
|----------|---------|
| DiamondProxy | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |
| MinimalForwarder | `0x41c66b80B1445F48AF3863763BC0EC0549413CD7` |
| USDC (test) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

---

## Stack

| Layer | Tech |
|-------|------|
| Smart Contracts | Solidity 0.8.20, Foundry, OpenZeppelin v5 |
| Proxy Pattern | Diamond EIP-2535 |
| Gasless | ERC-2771 + EIP-712 MinimalForwarder |
| Payment | USDC (ERC-20) |
| Frontend | Next.js 14, wagmi v2, viem, RainbowKit |
| Messaging | XMTP (E2E encrypted chat) |
| Relayer | Node.js + Express |

---

## Getting Started

### Prerequisites
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- Node.js 18+
- A Base Sepolia wallet with test ETH

### Clone & install

```bash
git clone https://github.com/Signature404/Signature404.git
cd Signature404

# Smart contracts
forge install
forge build

# Frontend
cd frontend
npm install
cp .env.example .env.local
# fill in your values
npm run dev
```

### Environment variables

Copy `frontend/.env.example` → `frontend/.env.local` and fill in:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_CHAIN_ID` | `84532` for Base Sepolia |
| `NEXT_PUBLIC_DIAMOND_ADDRESS` | Diamond proxy address |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | From [cloud.walletconnect.com](https://cloud.walletconnect.com) |
| `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` | Your RPC endpoint (drpc, alchemy, etc.) |
| `RELAY_PRIVATE_KEY` | Server-side relayer wallet private key |

### Run the relayer

```bash
cd relayer
cp .env.example .env
# fill in RELAYER_PRIVATE_KEY, TRUSTED_FORWARDER, DIAMOND_ADDRESS
node index.js
```

---

## Smart Contract Commands

```bash
# Build
forge build

# Test
forge test -vvv

# Deploy everything
forge script script/Deploy.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast

# Read from contract
cast call $DIAMOND_ADDRESS "getFeeRecipient()(address)" \
  --rpc-url $BASE_SEPOLIA_RPC_URL

# Regenerate documentation
npm run docs
```

---

## Documentation

- [Contract & Frontend Docs](docs/generated/README.md)
- [FAQ](https://signature404.vercel.app/docs/faq)

---

## License

ISC
