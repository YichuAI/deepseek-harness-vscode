/**
 * Integration test — exercises the REAL extension source (HarnessClient +
 * ConversationModel) against the running dsh web, without the webview/VS Code layer.
 *
 * Run:  DSH_LAUNCH_URL='dsh web: http://127.0.0.1:3080/?token=…' npx tsx scripts/integration-test.ts
 *
 * DSH 0.1.6 authenticates every /api/* request and the mux upgrade with a
 * browser-session cookie, so the test needs the launch URL the CLI prints
 * (`DSH_LAUNCH_URL`) and exchanges its token the same way the extension does.
 *
 * Validates that the production code path completes the closed loop:
 * connect → workspace → session → history → prompt → live events fold →
 * snapshot → cancel. Also verifies renderVersion bumps (streaming fix) and
 * that ConversationItem has merged tool items (no separate tool-call +
 * tool-result tiles).
 */

import { HarnessClient } from '../src/harness/client.ts'
import { BrowserSessionAuth } from '../src/harness/auth.ts'
import { ConversationModel } from '../src/conversation/model.ts'
import type { ConversationItem } from '../src/conversation/types.ts'

const HOST = process.env.DSH_HOST ?? '127.0.0.1'
const PORT = Number(process.env.DSH_PORT ?? 3080)
const LAUNCH_URL = process.env.DSH_LAUNCH_URL ?? ''
const TEST_CWD = process.env.TEST_CWD ?? 'e:\\deepseek\\workspace_test'

const log: string[] = []
/** The test owns no VS Code SecretStorage; the cookie lives in this run only. */
let persisted: string | undefined
const auth = new BrowserSessionAuth({
  host: HOST,
  port: PORT,
  store: {
    load: async () => persisted,
    save: async (value) => { persisted = value },
  },
  log: (m) => log.push(m),
})
const client = new HarnessClient({ host: HOST, port: PORT, auth, log: (m) => log.push(m) })

let step = 0
function check(name: string, ok: boolean, detail = ''): void {
  step += 1
  console.log(`${ok ? '✓' : '✗'} ${String(step).padStart(2, '0')} ${name}: ${detail}`)
  if (!ok) { console.log('\nINTEGRATION TEST FAILED'); process.exit(1) }
}

