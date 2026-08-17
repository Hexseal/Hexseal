#!/usr/bin/env node
'use strict'

// Pre-flight for `npm run deploy:studio`: the label about to be published must
// name the content about to be published.
//
// WHY THIS EXISTS. v2.4.0 is not a data release. It is the toolchain move on
// its own — graph-cli 0.91 -> 0.98.1, graph-ts 0.35.1 -> 0.38.2 — and it has
// never been run in anger. The owner's decision is two rollouts, not one:
// deploy the toolchain from the tree it was written against, watch it, and only
// then deploy the arbiter accountability content under a label of its own.
// Ship both under v2.4.0 and the first breakage costs a guess about whose fault
// it is, which is exactly the separation the two rollouts were bought with.
//
// Until this file existed that decision lived in prose — a `_note_unreleased`
// key in package.json. Prose does not refuse. Somebody runs the habitual
// command, does not read the note, and the separation is spent silently. This
// check refuses instead, and it refuses on what the tree CONTAINS, not on
// whether the note is still there: delete the note and the refusal is
// unchanged.
//
// HOW IT DECIDES. A reserved label is one that has been promised to a
// particular tree. For each of them RESERVED below records the commit that tree
// is, and the check compares the deployable content of the working tree against
// the content at that commit, read out of git. Same content -> the label is
// honest, deploy. Different content -> refuse and say which files moved.
//
// The expected side is taken from git history and not from a list of ours, so
// the check cannot agree with itself: the recorded digest is verified against
// what git actually holds at that commit, and a disagreement between the two is
// reported as UNVERIFIED rather than resolved in either direction.
//
// WHAT IT DOES NOT GUARD, said plainly:
//   • a label with no entry in RESERVED is not constrained by anything here. It
//     prints a line saying so and exits 0. Raising the label IS the correct fix
//     for a refusal, so the gate has to let a raised label through — but that
//     also means it is silent about a label nobody has thought about.
//   • it does not know which labels Studio already holds. Publishing over a
//     live label is the graph node's business, not this file's.
//   • it guards `npm run deploy:studio`. A bare `graph deploy` typed by hand
//     goes around it, as does any deploy from another checkout.
//
// This check publishes NOTHING. Run it on its own any time:  npm run check:deploy
//
// Exit codes:
//   0  the label matches the tree, or the label is not reserved
//   1  REFUSED: the label is reserved for a different tree
//   3  UNVERIFIED: the check could not run (no git, commit missing, label
//      unparseable, record disagrees with history, manifest points at files
//      this check does not hash). Not the same as "no violations" — a deploy
//      must not proceed on a 3 either, which is why `deploy:studio` chains on
//      `&&`.

const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SUBGRAPH_DIR = path.resolve(__dirname, '..')

// The content a deployment is made of: `graph build` reads exactly these and
// `graph deploy` publishes what comes out. Everything else in this directory —
// tests, this script, package.json itself — changes nothing a consumer of the
// subgraph can observe, so it must not force a label bump. `assertManifestStaysInside`
// below keeps the list from quietly falling behind the manifest.
const CONTENT_ROOTS = ['schema.graphql', 'subgraph.yaml', 'src', 'abis']

const RESERVED = {
  'v2.4.0': {
    commit: 'a02eee9133d795cfc3b4704e21b906b39d692518',
    // sha256 over the deployable content at that commit; recomputed from git on
    // every run and cross-checked against this line. Regenerate with:
    //   node subgraph/scripts/check-deploy-label.js --print-digest <commit>
    digest: 'cdc878c6e8d285aff7b2801899bdfdabdce3b54668c7938d199a5449898b05c0',
    carries:
      'the toolchain move alone: graph-cli 0.91 -> 0.98.1, graph-ts 0.35.1 -> 0.38.2, ' +
      'plus the entity mutability marks the new version demands',
    because:
      'it has never been run in anger. Mixing a new toolchain with new data means ' +
      'guessing whose fault the first breakage is — the owner chose two rollouts ' +
      'so that guess is never needed',
    suggestNext: 'v2.5.0',
  },
}

function fail(code, lines) {
  process.stderr.write(lines.join('\n') + '\n')
  process.exit(code)
}

function git(args, opts) {
  return execFileSync('git', args, Object.assign({ cwd: SUBGRAPH_DIR }, opts))
}

function gitText(args) {
  return git(args, { encoding: 'utf8' }).trim()
}

// ── the label ────────────────────────────────────────────────────────────────

