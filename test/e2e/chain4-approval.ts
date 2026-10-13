/**
 * Chain 4 — "allow, reject, withdraw, and a Host that refuses the answer".
 *
 * Why this chain exists at all
 * ----------------------------
 * The changelog says "Allow" once never actually granted anything. The cause was
 * one field: the decision has to travel in `outcome.value`, and a bare
 * `{kind:'result'}` resolves the Host's waterfall with `undefined`, which
 * `ApprovalService.decide` normalizes to `'unavailable'` — a **fail-closed deny
 * that still writes a plausible-looking audit entry**. Nothing looks wrong from
 * the extension's side. The card goes away, the tool does not run, and the only
 * evidence is in the Host's log.
 *
 * That is a wire-contract bug, and the only way to test it honestly is to put a
 * real envelope on a real socket and read what arrived. So every assertion here
 * is about the bytes the Host received, not about what the client thinks it sent.
 *
 * What it covers:
 *   1. an approval arrives as a renderable frame, carrying tool name and reason
 *   2. allowing posts `{kind:'result', value:'allowed-once'}` — value present
 *   3. rejecting posts `{kind:'result', value:'rejected'}`
 *   4. the clientId is the one the Host issued, not an empty string
 *   5. answering an event nobody saw throws, and posts nothing
 *   6. a Host that refuses the POST rejects the promise and keeps the card open
 *   7. delegation posts `{kind:'next'}` and then forgets the frame
 *   8. a withdrawn waterfall resolves the card, and cannot be answered after
 *   9. a question answer travels as an object whose `selected` is the LABEL
 */

import { BrowserSessionAuth, type AuthStore } from '../../src/harness/auth.ts'
import { HarnessClient } from '../../src/harness/client.ts'
import { startFakeHarness, type FakeHarnessHost, type RecordedEventResult } from './fake-host.ts'
import type { ChainResult } from './chain5-revert.ts'

function memoryStore(): AuthStore {
  let value: string | undefined
  return {
    load: async (): Promise<string | undefined> => value,
    save: async (v: string | undefined): Promise<void> => { value = v },
  }
}

/** One answer, as the Host saw it. */
type Outcome = { kind?: unknown; value?: unknown }

function outcomeOf(rec: RecordedEventResult | undefined): Outcome {
  if (rec === undefined) return {}
  const o = rec.outcome
  return (typeof o === 'object' && o !== null ? o : {}) as Outcome
}

