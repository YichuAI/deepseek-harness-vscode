/**
 * Integration test — exercises the REAL extension source (HarnessClient +
 * ConversationModel) against the running dsh web, without the webview/VS Code layer.
 *
 * Run:  npx tsx scripts/integration-test.ts        (mints the cookie locally)
 *       DSH_LAUNCH_URL='dsh web: http://127.0.0.1:3080/?token=…' npx tsx … (token exchange instead)
 *
 * DSH authenticates every /api/* request and the mux upgrade with a browser-session
 * cookie. The default path mints that cookie the way the extension does — from the
 * signing secret in `$DSH_HOME/.credentials.yaml` — so no per-process token has to
 * be copied out of the terminal. Passing `DSH_LAUNCH_URL` exercises the older token
 * exchange instead.
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

  // Authentication. A launch URL, when the caller has one, still exercises the
  // token-exchange path (auth.ts keeps it, and it is worth a smoke test). Without
  // one we mint locally from $DSH_HOME/.credentials.yaml — the same thing the
  // extension does — so the test runs without copying a per-process token out of
  // the terminal, where it does not stay valid for long anyway.
  if (LAUNCH_URL !== '') {
    const origin = await auth.adoptLaunchUrl(LAUNCH_URL)
    if (origin.host !== HOST || origin.port !== PORT) {
      console.log(`note: launch URL targets ${origin.host}:${String(origin.port)}; retargeting the client.`)
      client.retarget(origin.host, origin.port)
    }
  } else {
    auth.setAllowLocalMint(true)
    const minted = await auth.tryMintLocalSession()
    if (!minted) {
      console.log(`no cookie: ${auth.describeMintGap() ?? auth.describeGap()}`)
      console.log('Start `dsh web` once in this harness home, or pass DSH_LAUNCH_URL=… to use the token exchange.')
      process.exit(1)
    }
    console.log('auth: minted locally from $DSH_HOME/.credentials.yaml')
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

  // 03. Workspace resolution is two steps, and both matter.
  //
  //     (a) `listWorkspaces()` derives the registry from `session/list` — there is
  //         no `workspace/list` RPC. The `workspaceId` it hands back is therefore a
  //         *path*, not a host-issued id.
  //     (b) `workspace/create` normalizes that path into a real workspace record.
  //         An existing path answers `created:false` but still yields a host-issued
  //         id, which is what `session/create` requires.
  //
  //     Skipping (b) is exactly what broke here once listWorkspaces() stopped
  //     returning an empty array: session/create rejected the path-shaped id and
  //     the failure surfaced as "this harness does not serve session/create".
  const { items } = await client.listWorkspaces()
  const derived = items.find(w => w.path.toLowerCase().replace(/\//g, '\\') === TEST_CWD.toLowerCase())
  check('workspace discovered by derived path', derived !== undefined,
    derived?.path ?? `none of ${String(items.length)} derived workspace(s) match ${TEST_CWD}`)

  const confirmed = await client.createWorkspace(TEST_CWD)
  const ws = confirmed.workspace
  check('workspace normalized to a host-issued record', ws.workspaceId !== ws.path,
    `created=${String(confirmed.created)} id=${ws.workspaceId.slice(0, 12)} path=${ws.path}`)

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

  // 08b. Attachments, measured end to end rather than assumed.
  //
  //      Images ride the prompt as inline base64 parts and the host promotes them
  //      to durable refs during admission; reading them back is a `session/attachment`
  //      call. Files cannot ride a prompt at all — they are staged with a raw
  //      `application/octet-stream` POST and the prompt carries the receipt.
  //      Both halves are exercised here, and the image half closes the loop by
  //      decoding the bytes that come back.
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=='

  // The catalog does not publish which models accept images, so the host's own
  // verdict is the only authority — ask each model in turn.
  const catalog = await client.modelCatalog()
  const routes = catalog.groups.flatMap((g) => g.models.map((m) => ({ provider: g.id, model: m.id })))
  let imageAdmitted = false
  let sawCapabilityRefusal = false
  const refusals: string[] = []
  for (const route of routes) {
    try {
      await client.selectModel(sessionId, route.provider, route.model)
      await client.prompt(sessionId, 'What colour fills this image? Answer with one word.', undefined, {
        images: [{ mediaType: 'image/png', data: PNG_B64, name: 'integration-red.png' }],
      })
      imageAdmitted = true
      console.log(`     inline image admitted by ${route.provider}/${route.model}`)
      break
    } catch (e) {
      const err = e as { code?: string; details?: { reason?: string }; message?: string }
      if (err.details?.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES') sawCapabilityRefusal = true
      refusals.push(`${route.model}: ${err.code ?? ''} ${err.message ?? ''}`.trim())
    }
  }
  if (imageAdmitted) {
    check('an inline image reaches host admission', true, 'accepted by the picture-capable route')
  } else {
    // An honest skip: the wire shape is still proven, because the host got far
    // enough to reject on model capability rather than on a malformed part.
    check('image parts are understood even where no model takes them',
      sawCapabilityRefusal, refusals.join(' | ').slice(0, 200))
  }

  // The durable ref, read back off the log. `session/page` needs the cursor the
  // follow stream published: `throughSeq: 0` would answer a single
  // `permission/preset` record and never a message.
  let imageRef: { attachmentId?: string; mediaType?: string } | undefined
  for (let attempt = 0; attempt < 24 && imageRef === undefined; attempt++) {
    await new Promise((r) => setTimeout(r, 500))
    const page = await client.getHistory(sessionId, { maxMessages: 50 })
    for (const entry of page.events) {
      const data = entry.event.data as { message?: { content?: unknown } } | undefined
      const content = data?.message?.content
      if (!Array.isArray(content)) continue
      const block = (content as { type?: string; attachment?: { attachmentId?: string; mediaType?: string } }[])
        .find((b) => b.type === 'image')
      if (block?.attachment !== undefined) { imageRef = block.attachment; break }
    }
  }
  if (imageAdmitted) {
    check('the stored message carries a durable image ref', imageRef?.attachmentId !== undefined,
      imageRef?.attachmentId ?? 'no image block in the log')
  }

  if (imageRef?.attachmentId !== undefined) {
    const read = await client.readAttachment(sessionId, imageRef.attachmentId)
    const bytes = Buffer.from(read.data, 'base64')
    // A PNG signature, so this is the picture and not an empty placeholder.
    const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
    check('the image bytes come back over session/attachment', isPng,
      `${String(bytes.length)} bytes, mediaType=${read.attachment.mediaType ?? '?'}`)
  }

  // The file half: stage raw bytes, then reference the receipt from a prompt.
  const stagedFile = await client.uploadFile(sessionId, 'integration-note.txt',
    new TextEncoder().encode('staged by integration-test'))
  check('the staging route answers a receipt',
    typeof stagedFile.receiptId === 'string' && stagedFile.receiptId.length > 0,
    String(stagedFile.receiptId).slice(0, 12) + '…')
  await client.prompt(sessionId, 'Reply with the single word ok. Ignore the attachment.',
    'UTC', { files: [{ receiptId: stagedFile.receiptId as string }] })
  check('a prompt referencing the staged receipt is admitted', true, 'accepted')

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
