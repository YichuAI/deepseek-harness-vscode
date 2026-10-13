/**
 * Chain 5 — "the agent changed a file, I changed it again, now Revert must not
 * eat my work".
 *
 * This is the one chain on the end-to-end list with a real hazard rather than a
 * correctness bug: getting it wrong destroys a user's edits with no undo, and
 * the failure is silent — the file simply contains the wrong thing afterwards.
 *
 * It is written here, ahead of the other four, because it is the only chain that
 * does not need a VS Code Extension Host to be tested honestly. `ReviewMaterializer`
 * takes the workspace API as a constructor argument, so it can be handed a stub
 * whose `fs` is the **real** filesystem and be driven against a real temp
 * directory. That matters: a simulated filesystem would let the test agree with
 * the implementation instead of catching it.
 *
 * What this file covers, in the order a user would hit it:
 *   1. the ordinary case — nothing moved, the revert restores the old bytes
 *   2. the case in the checklist — the file moved, the revert REFUSES, and the
 *      user's bytes are still on disk afterwards
 *   3. unsaved editor changes — same refusal, named differently
 *   4. a file the turn created, unedited → removed
 *   5. a file the turn created, then edited → refused, file survives
 *   6. a file the tool deleted → restored
 *   7. two hunks in one file: undo one, keep the other — and then the other,
 *      which is the case the whole-file guard used to make impossible
 *   8. the same two, undone in the other order
 *   9. a file already half-undone, still revertible whole
 *  10. an edit made after a hunk undo still refuses the next hunk
 *  11. clicking undo twice writes once
 *  12. a hunk undo on a file the call deleted, and on one it created
 *  13. a review with no captured text refuses instead of reporting success
 *
 * Run: npm run e2e-test   (or: node node_modules/tsx/dist/cli.mjs test/e2e/run.ts)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReviewStore } from '../../src/review/store.ts'
import { loadMaterializer, type StubTextDocument, type StubWorkspace } from './vscode-stub.ts'

export interface ChainResult {
  name: string
  passed: number
  failed: number
  failureDetail?: string
}

/** A workspace stub whose `fs` is the real filesystem. */
function realWorkspace(textDocuments: StubTextDocument[] = []): StubWorkspace {
  return {
    textDocuments,
    fs: {
      async readFile(uri) { return new Uint8Array(readFileSync(uri.fsPath)) },
      async writeFile(uri, content) { writeFileSync(uri.fsPath, Buffer.from(content)) },
      async delete(uri) { rmSync(uri.fsPath, { force: true }) },
    },
  }
}

