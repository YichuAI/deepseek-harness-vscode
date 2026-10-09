/**
 * Context collector — `@file` mention handling for the composer.
 *
 * The grammar is the harness's own, not this plugin's invention
 * (`@deepseek-ai/dsh-file-reference/grammar`, shared by the terminal and the
 * web composer):
 *
 *   @path                  a mention at the start of input or after whitespace
 *   @"path with spaces"    quoting is required when the path contains whitespace
 *   @dir/                  a directory keeps its trailing slash
 *
 * A mention is ordinary prompt text. Nothing is attached and nothing is read:
 * the host's `FILE_REFERENCE_PROMPT` guidance tells the model to call a
 * filesystem tool when it wants the contents. This module used to inline the
 * referenced file's bytes into the message instead, which is what "add to chat
 * pasted the whole file" was — it made every re-send of the same mention a
 * fresh, uncacheable copy of the file.
 *
 * This module owns two things only:
 *   1. `findMentions` — what the composer is currently pointing at, for the
 *      chip preview. It never rewrites the text.
 *   2. `formatMention` — the exact string a pick or a context-menu command
 *      should insert.
 *
 * There is a second, deliberately duplicated copy of the grammar inside the
 * webview script (`src/view/client.ts`), because the webview cannot import
 * extension-host code. Both are pinned by the protocol tests.
 */

/** One `@` mention found in composer text. */
export interface FileMention {
  /** Path exactly as typed, without the leading `@` and without line-range suffix. */
  path: string
  /** Whether the mention was written in the quoted form. */
  quoted: boolean
  /** 1-indexed inclusive start line, when the mention carried `:L<n>` / `:L<n>-L<m>`. */
  lineStart?: number
  /** 1-indexed inclusive end line, when the mention carried a range. */
  lineEnd?: number
  /** Index of the `@` in the source text. */
  start: number
  /** Index just past the whole mention. */
  end: number
}

/**
 * `@"…"` or `@bare`, each optionally followed by `:L<n>` / `:L<n>-L<m>`.
 *
 * The bare form excludes `"` so a quoted mention cannot be swallowed by it, and
 * the range suffix is matched outside the closing quote so
 * `@"my file.ts":L10-L20` parses as one mention.
 */
const MENTION_RE = /@(?:"([^"\n]*)"|([^\s"]+))(?::L(\d+)(?:-L(\d+))?)?/g

/** True when `@` at `index` is a mention trigger (start of text or after whitespace). */
function triggersAt(text: string, index: number): boolean {
  if (index === 0) return true
  const prev = text[index - 1] ?? ''
  // An `@` inside another token (an email address is the common case) is not a
  // mention: the grammar only fires at the start of input or after whitespace.
  return /\s/u.test(prev)
}

/**
 * Find every `@` mention in the composer text.
 *
 * Read-only: unlike the old `@file:` parser this never strips anything, because
 * the mention *is* the payload the model should see.
 */
export function findMentions(text: string): FileMention[] {
  const found: FileMention[] = []
  const re = new RegExp(MENTION_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (!triggersAt(text, m.index)) continue
    const quoted = m[1] !== undefined
    const path = (quoted ? m[1] : m[2]) ?? ''
    if (path === '') continue
    const mention: FileMention = {
      path,
      quoted,
      start: m.index,
      end: m.index + m[0].length,
    }
    if (m[3] !== undefined) {
      mention.lineStart = parseInt(m[3], 10)
      if (m[4] !== undefined) mention.lineEnd = parseInt(m[4], 10)
    }
    found.push(mention)
  }
  return found
}

export interface FormatMentionOptions {
  /** Directory candidates keep a trailing slash (and stay quoted if quoted). */
  kind?: 'file' | 'directory'
  /** Retain an explicitly opened quote even when the path would not need one. */
  preserveQuote?: boolean
  /** 1-indexed line or line range to append as `:L<n>` / `:L<n>-L<m>`. */
  lineStart?: number
  lineEnd?: number
}

/**
 * Render a path as prompt text, mirroring the host's `formatFileMention`.
 *
 * @returns the mention, or `undefined` for a path the grammar cannot express
 *          safely (a control character, or an embedded double quote).
 */
export function formatMention(filePath: string, opts: FormatMentionOptions = {}): string | undefined {
  const normalized = filePath.replace(/\\/g, '/')
  const withSlash = opts.kind === 'directory' && !normalized.endsWith('/') ? `${normalized}/` : normalized
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(withSlash)) return undefined
  const quoted = opts.preserveQuote === true || /\s/u.test(withSlash)
  const head = quoted ? `@"${withSlash}"` : `@${withSlash}`
  if (opts.lineStart === undefined) return head
  const range = opts.lineEnd === undefined || opts.lineEnd === opts.lineStart
    ? `:L${String(opts.lineStart)}`
    : `:L${String(opts.lineStart)}-L${String(opts.lineEnd)}`
  return head + range
}
