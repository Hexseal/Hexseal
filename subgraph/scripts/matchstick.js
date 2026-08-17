#!/usr/bin/env node
'use strict'

// Runs the matchstick test binary over ./tests.  `npm test`.
//
// WHY NOT `graph test`. graph-cli ships its own launcher for exactly this, and
// on this machine it refuses:
//
//     $ graph test
//     Error: Failed to get matchstick binary: Unsupported platform: Linux x64 18
//
// It reads NAME/VERSION out of /etc/*-release and matches the number against a
// table of Ubuntu releases. The workstation runs Zorin OS 18.1, whose VERSION_ID
// is 18 and whose base is Ubuntu 24.04 (UBUNTU_CODENAME=noble) — so the number
// it compares is the distribution's own, and 18 is in the table as *Ubuntu* 18,
// which matchstick 0.6.0 has no build for. The binary it would have chosen for
// Ubuntu 24 is binary-linux-22, and that one runs here without complaint. So
// this launcher does the same job with the derivative case understood: it looks
// at UBUNTU_CODENAME before VERSION_ID, because on every Ubuntu derivative the
// codename is the truthful field.
//
// Everything else is the same shape as graph-cli's: download once, cache, spawn,
// pass the exit code through.
//
// Usage:
//   npm test                  all tests
//   npm test -- -r            force recompile (after changing generated/)
//   npm test -- -c            coverage
//   npm test -- <name>        a single test file, by name without .test.ts
//
// Escape hatches:
//   MATCHSTICK_BINARY=/path   use this binary, download nothing (air-gapped CI)
//   MATCHSTICK_PLATFORM=…     override the platform guess (binary-linux-22, …)
//   MATCHSTICK_CACHE_DIR=…    where to keep the downloaded binary
//
// None of them skips the digest check below — a binary handed over in
// MATCHSTICK_BINARY is checked exactly like a downloaded one.
//
// The binary is cached under node_modules/.cache/ by default, which is already
// ignored by git and thrown away by `rm -rf node_modules` like any other build
// tool. `npm ci` wipes node_modules too, so a CI job that wants to keep the
// 27 MB download between runs should point MATCHSTICK_CACHE_DIR somewhere it
// caches — the whole directory is content-addressed by version and platform.