export async function runChain5(): Promise<ChainResult> {
  const { ReviewMaterializer } = await loadMaterializer()

  const name = 'File changes (revert vs. later edits)'
  let passed = 0
  let failed = 0
  const details: string[] = []

  const check = (label: string, ok: boolean, detail = ''): void => {
    if (ok) { passed++; console.log(`  ✓ ${label}`) }
    else { failed++; details.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-revert-'))

  /** Build a review whose file is `path`, as a file tool would have left it. */
  const reviewFor = (store: ReviewStore, path: string, before: string | null, after: string | null) => {
    const id = store.createFromToolResult({
      sessionId: 'session-e2e',
      callId: `call-${String(store.forSession('session-e2e').length + 1)}`,
      toolName: 'write',
      arguments: '{}',
      resultMeta: { diffs: [{ path, before, after }] },
    })
    if (id === undefined) throw new Error('e2e: the store refused to build a review for ' + path)
    const review = store.getById(id)!
    const file = review.files.find((f) => f.path === path)!
    return { id, review, file }
  }

  /** The same, for a tool that replaced two separate regions of one file. */
  const reviewWithHunks = (
    store: ReviewStore,
    path: string,
    before: string | null,
    after: string | null,
    hunks: Array<{ oldText: string | null; newText: string }>,
  ) => {
    const id = store.createFromToolResult({
      sessionId: 'session-e2e',
      callId: `call-${String(store.forSession('session-e2e').length + 1)}`,
      toolName: 'edit',
      arguments: '{}',
      resultMeta: { diffs: [{ path, before, after, hunks }] },
    })
    if (id === undefined) throw new Error('e2e: the store refused to build a review for ' + path)
    const review = store.getById(id)!
    const file = review.files.find((f) => f.path === path)!
    const hunk = (hunkId: string) => {
      const found = file.hunks.find((h) => h.id === hunkId)
      if (found === undefined) throw new Error(`e2e: no hunk ${hunkId} in ${path}`)
      return found
    }
    return { id, review, file, hunk }
  }

  // A two-hunk edit: the tool changed one line in each half of the file.
  const baseText = 'alpha\none\nbeta\ntwo\ngamma\n'
  const editedText = 'alpha\nONE\nbeta\nTWO\ngamma\n'
  const halfUndone = 'alpha\nONE\nbeta\ntwo\ngamma\n'
  const twoHunks = [{ oldText: 'one', newText: 'ONE' }, { oldText: 'two', newText: 'TWO' }]

  try {
    // ── 1. the ordinary case ────────────────────────────────────────────────
    {
      const path = join(dir, 'untouched.txt')
      writeFileSync(path, 'after\n')
      const store = new ReviewStore()
      const { review, file } = reviewFor(store, path, 'before\n', 'after\n')
      const result = await new ReviewMaterializer(realWorkspace()).rejectFile(review, file)
      check('an untouched file reverts', result.ok === true, JSON.stringify(result))
      check('...and the old bytes are what is on disk', readFileSync(path, 'utf8') === 'before\n')
    }

    // ── 2. the checklist case: the user edited it after the turn ────────────
    {
      const path = join(dir, 'edited-by-user.txt')
      writeFileSync(path, 'after\n')
      const store = new ReviewStore()
      const { review, file } = reviewFor(store, path, 'before\n', 'after\n')

      // The user's edit lands between the turn and the undo.
      writeFileSync(path, 'after\nplus my own work\n')

      const result = await new ReviewMaterializer(realWorkspace()).rejectFile(review, file)
      check('a file edited since the turn is REFUSED', result.ok === false, JSON.stringify(result))
      check('...the refusal is classified as stale', result.ok === false && result.reason === 'stale',
        result.ok === false ? result.reason : 'ok')
      check('...and the user’s bytes are still on disk untouched',
        readFileSync(path, 'utf8') === 'after\nplus my own work\n',
        JSON.stringify(readFileSync(path, 'utf8')))
      check('...the reason names the file, so the card can explain itself',
        result.ok === false && result.message.includes(path))
    }

    // ── 3. unsaved changes in an open editor ────────────────────────────────
    {
      const path = join(dir, 'dirty-editor.txt')
      writeFileSync(path, 'after\n')
      const store = new ReviewStore()
      const { review, file } = reviewFor(store, path, 'before\n', 'after\n')

      const workspace = realWorkspace([{ fileName: path, isDirty: true }])
      const result = await new ReviewMaterializer(workspace).rejectFile(review, file)
      check('an open, unsaved editor blocks the revert', result.ok === false)
      check('...as its own reason, not as drift', result.ok === false && result.reason === 'dirty',
        result.ok === false ? result.reason : 'ok')
      check('...and the disk is not written to', readFileSync(path, 'utf8') === 'after\n')
    }

    // ── 4. a file the turn created, unedited ────────────────────────────────
    {
      const path = join(dir, 'created.txt')
      writeFileSync(path, 'brand new\n')
      const store = new ReviewStore()
      const { review, file } = reviewFor(store, path, null, 'brand new\n')
      const result = await new ReviewMaterializer(realWorkspace()).rejectFile(review, file)
      check('a file the turn created is removed', result.ok === true, JSON.stringify(result))
      let gone = false
      try { readFileSync(path); } catch { gone = true }
      check('...and it is really gone', gone)
    }

    // ── 5. a file the turn created, then edited ─────────────────────────────
    {
      const path = join(dir, 'created-then-edited.txt')
      writeFileSync(path, 'brand new\n')
      const store = new ReviewStore()
      const { review, file } = reviewFor(store, path, null, 'brand new\n')

      writeFileSync(path, 'brand new\nand mine\n')
      const result = await new ReviewMaterializer(realWorkspace()).rejectFile(review, file)
      check('a created-then-edited file is refused, not deleted', result.ok === false)
      check('...so the user’s file survives', readFileSync(path, 'utf8') === 'brand new\nand mine\n')
    }

    // ── 6. a file the tool deleted ──────────────────────────────────────────
    {
      const path = join(dir, 'deleted-by-tool.txt')
      // The tool removed it; the review recorded that.
      const store = new ReviewStore()
      const { review, file } = reviewFor(store, path, 'was here\n', null)
      const result = await new ReviewMaterializer(realWorkspace()).rejectFile(review, file)
      check('a file the turn deleted is restored', result.ok === true, JSON.stringify(result))
      check('...with its old contents', readFileSync(path, 'utf8') === 'was here\n')
    }

    // ── 7. two hunks in one file: undo one, keep the other ──────────────────
    //
    // This is the assertion the whole release exists for. Before it, the first
    // hunk-level undo poisoned every later one: the guard compared the file to
    // the tool's original result, the file no longer matched, and the rest of
    // the turn came back "has been modified since this review was created".
    {
      const path = join(dir, 'two-hunks.txt')
      writeFileSync(path, editedText)
      const store = new ReviewStore()
      const { id, review, file, hunk } = reviewWithHunks(store, path, baseText, editedText, twoHunks)

      const second = await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h1'))
      check('undoing the second of two hunks succeeds', second.ok === true, JSON.stringify(second))
      check('...and takes only that hunk out of the file',
        readFileSync(path, 'utf8') === halfUndone, JSON.stringify(readFileSync(path, 'utf8')))

      // The controller records this after a successful revert, and the guard
      // reads it back on the next one — so the test must do it too, or it would
      // be asserting against a state the app never produces.
      store.setHunkState(id, path, 'h1', 'rejected')

      const first = await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h0'))
      check('...and the FIRST hunk is still undoable afterwards', first.ok === true, JSON.stringify(first))
      check('...reaching the file’s original bytes', readFileSync(path, 'utf8') === baseText,
        JSON.stringify(readFileSync(path, 'utf8')))
    }

    // ── 8. the same two, undone the other way round ─────────────────────────
    {
      const path = join(dir, 'two-hunks-reverse.txt')
      writeFileSync(path, editedText)
      const store = new ReviewStore()
      const { id, review, file, hunk } = reviewWithHunks(store, path, baseText, editedText, twoHunks)

      const first = await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h0'))
      check('the user may pick the first hunk first', first.ok === true, JSON.stringify(first))
      check('...leaving the second where it is',
        readFileSync(path, 'utf8') === 'alpha\none\nbeta\nTWO\ngamma\n',
        JSON.stringify(readFileSync(path, 'utf8')))

      store.setHunkState(id, path, 'h0', 'rejected')
      const second = await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h1'))
      check('...and then the second one', second.ok === true, JSON.stringify(second))
      check('...also reaching the original bytes', readFileSync(path, 'utf8') === baseText)
    }

    // ── 9. a half-undone file can still be reverted whole ───────────────────
    //
    // Without this the file-level button would strand the file: it is offered
    // while the file is 'partial', and the old guard would have refused it
    // because the file no longer equalled the tool's result.
    {
      const path = join(dir, 'partial-then-file.txt')
      writeFileSync(path, editedText)
      const store = new ReviewStore()
      const { id, review, file, hunk } = reviewWithHunks(store, path, baseText, editedText, twoHunks)
      await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h1'))
      store.setHunkState(id, path, 'h1', 'rejected')

      const whole = await new ReviewMaterializer(realWorkspace()).rejectFile(review, file)
      check('a file already half-undone still reverts whole', whole.ok === true, JSON.stringify(whole))
      check('...because the guard expects the undo it already made',
        readFileSync(path, 'utf8') === baseText, JSON.stringify(readFileSync(path, 'utf8')))
    }

    // ── 10. an edit after a hunk undo still stops the next hunk ─────────────
    //
    // The rule that must survive the new leniency. Accounting for our own undo
    // must not become "anything goes".
    {
      const path = join(dir, 'partial-then-user-edit.txt')
      writeFileSync(path, editedText)
      const store = new ReviewStore()
      const { id, review, file, hunk } = reviewWithHunks(store, path, baseText, editedText, twoHunks)
      await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h1'))
      store.setHunkState(id, path, 'h1', 'rejected')

      writeFileSync(path, halfUndone + 'and mine\n')
      const refused = await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h0'))
      check('an edit made after a hunk undo still blocks the next one', refused.ok === false)
      check('...classified as drift, not as something else',
        refused.ok === false && refused.reason === 'stale', refused.ok === false ? refused.reason : 'ok')
      check('...and the user’s line survives',
        readFileSync(path, 'utf8') === halfUndone + 'and mine\n',
        JSON.stringify(readFileSync(path, 'utf8')))
    }

    // ── 11. clicking undo twice ─────────────────────────────────────────────
    {
      const path = join(dir, 'double-click.txt')
      writeFileSync(path, editedText)
      const store = new ReviewStore()
      const { id, review, file, hunk } = reviewWithHunks(store, path, baseText, editedText, twoHunks)
      await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h1'))
      store.setHunkState(id, path, 'h1', 'rejected')

      const again = await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h1'))
      check('undoing a hunk twice is a no-op, not an error', again.ok === true, JSON.stringify(again))
      check('...and writes nothing the second time', readFileSync(path, 'utf8') === halfUndone)
    }

    // ── 12. the two ends of a diff, where a hunk has only one side ──────────
    {
      const path = join(dir, 'deleted-by-tool-hunk.txt')
      const store = new ReviewStore()
      const { review, file, hunk } = reviewWithHunks(store, path, 'was here\n', null, [
        { oldText: 'was here\n', newText: '' },
      ])
      const result = await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h0'))
      check('a hunk undo on a file the call deleted restores it',
        result.ok === true, JSON.stringify(result))
      check('...with its old contents', readFileSync(path, 'utf8') === 'was here\n')
    }
    {
      const path = join(dir, 'created-by-tool-hunk.txt')
      writeFileSync(path, 'brand new\n')
      const store = new ReviewStore()
      const { review, file, hunk } = reviewWithHunks(store, path, null, 'brand new\n', [
        { oldText: null, newText: 'brand new\n' },
      ])
      const result = await new ReviewMaterializer(realWorkspace()).rejectHunk(review, file, hunk('h0'))
      check('a hunk undo on a file the call created removes it',
        result.ok === true, JSON.stringify(result))
      let gone = false
      try { readFileSync(path) } catch { gone = true }
      check('...since there is no earlier version to patch towards', gone)
    }

    // ── 13. a diff with no captured text ────────────────────────────────────
    //
    // A review built from a tool call alone. It cannot be reverted, and the
    // honest answer is to say so: this path used to fall through to the
    // "new file" branch and DELETE the file.
    {
      const path = join(dir, 'no-diff.txt')
      writeFileSync(path, 'on disk\n')
      const store = new ReviewStore()
      const id = store.createFromToolResult({
        sessionId: 'session-e2e',
        callId: 'call-no-diff',
        toolName: 'edit',
        arguments: JSON.stringify({ path, oldText: 'old', newText: 'new' }),
        resultMeta: {},
      })
      if (id === undefined) throw new Error('e2e: expected a review built from arguments alone')
      const review = store.getById(id)!
      const file = review.files.find((f) => f.path === path)!

      const result = await new ReviewMaterializer(realWorkspace()).rejectFile(review, file)
      check('a review with no captured text refuses', result.ok === false)
      check('...saying what is missing rather than reporting a phantom success',
        result.ok === false && result.reason === 'no-diff', result.ok === false ? result.reason : 'ok')
      check('...and above all does not delete the file',
        readFileSync(path, 'utf8') === 'on disk\n', JSON.stringify(readFileSync(path, 'utf8')))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  return {
    name,
    passed,
    failed,
    ...(details.length > 0 ? { failureDetail: details.join('; ') } : {}),
  }
}
