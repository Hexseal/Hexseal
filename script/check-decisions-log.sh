#!/usr/bin/env bash
# Gate: an item marked closed in the debt list must come with a line in the
# decision journal.
#
# WIRED INTO CI since 22 August 2026, as the tenth. It reads two revisions of
# two markdown files through `git show` — no build, no node_modules, no
# network, no submodules. Measured on this repository, three consecutive runs:
# 0.05 s, 0.05 s, 0.05 s.
#
# WHY IT EXISTS. `docs/OPEN-ITEMS.md` says what is known and not done;
# `docs/DECISIONS.md` says what was decided and why, and what was turned down.
# Until 22 August 2026 the second file did not exist at all: the reasoning
# behind a month of work lived only in material that is deliberately kept out
# of this repository, so from outside the project the decisions did not exist.
# What was left for a reader was the commit log — a record of work, not a
# record of meaning. Over the week when removal of an arbiter turned into an
# adversarial process, the commits were mostly tests, gates and build.
#
# Closing an item is exactly the moment the journal has something to gain: a
# hole gets closed BECAUSE somebody chose one way over another. That is why
# the gate fires on the transition and on nothing else — it does not ask for a
# journal entry per edit, only per closure.
#
# ── HOW THE RANGE IS CHOSEN, AND WHAT HAPPENS WITHOUT ONE ────────────────────
#
# The comparison is a diff, not a state. State would mean inventing a
# correspondence between two independently numbered lists, and it would be red
# on arrival for every item closed before the journal existed.
#
# Resolution order, and the chosen range is always printed on the first line:
#
#   1. --range <base>..<head>            (<head> may be the token WORKTREE)
#   2. DECISIONS_RANGE=<base>..<head>    same syntax, from the environment
#   3. GitHub Actions: the event payload — a pull request compares base with
#      head, a push compares `before` with `after`
#   4. local, either of the two files edited on disk:  HEAD..WORKTREE
#   5. local, neither of them edited:                  HEAD~1..HEAD
#
# Run with no range at all, which is how it is normally run: rules 4 and 5
# answer, and they answer differently on purpose. Before committing, "my
# change" is what is on disk; after committing, it is the commit. Both are the
# right unit at the moment they apply.
#
# Rules 4 and 5 look at those two files and not at `git status` over the whole
# tree, and that is not a detail: a stray untracked file anywhere would
# otherwise make the tree "dirty", the range would become HEAD..WORKTREE, and a
# closure that had just been COMMITTED would show up as no change at all —
# green for the wrong reason.
#
# If nothing resolves — a shallow clone missing the base commit, a first commit
# with no parent — the gate exits 3, not 0. "Could not be checked" is not the
# same claim as "holds".
#
# That last case is why the checkout of the `contracts` job in CI carries
# `fetch-depth: 0`. With the default depth of one commit the base of the range
# is simply absent and every run would exit 3.
#
# ── WHAT COUNTS AS A CLOSURE MARK ────────────────────────────────────────────
#
# Four spellings live in the debt list today, not one, and a scanner taught
# only `✅ ЗАКРЫТ` would be recognising spelling instead of meaning. The gate
# reads a heading as closed when it carries the ✅ sign, or one of the closure
# words in capitals as a whole word (ЗАКРЫТ / СНЯТ / РЕШЁН / ОТКЛОНЁН /
# ОТВЕРГНУТ and their endings), or opens with a struck-through span. A word
# behind НЕ or ЕЩЁ НЕ is not a mark. The list of words is written out by hand
# in script/check_decisions_log.py and not derived from the file being checked:
# an expectation derived from the thing it checks agrees with it forever.
#
# ── WHAT IT DELIBERATELY DOES NOT CATCH ──────────────────────────────────────
#
# Written down because a gate whose blind spots are unknown gets trusted for
# more than it does:
#
#   * a closure recorded only in the BODY of an item — the scan reads headings
#     (`##` and `###`) and nothing else. Two spots in the file already carry a
#     mark on a level-3 heading, and those are seen; a mark inside a paragraph
#     is not. Widening it to every line was tried on paper and dropped: one
#     item quoting another item's status would fire the gate on prose;
#   * a closure written in words with no mark at all — "починено", "сделано",
#     "уехало в код". Nothing distinguishes that from an ordinary edit;
#   * a closure recorded somewhere else entirely — docs/PROCESS.md,
#     docs/CONTRACT_GUIDE.md, a commit message. The gate watches one file;
#   * WHAT was written in the journal. Any change to docs/DECISIONS.md counts
#     as touched, including a typo fix. No gate can judge whether the new text
#     is about the item that closed, and one that tried would be matching
#     spelling again. What this buys is the moment of attention, not the
#     content;
#   * an item deleted rather than closed. Deletion is not a transition to
#     closed, and treating it as one would make tidying the list expensive.
#
# Usage:
#   ./script/check-decisions-log.sh                       — check the edit in hand
#   ./script/check-decisions-log.sh --print               — also list what it saw
#   ./script/check-decisions-log.sh --range A..B          — an explicit range
#   ./script/check-decisions-log.sh --range A..WORKTREE   — a revision vs the disk
#
# Exit codes:
#   0   no item was marked closed in this range, or one was and the journal
#       was written in the same range
#   1   an item was marked closed and docs/DECISIONS.md was left untouched
#   3   the range could not be resolved: the rule is UNVERIFIED, which is not
#       the same as clean
#   127 python3 not found
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
    echo "check-decisions-log: python3 not found" >&2
    exit 127
fi

# No `forge build` and no `npm ci`: this gate reads what git already has, so it
# holds on a bare checkout with the submodules missing.
python3 script/check_decisions_log.py "$@"
