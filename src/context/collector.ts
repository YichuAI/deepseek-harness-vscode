/**
 * Context collector — gathers VS Code editor state into a PromptContext.
 *
 * Two responsibilities:
 *   1. Parse @file references from the prompt text.
 *      Syntax: @file:/abs/path          → whole file
 *              @file:/abs/path:L10      → single line
 *              @file:/abs/path:L10-L20  → line range
 *      The @file tokens are STRIPPED from the prompt text so they don't
 *      pollute the conversation KV cache.
 *
 *   2. Collect active editor state (selection, active file path).
 *      Only non-empty selections are included. The active file is always
 *      included when an editor is open.
 *
 * KV cache consistency: until DSH 0.1.6 the context travelled in
 * `payload.context`, a separate field the backend treated as ephemeral
 * metadata. That field was removed from `SessionPromptRequest`, so the
 * context is now rendered into the prompt *text* by `renderContextBlock()`
 * instead — placed after the message so the user's own words stay the stable
 * prefix of the turn.
 */

import type * as vscode from 'vscode'
import type {
  ActiveFileContext, FileReference, PromptContext, SelectionContext,
} from '../harness/protocol.ts'

/** Regex matching @file:path, @file:path:L10, @file:path:L10-L20.
 *  Path may contain any chars except whitespace; line ranges use L<digits>.
 *  The negative lookahead (?!L\d) prevents :L<digits> from being consumed
 *  as part of the path (critical for Windows paths like e:\folder\file.ts:L10). */
const AT_FILE_RE = /@file:([^\s:]+(?::(?!L\d)\\?[^\s:]*)*)(?::L(\d+)(?:-L(\d+))?)?/g

/**
 * Extract @file references from prompt text. Returns the cleaned text
 * (with @file tokens removed) and the parsed FileReference array.
 */
export function parseAtFileReferences(text: string): {
  cleanedText: string
  files: FileReference[]
} {
  const files: FileReference[] = []
  const cleanedText = text.replace(AT_FILE_RE, (_match, rawPath: string, lineStartStr?: string, lineEndStr?: string) => {
    // Normalize path: handle Windows drive letters (C:\... stays as-is)
    const filePath = rawPath.replace(/\\/g, '/')
    const ref: FileReference = { path: filePath }
    if (lineStartStr) {
      ref.lineStart = parseInt(lineStartStr, 10)
      if (lineEndStr) ref.lineEnd = parseInt(lineEndStr, 10)
    }
    files.push(ref)
    return '' // strip the @file token from the prompt text
  }).replace(/\s{2,}/g, ' ').trim()

  return { cleanedText, files }
}

/**
 * Collect context from the active VS Code editor.
 * Returns undefined if there's no meaningful context to attach.
 */
export function collectEditorContext(vscodeWindow: typeof vscode.window): PromptContext | undefined {
  const editor = vscodeWindow.activeTextEditor
  if (!editor) return undefined
  // Skip non-file documents (Output panel, Settings, etc.) — their URIs are not file paths
  if (editor.document.uri.scheme !== 'file') return undefined

  const ctx: PromptContext = {}

  // Active file
  const activeFile: ActiveFileContext = {
    path: editor.document.uri.fsPath.replace(/\\/g, '/'),
  }
  ctx.activeFile = activeFile

  // Selection (only non-empty)
  const sel = editor.selection
  if (!sel.isEmpty) {
    const selectedText = editor.document.getText(sel)
    if (selectedText.trim()) {
      const selection: SelectionContext = {
        text: selectedText,
        path: activeFile.path,
        lineStart: sel.start.line + 1, // 1-indexed
        lineEnd: sel.end.line + 1,
      }
      ctx.selection = selection
    }
  }

  return ctx
}

/**
 * Merge @file references into an existing PromptContext (from editor state).
 * @file refs take priority — they're explicit user intent.
 */
export function mergeContext(
  editorCtx: PromptContext | undefined,
  atFileRefs: FileReference[],
): PromptContext | undefined {
  if (atFileRefs.length === 0 && !editorCtx) return undefined

  const merged: PromptContext = { ...editorCtx }

  if (atFileRefs.length > 0) {
    // Deduplicate by path+range
    const existing = new Set(
      (merged.files ?? []).map(f => `${f.path}:${f.lineStart ?? ''}:${f.lineEnd ?? ''}`)
    )
    const newRefs = atFileRefs.filter(f => {
      const key = `${f.path}:${f.lineStart ?? ''}:${f.lineEnd ?? ''}`
      return !existing.has(key)
    })
    merged.files = [...(merged.files ?? []), ...newRefs]
  }

  return merged
}

/**
 * Render a PromptContext as a text block appended to the prompt.
 *
 * DSH 0.1.6 removed the `context` field from `SessionPromptRequest`, so editor
 * metadata has to travel inside the message. The block is appended *after* the
 * user's own words: the turn's stable prefix therefore stays the user's text,
 * and successive prompts with the same preamble keep a shared KV prefix.
 *
 * @param ctx - collected editor/@file context, or undefined.
 * @returns the block, or an empty string when there is nothing to say.
 */
export function renderContextBlock(ctx: PromptContext | undefined): string {
  if (!ctx) return ''
  const lines: string[] = []
  if (ctx.activeFile?.path) {
    lines.push(`- Active file: ${ctx.activeFile.path}`)
  }
  if (ctx.files && ctx.files.length > 0) {
    for (const f of ctx.files) {
      const range = f.lineStart
        ? `:L${String(f.lineStart)}${f.lineEnd ? `-L${String(f.lineEnd)}` : ''}`
        : ''
      lines.push(`- Referenced file: ${f.path}${range}`)
    }
  }
  if (ctx.selection) {
    const { path, lineStart, lineEnd, text } = ctx.selection
    lines.push(
      `- Selection in ${path}:L${String(lineStart)}-L${String(lineEnd)}:`,
      '```',
      text,
      '```',
    )
  }
  if (lines.length === 0) return ''
  return `<context>\n${lines.join('\n')}\n</context>`
}
