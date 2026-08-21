#!/usr/bin/env python3
"""Hold the subgraph's copy of the arbiter events against the contracts, and
hold the AREA itself closed: no event of the two arbiter facets goes
unaccounted for, none of them is a declaration nothing emits, and no way of
booking a judicial mistake exists without a log a reader can find it by.

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

  * The PARAMETERS of an event are held against solc only for the events this
    subgraph indexes. An event written into the exception file is checked to
    exist and to have a reason, and its shape is not compared — nothing reads
    it, so nothing can break. The day it moves into the feed it leaves the file
    and the comparison starts applying to it.

    ⚠️ COVERAGE ITSELF IS ENFORCED OVER BOTH FACETS since 21 August 2026, and
    it was not before. The old rule held ArbiterAccountabilityFacet to full
    coverage and said nothing at all about ArbiterRegistryFacet, on the argument
    that the registry emits thirty-odd events with nothing to do with
    accountability. The price of that argument was measured: RemovalProposedByChain
    and ChainAccusationCleared — the chain accusing an arbiter in its own name,
    and the withdrawal of that accusation — sat unindexed from 18 to 21 August
    with every gate green, remembered by a comment in this file and nothing
    else. Now every event of both facets is either handled or written into
    script/subgraph-arbiter-events.allow with a reason in words.
  * That the selectors are mounted on the live diamond. That is the cut's job
    and test/ArbiterAccountabilityUpgrade.t.sol's.
  * That the handlers do anything sensible with what they decode.
  * The SHAPE of an event in a written-off file. Those files are held only to
    their event COUNT, which is what stops one growing an arbiter event
    unnoticed; what the other events in them look like is somebody else's rule.

TWO NUMBERS THAT DO NOT ADD UP, ON PURPOSE, so nobody goes looking for the
difference. The parameter comparison runs over BINDINGS — 21 of them — because
ArbiterDemoted and ArbiterSuspensionLifted are each declared once and emitted
from both facets, so solc puts them into both ABIs and each copy is checked
against each declaration. Coverage runs over DECLARATIONS — 45 — because one
event is one decision. Expect bindings to exceed the handled count by exactly
the number of cross-facet emits.

THREE THINGS ARE READ FROM solc's AST rather than from the text, and every one
of them is a place where a scanner would have recognised spelling and gone
quiet on a rewording: which files declare which events, how many `emit`
statements resolve to each declaration, and which functions call
_recordArbiterMistake. The AST is in the artifacts already (`ast = true` in
foundry.toml, put there for check-gasless-sender.sh), so it costs nothing.

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
    0   the copies agree with the contracts; every event of both arbiter facets
        is indexed or excluded with a reason; every one of them is emitted
        somewhere; every .sol under src/ is classified; and every caller of
        _recordArbiterMistake names a log the subgraph indexes
    1   any of those fails, or a written-down decision has gone stale — an
        exclusion for an event nothing declares, a written-off file that does
        not exist, a mistake path that no longer calls anything
    2   a decision file is missing, empty or damaged — a record without its
        reason line, a written-off file with no pinned count, a duplicate
        record, text outside any record. There is nothing to compare against,
        which is NOT "clean"
    3   the check could not run (no artifacts, no AST, no manifest, or
        _recordArbiterMistake renamed out from under this gate): the rule is
        UNVERIFIED, which is not the same as "no violations"
"""

