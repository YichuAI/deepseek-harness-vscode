/**
 * Workspace binding — split resolve (read-only discovery) from ensure
 * (create-on-demand at send-time).
 *
 * v0.0.2 change: workspace creation is NOT part of the connect flow. The UI
 * remains usable when no matching harness workspace exists; the binding is
 * promoted from `pending` → `registered` only when the user actually sends
 * the first prompt. No confirmation modals.
 */

import * as path from 'node:path'
import type * as vscode from 'vscode'
import type { HarnessClient } from '../harness/client.ts'
import type { WorkspaceView } from '../harness/protocol.ts'

export interface WorkspaceBinding {
  folder: vscode.WorkspaceFolder
  harness?: WorkspaceView
  /** True once `harness` came back from `workspace/create` (host-issued id). */
  confirmed?: boolean
}

/** Normalize a directory path for matching against harness canonical paths. */
function normalizeFsPath(p: string): string {
  let norm = p.replace(/\//g, '\\')
  if (/^[a-z]:/.test(norm)) {
    const head = norm[0]
    if (head !== undefined) norm = head.toUpperCase() + norm.slice(1)
  }
  if (norm.length > 2 && norm.endsWith('\\')) norm = norm.slice(0, -1)
  return norm
}

/** Pick the VS Code folder to bind to. Same resolution order as §9. */
export async function pickVsCodeFolder(
  workspace: typeof vscode.workspace,
  window: typeof vscode.window,
): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = workspace.workspaceFolders
  if (!folders || folders.length === 0) return undefined
  if (folders.length === 1) return folders[0]

  const active = window.activeTextEditor
  if (active) {
    const owning = workspace.getWorkspaceFolder(active.document.uri)
    if (owning) return owning
  }

  const picked = await window.showQuickPick(
    folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { placeHolder: 'Select the workspace folder to bind to DeepSeek Harness', title: 'DeepSeek Harness: Workspace' },
  )
  return picked?.folder
}

/** Read-only discovery: resolve a harness workspace matching the folder.
 *  Returns undefined when no match exists — does NOT create one. */
export async function findHarnessWorkspace(
  client: HarnessClient,
  folder: vscode.WorkspaceFolder,
): Promise<WorkspaceView | undefined> {
  const target = normalizeFsPath(folder.uri.fsPath)
  const { items } = await client.listWorkspaces()
  return items.find(w => normalizeFsPath(w.path) === target)
}

/** Lazy ensure: resolve-or-create the harness workspace for a binding.
 *  Called the first time the user sends a prompt on a pending binding.
 *  No user confirmation — creation is implicit at write-time.
 *
 *  A workspace discovered by {@link findHarnessWorkspace} is *derived* from
 *  `session/list` (rc.2 has no `workspace/list`), so its `workspaceId` is a
 *  path, not a host-issued id. Passing that to `session/create` would be
 *  wrong. `workspace/create` is idempotent — the host returns the existing
 *  workspace with `created:false` — so we always go through it at write-time
 *  to obtain the authoritative workspace before creating a session. */
export async function ensureHarnessWorkspace(
  client: HarnessClient,
  binding: WorkspaceBinding,
): Promise<WorkspaceView> {
  if (binding.harness) {
    if (binding.confirmed) return binding.harness
    const confirmed = await client.createWorkspace(binding.harness.path)
    binding.harness = confirmed.workspace
    binding.confirmed = true
    return confirmed.workspace
  }
  const created = await client.createWorkspace(binding.folder.uri.fsPath)
  binding.harness = created.workspace
  binding.confirmed = true
  return created.workspace
}

/** Format a workspace path for display (basename when short, else abbreviated). */
export function shortWorkspacePath(ws: WorkspaceView): string {
  const base = path.basename(ws.path) || ws.path
  return ws.title && ws.title !== base ? `${ws.title} (${base})` : base
}
