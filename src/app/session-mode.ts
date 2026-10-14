/**
 * session-mode.ts — the three ways this extension can obtain a Harness session.
 *
 * Until now there was really only one, and a boolean pretending to be a choice.
 * `autoSession: false` did not mean "use the other route"; it meant "do not
 * authenticate", because the command that would have offered the other route had
 * been unregistered. A switch that can only turn things off is not a setting, it
 * is a trap, and it made the extension look like it could not work without
 * reading `$DSH_HOME/.credentials.yaml` — a file that also holds the user's model
 * API keys, which is the single largest reason not to install this plugin.
 *
 * So the boolean becomes a mode, and each mode names what it does:
 *
 *   credentials — read the signing secret, mint the cookie locally.
 *                 Zero friction. Requires reading a file full of secrets.
 *   managed     — start `dsh web` ourselves and take the launch URL it prints.
 *                 No credential file, no paste. Requires starting a process.
 *   paste       — ask the user for the launch URL of a Host they started.
 *                 Reads nothing, starts nothing. Requires a copy-paste.
 *
 * The default stays `credentials` so that upgrading changes nothing for anyone
 * already using the extension, and the two new routes are explicit choices
 * rather than surprises.
 *
 * Kept separate from both `extension.ts` (which reads configuration) and
 * `controller.ts` (which acts on it) so that "what does this mode actually
 * permit" is answered in exactly one place — and can be asserted without a
 * VS Code host.
 */

export type SessionMode = 'credentials' | 'managed' | 'paste'

/** In the order they appear in the settings dropdown. */
export const SESSION_MODES: readonly SessionMode[] = ['credentials', 'managed', 'paste']

/** What a mode implies for the rest of the system. */
export interface SessionModeTraits {
  /** Whether the local-mint path may read `$DSH_HOME/.credentials.yaml`. */
  allowLocalMint: boolean
  /** Whether this extension may start `dsh web` on its own. */
  startsHost: boolean
  /** Whether the user is expected to paste a launch URL. */
  expectsPaste: boolean
}

/**
 * An unknown or absent value falls back to the default rather than throwing.
 *
 * Settings are user-editable JSON, so `sessionMode` can legitimately be a typo,
 * a number, or absent (a workspace override that sets only `port`, say). Refusing
 * to start over a bad enum would be a worse failure than picking the default.
 */
export function parseSessionMode(raw: unknown): SessionMode {
  return typeof raw === 'string' && (SESSION_MODES as readonly string[]).includes(raw)
    ? (raw as SessionMode)
    : 'credentials'
}

const TRAITS: Record<SessionMode, SessionModeTraits> = {
  credentials: { allowLocalMint: true, startsHost: false, expectsPaste: false },
  // Deliberately not `allowLocalMint`: a managed launch hands us a fresh cookie
  // from a Host we own, and reading the credential file anyway would defeat the
  // reason for choosing this mode.
  managed: { allowLocalMint: false, startsHost: true, expectsPaste: false },
  paste: { allowLocalMint: false, startsHost: false, expectsPaste: true },
}

export function traitsOf(mode: SessionMode): SessionModeTraits {
  return TRAITS[mode]
}

/** The palette command that completes the `paste` route. */
export const USE_LAUNCH_URL_COMMAND = 'deepseekHarness.useLaunchUrl'

/**
 * Everything `Open Web UI` can know about what we hold, as plain values.
 *
 * The pieces come from four different places (the launcher, the auth object,
 * the config-derived local-mint flag and `vscode.env`), which is exactly why the
 * decision is made here instead of inline: as an object it can be asserted
 * without a VS Code host, and the failure that motivated this — a command that
 * could only ever refuse — was a branching problem, not a plumbing one.
 */