function readDeployLabel(pkg) {
  const script = pkg.scripts && pkg.scripts['deploy:studio']
  if (!script) {
    fail(3, [
      'check-deploy-label: UNVERIFIED — package.json has no "deploy:studio" script.',
      'There is nothing to check the label of, and nothing here can tell whether that is',
      'because the deploy moved somewhere this check does not see.',
    ])
  }
  const hits = []
  const re = /(?:^|\s)(?:-l|--version-label)[=\s]+(\S+)/g
  let m
  while ((m = re.exec(script)) !== null) hits.push(m[1])
  if (hits.length !== 1) {
    fail(3, [
      'check-deploy-label: UNVERIFIED — could not read a single version label out of',
      '"deploy:studio". Found ' + hits.length + ' (' + (hits.join(', ') || 'none') + ').',
      'Script: ' + script,
    ])
  }
  return hits[0]
}

// ── content of the working tree ──────────────────────────────────────────────

function walk(rel, out) {
  const abs = path.join(SUBGRAPH_DIR, rel)
  let st
  try {
    st = fs.statSync(abs)
  } catch (e) {
    return // absent is a legitimate state; it shows up as a missing file in the diff
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, name), out)
  } else if (st.isFile()) {
    out.set(rel, sha256(fs.readFileSync(abs)))
  }
}

function workingTreeContent() {
  const out = new Map()
  for (const root of CONTENT_ROOTS) walk(root, out)
  return out
}

// ── content at a commit, read out of git ─────────────────────────────────────

