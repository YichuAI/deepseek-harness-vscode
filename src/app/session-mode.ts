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
 * The pieces come from four different places (the launcher, the auth object, the
 * configured mode and `vscode.env`), which is exactly why the decision is made
 * here instead of inline: as an object it can be asserted without a VS Code host.
 *
 * It carries the **mode**, not a boolean about minting. An earlier version passed
 * `auth.localMintEnabled()`, and that single bit is `false` for two modes whose
 * remedies are opposites — `managed` (start the Host we were always going to
 * start) and `paste` (ask for the URL, and never start anything). Collapsing them
 * produced a message telling `paste` users to switch to `managed` and `managed`
 * users to switch to the mode they were already in.
 */
export interface OpenWebUiInput {
  /** The URL a Host we started printed. Absent unless this mode starts one. */
  launchedUrl: string | undefined
  /** The launch URL this session was adopted from, if the route kept one. */
  adoptedUrl: string | undefined
  /** The configured route, which is what decides the remedy. */
  mode: SessionMode
  /** Whether a usable cookie for the configured Host exists at all. */
  authenticated: boolean
  /** `vscode.env.remoteName`: set when the window is not the local machine. */
  remoteName: string | undefined
}

export type OpenWebUiPlan =
  | { kind: 'open'; url: string }
  /** `credentials`: only a Host we start prints a token. */
  | { kind: 'offer-managed'; reason: 'minted' | 'no-session' }
  /** `paste`: asking is the mode, not a fallback. */
  | { kind: 'ask-launch-url' }
  /** `managed`: start the Host, then read the URL it printed. */
  | { kind: 'start-managed' }
  /** A Host started here would land on a loopback this browser cannot reach. */
  | { kind: 'explain-remote'; reason: 'minted' | 'managed' }

/**
 * Decide what `DeepSeek Harness: Open Web UI` should do, instead of refusing.
 *
 * The harness gates its web UI per process: `/` answers `401` unless the request
 * carries either the process's launch token or the cookie that token mints, and
 * only the launch URL carries the token. That token is `randomBytes` kept in a
 * WeakMap inside the Host process (`browser-auth.ts`), so the `credentials` route
 * — which holds the signing secret and can mint a *cookie* byte-for-byte — still
 * cannot compose an authenticated URL.
 *
 * That much was always true; what was wrong was the branching. There is no case
 * here that has to end in a refusal, because **every mode can name a next step**:
 * `managed` starts the Host that prints a URL, `paste` asks for one, and
 * `credentials` can switch to the first. So the plan has no dead end short of a
 * remote window whose loopback is not the one the browser will use.
 *
 * Order matters. A URL we already hold beats one we would have to create; the
 * mode decides the remedy; and the remote check comes last, because it only
 * disqualifies the remedies that start something.
 */
export function planOpenWebUi(input: OpenWebUiInput): OpenWebUiPlan {
  if (input.launchedUrl !== undefined) return { kind: 'open', url: input.launchedUrl }
  if (input.adoptedUrl !== undefined) return { kind: 'open', url: input.adoptedUrl }

  const traits = traitsOf(input.mode)

  // `paste` reads nothing and starts nothing by design — the user chose it to
  // avoid exactly those two things — so being asked for the URL *is* the route.
  if (traits.expectsPaste) return { kind: 'ask-launch-url' }

  // Everything below would have to start a Host, and a Host started in a
  // Remote-SSH window listens on the remote's loopback while the browser this
  // command opens is on the laptop. A button that cannot work is worse than a
  // sentence that says why.
  if (input.remoteName !== undefined) {
    return { kind: 'explain-remote', reason: traits.startsHost ? 'managed' : 'minted' }
  }

  if (traits.startsHost) return { kind: 'start-managed' }

  // `credentials`: the missing cookie is not the obstacle, it is part of the
  // description. Minting produces a cookie and no token, so a Host started from
  // here is the only thing that prints us something a browser can use — whether
  // or not a cookie happens to be present. `reason` changes the explanation and
  // nothing else.
  return { kind: 'offer-managed', reason: input.authenticated ? 'minted' : 'no-session' }
}

/**
 * The copy for every outcome that does not open anything.
 *
 * Kept beside the decision so "what does this command say" is answerable in one
 * place, and so the strings can be asserted. Three of them take the target
 * because "which Host" is the first thing a reader needs and the last thing a
 * fixed sentence can say.
 */
export const OPEN_WEB_UI_TEXT = {
  offerManaged: {
    /** There is a cookie, and it is a minted one — so there is no token in it. */
    minted:
      'This session was minted from $DSH_HOME/.credentials.yaml, which does no token exchange, so '
      + 'there is no token for this command to add to a URL. A Host started from here prints one.',
    /** No cookie either. Still not a dead end: the Host we start issues its own. */
    noSession: (target: string): string =>
      `No browser session for ${target} is available — none is stored, or the stored one expired — `
      + 'and a minted session carries no token to put in a URL anyway. A Host started from here '
      + 'prints one.',
    action: 'Switch to managed and open',
    dismiss: 'Not now',
  },
  /** `paste`: the command owes the user the one thing the mode is built around. */
  askLaunchUrl: {
    message: (target: string): string =>
      `This window uses deepseekHarness.sessionMode "paste", so the extension reads no credential `
      + `file and starts no process for ${target}. Run \`dsh web\` — or open the desktop app — and `
      + 'paste the whole line it printed: that line carries the per-process token the browser needs.',
    action: 'Paste launch URL',
    dismiss: 'Not now',
  },
  explainRemote: {
    minted:
      'This session was minted from $DSH_HOME/.credentials.yaml, which does no token exchange, so '
      + 'there is no token for this command to add to a URL. Starting a Host here would start it on '
      + 'the remote, whose loopback this browser cannot reach — run `dsh web` on the machine you are '
      + 'sitting at and paste its URL with "DeepSeek Harness: Use Launch URL".',
    managed:
      'This window uses deepseekHarness.sessionMode "managed", so a Host would be started on the '
      + 'remote — and the browser this command opens is on the machine in front of you, whose '
      + 'loopback is not the remote\'s. Run `dsh web` on the machine you are sitting at and paste '
      + 'its line with "DeepSeek Harness: Use Launch URL".',
  },
  /** The mode switch landed, but an existing Host was adopted instead of started. */
  alreadyRunning: (target: string): string =>
    `DeepSeek Harness: a Host was already answering on ${target}, so none was started — and only `
    + 'the console of the process that started it printed its launch URL. Stop that Host and run '
    + 'this command again to have the extension start one it can open.',
  /** Nothing was adopted and nothing started: say what the connect itself said. */
  startFailed: (target: string, detail: string): string =>
    `DeepSeek Harness: could not start a Host on ${target} to open the web UI. ${detail}`,
} as const