import glob
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
    "ArbiterSuspensionLifted": "handleArbiterSuspensionLifted",  # also in REGISTRY, see below
    "ArbiterRemovedForCause": "handleArbiterRemovedForCause",
    "RemovalProposed": "handleRemovalProposed",
    "RemovalProposalWithdrawn": "handleRemovalProposalWithdrawn",
    "RemovalProposalConsumed": "handleRemovalProposalConsumed",
    "RemovalAnswered": "handleRemovalAnswered",
    # ⚠️ DECLARED IN ArbiterRegistryFacet, EMITTED FROM THIS ONE since task 12
    # (18 August 2026). The third judicial mistake stopped unseating anyone —
    # it suspends and accuses — so "demoted" became true two days later, inside
    # executeChainRemoval, which lives here. solc puts the event into BOTH
    # facets' ABIs, so it shows up in this facet's coverage as well.
    #
    # Listed in both ACCOUNTABILITY and REGISTRY on purpose: the comparison in
    # section 2 then runs TWICE, once per facet, against the same subgraph copy
    # — which is exactly the check a cross-contract emit needs. Let the two
    # declarations drift apart and one of the two runs goes red.
    "ArbiterDemoted": "handleArbiterDemoted",
    # The words of the accusation and the words of the answer, indexed on
    # 21 August 2026. They were the two entries of NOT_INDEXED below, carrying
    # the reason "the contract work landed first" — which stopped being a
    # reason once the feed work followed it.
    "RemovalReasonGiven": "handleRemovalReasonGiven",
    "RemovalReplyGiven": "handleRemovalReplyGiven",
}

# Events deliberately not indexed live in a file of their own, one record each,
# every record carrying its reason in words. The dict that used to sit here held
# two entries and was emptied on 21 August 2026 when both were indexed; the file
# replaces it because coverage now runs over the registry too, where the
# exceptions are two dozen and belong nowhere near the handler map.
ALLOW_PATH = "script/subgraph-arbiter-events.allow"

# The line a record cannot be without. Deliberately awkward, exactly as
# gasless-sender.allow's "не гейслесс, потому что:" is: an exception cannot be
# taken without saying out loud why.
ALLOW_REASON_PREFIX = "not indexed, because:"

# The other kind of record, and the answer to "which contracts are in scope".
# Copied wholesale from gasless-sender.allow, which had the same problem one
# floor down and solved it this way: the scope is not a list in the script — it
# is EVERY .sol under src/, minus the files written off here with a reason. A
# file classified nowhere fails the gate, so a new contract cannot arrive
# unnoticed, and neither can an arbiter event declared in an old one.
ALLOW_SCOPE_PREFIX = "out of scope :: "
ALLOW_SCOPE_REASON_PREFIX = "no accountability events, because:"

# Pinned per out-of-scope file, exactly as `occurrences:` is pinned there and
# for exactly the same reason: without it, writing off a file once writes off
# everything ever added to it. This is the line that makes the reviewer's
# measurement red — an arbiter event declared in ReputationFacet moves its count
# and the gate stops.
ALLOW_SCOPE_COUNT_PREFIX = "events:"

# The third list, and the only one that is not about exceptions: every way an
# arbiter can be booked a judicial mistake, with the log each leaves. It has a
# file of its own because the allow file above is framed as "what we chose not
# to index", and a registry of mistake paths is not an exception to anything.
PATHS_PATH = "script/arbiter-mistake-paths.allow"
PATHS_LOG_PREFIX = "log:"
PATHS_REASON_PREFIX = "recoverable, because:"

# The function every mistake path goes through. Callers are resolved through
# solc's AST by declaration id, never by grepping for the name.
MISTAKE_SINK = "_recordArbiterMistake"

