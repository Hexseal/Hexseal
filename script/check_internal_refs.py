#!/usr/bin/env python3
"""
Gate: a tracked file must not point at material that is not in git.

Run it through ./script/check-internal-refs.sh (that wrapper checks python3 and
the working directory). Wired into CI as the ninth gate.

---------------------------------------------------------------------------
WHAT IT GUARDS

The repository is public since 14 August 2026. Two directories of working
material are deliberately kept out of it: the design specs and plans, and the
agent's own notes. They are excluded through `.git/info/exclude` and
`.gitignore`, so nothing stops a comment or a document from pointing INTO them.

A pointer like that does two things at once, and both are damage:

  * it is a dead link for every reader — the path resolves to nothing in a
    fresh clone, and the reader cannot tell whether the file was deleted,
    renamed, or never existed;
  * it names a document the reader is not going to get, which tells an outside
    reader the shape of what is being withheld — the date, the subject, and
    sometimes the section number.

The class has now surfaced twice, and both times the manual sweep found some of
the references and missed the rest. That is what this gate is for: the sweep is
the part that must stop being done from memory.

---------------------------------------------------------------------------
WHAT COUNTS AS A REFERENCE

Two kinds, both declared in script/internal-refs.deny with a written reason:

  `path :: <prefix>/`
      Any occurrence of that path in a tracked file, as a whole token. The
      trailing slash is optional in the text: naming the directory without it
      discloses exactly as much.

      Prose that happens to contain the last segment as an ordinary word does
      NOT match — the match is anchored on the whole prefix, so "gives the
      agent superpowers" is not a path and stays green.

  `name :: <regex>`
      A document name in the internal naming convention (a dated markdown
      file) that NO TRACKED FILE carries. This is the same leak without the
      directory: a bare dated `-design.md` name discloses the date and the
      subject of a document the reader cannot open just as loudly as the full
      path to it does, and it is how five of the eight references found on
      21 August 2026 were written.

      The expected side of this comparison — "which names does the repository
      actually contain" — is taken from `git ls-files`, NOT from the text being
      checked. A rule whose expectation is derived from the thing it checks
      agrees with itself forever; this one cannot.

---------------------------------------------------------------------------
A LINE BREAK MUST NOT HIDE A REFERENCE

The reference in relayer/bagStore.js survived the previous sweep for one
reason: it was wrapped. `docs/` ended one line and `// superpowers/specs/...`
began the next, so every grep for the directory name came back clean while the
pointer was intact for a human reader.

So the scan does not work on physical lines. A line that ends mid-path — with a
slash, or with a fragment that is the beginning of a denied path — is joined to
the line that follows it, with the next line's indentation and comment leader
(`//`, `*`, `#`, `--`, `<!--`, `>`) removed first. Up to three lines are joined
this way, and the finding is reported as a line RANGE so the reader can see
that the reference is split.

---------------------------------------------------------------------------
WHAT THE SCANNER COULD NOT READ, IT SAYS OUT LOUD

Two cases, and neither is allowed to pass in silence:

  * A line ends with a fragment of a denied path and joining the lines that
    follow does not produce a whole one. The scanner does not know what that
    is; it may be a reference broken in a way this code does not model. It is
    reported, and it is red.

  * A tracked file does not decode as UTF-8. It is not skipped — skipping is
    exactly how this repository has been burned before: the search wrapper the
    shells here get runs with `-I`, so a file carrying a raw NUL is passed over
    without a word, and a "single source" check stayed green forever. Measured
    on a file whose text plainly contains a withheld path: the wrapper answers
    "no match", /usr/bin/grep finds it, and this gate reports the file as
    unread. Every such file must be named in script/internal-refs.allow with a
    reason, or the gate is red.

The two submodule gitlinks (mode 160000) are not files in this tree and have no
content to read here; they are skipped, and that is the only silent skip.

---------------------------------------------------------------------------
EXCEPTIONS

Some tracked files legitimately name the excluded directories: the `.gitignore`
that excludes one of them, a scanner told not to descend into it, and the two
files of this gate itself. They live in script/internal-refs.allow, each with a
reason in words and a pinned occurrence count.

The count is the part that keeps an exception from becoming a hiding place: an
allowed file that grows a NEW reference changes its count and the gate goes red
on it, instead of covering everything the file will ever say. A count that
drops to zero is red as well — an exception nobody needs any more is a stale
claim about the code, and stale claims are what this repository keeps paying
for.

---------------------------------------------------------------------------
EXIT CODES

  0   no tracked file points at withheld material
  1   one does, or a fragment could not be resolved, or an unreadable file is
      not accounted for, or an exception has drifted or gone stale
  2   script/internal-refs.deny or script/internal-refs.allow is missing, empty
      or damaged — there is nothing to check against, which is not "clean"
  3   the check could not run (not a git work tree, git failed): the rule is
      UNVERIFIED, which is also not "clean"
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

DENY_FILE = "script/internal-refs.deny"
ALLOW_FILE = "script/internal-refs.allow"

MAX_JOIN = 3  # how many following lines a wrapped path may be reassembled from

# Leaders a wrapped line may begin with once its indentation is gone. A path
# broken across two lines of a block comment continues after ` * `, one broken
# in a shell script after `# `, one in markdown quotes after `> `.
LEADER = re.compile(r"^\s*(?:///|//|/\*+|\*/|\*|#+|--|<!--|>)?\s*")


class Damaged(Exception):
    """The deny or allow registry cannot be read as intended."""


# ---------------------------------------------------------------------------
# registries


def _entries(path: str, kinds: tuple[str, ...]) -> list[dict]:
    """Parse a registry file into entries.

    An entry opens with `<kind> :: <key>` at the left margin and continues on
    the indented lines below it. One of those lines must start with `because:`
    and carry a non-empty reason; without it the file is damaged, not lenient.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    except FileNotFoundError:
        raise Damaged(f"{path} is missing")
    except UnicodeDecodeError as exc:
        raise Damaged(f"{path} does not decode as UTF-8: {exc}")

    entries: list[dict] = []
    cur: dict | None = None
    for lineno, line in enumerate(raw.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        head = re.match(r"^([a-z]+)\s*::\s*(.+?)\s*$", line)
        if head and not line[:1].isspace():
            kind, key = head.group(1), head.group(2)
            if kind not in kinds:
                raise Damaged(
                    f"{path}:{lineno}: unknown entry kind {kind!r} "
                    f"(expected one of {', '.join(kinds)})"
                )
            cur = {"kind": kind, "key": key, "line": lineno, "because": "", "occurrences": None}
            entries.append(cur)
            continue
        if cur is None:
            raise Damaged(f"{path}:{lineno}: text before the first entry: {stripped!r}")
        if stripped.startswith("because:"):
            cur["because"] += stripped[len("because:") :].strip() + " "
        elif stripped.startswith("occurrences:"):
            value = stripped[len("occurrences:") :].strip()
            if not value.isdigit():
                raise Damaged(f"{path}:{lineno}: occurrences must be a number, got {value!r}")
            cur["occurrences"] = int(value)
        else:
            cur["because"] += stripped + " "

    if not entries:
        raise Damaged(f"{path} declares no entries")
    for entry in entries:
        if not entry["because"].strip():
            raise Damaged(
                f"{path}:{entry['line']}: entry {entry['key']!r} has no `because:` line. "
                "An entry without a reason in words is not allowed here."
            )
    return entries


def load_deny() -> tuple[list[dict], list[dict]]:
    entries = _entries(DENY_FILE, ("path", "name"))
    paths = [e for e in entries if e["kind"] == "path"]
    names = [e for e in entries if e["kind"] == "name"]
    if not paths:
        raise Damaged(f"{DENY_FILE} declares no `path ::` entry")
    for entry in names:
        try:
            entry["regex"] = re.compile(entry["key"])
        except re.error as exc:
            raise Damaged(f"{DENY_FILE}:{entry['line']}: {entry['key']!r} is not a regex: {exc}")
    for entry in paths:
        prefix = entry["key"].rstrip("/")
        if not prefix:
            raise Damaged(f"{DENY_FILE}:{entry['line']}: empty path")
        entry["prefix"] = prefix
        # The trailing slash is optional in the text, but the token must end
        # there: `.superpowers` matches, `.superpowersomething` does not.
        entry["regex"] = re.compile(re.escape(prefix) + r"(?![\w-])")
    return paths, names


def load_allow() -> list[dict]:
    entries = _entries(ALLOW_FILE, ("file", "unscannable"))
    for entry in entries:
        if entry["kind"] == "file" and entry["occurrences"] is None:
            raise Damaged(
                f"{ALLOW_FILE}:{entry['line']}: entry {entry['key']!r} has no `occurrences:` line. "
                "Without a pinned count the exception would cover every future reference too."
            )
    return entries


# ---------------------------------------------------------------------------
# scanning


def fragments(prefixes: list[str]) -> list[str]:
    """Line endings that look like the beginning of a denied path.

    Only fragments that already reach past the first path segment count, so a
    line ending in the bare word `docs` is not suspicious while one ending in
    `docs/superpow` is. For a one-segment path (`.superpowers`) four characters
    are enough — nothing else in this repository ends in `.sup`.
    """
    out: set[str] = set()
    for prefix in prefixes:
        for i in range(4, len(prefix)):
            frag = prefix[:i]
            if frag.endswith("/"):
                continue
            if "/" in prefix and "/" not in frag:
                continue
            out.add(frag)
    return sorted(out, key=len, reverse=True)


def fragment_tail(frags: list[str]) -> re.Pattern:
    """One end-anchored regex for all fragments — this runs on every line of
    every tracked file, lock files included, so it is not a loop."""
    if not frags:
        return re.compile(r"(?!)")
    return re.compile("(" + "|".join(re.escape(f) for f in frags) + ")$")


def windows(text: str, tail_re: re.Pattern) -> list[tuple[int, int, str, str]]:
    """Physical lines, with wrapped paths reassembled.

    Returns (first line, last line, text, dangling fragment) tuples covering
    every line exactly once. A line that ends mid-path pulls the following
    lines in, so a path broken by a line break is read as one string.

    The fourth element is what the scanner tried to complete and could not: a
    line ended with the beginning of a denied path, the lines after it were
    pulled in, and the result still is not a path. It has to be carried out of
    here rather than recomputed from the joined text — the joined text ends
    with whatever the CONTINUATION happened to end with, so asking it about the
    fragment gets the wrong answer, and the wrong answer is silence.
    """
    lines = text.split("\n")
    out: list[tuple[int, int, str, str]] = []
    i = 0
    while i < len(lines):
        joined = lines[i].rstrip()
        last = i
        dangling = ""
        while True:
            tail = joined.rstrip()
            match = tail_re.search(tail)
            if match:
                dangling = match.group(0)
            if not (tail.endswith("/") or match):
                break
            if last - i >= MAX_JOIN or last + 1 >= len(lines):
                break
            joined = tail + LEADER.sub("", lines[last + 1]).rstrip()
            last += 1
        out.append((i + 1, last + 1, joined, dangling))
        i = last + 1
    return out


def tracked() -> list[tuple[str, str]]:
    """(mode, path) for everything git has, in this tree."""
    proc = subprocess.run(
        ["git", "ls-files", "-sz"], capture_output=True, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace").strip() or "git ls-files failed")
    out = []
    for record in proc.stdout.split(b"\0"):
        if not record:
            continue
        meta, _, path = record.decode("utf-8", "surrogateescape").partition("\t")
        out.append((meta.split()[0], path))
    return out


def scan() -> int:
    try:
        deny_paths, deny_names = load_deny()
        allow = load_allow()
    except Damaged as exc:
        print(f"check-internal-refs: {exc}", file=sys.stderr)
        return 2

    try:
        files = tracked()
    except RuntimeError as exc:
        print(f"check-internal-refs: {exc} — the rule is NOT checked", file=sys.stderr)
        return 3

    tracked_paths = {path for mode, path in files if mode != "160000"}
    tracked_names = {os.path.basename(p) for p in tracked_paths}
    frags = fragments([e["prefix"] for e in deny_paths])
    tail_re = fragment_tail(frags)

    allowed_files = {e["key"]: e for e in allow if e["kind"] == "file"}
    allowed_unscannable = {e["key"]: e for e in allow if e["kind"] == "unscannable"}

    findings: list[tuple[str, str]] = []   # (path, message) — real violations
    counted: dict[str, int] = {}           # path -> occurrences, allowed files
    unscannable: list[tuple[str, str]] = []

    # A deny entry that has become tracked is a lie about the repository: the
    # material is published, and the entry would keep hiding honest links.
    for entry in deny_paths:
        prefix = entry["prefix"]
        if any(p == prefix or p.startswith(prefix + "/") for p in tracked_paths):
            findings.append(
                (DENY_FILE, f"line {entry['line']}: `{entry['key']}` IS tracked now — "
                            "the entry is stale, remove it or stop committing that path")
            )

    for mode, path in files:
        if mode == "160000":
            continue  # submodule gitlink: no content in this tree to read
        try:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
        except (UnicodeDecodeError, OSError) as exc:
            unscannable.append((path, f"{type(exc).__name__}: {exc}"))
            continue

        hits: list[str] = []
        for first, last, line, dangling in windows(text, tail_re):
            where = f"line {first}" if first == last else f"lines {first}-{last}"
            found_here = False
            for entry in deny_paths:
                for match in entry["regex"].finditer(line):
                    found_here = True
                    hits.append(f"{where}: path into withheld material: {match.group(0)}")
            for entry in deny_names:
                for match in entry["regex"].finditer(line):
                    name = match.group(0)
                    if name in tracked_names:
                        continue
                    found_here = True
                    hits.append(
                        f"{where}: names a document that is not in git: {name}"
                    )
            if not found_here and dangling:
                hits.append(
                    f"{where}: ends with `{dangling}` and the lines after it do not "
                    "complete a path — the scanner could not read this, so it says so "
                    "instead of passing"
                )

        if not hits:
            continue
        if path in allowed_files:
            counted[path] = len(hits)
            continue
        findings.extend((path, hit) for hit in hits)

    # Exceptions that drifted or went stale.
    for path, entry in allowed_files.items():
        if path not in tracked_paths:
            findings.append((ALLOW_FILE, f"line {entry['line']}: `{path}` is not tracked any more"))
            continue
        actual = counted.get(path, 0)
        if actual != entry["occurrences"]:
            if actual == 0:
                findings.append(
                    (ALLOW_FILE, f"line {entry['line']}: `{path}` no longer names withheld "
                                 "material — the exception is stale, delete it")
                )
            else:
                findings.append(
                    (ALLOW_FILE, f"line {entry['line']}: `{path}` has {actual} reference(s), "
                                 f"the entry pins {entry['occurrences']} — read the new one "
                                 "and update the count on purpose")
                )

    for path, why in unscannable:
        if path in allowed_unscannable:
            continue
        findings.append(
            (path, f"cannot be read as text ({why}) — the scan did NOT cover it. "
                   f"Name it in {ALLOW_FILE} with a reason.")
        )
    for path, entry in allowed_unscannable.items():
        if path not in tracked_paths:
            findings.append((ALLOW_FILE, f"line {entry['line']}: `{path}` is not tracked any more"))
        elif not any(p == path for p, _ in unscannable):
            findings.append(
                (ALLOW_FILE, f"line {entry['line']}: `{path}` reads as text now — "
                             "the exception is stale, delete it")
            )

    if "--print" in sys.argv[1:]:
        for path in sorted(counted):
            print(f"allowed  {path}: {counted[path]} reference(s)")
        for path, _ in sorted(unscannable):
            state = "allowed" if path in allowed_unscannable else "UNACCOUNTED"
            print(f"{state}  {path}: unreadable as text")

    if findings:
        print("check-internal-refs: a tracked file points at material that is not in git.\n")
        for path, message in sorted(findings):
            print(f"  {path}: {message}")
        print(
            "\nDo not delete the thought with the link. Replace the pointer with the "
            "property it stood for — what was decided, by whom, and when — so the reader "
            "does not need the file that is not there."
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(scan())
