# Where the panel lives

**DeepSeek Harness** sits in the activity bar, on the far left. It is the only
view in its container, and it has three regions:

| Region | What it is |
| --- | --- |
| Status row | the connection dot, the Host it is talking to, and the buttons that fix it |
| Transcript | the conversation, plus any approvals waiting on you |
| Composer | where you type — `/` for commands, `@` to reference a file |

Nothing to configure first. On activation the extension connects on its own: in
the default `auto` mode it reuses the credentials DeepSeek Harness already
wrote to `~/.dsh/.credentials.yaml`, and starts a Host when none is listening.

If you would rather keep the panel beside your code than over it, use
**Move to Right Side Bar** — same view, no modal behaviour.