export async function runChain4(): Promise<ChainResult> {
  const name = 'Approvals (allow, reject, withdraw, refusal)'
  let passed = 0
  let failed = 0
  const details: string[] = []

  const check = (label: string, ok: boolean, detail = ''): void => {
    if (ok) { passed++; console.log(`  ✓ ${label}`) }
    else { failed++; details.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
  }

  let host: FakeHarnessHost | undefined
  let client: HarnessClient | undefined

  /** Wait for the client to surface the next waterfall frame. */
  const nextFrame = (): Promise<{ type: string; approvalId?: string; toolName?: string; reason?: string }> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { sub.dispose(); reject(new Error('timed out waiting for a waterfall frame')) }, 3000)
      const sub = client!.onApprovalFrame((frame) => {
        clearTimeout(timer)
        sub.dispose()
        resolve(frame as unknown as { type: string })
      })
    })
  }

  try {
    host = await startFakeHarness()
    const auth = new BrowserSessionAuth({
      host: host.host, port: host.port, store: memoryStore(), log: () => undefined, allowLocalMint: false,
    })
    client = new HarnessClient({ host: host.host, port: host.port, auth, log: () => undefined })
    await auth.adoptLaunchUrl(host.launchUrl)
    await client.connect({ force: true })

    const issuedClientId = client.describe().clientId
    check('connected, and the Host issued a clientId', typeof issuedClientId === 'string' && issuedClientId !== '',
      String(issuedClientId))

    // ── 1. an approval arrives renderable ───────────────────────────────────
    {
      const framePromise = nextFrame()
      const delivered = host.emitApproval('evt-allow', { toolName: 'bash', reason: 'needs to run a command' })
      check('the Host delivered the waterfall to a connected client', delivered === 1, `${String(delivered)} socket(s)`)
      const frame = await framePromise
      check('it surfaces as approval/requested', frame.type === 'approval/requested', frame.type)
      check('...carrying the event id the answer must quote', frame.approvalId === 'evt-allow', String(frame.approvalId))
      check('...and the tool name, so the card can say what is being asked',
        frame.toolName === 'bash', String(frame.toolName))
      check('...and the reason, which is what the approval gate reads', frame.reason === 'needs to run a command',
        String(frame.reason))
    }

    // ── 2. allow ────────────────────────────────────────────────────────────
    {
      await client.respondApproval('evt-allow', 'allowed-once')
      const rec = host.eventResults.at(-1)
      const outcome = outcomeOf(rec)
      check('allowing posts to the waterfall sink', rec !== undefined)
      check('...with outcome.kind === "result"', outcome.kind === 'result', String(outcome.kind))
      // The whole point. A bare `{kind:'result'}` silently denies the call.
      check('...AND the decision in outcome.value — the field whose absence caused the fail-closed deny',
        outcome.value === 'allowed-once', JSON.stringify(outcome))
      check('...quoting the event id it answers', rec?.eventId === 'evt-allow', String(rec?.eventId))
      check('...and the Host-issued clientId, never an empty string',
        rec?.clientId === issuedClientId, JSON.stringify(rec?.clientId))
      const envelope = rec?.envelope ?? {}
      check('...as a client-request envelope naming $events/result',
        rec?.envelopeType === 'client-request' && rec?.method === '$events/result',
        `${JSON.stringify(rec?.envelopeType)} / ${JSON.stringify(rec?.method)} (envelope ${JSON.stringify(envelope['type'])})`)
    }

    // ── 3. reject ───────────────────────────────────────────────────────────
    {
      const framePromise = nextFrame()
      host.emitApproval('evt-deny', { toolName: 'write', reason: 'wants to write outside the workspace' })
      await framePromise
      await client.respondApproval('evt-deny', 'rejected')
      const outcome = outcomeOf(host.eventResults.at(-1))
      check('rejecting posts value "rejected", not a missing value', outcome.value === 'rejected', JSON.stringify(outcome))
      check('...keeping kind === "result" so the waterfall still settles',
        outcome.kind === 'result', String(outcome.kind))
    }

    // ── 4. answering an unseen event must not post anything ────────────────
    {
      const before = host.eventResults.length
      let threw = false
      try { await client.respondApproval('evt-never-seen', 'allowed-once') } catch { threw = true }
      check('answering an event nobody observed throws', threw)
      check('...and the Host received nothing — no fail-closed deny was smuggled through',
        host.eventResults.length === before,
        `${String(host.eventResults.length)} vs ${String(before)}`)
    }

    // ── 5. a Host that refuses the answer ──────────────────────────────────
    {
      const framePromise = nextFrame()
      host.emitApproval('evt-refused', { toolName: 'bash', reason: 'why not' })
      await framePromise

      host.failEventResults = true
      const before = host.eventResults.length
      let threw = false
      let message = ''
      try { await client.respondApproval('evt-refused', 'allowed-once') } catch (e) {
        threw = true
        message = e instanceof Error ? e.message : String(e)
      }
      host.failEventResults = false

      check('a refused POST rejects the promise rather than looking like success', threw)
      // The actionable part is the status and the Host's own words, not the port
      // — the request demonstrably arrived, so the port is not in question.
      check('...saying it was a refusal, and quoting what the Host said back',
        /refused the answer/i.test(message) && message.includes('the Host refused the answer'),
        JSON.stringify(message.slice(0, 160)))
      check('...and the attempt still reached the Host, so this is a refusal and not a routing miss',
        host.eventResults.length > before)
      // Because the frame was not discarded, the card can be retried instead of
      // being left in a state that claims the approval was answered.
      let retryOk = true
      try { await client.respondApproval('evt-refused', 'rejected') } catch { retryOk = false }
      check('...and the approval is still answerable afterwards, so a failed answer does not settle the card', retryOk)
      check('...with the retry actually sent', outcomeOf(host.eventResults.at(-1)).value === 'rejected')
    }

    // ── 5b. a 200 that still says no ───────────────────────────────────────
    {
      const framePromise = nextFrame()
      host.emitApproval('evt-declined', { toolName: 'bash', reason: 'why not' })
      await framePromise

      host.declineEventResults = true
      let threw = false
      let message = ''
      try { await client.respondApproval('evt-declined', 'allowed-once') } catch (e) {
        threw = true
        message = e instanceof Error ? e.message : String(e)
      }
      host.declineEventResults = false

      check('a 200 whose envelope says ok:false is still a refusal', threw)
      check('...and the Host’s own error message is what the user sees',
        message.includes('no longer holds a delivery'), JSON.stringify(message.slice(0, 160)))
    }

    // ── 6. delegation ───────────────────────────────────────────────────────
    {
      const framePromise = nextFrame()
      host.emitApproval('evt-delegate', { toolName: 'bash', reason: 'answer in the browser' })
      await framePromise
      await client.delegateWaterfall('evt-delegate')
      const outcome = outcomeOf(host.eventResults.at(-1))
      check('delegating posts kind "next" and no value', outcome.kind === 'next' && outcome.value === undefined,
        JSON.stringify(outcome))
      let threw = false
      try { await client.respondApproval('evt-delegate', 'allowed-once') } catch { threw = true }
      check('...and the frame is forgotten, so a second answer fails loudly instead of no-op silently', threw)
    }

    // ── 7. withdrawal ───────────────────────────────────────────────────────
    {
      const framePromise = nextFrame()
      host.emitApproval('evt-withdrawn', { toolName: 'bash', reason: 'another client answered' })
      await framePromise
      const resolved = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { sub.dispose(); resolve(false) }, 3000)
        const sub = client!.onApprovalFrame((frame) => {
          if ((frame as { type?: string }).type === 'waterfall/resolved') { clearTimeout(timer); sub.dispose(); resolve(true) }
        })
      })
      host.withdrawWaterfall('evt-withdrawn')
      check('a withdrawn waterfall resolves the card', await resolved)
      let threw = false
      try { await client.respondApproval('evt-withdrawn', 'allowed-once') } catch { threw = true }
      check('...and can no longer be answered', threw)
    }

    // ── 8. questions ────────────────────────────────────────────────────────
    {
      const framePromise = nextFrame()
      host.emitQuestion('evt-question', {
        wait: { callId: 'call-42' },
        questions: [{ id: 'q1', header: 'Which?', question: 'Pick one', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
      })
      const frame = await framePromise
      check('a question surfaces as question/requested', frame.type === 'question/requested', frame.type)

      await client.respondQuestion('evt-question', { answers: [{ id: 'q1', selected: ['Beta'] }] })
      const outcome = outcomeOf(host.eventResults.at(-1))
      check('the answer travels in outcome.value as an object, not as a bare string',
        typeof outcome.value === 'object' && outcome.value !== null, JSON.stringify(outcome.value))
      const answers = (outcome.value as { answers?: Array<{ id?: unknown; selected?: unknown }> }).answers ?? []
      check('...with one answer per question id', answers[0]?.id === 'q1', JSON.stringify(answers[0]))
      // Not the index: `selected` carries the option's LABEL, which is what the
      // Host compares against. An index here selects nothing. It is a list
      // rather than a string because one question may allow several choices.
      const selected = answers[0]?.selected
      check('...and `selected` carries the option LABELS, not their indices',
        Array.isArray(selected) && selected.length === 1 && selected[0] === 'Beta',
        JSON.stringify(selected))
    }
  } catch (e) {
    failed++
    details.push(`chain threw: ${e instanceof Error ? e.message : String(e)}`)
    console.log(`  ✗ chain threw — ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    try { client?.dispose() } catch { /* noop */ }
    try { await host?.kill() } catch { /* noop */ }
  }

  return { name, passed, failed, ...(details.length > 0 ? { failureDetail: details.join('; ') } : {}) }
}
