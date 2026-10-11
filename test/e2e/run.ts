/**
 * End-to-end runner.
 *
 * The protocol test pins the wire contract and the projection model, and it is
 * cheap and reliable — which is exactly why it passed all the way through the
 * release that broke the mention chip. What it cannot see is a *sequence* of
 * user actions against a Host that misbehaves in the middle: connect, restart the
 * Host, reconnect; send from the browser and look here; approve, reject, time
 * out. That is what this directory is for.
 *
 * Coverage is reported, not implied. A chain that is not written yet prints as
 * `not written` and says what it needs, rather than being silently absent from a
 * suite that claims to be green. The exit code is non-zero only for a chain that
 * ran and failed — so an incomplete suite never masquerades as a passing one, and
 * never blocks the build with a red X that means "not yet implemented".
 *
 * Run: npm run e2e-test
 */

import { appendFileSync } from 'node:fs'
import { runChain5, type ChainResult } from './chain5-revert.ts'

interface Chain {
  n: number
  name: string
  /** What the chain needs before it can be written honestly. */
  note: string
  run?: () => Promise<ChainResult>
}

const CHAINS: Chain[] = [
  {
    n: 1,
    name: 'Connect and auth — Host up → VS Code connects → Host restarts → recovers',
    note: 'needs a Host that can be killed and restarted between two connects',
  },
  {
    n: 2,
    name: 'Session consistency — browser sends → VS Code sees it → switch → reload → history intact',
    note: 'needs a real VS Code Extension Host',
  },
  {
    n: 3,
    name: 'Streaming — long reply → tool call → drop the socket → no duplicate, loss or reorder',
    note: 'needs a Host that can kill one connection without dying itself',
  },
  {
    n: 4,
    name: 'Approvals — allow, reject, time out, Host error → every card reaches a terminal state',
    note: 'needs a real Extension Host to click in',
  },
  {
    n: 5,
    name: 'File changes — agent edits → user edits again → revert must not clobber the user',
    note: 'real filesystem, real materializer, no Extension Host needed',
    run: runChain5,
  },
]

async function main(): Promise<void> {
  console.log('\nDeepSeek Harness Connector — end-to-end chains\n')

  let covered = 0
  let passed = 0
  let failed = 0
  const summary: string[] = []

  for (const chain of CHAINS) {
    if (chain.run === undefined) {
      console.log(`${String(chain.n)}. NOT WRITTEN  ${chain.name}`)
      console.log(`   ${chain.note}`)
      summary.push(`| ${String(chain.n)} | ${chain.name} | ⬜ not written | ${chain.note} |`)
      continue
    }

    covered++
    console.log(`${String(chain.n)}. ${chain.name}`)
    const result = await chain.run()
    passed += result.passed
    failed += result.failed
    console.log(`   ${result.failed === 0 ? '✓' : '✗'} ${String(result.passed)} passed, ${String(result.failed)} failed`)
    summary.push(
      `| ${String(chain.n)} | ${chain.name} | ${result.failed === 0 ? '✅ passing' : '❌ failing'} | ${String(result.passed)}/${String(result.passed + result.failed)} assertions |`,
    )
  }

  const total = CHAINS.length
  console.log(`\n${String(covered)} of ${String(total)} chains covered, ${String(total - covered)} not written`)

  // GitHub renders this under the job, which is where a reader looks first.
  const stepSummary = process.env['GITHUB_STEP_SUMMARY']
  if (stepSummary !== undefined && stepSummary !== '') {
    appendFileSync(stepSummary,
      `## End-to-end chains\n\n${String(covered)} of ${String(total)} covered.\n\n`
      + '| # | Chain | State | |\n| --- | --- | --- | --- |\n' + summary.join('\n') + '\n')
  }

  if (failed > 0) {
    console.log(`\n${String(failed)} assertion(s) FAILED\n`)
    process.exit(1)
  }
  console.log(failed === 0 ? '\nEvery written chain passed.\n' : '')
}

main().catch((e) => {
  console.error('\nE2E RUNNER ERROR:', e)
  process.exit(1)
})
