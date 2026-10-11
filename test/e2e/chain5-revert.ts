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
