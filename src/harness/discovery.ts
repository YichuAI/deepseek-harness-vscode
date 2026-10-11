/**
 * discovery.ts — find the dsh Host when the configured port is wrong.
 *
 * Why this exists
 * ───────────────
 * `dsh web` defaults to `127.0.0.1:3080`, so a fixed port is right *most* of the
 * time. The desktop app is the exception, and it is built in: it spawns its Host
 * with `--port 0` (`apps/desktop-host/src/index.ts`), so the OS assigns a fresh
 * port on every launch and reports it only to Electron over Node IPC. Nothing
 * lands on disk, which is why "the panel is stuck until you restart VS Code" was
 * really "the plugin is still pointing at last launch's port".
 *
 * The two ways out, cheapest first:
 *
 *   1. **Pinned ports.** A profile's user patch layer
 *      (`$DSH_HOME/profiles/<name>/cordis.patch.yml`) can carry a `webserver`
 *      entry with an explicit `port`. That is read from config alone — no
 *      probing, no guesswork.
 *   2. **The Host's own refusal.** An unauthenticated request to a dsh Host
 *      answers with HTTP 401 and the exact sentence
 *      "dsh web authentication required; reopen the URL printed by dsh web."
 *      That text comes from the connection carrier's fence, *not* the web
 *      frontend, so it is emitted whichever entry point booted the Host. It is
 *      therefore a fingerprint: any loopback listener that answers it is a Host
 *      this plugin can attach to with a cookie minted from
 *      `$DSH_HOME/.credentials.yaml`.
 *
 * Ports to probe come from the OS listener table (netstat / lsof / /proc/net/tcp)
 * rather than a blind range scan: a few dozen listeners resolve in about a
 * second, while sweeping 16k ephemeral ports would be both slow and rude.
 *
 * Everything here is best-effort. A missing listener table, an unsupported
 * platform or a probe that times out degrades to "found nothing", never to a
 * thrown error — discovery must not be able to break a connect that would
 * otherwise have worked.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { httpRequest } from './http.ts'

/**
 * The connection fence's refusal sentence. The Host answers this to any
 * unauthenticated request, regardless of which front end started it, which is
 * what makes it usable as an identity check.
 */
export const DSH_FENCE_FINGERPRINT = 'dsh web authentication required'

/**
 * CSS custom property only the dsh web shell defines.
 *
 * Secondary accept: a Host deployed with the browser fence disabled answers
 * `200` to an anonymous `/`. Checking for this marker keeps discovery working
 * there without loosening the check into "some server answered".
 */
export const DSH_BOOT_MARKER = '--dsh-boot-bg'

/** How one loopback port answered the probe. */
export type HostProbe = 'dsh-host' | 'foreign' | 'silent'

/** Default per-probe budget. Shorter than a connect: these run in parallel. */
const DEFAULT_PROBE_TIMEOUT_MS = 1200
/** How many probes may be in flight at once. */
const DEFAULT_CONCURRENCY = 12
/** Upper bound on ports probed in one discovery pass, so a huge listener table cannot stall the UI. */
const DEFAULT_MAX_PROBES = 140

/**
 * Ask one loopback port whether it is a dsh Host.
 *
 * Deliberately sends **no cookie**: an authenticated `/` answers 200 with the
 * app shell, which no longer distinguishes a Host from anything else serving
 * HTML. Anonymous is the only interrogation that yields the fence text.
 */
