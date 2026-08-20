#!/usr/bin/env python3
"""Text search that is honest about two traps this project has paid for twice.

WHY THIS EXISTS. Two separate defects bit us, and each defence breaks the other:

  1. `grep` here is ugrep with `-I`: a file holding a raw NUL byte is skipped
     IN SILENCE, so "nothing found" reads as clean when the file was never
     opened. The known cure is `LC_ALL=C command grep -a`.

  2. `LC_ALL=C` makes a character class match BYTES, not characters. Under it
     `[A-Яa-я]` matches pieces of unrelated multi-byte characters — an em dash,
     an arrow, a warning sign. Measured 20 August 2026: counting Cyrillic
     commit subjects gave 28 by bytes and 9 by codepoints, and the first run
     reported Cyrillic inside an all-English commit. It was the dash.

So the cure for (1) causes (2). The rule that follows is narrow, and stating it
is the whole point of this file:

    `LC_ALL=C command grep -a` stays CORRECT for LITERAL strings.
    For a CHARACTER CLASS it is WRONG. Use this script instead.

The trap caught the coordinator and, ten minutes later and holding an explicit
warning about it, the implementer. A warning is not a defence — a tool is.

USAGE
    script/textgrep.py PATTERN PATH [PATH ...]      # print path:line:text
    script/textgrep.py --count PATTERN PATH [...]   # print one count per path
    script/textgrep.py --cyrillic PATH [...]        # lines carrying Cyrillic
    script/textgrep.py --stdin PATTERN              # filter stdin (e.g. a diff)

PATTERN is a Python regular expression over CHARACTERS, so `[Ѐ-ӿ]`
means Cyrillic and nothing else.

Directories are walked. `.git`, `node_modules`, `out`, `cache`, `lib` and
`broadcast` are skipped — say `--all` to include them.

WHAT IT REFUSES TO DO QUIETLY. Every file it cannot decode or read is reported
on stderr and counted; the exit code is 2 if any file was skipped, so a sweep
can never look complete when it was not. That is the same failure mode as (1),
and it is closed here by construction rather than by remembering.
"""

import argparse
import os
import re
import sys

SKIP_DIRS = {".git", "node_modules", "out", "cache", "lib", "broadcast", ".superpowers"}
CYRILLIC = r"[Ѐ-ӿԀ-ԯ]"


def walk(paths, include_all):
    for p in paths:
        if os.path.isfile(p):
            yield p
            continue
        for root, dirs, files in os.walk(p):
            if not include_all:
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for f in sorted(files):
                yield os.path.join(root, f)


def scan_file(path, rx):
    """Return (matches, skipped_reason). Never raises, never skips in silence."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        return [], f"unreadable: {exc}"
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        # Not silent: the caller reports it and the exit code carries it.
        return [], "not valid UTF-8"
    hits = []
    for n, line in enumerate(text.split("\n"), 1):
        if rx.search(line):
            hits.append((n, line))
    return hits, None


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--count", action="store_true", help="print counts, not lines")
    ap.add_argument("--cyrillic", action="store_true", help="pattern is Cyrillic")
    ap.add_argument("--stdin", action="store_true", help="read text from stdin")
    ap.add_argument("--all", action="store_true", help="do not skip build dirs")
    ap.add_argument("pattern", nargs="?")
    ap.add_argument("paths", nargs="*")
    args = ap.parse_args()

    if args.cyrillic:
        pattern = CYRILLIC
        paths = ([args.pattern] if args.pattern else []) + args.paths
    else:
        pattern = args.pattern
        paths = args.paths
    if not pattern:
        ap.error("no pattern (use --cyrillic or give one)")

    rx = re.compile(pattern)

    if args.stdin:
        total = 0
        for n, line in enumerate(sys.stdin.buffer.read().decode("utf-8", "replace").split("\n"), 1):
            if rx.search(line):
                total += 1
                if not args.count:
                    print(f"{n}:{line}")
        if args.count:
            print(total)
        return 0

    if not paths:
        ap.error("no paths")

    skipped = 0
    grand = 0
    for path in walk(paths, args.all):
        hits, reason = scan_file(path, rx)
        if reason:
            print(f"SKIPPED {path}: {reason}", file=sys.stderr)
            skipped += 1
            continue
        grand += len(hits)
        if args.count:
            if hits:
                print(f"{len(hits)}\t{path}")
        else:
            for n, line in hits:
                print(f"{path}:{n}:{line}")

    if args.count:
        # TOTAL goes to stdout on purpose: a gate reads it, and a number that
        # only exists on stderr is a number nobody checks.
        print(f"{grand}\tTOTAL")
    if skipped:
        print(f"{skipped} file(s) skipped — this sweep is INCOMPLETE", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
