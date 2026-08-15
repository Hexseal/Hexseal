# Security policy

## Read this first — what you are looking at

- The only deployment is **Base Sepolia (chain id 84532)**, a public test network.
- The USDC is **test USDC**. There is **no real money** anywhere in this system.
- There has been **no external audit**. Slither runs in CI and its output lives in
  `docs/audits/2026-07-25-slither/`. That is a static analyser, not an audit.
- There is **no bug bounty and no reward**. Not a small one, not a discretionary one —
  none. If you need to be paid for your time, this is not the project to spend it on.
- The protocol is **not fully autonomous yet**. One key can still replace any facet,
  overturn a verdict before it is finalised, and freeze or unfreeze one. That is written
  down in [`docs/DECENTRALIZATION.md`](docs/DECENTRALIZATION.md), including which event
  ends each of those powers. Reporting "the owner key can upgrade the contracts" is not a
  finding; it is the documented design, and the document says so before you do.

Known open defects are kept in the open, in [`docs/OPEN-ITEMS.md`](docs/OPEN-ITEMS.md)
(Russian). Check it before reporting — a good part of what you might find is already
there, dated, with what is being done about it.

## How to report

**Use GitHub's Private Vulnerability Reporting.** On this repository:
**Security → Report a vulnerability**. The report is visible to the maintainer only; it
does not appear in the public issue tracker, in search, or in notifications to anyone
else.

There is deliberately **no email address in this file**. The project is maintained
anonymously and has no project mailbox; publishing a personal one would defeat both. The
GitHub channel needs no mailbox to exist and is the only supported route.

**Do not open a public issue for a security problem**, and do not describe one on social
media before we have replied. If the private reporting form is unavailable to you for some
reason, open a public issue that says only that you have a security report and cannot use
the form — no details, no reproduction — and we will take it from there.

### What to put in the report

1. What breaks, in one sentence.
2. Which component: a contract in `src/`, the relayer (`relayer/`), the web app
   (`frontend/`), or the deployment itself.
3. Steps to reproduce, or a failing test. A test is worth more than prose here — the repo
   runs `forge test`, `relayer && npm test` and `frontend && npm test`, and a red one of
   those is an unambiguous report.
4. What an attacker gets out of it, and what it costs them.
5. Whether you have already run it against the live Base Sepolia deployment, and if so,
   with which addresses.

## Response times

This is a one-person project. These are the numbers that can actually be kept, not the
ones that look good:

| Step | Target |
|---|---|
| First reply, confirming the report arrived | **7 days** |
| An assessment: reproduced or not, and how severe | **21 days** |
| A fix, or a written decision not to fix, for anything that puts user data or funds at risk | **90 days** |
| Anything else | best effort, tracked in `docs/OPEN-ITEMS.md` |

If 14 days pass with no reply at all, assume the report was lost rather than ignored, and
open a public issue saying only that a private report is waiting — no details.

We will credit you in the fix commit unless you ask us not to.

## Scope

### In scope

- Contracts in `src/` — escrow accounting, the arbitration flow, the Diamond storage
  layout, the ERC-2771 meta-transaction path.
- `relayer/` — the meta-transaction relayer, the file server, the push sender, the chat
  bag store and the key directory.
- `frontend/` — the Next.js app and its API routes, including the RPC proxy and the relay
  proxy.
- The deployment configuration itself: the deploy scripts in `script/`, the CI workflow,
  the Docker and tunnel configuration.
- **Anything where the code and the documentation disagree about who can touch money.**
  That class is explicitly wanted. If `README.md`, the in-app FAQ, or
  `docs/DECENTRALIZATION.md` claims a guarantee the code does not provide, that is a
  report we want to receive.

### Out of scope

- The owner key's documented powers (see above).
- Anything that requires the owner's private key, the relayer's private key, or the
  server itself to already be compromised.
- Missing rate limits, missing log rotation, unbounded disk growth and similar
  availability limits **that are already listed in `docs/OPEN-ITEMS.md`**. New ones that
  are not listed there are in scope.
- Third-party code under `lib/` — report those upstream to OpenZeppelin or
  Foundry. Since 15 August 2026 that directory is two git submodules rather than 924
  files committed here, so this repository no longer distributes any of it; the code
  appears on your disk only after `git submodule update --init --recursive`. Either way
  we did not write it and do not call it from our own code.

  **The recurring false positive, named so you can skip it.** `lib/forge-std/src/StdChains.sol`
  hardcodes default RPC URLs that contain what look like API keys — an Infura key on
  Sepolia, an Alchemy key on mainnet. They ship inside Foundry's standard library and are
  present in every Foundry project in existence. They are not ours and there is nothing
  for us to rotate. Measured on this repository: those strings appear in **4 files, all
  under `lib/`, and in 0 files under `src/`, `frontend/` or `relayer/`**. Credential
  scanners flag them regularly; a report about them will be closed with this paragraph.

- Findings produced by an automated scanner and submitted without a reproduction. A
  Slither or npm-audit dump with no analysis will be closed.
- Anything about a mainnet deployment. There isn't one.

## Testing rules

The deployment is public and the test network is free, so testing it is fine — within
these limits:

- **Do not touch other people's wallets, deals, chats or files.** Everything on a test
  network is reachable, and the addresses are public on-chain; that is not permission.
  Use your own wallets on both sides of a deal.
- **Do not run load or denial-of-service tests against the live relayer.** Several
  availability limits are known and written down; hitting them harder proves nothing and
  takes the service away from other people. If you want to measure one, say so in the
  report and we will point you at the local stand.
- **Run it locally instead where you can.** `docker-compose.yml` and
  [`CONTRIBUTING.md`](CONTRIBUTING.md) bring the whole thing up on your own machine, and
  the contracts run entirely offline under `forge test`.
- **Do not send spam or unsolicited push notifications to real addresses.**

## Licence and testing

The root [`LICENSE`](LICENSE) is BUSL-1.1 with an Additional Use Grant that explicitly
covers security testing, auditing and running your own instance. You do not need
permission from us to read the code, fork it, run it, or test it.
