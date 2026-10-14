/**
 * check-versions.ts — one gate for every place a version number is typed by hand.
 *
 * Why this exists: on 2026-10-11 the same extension was showing four different
 * versions depending on where you looked — the Marketplace listing (0.1.3, the
 * last publish), `package.json` on `main` (0.1.7), the newest GitHub Release
 * (0.2.0), and a stale `v0.0.3` heading still sitting in the README. None of
 * those was a code defect; they were four independently-typed strings that
 * nothing ever compared. A human had to notice.
 *
 * So the rule this file enforces is narrow and mechanical: `package.json` is the
 * single source of truth, and every other place a version is written must agree
 * with it. Formatting that can be derived (badges) must be derived instead of
 * typed, and the ones that cannot be derived (an install command a reader is
 * meant to copy verbatim) are checked rather than removed.
 *
 * Usage
 *   node node_modules/tsx/dist/cli.mjs scripts/check-versions.ts
 *   node node_modules/tsx/dist/cli.mjs scripts/check-versions.ts --online
 *   node node_modules/tsx/dist/cli.mjs scripts/check-versions.ts --release
 *
 *   --online   also compare against the published GitHub Release and the
 *              Marketplace listing (needs network; off by default so the check
 *              is usable offline and in a sandbox).
 *   --release  require the version to be tagged already. Tag-push CI passes
 *              this; ordinary CI does not, because between the version bump and
 *              the tag it is normal for the number to be ahead of every tag.
 *
 * Exit code is 0 only when every check passes.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXT_ID = 'lucasliang.harness-connector-deepseek'
const REPO = 'YichuAI/deepseek-harness-vscode'

const args = new Set(process.argv.slice(2))
const ONLINE = args.has('--online')
const RELEASE = args.has('--release') || process.env['RELEASE'] === '1'

// ─── tiny assertion harness (same shape as protocol-test, so output reads alike)

let passed = 0
const failures: string[] = []
const skipped: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(name)
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * A check that could not run — distinct from one that ran and failed.
 *
 * The difference matters because some of these checks read `git`, and a
 * restricted environment may refuse to spawn any child process at all. Calling
 * that a failure would paint every local run red for a reason the author cannot
 * fix, which is how a gate gets ignored. It is not silent: skips are printed and
 * counted, so an empty tag list in CI (where `git` does run) is still a failure.
 */
function skip(name: string, why: string): void {
  skipped.push(name)
  console.log(`– ${name} — skipped: ${why}`)
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, actual === expected ? String(actual) : `got ${String(actual)}, want ${String(expected)}`)
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/**
 * The body of the first section whose heading matches, up to the next `## `.
 *
 * Scoped rather than whole-file, because the numbers this script hunts for are
 * routinely written twice on purpose — the README says "312 assertions (was
 * 295)" inside the *current* release's notes and quotes older figures inside
 * older notes.
 */
function sectionFor(text: string, heading: RegExp): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => heading.test(l))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

// ─── the source of truth

const pkg = JSON.parse(read('package.json')) as { version: string; publisher?: string; name?: string }
const VERSION = pkg.version

console.log(`\nversion under test: ${VERSION}\n`)

// ─── 1. the version itself

check('package.json version is semver', /^\d+\.\d+\.\d+$/.test(VERSION), VERSION)
eq('publisher is the one the Marketplace listing uses', pkg.publisher, 'lucasliang')

// ─── 1b. the lockfile, which also carries the version

// `npm ci` does not validate the root version, so this drifted unnoticed from
// 0.1.5 to 0.2.1 -- the lockfile still said 0.1.4 while everything else had
// moved on. It is invisible to a user, but it is the same class of defect: a
// number that names this release, written in a second place, with nothing
// comparing it. `npm install --package-lock-only` fixes it in two lines.
const lock = JSON.parse(read('package-lock.json')) as {
  version?: string
  packages?: Record<string, { version?: string }>
}
eq('package-lock.json carries the current version', lock.version, VERSION)
eq('package-lock.json’s root entry carries the current version', lock.packages?.['']?.version, VERSION)

