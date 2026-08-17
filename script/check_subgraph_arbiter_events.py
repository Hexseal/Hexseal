#!/usr/bin/env python3
"""Hold subgraph/abis/Diamond.json and subgraph/subgraph.yaml against the
contracts, for the arbiter-accountability events only.

WHY THIS SEAM AND NOT ANOTHER. Four things have to agree before a single
accountability record reaches a card:

    ArbiterAccountabilityFacet.sol / ArbiterRegistryFacet.sol   (the truth)
        -> subgraph/abis/Diamond.json                           (a hand copy)
            -> subgraph.yaml eventHandlers                      (a hand copy)
                -> src/arbiter.ts                               (the handlers)

`graph build` checks the bottom two links: a manifest signature with no
matching ABI entry, a handler that reads a parameter the ABI does not declare,
a schema field the mapping does not know — all of those go red at build time,
measured. It checks the top link not at all. Nothing does. The ABI file is a
hand-written subset with no generator behind it, and an event can be added to a
facet, renamed, or have `indexed` moved from one parameter to another with
every build in this repository staying green.

`indexed` is the reason this is not a cosmetic worry. It does not change the
signature the manifest matches on, it changes where the value lives in the log:
move it and the event either stops matching its topic hash entirely — silence,
no error, an empty feed — or decodes a different field into the record. Either
way the first sign of trouble is a person reading a removal that says something
false about who was removed.

WHAT IS COMPARED. Not the text of the .sol: solc's own ABI output, read from
out/<File>.sol/<Contract>.json. That sidesteps the whole class of scanner
mistakes where a declaration is recognised by spelling — an enum parameter
(`Cause cause`) is `uint8` here because solc says so, not because a table in
this file says so, and a user-defined value type or a struct parameter added
tomorrow needs no new rule to be handled correctly. The price is that the gate
needs a build; `forge build` is run by the wrapper and missing artifacts exit
with 3, not with 0.

WHAT IS NOT COMPARED, said plainly:

  * Only the events listed in ACCOUNTABILITY and REGISTRY below are held
    against the contracts. ArbiterRegistryFacet emits more than thirty events —
    verdicts, appeals, bounties, chat keys — and none of them are part of the
    accountability work. Coverage IS enforced for ArbiterAccountabilityFacet,
    where every event is about exactly this: add one there and this gate goes
    red until it is either indexed or written into NOT_INDEXED with a reason.
    Add one to ArbiterRegistryFacet and this gate says nothing.
  * That the selectors are mounted on the live diamond. That is the cut's job
    and test/ArbiterAccountabilityUpgrade.t.sol's.
  * That the handlers do anything sensible with what they decode.

THE MANIFEST SIDE IS READ BY SPELLING, and that is measured rather than
assumed. subgraph.yaml is matched with regular expressions, not parsed as YAML:
the file carries reasoning in its comments, and PyYAML is not a dependency
here. Write the same handler entry in flow style — `- {event: "...", handler:
...}`, valid YAML, identical meaning — and this gate reports "no handler" while
`graph build` stays green (measured, 17 August 2026). Every spelling this parser
does not know fails towards a false alarm rather than towards silence, which is
the direction to fail in, but a red from this gate is worth reading before it
is believed.

Exit codes:
    0   ABI and manifest agree with the contracts
    1   they disagree, or an accountability event is neither indexed nor
        excluded with a reason
    3   the check could not run (no artifacts, no manifest): the rule is
        UNVERIFIED, which is not the same as "no violations"
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ARTIFACTS = {
    "ArbiterAccountabilityFacet": "out/ArbiterAccountabilityFacet.sol/ArbiterAccountabilityFacet.json",
    "ArbiterRegistryFacet": "out/ArbiterRegistryFacet.sol/ArbiterRegistryFacet.json",
}

ABI_PATH = "subgraph/abis/Diamond.json"
MANIFEST_PATH = "subgraph/subgraph.yaml"
MAPPING_PATH = "subgraph/src/arbiter.ts"   # where the handler bodies live

# Every event of ArbiterAccountabilityFacet is about the accountability of an
# arbiter, so every one of them is expected in the subgraph. Coverage over this
# facet is enforced.
ACCOUNTABILITY = {
    "ArbiterSuspended": "handleArbiterSuspended",
    "ArbiterSuspensionLifted": "handleArbiterSuspensionLifted",
    "ArbiterRemovedForCause": "handleArbiterRemovedForCause",
    "RemovalProposed": "handleRemovalProposed",
    "RemovalProposalWithdrawn": "handleRemovalProposalWithdrawn",
    "RemovalProposalConsumed": "handleRemovalProposalConsumed",
    "RemovalAnswered": "handleRemovalAnswered",
}

# An accountability event that is deliberately not indexed goes here with the
# reason, and the gate stays green. Empty on purpose: everything the facet
# emits today is indexed. This exists so that leaving one out is a decision
# someone has to write down, rather than something that happens by forgetting.
NOT_INDEXED: dict = {}

# From ArbiterRegistryFacet only what the accountability feed needs: how the
# seat was taken, and the two ways of losing it that live in that facet.
# Coverage is NOT enforced here — see the module docstring.
REGISTRY = {
    "ArbiterSeated": "handleArbiterSeated",
    "ArbiterResigned": "handleArbiterResigned",
    "ArbiterDemoted": "handleArbiterDemoted",
}

# The arbiter handlers ride the data source that already indexes the boards.
# This handler is the anchor for "that one": it has been indexing the live
# diamond since July, so a section carrying it is the diamond's section.
BOARD_ANCHOR_HANDLER = "handleJobPosted"


def fail(msg):
    print("❌ " + msg)
    return 1


def load_source_events():
    """solc's ABI for the two facets, keyed by event name."""
    events = {}
    for contract, rel in ARTIFACTS.items():
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            print(
                "check-subgraph-arbiter-events: no artifact %s — run `forge build` first"
                % rel,
                file=sys.stderr,
            )
            sys.exit(3)
        with open(path) as fh:
            abi = json.load(fh)["abi"]
        for entry in abi:
            if entry["type"] == "event":
                events.setdefault(contract, {})[entry["name"]] = entry
    return events


