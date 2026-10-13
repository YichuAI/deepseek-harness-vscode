# I built my first VS Code extension on a non-flagship model

**58 days, 24 tagged versions, and one conclusion: what is scarce now is not code. It is the judgement to leave things out.**

*Unofficial, community-built extension. Not affiliated with or endorsed by DeepSeek.*

[![The trailer’s opening card, with a play button](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/media/promo-cover.jpg)](./docs/media/promo-1080p.mp4)

*30 seconds, no narration — [play the trailer](./docs/media/promo-1080p.mp4). It is the same story as this file, told faster and with a better soundtrack.*

DeepSeek Harness is an AI coding agent that runs on your own machine: you talk to it in a browser, it reads and writes files and runs commands locally. This extension lets VS Code drive that same agent. That is the whole product. [The README](./README.md) describes what it does; this file is about how it got here, because the interesting part was never the code.

Before day one I had never read a line of VS Code extension documentation. My day job is systems architecture and embedded deployment — fifteen years of C and C++, and roughly zero TypeScript. The finished thing is 56 commits, 24 tagged versions and about 14,700 lines of TypeScript under `src/`.

![One session, two surfaces: the DSH web UI on the left, the extension in VS Code on the right](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/01-shared-session.png)

*The screenshot the whole project exists to produce. Same session, same turn, two clients — nothing imported, mirrored or forked.*

## 58 days, of which 11 had code in them

The dates are the first surprise. First commit 15 August 2026. First version anyone else could install, 58 days later. Laid out on a calendar, the days with a commit in them number **eleven**.

**Day one had fifteen commits. Then five weeks of nothing. Then twelve versions in four days.**

The usual fantasy about AI coding is a weekend from zero to shipped. What actually happened: one weekend produced a shell that ran, and the remaining fifty days went into arguing with the edges of the real world. Ports change. One socket carries two different streams. Line endings differ across three operating systems.

> The thing that nearly killed this was never slowness. It was drift — the project sitting untouched for five weeks while I told myself I would get back to it. What got it moving again was shrinking each session to one item: pin down the uncertainty I had measured last time, then stop.

## The most valuable change in it was deleting a button

Each turn, the agent reports which files it touched, and the card offered two buttons: **Accept** and **Reject**. That looked obvious to me for weeks.

It is a lie. The agent writes to disk first and tells you afterwards. By the time you can click Accept, the file has already changed. The button did nothing at all except perform a verdict; **Reject** was the only one with behaviour behind it, because reverting means writing the captured text back.

**I deleted Accept.**

The card stopped being a bench and became a report: *Revert this file* / *Revert all*. Deleting it was harder than writing it, because writing a button is a reflex, and admitting it should not exist requires deciding who owns what.

**The rule I settled on: human and AI are equals at the file level. No gate between them.**

The AI can write; I can revert; neither of us asks the other for permission. That also killed the mirror-image feature — pushing *my* edits into the AI's context. There is no reflow mechanism here, and none is needed, because the agent re-reads the file on every step. If I want it to know something, I say it in the conversation.

## The "won't do" list is longer than the feature list

What this extension is was decided at least as much by what I refused to build. Every one of these was tempting, and every one buys a better demo at the price of a real consistency.

| Not doing | Why it looks good | Why not |
| --- | --- | --- |
| Embedding the agent's web UI in the panel | A day of work, and what most peers in this niche ship | The editor side ends up with no say; approvals still get answered in a web page. The panel becomes a picture frame |
| Letting the extension start the Harness by default | Nothing for the user to start by hand | A second source of truth, and a second set of ports and credentials to keep straight |
| Code completion | The thing users ask for first | The upstream API has none. Implementing it means bolting on a separate endpoint and calling it a feature |
| Registering as another assistant's model provider | One integration, double the exposure | The price is giving up the orchestration — which is the entire product |
| Intercepting the agent's writes to "review" them | A tidier-looking approval flow | **DSH has to write to disk and read it back on the next step.** Intercepting that breaks the agent quietly, several steps later, with no visible thread back to the cause |

I have a name for that trade now: **giving up a moat for a dropdown entry.** It is rarely worth it.

> Taste is not an aesthetic gift. It is the willingness to give up demo effect in exchange for consistency. A feature list can be extended forever by asking a model to extend it. A won't-do list can only be held by a person.

## Three bugs a model could not have caught

Models have a stable bias: they hand you the statistically most likely correct solution. Bugs do not live in the centre of a problem. They live at its edges.

**"Connected" — and then perfectly silent.** Early on, the panel would say connected and never say anything else. The wire it had joined carries *two* logical streams: one forwards control events, the other carries the actual conversation. I had joined the first. That bug is exactly what a model would write, because for most connection protocols one stream is the whole story.

**A green test that was green by accident.** One build passed all 21 live checks. Two runs later, the same checks failed. The cause: three message types nest their fields differently, I had taught the test only one of them, and the run that "passed" had simply never reached the line that mattered. The test was wrong; the product code was fine.

**331,709 and 331,706.** The package I built locally weighed three bytes more than the one the CI machine built. Fourteen entries compared one by one: thirteen identical down to the checksum, one icon different. Windows line endings versus Unix ones, seven carriage returns, three bytes once compressed. Not chasing three bytes means that the next time a number moves you cannot tell who moved it.

