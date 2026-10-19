/**
 * Path identity — one definition of "the same file", so nobody re-derives it.
 *
 * Two things in here need this and used to disagree about it: the launcher, when
 * it decides whether a directory is already on `PATH`, and the live integration
 * test, when it decides whether a Host knows the workspace it just created. The
 * test had its own copy and got it wrong in a way only Linux could show — it
 * hard-coded a Windows path and compared raw strings.
 *
 * `platform` is a parameter rather than `process.platform` so both halves can be
 * exercised on one machine, which is the whole point: the failure this replaces
 * was invisible on the platform it was written on.
 */

/**
 * The key two paths are compared by.
 *
 * Separators are not meaning on Windows, where both forms name one directory;
 * on POSIX a backslash is an ordinary filename character and must stay one.
 * Trailing separators are never meaning. Case is meaning on POSIX and is not on
 * Windows. Nothing here resolves symlinks or `..` — that needs the filesystem,
 * and every caller compares paths it already has in absolute form.
 */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const separators = platform === 'win32' ? /[\\/]+/g : /\/+/g
  const normalized = path.replace(separators, '/').replace(/\/+$/, '')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Do these two strings name the same path on this platform? */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform)
}