export async function probeHost(
  host: string,
  port: number,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<HostProbe> {
  try {
    const res = await httpRequest({ host, port, method: 'GET', path: '/', timeoutMs })
    if (res.status === 401 && res.body.includes(DSH_FENCE_FINGERPRINT)) return 'dsh-host'
    if (res.status === 200 && res.body.includes(DSH_BOOT_MARKER)) return 'dsh-host'
    return 'foreign'
  } catch {
    return 'silent'
  }
}

/** A port pinned by one profile's user patch layer. */
export interface PinnedPort {
  /** Profile directory name, e.g. `desktop`. */
  profile: string
  port: number
}

/**
 * Pull the `webserver` entry's `port` out of a `cordis.patch.yml`.
 *
 * Hand-parsed rather than YAML-parsed on purpose: the user layer may contain
 * `!!js` tags that only the dsh loader can evaluate, and a generic parser would
 * reject the whole document over one of them.
 */
export function parseWebserverPort(text: string): number | undefined {
  // Entries begin at a list item; split so a `port:` key can only match inside
  // the entry that declares it.
  for (const entry of text.split(/^(?=\s*-\s*id\s*:)/m)) {
    if (!/^\s*-\s*id\s*:\s*webserver\s*$/m.test(entry)) continue
    const port = /^\s*port\s*:\s*(\d{1,5})\s*$/m.exec(entry)
    if (port?.[1] !== undefined) return Number(port[1])
  }
  return undefined
}

/** Resolve `$DSH_HOME` the way the harness does: env, else `~/.dsh`. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['DSH_HOME']
  const home = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : join(homedir(), '.dsh')
  return resolve(expandTilde(home))
}

function expandTilde(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** Read every profile's pinned `webserver` port. Missing profiles dir → empty. */
export async function readPinnedPorts(env: NodeJS.ProcessEnv = process.env): Promise<PinnedPort[]> {
  const profilesDir = join(resolveDshHome(env), 'profiles')
  let names: string[]
  try {
    names = await readdir(profilesDir)
  } catch {
    return []
  }
  const found: PinnedPort[] = []
  for (const name of names.sort()) {
    let text: string
    try {
      text = await readFile(join(profilesDir, name, 'cordis.patch.yml'), 'utf8')
    } catch {
      continue
    }
    const port = parseWebserverPort(text)
    if (port !== undefined) found.push({ profile: name, port })
  }
  return found
}

/**
 * Loopback ports from a Windows `netstat -ano` dump.
 *
 * `0.0.0.0`/`[::]` wildcard binds are included: a service listening on every
 * interface is still reachable on 127.0.0.1, and the fingerprint decides which
 * of them is actually a Host.
 */
export function parseNetstatListeners(text: string): number[] {
  const ports = new Set<number>()
  const re = /^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]):(\d+)\s+\S+\s+LISTENING\b/
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line)
    if (m?.[1] !== undefined) ports.add(Number(m[1]))
  }
  return [...ports].sort((a, b) => a - b)
}

/** Loopback ports from macOS `lsof -nP -iTCP -sTCP:LISTEN`. */
export function parseLsofListeners(text: string): number[] {
  const ports = new Set<number>()
  const re = /\bTCP\s+(?:127\.0\.0\.1|\[::1\]|\*)[:.](\d+)\s+\(LISTEN\)/
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line)
    if (m?.[1] !== undefined) ports.add(Number(m[1]))
  }
  return [...ports].sort((a, b) => a - b)
}

/**
 * Loopback ports from `/proc/net/tcp` (or `tcp6`).
 *
 * The kernel writes `LISTEN` as state `0A`, the address little-endian in hex:
 * `0100007F:0C08` is 127.0.0.1:3080. For tcp6, `::1` is a run of zeros with a
 * trailing `01`, and `::` is all zeros.
 */
export function parseProcNetListeners(text: string, family: 4 | 6 = 4): number[] {
  const loopback = family === 4
    ? '0100007F'
    // `::1` exactly as /proc renders it: four 32-bit words in host byte order, so
    // the trailing word 1 prints as `01000000`, not `00000001`.
    : `${'0'.repeat(24)}01000000`
  const wildcard = '0'.repeat(family === 4 ? 8 : 32)
  const ports = new Set<number>()
  for (const line of text.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    const [addr, portHex] = (cols[1] ?? '').split(':')
    if (addr === undefined || portHex === undefined) continue
    if (cols[3] !== '0A') continue
    if (addr !== loopback && addr !== wildcard) continue
    const port = Number.parseInt(portHex, 16)
    if (Number.isFinite(port) && port > 0) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

/** Run one command and return stdout, or undefined on any failure. */
function run(command: string, args: readonly string[], timeoutMs = 6000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err === null ? stdout : undefined)
    })
  })
}

/** `netstat` by absolute path — an extension host's PATH is not always the shell's. */
function windowsNetstatPath(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  return join(root, 'System32', 'netstat.exe')
}

/**
 * Every loopback port something is listening on.
 *
 * Best-effort by contract: an unsupported platform or a missing binary returns
 * an empty list rather than throwing, and callers fall back to pinned ports.
 */