def canonical(entry):
    """The signature graph-cli matches a log against, `indexed` included."""
    parts = []
    for inp in entry["inputs"]:
        parts.append(("indexed " if inp["indexed"] else "") + inp["type"])
    return entry["name"] + "(" + ",".join(parts) + ")"


def describe(entry):
    parts = []
    for inp in entry["inputs"]:
        parts.append(
            ("indexed " if inp["indexed"] else "") + inp["type"] + " " + inp["name"]
        )
    return entry["name"] + "(" + ", ".join(parts) + ")"


def parse_data_sources(text):
    """Every ethereum data source in the manifest, as dicts.

    Deliberately not a YAML parse: subgraph.yaml carries reasoning in its
    comments and PyYAML is not a dependency of this repository. A section runs
    from its `- kind: ethereum` to the next one, or to the next top-level key,
    so a handler cannot be counted against the wrong data source.
    """
    lines = text.splitlines()
    starts = [
        i for i, line in enumerate(lines) if re.match(r"^\s{2}-\s+kind:\s*ethereum\s*$", line)
    ]
    sources = []
    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(lines)
        for i in range(start + 1, end):
            if re.match(r"^\S", lines[i]):
                end = i
                break

        source = {"name": None, "address": None, "file": None, "handlers": {}}
        pending = None
        for line in lines[start:end]:
            m = re.match(r"^\s*name:\s*(\S+)\s*$", line)
            if m and source["name"] is None:
                source["name"] = m.group(1)
            m = re.match(r'^\s*address:\s*"?(0x[0-9a-fA-F]{40})"?\s*$', line)
            if m:
                source["address"] = m.group(1)
            m = re.match(r"^\s*file:\s*(\S+)\s*$", line)
            if m:
                source["file"] = m.group(1)
            m = re.match(r"^\s*-\s*event:\s*(.+?)\s*$", line)
            if m:
                pending = m.group(1)
            m = re.match(r"^\s*handler:\s*(\S+)\s*$", line)
            if m and pending is not None:
                source["handlers"][pending] = m.group(1)
                pending = None
        sources.append(source)
    return sources


