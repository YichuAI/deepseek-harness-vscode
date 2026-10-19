# Two cards, two different jobs

**Approvals** are the agent asking before it acts. The card appears above the
composer while the turn is blocked, and the turn does not continue until you
answer: `Allow once` or `Reject`. A rejected call goes back to the model as a
refusal — it is an answer, not an error. Questions from the agent arrive the
same way, and the same rule holds: while a card is up, everything is waiting on
you.

**Review** is what you get afterwards. Harness writes to your files directly —
the extension never intercepts, buffers, or proxies a write. So the honest
question is not "should this be applied" but "do I want to keep it", and the
cards answer exactly that: `Revert this file`, `Revert all`, or open the diff
first and revert a single hunk.

One thing worth knowing because it explains a card that otherwise looks odd: a
review exists per file-writing tool call, and it can only restore what it was
told about. A change made by a shell command (`sed -i`, a formatter, a codegen
script) never had a review — it shows up in the turn's change record instead,
which is the Host's own git snapshot and carries hunks rather than whole files.
