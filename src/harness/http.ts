/**
 * http.ts — the tiny HTTP client behind every harness request.
 *
 * We deliberately avoid the platform `fetch`:
 *   • Node's fetch has no cookie jar and its treatment of the `Cookie` request
 *     header is implementation-defined; the harness now *requires* that header
 *     on every `/api/*` call and on the mux upgrade.
 *   • Reading `Set-Cookie` during the token exchange must be exact, and
 *     `Headers.get('set-cookie')` folds multiple values in some runtimes.
 *   • `node:http` is present in every VS Code extension host, fetch is not
 *     guaranteed to be.
 */

import http from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'

export interface HttpRequestOptions {
  host: string
  port: number
  method: 'GET' | 'POST'
  /** Path including any query string, e.g. `/api/session/list`. */
  path: string
  headers?: Record<string, string>
  body?: string
}

export interface HttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** Strip IPv6 brackets so `http.request` receives a bare literal. */
function bareHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Perform one request to completion. Never follows redirects (the token exchange needs the 303). */
export function httpRequest(opts: HttpRequestOptions): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body
    const req = http.request({
      hostname: bareHost(opts.host),
      port: opts.port,
      method: opts.method,
      path: opts.path,
      headers: {
        ...(payload === undefined
          ? {}
          : {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          }),
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Uint8Array[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', (err) => { reject(err instanceof Error ? err : new Error(String(err))) })
    req.end(payload)
  })
}

/** First value of a possibly-repeated response header. */
export function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}
