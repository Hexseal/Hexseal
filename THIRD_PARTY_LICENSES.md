# Third-party licences

The root [`LICENSE`](LICENSE) (Business Source License 1.1) covers **only the Solidity
sources in `src/`** — 15 files, the Hexseal protocol contracts. Everything listed below
belongs to somebody else, keeps its original licence, and is unaffected by the BUSL.

Two rules follow from that, and both are load-bearing:

- **Do not edit the `SPDX-License-Identifier` header of a vendored file.** In Solidity that
  header, not this document and not the root `LICENSE`, is the operative declaration for
  the file. `solc` also warns when it is missing, so the rule is a compiler requirement as
  well as a legal one.
- **Do not delete the licence texts listed in the "Where the text lives" column.** MIT
  requires the copyright notice to travel with the copies; Apache-2.0 requires the licence
  text to be included on redistribution. They are in the repository for that reason, not
  by accident.

## Vendored into the repository (`lib/`, 924 tracked files)

`lib/` holds plain files, not git submodules, so these ship inside every clone and every
archive of this repository.

| Path | What | Version | Licence | Where the text lives |
|---|---|---|---|---|
| `lib/openzeppelin-contracts/` | OpenZeppelin Contracts | 5.4.0 | MIT | `lib/openzeppelin-contracts/LICENSE` |
| `lib/forge-std/` | Forge Standard Library | 1.10.0 | MIT **OR** Apache-2.0, at your option | `lib/forge-std/LICENSE-MIT`, `lib/forge-std/LICENSE-APACHE` |

### Nested inside OpenZeppelin's own tree

OpenZeppelin vendors its own dependencies, and two of them are **AGPL-3.0**. They are
OpenZeppelin's test and symbolic-execution helpers. Nothing in `src/`, `test/` or `script/`
imports them — checked, zero references — and they are not on any build path of this
project. They are listed here so that a reviewer who greps the tree and finds AGPL text
knows exactly what it is and why it is harmless.

| Path | What | Licence | Where the text lives |
|---|---|---|---|
| `lib/openzeppelin-contracts/lib/forge-std/` | Forge Standard Library (OZ's copy) | MIT OR Apache-2.0 | `…/lib/forge-std/LICENSE-MIT`, `…/LICENSE-APACHE` |
| `lib/openzeppelin-contracts/lib/erc4626-tests/` | ERC-4626 property tests | **AGPL-3.0** | `lib/openzeppelin-contracts/lib/erc4626-tests/LICENSE` |
| `lib/openzeppelin-contracts/lib/halmos-cheatcodes/` | Halmos cheatcodes | **AGPL-3.0** | `lib/openzeppelin-contracts/lib/halmos-cheatcodes/LICENSE` |
| `lib/openzeppelin-contracts/contracts/vendor/compound/` | Compound interfaces | BSD-3-Clause | `lib/openzeppelin-contracts/contracts/vendor/compound/LICENSE` |

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
