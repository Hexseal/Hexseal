#!/usr/bin/env bash
# Gate: the subgraph's copy of the arbiter-accountability events matches the
# contracts, and every one of them has a handler pointed at the diamond.
#
# ⚠️ WIRED INTO CI since 21 August 2026, as the eighth, together with
# check-arbiter-bond-writers.sh as the seventh. Here stood "NOT WIRED INTO CI,
# deliberately... each new one is a tax on every run" — an argument nobody had
# measured. Measured: 3.1 seconds on a warm cache, which is the only kind CI
# has here, since `forge test` runs first and this gate's own `forge build` is
# then a cache hit.
#
# The reason it could not stay out: this gate exists to catch an event being
# FORGOTTEN, and until now it was itself remembered only when somebody thought
# to run it. A guard against forgetting that runs from memory is the defect it
# was written against.
#
# What it guards, why the seam is worth a gate, and what it deliberately does
# not look at — the docstring of script/check_subgraph_arbiter_events.py.
#
# Short version: `graph build` proves the manifest agrees with the ABI file and
# the handlers agree with the schema. Nothing at all proves the ABI file agrees
# with the .sol it was copied from, and `indexed` can move between parameters
# without changing anything `graph build` looks at — the feed then goes silent
# or decodes the wrong field into a public accusation.
#
# Usage:
#   ./script/check-subgraph-arbiter-events.sh
#
# Exit codes:
#   0   the copies agree with the contracts, and every event of both arbiter
#       facets is either indexed or excluded with a reason
#   1   they do not, or an event is indexed nowhere and excluded nowhere, or an
#       exclusion has gone stale
#   2   script/subgraph-arbiter-events.allow is missing, empty or damaged —
#       there is nothing to compare the uncovered events against
#   3   the check could not run (build failed, no artifacts, files missing):
#       the rule is UNVERIFIED, which is not "no violations"
#   127 python3 not found
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
    echo "check-subgraph-arbiter-events: python3 not found" >&2
    exit 127
fi

# The comparison is against solc's own ABI output in out/, so the artifacts
# have to be current — otherwise the gate would be checking yesterday's
# contracts and saying nothing about today's. Almost always a no-op.
#
# forge's exit code is captured by hand, around `set -e`: under it a failed
# build would kill the script silently, before the diagnosis and before the
# sentinel 3 — and a silent non-zero code is indistinguishable from "the gate
# found a violation".
set +e
BUILD_OUT=$(forge build 2>&1)
BUILD_RC=$?
set -e
if [[ $BUILD_RC -ne 0 ]]; then
    echo "check-subgraph-arbiter-events: forge build failed, the rule is UNVERIFIED" >&2
    echo "$BUILD_OUT" | tail -20 >&2
    exit 3
fi

python3 script/check_subgraph_arbiter_events.py