const { execFileSync, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SUBGRAPH_DIR = path.resolve(__dirname, '..')

function die(lines) {
  process.stderr.write(lines.join('\n') + '\n')
  process.exit(1)
}

// The binary and the AssemblyScript library have to be the same version — they
// are two halves of one tool and the library's assertions call into the
// binary's host functions.
//
// The number comes from the library that is actually installed, not from the
// range written in package.json. The range is a request; node_modules is the
// answer, and they are allowed to differ: "^0.6.0" is satisfied by 0.6.1, so
// reading the request would have this launcher fetch and check the 0.6.0 binary
// while the tests compile against a 0.6.1 library — two halves of different
// tools, and nothing anywhere would say so out loud. Reading what is installed
// makes that impossible by construction: the pair moves together or the run
// stops at an unpinned version.
//
// Not being installed is a refusal, not a fallback to the range. A guess about
// which library is present is exactly the thing this function exists to stop.
function installedVersion() {
  let pkgPath
  try {
    pkgPath = require.resolve('matchstick-as/package.json', { paths: [SUBGRAPH_DIR] })
  } catch (e) {
    // Two different problems with two different fixes: nobody asked for the
    // library, or somebody asked and it was never installed.
    let declared
    try {
      const own = JSON.parse(fs.readFileSync(path.join(SUBGRAPH_DIR, 'package.json'), 'utf8'))
      declared = (own.devDependencies || {})['matchstick-as'] || (own.dependencies || {})['matchstick-as']
    } catch (_) {}
    if (!declared) {
      die([
        'matchstick: package.json has no dependency on matchstick-as.',
        'The test library and the test binary are versioned together; without the library',
        'there is nothing for the binary to run, and no version to look a binary up by.',
      ])
    }
    die([
      'matchstick: matchstick-as is declared (' + declared + ') but not installed.',
      '',
      'This launcher takes the binary version from the library that is actually in',
      'node_modules, because the range in package.json is a request and not an answer.',
      'With nothing installed there is nothing to read, and guessing from the range is',
      'the mistake this check exists to prevent.',
      '',
      '  cd ' + SUBGRAPH_DIR + ' && npm ci',
    ])
  }
  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
  if (!version) die(['matchstick: ' + pkgPath + ' has no version field.'])
  // Whatever this string turns out to be, it is looked up in PINNED_SHA256
  // before it is ever put in a download URL — an unexpected version stops at
  // the pin, it does not become a request to GitHub.
  return version
}

// ---------------------------------------------------------------------------
// Pinned digests, keyed by the version above and the release asset name.
//
// READ THIS BEFORE TRUSTING IT. This is trust on first use, not verification.
// LimeChain publishes no checksums for matchstick: release 0.6.0 carries the
// three binaries and nothing else — no SHA256SUMS file, no signature, nothing
// to compare against. So there is no upstream statement here. What is written
// below is the digest of the file *we* were served, computed by hand on
// 17 August 2026 on the workstation, and pinned as-is.
//
// What that buys: if the release asset is ever swapped — by the author, by
// someone who takes the account, by anything between us and GitHub — the next
// run on any machine stops instead of executing the new file, and a CI job
// that has thrown its cache away stops too.
//
// What it does not buy: any evidence that what we were served on the first day
// is what the author built. If the file was already substituted before we ever
// downloaded it, this table pins the substitution and every run goes green.
//
// So a passing run does NOT mean "the binary is verified". It means "the binary
// is byte-for-byte the one we got on 17 August 2026". Nothing more.
//
// There is deliberately no skip switch. A mismatch is a refusal, including for
// a binary handed over in MATCHSTICK_BINARY. If a different binary is genuinely
// wanted, the digest below has to be edited — a visible line in a diff that a
// reviewer can question — rather than an env var nobody sees.
// ---------------------------------------------------------------------------
const PINNED_SHA256 = {
  '0.6.0': {
    'binary-linux-22': 'e11131536716f2a6daaa242beb7c3f89784017ba2a73128fcf80027296e80c85',
    // binary-macos-12 and binary-macos-12-m1 are deliberately absent. We have
    // never downloaded them, so any number written here would be copied from
    // somewhere rather than measured, and a digest nobody computed is worse
    // than no digest: it looks like a check. A mac therefore gets a refusal
    // that says why and says how to end it (download once, compute, pin,
    // commit) instead of a check that is really a guess.
  },
}

function pinnedDigest(version, platform) {
  const forVersion = PINNED_SHA256[version]
  if (!forVersion) {
    die([
      'matchstick: no pinned digest for version ' + version + '.',
      '',
      'The matchstick-as installed in node_modules is ' + version + ', and this launcher only',
      'runs a binary whose sha256 was written down for that exact version. Moving the',
      'library — a bump, or a range that resolved somewhere new — means pinning the',
      'matching binary too:',
      '',
      '  curl -sSL --fail -o /tmp/' + platform +
        ' https://github.com/LimeChain/matchstick/releases/download/' + version + '/' + platform,
      '  sha256sum /tmp/' + platform,
      '',
      "then add the number to PINNED_SHA256 in this file, under '" + version + "'.",
    ])
  }
  const digest = forVersion[platform]
  if (!digest) {
    die([
      'matchstick: no pinned digest for ' + platform + ' at version ' + version + '.',
      '',
      'Only ' + Object.keys(forVersion).join(', ') + ' has a digest recorded, because that is',
      'the only release asset this project has ever downloaded. The macOS builds have',
      'never been fetched here, so there is no measured number for them — and writing an',
      'unmeasured one would turn this check into theatre.',
      '',
      'To run on this platform, pin it once, deliberately:',
      '  curl -sSL --fail -o /tmp/' + platform +
        ' https://github.com/LimeChain/matchstick/releases/download/' + version + '/' + platform,
      '  sha256sum /tmp/' + platform,
      "then add the number to PINNED_SHA256 in this file under '" + version + "' and commit it,",
      'so everyone else is checking against the same file you were served.',
    ])
  }
  return digest
}

function sha256File(file) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

// Refuses unless `file` hashes to `expected`. `onMismatch` gets to clean up
// (delete a half-downloaded file) before the message is printed; a file already
// in place is left alone on purpose — deleting it would destroy the evidence
// and let the very next run re-download and go green as if nothing happened.
function requireDigest(file, expected, whatItIs, extraLines, onMismatch) {
  const actual = sha256File(file)
  if (actual === expected) return
  if (onMismatch) onMismatch()
  die(
    [
      'matchstick: REFUSING TO RUN — ' + whatItIs + ' does not match the pinned digest.',
      '',
      '  file:     ' + file,
      '  expected: ' + expected,
      '  actual:   ' + actual,
      '',
    ]
      .concat(extraLines)
      .concat([
        '',
        'This launcher runs no binary it cannot recognise, and has no flag to make it.',
        'If the change is intended, edit PINNED_SHA256 in ' + path.relative(SUBGRAPH_DIR, __filename) + ' and commit it.',
      ]),
  )
}

function osRelease() {
  const out = {}
  let text
  try {
    text = fs.readFileSync('/etc/os-release', 'utf8')
  } catch (e) {
    return out
  }
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

// Ubuntu codename -> major version. Only the ones matchstick has builds for
// need to be here; anything else falls through to the honest refusal below.
const UBUNTU_CODENAMES = { focal: 20, jammy: 22, noble: 24 }

function platformName() {
  if (process.env.MATCHSTICK_PLATFORM) return process.env.MATCHSTICK_PLATFORM
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    die(['matchstick: no build exists for ' + process.platform + ' ' + process.arch + '.'])
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'binary-macos-12-m1' : 'binary-macos-12'
  }
  if (process.platform === 'linux') {
    const rel = osRelease()
    // The codename first: on a derivative (Zorin, Pop!_OS, Linux Mint) VERSION_ID
    // is the derivative's own numbering and says nothing about which Ubuntu the
    // binary would be linked against.
    const major =
      UBUNTU_CODENAMES[rel.UBUNTU_CODENAME] ||
      UBUNTU_CODENAMES[rel.VERSION_CODENAME] ||
      (rel.ID === 'ubuntu' ? parseInt(rel.VERSION_ID, 10) : NaN)
    if (major === 22 || major === 24) return 'binary-linux-22'
    die([
      'matchstick: no build known for this Linux.',
      '  ID=' + (rel.ID || '?') + ' VERSION_ID=' + (rel.VERSION_ID || '?') +
        ' UBUNTU_CODENAME=' + (rel.UBUNTU_CODENAME || '-'),
      '',
      'matchstick 0.6.0 publishes binary-linux-22 (Ubuntu 22.04/24.04), binary-macos-12',
      'and binary-macos-12-m1. If this machine can run one of them, name it:',
      '  MATCHSTICK_PLATFORM=binary-linux-22 npm test',
      'or point at a binary you already have:',
      '  MATCHSTICK_BINARY=/path/to/matchstick npm test',
    ])
  }
  die(['matchstick: unsupported platform ' + process.platform + '.'])
}

function ensureBinary(version, platform) {
  // Whatever the source — env var, cache, fresh download — the file is hashed
  // before it is run. The check is cheap next to the test run itself (measured
  // at 17-18 ms over the 27 MB binary, warm) and it is the only thing standing
  // between a swapped release asset and code execution on this machine.
  const expected = pinnedDigest(version, platform)

  if (process.env.MATCHSTICK_BINARY) {
    const p = process.env.MATCHSTICK_BINARY
    if (!fs.existsSync(p)) die(['matchstick: MATCHSTICK_BINARY=' + p + ' does not exist.'])
    requireDigest(p, expected, 'the binary given in MATCHSTICK_BINARY', [
      'A binary supplied by hand is held to the same digest as a downloaded one: the',
      'point of the pin is that every machine runs the same file. This one is a',
      'different file — a different version, a different platform build, or tampered.',
    ])
    return p
  }
  const root = process.env.MATCHSTICK_CACHE_DIR || path.join(SUBGRAPH_DIR, 'node_modules', '.cache', 'matchstick')
  const dir = path.join(root, version)
  const bin = path.join(dir, platform)
  if (fs.existsSync(bin)) {
    requireDigest(bin, expected, 'the cached binary', [
      'It was accepted when it was downloaded, so something changed it since — disk',
      'corruption, an editor, or another process. It is left in place rather than',
      'deleted, so it can be looked at; removing it makes the next run download afresh:',
      '  rm ' + bin,
    ])
    return bin
  }

  const url = 'https://github.com/LimeChain/matchstick/releases/download/' + version + '/' + platform
  process.stderr.write('matchstick: downloading ' + url + '\n')
  fs.mkdirSync(dir, { recursive: true })
  const tmp = bin + '.part'
  try {
    // curl rather than fetch+pipeline: this runs once per machine, and a 27 MB
    // download that dies half way must not leave a truncated file behind that
    // every later run then tries to execute. --fail turns an HTML error page
    // into a non-zero exit.
    execFileSync('curl', ['-sSL', '--fail', '-o', tmp, url], { stdio: ['ignore', 'ignore', 'inherit'] })
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch (_) {}
    die([
      'matchstick: could not download the test binary.',
      '  ' + url,
      '',
      'No network, or the release moved. On a machine that has it, fetch the file and',
      'point at it:  MATCHSTICK_BINARY=/path/to/' + platform + ' npm test',
    ])
  }
  // Hash before chmod: an unrecognised download never becomes executable, not
  // even for the moment between the two syscalls.
  requireDigest(
    tmp,
    expected,
    'the freshly downloaded binary',
    [
      '  from:     ' + url,
      '',
      'The download has been deleted, and it was never made executable. Either the',
      'release asset was replaced upstream, or something rewrote it in transit.',
      'Nothing was run.',
    ],
    () => {
      try { fs.unlinkSync(tmp) } catch (_) {}
    },
  )
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, bin)
  return bin
}

function main() {
  const version = installedVersion()
  const platform = platformName()
  const bin = ensureBinary(version, platform)
  const res = spawnSync(bin, process.argv.slice(2), { cwd: SUBGRAPH_DIR, stdio: 'inherit' })
  if (res.error) die(['matchstick: could not run ' + bin + ': ' + res.error.message])
  process.exit(res.status === null ? 1 : res.status)
}

main()