> All three live in the same place, and it is not "writing code". It is verifying that what you wrote is true. Verification is the part a model is worst at substituting for, because it requires knowing what is suspicious.

![Reverting lands in VS Code's own diff editor](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/04-native-diff.png)

*Being able to see which line changed is what makes verification possible at all. The left side is text the plugin captured before the change; the right side is the file as it is now.*

## Choices you cannot outsource

A model will hand you five options with a tidy trade-off table. Picking one is still yours, because the deciding constraint is the thing you never thought to put in the prompt.

- **No frontend framework — plain DOM.** This is a panel that lives in a sidebar, not a product site. A build layer is one more thing to keep alive for years.
- **A hand-written WebSocket instead of the platform's.** The connection has to present the session credential, and the browser's own WebSocket API does not let you set a header on the handshake.
- **Read the OS listener table, never scan ports.** Twenty-odd ports answer in two seconds; sweeping ten thousand ephemeral ports is slow and rude.
- **Never write a discovered port back to settings.** It changes on every launch by design. Persisting it just plants a value that is guaranteed to be wrong later.

> A model flattens implementation ability, not judgement. It can cost out those five options better than I can, and it still does not know that this plugin's job is to attach to the Harness you already have, or how much consistency I am willing to pay for.

## The non-flagship tier was enough

The least intuitive result, and worth stating plainly: everything here was built on the cheap, fast, non-reasoning tier — the one that was called *V4 Flash* while I was working.

**The model names rotate; the tiers do not.** By the time you read this, the name is probably gone. What matters is that 14,700 lines, 493 protocol assertions and end-to-end chains on three operating systems all came out of that tier.

**The bottleneck was never how deeply the model reasoned. It was whether the context I handed it was complete.** Given the upstream API's real response, the actual error text from last time, and how I intended to use the data, a cheap model is usually right. Given "make me a VS Code extension", even a flagship can only hand back the most statistically average correct answer. What slowed this project down was never a model being insufficiently clever. It was me not having decided what I was building.

## Where to put your effort

**Most people are not stuck because they cannot build the thing. They are stuck because they never decided what to leave out.**

| If you are… | Spend your effort on | Stop |
| --- | --- | --- |
| About to build a tool with AI, still not started | Writing the won't-do list first | Generating code |
| Already building, but it keeps getting messier | Going back to the definition: what does it connect to, what does it not own | Adding features |
| Nearly done, wanting to ship | Walking the release path end to end | Polishing automation |
| Shipped, and nobody uses it | Explaining how it differs from the thing they already use | Adding more features |

Row three is my own scar. Code hosting and CI were fine; only the official Marketplace publish was blocked — the server simply does not implement the capability yet, so the last step is a manual upload. No amount of local testing finds that. Walking it once does.

## What the thing does now

The extension is called **DeepSeek Harness Connector**, it is MIT-licensed, and it is in the VS Code Marketplace.

Most plugins in this niche embed the Harness web UI in a panel and call it a day. In those, clicking **Allow** is clicking inside a web page; the editor is a picture frame. This one speaks the Harness itself, so every card is the editor's own.

| What it does | The annoyance it removes |
| --- | --- |
| **Continues the session you already have** | Workspaces and sessions are read from the running Harness. Refresh that session in the browser and you see exactly what the editor just sent |
| **Answers approvals and agent questions here** | The card appears in the sidebar. You do not switch back to a browser tab, and it does not matter whether you closed it |
| **Reports each turn, and can undo it — down to one hunk** | Fed by the Harness's own turn record, so a file a shell command edited is included. The undo checks the file's current bytes and refuses rather than overwriting your edit |
| **Opens VS Code's own editor for anything that is code** | A diff is a real diff editor; a path opens the file. Nothing is reimplemented in the webview |
| **Finds the Harness by itself** | The desktop app starts its Host on an OS-assigned port that changes every launch. Nothing to type in |
| **Starts no process unless you ask** | The default attaches to the Harness you already have running |

![The extension's panel: sessions, the conversation, the changed-files card, the model picker](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/03-editor-sidebar.png)

*The panel as it ships. Connected to the Harness that was already running, on the session that was already open.*

```
code --install-extension lucasliang.harness-connector-deepseek
```

Or take the VSIX from [GitHub Releases](https://github.com/YichuAI/deepseek-harness-vscode/releases).

## If you want to do this too

1. **Write the won't-do list before the feature list.** The first one is usually shorter and much harder to write.
2. **Pick a problem you personally hit every day.** This project started as "I am tired of switching windows". That irritation was a better market signal than any research would have been.
3. **When something behaves strangely, measure before you change anything.** Print the real record. Count the real bytes. Stop guessing.
4. **Put conclusions in comments or assertions, not in a chat window.** Windows close.
5. **Walk the release path early.** It is the one part of the work that cannot be verified locally, no matter how much you test.
6. **Do not worship the model tier.** Handing over complete facts beats paying for a smarter model.

**It did not die of being slow, and it did not die of a weak model. It nearly died of not knowing what not to build.**

Fifty-eight days, eleven of them with code in them. The thing you have been meaning to build for a while — is it stuck because you have not decided what to leave out, or because you have not started?

---

*Every number in this file comes from the repository itself: its commit log, its assertion counts and its release records. Written 2026-10-14. Runtime details change; the [README](./README.md) is current.*
