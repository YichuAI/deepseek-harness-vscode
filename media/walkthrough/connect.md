# What the status row is telling you

The dot and the text next to it are the whole connection state:

| Reads | Means | What to press |
| --- | --- | --- |
| **Connected** | a Host answered and the session is live | nothing |
| **Disconnected** | nothing has been reached yet | `Reconnect` |
| **an error message** | a Host was reached and refused, or none was found | `Fix`, when it appears |

`Fix` is not a generic retry. It runs the one repair the extension derived from
the failure it actually saw — install a Host, switch to a mode that can mint a
session, or paste the launch URL a Host printed. When the row offers no `Fix`,
the cause is not one the extension can act on by itself, and the text above the
button says which.

Two commands worth knowing:

- **DeepSeek Harness: Diagnostics** — the state, the target, and the classified
  reason in one place.
- **DeepSeek Harness: Show Logs** — the same thing over time. If you ever report
  a problem, this is the file to attach.

Modes live in `deepseekHarness.sessionMode`. `auto` (the default) is the one
that both mints a cookie and starts a Host; the other three each do only half
of that, on purpose.
