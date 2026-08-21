#!/usr/bin/env bash
# Gate: no tracked file points at material that is deliberately not in git.
#
# WIRED INTO CI since 21 August 2026, as the ninth. Cost measured, not guessed:
# it reads the 692 tracked files of this repository and needs no build, no
# node_modules and no network — see the timing in the header of the CI step.
#
# WHY IT EXISTS. The repository went public on 14 August 2026. The design specs
# and the working notes did not: they are excluded, one through
# `.git/info/exclude` and one through `.gitignore`. Nothing stopped a comment
# from pointing into them, and by 21 August eight tracked files did. Each
# pointer is a dead link for the reader AND a disclosure of the date and
# subject of a document being withheld.
#
# Two sweeps by hand had already been done for this class, and both times they
# found some of the references and missed the rest. One of the misses is the
# reason this gate does not read physical lines: the reference in
# `relayer/bagStore.js` was WRAPPED — the directory ended one line and resumed
# on the next behind a `//` — so every grep came back clean while the pointer
# was perfectly readable to a human.
#
# What counts as a reference, how a wrapped path is reassembled, what happens
# to a file the scanner cannot read, and why the list of forbidden paths is
# written out by hand instead of derived — the docstring of
# script/check_internal_refs.py and the header of script/internal-refs.deny.
#
# Usage:
#   ./script/check-internal-refs.sh           — check
#   ./script/check-internal-refs.sh --print   — also list the accounted-for
#                                               exceptions and their counts
#
# Exit codes:
#   0   nothing tracked points at withheld material
#   1   something does, or a wrapped fragment could not be resolved, or a file
#       the scanner cannot read is unaccounted for, or an exception drifted
#   2   script/internal-refs.deny or script/internal-refs.allow is missing,
#       empty or damaged — there is nothing to check against, and that is not
#       the same as "clean"
#   3   the check could not run at all: the rule is UNVERIFIED, which is also
#       not the same as "clean"
#   127 python3 not found
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
    echo "check-internal-refs: python3 not found" >&2
    exit 127
fi

# No `forge build` and no `npm ci` here on purpose: this gate reads the files
# git already has, so it holds on a bare checkout — including one where the
# submodules were never initialised.
python3 script/check_internal_refs.py "$@"
