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
// The binary is cached under node_modules/.cache/ by default, which is already
// ignored by git and thrown away by `rm -rf node_modules` like any other build
// tool. `npm ci` wipes node_modules too, so a CI job that wants to keep the
// 27 MB download between runs should point MATCHSTICK_CACHE_DIR somewhere it
// caches — the whole directory is content-addressed by version and platform.

const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const SUBGRAPH_DIR = path.resolve(__dirname, '..')

function die(lines) {
  process.stderr.write(lines.join('\n') + '\n')
  process.exit(1)
}

// The binary and the AssemblyScript library have to be the same version — they
// are two halves of one tool and the library's assertions call into the
// binary's host functions. Taking the number from devDependencies means a
// version bump in package.json moves both, and neither can be forgotten.
function wantedVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SUBGRAPH_DIR, 'package.json'), 'utf8'))
  const spec = (pkg.devDependencies || {})['matchstick-as']
  if (!spec) {
    die([
      'matchstick: package.json has no devDependency on matchstick-as.',
      'The test library and the test binary are versioned together; without the library',
      'there is nothing for the binary to run.',
    ])
  }
  const m = /(\d+\.\d+\.\d+)/.exec(spec)
  if (!m) die(['matchstick: cannot read a version out of matchstick-as spec "' + spec + '".'])
  return m[1]
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
  if (process.env.MATCHSTICK_BINARY) {
    const p = process.env.MATCHSTICK_BINARY
    if (!fs.existsSync(p)) die(['matchstick: MATCHSTICK_BINARY=' + p + ' does not exist.'])
    return p
  }
  const root = process.env.MATCHSTICK_CACHE_DIR || path.join(SUBGRAPH_DIR, 'node_modules', '.cache', 'matchstick')
  const dir = path.join(root, version)
  const bin = path.join(dir, platform)
  if (fs.existsSync(bin)) return bin

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
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, bin)
  return bin
}

function main() {
  const version = wantedVersion()
  const platform = platformName()
  const bin = ensureBinary(version, platform)
  const res = spawnSync(bin, process.argv.slice(2), { cwd: SUBGRAPH_DIR, stdio: 'inherit' })
  if (res.error) die(['matchstick: could not run ' + bin + ': ' + res.error.message])
  process.exit(res.status === null ? 1 : res.status)
}

main()