// ─── 2. README: the heading must not carry a hand-typed version

const readme = read('README.md')
const readmeZh = read('README.zh-CN.md')

// The title stopped being line 1 when the README grew a centred hero — the file
// now opens with `<p align="center">` holding the logo. So read whichever form
// the file uses, and read *something*: checking `split('\n')[0]` after that
// change would have compared an empty string and passed forever.
const titleOf = (text: string): string =>
  text.split('\n').find((line) => /^#\s/.test(line) || /<h1\b/i.test(line)) ?? ''
const h1 = titleOf(readme)
const h1Zh = titleOf(readmeZh)
check('README has a title line', h1 !== '', h1 || '(neither `# ` nor `<h1>` found)')
check('README.zh-CN has a title line', h1Zh !== '', h1Zh || '(neither `# ` nor `<h1>` found)')
check('README H1 carries no version', !/\(v?\d+\.\d+\.\d+\)/.test(h1), h1)
check('README.zh-CN H1 carries no version', !/\(v?\d+\.\d+\.\d+\)/.test(h1Zh), h1Zh)

// ─── 3. badges are derived, not typed
//
// A live endpoint that reads GitHub/Marketplace cannot go stale. A
// `badge/version-0.2.0-blue.svg` URL is a number someone typed, and it was the
// easiest surface to forget (it was, twice).

for (const [label, text] of [['README', readme], ['README.zh-CN', readmeZh]] as const) {
  const typed = text.match(/img\.shields\.io\/badge\/version-[\d.]+/g) ?? []
  check(`${label} has no hand-typed version badge`, typed.length === 0, typed.join(', ') || 'none')
  check(
    `${label} uses a live GitHub release badge`,
    text.includes(`img.shields.io/github/v/release/${REPO}`),
  )
  // The Marketplace pair lives on badgen.net, and that is not a preference.
  // shields.io never served a `vs-marketplace` slug — its namespace is
  // `visual-studio-marketplace`, and that one now answers with an SVG reading
  // "retired badge", i.e. the integration was withdrawn rather than renamed.
  // There was no correct shields URL to switch to. Hence an assertion on the
  // host rather than on "there is some badge here": a dead badge still renders,
  // it just renders red, which is invisible from a source-level check.
  check(
    `${label} uses a live Marketplace version badge`,
    text.includes(`badgen.net/vs-marketplace/v/${EXT_ID}`),
  )
  check(
    `${label} uses a live Marketplace install badge`,
    text.includes(`badgen.net/vs-marketplace/i/${EXT_ID}`),
  )
  const retired = text.match(/img\.shields\.io\/vs-marketplace\//g) ?? []
  check(
    `${label} carries no retired shields Marketplace badge`,
    retired.length === 0,
    retired.join(', ') || 'none',
  )
}

// ─── 4. the "what's new" heading is the current version, and there is only one

function firstMatch(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1]
}

const enWhatsNew = [...readme.matchAll(/^## What's new in v(\d+\.\d+\.\d+)$/gm)].map((m) => m[1]!)
const zhWhatsNew = [...readmeZh.matchAll(/^## v(\d+\.\d+\.\d+) 新特性$/gm)].map((m) => m[1]!)

eq('README’s newest "What\'s new" heading is the current version', enWhatsNew[0], VERSION)
eq('README.zh-CN’s newest "新特性" heading is the current version', zhWhatsNew[0], VERSION)

// History belongs in the CHANGELOG. When the README accumulated one section per
// release it ended up as the de-facto changelog, and then advertising v0.0.3 and
// v0.2.0 in the same document.
eq('README keeps only the current release’s notes', enWhatsNew.length, 1)
eq('README.zh-CN keeps only the current release’s notes', zhWhatsNew.length, 1)

const staleHeadings = [...readme.matchAll(/^## (?:What v|What's new in v)(\d+\.\d+\.\d+)/gm)]
  .map((m) => m[1]!)
  .filter((v) => v !== VERSION)
check(
  'no other release heading survives in README',
  staleHeadings.length === 0,
  staleHeadings.join(', ') || 'none',
)

// ─── 5. the copy-paste install commands name this version
//
// Deliberately checked rather than replaced with `<ver>`: a reader is supposed
// to be able to paste these, so they have to be literally correct.

for (const [label, text] of [['README', readme], ['README.zh-CN', readmeZh]] as const) {
  const named = [...text.matchAll(/harness-connector-deepseek-(\d+\.\d+\.\d+)\.vsix/g)]
    .map((m) => m[1]!)
  check(`${label} has at least one install command naming a version`, named.length > 0)
  const wrong = named.filter((v) => v !== VERSION)
  check(`${label}’s VSIX filenames all name ${VERSION}`, wrong.length === 0, wrong.join(', ') || `${String(named.length)} occurrence(s)`)
}

// ─── 6. CHANGELOG tops out at the same version

const changelog = read('CHANGELOG.md')
const changelogZh = read('CHANGELOG.zh-CN.md')
eq('CHANGELOG’s newest entry is the current version', firstMatch(changelog, /^## \[(\d+\.\d+\.\d+)\]/m), VERSION)
eq('CHANGELOG.zh-CN’s newest entry is the current version', firstMatch(changelogZh, /^## \[(\d+\.\d+\.\d+)\]/m), VERSION)

// The CHANGELOG is shipped inside the VSIX under vsce's lowercase name, so a
// missing entry is user-visible rather than merely untidy.
check('CHANGELOG has an entry for the current version', changelog.includes(`## [${VERSION}]`), `## [${VERSION}]`)
check('README points at the CHANGELOG for history', readme.includes('](./CHANGELOG.md)'))
check('README.zh-CN points at the CHANGELOG for history', readmeZh.includes('](./CHANGELOG.zh-CN.md)'))

// ─── 7. RELEASE.md's packaging baseline names the current version
//
// The recorded VSIX size is only meaningful alongside the version it was
// measured on; carrying `v0.1.9 = 309,620` into the 0.2.0 section reads as
// authoritative and is not.

const release = read('RELEASE.md')
const releaseZh = read('RELEASE.zh-CN.md')
check('RELEASE.md baseline is labelled with the current version', release.includes(`v${VERSION} = `))
check('RELEASE.zh-CN.md baseline is labelled with the current version', releaseZh.includes(`v${VERSION} = `))
check('RELEASE.md documents the version gate', release.includes('check-versions'))

// ─── 8. the assertion count the docs advertise is one number, not five
//
// This is the single most common doc drift in this repo, and it only ever
// happens one way: a release updates the count in the README and forgets the
// ARCHITECTURE file tree, or updates both and leaves the RELEASE trail behind.
// So the check does not need to run the test suite — it needs to confirm that
// the places which claim to describe *the current state* all say the same
// thing. Historical entries legitimately quote the number of their own day and
// are deliberately out of scope.
//
// The anchor is the ARCHITECTURE file tree, because it is one unambigous line;
// RELEASE.md's arrow trail must *end* on the same value, which is what makes
// the trail a record rather than decoration.

function assertionAnchor(): number | undefined {
  const m = /protocol-test\.ts\s+#[^\n]*?(\d+)\s+assertions/.exec(read('ARCHITECTURE.md'))
  return m ? Number(m[1]) : undefined
}

function firstAssertionCount(text: string, re: RegExp): number | undefined {
  const m = re.exec(text)
  return m ? Number(m[1]) : undefined
}

function trailEnd(text: string): number | undefined {
  const run = /((?:\d+\s*→\s*)+\d+)/.exec(text)?.[1]
  if (!run) return undefined
  const nums = run.match(/\d+/g) ?? []
  return nums.length > 0 ? Number(nums[nums.length - 1]) : undefined
}

const anchor = assertionAnchor()
check('ARCHITECTURE.md states an assertion count', anchor !== undefined, String(anchor ?? 'none'))

if (anchor !== undefined) {
  const releaseSectionEn = sectionFor(readme, /^## What's new in v\d+\.\d+\.\d+$/m)
  const releaseSectionZh = sectionFor(readmeZh, /^## v\d+\.\d+\.\d+ 新特性$/m)

  eq('README’s current release quotes that count', firstAssertionCount(releaseSectionEn, /(\d+)\s+assertions/), anchor)
  eq('README.zh-CN’s current release quotes that count', firstAssertionCount(releaseSectionZh, /(\d+)\s+项断言/), anchor)
  eq('ARCHITECTURE.zh-CN quotes that count', firstAssertionCount(read('ARCHITECTURE.zh-CN.md'), /(\d+)\s+项断言/), anchor)
  eq('RELEASE.md’s growth trail ends on that count', trailEnd(release), anchor)
  eq('RELEASE.zh-CN.md’s growth trail ends on that count', trailEnd(releaseZh), anchor)
}

// ─── 9. tags

function git(...argv: string[]): string {
  return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' }).trim()
}

// Probe once, before trusting any individual `git` call. `execFileSync` throws
// both when git is missing and when the sandbox forbids spawning, and those two
// cases look the same from here — "no tags" and "cannot look" must not.
let gitUsable = true
try {
  git('rev-parse', '--git-dir')
} catch {
  gitUsable = false
}

let latestTag = ''
let tagCommit = ''
if (gitUsable) {
  try {
    latestTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*')
  } catch {
    latestTag = ''
  }
}

const latestTagVersion = latestTag.replace(/^v/, '')

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

if (!gitUsable) {
  skip('at least one version tag exists', 'git is not runnable in this environment')
} else {
  check('at least one version tag exists', latestTag !== '', latestTag || 'none')
}

if (RELEASE && !gitUsable) {
  skip('the version is tagged and points at HEAD', 'git is not runnable in this environment')
} else if (RELEASE) {
  eq('the version is tagged', latestTagVersion, VERSION)
  try {
    tagCommit = git('rev-list', '-n1', `v${VERSION}`)
    check('the tag resolves to a commit', /^[0-9a-f]{40}$/.test(tagCommit), tagCommit.slice(0, 7))
    eq('the tag points at HEAD', tagCommit, git('rev-parse', 'HEAD'))
  } catch (e) {
    check('the tag resolves to a commit', false, e instanceof Error ? e.message : String(e))
  }
} else if (latestTagVersion) {
  // Between the bump and the tag the number is legitimately ahead. What is never
  // legitimate is being *behind* — that means the repo lost a release.
  const cmp = compareSemver(VERSION, latestTagVersion)
  check(
    `the version is not behind the newest tag (${latestTag})`,
    cmp >= 0,
    cmp === 0 ? `in sync with ${latestTag}` : `${VERSION} is ahead of ${latestTag} — unreleased bump`,
  )
}

// ─── 10. the published surfaces (opt-in)

async function published(): Promise<void> {
  const headers = { Accept: 'application/json;api-version=7.2-preview.1', 'Content-Type': 'application/json' }
  const body = JSON.stringify({
    filters: [{ criteria: [{ filterType: 7, value: EXT_ID }] }],
    flags: 914,
  })

  try {
    const res = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
      method: 'POST', headers, body,
    })
    const json = (await res.json()) as {
      results: { extensions: { versions: { version: string }[]; statistics: { statisticName: string; value: number }[] }[] }[]
    }
    const ext = json.results[0]?.extensions[0]
    const online = ext?.versions[0]?.version
    const installs = ext?.statistics?.find((s) => s.statisticName === 'install')?.value
    eq('the Marketplace serves the current version', online, VERSION)
    console.log(`   (Marketplace installs: ${String(installs ?? 'unknown')})`)
  } catch (e) {
    check('could not reach the Marketplace gallery API', false, e instanceof Error ? e.message : String(e))
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'check-versions' },
    })
    const json = (await res.json()) as { tag_name?: string }
    eq('the newest GitHub Release is the current version', (json.tag_name ?? '').replace(/^v/, ''), VERSION)
  } catch (e) {
    check('could not reach the GitHub releases API', false, e instanceof Error ? e.message : String(e))
  }

  // A badge URL that string-matches is not a badge that renders — which is the
  // exact gap that let `img.shields.io/vs-marketplace/...` ship for releases: it
  // satisfies every substring assertion and still draws `404 badge not found`.
  // So fetch them and read the label the SVG announces about itself.
  const badges: [string, string][] = [
    ['Marketplace version', `https://badgen.net/vs-marketplace/v/${EXT_ID}`],
    ['Marketplace installs', `https://badgen.net/vs-marketplace/i/${EXT_ID}`],
    ['GitHub release', `https://img.shields.io/github/v/release/${REPO}`],
    ['GitHub stars', `https://badgen.net/github/stars/${REPO}`],
    // The README also carries `img.shields.io/open-vsx/v|dt/…`, and they are
    // deliberately *not* listed here. That provider flaps: within a few minutes
    // it answered `200 open vsx: v0.2.5` and then `200 404: badge not found` for
    // the same URL of an extension that is published and downloadable — so the
    // check would red-light at random on a release gate, which is worse than not
    // having it. The risk this section exists to catch is a *typed* number going
    // stale; both Open VSX badges derive their value live, so that risk is absent.
    // Verified by hand instead: both draw when the provider is healthy.
  ]
  // A badge host sits upstream of someone else's API and will answer
  // `404: badge not found` while that upstream hiccups — measured on the Open
  // VSX pair, which drew fine seconds later and then flapped again. One miss is
  // therefore not evidence of a dead badge; several spread over half a minute
  // are, and the last answer is what gets reported. If the Open VSX lines are
  // the only red ones, re-run before believing them.
  const badgeBackoffMs = [2000, 5000, 8000]
  const probeBadge = async (url: string): Promise<{ ok: boolean; detail: string }> => {
    let detail = ''
    for (let attempt = 0; attempt <= badgeBackoffMs.length; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'check-versions' } })
        const svg = await res.text()
        const label = /aria-label="([^"]*)"/.exec(svg)?.[1] ?? ''
        detail = label || `HTTP ${String(res.status)} with no label`
        if (res.ok && label !== '' && !/not found|retired|invalid|deprecated/i.test(label)) {
          return { ok: true, detail }
        }
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e)
      }
      const wait = badgeBackoffMs[attempt]
      if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait))
    }
    return { ok: false, detail }
  }

  for (const [name, url] of badges) {
    const { ok, detail } = await probeBadge(url)
    check(`the ${name} badge still renders`, ok, detail)
  }
}

// ─── report

// Wrapped rather than written as top-level `await`: this package has no
// `"type": "module"`, so tsx compiles the file as CJS and esbuild rejects
// top-level await outright (`ERR_REQUIRE_ASYNC_MODULE`). `main().catch(...)`
// is the convention the other scripts here already use.
async function report(): Promise<void> {
  if (ONLINE) await published()

  console.log(`\n${passed} passed, ${failures.length} failed${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`)
  if (failures.length > 0) {
    console.log('\nVersion surfaces disagree:')
    for (const f of failures) console.log(`  • ${f}`)
    console.log('\npackage.json is the source of truth. Fix the other surface, not this check.')
    process.exit(1)
  }
  if (skipped.length > 0) {
    console.log('\nSkipped because the environment cannot perform them:')
    for (const s of skipped) console.log(`  – ${s}`)
    console.log('CI runs these; treat a skip here as unverified, not as passing.')
  }
  console.log(skipped.length > 0 ? '\nEvery version surface that could be read agrees.' : '\nEvery version surface agrees.')
}

report().catch((e) => {
  console.error('\nVERSION CHECK ERROR:', e)
  process.exit(1)
})