export interface OpenWebUiInput {
  /** The URL a Host we started printed. Absent unless this mode starts one. */
  launchedUrl: string | undefined
  /** The launch URL this session was adopted from, if the route kept one. */
  adoptedUrl: string | undefined
  /** True when the cookie was minted from `$DSH_HOME/.credentials.yaml`. */
  mintedLocally: boolean
  /** Whether a usable cookie for the configured Host exists at all. */
  authenticated: boolean
  /** `vscode.env.remoteName`: set when the window is not the local machine. */
  remoteName: string | undefined
}

export type OpenWebUiPlan =
  | { kind: 'open'; url: string }
  | { kind: 'offer-managed' }
  | { kind: 'explain-minted-remote' }
  | { kind: 'explain-no-url' }

/**
 * Decide what `DeepSeek Harness: Open Web UI` should do, instead of refusing.
 *
 * The harness gates its web UI per process: `/` answers `401` unless the request
 * carries either the process's launch token or the cookie that token mints, and
 * only the launch URL carries the token. That token is `randomBytes` kept in a
 * WeakMap inside the Host process (`browser-auth.ts`), so the `credentials` route
 * — which holds the signing secret and can mint a *cookie* byte-for-byte — still
 * cannot compose an authenticated URL. The old command answered every case with
 * that fact, and it is true, but it was answering the wrong question: two of the
 * three routes do hold a URL, and on the third we can get one by starting a Host
 * ourselves, which is a thing this extension is allowed to do.
 *
 * Order matters. A URL we already hold beats one we would have to create, and
 * `offer-managed` only survives the remote check because a Host started in a
 * Remote-SSH window listens on the *remote's* loopback while the browser this
 * command opens is on the laptop.
 */
export function planOpenWebUi(input: OpenWebUiInput): OpenWebUiPlan {
  if (input.launchedUrl !== undefined) return { kind: 'open', url: input.launchedUrl }
  if (input.adoptedUrl !== undefined) return { kind: 'open', url: input.adoptedUrl }

  // Only the minted route has a way out, and only while it is actually
  // authenticated: offering to start a Host to somebody whose cookie is missing
  // would fix the wrong problem.
  if (!input.mintedLocally || !input.authenticated) return { kind: 'explain-no-url' }
  if (input.remoteName !== undefined) return { kind: 'explain-minted-remote' }
  return { kind: 'offer-managed' }
}

/**
 * The copy for every outcome that does not open anything.
 *
 * Kept beside the decision so "what does this command say" is answerable in one
 * place, and so the strings can be asserted — the previous wording is how the
 * command came to look broken: it described the constraint accurately and never
 * mentioned that a Host started from here would lift it.
 */
export const OPEN_WEB_UI_TEXT = {
  offerManaged: {
    message:
      'This session was minted from $DSH_HOME/.credentials.yaml, which does no token exchange, so '
      + 'there is no token for this command to add to a URL. A Host started from here prints one.',
    action: 'Switch to managed and open',
    dismiss: 'Not now',
  },
  /** The button cannot help from a window whose browser is on another machine. */
  mintedRemote:
    'This session was minted from $DSH_HOME/.credentials.yaml, which does no token exchange, so '
    + 'there is no token for this command to add to a URL. Starting a Host here would start it on '
    + 'the remote, whose loopback this browser cannot reach — run `dsh web` on the machine you are '
    + 'sitting at and paste its URL with "DeepSeek Harness: Use Launch URL".',
  /** No reusable URL on this route, and nothing we could start to get one. */
  noUrl:
    'Open the web UI with the URL `dsh web` printed to its console — it carries the per-process '
    + 'token the browser needs. The extension authenticates on its own; set '
    + 'deepseekHarness.sessionMode to "managed" and it will start the Host itself, which also '
    + 'lets this command open the web UI for you.',
  /** The mode switch landed, but an existing Host was adopted instead of started. */
  alreadyRunning:
    'DeepSeek Harness: a Host was already answering on the configured port, so none was started — '
    + 'and only the console of the process that started it printed its launch URL. Stop that Host '
    + 'and run this command again to have the extension start one it can open.',
} as const
