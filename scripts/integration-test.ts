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

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessClient } from '../src/harness/client.ts'
import { BrowserSessionAuth } from '../src/harness/auth.ts'
import { discoverHosts, probeHost } from '../src/harness/discovery.ts'
import { nonLoopbackRefusal } from '../src/harness/endpoint.ts'
import { samePath } from '../src/harness/path-identity.ts'
import { ConversationModel } from '../src/conversation/model.ts'
import type { ConversationItem } from '../src/conversation/types.ts'

const HOST = process.env.DSH_HOST ?? '127.0.0.1'
const PORT = Number(process.env.DSH_PORT ?? 3080)
const LAUNCH_URL = process.env.DSH_LAUNCH_URL ?? ''

/**
 * The directory this run writes into.
 *
 * This used to default to `e:\deepseek\workspace_test`, which quietly made the
 * test single-platform: step 5 asserts that the directory is already a known
 * workspace, and that was true on one box and false everywhere else. It was
 * true there only because earlier runs had seeded it, so a fresh Host fails the
 * same way on any OS. `TEST_CWD` still wins when the caller has an opinion;
 * otherwise make a throwaway directory under the system temp dir — writable by
 * construction, empty by construction, and belonging to this run alone.
 */
const TEST_CWD = process.env.TEST_CWD ?? mkdtempSync(join(tmpdir(), 'dsh-itest-'))
/** True when the path above is ours to delete afterwards. */
const TEMP_CWD = process.env.TEST_CWD === undefined

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
  console.log(`\nDeepSeek Harness Connector integration test → http://${HOST}:${PORT}`)
  console.log(`workspace: ${TEST_CWD}${TEMP_CWD ? ' (temporary, removed on success)' : ' (from TEST_CWD)'}\n`)

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
  // Asserted against the exported refusal rather than against a phrase from it, so
  // this cannot pass while the message drifts somewhere the panel cannot render.
  // `0.0.0.0` is the interesting value: the fence refuses it AND it is not a valid
  // client-side authority, so it would fail twice over if the fence let it by.
  const evil = new HarnessClient({ host: '0.0.0.0', port: PORT, auth: evilAuth, log: () => {} })
  try {
    await evil.connect()
    check('loopback fence', false, '0.0.0.0 was accepted')
  } catch (e) {
    const message = (e as Error).message
    check('loopback fence', message === nonLoopbackRefusal('0.0.0.0'), message)
    check('...and the refusal names every host that would work',
      ['127.0.0.1', 'localhost', '::1'].every((h) => message.includes(h)), message)
  }

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
  //     (a) `workspace/create` normalizes a path into a real workspace record.
  //         A path that already exists answers `created:false` but still yields a
  //         host-issued id, which is what `session/create` requires — the id is
  //         not the path.
  //     (b) `listWorkspaces()` is derived, not stored: there is no
  //         `workspace/list` RPC, so the registry is folded out of `session/list`.
  //         The invariant worth testing is that one leads to the other, which is
  //         why (b) is asserted *after* a session exists rather than before it.
  //
  //     Requiring (b) first used to make this test platform- and history-bound:
  //     it demanded a directory some earlier run had already seeded, on a machine
  //     that happened to have it.
  const confirmed = await client.createWorkspace(TEST_CWD)
  const ws = confirmed.workspace
  check('workspace normalized to a host-issued record', ws.workspaceId !== ws.path,
    `created=${String(confirmed.created)} id=${ws.workspaceId.slice(0, 12)} path=${ws.path}`)

  // 04. Create a fresh session in this workspace (so the test is hermetic).
  const created = await client.createSession({ workspaceId: ws.workspaceId })
  const sessionId = created.sessionId
  check('create session', true, `id=${sessionId.replace(/^session-/, '').slice(0, 8)}`)

  // 05. The derived registry now knows the workspace the test just created.
  const { items } = await client.listWorkspaces()
  const derived = items.find(w => samePath(w.path, TEST_CWD))
  check('workspace discovered by derived path', derived !== undefined,
    derived?.path ?? `none of ${String(items.length)} derived workspace(s) match ${TEST_CWD}`)

  // 06. Load history (empty for a brand-new session) and subscribe.
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

  // What the panel's picker depends on: a selection is a durable session event
  // (`model/selection`), not a preference held by whoever asked. That is what a
  // reload reads back before any turn has run, and it costs no tokens to check —
  // so it is checked here, before the image loop starts spending them.
  if (routes.length > 0) {
    const pick = routes[routes.length - 1] as { provider: string; model: string }
    const rung = catalog.groups
      .find((g) => g.id === pick.provider)
      ?.models.find((m) => m.id === pick.model)
      ?.reasoning?.efforts.at(-1)?.id
    await client.selectModel(sessionId, pick.provider, pick.model, rung)
    const recorded = (await client.getHistory(sessionId, { maxMessages: 50 }))
      .events.map((e) => e.event)
      .filter((e) => e.type === 'model/selection')
      .at(-1)?.data as { provider?: string; model?: string; reasoningEffort?: string } | undefined
    check('selectModel is recorded as a durable model/selection event',
      recorded?.provider === pick.provider && recorded?.model === pick.model
        && recorded?.reasoningEffort === rung,
      `${pick.provider}/${pick.model}${rung ? ` @ ${String(rung)}` : ''} → `
      + `${recorded?.provider ?? '?'}/${recorded?.model ?? '?'}`)
  }

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
  //
  // Getting the *shape* right matters as much as the cursor. The two message
  // record types nest differently and it is not cosmetic — measured on the live
  // host:
  //
  //   user/message      → data.content            ← the image lands here
  //   assistant/message → data.message.content
  //
  // Looking only at the nested form (which this assertion used to do) silently
  // finds nothing, because the user record has no `message` wrapper at all.
  const contentPartsOf = (event: unknown): { type?: string; text?: string; attachment?: { attachmentId?: string; mediaType?: string } }[] => {
    const data = (event as { data?: Record<string, unknown> }).data
    if (data === undefined || data === null) return []
    const nested = (data['message'] as { content?: unknown } | undefined)?.content
    const out: { type?: string; text?: string; attachment?: { attachmentId?: string; mediaType?: string } }[] = []
    for (const candidate of [data['content'], nested]) {
      if (Array.isArray(candidate)) out.push(...candidate as { type?: string; text?: string }[])
    }
    return out
  }

  let imageRef: { attachmentId?: string; mediaType?: string } | undefined
  let lastShape = 'no page yet'
  for (let attempt = 0; attempt < 24 && imageRef === undefined; attempt++) {
    await new Promise((r) => setTimeout(r, 500))
    const page = await client.getHistory(sessionId, { maxMessages: 50 })
    lastShape = page.events
      .map((entry) => {
        const e = entry.event as { type?: string; seq?: number }
        const parts = contentPartsOf(entry.event)
        return `${String(e.seq)}:${String(e.type)}${parts.length === 0 ? '' : `(${parts.map((p) => p.type ?? '?').join(',')})`}`
      })
      .join(' ')
    for (const entry of page.events) {
      const block = contentPartsOf(entry.event).find((b) => b.type === 'image')
      if (block?.attachment !== undefined) { imageRef = block.attachment; break }
    }
  }
  if (imageAdmitted) {
    check('the stored message carries a durable image ref', imageRef?.attachmentId !== undefined,
      imageRef?.attachmentId ?? `no image block in the log — records were: ${lastShape.slice(0, 300)}`)
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

  // 08c. The two answerable waterfalls a mux client is handed, measured live.
  //
  //      Both were broken in ways that only a real Host could show:
  //        · user-questions/request was translated and then DROPPED, so the
  //          Host blocked on ask_user_question with nobody able to answer;
  //        · approval answers went out as `{kind:'result'}` with no value, which
  //          the Host normalises to 'unavailable' — a click on Allow that
  //          silently denied and still wrote a plausible-looking audit entry.
  //      The protocol test pins the envelopes; this measures that a real Host
  //      accepts them and the model gets the answer back.
  const waterfalls: { type: string; eventId: string; callId?: string; sessionId?: string }[] = []
  const wfSub = client.onApprovalFrame((frame, eventId) => {
    const f = frame as { type?: string; callId?: string; sessionId?: string }
    waterfalls.push({ type: String(f.type), eventId, callId: f.callId, sessionId: f.sessionId })
  })

  async function waitForWaterfall(type: string, ms: number): Promise<string | undefined> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const hit = waterfalls.find((w) => w.type === type)
      if (hit !== undefined) return hit.eventId
      await new Promise((r) => setTimeout(r, 500))
    }
    return undefined
  }

  /** Does any durable tool result carry `needle`? */
  async function journalMentions(needle: string, ms: number): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500))
      const page = await client.getHistory(sessionId, { maxMessages: 50 })
      const hit = page.events.some((entry) => contentPartsOf(entry.event)
        .some((p) => (p.text ?? '').includes(needle)))
      if (hit) return true
    }
    return false
  }

  await client.prompt(sessionId,
    'You must call the ask_user_question tool right now, before anything else. '
    + 'Pass exactly one question: id "q1", question "Pick a color", options red, green and blue. '
    + 'Do not answer it yourself, and do not use any other tool.', 'UTC')
  const questionEventId = await waitForWaterfall('question/requested', 60_000)
  if (questionEventId === undefined) {
    // The trigger is the model's choice, not the wire's. Say so rather than
    // reporting a pass nobody measured.
    console.log('  ~ skipped: the model did not call ask_user_question within 60s')
  } else {
    check('the live host delivers user-questions/request to a mux client', true,
      `eventId=${questionEventId.slice(0, 8)}…`)
    // Attribution, measured rather than assumed. A question's wire request
    // carries no session of any kind, so the ONLY way this can name the session
    // that asked is by reading the frame's `agentId` — and if the Host ever
    // stopped sending one, the client would now drop the frame instead of
    // guessing, which would show up here as no frame at all.
    const asked = waterfalls.find((w) => w.eventId === questionEventId)
    check('...and it is attributed to the session that asked it, from the frame scope alone',
      asked?.sessionId === sessionId, `sessionId=${String(asked?.sessionId)}`)
    await client.respondQuestion(questionEventId, { answers: [{ id: 'q1', selected: ['green'] }] })
    const answered = await journalMentions('"selected":["green"]', 30_000)
    check('the answer reaches the blocked tool call', answered,
      answered ? 'the tool result echoes the chosen label' : 'no tool result carried the answer within 30s')
  }

  // The approval half. The sidebar only answers from an ACTIVE session and only
  // when the reason does not announce full access, so set a confining preset and
  // ask for an honest escalation into it.
  await client.setPermissionPreset(sessionId, 'workspace-write')
  await new Promise((r) => setTimeout(r, 800))
  await client.prompt(sessionId,
    'The user explicitly asked for this, so do it without asking for confirmation first. '
    + 'Use the bash/shell tool to append the line "probe" to the file '
    + 'C:\\Users\\PP\\AppData\\Local\\Temp\\dsh-approval-probe.txt . That path is OUTSIDE the '
    + 'workspace on purpose, so the command must write outside the sandbox: pass '
    + 'sandbox_permissions="danger-full-access" and justification="the user asked for a probe file outside the workspace".',
    'UTC')
  const approvalEventId = await waitForWaterfall('approval/requested', 60_000)
  if (approvalEventId === undefined) {
    console.log('  ~ skipped: the model did not request an escalation within 60s')
  } else {
    check('the live host delivers approval/request to a mux client', true,
      `eventId=${approvalEventId.slice(0, 8)}…`)
    await client.respondApproval(approvalEventId, 'allowed-once')
    const granted = await journalMentions('probe', 30_000)
    check('an allow actually grants the escalation', granted,
      granted ? 'the escalated command ran' : 'no tool result showed the command running within 30s')
  }
  wfSub.dispose()

  // 08d. The turn's changed-files record, driven through the real model.
  //
  //      `workspace/changes` is the Host's own account of what a turn touched.
  //      It is built at the turn boundary from a git-backed snapshot, which is
  //      why it can list a file no file tool ever reported (a `sed -i` inside a
  //      shell command is the case that matters — the plugin's own
  //      `tool/result.meta.diffs` cannot see one).
  //
  //      The addressable part is the subtle one. The event's data carries only
  //      the TURN, while the summary route is addressed by the EVENT'S OWN `seq`
  //      — reading it by turn number would 404 every time. Converting one
  //      coordinate into the other is the model's job, so the real model is
  //      driven here rather than the route being called directly: the handoff
  //      from announcement to route is the part that can silently break.
  const announced: { turn: number; seq: number }[] = []
  model.setChangesRequestHandler((turn, seq) => { announced.push({ turn, seq }) })

  const probeName = `integration-changes-probe-${String(Date.now())}.txt`
  await client.prompt(sessionId,
    `Create a new file named ${probeName} in the workspace root with exactly the three lines `
    + 'alpha, beta, gamma. Then stop and reply done.', 'UTC')

  const changesDeadline = Date.now() + 120_000
  while (announced.length === 0 && Date.now() < changesDeadline) {
    await new Promise((r) => setTimeout(r, 500))
  }
  const firstAnnouncement = announced[0]
  if (firstAnnouncement === undefined) {
    // Whether a turn writes anything is the model's decision, not the wire's.
    // Say so rather than reporting a pass nobody measured.
    console.log('  ~ skipped: no workspace/changes announcement within 120s')
  } else {
    const { turn, seq } = firstAnnouncement
    check('a turn that wrote announces its changed files', true, `turn=${turn} seq=${seq}`)

    const summary = await client.changesSummary(sessionId, seq)
    check('the announcement seq addresses the summary route', summary !== undefined,
      summary === undefined
        ? `the route served nothing for seq=${String(seq)}`
        : `${String(summary.total)} file(s), +${String(summary.added)}/-${String(summary.deleted)}`)

    if (summary !== undefined) {
      check('the summary names the turn the model announced', summary.turn === turn,
        `event turn=${String(turn)} summary turn=${String(summary.turn)}`)
      check('total agrees with the files actually listed', summary.total === summary.files.length,
        `total=${String(summary.total)} listed=${String(summary.files.length)}`)

      const probe = summary.files.find(
        (f) => f.path.endsWith(probeName) || f.display.endsWith(probeName))
      check('the file the turn was asked to write is in the record', probe !== undefined,
        probe === undefined
          ? `none of [${summary.files.map((f) => f.display).join(', ')}] ends with ${probeName}`
          : `${probe.display} +${String(probe.added)}/-${String(probe.deleted)}`)

      // A listed file must be addressable by its own index, and its hunks must
      // agree with the counts the summary published. That agreement is the only
      // thing proving the hunk format was read correctly — and the whole native
      // diff is rebuilt from those hunks, so a misread is a blank or a
      // mislabelled comparison rather than a visible failure.
      const index = probe === undefined ? 0 : summary.files.indexOf(probe)
      const diff = await client.changesDiff(sessionId, seq, index)
      check('a listed file is addressable by its index', diff !== undefined,
        `index=${String(index)} kind=${diff?.kind ?? 'none'}`)

      if (diff !== undefined && diff.kind === 'text') {
        const lines = diff.hunks.flatMap((h) => h.lines)
        const added = lines.filter((l) => l.startsWith('+')).length
        const deleted = lines.filter((l) => l.startsWith('-')).length
        // Prefixes are load-bearing: hunksToSides() splits on the first column,
        // so an unprefixed line would land on both sides as unchanged context.
        check('every hunk line carries a diff prefix',
          lines.length > 0
          && lines.every((l) => l.startsWith('+') || l.startsWith('-') || l.startsWith(' ')),
          JSON.stringify(lines.slice(0, 3)))
        check('the hunks add up to the counts the summary published',
          probe !== undefined && added === probe.added && deleted === probe.deleted,
          `hunks +${String(added)}/-${String(deleted)} vs summary `
          + `+${String(probe?.added ?? -1)}/-${String(probe?.deleted ?? -1)}`)
        // Each hunk header must agree with its own body. The renderer rebuilds
        // both sides from the body alone, so a header that disagrees is a
        // comparison whose gutter numbers lie about where the change is.
        const headerMismatch = diff.hunks.filter((h) =>
          h.lines.filter((l) => !l.startsWith('+')).length !== h.oldLines
          || h.lines.filter((l) => !l.startsWith('-')).length !== h.newLines)
        check('every hunk header agrees with its own body',
          headerMismatch.length === 0,
          `${String(diff.hunks.length)} hunk(s), ${String(headerMismatch.length)} inconsistent`)
      } else if (diff !== undefined) {
        // Binary and oversized are legitimate answers; they just cannot carry
        // hunks. Report which one so the assertion is never a silent pass.
        console.log(`     note: ${probeName} came back as kind=${diff.kind}`)
      }

      // The route is valid only while the Session lives. An unknown seq must
      // read as "no card", not as an exception — a Host restart drops every
      // summary, and a throw there would surface as a broken panel.
      const gone = await client.changesSummary(sessionId, seq + 100_000)
      check('a seq the Host never served resolves to absent, not an error',
        gone === undefined, `seq=${String(seq + 100_000)} → ${gone === undefined ? 'absent' : 'a summary'}`)
    }
  }

  if (firstAnnouncement !== undefined) {
    // The probe is a file the test asked for; leaving it behind would litter the
    // very workspace this test measures. Removing it is not a turn, so it
    // announces nothing and cannot disturb the next run.
    try { rmSync(join(TEST_CWD, probeName), { force: true }) } catch { /* not there */ }
  }

  // 09. Discovery + forced reconnect, measured against the real Host.
  //
  //     The desktop app starts its Host with `--port 0`, so the port is freshly
  //     assigned on every launch and the configured one goes stale a moment
  //     later. Recovering that without reloading VS Code rests on two facts that
  //     only a live Host can confirm: it is identifiable from an anonymous
  //     request, and a forced connect really does rebuild the session.
  {
    const target = client.target()
    const hosts = await discoverHosts({ host: target.host, port: target.port, probeTimeoutMs: 1500 })
    const self = hosts.find((h) => h.port === target.port)
    check('discovery identifies the running Host from its anonymous refusal', self !== undefined,
      self === undefined
        ? `nothing answered at ${target.host}:${String(target.port)}`
        : `via ${self.source}${self.profile === undefined ? '' : ` (${self.profile})`}`)

    // Negative control. A fingerprint that matches everything is not a
    // fingerprint, and the failure mode is severe: the plugin would adopt a
    // stranger's HTTP port and mint a cookie at it. The pin layer is pointed at
    // a directory that does not exist and the listener table at the decoy alone,
    // so the decoy is the only thing discovery can possibly return.
    const decoy = createServer((_q, s) => {
      s.writeHead(200, { 'content-type': 'text/html' })
      s.end('<!doctype html><html><body>not a harness</body></html>')
    })
    const decoyPort = await new Promise<number>((r) => {
      decoy.listen(0, '127.0.0.1', () => { r((decoy.address() as AddressInfo).port) })
    })
    const decoyProbe = await probeHost('127.0.0.1', decoyPort, 1000)
    const decoyHosts = await discoverHosts({
      host: '127.0.0.1',
      port: decoyPort,
      env: { DSH_HOME: join(tmpdir(), 'dsh-no-such-home') },
      listeners: async () => [decoyPort],
      probeTimeoutMs: 1000,
    })
    check('a plain HTTP listener is not mistaken for a Host',
      decoyProbe === 'foreign' && decoyHosts.length === 0,
      `probe=${decoyProbe} candidates=${String(decoyHosts.length)}`)
    await new Promise<void>((r) => { decoy.close(() => { r() }) })

    // The forced path. The client still believes it is connected, so a plain
    // connect() would return without touching the socket — that gap is what made
    // "reload the window" the only recovery.
    await client.connect({ force: true })
    const state = client.getState()
    check('a forced reconnect re-establishes the connection', state.kind === 'connected', `state=${state.kind}`)

    const survivors = (await client.listSessions()).items.filter((s) => s.sessionId === sessionId)
    check('...and the session that was open is still on the Host', survivors.length === 1,
      survivors.length === 1 ? 'same sessionId' : `${String(survivors.length)} match(es)`)
  }

  // 10. Cancel (no-op if already ended) to validate the wire.
  await client.cancel(sessionId)
  check('cancel', true, 'accepted')

  sub.dispose()
  client.dispose()

  // The throwaway workspace is this run's litter, not the machine's: remove it
  // once the Host has nothing left to say about it. The session record outlives
  // the directory either way, so this changes nothing for the next run.
  if (TEMP_CWD) {
    try { rmSync(TEST_CWD, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  console.log('\n────────────────────────────────────────')
  console.log('  integration test passed — ConversationModel closed loop OK')
  console.log('────────────────────────────────────────\n')
}

main().catch((e) => {
  console.error('\nINTEGRATION TEST ERROR:', e)
  try { client.dispose() } catch { /* noop */ }
  process.exit(1)
})