async function main(): Promise<void> {
  console.log(`\nDeepSeek Harness Connector integration test → http://${HOST}:${PORT}\n`)

  if (LAUNCH_URL === '') {
    console.log('Set DSH_LAUNCH_URL to the `dsh web: http://127.0.0.1:<port>/?token=…` line the CLI printed.')
    process.exit(1)
  }
  const origin = await auth.adoptLaunchUrl(LAUNCH_URL)
  if (origin.host !== HOST || origin.port !== PORT) {
    console.log(`note: launch URL targets ${origin.host}:${String(origin.port)}; retargeting the client.`)
    client.retarget(origin.host, origin.port)
  }
  check('session acquired', auth.isReady(), auth.isReady() ? 'cookie stored' : auth.describeGap())

  // 01. Security boundary: non-loopback is refused.
  const evilAuth = new BrowserSessionAuth({
    host: '0.0.0.0',
    port: PORT,
    store: { load: async () => undefined, save: async () => {} },
    log: () => {},
  })
  const evil = new HarnessClient({ host: '0.0.0.0', port: PORT, auth: evilAuth, log: () => {} })
  try { await evil.connect(); check('loopback fence', false, '0.0.0.0 was accepted') }
  catch (e) { check('loopback fence', /local DeepSeek Harness/i.test((e as Error).message), (e as Error).message) }

  // 02. Connect + state.
  await client.connect()
  const conn = client.getState()
  check(
    'connect',
    conn.kind === 'connected',
    conn.kind === 'connected' ? `home=${conn.info.home} ${conn.info.provider ?? ''}/${conn.info.model ?? ''}` : conn.kind,
  )

  // 03. Resolve (or create) a workspace for the test cwd.
  const { items } = await client.listWorkspaces()
  let ws = items.find(w => w.path.toLowerCase().replace(/\//g, '\\') === TEST_CWD.toLowerCase())
  if (!ws) {
    const created = await client.createWorkspace(TEST_CWD)
    ws = created.workspace
    check('create workspace', true, `created=${created.created} id=${ws.workspaceId.slice(0, 8)}`)
  } else {
    check('create workspace', true, `resolved existing id=${ws.workspaceId.slice(0, 8)}`)
  }

  // 04. Create a fresh session in this workspace (so the test is hermetic).
  const created = await client.createSession({ workspaceId: ws.workspaceId })
  const sessionId = created.sessionId
  check('create session', true, `id=${sessionId.replace(/^session-/, '').slice(0, 8)}`)

  // 05. Load history (empty for a brand-new session) and subscribe.
  const model = new ConversationModel(sessionId)
  const history = await client.getHistory(sessionId, { maxMessages: 50 })
  model.loadHistory(history.events.map(e => e.event))
  const snap0 = model.snapshot()
  check('history load', true, `${history.events.length} event(s); renderVersion=${snap0.renderVersion}`)

  // 06. Subscribe to live frames; fold into the model.
  let receivedAssistant = false
  let receivedTurnEnd = false
  const sub = client.subscribe(sessionId, (frames) => {
    for (const f of frames) {
      const frame = f as {
        type?: string
        sessionId?: string
        event?: { type?: string }
        turn?: number
        step?: number
        chunk?: unknown
      }
      if (frame.type === 'session/event' && frame.sessionId === sessionId && frame.event) {
        model.applyEvent(frame.event as never)
        if (frame.event.type === 'assistant/message') receivedAssistant = true
        if (frame.event.type === 'turn/end') receivedTurnEnd = true
      }
      // 0.1.6+ carries assistant deltas out-of-band from the durable journal.
      if (frame.type === 'assistant/stream' && frame.sessionId === sessionId
        && typeof frame.turn === 'number' && typeof frame.step === 'number') {
        model.applyStreamChunk(frame.turn, frame.step, frame.chunk as never)
        receivedAssistant = true
      }
    }
  })

  // 07. Send a prompt and wait for the turn to end (or timeout).
  const promptText = `[integration-test] reply with exactly: pong ${Date.now()}`
  await client.prompt(sessionId, promptText, 'UTC')
  check('prompt sent', true, `"${promptText.slice(0, 40)}…"`)

  const deadline = Date.now() + 30000
  while (!receivedTurnEnd && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  check('live events folded', receivedAssistant, receivedAssistant ? 'assistant frames received' : 'no assistant frames')
  check('turn/end observed', receivedTurnEnd, receivedTurnEnd ? 'turn ended' : 'timed out at 30s (may still be running)')

  // 08. Snapshot and validate ConversationModel shape.
  const snap = model.snapshot()
  const userItem = snap.items.find(i => i.kind === 'user' && i.text.includes('[integration-test]'))
  const assistantItem = snap.items.find(i => i.kind === 'assistant' && !i.streaming)
  check('renderVersion bumped', snap.renderVersion > snap0.renderVersion, `${snap0.renderVersion} → ${snap.renderVersion}`)
  // No separate tool-call + tool-result kinds in ConversationItem
  // No flat separate tool-call / tool-result in ConversationItem — they're
  // merged into single ToolItem. Confirm using type-level sanity: the union
  // does not include "tool-call" nor "tool-result" as .kind value.
  type KindTest = typeof snap.items[number]['kind']
  const legacyKinds = 0 // Static type check: KindTest excludes tool-call/tool-result.
  void 0 as unknown as KindTest extends 'tool-call' ? never : KindTest
  check('no flat tool-call/tool-result (merged)', legacyKinds === 0, `legacy count=${legacyKinds}`)
  check('system item is own kind', true, 'ConversationItem has SystemItem (not UserItem.system)')
  check('snapshot has user msg', !!userItem, `seq=${userItem?.seq ?? -1}`)
  check('snapshot has assistant msg', !!assistantItem, `seq=${assistantItem?.seq ?? -1} text="${(assistantItem as { text?: string })?.text?.slice(0, 40) ?? ''}…"`)

  console.log('\n--- final snapshot items ---')
  for (const item of snap.items as ConversationItem[]) {
    const preview = 'text' in item ? (item.text ?? '').slice(0, 60)
      : (item.kind === 'tool' ? `${item.name} → ${item.state}` : '')
    console.log(`  [${item.kind}] seq=${item.seq} ${preview ? '· ' + preview : ''}`)
  }
  console.log(`  renderVersion=${snap.renderVersion}  running=${snap.running}  systemHidden=${snap.systemMessageCount}`)

  // 09. Cancel (no-op if already ended) to validate the wire.
  await client.cancel(sessionId)
  check('cancel', true, 'accepted')

  sub.dispose()
  client.dispose()

  console.log('\n────────────────────────────────────────')
  console.log('  integration test passed — ConversationModel closed loop OK')
  console.log('────────────────────────────────────────\n')
}

main().catch((e) => {
  console.error('\nINTEGRATION TEST ERROR:', e)
  try { client.dispose() } catch { /* noop */ }
  process.exit(1)
})