def main():
    problems = 0

    src = load_source_events()

    abi_path = os.path.join(ROOT, ABI_PATH)
    manifest_path = os.path.join(ROOT, MANIFEST_PATH)
    mapping_path = os.path.join(ROOT, MAPPING_PATH)
    for path in (abi_path, manifest_path, mapping_path):
        if not os.path.isfile(path):
            print(
                "check-subgraph-arbiter-events: %s missing — run the gate from the "
                "repository root" % path,
                file=sys.stderr,
            )
            sys.exit(3)

    with open(abi_path) as fh:
        subgraph_abi = json.load(fh)
    with open(manifest_path) as fh:
        manifest = fh.read()
    with open(mapping_path) as fh:
        mapping = fh.read()

    abi_events = {}
    for entry in subgraph_abi:
        if entry.get("type") != "event":
            continue
        if entry["name"] in abi_events:
            problems += fail(
                "%s appears twice in %s — one log would be decoded by two "
                "definitions" % (entry["name"], ABI_PATH)
            )
        abi_events[entry["name"]] = entry

    # ── 1. coverage over the accountability facet ────────────────────────────
    for name in sorted(src.get("ArbiterAccountabilityFacet", {})):
        if name in ACCOUNTABILITY or name in NOT_INDEXED:
            continue
        problems += fail(
            "ArbiterAccountabilityFacet emits %s and the subgraph does not know "
            "about it. Index it, or write it into NOT_INDEXED in %s with the "
            "reason." % (name, os.path.relpath(__file__, ROOT))
        )
    for name in NOT_INDEXED:
        if name in ACCOUNTABILITY:
            problems += fail(
                "%s is both indexed and listed as not indexed" % name
            )

    # ── 2. the ABI copy against solc ─────────────────────────────────────────
    wanted = []
    for name, handler in ACCOUNTABILITY.items():
        wanted.append(("ArbiterAccountabilityFacet", name, handler))
    for name, handler in REGISTRY.items():
        wanted.append(("ArbiterRegistryFacet", name, handler))

    for contract, name, handler in sorted(wanted, key=lambda t: t[1]):
        source = src.get(contract, {}).get(name)
        if source is None:
            problems += fail(
                "%s does not emit %s any more (or it was renamed) — the subgraph "
                "still lists it" % (contract, name)
            )
            continue

        copy = abi_events.get(name)
        if copy is None:
            problems += fail(
                "%s is missing from %s: %s" % (name, ABI_PATH, describe(source))
            )
            continue

        if copy.get("anonymous", False) != source.get("anonymous", False):
            problems += fail("%s: `anonymous` differs from the contract" % name)

        if len(copy["inputs"]) != len(source["inputs"]):
            problems += fail(
                "%s: %d parameters in %s, %d in %s\n     contract: %s\n     subgraph: %s"
                % (
                    name,
                    len(copy["inputs"]),
                    ABI_PATH,
                    len(source["inputs"]),
                    contract,
                    describe(source),
                    describe(copy),
                )
            )
            continue

        for pos, (mine, theirs) in enumerate(zip(copy["inputs"], source["inputs"])):
            for field in ("name", "type", "indexed"):
                if mine.get(field) != theirs.get(field):
                    problems += fail(
                        "%s parameter %d: %s is %r in %s, %r in %s\n"
                        "     contract: %s\n     subgraph: %s"
                        % (
                            name,
                            pos,
                            field,
                            mine.get(field),
                            ABI_PATH,
                            theirs.get(field),
                            contract,
                            describe(source),
                            describe(copy),
                        )
                    )

    # ── 3. the manifest against the ABI ──────────────────────────────────────
    sources = parse_data_sources(manifest)
    hosting = [
        s
        for s in sources
        if any(h in ACCOUNTABILITY.values() or h in REGISTRY.values() for h in s["handlers"].values())
    ]

    if not hosting:
        problems += fail(
            "no data source in %s declares a single accountability handler — "
            "nothing is listening" % MANIFEST_PATH
        )
    elif len(hosting) > 1:
        problems += fail(
            "the accountability handlers are spread over %d data sources (%s). "
            "They belong to one, and it has to be the one indexing the boards."
            % (len(hosting), ", ".join(str(s["name"]) for s in hosting))
        )
    else:
        host = hosting[0]

        # The address is not compared against a literal here: with one data
        # source that would be the file agreeing with itself. It is compared
        # against a job — handleJobPosted has been indexing the live diamond
        # since July, so the section carrying it is the diamond's section. Move
        # the arbiter handlers to a data source pointed at a facet and this
        # goes red; facets are replaced by every cut, the proxy address never
        # changes, and a data source aimed at a facet goes quiet at the next
        # upgrade with no error anywhere.
        if BOARD_ANCHOR_HANDLER not in host["handlers"].values():
            problems += fail(
                "the accountability handlers sit on data source `%s` at %s, which "
                "does not carry %s — that is not the diamond's data source"
                % (host["name"], host["address"], BOARD_ANCHOR_HANDLER)
            )

        # One data source, therefore one startBlock. Not a style rule: a second
        # one makes frontend/src/lib/arbiterTurn.test.ts refuse to guess which
        # block belongs to the diamond, and it is right to refuse. Measured on
        # 17 August 2026 — a second data source here turned two of its tests
        # red, in a file with nothing to do with arbiters.
        blocks = re.findall(r"^\s*startBlock:\s*\d+\s*$", manifest, re.M)
        if len(blocks) != 1:
            problems += fail(
                "%d `startBlock:` lines in %s. The frontend reads this file for the "
                "diamond's deploy block and refuses to guess between two of them "
                "(frontend/src/lib/arbiterTurn.test.ts) — keep the arbiter handlers "
                "on the existing data source." % (len(blocks), MANIFEST_PATH)
            )

        for contract, name, handler in sorted(wanted, key=lambda t: t[1]):
            source = src.get(contract, {}).get(name)
            if source is None:
                continue
            sig = canonical(source)
            if sig not in host["handlers"]:
                near = [s for s in host["handlers"] if s.startswith(name + "(")]
                problems += fail(
                    "no handler for %s\n     contract: %s\n     manifest: %s"
                    % (sig, describe(source), near[0] if near else "nothing at all")
                )
                continue
            if host["handlers"][sig] != handler:
                problems += fail(
                    "%s is handled by %s, this gate expects %s"
                    % (sig, host["handlers"][sig], handler)
                )

        # ── 4. the handlers reach the file the manifest names ────────────────
        # The bodies are in arbiter.ts; the manifest names diamond.ts, which
        # re-exports them. `graph build` refuses a handler the mapping does not
        # export (measured), so this is a second pair of eyes rather than the
        # only one — but it names the two-file arrangement, which a compile
        # error does not.
        mapping_named = os.path.join(ROOT, "subgraph", (host["file"] or "").lstrip("./"))
        named_text = ""
        if os.path.isfile(mapping_named):
            with open(mapping_named) as fh:
                named_text = fh.read()
        else:
            problems += fail(
                "the manifest maps through %r, which is not a file" % host["file"]
            )

        for _, name, handler in sorted(wanted, key=lambda t: t[1]):
            if not re.search(r"^export function %s\(" % re.escape(handler), mapping, re.M):
                problems += fail(
                    "%s is named in the manifest for %s and not defined in %s"
                    % (handler, name, MAPPING_PATH)
                )
            if named_text and not re.search(r"\b%s\b" % re.escape(handler), named_text):
                problems += fail(
                    "%s never reaches %s — a data source only sees what its own "
                    "mapping file exports" % (handler, host["file"])
                )

    if problems:
        print()
        print("check-subgraph-arbiter-events: %d problem(s)" % problems)
        return 1

    print(
        "✅ %d arbiter events: the ABI matches solc parameter for parameter "
        "(names, types, indexed), and every one is handled by the data source "
        "that indexes the diamond" % len(wanted)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
