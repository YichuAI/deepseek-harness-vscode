/** CSS for the webview sidebar. Kept as a plain string template; physical
 *  file separation makes it easier to edit without touching provider.ts. */
export const STYLES = /* css */ `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0; height: 100vh;
  display: flex; flex-direction: column;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
.bar { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
.brand-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
.brand-bar img { width: 20px; height: 20px; flex-shrink: 0; }
.brand-bar .brand-name { font-weight: 600; font-size: 12px; flex: 1; }
.brand-bar .toolbar { display: flex; gap: 2px; }
.brand-bar .toolbar button { padding: 2px 6px; font-size: 11px; }
.toggle-badge { font-size: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 4px; margin-left: 2px; }
.row { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
.status { display: flex; align-items: center; gap: 6px; font-weight: 600; }
/* The manual connect/retry affordance rides in the status row, right-aligned so
   it reads as an action on the status rather than another toolbar icon. */
.status #connect { margin-left: auto; padding: 2px 8px; font-size: 11px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.disconnected { background: var(--vscode-disabledForeground, #888); }
.dot.connecting { background: var(--vscode-charts-yellow, #ca9c2e); animation: pulse 1s infinite; }
.dot.connected { background: var(--vscode-charts-green, #2da44e); }
.dot.error { background: var(--vscode-errorForeground, #c53149); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.muted { color: var(--vscode-descriptionForeground); font-weight: 400; font-size: 11px; }
select, button, input, textarea {
  font-family: inherit; font-size: inherit; color: inherit;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px; padding: 4px 6px;
}
select { width: 100%; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; padding: 4px 10px; border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: .5; cursor: default; }
button.icon { padding: 4px 6px; }
.ws-name { font-weight: 600; }
.ws-path { color: var(--vscode-descriptionForeground); font-size: 11px; word-break: break-all; }
.ws-pending { color: var(--vscode-charts-yellow, #ca9c2e); font-size: 11px; margin-top: 2px; }
/* Control surface — the knobs the harness has always shipped. */
.ctl { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); padding: 6px 10px 8px; }
.ctl-head { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
.ctl-arrow { font-size: 10px; color: var(--vscode-descriptionForeground); width: 10px; }
.ctl.open .ctl-arrow { transform: rotate(90deg); }
.ctl-title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.ctl-summary { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; justify-content: flex-end; }
.ctl-body { display: none; margin-top: 6px; }
.ctl.open .ctl-body { display: block; }
.ctl-chip {
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  white-space: nowrap;
}
.ctl-chip.plan { background: var(--vscode-charts-purple, #8250df); color: #fff; }
.ctl-chip.risk { background: var(--vscode-errorForeground, #c53149); color: #fff; }
.ctl-chip.running { background: var(--vscode-charts-yellow, #ca9c2e); color: #1b1b1b; }
.ctl-section { margin-bottom: 8px; }
.ctl-section-title { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
.ctl-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 3px 0; }
.ctl-row select { width: auto; flex: 1; min-width: 120px; }
.ctl-todos { margin: 0; padding-left: 16px; }
.ctl-todos li { margin: 1px 0; word-break: break-word; }
.ctl-todos li.done { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
.ctl-todos li.active { font-weight: 600; }
.ctl-goal { border-left: 3px solid var(--vscode-charts-blue, #1b7fbd); padding-left: 6px; }
.ctl-goal-phase { font-size: 10px; color: var(--vscode-descriptionForeground); }
.ctl-note { font-size: 11px; color: var(--vscode-descriptionForeground); word-break: break-word; }
.ctl-unsupported { font-size: 10px; color: var(--vscode-descriptionForeground); font-style: italic; }

#messages { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.msg { padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
.msg.user { background: var(--vscode-input-background); border-left: 3px solid var(--vscode-charts-blue, #1b7fbd); }
.msg.user .role { color: var(--vscode-charts-blue, #1b7fbd); }
.msg.assistant { background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-charts-green, #2da44e); }
.msg.assistant .role { color: var(--vscode-charts-green, #2da44e); }
.msg .role { font-weight: 600; font-size: 11px; display: block; margin-bottom: 2px; }
.msg .reasoning { color: var(--vscode-descriptionForeground); font-style: italic; margin: 4px 0; border-left: 2px solid var(--vscode-panel-border); padding-left: 6px; }
.msg .usage { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 4px; }

/* Markdown content (assistant messages only). */
.msg .md { line-height: 1.55; }
.msg .md p { margin: 0 0 0.7em; }
.msg .md p:last-child { margin-bottom: 0; }
.msg .md h1, .msg .md h2, .msg .md h3, .msg .md h4 { margin: 1em 0 0.4em; line-height: 1.25; font-weight: 600; }
.msg .md h1 { font-size: 1.25em; }
.msg .md h2 { font-size: 1.15em; }
.msg .md h3 { font-size: 1.08em; }
.msg .md code {
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
  padding: 1px 4px; border-radius: 3px; font-size: 0.92em;
}
.msg .md pre {
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
  border-radius: 4px; padding: 8px; overflow-x: auto; margin: 0.6em 0;
}
.msg .md pre code { background: transparent; padding: 0; }
.msg .md blockquote {
  margin: 0.4em 0; padding: 2px 10px;
  border-left: 3px solid var(--vscode-charts-yellow, #ca9c2e);
  color: var(--vscode-descriptionForeground);
}
.msg .md ul, .msg .md ol { padding-left: 1.4em; margin: 0.4em 0; }
.msg .md li { margin: 2px 0; }
.msg .md a { color: var(--vscode-textLink-foreground); }
.msg .md table { border-collapse: collapse; margin: 0.6em 0; font-size: 0.95em; }
.msg .md th, .msg .md td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); padding: 4px 8px; }
.msg .md th { background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08)); font-weight: 600; }
.msg .md img { max-width: 100%; }
.msg .md hr { border: 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); margin: 0.8em 0; }

/* System item (collapsed by default) */
.system {
  padding: 4px 8px; border-radius: 4px;
  background: var(--vscode-textBlockQuote-background);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
  font-size: 11px; color: var(--vscode-descriptionForeground);
}
.system .sys-head { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px; font-weight: 500; }
.system .sys-head:hover { color: var(--vscode-foreground); }
.system .sys-arrow { display: inline-block; width: 10px; transition: transform 0.15s; }
.system.open .sys-arrow { transform: rotate(90deg); }
.system .sys-body { display: none; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; }
.system.open .sys-body { display: block; }
.system .sys-source { color: var(--vscode-textLink-foreground); font-size: 10px; margin-left: auto; }

/* ToolItem: single collapsed card (call + result merged). */
.tool {
  padding: 4px 8px; border-radius: 4px;
  background: var(--vscode-textBlockQuote-background);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
}
.tool .t-head {
  cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 6px; font-weight: 500; font-size: 12px;
}
.tool .t-head:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); border-radius: 3px; }
.tool .t-arrow { display: inline-block; width: 10px; transition: transform 0.15s; color: var(--vscode-descriptionForeground); }
.tool.open .t-arrow { transform: rotate(90deg); }
.tool .t-name { color: var(--vscode-symbolIcon-functionForeground, #b58900); flex: 0 0 auto; }
.tool.error .t-name { color: var(--vscode-errorForeground, #c53149); }
.tool .t-title { flex: 1; }
.tool .t-state { font-size: 10px; flex: 0 0 auto; }
.tool .t-state.running { color: var(--vscode-charts-yellow, #ca9c2e); }
.tool .t-state.done { color: var(--vscode-charts-green, #2da44e); }
.tool .t-state.error { color: var(--vscode-errorForeground, #c53149); }
.tool .t-body { display: none; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
.tool.open .t-body { display: block; }
.tool .t-section-title { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 6px 0 2px; }
.tool pre {
  margin: 0; font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px; white-space: pre-wrap; word-break: break-word;
  max-height: 260px; overflow-y: auto;
  background: var(--vscode-editor-background);
  padding: 6px; border-radius: 3px;
}
.tool.error .t-result { color: var(--vscode-errorForeground); }

.status-line { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; padding: 2px 0; }
.status-line.running { color: var(--vscode-charts-yellow, #ca9c2e); }
.cursor { display: inline-block; width: 7px; height: 13px; background: var(--vscode-editorCursor-foreground); vertical-align: text-bottom; animation: blink 1s step-end infinite; margin-left: 2px; }
@keyframes blink { 50% { opacity: 0; } }
#input-area { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
textarea { resize: none; min-height: 60px; max-height: 200px; width: 100%; }
.input-row { display: flex; gap: 6px; }
.input-row button { flex: 1; }
#open-web { text-align: center; padding: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
#open-web a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; font-size: 11px; }
#open-web a:hover { text-decoration: underline; }
.empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 24px 12px; font-size: 12px; }

/* First-run card. Replaces the one-line empty state until something has
   connected once: same slot, but it can be read by somebody who has never seen
   this extension before. */
.first-run { padding: 18px 12px; font-size: 12px; color: var(--vscode-foreground); }
.first-run .fr-step { display: flex; gap: 8px; margin-bottom: 10px; }
.first-run .fr-n {
  flex: 0 0 18px; height: 18px; line-height: 18px; border-radius: 50%;
  text-align: center; font-size: 10px; font-weight: bold;
  background: var(--vscode-badge-background, rgba(128,128,128,.25));
  color: var(--vscode-badge-foreground, var(--vscode-foreground));
}
.first-run .fr-body { flex: 1 1 auto; min-width: 0; }
.first-run .fr-title { font-weight: bold; }
.first-run .fr-note { color: var(--vscode-descriptionForeground); line-height: 1.45; }
.first-run .fr-actions { margin-top: 14px; }

/* Context injection UI */
.context-bar { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0; align-items: center; }
.ctx-chip {
  display: inline-flex; align-items: center; gap: 3px;
  background: var(--vscode-badge-background, rgba(0,120,212,.2));
  color: var(--vscode-badge-foreground, var(--vscode-foreground));
  border-radius: 3px; padding: 1px 6px; font-size: 10px; max-width: 200px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ctx-chip.selection { background: var(--vscode-charts-yellow, #ca9c2e); color: var(--vscode-contrastActiveBorder, #000); }
.ctx-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.atfile-hint { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.7; padding: 2px 0; }

/* Review card (embedded in tool item, always visible) */
.t-review {
  margin: 4px 0; padding: 6px 8px; border-radius: 4px;
  background: var(--vscode-textBlockQuote-background);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  font-size: 12px;
}
.t-review .review-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.t-review .review-title { font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
.t-review .review-state { font-size: 10px; padding: 1px 6px; border-radius: 8px; }
.t-review .review-state.pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.t-review .review-state.accepted { background: var(--vscode-charts-green, #2da44e); color: #fff; }
.t-review .review-state.rejected { background: var(--vscode-charts-red, #c53149); color: #fff; }
.t-review .review-state.partial { background: var(--vscode-charts-yellow, #ca9c2e); color: #000; }
.t-review .review-state.conflicted { background: var(--vscode-errorForeground, #c53149); color: #fff; }
.t-review .review-files { display: flex; flex-direction: column; gap: 2px; }
.t-review .review-file {
  display: flex; flex-direction: column; padding: 3px 4px; border-radius: 3px;
  background: var(--vscode-editor-background);
}
.t-review .rf-head { display: flex; align-items: center; gap: 6px; }
.t-review .rf-path { flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-review .rf-stats { font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); flex: 0 0 auto; }
.t-review .rf-stats .added { color: var(--vscode-charts-green, #2da44e); }
.t-review .rf-stats .removed { color: var(--vscode-charts-red, #c53149); }
.t-review .rf-state { font-size: 10px; flex: 0 0 auto; }
.t-review .rf-state.accepted { color: var(--vscode-charts-green, #2da44e); }
.t-review .rf-state.rejected { color: var(--vscode-charts-red, #c53149); }
.t-review .review-file button { padding: 2px 6px; font-size: 10px; flex: 0 0 auto; }
/* Per-hunk rows. Indented under the file so the hierarchy reads as "these are
   the parts of that file", and dimmer, because they are detail rather than a
   second list of files. */
.t-review .rf-hunks { display: flex; flex-direction: column; gap: 1px; margin: 2px 0 0 10px; }
.t-review .rf-hunk {
  display: flex; align-items: center; gap: 6px; padding: 1px 3px; border-radius: 3px;
  border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.3));
}
.t-review .rf-hunk.rejected { opacity: .55; }
.t-review .rf-hunk-text {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
  color: var(--vscode-descriptionForeground);
}
.t-review .review-actions { display: flex; gap: 6px; margin-top: 6px; }
.t-review .review-actions button { flex: 1; padding: 3px 10px; font-size: 11px; }

/* ─── end-of-turn changed files ─────────────────────────────────────────────
   A report of what the turn already wrote, plus the one action that makes
   sense on a fact: undo it. Visually a sibling of the review card above, but
   it belongs to the TURN rather than to one tool call, so it sits at the end
   of the transcript instead of inside a tool row. */
.changes {
  margin: 8px 0; padding: 8px 10px; border-radius: 6px;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
}
.changes.loading { color: var(--vscode-descriptionForeground); font-size: 11px; }
.changes.error { border-color: var(--vscode-errorForeground, #c53149); }
.changes-error { font-size: 11px; color: var(--vscode-errorForeground, #c53149); }
.changes-head { display: flex; align-items: center; gap: 8px; }
.changes-title { flex: 1; font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.changes-stats { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; flex: 0 0 auto; }
.changes-stats .added, .changes-file .cf-stats .added { color: var(--vscode-charts-green, #2da44e); }
.changes-stats .removed, .changes-file .cf-stats .removed { color: var(--vscode-charts-red, #c53149); }
.changes-head button { padding: 2px 8px; font-size: 10px; flex: 0 0 auto; }
.changes-files { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.changes-file { display: flex; align-items: center; gap: 6px; }
.changes-file .cf-path {
  flex: 1; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.changes-file .cf-path:hover { text-decoration: underline; }
.changes-file .cf-stats { font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); flex: 0 0 auto; }
.changes-file button { padding: 2px 6px; font-size: 10px; flex: 0 0 auto; }
.changes-fold { margin-top: 6px; width: 100%; padding: 3px 10px; font-size: 11px; }

/* ── v0.0.9: queued messages / slash completion / usage panel ───────────── */
#queue-bar { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 4px; margin-bottom: 6px; padding: 5px 7px; }#queue-bar .queue-title { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; text-transform: uppercase; letter-spacing: .4px; }
#queue-bar .queue-item { display: flex; align-items: center; gap: 5px; padding: 3px 0; }
#queue-bar .queue-item + .queue-item { border-top: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.2)); }
#queue-bar .queue-text { flex: 1; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-charts-yellow, #ca9c2e); }
#queue-bar .queue-item button { padding: 1px 6px; font-size: 10px; flex: 0 0 auto; }

/* ── pending waterfalls: approvals + ask_user_question ───────────────────
   Both block the Host's tool call, so both belong in the one place the user is
   already looking when they are about to type. Deliberately styled as a warning
   block (left rule, raised background) rather than a message: it is a question
   addressed to the reader, not a record of something that happened. */
.pending-panel { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
.pending-card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-left: 3px solid var(--vscode-charts-yellow, #ca9c2e); border-radius: 4px; padding: 7px 8px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.06)); }
.pending-card.risk { border-left-color: var(--vscode-charts-red, #c53149); }
.pending-card.responding { opacity: .6; }
.pending-kind { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
.pending-head { font-size: 11.5px; font-weight: 600; margin-bottom: 3px; }
.pending-tool { font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); margin-bottom: 2px; }
.pending-reason { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: pre-wrap; word-break: break-word; }
.pending-note { font-size: 10.5px; color: var(--vscode-charts-red, #c53149); margin-top: 4px; }
.pending-card .pending-question { font-size: 11.5px; margin: 5px 0 3px; white-space: pre-wrap; word-break: break-word; }
.pending-card .pending-detail { font-size: 10.5px; color: var(--vscode-descriptionForeground); max-height: 160px; overflow: auto; white-space: pre-wrap; border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.3)); padding-left: 6px; margin: 4px 0; }
.pending-opts { display: flex; flex-direction: column; gap: 2px; margin: 4px 0; }
.pending-opt { display: flex; align-items: flex-start; gap: 6px; font-size: 11px; padding: 3px 5px; border-radius: 3px; cursor: pointer; }
.pending-opt:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.pending-opt input { flex: 0 0 auto; margin: 2px 0 0; }
.pending-opt .pending-opt-desc { display: block; font-size: 10px; color: var(--vscode-descriptionForeground); }
.pending-card .pending-other { width: 100%; box-sizing: border-box; font-size: 11px; padding: 3px 5px; margin-top: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,.35))); border-radius: 3px; }
.pending-actions { display: flex; gap: 6px; margin-top: 6px; }
.pending-actions button { padding: 3px 10px; font-size: 11px; }
.pending-actions .grow { flex: 1; }

/* Composer attachments: chips above the textarea. Images that were pasted get a
   local blob thumbnail, so the preview never travels as base64. */
.attach-bar { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.attach-chip { display: flex; align-items: center; gap: 5px; max-width: 100%; padding: 3px 5px 3px 3px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 4px; background: var(--vscode-input-background); }
.attach-thumb { width: 26px; height: 26px; border-radius: 3px; object-fit: cover; flex: 0 0 auto; background: var(--vscode-editorWidget-background, #222); }
.attach-glyph { width: 26px; height: 26px; border-radius: 3px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; font-size: 13px; background: var(--vscode-editorWidget-background, #222); }
.attach-name { font-size: 11px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-size { font-size: 10px; color: var(--vscode-descriptionForeground); flex: 0 0 auto; }
.attach-chip .attach-x { padding: 0 4px; font-size: 10px; flex: 0 0 auto; background: transparent; color: var(--vscode-descriptionForeground); }
.attach-chip .attach-x:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
#input-area.drag-over { outline: 1px dashed var(--vscode-focusBorder); outline-offset: -3px; }


#slash-popup { position: relative; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 4px; margin-bottom: 4px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); box-shadow: 0 2px 8px rgba(0,0,0,.35); max-height: 180px; overflow-y: auto; z-index: 5; }
#slash-popup .slash-row { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; cursor: pointer; }
#slash-popup .slash-row.active { background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,.25)); color: var(--vscode-list-activeSelectionForeground, inherit); }
#slash-popup .slash-name { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; font-size: 11.5px; flex: 0 0 auto; }
#slash-popup .slash-desc { font-size: 10.5px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── @file mention completion (host fileReferences/list) ─────────────────── */
/* Deliberately the same visual grammar as the slash popup: both are composer
   completions sitting directly above the textarea, and a user who has learned
   one should not have to learn the other. */
#at-popup { position: relative; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 4px; margin-bottom: 4px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); box-shadow: 0 2px 8px rgba(0,0,0,.35); max-height: 200px; overflow-y: auto; z-index: 5; }
#at-popup .at-row { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; cursor: pointer; }
#at-popup .at-row.active { background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,.25)); color: var(--vscode-list-activeSelectionForeground, inherit); }
#at-popup .at-glyph { flex: 0 0 auto; font-size: 11px; opacity: .85; }
#at-popup .at-path { font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
#at-popup .at-kind { flex: 0 0 auto; font-size: 10px; color: var(--vscode-descriptionForeground); }

.steer-wrap { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); cursor: pointer; flex: 0 0 auto; margin-left: auto; }
.steer-wrap input { width: auto; margin: 0; }
.input-row { display: flex; gap: 6px; align-items: center; }
.input-row #send { flex: 0 0 auto; }
.input-row #stop { flex: 0 0 auto; }

.usage-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: 6px; margin: 4px 0; }
.usage-grid .usage-cell { background: var(--vscode-editor-background, rgba(128,128,128,.08)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); border-radius: 4px; padding: 4px 6px; text-align: center; }
.usage-grid .usage-cell b { display: block; font-size: 12px; }
.usage-grid .usage-cell span { font-size: 9.5px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .3px; }

/* ── v0.1.0: session search / event inspector subpanels ─────────────────── */
.subpanel { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 5px; margin: 6px 0; padding: 7px 8px; background: var(--vscode-editorWidget-background, transparent); }
.subpanel-head { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; margin-bottom: 6px; }
.subpanel-head button { margin-left: 0; flex: 0 0 auto; }
.subpanel-head button + button { margin-left: auto; }
.subpanel-head span:first-child { flex: 1; }

/* Settings and help. One row per knob: what it is, what it does, and the control
   — because the alternative was a list of command-palette entries with no way to
   see what any of them were set to. */
.set-group {
  font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--vscode-descriptionForeground); margin: 12px 0 4px;
}
.set-group:first-child { margin-top: 2px; }
.set-row { display: flex; gap: 8px; align-items: flex-start; padding: 7px 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22)); }
.set-group + .set-row { border-top: 0; }
.set-label { flex: 0 0 86px; font-size: 11px; font-weight: 600; padding-top: 3px; }
.set-main { flex: 1 1 auto; min-width: 0; }
.set-note { color: var(--vscode-descriptionForeground); font-size: 10.5px; line-height: 1.45; margin-top: 3px; }
.set-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.set-actions button { margin: 0; }
.set-inline { display: flex; gap: 4px; }
.set-inline input { flex: 1 1 auto; min-width: 0; }
.set-inline input[type="number"] { flex: 0 0 78px; }
.set-check { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.set-check input { flex: 0 0 auto; }
#settings-body { max-height: 340px; overflow-y: auto; }
.subpanel .row { display: flex; gap: 6px; margin-bottom: 5px; }
.subpanel .row input { flex: 1; }
.muted.warn { color: var(--vscode-charts-yellow, #ca9c2e); }

#search-results { max-height: 180px; overflow-y: auto; }
.search-row { padding: 4px 6px; border-radius: 4px; cursor: pointer; }
.search-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.search-row .search-title { font-size: 11.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-row .search-snippet { font-size: 10.5px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.inspector-list { max-height: 220px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; }
.insp-row { display: flex; gap: 6px; padding: 1.5px 4px; cursor: copy; border-radius: 3px; align-items: baseline; }
.insp-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.insp-row.copied { background: var(--vscode-list-activeSelectionBackground, rgba(90,160,255,.25)); }
.insp-seq { color: var(--vscode-descriptionForeground); flex: 0 0 26px; text-align: right; }
.insp-time { color: var(--vscode-descriptionForeground); flex: 0 0 62px; }
.insp-kind { color: var(--vscode-charts-blue, #4aa3ff); flex: 0 0 auto; }
.insp-summary { color: var(--vscode-foreground, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`
