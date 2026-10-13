/**
 * endpoint.ts — the one place that decides which hosts this plugin will talk to,
 * and how a `{host, port}` pair becomes each of the three strings the wire needs.
 *
 * Why it exists as its own module: the answer to "does this work over
 * Remote-SSH / WSL / a dev container?" is *this file*, not a setting. A Host on
 * another machine is refused here, before a socket is opened, and the same
 * `{host, port}` is then used verbatim for three things that must agree with
 * each other:
 *
 *   - the `Origin:` header the Host's CSRF fence compares (an `http://` origin),
 *   - the `Host:`-equivalent authority the browser-session cookie is named after
 *     (`sha256(authority)` — get this wrong and the cookie is silently rejected
 *     as belonging to someone else),
 *   - the `ws://` URL of the event socket.
 *
 * Until v0.2.3 each of those was composed inline at its own call site, which is
 * how `::1` came to be listed as an accepted host while producing
 * `http://::1:3080` — not a URL. One module means one formatting rule, and means
 * the remote-support matrix has a single line of code to point at.
 */

/**
 * The hosts this plugin will talk to: loopback, spelled three ways.
 *
 * Deliberately a closed set rather than "anything that resolves to 127.0.0.1".
 * A name that resolves to loopback *today* can be re-pointed by a hosts file or
 * a DNS answer tomorrow, and the fence exists to make DNS rebinding a non-issue
 * rather than something the plugin re-checks. `host.docker.internal`,
 * `172.17.0.1`, the host's LAN address and anything reached through a forwarded
 * port are all outside the set, and all refused.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

/**
 * `host` as it must appear inside a URL or an endpoint authority.
 *
 * An IPv6 literal carries colons, so in a URL it has to be bracketed or the
 * port reads as a sixth group — `http://::1:3080/` parses as host `::1:3080`
 * and a default port. Brackets are only for the literal form; `localhost` and
 * a dotted quad are unchanged.
 */
export function hostLiteral(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * `host:port` exactly as the `Host` header will carry it, and exactly what the
 * cookie name is derived from. The two are the same string on purpose: the Host
 * names the cookie after the authority the request arrived under, so a client
 * that formats its own cookie key differently from its own `Host` header is
 * asking to be told its cookie is not valid here.
 */
export function authorityOf(host: string, port: number): string {
  return `${hostLiteral(host)}:${String(port)}`
}

/** The `Origin:` header for HTTP requests to this endpoint. */
export function httpOrigin(host: string, port: number): string {
  return `http://${authorityOf(host, port)}`
}

/** The `Origin:` header for the event socket, and the socket URL itself. */
export function wsOrigin(host: string, port: number): string {
  return `ws://${authorityOf(host, port)}`
}

/**
 * What the user is told when the fence refuses — one wording, raised at every
 * entry point, so a refusal from `connect` and a refusal from a mid-session RPC
 * are recognisably the same rule rather than two different accidents.
 *
 * It names the three accepted values and the machine they mean, because the
 * common case is not a mistake: it is a workspace on one machine and a Harness
 * on another, and the reader needs to know which of the two has to move.
 */
export function nonLoopbackRefusal(host: string): string {
  return `Refusing to talk to "${host}": this plugin only drives a DeepSeek Harness running on the ` +
    'same machine as the VS Code window. Set deepseekHarness.host to 127.0.0.1, localhost or ::1.'
}