# From ArbiterRegistryFacet only what the accountability feed needs: how the
# seat was taken, and the two ways of losing it that live in that facet.
# Coverage is NOT enforced here — see the module docstring.
REGISTRY = {
    "ArbiterSeated": "handleArbiterSeated",
    "ArbiterResigned": "handleArbiterResigned",
    "ArbiterDemoted": "handleArbiterDemoted",
    # ⚠️ DECLARED IN ArbiterAccountabilityFacet, EMITTED FROM THE REGISTRY TOO
    # since task 12 review round 2 (18 August 2026): the vindication branch in
    # resolveAppeal lifts the suspension it cancels, and a lift that leaves no
    # log reads in the feed as a suspension that never ended. solc therefore
    # puts the event into BOTH facets' ABIs.
    #
    # Listed on both sides for the same reason ArbiterDemoted is: the parameter
    # comparison then runs once per facet against the same subgraph copy, which
    # is the check a cross-contract emit needs. Let the declarations drift and
    # one of the two runs goes red.
    "ArbiterSuspensionLifted": "handleArbiterSuspensionLifted",
    # ── The chain accusing in its own name (indexed 21 August 2026) ──────────
    # Until these two were here, an arbiter under a chain accusation read in
    # the feed as an arbiter with nothing against him, and the removal that
    # followed read as a seat taken away with no accusation, no pause and no
    # right of reply.
    "RemovalProposedByChain": "handleRemovalProposedByChain",
    "ChainAccusationCleared": "handleChainAccusationCleared",
    # ── The evidence under that accusation (owner decision 15a) ──────────────
    # The accused must see EVERY dispute the accusation stands on, and the
    # accusation names one of three. The other two are recovered from the
    # verdict logs, which means the RESETS have to be recoverable as well: a
    # streak is mistakes in an unbroken row, and the break is "finalized
    # without having been overturned", which no single log states.
    "VerdictSubmitted": "handleVerdictSubmitted",
    "VerdictOverturned": "handleVerdictOverturned",
    "VerdictFinalized": "handleVerdictFinalized",
    "AppealResolved": "handleAppealResolved",
    # ⚠️ THE PATH THAT USED TO LEAVE NO TRACE (round of edits 1, 21 August
    # 2026). A judicial mistake booked on the timeout emitted nothing naming the
    # arbiter, so a mistake run containing one could not be reconstructed by any
    # reading of the chain — the accused was shown two of the three disputes he
    # was about to be removed over. The event was added to the contract for this
    # gap and for no other reader.
    "ArbiterTimeoutRecorded": "handleArbiterTimeoutRecorded",
}

# ⚠️ THE HOLE THAT USED TO BE HERE IS CLOSED, and the closing is worth keeping
# on the record. Until 21 August 2026 coverage ran over the accountability facet
# alone: an event added to the REGISTRY and forgotten produced no red anywhere,
# which is how RemovalProposedByChain and ChainAccusationCleared spent three
# days unindexed with every gate green.
#
# The objection to closing it was real — the facet emits thirty-seven events and
# most have nothing to do with this feed, so enforcement means two dozen written
# exceptions. The owner's answer was to pay it, in the shape the repository
# already uses for exactly this: an allow file with a mandatory reason, the same
# arrangement as script/gasless-sender.allow. The list is
# script/subgraph-arbiter-events.allow.

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


