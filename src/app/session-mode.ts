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
