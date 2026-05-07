"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ChevronDown, ArrowLeft, ExternalLink } from "lucide-react";

interface FAQItem {
  q: string;
  a: React.ReactNode;
}

interface FAQSection {
  title: string;
  items: FAQItem[];
}

const FAQ_SECTIONS: FAQSection[] = [
  {
    title: "General",
    items: [
      {
        q: "What is Signature404?",
        a: "Signature404 is a decentralized freelance marketplace on Base. Clients post jobs, executors submit work, and funds are locked in an on-chain escrow contract — enforced by code, not by a platform admin.",
      },
      {
        q: "Who controls the funds?",
        a: "No one. Funds are held by an autonomous smart contract (Agreement.sol). The platform cannot freeze, redirect, or touch your USDC. Only the client, executor, or arbiter can trigger state transitions — and only under conditions defined in the contract.",
      },
      {
        q: "Is it free to use?",
        a: "Transactions are gasless — the platform relayer pays ETH gas fees on your behalf. You only spend USDC for the deal amount itself. A small platform fee is deducted on successful deal completion.",
      },
      {
        q: "Which wallets are supported?",
        a: (
          <>
            MetaMask, Coinbase Wallet, Rainbow, Trust Wallet, Brave Wallet, OKX, Phantom, Ledger, and any injected wallet. WalletConnect QR code lets you connect any mobile wallet.
          </>
        ),
      },
      {
        q: "Which network does this run on?",
        a: (
          <>
            Currently deployed on <strong>Base Sepolia</strong> (testnet, chainId 84532). All USDC used is test USDC — no real money is at risk.
          </>
        ),
      },
    ],
  },
  {
    title: "Deals & Escrow",
    items: [
      {
        q: "How does a deal work?",
        a: (
          <ol className="list-decimal list-inside space-y-1 text-white/60">
            <li>Client creates a deal and specifies the executor address, amount, and deadline.</li>
            <li>Client funds the deal — USDC is locked in the contract.</li>
            <li>Executor activates the deal (accepts the work).</li>
            <li>Executor submits deliverable and marks the deal done.</li>
            <li>Client reviews and releases payment — or raises a dispute.</li>
            <li>If client is silent for 5 days after delivery, funds auto-release to executor.</li>
          </ol>
        ),
      },
      {
        q: "What happens if the executor doesn't activate?",
        a: "If the executor doesn't activate within 3 days after funding, the client can trigger a refund. Funds return to the client's wallet.",
      },
      {
        q: "What happens if the deadline passes?",
        a: "If the executor hasn't submitted work by the deadline, the client can trigger a timeout refund. Funds return to the client.",
      },
      {
        q: "Can I cancel a deal?",
        a: "The executor can decline a deal before activating — the client then receives a refund after the 3-day window. Once the deal is active there is no unilateral cancel; either party can raise a dispute instead.",
      },
      {
        q: "What is auto-approve?",
        a: "If the executor marks work as done and the client doesn't respond for 5 days, the funds automatically release to the executor. This prevents clients from holding payment hostage.",
      },
    ],
  },
  {
    title: "Gasless Transactions",
    items: [
      {
        q: "What does 'gasless' mean?",
        a: "You sign a message with your wallet (no ETH needed). The platform relayer submits the transaction on-chain and pays the ETH gas fee. Your wallet only signs — it does not spend ETH.",
      },
      {
        q: "Is it safe to sign gasless messages?",
        a: "Yes. Each message is EIP-712 typed data bound to a specific contract, function, nonce, and deadline. The relayer cannot alter the call — it can only forward your signed intent.",
      },
      {
        q: "Can the relayer be censored?",
        a: "If the relayer is down, you can always call the contracts directly using any Ethereum wallet or tool like cast. Gasless is a convenience layer, not a requirement.",
      },
    ],
  },
  {
    title: "Disputes & Arbitration",
    items: [
      {
        q: "How do I raise a dispute?",
        a: "On the deal page, click 'Raise Dispute' and describe the issue. USDC is frozen immediately. An arbiter from the registry will claim the case and review both sides.",
      },
      {
        q: "Who are the arbiters?",
        a: "Arbiters are addresses registered on-chain by the platform owner or chief arbiter. They are neutral third parties. You can view the full registry on the Arbiter page.",
      },
      {
        q: "How does an arbiter claim a dispute?",
        a: "Arbiters use a commit-reveal scheme: first commit a hash (to prevent front-running), then reveal in the next block to officially claim the deal. This ensures fair selection.",
      },
      {
        q: "What are the possible dispute outcomes?",
        a: (
          <ul className="list-disc list-inside space-y-1 text-white/60">
            <li><strong className="text-white/80">Client wins</strong> — full USDC refunded to client.</li>
            <li><strong className="text-white/80">Executor wins</strong> — full USDC paid to executor.</li>
          </ul>
        ),
      },
      {
        q: "What if the arbiter doesn't resolve in time?",
        a: "If the arbiter doesn't resolve within the arbiter window, either party can trigger an arbiter timeout — funds return to the client.",
      },
    ],
  },
  {
    title: "Jobs & Services",
    items: [
      {
        q: "What is a Job Posting?",
        a: "A client posts a job on the Job Board with a description, budget, and requirements. Executors browse and apply. The client selects an applicant and a deal is created.",
      },
      {
        q: "What is a Service Listing?",
        a: "An executor lists a service they offer on the Service Board with a fixed price. Clients browse and request the service directly, creating a deal.",
      },
      {
        q: "What are Job Receipt NFTs?",
        a: "When a deal is successfully completed, the executor receives a soulbound NFT (non-transferable) as verifiable proof of the completed work. These build an on-chain reputation over time.",
      },
    ],
  },
  {
    title: "Privacy & Security",
    items: [
      {
        q: "Is the chat private?",
        a: "Yes. All chat messages are end-to-end encrypted via XMTP. Only the participants (client, executor, arbiter) can read the messages. The platform cannot read them.",
      },
      {
        q: "Are files shared in chat private?",
        a: "Files are AES-256-GCM encrypted in your browser before upload. The encryption key travels only through XMTP (E2E encrypted). Files are stored on the relayer server for 18 days, then permanently deleted.",
      },
      {
        q: "Can the platform take my funds?",
        a: "No. The smart contracts are immutable once deployed. The platform owner can upgrade facets on the Diamond, but cannot touch funds in individual Agreement contracts — those are standalone escrow contracts.",
      },
      {
        q: "Are the contracts audited?",
        a: "The protocol is currently on Base Sepolia testnet and has not been formally audited. Do not use with significant real funds until a mainnet audit is completed.",
      },
    ],
  },
  {
    title: "Technical",
    items: [
      {
        q: "What is EIP-2535 (Diamond)?",
        a: "Diamond is an upgradeable proxy pattern where a single proxy contract delegates calls to multiple 'facet' contracts. This allows the protocol to be extended or fixed without redeploying everything.",
      },
      {
        q: "Where is the source code?",
        a: (
          <a
            href="https://github.com/Signature404/Signature404"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-1"
          >
            github.com/Signature404/Signature404 <ExternalLink className="w-3 h-3" />
          </a>
        ),
      },
      {
        q: "How do I verify the deployed contracts?",
        a: (
          <>
            You can inspect all contracts on{" "}
            <a
              href="https://sepolia.basescan.org/address/0xF00CC71878c226E0b64253Fb71dD802aF12165D0"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              BaseScan
            </a>
            . Diamond address: <code className="text-xs bg-white/8 px-1.5 py-0.5 rounded font-mono">0xF00CC71878c226E0b64253Fb71dD802aF12165D0</code>
          </>
        ),
      },
    ],
  },
];