def iter_nodes(node):
    """Every dict in an AST, depth first."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from iter_nodes(value)
    elif isinstance(node, list):
        for value in node:
            yield from iter_nodes(value)


def load_asts():
    """{relpath: ast} for every .sol under src/.

    solc's own tree, not a scan of the text, and the reason is the one this
    repository has already paid for twice: a scanner recognises SPELLING. An
    `emit` written as `emit ArbiterRegistryFacet.ArbiterDemoted(...)` from a
    neighbouring facet, an event declared inside a library, a name that appears
    in a comment — all three are answered correctly by the tree and wrongly by a
    regular expression. The AST is in the artifacts already (`ast = true` in
    foundry.toml, put there for check-gasless-sender.sh), so this costs nothing.
    """
    asts = {}
    for artifact in glob.glob(os.path.join(ROOT, "out", "**", "*.json"), recursive=True):
        try:
            with open(artifact) as fh:
                data = json.load(fh)
        except (ValueError, OSError):
            continue
        if not isinstance(data, dict):
            continue
        ast = data.get("ast")
        if not isinstance(ast, dict):
            continue
        path = ast.get("absolutePath")
        if isinstance(path, str) and path.startswith("src/") and path not in asts:
            asts[path] = ast

    sources = sorted(
        os.path.relpath(p, ROOT).replace(os.sep, "/")
        for p in glob.glob(os.path.join(ROOT, "src", "**", "*.sol"), recursive=True)
    )
    missing = [p for p in sources if p not in asts]
    if missing:
        print(
            "check-subgraph-arbiter-events: no AST for %s — run `forge build`, and "
            "check that foundry.toml still carries `ast = true`"
            % ", ".join(missing),
            file=sys.stderr,
        )
        sys.exit(3)
    return sources, asts


def index_events(sources, asts):
    """Declarations and emit sites of every event under src/.

    Returns (declarations, emits) where declarations is
    {(file, contract, name): id} and emits is {id: how many `emit` statements
    anywhere in src/ resolve to that declaration}.

    ⚠️ THE TWO ARE COUNTED SEPARATELY ON PURPOSE. An event that is declared and
    never emitted is a promise in the ABI that the chain will never keep, and
    for an indexed one it is worse: the handler, the manifest entry and the ABI
    copy all still line up, so every check that reads DECLARATIONS stays green
    while the feed goes silent for good. That happened here in reverse on
    15 August 2026, when ArbiterRemoved lost its only emit site along with the
    function that emitted it.
    """
    declarations = {}
    emits = {}
    for path in sources:
        ast = asts[path]
        for contract in iter_nodes(ast):
            if contract.get("nodeType") != "ContractDefinition":
                continue
            for node in contract.get("nodes", []):
                if node.get("nodeType") == "EventDefinition":
                    declarations[(path, contract["name"], node["name"])] = node["id"]
        for node in iter_nodes(ast):
            if node.get("nodeType") != "EmitStatement":
                continue
            # `emit Foo(...)` is an Identifier; `emit Other.Foo(...)` is a
            # MemberAccess. Both carry the id of the declaration they resolve
            # to, which is what makes this a semantic count rather than a
            # textual one.
            ref = node.get("eventCall", {}).get("expression", {}).get("referencedDeclaration")
            if ref is not None:
                emits[ref] = emits.get(ref, 0) + 1
    return declarations, emits


class AllowError(Exception):
    """A decision file cannot be read as a list of decisions."""


def parse_paths(text):
    """{qualified name: (logs, reason)} from the mistake-path registry."""
    records = {}
    key = None
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        header = re.match(r"^===\s*([\w.]+)\s*===$", line)
        if header:
            key = header.group(1)
            if key in records:
                raise AllowError("line %d: %s appears twice" % (lineno, key))
            records[key] = {"logs": [], "reason": False}
            continue

        if line.startswith("==="):
            raise AllowError(
                "line %d: %r is not a record header. The shape is "
                "`=== <Contract>.<function> ===`" % (lineno, line)
            )
        if key is None:
            raise AllowError(
                "line %d: %r stands outside any record" % (lineno, line)
            )

        if line.startswith(PATHS_LOG_PREFIX):
            names = [n.strip() for n in line[len(PATHS_LOG_PREFIX):].split(",")]
            records[key]["logs"].extend(n for n in names if n)
        elif line.startswith(PATHS_REASON_PREFIX):
            records[key]["reason"] = True

    broken = sorted(
        k for k, v in records.items() if not v["logs"] or not v["reason"]
    )
    if broken:
        raise AllowError(
            "%s: a record needs a line beginning %r and a line beginning %r. "
            "Naming the path without naming the log it leaves is the whole "
            "mistake this file exists to stop"
            % (", ".join(broken), PATHS_LOG_PREFIX, PATHS_REASON_PREFIX)
        )
    return records


def load_paths():
    path = os.path.join(ROOT, PATHS_PATH)
    if not os.path.isfile(path):
        print(
            "check-subgraph-arbiter-events: %s is missing — there is nothing to "
            "hold the mistake paths against, which is not the same as their all "
            "being covered." % PATHS_PATH,
            file=sys.stderr,
        )
        sys.exit(2)
    with open(path) as fh:
        text = fh.read()
    try:
        return parse_paths(text)
    except AllowError as exc:
        print(
            "check-subgraph-arbiter-events: %s is damaged — nothing to compare "
            "against:" % PATHS_PATH,
            file=sys.stderr,
        )
        print("  %s" % exc, file=sys.stderr)
        sys.exit(2)


def find_mistake_callers(src_files, asts):
    """{"<Contract>.<function>": True} — every caller of MISTAKE_SINK.

    Resolved by declaration id, so a call written any which way is found and a
    mention in a comment is not. Returns the qualified names of the FUNCTIONS
    the calls sit in: a wrapper introduced tomorrow reads as a new path, which
    is the honest answer — a wrapper IS a new path.
    """
    sink_ids = set()
    for path in src_files:
        for node in iter_nodes(asts[path]):
            if (
                node.get("nodeType") == "FunctionDefinition"
                and node.get("name") == MISTAKE_SINK
            ):
                sink_ids.add(node["id"])
    if not sink_ids:
        print(
            "check-subgraph-arbiter-events: no function named %s under src/ — "
            "it was renamed or removed, and this gate no longer knows what a "
            "mistake path is. The rule is UNVERIFIED." % MISTAKE_SINK,
            file=sys.stderr,
        )
        sys.exit(3)

    callers = set()
    for path in src_files:
        for contract in iter_nodes(asts[path]):
            if contract.get("nodeType") != "ContractDefinition":
                continue
            for function in iter_nodes(contract):
                if function.get("nodeType") != "FunctionDefinition":
                    continue
                for node in iter_nodes(function):
                    if node.get("nodeType") != "FunctionCall":
                        continue
                    ref = node.get("expression", {}).get("referencedDeclaration")
                    if ref in sink_ids:
                        callers.add(
                            "%s.%s" % (contract["name"], function.get("name") or "<fallback>")
                        )
    return callers


def parse_allow(text):
    """Two kinds of record from the allow file.

    Returns (events, scope) where events is {(contract, event): reason} and
    scope is {relpath: pinned event count}.

    Read by spelling, like the manifest and for the same reason: the file is
    written by people and carries its argument in comments. Every shape this
    parser does not understand raises rather than being skipped — an exception
    silently dropped would put an event back into coverage and produce a red
    somewhere else entirely, which is the confusing direction to fail in.
    """
    events = {}
    scope = {}
    key = None          # ("event", contract, name) or ("scope", relpath)
    reasoned = set()
    counted = set()

    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        header = re.match(r"^===\s*(.+?)\s*===$", line)
        if header:
            body = header.group(1)
            if body.startswith(ALLOW_SCOPE_PREFIX):
                path = body[len(ALLOW_SCOPE_PREFIX):].strip()
                key = ("scope", path)
                if path in scope:
                    raise AllowError(
                        "line %d: %s is written off twice" % (lineno, path)
                    )
                scope[path] = None
                continue

            pair = re.match(r"^(\w+)\s*::\s*(\w+)$", body)
            if pair:
                key = ("event", pair.group(1), pair.group(2))
                if key[1:] in events:
                    raise AllowError(
                        "line %d: %s :: %s appears twice — two decisions about "
                        "one event, and no way to tell which is current"
                        % (lineno, key[1], key[2])
                    )
                events[key[1:]] = ""
                continue

            raise AllowError(
                "line %d: %r is neither shape of header. They are\n"
                "       === <Contract> :: <EventName> ===\n"
                "       === %s<path/under/src.sol> ==="
                % (lineno, line, ALLOW_SCOPE_PREFIX)
            )

        if line.startswith("==="):
            raise AllowError(
                "line %d: %r is not a record header — a header ends in `===` too"
                % (lineno, line)
            )

        if key is None:
            raise AllowError(
                "line %d: %r stands outside any record. Text before the first "
                "header has to be a comment, or it is a reason with nothing to "
                "be a reason for" % (lineno, line)
            )

        if key[0] == "event":
            if line.startswith(ALLOW_REASON_PREFIX):
                reasoned.add(key)
            events[key[1:]] += line + " "
        else:
            if line.startswith(ALLOW_SCOPE_REASON_PREFIX):
                reasoned.add(key)
            if line.startswith(ALLOW_SCOPE_COUNT_PREFIX):
                if key in counted:
                    raise AllowError(
                        "line %d: %s carries two `%s` lines"
                        % (lineno, key[1], ALLOW_SCOPE_COUNT_PREFIX)
                    )
                raw_count = line[len(ALLOW_SCOPE_COUNT_PREFIX):].strip()
                if not raw_count.isdigit():
                    raise AllowError(
                        "line %d: `%s %s` is not a number" % (lineno, ALLOW_SCOPE_COUNT_PREFIX, raw_count)
                    )
                scope[key[1]] = int(raw_count)
                counted.add(key)

    all_keys = [("event",) + k for k in events] + [("scope", p) for p in scope]
    missing_reason = sorted(
        ("%s :: %s" % k[1:]) if k[0] == "event" else k[1]
        for k in all_keys
        if k not in reasoned
    )
    if missing_reason:
        raise AllowError(
            "%s: no reason line. An exception is not taken without saying why —\n"
            "       events need a line beginning %r,\n"
            "       written-off files a line beginning %r"
            % (", ".join(missing_reason), ALLOW_REASON_PREFIX, ALLOW_SCOPE_REASON_PREFIX)
        )

    uncounted = sorted(p for p, n in scope.items() if n is None)
    if uncounted:
        raise AllowError(
            "%s: no `%s <n>` line. Without the pin, writing a file off once "
            "writes off everything ever added to it"
            % (", ".join(uncounted), ALLOW_SCOPE_COUNT_PREFIX)
        )
    return events, scope


def load_allow():
    path = os.path.join(ROOT, ALLOW_PATH)
    if not os.path.isfile(path):
        print(
            "check-subgraph-arbiter-events: %s is missing. There is nothing to "
            "compare the uncovered events against, which is not the same as "
            "there being none." % ALLOW_PATH,
            file=sys.stderr,
        )
        sys.exit(2)
    with open(path) as fh:
        text = fh.read()
    if not text.strip():
        print(
            "check-subgraph-arbiter-events: %s is empty." % ALLOW_PATH,
            file=sys.stderr,
        )
        sys.exit(2)
    try:
        return parse_allow(text)
    except AllowError as exc:
        print(
            "check-subgraph-arbiter-events: %s is damaged — nothing to compare "
            "against:" % ALLOW_PATH,
            file=sys.stderr,
        )
        print("  %s" % exc, file=sys.stderr)
        sys.exit(2)


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

    # ── 1. THE AREA IS CLOSED: every .sol, every event, every event ALIVE ────
    #
    # Three checks that used to be one, and each of the two additions closes a
    # blind zone a reviewer measured on 21 August 2026:
    #
    #   1a  scope — the set of contracts was a two-entry constant, so an arbiter
    #       event declared in ReputationFacet.sol left the gate green. Now the
    #       area is EVERY .sol under src/ minus what the allow file writes off,
    #       with the event count of each written-off file pinned.
    #   1b  coverage — unchanged in spirit: handled xor excluded, no silence.
    #   1c  liveness — the gate compared DECLARATIONS. Delete the only `emit` of
    #       an indexed event and the declaration, the handler, the manifest and
    #       the ABI all still agreed, so nothing went red while the feed went
    #       silent for good.
    allowed, written_off = load_allow()
    src_files, asts = load_asts()
    declarations, emit_counts = index_events(src_files, asts)

    handled = {
        "ArbiterAccountabilityFacet": ACCOUNTABILITY,
        "ArbiterRegistryFacet": REGISTRY,
    }
    # ⚠️ DERIVED, NOT TYPED AGAIN. The first draft of this section carried the
    # two paths as a literal beside ARTIFACTS, which is two statements of one
    # fact — add a third contract above and the area silently keeps the old
    # shape. The AST already knows where every contract lives, so ask it.
    contract_files = {contract: path for path, contract, _ in declarations}
    artifact_files = set()
    for contract in sorted(ARTIFACTS):
        path = contract_files.get(contract)
        if path is None:
            print(
                "check-subgraph-arbiter-events: %s is read by this gate and "
                "declares no events anywhere under src/ — it was renamed, moved "
                "or emptied. The rule is UNVERIFIED." % contract,
                file=sys.stderr,
            )
            sys.exit(3)
        artifact_files.add(path)

    # ── 1a. every file in src/ is classified ────────────────────────────────
    for path in src_files:
        if path in written_off or path in artifact_files:
            continue
        problems += fail(
            "%s is neither read by this gate nor written off in %s.\n"
            "     Every .sol under src/ has to be one or the other — that is how\n"
            "     an arbiter event declared in an unexpected file is noticed.\n"
            "     Add to %s:\n"
            "       === %s%s ===\n"
            "       %s <why no accountability event can live here>\n"
            "       %s %d"
            % (path, ALLOW_PATH, ALLOW_PATH, ALLOW_SCOPE_PREFIX, path,
               ALLOW_SCOPE_REASON_PREFIX, ALLOW_SCOPE_COUNT_PREFIX,
               sum(1 for f, _, _ in declarations if f == path))
        )

    for path, pinned in sorted(written_off.items()):
        if path not in src_files:
            problems += fail(
                "%s writes off %s, which is not a file under src/ — stale"
                % (ALLOW_PATH, path)
            )
            continue
        if path in artifact_files:
            problems += fail(
                "%s writes off %s, and this gate reads it — one of the two is "
                "out of date" % (ALLOW_PATH, path)
            )
            continue
        actual = sum(1 for f, _, _ in declarations if f == path)
        if actual != pinned:
            problems += fail(
                "%s declares %d event(s), %s pins %d.\n"
                "     A file written off once must not quietly grow events. If the\n"
                "     new one is about arbiter accountability it belongs in the\n"
                "     feed; if it is not, raise the pin and say so."
                % (path, actual, ALLOW_PATH, pinned)
            )

    # ── 1b. every event of an in-scope file is handled or excluded ──────────
    #
    # Over DECLARATIONS, one per event, and not over the ABI: solc puts an event
    # into the ABI of every contract that emits it, so ArbiterDemoted and
    # ArbiterSuspensionLifted appear in both facets. Counting those twice here
    # would ask for two decisions about one event.
    for (path, contract, name), node_id in sorted(declarations.items()):
        if path not in artifact_files:
            continue
        in_handlers = name in handled.get(contract, {})
        in_allow = (contract, name) in allowed
        if in_handlers and in_allow:
            problems += fail(
                "%s :: %s is both indexed and written into %s. One of the two "
                "is out of date, and this gate cannot tell which."
                % (contract, name, ALLOW_PATH)
            )
        elif not in_handlers and not in_allow:
            problems += fail(
                "%s declares %s and the subgraph neither handles it nor "
                "excludes it.\n"
                "     Index it, or add to %s:\n"
                "       === %s :: %s ===\n"
                "       %s <why this feed does not need it>"
                % (contract, name, ALLOW_PATH, contract, name,
                   ALLOW_REASON_PREFIX)
            )

        # ── 1c. and it actually fires somewhere ─────────────────────────────
        if emit_counts.get(node_id, 0) == 0:
            problems += fail(
                "%s :: %s is declared and emitted NOWHERE in src/.%s\n"
                "     A declaration with no emit is a promise in the ABI that the\n"
                "     chain will never keep. Delete it, or emit it."
                % (
                    contract,
                    name,
                    "\n     It is INDEXED, so the feed would wait for a log that "
                    "cannot arrive." if in_handlers else "",
                )
            )

    # ── 1d. every way of booking a mistake leaves a log the feed reads ──────
    #
    # Owner decision 15a lives or dies here. The accusation names one dispute
    # and stands on three; the rest are recovered from the logs, which holds
    # only while EVERY path that books a mistake leaves one. The scene in
    # test/ArbiterRemovalForCauseIntegration.t.sol proves the three paths it
    # plays and can never play a fourth, so the list of paths is held here
    # instead — against solc's AST, never against a grep.
    paths = load_paths()
    callers = find_mistake_callers(src_files, asts)
    handled_names = set(ACCOUNTABILITY) | set(REGISTRY)

    for caller in sorted(callers):
        if caller in paths:
            continue
        problems += fail(
            "%s calls %s and is not in %s.\n"
            "     A new way of booking a judicial mistake is a new thing the\n"
            "     accused has to be able to find. Name the log it leaves:\n"
            "       === %s ===\n"
            "       %s <EventName>\n"
            "       %s <how a reader gets from that log to this arbiter>"
            % (caller, MISTAKE_SINK, PATHS_PATH, caller,
               PATHS_LOG_PREFIX, PATHS_REASON_PREFIX)
        )

    for caller in sorted(paths):
        if caller not in callers:
            problems += fail(
                "%s lists %s, which no longer calls %s — stale"
                % (PATHS_PATH, caller, MISTAKE_SINK)
            )
            continue
        for name in paths[caller]["logs"]:
            if name not in handled_names:
                problems += fail(
                    "%s says %s is recoverable from %s, and the subgraph does "
                    "not index %s.\n"
                    "     Naming a log nobody reads leaves the accused exactly "
                    "where he was."
                    % (PATHS_PATH, caller, name, name)
                )

    # A decision about an event that no longer exists is not a decision, it is
    # litter that makes the file look more complete than it is. Same treatment
    # as a stale entry in gasless-sender.allow.
    declared_pairs = {(contract, name) for _, contract, name in declarations}
    for contract, name in sorted(allowed):
        if (contract, name) not in declared_pairs:
            problems += fail(
                "%s excludes %s :: %s, and nothing under src/ declares it any "
                "more (or it was renamed) — the exclusion is stale"
                % (ALLOW_PATH, contract, name)
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

    in_scope = [k for k in declarations if k[0] in artifact_files]
    live = sum(emit_counts.get(declarations[k], 0) for k in in_scope)
    print(
        "✅ %d handler bindings: the ABI matches solc parameter for parameter "
        "(names, types, indexed), and every one is handled by the data source "
        "that indexes the diamond" % len(wanted)
    )
    # ⚠️ BINDINGS ABOVE, DECLARATIONS BELOW, and the two numbers do not add up
    # on purpose. ArbiterDemoted and ArbiterSuspensionLifted are each declared
    # once and emitted from BOTH facets, so solc puts them into both ABIs and
    # the comparison above runs on each — that is the check a cross-contract
    # emit needs. Coverage counts the declaration once, because one event is one
    # decision. Expect the binding count to exceed the handled count by exactly
    # the number of such events.
    print(
        "✅ coverage: %d event declarations in the two arbiter facets, %d "
        "handled, %d excluded in %s with a reason" % (
            len(in_scope), len(in_scope) - len(allowed), len(allowed), ALLOW_PATH
        )
    )
    print(
        "✅ liveness: %d emit site(s) behind them, none of the %d declarations "
        "dead" % (live, len(in_scope))
    )
    print(
        "✅ area: %d file(s) under src/, %d read here, %d written off with a "
        "reason and a pinned event count"
        % (len(src_files), len(artifact_files), len(written_off))
    )
    print(
        "✅ mistake paths: %d caller(s) of %s, each naming an indexed log in %s"
        % (len(callers), MISTAKE_SINK, PATHS_PATH)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
