# Third-party licences

The root [`LICENSE`](LICENSE) (Business Source License 1.1) covers **only the Solidity
sources in `src/`** — 15 files, the Hexseal protocol contracts. Everything listed below
belongs to somebody else, keeps its original licence, and is unaffected by the BUSL.

Because in Solidity the **per-file `SPDX-License-Identifier` header** — not this document
and not the root `LICENSE` — is the operative declaration, the split is drawn in the files
themselves:

| Where | Header | Count |
|---|---|---|
| `src/` | `// SPDX-License-Identifier: BUSL-1.1` | 15 |
| `script/`, `test/` | `// SPDX-License-Identifier: MIT` | 90 |
| `lib/` | whatever upstream wrote — untouched | 0 files in this repository, see below |

⚠️ The contracts already deployed to Base Sepolia were verified on Basescan **before** the
`src/` headers changed, so their verified source differs from this repository by exactly
that one line. The measurement of what that costs is in `README.md`, under the deployed
contracts.

Two rules follow, and both are load-bearing:

- **Do not edit the `SPDX-License-Identifier` header of an upstream file.** `solc` also
  warns when it is missing, so the rule is a compiler requirement as well as a legal one.
  Since 15 August 2026 the practical form of the rule is *do not commit anything inside a
  submodule*: a patched submodule is a local change that no clone of this repository will
  ever reproduce.
- **Do not delete the licence texts listed in the "Where the text lives" column.** MIT
  requires the copyright notice to travel with the copies; Apache-2.0 requires the licence
  text to be included on redistribution. They arrive with the submodule checkout, at the
  paths named below.

## Referenced as git submodules (`lib/`, 0 tracked files)

⚠️ **Changed on 15 August 2026.** `lib/` used to hold 924 plain files, which meant every
clone and every `git archive` of this repository carried a full copy of OpenZeppelin and
forge-std — including the two AGPL-3.0 trees listed further down. It is now two git
submodules, so this repository distributes **no third-party source at all**; it records
two commit ids, and `git submodule update --init --recursive` fetches the code from
upstream on the reader's own machine.

| Path | What | Pinned at | Licence | Where the text lives |
|---|---|---|---|---|
| `lib/openzeppelin-contracts/` | OpenZeppelin Contracts | **v5.7.0** (`cab19933`, 2026-07-29) | MIT | `lib/openzeppelin-contracts/LICENSE` |
| `lib/forge-std/` | Forge Standard Library | **v1.16.2** (`bf647bd6`, 2026-06-30) | MIT **OR** Apache-2.0, at your option | `lib/forge-std/LICENSE-MIT`, `lib/forge-std/LICENSE-APACHE` |

Both pins are **release tags**, and that is checkable rather than claimed:
`git -C lib/<name> describe --tags --exact-match` prints the version above for each.
It is worth checking, because it was false until 15 August 2026: both dependencies sat
on arbitrary `master` commits from **12 August 2025**, a year stale, while
OpenZeppelin's `package.json` — and this document — said "5.4.0". The code was in fact
*past* the v5.4.0 tag. The history is in `docs/OPEN-ITEMS.md` item 59.

### Nested inside OpenZeppelin's own tree

OpenZeppelin has its own submodules, and two of them are **AGPL-3.0**. They are
OpenZeppelin's test and symbolic-execution helpers. Nothing in `src/`, `test/` or `script/`
imports them — checked, zero references — and they are not on any build path of this
project. They are listed here so that a reviewer who greps a fully-initialised working tree
and finds AGPL text knows exactly what it is and why it is harmless.

They are initialised deliberately rather than skipped, and the reason is reproducibility,
not necessity: `forge` builds its remapping list from whatever sits under `lib/`, and the
remappings are part of the compiler settings that get hashed into contract metadata. Drop
these three and the metadata hash of every compiled contract shifts, which would break a
byte-for-byte comparison against what is already verified on Basescan.

| Path | What | Pinned at | Licence | Where the text lives |
|---|---|---|---|---|
| `lib/openzeppelin-contracts/lib/forge-std/` | Forge Standard Library (OZ's copy) | `1801b054` (v1.14.0) | MIT OR Apache-2.0 | `…/lib/forge-std/LICENSE-MIT`, `…/LICENSE-APACHE` |
| `lib/openzeppelin-contracts/lib/erc4626-tests/` | ERC-4626 property tests | `232ff9ba` (v0.1.1) | **AGPL-3.0** | `lib/openzeppelin-contracts/lib/erc4626-tests/LICENSE` |
| `lib/openzeppelin-contracts/lib/halmos-cheatcodes/` | Halmos cheatcodes | `7328abe1` | **AGPL-3.0** | `lib/openzeppelin-contracts/lib/halmos-cheatcodes/LICENSE` |
| `lib/openzeppelin-contracts/contracts/vendor/compound/` | Compound interfaces | — | BSD-3-Clause | `lib/openzeppelin-contracts/contracts/vendor/compound/LICENSE` |

## What `src/` actually imports

Six files, all from OpenZeppelin, all MIT:

```
@openzeppelin/contracts/proxy/Clones.sol
@openzeppelin/contracts/utils/Base64.sol
@openzeppelin/contracts/utils/Strings.sol
@openzeppelin/contracts/utils/cryptography/ECDSA.sol
@openzeppelin/contracts/utils/cryptography/EIP712.sol
@openzeppelin/contracts/utils/introspection/IERC165.sol
```

Reproduce that list with:

```bash
grep -rhoE 'import[^;]*"@openzeppelin[^"]+"' src/ | grep -oE '@openzeppelin[^"]+' | sort -u
```

## Not vendored: npm dependencies

`frontend/` and `relayer/` install their dependencies from npm; `node_modules/` is **not**
tracked in this repository. Each package carries its own licence inside its own directory
after `npm ci`. The declared dependency lists are `frontend/package.json` and
`relayer/package.json`; the resolved trees are pinned in the two `package-lock.json` files.

Neither application is part of the Licensed Work under the root `LICENSE`.
