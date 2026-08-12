# Contributing

This is a one-person project. That shapes everything below: the goal of this file is to
stop you losing an evening to something the repository already knows about.

**Open an issue before writing a pull request.** Not as a formality — a PR that
restructures something the maintainer is halfway through rewriting gets closed no matter
how good it is, and neither of us gets that time back. A short "I want to do X, is that
wanted?" costs a day of waiting and saves the rest.

**Security problems do not go here.** They go through GitHub's private reporting form —
see [`SECURITY.md`](SECURITY.md).

Most of the documentation in `docs/` is in Russian. Issues and pull requests in English
are fine; so are Russian ones.

## Setting up

You need [Foundry](https://getfoundry.sh) and Node.js 22 or newer. CI runs Node 22, which
is what both Dockerfiles use.

```bash
forge build

cd relayer   && npm ci                       # FIRST — see below
cd ../frontend && npm ci --legacy-peer-deps   # the flag is required, not optional
```

### `--legacy-peer-deps` is not a suggestion

Without it, `npm ci` in `frontend/` fails outright with `ERESOLVE`: this repository has
`eslint ^9` against `@typescript-eslint/eslint-plugin ^7`, which wants peer `eslint
^8.56`. The same conflict is why `npm run lint` is broken repo-wide
(`docs/OPEN-ITEMS.md` #18) — its working part is kept alive as a separate hooks-only gate,
see below. `frontend/Dockerfile` and `.github/workflows/ci.yml` both pass the flag for
exactly this reason.

### The order matters: relayer, then frontend

**The frontend has no test runner of its own.** `frontend/package.json` says:

```json
"test": "node ../relayer/node_modules/vitest/vitest.mjs run"
```

There is no `vitest` in the frontend's dependencies at all. If you install the frontend
first, or skip the relayer's install, the frontend's tests do not fail on a real bug —
they fail on `Cannot find module .../vitest.mjs`. The reasoning behind sharing one runner
is in the header of `frontend/vitest.config.mjs`.

### ⚠️ Never run `npx vitest` inside `frontend/`

It looks like it works and it lies to you. Measured on a clean tree:

```
$ cd frontend && npx vitest run src/lib/mediaUrl.test.ts
 RUN  v4.1.10 ~/hexseal/frontend
No test files found, exiting with code 1
```

The file exists and passes under `npm test`. `npx` found no local `vitest`, so it fetched
a **different major version** (4.x) into its own cache; the relayer's runner — the one this
repository is written against — is **2.1.9**. You get red output that has nothing to do
with your change.

The same applies to `npx tsc`: use `npm run type-check`, which calls
`node node_modules/typescript/bin/tsc` by path.

Rule of thumb for this repository: **run the `npm run` script, never the bare tool.**
Every script here calls its binary by explicit path for this reason.

## Running everything

Order matters here too, for the same reason.

```bash
forge test                                       # contracts
cd relayer   && npm test                         # relayer
cd ../frontend && npm test                       # frontend
cd frontend && npm run build && npm run type-check
```

On a clean `main` these are the numbers you should see. If one of them moves, say so in
the pull request and say why:

| Suite | Expected |
|---|---|
| `forge test` | **600 passing** |
| `relayer && npm test` | **44 files, 955 tests** |
| `frontend && npm test` | **144 files, 2558 tests** |
| `frontend && npm run build` | builds |

`npm run build` is not optional busywork: it is the only thing that catches Next.js's
Suspense requirement around `useSearchParams()`, which is checked per page during
prerender and shows up in neither `next dev` nor `tsc`. It has broken a branch here before.

`relayer/e2e.mjs` talks to the live Base Sepolia deployment and spends real test USDC.
It is deliberately not part of `npm test` and must never be added to CI.

## The five gates

These are shell scripts, they run in CI, and all five must be green:

| Gate | What it catches |
|---|---|
| `script/check-storage-layout.sh` | the namespace slots of Diamond storage moving |
| `script/check-storage-structs.sh` | a changed field **type** inside an existing slot — the bug that broke the job board in July 2026 |
| `script/check-agreement-layout.sh` | the same append-only rule for `Agreement`, whose EIP-1167 clones all share the implementation's layout |
| `script/check-gasless-sender.sh` | `msg.sender` read on a meta-transaction path, where it is the forwarder's address and not a person |
| `script/check-appeal-window.sh` | the relayer's copies of the appeal windows drifting away from the contract's |

Run them from the repository root:

```bash
for g in script/check-*.sh; do "$g" || echo "FAILED: $g"; done
```

Two of them (`check-storage-layout.sh`, `check-agreement-layout.sh`) shell out to
`slither --print variable-order`, so you need `slither-analyzer` installed
(`pip install slither-analyzer`). That is also why CI installs Slither in a job that has no
visible Slither step — removing it once turned both gates into exit code 127.

### The storage rule these gates enforce

**Storage layout is append-only.** In any `struct Layout` / `struct Data` under a Diamond
Storage namespace, and in `Agreement`:

- you may **add** fields at the end;
- you may **not** reorder, remove, or **change the type** of an existing field — not even
  for a type of the same slot width.

The last one is the trap. In July 2026 a field's type changed inside the same slot, every
test stayed green, and `getOpenJobs()` started reverting with `Panic(0x22)` on live
Base Sepolia. `check-storage-structs.sh` exists specifically for that class. The full
story is in `docs/CONTRACT_GUIDE.md`.

### The ERC-2771 rule

In gasless contracts the sender is taken **only** via `_msgSender()`. On a relayed call,
`msg.sender` is the `MinimalForwarder` address, not the person. `check-gasless-sender.sh`
enforces this by walking solc's AST, so a `msg.sender` in a comment does not count and
every real read is attributed to its function. Every `.sol` file under `src/` must be
either an ERC-2771 contract or listed in `script/gasless-sender.allow` **with a stated
reason** — otherwise the gate is red by construction.

A test that calls the facet directly does **not** catch this class of bug. You need a call
through a real forwarder.

## What a good pull request looks like here

- **One subject per PR.** Storage-layout changes and dependency bumps go on their own.
- **Tests that measure behaviour, not text.** A test that asserts a string exists in a
  file — a function name, an import, a key — passes just as happily when nothing calls
  that function. Before you claim a test guards something, delete the thing it guards, run
  the suite, and see a red. If nothing goes red, the test is guarding text.
- **Say what you measured.** "Removed the call to X, 3 tests failed" is worth more than
  "added tests". Zero failures is not a pass; it means the lock is not wired up.
- **Do not edit `src/` licence headers.** They are Solidity `SPDX-License-Identifier`
  lines and are load-bearing; see [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
  The same goes double for anything under `lib/`, which is vendored third-party code.
- **Commit messages** in this repository are Russian and follow
  `type(область): что изменилось`. English is accepted from contributors.

## Licence of contributions

The contracts in `src/` are licensed under BUSL-1.1 (see [`LICENSE`](LICENSE)), which
converts to MIT on 2030-08-12. By opening a pull request you agree that your contribution
is licensed on those same terms.
