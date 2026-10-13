/**
 * A `vscode` module stub, installed by patching Node's CJS loader.
 *
 * `src/review/materializer.ts` imports VS Code for one runtime call
 * (`Uri.file`) and reaches the filesystem through `workspace.fs`. That module is
 * only resolvable inside an Extension Host, so a plain Node test has to supply
 * the module itself. This is the same technique `scripts/protocol-test.ts` uses;
 * it lives here as a module so the e2e suite can reuse it without importing that
 * script (which would run the whole protocol suite twice).
 *
 * What the stub deliberately does **not** do is simulate a filesystem. `Uri.file`
 * keeps the real path and the caller passes a real `fs`, so a revert test reads
 * and writes actual bytes on disk. A simulated filesystem here would let the
 * test agree with the implementation instead of catching it.
 */

import type { RevertWorkspace } from '../../src/review/materializer.ts'

export interface StubTextDocument {
  fileName: string
  isDirty: boolean
}

/**
 * The slice of `vscode.workspace` a revert touches.
 *
 * Taken from the materializer itself rather than restated here: a second copy
 * would drift, and the drift would show up as a test that mocks something the
 * production code stopped calling.
 */
export type StubWorkspace = RevertWorkspace

export async function loadMaterializer(): Promise<typeof import('../../src/review/materializer.ts')> {
  const moduleApi = await import('node:module')
  const loadable = (moduleApi.default ?? moduleApi) as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const original = loadable._load
  const stubUri = (p: string): Record<string, unknown> => ({
    fsPath: p, scheme: 'file', path: p, toString: () => 'file://' + p,
  })
  const stub: Record<string, unknown> = {
    Uri: { file: stubUri, parse: stubUri },
    Position: class { constructor(public line: number, public character: number) {} },
    Range: class { constructor(public start: unknown, public end: unknown) {} },
    Disposable: class { dispose(): void {} },
    EventEmitter: class { event = (): void => undefined; fire(): void {}; dispose(): void {} },
    window: {}, workspace: {}, commands: {}, languages: {}, env: {},
  }
  loadable._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return stub
    return original.call(this, request, parent, isMain)
  }
  return import('../../src/review/materializer.ts')
}
