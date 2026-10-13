/**
 * The canned asks the editor / Explorer / Source Control context menus
 * pre-fill into the composer.
 *
 * Deliberately a pure module — no `vscode`, no I/O — because the exact strings
 * are asserted in protocol-test. A prompt that drops its target, or one
 * phrased for the wrong thing ("this file" when the user had three lines
 * selected), is otherwise invisible until after the user has sent it.
 *
 * Nothing here sends. A quick task writes into the composer and stops, so the
 * person still reads and edits what goes to the agent — the same stance the
 * plugin takes on file writes.
 */

/** What the user right-clicked. */
export type QuickScope = 'selection' | 'file' | 'change'

/** What they asked for. */
export type QuickAsk = 'explain' | 'fix' | 'review'

/** How each scope is named inside the sentence. */
const NOUN: Record<QuickScope, string> = {
  selection: 'code',
  file: 'file',
  change: 'change',
}

/**
 * URI schemes that name a file the Host can actually open.
 *
 * An allowlist rather than a denylist because the failure is silent: a mention
 * built from a `git:` HEAD side or a GitLens revision looks exactly like a
 * path, and the Host answers it with a file-not-found long after the person has
 * stopped thinking about where the text came from.
 *
 * `vscode-remote` is what VS Code gives every remote scenario — Remote-SSH,
 * WSL, Dev Containers, tunnels — so as far as `@` mentions are concerned this
 * set *is* the remote support matrix. The Host itself is reached over
 * loopback, which is a separate constraint (see the README table).
 */
const OPENABLE_SCHEMES = new Set(['file', 'vscode-remote'])

/** Whether a URI with this scheme is the file itself, not a view of one. */
export function isOpenableScheme(scheme: string): boolean {
  return OPENABLE_SCHEMES.has(scheme)
}

/** The instruction line the composer opens with. */
export function quickAskPrompt(ask: QuickAsk, scope: QuickScope): string {
  const noun = NOUN[scope]
  switch (ask) {
    case 'explain': return `Explain what this ${noun} does.`
    case 'fix': return `Fix the problems in this ${noun}.`
    case 'review': return `Review this ${noun} and point out anything wrong.`
  }
}

/**
 * The instruction line and the mention, on separate lines.
 *
 * Two lines rather than one so the mention — the part that decides *what* the
 * agent actually reads — stays visible and can be deleted on its own. The
 * trailing space matters: the webview appends to whatever is already in the
 * composer, so the text must end where the next token can start.
 */
export function quickAskInput(prompt: string, mention: string): string {
  return `${prompt}\n${mention} `
}