export async function listLoopbackPorts(log?: (m: string) => void): Promise<number[]> {
  try {
    if (process.platform === 'win32') {
      const out = await run('netstat', ['-ano']) ?? await run(windowsNetstatPath(), ['-ano'])
      return out === undefined ? [] : parseNetstatListeners(out)
    }
    if (process.platform === 'darwin') {
      const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
      return out === undefined ? [] : parseLsofListeners(out)
    }
    const v4 = await readFile('/proc/net/tcp', 'utf8').catch(() => undefined)
    const v6 = await readFile('/proc/net/tcp6', 'utf8').catch(() => undefined)
    const ports = new Set<number>([
      ...(v4 === undefined ? [] : parseProcNetListeners(v4, 4)),
      ...(v6 === undefined ? [] : parseProcNetListeners(v6, 6)),
    ])
    return [...ports].sort((a, b) => a - b)
  } catch (e) {
    log?.(`discovery: could not enumerate listeners — ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

/** One loopback address confirmed to be a dsh Host. */
export interface HostCandidate {
  host: string
  port: number
  /** Why the port was probed at all. */
  source: 'pinned' | 'listening'
  /** Profile whose patch layer pinned it, when `source` is `pinned`. */
  profile?: string
}

export interface DiscoveryOptions {
  /** Address to probe on. Only loopback is meaningful; anything else is ignored. */
  host: string
  /** The port the plugin is configured for — probed first, always. */
  port: number
  env?: NodeJS.ProcessEnv
  probeTimeoutMs?: number
  concurrency?: number
  maxProbes?: number
  /**
   * Where the candidate ports come from. Overridable so a test can supply a
   * fixed set instead of the machine's real listener table.
   */
  listeners?: () => Promise<number[]>
  log?: (m: string) => void
}

/** Probe `ports` with at most `concurrency` requests in flight. */
async function probeAll(
  host: string,
  ports: readonly number[],
  concurrency: number,
  timeoutMs: number,
): Promise<Map<number, HostProbe>> {
  const results = new Map<number, HostProbe>()
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      const port = ports[index]
      if (port === undefined) return
      results.set(port, await probeHost(host, port, timeoutMs))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker))
  return results
}

/**
 * Find dsh Hosts reachable on loopback.
 *
 * Order is by confidence, not by port number: a port pinned in a profile's patch
 * layer is a deliberate declaration and comes first, then whatever the listener
 * table turned up. The configured port is probed first of all so the happy path
 * costs one request.
 *
 * @returns the confirmed Hosts, best candidate first. Empty when nothing answers
 *   the fingerprint — which is itself the answer ("no Host is running").
 */
export async function discoverHosts(opts: DiscoveryOptions): Promise<HostCandidate[]> {
  const {
    host, port,
    env = process.env,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    concurrency = DEFAULT_CONCURRENCY,
    maxProbes = DEFAULT_MAX_PROBES,
    listeners = listLoopbackPorts,
    log,
  } = opts

  const pinned = await readPinnedPorts(env)
  const listening = await listeners(log)

  // Configured port first, then pinned, then the rest of the listener table.
  const ordered: number[] = [port]
  const source = new Map<number, { source: 'pinned' | 'listening'; profile?: string }>()
  for (const p of pinned) {
    if (!ordered.includes(p.port)) ordered.push(p.port)
    source.set(p.port, { source: 'pinned', profile: p.profile })
  }
  for (const p of listening) {
    if (!ordered.includes(p)) ordered.push(p)
  }
  for (const p of listening) {
    if (!source.has(p)) source.set(p, { source: 'listening' })
  }

  const probed = ordered.slice(0, Math.max(1, maxProbes))
  const verdicts = await probeAll(host, probed, concurrency, probeTimeoutMs)
  const hosts = probed
    .filter((p) => verdicts.get(p) === 'dsh-host')
    .map((p) => {
      const origin = source.get(p)
      return origin === undefined
        ? { host, port: p, source: 'listening' as const }
        : { host, port: p, source: origin.source, ...(origin.profile === undefined ? {} : { profile: origin.profile }) }
    })
  // Pinned declarations outrank incidental listeners.
  hosts.sort((a, b) => (a.source === b.source ? a.port - b.port : a.source === 'pinned' ? -1 : 1))

  log?.(`discovery: probed ${String(probed.length)} loopback port(s) — `
    + `${String(hosts.length)} dsh Host(s)`
    + (hosts.length > 0 ? ` at ${hosts.map((h) => `${h.host}:${String(h.port)}`).join(', ')}` : '')
    + `; ${String(pinned.length)} pinned in profile patch layers`)
  return hosts
}