function commitContent(commit, prefix) {
  // --full-tree, because git resolves pathspecs against the current directory
  // and this script runs from inside the subgraph directory: without it the
  // pathspecs read as subgraph/subgraph/… and match nothing at all. Silently,
  // and an empty match digests to the sha256 of nothing — which is why the
  // emptiness check below is not decoration.
  const paths = CONTENT_ROOTS.map(r => prefix + r)
  let listing
  try {
    listing = gitText(['ls-tree', '-r', '--full-tree', '--name-only', commit, '--'].concat(paths))
  } catch (e) {
    fail(3, [
      'check-deploy-label: UNVERIFIED — git cannot read commit ' + commit.slice(0, 8) + '.',
      'The expected side of this comparison comes from history; without it the check has',
      'nothing to compare against and must not wave a deploy through.',
      String(e.message || e).trim(),
    ])
  }
  const out = new Map()
  for (const p of listing.split('\n').filter(Boolean)) {
    const blob = git(['cat-file', 'blob', commit + ':' + p], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
    out.set(p.slice(prefix.length), sha256(blob))
  }
  if (out.size === 0) {
    fail(3, [
      'check-deploy-label: UNVERIFIED — commit ' + commit.slice(0, 8) + ' holds none of',
      '  ' + CONTENT_ROOTS.join(', ') + '   under ' + (prefix || '<repo root>') + '.',
      'Either the commit is wrong, or the subgraph lived somewhere else then. An empty',
      'match must not be mistaken for an empty deployment: everything would look equal',
      'to everything.',
    ])
  }
  return out
}

// ── digests ──────────────────────────────────────────────────────────────────

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// One hash over "path -> hash of its bytes", in path order. A rename shows up,
// a byte change shows up, and the order of a directory listing cannot.
function digestOf(content) {
  const h = crypto.createHash('sha256')
  for (const rel of Array.from(content.keys()).sort()) {
    h.update(rel, 'utf8')
    h.update('\0')
    h.update(content.get(rel), 'utf8')
    h.update('\n')
  }
  return h.digest('hex')
}

function describeDifference(tree, baseline) {
  const lines = []
  const all = new Set(Array.from(tree.keys()).concat(Array.from(baseline.keys())))
  for (const rel of Array.from(all).sort()) {
    const a = baseline.get(rel)
    const b = tree.get(rel)
    if (a === b) continue
    if (a === undefined) lines.push('    + ' + rel + '   (added since)')
    else if (b === undefined) lines.push('    - ' + rel + '   (gone since)')
    else lines.push('    ~ ' + rel + '   (changed)')
  }
  return lines
}

// ── the list of hashed roots must not fall behind the manifest ───────────────

// Every `file:` in subgraph.yaml has to resolve inside CONTENT_ROOTS, otherwise
// this check is hashing less than the deployment carries and would call a
// changed tree unchanged. Anything unparseable is treated as a violation rather
// than skipped: an unknown path is exactly the case this guard is for.
function assertManifestStaysInside() {
  const manifest = path.join(SUBGRAPH_DIR, 'subgraph.yaml')
  if (!fs.existsSync(manifest)) {
    fail(3, ['check-deploy-label: UNVERIFIED — subgraph.yaml is missing from ' + SUBGRAPH_DIR + '.'])
  }
  const text = fs.readFileSync(manifest, 'utf8')
  const strays = []
  const re = /^\s*(?:-\s*)?file:\s*(.+?)\s*$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    let ref = m[1].replace(/^["']|["']$/g, '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue // an IPFS/http reference, not a file in this tree
    const rel = path.posix.normalize(ref.replace(/^\.\//, ''))
    const inside = CONTENT_ROOTS.some(root => rel === root || rel.startsWith(root + '/'))
    if (!inside) strays.push(rel)
  }
  if (strays.length > 0) {
    fail(3, [
      'check-deploy-label: UNVERIFIED — subgraph.yaml points at files this check does not hash:',
      strays.map(s => '    ' + s).join('\n'),
      '',
      'The comparison would then call a changed deployment unchanged. Add the path to',
      'CONTENT_ROOTS in ' + path.relative(SUBGRAPH_DIR, __filename) + ' and re-record the digests it changes.',
    ])
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2)

  let prefix
  try {
    prefix = gitText(['rev-parse', '--show-prefix'])
  } catch (e) {
    fail(3, [
      'check-deploy-label: UNVERIFIED — this is not a git checkout, or git is not installed.',
      'The tree a reserved label was promised to is named by a commit, and only git can',
      'say what that commit holds.',
    ])
  }

  // Escape hatch for re-recording a digest after CONTENT_ROOTS changes. Prints
  // and exits; deploys nothing, checks nothing.
  if (argv[0] === '--print-digest') {
    const commit = argv[1]
    if (!commit) fail(3, ['usage: check-deploy-label.js --print-digest <commit>'])
    process.stdout.write(digestOf(commitContent(commit, prefix)) + '\n')
    return
  }

  assertManifestStaysInside()

  const pkg = JSON.parse(fs.readFileSync(path.join(SUBGRAPH_DIR, 'package.json'), 'utf8'))
  const label = readDeployLabel(pkg)
  const reserved = RESERVED[label]

  if (!reserved) {
    process.stdout.write(
      'check-deploy-label: label ' +
        label +
        ' is not reserved for any recorded tree — nothing here objects.\n' +
        '  (Reserved labels: ' +
        Object.keys(RESERVED).join(', ') +
        '. This check does not know what Studio already holds.)\n'
    )
    return
  }

  const baseline = commitContent(reserved.commit, prefix)
  const baselineDigest = digestOf(baseline)
  if (reserved.digest !== 'PLACEHOLDER' && reserved.digest !== baselineDigest) {
    fail(3, [
      'check-deploy-label: UNVERIFIED — the digest recorded for ' + label + ' disagrees with git.',
      '  recorded: ' + reserved.digest,
      '  ' + reserved.commit.slice(0, 8) + ':   ' + baselineDigest,
      '',
      'Two sources that were supposed to say the same thing do not. Somebody rewrote history,',
      'edited the record, or changed CONTENT_ROOTS without re-recording. Deploying now would',
      'be deploying on a comparison nobody can vouch for.',
    ])
  }

  const tree = workingTreeContent()
  if (digestOf(tree) === baselineDigest) {
    process.stdout.write(
      'check-deploy-label: ' +
        label +
        ' matches the tree it was promised to (' +
        reserved.commit.slice(0, 8) +
        '). Nothing here objects.\n'
    )
    return
  }

  fail(1, [
    '',
    'check-deploy-label: REFUSED — the tree is ahead of the label.',
    '',
    '  `npm run deploy:studio` would publish label ' + label + ' from this working tree.',
    '',
    '  ' + label + ' carries ' + reserved.carries + ',',
    '  and it is kept on its own because ' + reserved.because + '.',
    '',
    '  This is not that tree. Against ' + reserved.commit.slice(0, 8) + ':',
    describeDifference(tree, baseline).join('\n'),
    '',
    '  What to do:',
    '',
    '    • to ship ' + label + ' — deploy it from the tree it names, not from this one:',
    '        git worktree add ../hexseal-' + label + ' ' + reserved.commit.slice(0, 8),
    '        cd ../hexseal-' + label + '/subgraph && npm ci && npm run deploy:studio',
    '',
    '    • to ship THIS tree — raise the label in package.json ("deploy:studio", the -l',
    '      flag) to ' + reserved.suggestNext + ', and write in _note_deploy what it carries.',
    '      Then this check has nothing reserved to object to.',
    '',
    '  Nothing was published. This check publishes nothing; run it alone with',
    '  `npm run check:deploy`.',
    '',
  ])
}

main()
