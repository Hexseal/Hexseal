#!/usr/bin/env python3
"""
Gate: an item marked closed in the debt list must come with a line in the
decision journal.

Run it through ./script/check-decisions-log.sh (that wrapper checks python3 and
the working directory). Wired into CI as the tenth gate.

---------------------------------------------------------------------------
WHAT IT GUARDS

`docs/OPEN-ITEMS.md` records what is known and not done. `docs/DECISIONS.md`
records what was decided and why. The first answers "what was wrong", the
second answers "why we did it this way, and what we turned down".

Closing an item is exactly the moment the second file has something to gain:
a hole is closed BECAUSE somebody chose one way over another. If the choice is
written down nowhere, it survives only in the head of whoever made it, and
everyone outside — an auditor, a reviewer, anybody reading the public
repository — is left with a commit message, which is a record of work and not
a record of meaning.

The rule is deliberately narrow: it does not demand a journal entry for every
edit, only for the edit that marks a debt closed.

---------------------------------------------------------------------------
THE COMPARISON IS A DIFF, NOT A STATE

A gate that looked at the state ("there are 17 closed items and the journal
has 33 sections") would have to invent a correspondence between two lists that
are numbered independently, and it would be red on arrival for every item
closed before the journal existed. Neither is a rule anybody keeps.

So the gate reads `docs/OPEN-ITEMS.md` at TWO revisions and compares the
closure state of every item between them. An item that was not closed at the
base and is closed at the head is a NEW closure, and it is that transition —
nothing else — that requires `docs/DECISIONS.md` to have been touched in the
same range.

This also disposes of the moved-text problem: a closed item that is merely
renumbered, reordered or reworded produces a `+` line carrying a closure mark,
but no transition, so the gate stays quiet. A line-level scan of the diff
would have gone red on it.

---------------------------------------------------------------------------
HOW THE RANGE IS CHOSEN

The gate runs in two places with two different notions of "the edit", so the
range is resolved in a fixed order and the chosen range is always printed:

  1. `--range <base>..<head>` on the command line. `<head>` may be the literal
     token WORKTREE, meaning the files as they are on disk right now.
  2. the same syntax in the environment variable DECISIONS_RANGE.
  3. GitHub Actions: read the event payload named by GITHUB_EVENT_PATH.
     A pull request compares its base sha with its head sha; a push compares
     `before` with `after`.
  4. a local run where either of the two files differs from HEAD on disk:
     HEAD..WORKTREE — the edit in hand, which is what somebody running the gate
     before committing means by "my change".
  5. a local run where neither does: HEAD~1..HEAD — the last commit, which is
     what somebody running the gate after committing means.

  A push event whose `before` is all zeros — a branch that did not exist —
  names no base, so it falls through to rules 4 and 5 rather than failing.

If none of these resolves — a shallow clone where the base commit is absent,
a first commit with no parent, a push event whose `before` is all zeros and
whose head has no parent — the gate exits 3 and says so. Three is not zero on
purpose: "the rule could not be checked" is not the same claim as "the rule
holds", and this repository has paid for that confusion before.

CI therefore needs history. The checkout step of the `contracts` job carries
`fetch-depth: 0` for this gate and for nothing else; with the default depth of
one commit, the base of the range is simply not in the clone and every run
would exit 3.

---------------------------------------------------------------------------
WHAT COUNTS AS A CLOSURE MARK

Not one spelling. A scanner that recognises `✅ ЗАКРЫТ` and nothing else is a
scanner that recognises SPELLING rather than meaning, and the same debt list
already carries three other forms. As of 2026-08-22 the file holds 112 level-2
headings, of which:

    17  `✅ ЗАКРЫТ`            the canonical form
     2  `⚠️ ЧАСТИЧНО ЗАКРЫТ`   a partial closure — still a decision
     2  `СНЯТ`                 withdrawn, plus a struck-through title
     2  `✅ ЗАКРЫТО`           on level-3 sub-items

So a heading is read as closed when, after the item number is stripped, any of
these holds:

  * it carries one of the closure WORDS as a whole word in capitals —
    ЗАКРЫТ/ЗАКРЫТО/ЗАКРЫТА/ЗАКРЫТЫ, СНЯТ/СНЯТО/СНЯТА/СНЯТЫ,
    РЕШЁН/РЕШЕН/РЕШЕНО, ОТКЛОНЁН/ОТКЛОНЕН/ОТКЛОНЕНО, ОТВЕРГНУТ/ОТВЕРГНУТО.
    Capitals matter: the same words in running prose inside a title
    ("пункт закрыт частично") are not a mark, and treating them as one would
    make the gate fire on wording;
  * it carries the ✅ sign;
  * its title opens with a struck-through span (`~~…~~`), which is how a
    withdrawn item is written in markdown even when no word is added.

A word preceded by НЕ or ЕЩЁ НЕ is not a mark. "НЕ ЗАКРЫТ" is the opposite
statement, and a scanner that reads it as closure would be worse than no
scanner.

WHAT THIS DELIBERATELY DOES NOT CATCH is written out in the header of
script/check-decisions-log.sh, where somebody deciding whether to trust the
gate will look for it.

---------------------------------------------------------------------------
WHAT "THE JOURNAL WAS TOUCHED" MEANS

That `docs/DECISIONS.md` differs between the two ends of the range — including
the case where it appears for the first time. It does NOT mean that the new
text is about the item that was closed; no gate can judge that, and one that
pretended to would be checking spelling again. What it buys is the moment of
attention: closing an item without opening the journal is now impossible by
accident, and doing it on purpose takes a sentence.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

OPEN_ITEMS = "docs/OPEN-ITEMS.md"
DECISIONS = "docs/DECISIONS.md"

WORKTREE = "WORKTREE"

# ── the closure vocabulary ───────────────────────────────────────────────────
#
# Capitals only, whole word. See the docstring for why the list is written out
# by hand rather than derived from what the file happens to contain today: a
# list derived from the checked file would agree with that file forever.
CLOSURE_WORDS = (
    "ЗАКРЫТЫ", "ЗАКРЫТО", "ЗАКРЫТА", "ЗАКРЫТ",
    "СНЯТЫ", "СНЯТО", "СНЯТА", "СНЯТ",
    "РЕШЕНО", "РЕШЁНО", "РЕШЕН", "РЕШЁН",
    "ОТКЛОНЕНО", "ОТКЛОНЁНО", "ОТКЛОНЕН", "ОТКЛОНЁН",
    "ОТВЕРГНУТО", "ОТВЕРГНУТ",
)

CLOSURE_WORD_RE = re.compile(
    r"(?<![А-ЯЁA-Z\w])(?P<neg>НЕ\s+|ЕЩЁ\s+НЕ\s+|ЕЩЕ\s+НЕ\s+)?"
    r"(?P<word>" + "|".join(CLOSURE_WORDS) + r")(?![А-ЯЁа-яёA-Za-z\w])"
)

CHECKMARK = "✅"

HEADING_RE = re.compile(r"^(?P<hashes>##+)\s+(?P<title>.*?)\s*$")
NUMBER_RE = re.compile(r"^(?P<num>\d+(?:\.\d+)*)[.)]?\s+")
STRUCK_RE = re.compile(r"^~~.+?~~")


class Unresolvable(Exception):
    """The range could not be worked out, so the rule is UNVERIFIED."""


# ── git plumbing ─────────────────────────────────────────────────────────────

def git(*args: str) -> str:
    out = subprocess.run(
        ("git",) + args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if out.returncode != 0:
        raise Unresolvable(
            "git " + " ".join(args) + ": " + out.stderr.decode("utf-8", "replace").strip()
        )
    return out.stdout.decode("utf-8", "replace")


def rev_exists(rev: str) -> bool:
    if rev == WORKTREE:
        return True
    return subprocess.run(
        ("git", "cat-file", "-e", rev + "^{commit}"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def read_at(rev: str, path: str) -> str | None:
    """File content at a revision, or None when the file is not there."""
    if rev == WORKTREE:
        try:
            with open(path, encoding="utf-8") as fh:
                return fh.read()
        except FileNotFoundError:
            return None
    out = subprocess.run(
        ("git", "show", f"{rev}:{path}"),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if out.returncode != 0:
        return None
    return out.stdout.decode("utf-8", "replace")


# ── range resolution ─────────────────────────────────────────────────────────

def parse_range(spec: str, source: str) -> tuple[str, str]:
    if ".." not in spec:
        raise Unresolvable(
            f"{source}: expected <base>..<head>, got {spec!r}"
        )
    base, _, head = spec.partition("..")
    base, head = base.strip(), head.strip()
    if not base or not head:
        raise Unresolvable(f"{source}: both ends must be named, got {spec!r}")
    for rev in (base, head):
        if not rev_exists(rev):
            raise Unresolvable(
                f"{source}: revision {rev!r} is not in this clone "
                f"(a shallow checkout will do that)"
            )
    return base, head


def range_from_github() -> tuple[str, str, str] | None:
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            event = json.load(fh)
    except (OSError, ValueError) as exc:
        raise Unresolvable(f"GITHUB_EVENT_PATH is unreadable: {exc}")

    pr = event.get("pull_request")
    if isinstance(pr, dict):
        base = (pr.get("base") or {}).get("sha")
        head = (pr.get("head") or {}).get("sha")
        if base and head:
            for rev, side in ((base, "base"), (head, "head")):
                if not rev_exists(rev):
                    raise Unresolvable(
                        f"pull request {side} commit {rev[:12]} is not in this clone — "
                        f"the checkout needs fetch-depth: 0"
                    )
            return base, head, "pull request event"

    before, after = event.get("before"), event.get("after")
    if before and after and set(before) != {"0"}:
        for rev, side in ((before, "before"), (after, "after")):
            if not rev_exists(rev):
                raise Unresolvable(
                    f"push event {side} commit {rev[:12]} is not in this clone — "
                    f"the checkout needs fetch-depth: 0"
                )
        return before, after, "push event"

    return None


def resolve_range(argv_range: str | None) -> tuple[str, str, str]:
    if argv_range:
        base, head = parse_range(argv_range, "--range")
        return base, head, "--range"

    env_range = os.environ.get("DECISIONS_RANGE")
    if env_range:
        base, head = parse_range(env_range, "DECISIONS_RANGE")
        return base, head, "DECISIONS_RANGE"

    from_ci = range_from_github()
    if from_ci:
        return from_ci

    if not rev_exists("HEAD"):
        raise Unresolvable("this repository has no HEAD yet")

    # Only the two files this gate reads decide between rule 4 and rule 5.
    # `git status` over the whole tree would answer "dirty" for any stray
    # untracked file, and then a closure that was just COMMITTED would be
    # compared against the disk, where it is no longer a change — green for the
    # wrong reason. Limiting the question to these two paths also keeps the
    # brand-new, still-untracked journal visible: `--porcelain` reports it.
    dirty = git(
        "status", "--porcelain", "--", OPEN_ITEMS, DECISIONS
    ).strip()
    if dirty:
        return "HEAD", WORKTREE, "local run, the two files differ from HEAD"

    if not rev_exists("HEAD~1"):
        raise Unresolvable(
            "the tree is clean and HEAD has no parent, so there is no edit to compare"
        )
    return "HEAD~1", "HEAD", "local run, the two files match HEAD"


# ── the debt list ────────────────────────────────────────────────────────────

def is_closed(title: str) -> bool:
    if CHECKMARK in title:
        return True
    if STRUCK_RE.match(title):
        return True
    for m in CLOSURE_WORD_RE.finditer(title):
        if m.group("neg"):
            continue
        return True
    return False


def parse_items(text: str | None) -> dict[str, tuple[bool, str]]:
    """heading key -> (closed, title as written)."""
    if text is None:
        return {}
    items: dict[str, tuple[bool, str]] = {}
    in_fence = False
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING_RE.match(line)
        if not m:
            continue
        title = m.group("title")
        num = NUMBER_RE.match(title)
        if num:
            key = "num:" + num.group("num")
            body = title[num.end():]
        else:
            # No number: key off the wording, with the closure marks taken out
            # so that ADDING a mark is a transition and not a new item.
            body = title
            key = "text:" + normalise(title)
        items[key] = (is_closed(body), title)
    return items


def normalise(title: str) -> str:
    without_marks = CLOSURE_WORD_RE.sub(" ", title.replace(CHECKMARK, " "))
    without_marks = without_marks.replace("~~", " ").replace("⚠️", " ")
    return " ".join(without_marks.lower().split())


def short(title: str, width: int = 96) -> str:
    one_line = " ".join(title.split())
    if len(one_line) <= width:
        return one_line
    return one_line[: width - 1] + "…"


# ── the check ────────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    argv_range = None
    want_print = False
    rest = list(argv[1:])
    while rest:
        arg = rest.pop(0)
        if arg == "--range":
            if not rest:
                print("check-decisions-log: --range needs <base>..<head>", file=sys.stderr)
                return 3
            argv_range = rest.pop(0)
        elif arg.startswith("--range="):
            argv_range = arg.split("=", 1)[1]
        elif arg == "--print":
            want_print = True
        elif arg in ("-h", "--help"):
            print(__doc__)
            return 0
        else:
            print(f"check-decisions-log: unknown argument {arg!r}", file=sys.stderr)
            return 3

    try:
        base, head, how = resolve_range(argv_range)
    except Unresolvable as exc:
        print(f"check-decisions-log: UNVERIFIED — {exc}", file=sys.stderr)
        print(
            "check-decisions-log: this is not the same as clean; "
            "name a range with --range <base>..<head>",
            file=sys.stderr,
        )
        return 3

    print(f"check-decisions-log: range {base}..{head} ({how})")

    before = parse_items(read_at(base, OPEN_ITEMS))
    after = parse_items(read_at(head, OPEN_ITEMS))

    newly_closed = []
    for key, (closed, title) in after.items():
        if not closed:
            continue
        was = before.get(key)
        if was is None or not was[0]:
            newly_closed.append((key, title))

    journal_before = read_at(base, DECISIONS)
    journal_after = read_at(head, DECISIONS)
    journal_touched = journal_before != journal_after

    if want_print:
        closed_now = sum(1 for closed, _ in after.values() if closed)
        print(
            f"check-decisions-log: {len(after)} headings at head, "
            f"{closed_now} of them read as closed"
        )
        print(
            "check-decisions-log: journal "
            + ("changed" if journal_touched else "unchanged")
            + " in this range"
            + ("" if journal_after is not None else " (and absent at head)")
        )
        for key, title in newly_closed:
            print(f"    newly closed: {key}  {short(title)}")

    if not newly_closed:
        print("check-decisions-log: no item was marked closed in this range — nothing to require")
        return 0

    if journal_touched:
        print(
            f"check-decisions-log: {len(newly_closed)} item(s) marked closed, "
            f"and {DECISIONS} was written in the same range"
        )
        return 0

    sys.stdout.flush()
    print("", file=sys.stderr)
    print(
        f"check-decisions-log: {len(newly_closed)} item(s) marked closed in {OPEN_ITEMS} "
        f"while {DECISIONS} was left untouched:",
        file=sys.stderr,
    )
    for key, title in newly_closed:
        label = key.split(":", 1)[1]
        prefix = f"п. {label}" if key.startswith("num:") else "раздел"
        print(f"    {prefix} — {short(title)}", file=sys.stderr)
    print("", file=sys.stderr)
    print(
        "Closing a debt means a choice was made. Write it down in "
        f"{DECISIONS}: what was decided, why, what was turned down. "
        "A commit message records the work, not the reason.",
        file=sys.stderr,
    )
    if journal_after is None:
        print(f"({DECISIONS} does not exist at {head} at all.)", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
