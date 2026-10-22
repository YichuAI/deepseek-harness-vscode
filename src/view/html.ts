/** Static HTML skeleton for the sidebar webview. <style> and <script> are
 *  injected by provider.ts at build time. The body matches exactly the
 *  layout the client script looks up by element IDs. */
export const HTML_SKELETON = /* html */ `
  <div class="brand-bar">
    <img id="brand-icon" alt="" style="display:none;" />
    <span class="brand-name">DeepSeek Harness</span>
    <div class="toolbar">
      <button id="btn-settings" class="secondary icon" title="Settings and help">⚙</button>
      <button id="btn-search" class="secondary icon" title="Search sessions (F6)">🔍</button>
      <button id="btn-inspector" class="secondary icon" title="Live event inspector (F7)">📡</button>
      <button id="btn-attach" class="secondary icon" title="Attach files to session (F8)">📎</button>
      <button id="toggle-sys" class="secondary icon" title="Show/hide system messages (runtime context, plugin injections)" style="display:none;">SYS</button>
      <button id="move-right" class="secondary icon" title="Move to right side bar">⇲</button>
    </div>
  </div>

  <div class="bar">
    <div class="status">
      <span id="dot" class="dot disconnected"></span>
      <span id="status-text">Disconnected</span>
      <button id="connect" class="secondary icon" title="Reconnect to the harness Host (drops the current session and negotiates a fresh one)">Reconnect</button>
      <button id="install" class="secondary icon" style="display:none;">Get Harness</button>
      <button id="repair" class="secondary icon" style="display:none;">Fix</button>
    </div>
    <div id="host-info" class="muted" style="margin-top:2px;"></div>
    <div id="mux-status" class="muted"></div>
  </div>

  <div class="bar">
    <div id="ws-name" class="ws-name">No workspace</div>
    <div id="ws-path" class="ws-path"></div>
    <div id="ws-pending" class="ws-pending" style="display:none;"></div>
    <div class="row" style="margin-top:6px;">
      <select id="session-select" title="Session"></select>
      <button id="new-session" class="secondary icon" title="New session" style="flex:0 0 auto;">＋</button>
      <button id="refresh" class="secondary icon" title="Refresh" style="flex:0 0 auto;">⟳</button>
    </div>
  </div>

  <div id="settings-panel" class="subpanel" style="display:none;">
    <div class="subpanel-head">
      <span>⚙ Settings &amp; help</span>
      <button id="settings-close" class="secondary icon" title="Close">✕</button>
    </div>
    <div id="settings-body"></div>
  </div>

  <div id="search-panel" class="subpanel" style="display:none;">
    <div class="subpanel-head">
      <span>🔍 Search sessions</span>
      <button id="search-close" class="secondary icon" title="Close">✕</button>
    </div>
    <div class="row">
      <input id="search-input" type="text" placeholder="Full-text query…" />
      <button id="search-go" class="secondary">Search</button>
    </div>
    <div id="search-status" class="muted"></div>
    <div id="search-results"></div>
  </div>

  <div id="inspector-panel" class="subpanel" style="display:none;">
    <div class="subpanel-head">
      <span>📡 Event inspector</span>
      <button id="inspector-clear" class="secondary" title="Clear buffer">Clear</button>
      <button id="inspector-close" class="secondary icon" title="Close">✕</button>
    </div>
    <div id="inspector-list" class="inspector-list"></div>
  </div>

  <div id="messages"></div>

  <div id="input-area">
    <!-- Anything the Host is blocked on: approvals and ask_user_question
         requests. Sits above every other composer bar because it is the only
         one that stops the turn from finishing. -->
    <div id="pending-panel" class="pending-panel" style="display:none;"></div>
    <div id="queue-bar" style="display:none;"></div>
    <div id="attach-bar" class="attach-bar" style="display:none;"></div>
    <div id="at-popup" style="display:none;"></div>
    <div id="slash-popup" style="display:none;"></div>
    <textarea id="input" placeholder="Send a prompt… (Enter to send, / for commands, @ to reference a file, paste an image, Shift+Enter for newline)" rows="3"></textarea>
    <div id="context-bar" class="context-bar" style="display:none;">
      <span id="context-active-file" class="ctx-chip" style="display:none;"></span>
      <span id="context-selection" class="ctx-chip selection" style="display:none;">selection</span>
      <span id="context-files" class="ctx-chips"></span>
    </div>
    <div class="input-row">
      <button id="send">Send</button>
      <button id="stop" class="secondary" disabled>Stop</button>
      <label id="steer-wrap" class="steer-wrap" title="Inject this message into the agent's current turn instead of queueing it" style="display:none;">
        <input type="checkbox" id="steer" /> Steer
      </label>
    </div>
    <div id="model-bar" class="model-bar" style="display:none;">
      <label class="model-slot" title="Model used for the next turn of this session">
        <span class="model-tag">model</span>
        <select id="model-pick"></select>
      </label>
      <label id="effort-slot" class="model-slot" title="How much reasoning the model may spend before answering">
        <span class="model-tag">thinking</span>
        <select id="effort-pick"></select>
      </label>
      <span id="model-note" class="model-note"></span>
    </div>
    <div id="atfile-hint" class="atfile-hint">Tip: type @ to reference a file — the agent reads it itself, nothing is pasted. / for commands.</div>
  </div>

  <div id="open-web"><a id="open-web-link">Open in DeepSeek Harness Web UI ↗</a></div>
`