function FAQAccordion({ item }: { item: FAQItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`border rounded-xl transition-colors ${open ? "border-white/15 bg-white/[0.04]" : "border-white/8 bg-white/[0.02]"}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="text-sm font-medium text-white/85">{item.q}</span>
        <ChevronDown
          className={`w-4 h-4 text-white/30 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="px-5 pb-4 text-sm text-white/55 leading-relaxed">
          {item.a}
        </div>
      )}
    </div>
  );
}

export default function FAQPage() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-4 py-10">
        {/* Back */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs text-white/30 hover:text-white/60 transition-colors mb-8"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to home
        </Link>

        {/* Header */}
        <div className="mb-10">
          <p className="text-xs text-primary/70 font-semibold uppercase tracking-widest mb-2">Docs</p>
          <h1 className="text-3xl font-black font-syne mb-3">FAQ</h1>
          <p className="text-white/40 text-sm leading-relaxed">
            Frequently asked questions about Signature404 — the decentralized freelance protocol on Base.
          </p>
        </div>

        {/* Sections */}
        <div className="space-y-10">
          {FAQ_SECTIONS.map((section) => (
            <div key={section.title}>
              <h2 className="text-xs font-semibold uppercase tracking-widest text-white/30 mb-3">
                {section.title}
              </h2>
              <div className="space-y-2">
                {section.items.map((item) => (
                  <FAQAccordion key={item.q} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer note */}
        <div className="mt-12 pt-6 border-t border-white/8 text-center">
          <p className="text-xs text-white/25">
            Still have questions?{" "}
            <a
              href="https://github.com/Signature404/Signature404/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/45 hover:text-white/70 transition-colors"
            >
              Open an issue on GitHub
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
