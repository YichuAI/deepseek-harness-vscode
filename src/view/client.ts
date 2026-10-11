/**
 * Webview-side client script (renderer-side logic — runs inside the <script>
 * block wrapped with the CSP nonce).
 *
 * Responsibilities:
 *   • Render UiState snapshots. The transcript is reconciled item-by-item, so a
 *     streamed chunk redraws one row rather than rebuilding the conversation.
 *   • Assistant markdown via markdown-it (html:false — unsafe HTML is dropped).
 *   • System / Tool cards are collapsed by default; click-to-expand.
 *   • Post user actions back to the extension host (sendPrompt, selectSession…).
 *
 * IMPORTANT: The extension host sends raw markdown text. Markdown rendering
 * happens HERE (webview side), not in extension host — semantic vs. presentation
 * boundary.
 */

export const CLIENT_SCRIPT = /* js */ `
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  // ─── boot guard ─────────────────────────────────────────────────────────────
  // A throw anywhere below (a bad dependency, an unexpected state shape) used to
  // abort the whole script *before* the state listener was attached, freezing the
  // panel on its static "Disconnected" placeholder with dead controls and no
  // explanation. Surface it instead: an uncaught boot error is printed in the
  // message area, so a broken panel is self-evident rather than silent.
  window.addEventListener('error', function (ev) {
    try {
      var box = document.getElementById('messages');
      if (box && !box.getAttribute('data-boot-error')) {
        box.setAttribute('data-boot-error', '1');
        var detail = (ev && (ev.message || (ev.error && ev.error.message))) || 'unknown error';
        box.innerHTML = '<div class="empty">Webview failed to start: '
          + String(detail).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; })
          + '</div>';
      }
    } catch (e) { /* never mask the original error */ }
  });

  let lastRenderVersion = -1;
  // Incremental transcript state. itemNodes maps an item's key to the element
  // already drawn for it and the signature it was drawn from; transcriptEmpty
  // remembers whether the placeholder is the thing on screen. Together they let
  // a streamed chunk re-render ONE row instead of the whole conversation.
  let itemNodes = new Map();
  let transcriptEmpty = false;
  let lastSessionsSig = '';
  let currentReviews = [];
  let currentApprovals = [];
  let currentQuestions = [];
  let currentCapabilities = {};
  let currentCommands = [];
  let currentQueue = [];
  let currentCatalog = null;
  let currentSearch = null;
  let currentEventLog = [];
  let currentState = null;
  let lastControlSig = '';
  // Slash completion state
  let slashItems = [];
  let slashIndex = -1;
  // @file mention completion state
  let atItems = [];
  let atIndex = -1;
  let atToken = null;
  let atTimer = null;

  // ─── markdown renderer (webview-only, html disabled!) ──────────────────────
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  // Override the default link renderer to add target=_blank + rel=noopener.
  // Guarded: the extension's no-markdown-it fallback stub returns an object
  // without a renderer, and touching renderer.rules unguarded would abort the
  // whole script — the exact failure mode this panel just came out of.
  if (md.renderer && md.renderer.rules) {
    const defaultLinkRender = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
    md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
      const hrefIndex = tokens[idx].attrIndex('href');
      if (hrefIndex >= 0) {
        const href = tokens[idx].attrs[hrefIndex][1];
        // Only allow http/https/mailto — block javascript: / data: payloads
        const safe = /^(https?:|mailto:)/i.test(href);
        if (!safe) tokens[idx].attrs[hrefIndex][1] = '#';
      }
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      return defaultLinkRender(tokens, idx, options, env, self);
    };
  }

  function renderMarkdown(s) {
    if (!s) return '';
    return md.render(String(s));
  }

  // ─── util ───────────────────────────────────────────────────────────────────
  function escapeText(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function prettyArgs(raw) {
    if (!raw) return '';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  }
  function post(action) { vscode.postMessage(action); }

  function setDot(kind) {
    const dot = $('dot');
    dot.className = 'dot ' + kind;
  }

  // ─── main render entry point ────────────────────────────────────────────────
  function render(state) {
    currentState = state;
    currentSearch = state.search || null;
    currentEventLog = state.eventLog || [];
    // Store reviews/approvals for lookup in renderTool
    currentReviews = state.reviews || [];
    currentApprovals = state.approvals || [];
    currentQuestions = state.questions || [];
    currentCapabilities = state.capabilities || {};
    currentCommands = state.commands || [];
    currentQueue = state.queue || [];
    currentCatalog = state.modelCatalog || null;

    // @ completion candidates: only accept a batch that answers the token the
    // composer is asking about right now. A late reply for an abandoned token
    // would otherwise repopulate a menu the user already closed.
    //
    // The reply's query may be a PREFIX of what is typed now — that is the normal
    // case during fast typing (we asked about "src", the user has since typed
    // "src/ap"). Showing the older-but-still-plausible list avoids blinking the
    // menu out on every keystroke. Anything not a prefix is genuinely unrelated
    // and is ignored until its own reply arrives.
    if (atToken && typeof state.refQuery === 'string' && atToken.query.startsWith(state.refQuery)) {
      atItems = Array.isArray(state.refCandidates) ? state.refCandidates : [];
      if (atIndex >= atItems.length) atIndex = atItems.length > 0 ? 0 : -1;
      renderAtPopup();
    }

    // Brand bar
    const icon = $('brand-icon');
    if (state.brandIconUri) { icon.src = state.brandIconUri; icon.style.display = ''; }
    const sysBtn = $('toggle-sys');
    if (state.systemMessageCount > 0) {
      sysBtn.style.display = '';
      sysBtn.classList.toggle('active', state.showSystemMessages);
      sysBtn.textContent = state.showSystemMessages ? 'SYS✓' : 'SYS';
      sysBtn.title = (state.showSystemMessages ? 'Hide' : 'Show') + ' ' + state.systemMessageCount + ' system message(s)';
    } else {
      sysBtn.style.display = 'none';
    }

    // Connection
    const conn = state.connection;
    setDot(conn);
    const labels = { disconnected: 'Disconnected', connecting: 'Connecting…', connected: 'Connected', error: 'Connection error' };
    $('status-text').textContent = labels[conn] || conn;
    // Reconnect. Always visible, because the case that needs it most is the one
    // where the panel still says "Connected": the Host was restarted (or the
    // desktop app came up on a new port) and the socket we are holding is dead.
    // Clicking it always tears the old session down and negotiates a fresh one,
    // which is what "restart VS Code" used to be the only way to do.
    const connectBtn = $('connect');
    connectBtn.style.display = '';
    connectBtn.disabled = conn === 'connecting';
    connectBtn.textContent = conn === 'connecting'
      ? 'Connecting…'
      : (conn === 'error' ? 'Retry' : (conn === 'connected' ? '⟳ Reconnect' : 'Connect'));
    connectBtn.title = conn === 'connected'
      ? 'Reconnect: drop the current session and negotiate a fresh one'
      : 'Connect to the local DeepSeek Harness Host';
    const hi = state.hostInfo;
    const bits = [];
    if (hi) {
      if (hi.home) bits.push(hi.home);
      if (hi.provider) bits.push(hi.provider);
      if (hi.model) bits.push(hi.model);
    }
    $('host-info').textContent = bits.join(' · ');
    $('mux-status').textContent = state.muxStatus ? ('stream: ' + state.muxStatus) : '';
    if (state.errorMessage) $('host-info').textContent = state.errorMessage;

    // Workspace
    const pendingBanner = $('ws-pending');
    if (state.workspace) {
      $('ws-name').textContent = state.workspace.title || state.workspace.path;
      $('ws-path').textContent = state.workspace.path;
      if (pendingBanner) pendingBanner.style.display = 'none';
    } else if (state.workspace === null) {
      // "No matching harness workspace yet — workspace will be created on first send."
      $('ws-name').textContent = 'Not registered yet';
      $('ws-path').textContent = 'Your first prompt will automatically create the Harness workspace.';
      if (pendingBanner) {
        pendingBanner.textContent = '💡 Workspace will be created lazily on first send.';
        pendingBanner.style.display = '';
      }
    } else {
      $('ws-name').textContent = 'No workspace';
      $('ws-path').textContent = '';
      if (pendingBanner) pendingBanner.style.display = 'none';
    }

    // Sessions. Guarded by a signature: this runs on every push, and a push
    // fires for every streamed chunk. Rebuilding the <select> that often threw
    // away the user's selection mid-interaction to redraw an identical list.
    const sel = $('session-select');
    const sessionSig = state.sessions.map(function (s) {
      return s.sessionId + '\\u0001' + s.label + '\\u0001' + (s.running ? '1' : '0');
    }).join('\\u0002') + '\\u0003' + String(state.activeSessionId);
    if (sessionSig !== lastSessionsSig) {
      lastSessionsSig = sessionSig;
      const prev = sel.value;
      sel.innerHTML = '';
      if (state.sessions.length === 0) {
        const opt = document.createElement('option');
        opt.value = ''; opt.textContent = '(no sessions)';
        sel.appendChild(opt);
      } else {
        for (const s of state.sessions) {
          const opt = document.createElement('option');
          opt.value = s.sessionId;
          opt.textContent = s.label;
          if (state.activeSessionId === s.sessionId) opt.selected = true;
          sel.appendChild(opt);
        }
      }
      if (prev && state.activeSessionId === undefined) sel.value = prev;
    }

    // Messages — reconcile on renderVersion change, or reset when there is no
    // snapshot at all (the connection state may have changed).
    const msgs = $('messages');
    const snap = state.snapshot;
    if (snap && snap.renderVersion !== lastRenderVersion) {
      lastRenderVersion = snap.renderVersion;
      renderTranscript(msgs, snap, state.activeSessionId);
    } else if (!snap) {
      // No snapshot — show contextual empty state based on connection.
      // This branch runs every render when there's no snap, so the message
      // tracks the live connection state instead of caching "Disconnected".
      var emptyMsg;
      if (state.connection === 'connected') {
        emptyMsg = state.workspace === null
          ? 'Workspace will be created on your first send. Type a prompt below to begin.'
          : 'Select a session or send a prompt to start.';
      } else if (state.connection === 'connecting') {
        emptyMsg = 'Connecting to DeepSeek Harness…';
      } else if (state.connection === 'error') {
        emptyMsg = state.errorMessage || 'Connection error';
      } else {
        emptyMsg = 'Disconnected. Click Connect above, or Reconnect in the panel header.';
      }
      var expected = '<div class="empty">' + escapeText(emptyMsg) + '</div>';
      if (msgs.innerHTML !== expected) msgs.innerHTML = expected;
      itemNodes = new Map();
      transcriptEmpty = false;
    }

    // Input controls
    const canSend = state.connection === 'connected' && !state.sending;
    // Send button is enabled whenever connected (even without active session —
    // session+workspace will be created lazily on send).
    $('send').disabled = !canSend;
    $('stop').disabled = !state.canStop;
    $('new-session').disabled = state.connection !== 'connected' || state.workspace === null;
    $('refresh').disabled = state.connection !== 'connected';
    // Steer checkbox only makes sense while the agent is running.
    const running = !!(snap && snap.running);
    $('steer-wrap').style.display = running ? '' : 'none';
    if (!running) $('steer').checked = false;
    renderQueueBar(state);
    renderPending(state);
    renderPendingPanel(state);
    renderSearch(state);
    renderInspector(state);
  }

  // ─── composer attachments ──────────────────────────────────────────────────
  // Previews live here, keyed by the chip id the controller echoes back, so a
  // pasted screenshot is drawn from bytes the browser already holds instead of a
  // base64 copy riding UiState (which is re-pushed on every streamed chunk).
  let attPreview = {};
  let lastPendingSig = null;

  function formatBytes(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderPending(state) {
    const bar = $('attach-bar');
    const items = state.pending || [];
    const sig = items.map(function (p) { return p.id; }).join('|');
    if (sig === lastPendingSig) return;
    lastPendingSig = sig;
    // Drop previews whose chip is gone (sent, removed, or refused on the way up).
    Object.keys(attPreview).forEach(function (id) {
      if (!items.some(function (p) { return p.id === id; })) {
        try { URL.revokeObjectURL(attPreview[id]); } catch (e) { /* already gone */ }
        delete attPreview[id];
      }
    });
    bar.innerHTML = '';
    bar.style.display = items.length > 0 ? '' : 'none';
    items.forEach(function (p) {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      const url = attPreview[p.id];
      if (url) {
        const img = document.createElement('img');
        img.className = 'attach-thumb'; img.src = url; img.alt = '';
        chip.appendChild(img);
      } else {
        const glyph = document.createElement('span');
        glyph.className = 'attach-glyph';
        glyph.textContent = p.kind === 'image' ? '🖼' : '📄';
        chip.appendChild(glyph);
      }
      const name = document.createElement('span');
      name.className = 'attach-name'; name.textContent = p.name; name.title = p.name;
      chip.appendChild(name);
      if (p.bytes) {
        const size = document.createElement('span');
        size.className = 'attach-size'; size.textContent = formatBytes(p.bytes);
        chip.appendChild(size);
      }
      const remove = document.createElement('button');
      remove.className = 'attach-x'; remove.textContent = '✕'; remove.title = 'Remove attachment';
      remove.addEventListener('click', function () { post({ type: 'pendingRemove', id: p.id }); });
      chip.appendChild(remove);
      bar.appendChild(chip);
    });
  }

  // ─── F6: session search panel ──────────────────────────────────────────────
  let lastSearchSig = '';
  function renderSearch(state) {
    const panel = $('search-panel');
    if (!panel || panel.style.display === 'none') return
    const s = state.search
    const sig = s ? (s.query + '|' + s.results.length + '|' + (s.error ? 'e' : '') + (s.disabled ? 'd' : '')) : 'none'
    if (sig === lastSearchSig) return
    lastSearchSig = sig
    const status = $('search-status')
    const results = $('search-results')
    if (!s) { status.textContent = ''; results.innerHTML = ''; return }
    if (s.disabled) {
      status.textContent = '⚠️ Search is disabled on this host deployment.'
      status.className = 'muted warn'
    } else if (s.error) {
      status.textContent = '⚠️ ' + s.error
      status.className = 'muted warn'
    } else {
      status.textContent = s.results.length === 0 ? 'No matches.' : (s.results.length + ' result(s).')
      status.className = 'muted'
    }
    results.innerHTML = ''
    for (const r of s.results) {
      const row = document.createElement('div')
      row.className = 'search-row'
      row.innerHTML = '<div class="search-title">' + escapeText(r.title || r.sessionId) + '</div>'
        + (r.snippet ? '<div class="search-snippet">' + escapeText(r.snippet) + '</div>' : '')
      row.addEventListener('click', () => post({ type: 'selectSession', sessionId: r.sessionId }))
      results.appendChild(row)
    }
  }

  // ─── F7: live event inspector ───────────────────────────────────────────────
  let lastInspectorSeq = -1
  function renderInspector(state) {
    const panel = $('inspector-panel')
    if (!panel || panel.style.display === 'none') return
    const log = state.eventLog || []
    if (log.length === 0 || log[log.length - 1].seq === lastInspectorSeq) return
    lastInspectorSeq = log[log.length - 1].seq
    const list = $('inspector-list')
    // Rebuild, not append. The buffer is a ring, so its head moves as it fills
    // and its tail advances one frame at a time; appending the whole array on
    // every advance piled up a fresh copy of every row each time (300, then
    // 600, then 900 …) instead of showing the newest tail.
    list.innerHTML = ''
    const frag = document.createDocumentFragment()
    for (const f of log) {
      const row = document.createElement('div')
      row.className = 'insp-row'
      const time = new Date(f.at).toLocaleTimeString()
      row.innerHTML = '<span class="insp-seq">' + f.seq + '</span>'
        + '<span class="insp-time">' + time + '</span>'
        + '<span class="insp-kind">' + escapeText(f.kind) + (f.eventType ? ':' + escapeText(f.eventType) : '') + '</span>'
        + '<span class="insp-summary">' + escapeText(f.summary) + '</span>'
      row.title = f.raw
      row.addEventListener('click', () => {
        navigator.clipboard?.writeText(f.raw)
        row.classList.add('copied')
        setTimeout(() => row.classList.remove('copied'), 400)
      })
      frag.appendChild(row)
    }
    list.appendChild(frag)
    list.scrollTop = list.scrollHeight
  }

  // ─── pending waterfalls (approvals + ask_user_question) ──────────────────
  // Both block the Host: an approval holds a tool call, a question holds
  // ask_user_question. Neither resolves on its own, and neither necessarily has
  // a tool row on screen — so they get their own panel above the composer
  // instead of living inside whichever transcript item happens to match.
  //
  // Answers are keyed by option LABEL, not index: that is what the Host records
  // in AskUserQuestionAnswerItem, and what the durable transcript shows later.
  let pendingDraft = {};

  function pendingSignature(approvals, questions) {
    return approvals.map(function (a) { return a.rpcId + ':' + a.state; }).join(',')
      + '||' + questions.map(function (q) { return q.rpcId + ':' + q.state; }).join(',');
  }

  function renderPendingPanel(state) {
    const panel = $('pending-panel');
    if (!panel) return;
    // The panel holds unsent input (radio choices, a half-typed "Other"), so it
    // is rebuilt only when the set of pending requests actually changes —
    // render() runs on every streamed chunk, and rebuilding per chunk would
    // throw away whatever the user had typed.
    const approvals = (currentApprovals || []).filter(function (a) { return a.state !== 'resolved'; });
    const questions = (currentQuestions || []).filter(function (q) { return q.state !== 'resolved'; });
    const sig = pendingSignature(approvals, questions);
    if (sig === renderPendingPanel.lastSig) return;
    renderPendingPanel.lastSig = sig;
    Object.keys(pendingDraft).forEach(function (id) {
      if (!questions.some(function (q) { return q.rpcId === id; })) delete pendingDraft[id];
    });
    panel.innerHTML = '';
    panel.style.display = (approvals.length + questions.length) > 0 ? '' : 'none';
    approvals.forEach(function (ap) { panel.appendChild(renderApprovalPending(ap)); });
    questions.forEach(function (q) { panel.appendChild(renderQuestionPending(q)); });
  }
  renderPendingPanel.lastSig = null;

  function renderApprovalPending(ap) {
    const card = document.createElement('div');
    card.className = 'pending-card' + (ap.canAllow ? '' : ' risk') + (ap.state === 'responding' ? ' responding' : '');
    const kind = document.createElement('div');
    kind.className = 'pending-kind';
    kind.textContent = '⚠ Approval required';
    card.appendChild(kind);
    if (ap.toolName) {
      const tool = document.createElement('div');
      tool.className = 'pending-tool';
      tool.textContent = ap.toolName;
      card.appendChild(tool);
    }
    if (ap.reason) {
      const reason = document.createElement('div');
      reason.className = 'pending-reason';
      reason.textContent = ap.reason;
      card.appendChild(reason);
    }
    if (ap.blockedBy === 'high-risk') {
      const note = document.createElement('div');
      note.className = 'pending-note';
      note.textContent = 'The sidebar will not grant this one — it asks for unrestricted access. Use the Web UI.';
      card.appendChild(note);
    }
    const actions = document.createElement('div');
    actions.className = 'pending-actions';
    if (ap.canAllow) {
      const allow = document.createElement('button');
      allow.className = 'grow';
      allow.textContent = ap.state === 'responding' ? 'Allowing…' : 'Allow once';
      allow.disabled = ap.state !== 'pending';
      allow.addEventListener('click', function () {
        post({ type: 'approvalRespond', rpcId: ap.rpcId, outcome: 'allowed-once' });
      });
      actions.appendChild(allow);
    }
    const deny = document.createElement('button');
    deny.className = 'secondary' + (ap.canAllow ? '' : ' grow');
    deny.textContent = ap.state === 'responding' ? 'Denying…' : 'Deny';
    deny.disabled = ap.state !== 'pending';
    deny.addEventListener('click', function () {
      post({ type: 'approvalRespond', rpcId: ap.rpcId, outcome: 'rejected' });
    });
    actions.appendChild(deny);
    if (!ap.canAllow) {
      const web = document.createElement('button');
      web.className = 'secondary';
      web.textContent = 'Answer in Web UI ↗';
      web.title = 'Hand this request back to the Harness Web UI without answering it here';
      web.addEventListener('click', function () { post({ type: 'waterfallDelegate', rpcId: ap.rpcId }); });
      actions.appendChild(web);
    }
    card.appendChild(actions);
    return card;
  }

  function renderQuestionPending(q) {
    const card = document.createElement('div');
    card.className = 'pending-card' + (q.state === 'responding' ? ' responding' : '');
    const kind = document.createElement('div');
    kind.className = 'pending-kind';
    kind.textContent = q.questions.length > 1
      ? '❓ The agent is asking ' + q.questions.length + ' questions'
      : '❓ The agent is asking you';
    card.appendChild(kind);

    const draft = pendingDraft[q.rpcId] || (pendingDraft[q.rpcId] = { selected: {}, custom: {} });
    const err = document.createElement('div');
    err.className = 'pending-note';
    err.style.display = 'none';
    const slot = function (id, label) { return id + '\u0000' + label; };
    q.questions.forEach(function (item) {
      if (item.header) {
        const head = document.createElement('div');
        head.className = 'pending-head';
        head.textContent = item.header;
        card.appendChild(head);
      }
      const text = document.createElement('div');
      text.className = 'pending-question';
      text.textContent = item.question;
      card.appendChild(text);
      if (item.detail) {
        const detail = document.createElement('pre');
        detail.className = 'pending-detail';
        detail.textContent = item.detail;
        card.appendChild(detail);
      }
      const opts = Array.isArray(item.options) ? item.options : [];
      if (opts.length > 0) {
        const box = document.createElement('div');
        box.className = 'pending-opts';
        opts.forEach(function (opt) {
          const row = document.createElement('label');
          row.className = 'pending-opt';
          const input = document.createElement('input');
          input.type = item.multiSelect ? 'checkbox' : 'radio';
          input.name = 'q-' + q.rpcId + '-' + item.id;
          input.checked = !!draft.selected[slot(item.id, opt.label)];
          input.addEventListener('change', function () {
            // A radio group is exclusive, but the draft is a flat label map, so
            // the previous pick has to be cleared explicitly — otherwise the
            // answer would carry two labels for a single-select question.
            if (!item.multiSelect) {
              Object.keys(draft.selected).forEach(function (k) {
                if (k.indexOf(item.id + '\u0000') === 0) delete draft.selected[k];
              });
            }
            draft.selected[slot(item.id, opt.label)] = input.checked;
            // One question, one choice: choosing IS answering. Matches the Web
            // UI's option cards, which settle on click. With several questions in
            // one request that shortcut would submit empty answers for the rest,
            // so there it stays behind the Answer button.
            if (!item.multiSelect && q.questions.length === 1) submitQuestion(q, err);
          });
          const body = document.createElement('span');
          body.textContent = opt.label;
          if (opt.description) {
            const desc = document.createElement('span');
            desc.className = 'pending-opt-desc';
            desc.textContent = opt.description;
            body.appendChild(desc);
          }
          row.appendChild(input);
          row.appendChild(body);
          box.appendChild(row);
        });
        card.appendChild(box);
      }
      // Free text is always offered: an option list is a menu, not a cage, and
      // the Host's answer type carries a free-text field alongside the selected
      // labels for exactly this case.
      const other = document.createElement('input');
      other.className = 'pending-other';
      other.type = 'text';
      other.placeholder = opts.length > 0 ? 'Other…' : 'Type your answer…';
      other.value = draft.custom[item.id] || '';
      other.addEventListener('input', function () { draft.custom[item.id] = other.value; });
      other.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submitQuestion(q, err); }
      });
      card.appendChild(other);
    });

    card.appendChild(err);
    const actions = document.createElement('div');
    actions.className = 'pending-actions';
    const send = document.createElement('button');
    send.className = 'grow';
    send.textContent = q.state === 'responding' ? 'Answering…' : 'Answer';
    send.disabled = q.state !== 'pending';
    send.addEventListener('click', function () { submitQuestion(q, err); });
    const web = document.createElement('button');
    web.className = 'secondary';
    web.textContent = 'Answer in Web UI ↗';
    web.title = 'Hand this question back to the Harness Web UI without answering it here';
    web.addEventListener('click', function () { post({ type: 'waterfallDelegate', rpcId: q.rpcId }); });
    actions.appendChild(send);
    actions.appendChild(web);
    card.appendChild(actions);
    return card;
  }

  /**
   * Collect the draft for every question in the request and send one batch.
   *
   * Every asked question needs an answer: an incomplete batch is rejected deep
   * inside the tool call, where the user would never see it. So a missing one is
   * reported right here, on the card, instead of being sent to fail remotely.
   */
  function submitQuestion(q, errNode) {
    const draft = pendingDraft[q.rpcId] || { selected: {}, custom: {} };
    const answers = [];
    let missing = '';
    for (const item of q.questions) {
      let picked = (item.options || [])
        .map(function (o) { return o.label; })
        .filter(function (label) { return !!draft.selected[item.id + '\u0000' + label]; });
      if (!item.multiSelect && picked.length > 1) picked = picked.slice(0, 1);
      const custom = (draft.custom[item.id] || '').trim();
      if (picked.length === 0 && custom === '') missing = item.question;
      answers.push({ id: item.id, selected: picked, custom: custom || undefined });
    }
    if (missing) {
      errNode.textContent = 'Answer or type something for: ' + missing;
      errNode.style.display = '';
      return;
    }
    errNode.style.display = 'none';
    post({ type: 'questionAnswer', rpcId: q.rpcId, answers: answers });
  }

  // ─── queued messages (rc.2 session/updateQueue) ──────────────────────────
  function renderQueueBar(state) {
    const bar = $('queue-bar');
    if (!state.activeSessionId || currentQueue.length === 0) {
      bar.style.display = 'none'; bar.innerHTML = ''; return;
    }
    bar.style.display = '';
    bar.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'queue-title';
    title.textContent = currentQueue.length === 1 ? '1 queued message' : (currentQueue.length + ' queued messages');
    bar.appendChild(title);
    for (const q of currentQueue) {
      const row = document.createElement('div');
      row.className = 'queue-item';
      const text = document.createElement('span');
      text.className = 'queue-text';
      text.textContent = q.text;
      text.title = q.text;
      const steerBtn = document.createElement('button');
      steerBtn.className = 'secondary icon';
      steerBtn.textContent = '⚡';
      steerBtn.title = 'Steer: inject into the running turn now';
      steerBtn.addEventListener('click', (e) => { e.stopPropagation(); post({ type: 'queueSteer', itemId: q.id }); });
      const rmBtn = document.createElement('button');
      rmBtn.className = 'secondary icon';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove from queue';
      rmBtn.addEventListener('click', (e) => { e.stopPropagation(); post({ type: 'queueRemove', itemId: q.id }); });
      row.appendChild(text); row.appendChild(steerBtn); row.appendChild(rmBtn);
      bar.appendChild(row);
    }
  }

  // ─── slash command completion (rc.2 commands/list) ───────────────────────
  function slashMatches(text) {
    if (!text.startsWith('/')) return [];
    const word = text.slice(1).toLowerCase();
    return currentCommands.filter((c) => c.name.toLowerCase().startsWith(word)).slice(0, 8);
  }

  function renderSlashPopup() {
    const popup = $('slash-popup');
    if (slashItems.length === 0) { popup.style.display = 'none'; popup.innerHTML = ''; return; }
    popup.style.display = '';
    popup.innerHTML = '';
    slashItems.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'slash-row' + (i === slashIndex ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'slash-name'; name.textContent = '/' + c.name;
      const desc = document.createElement('span');
      desc.className = 'slash-desc';
      desc.textContent = c.description + (c.input && c.input.hint ? '  ' + c.input.hint : '');
      row.appendChild(name); row.appendChild(desc);
      row.addEventListener('click', () => { applySlash(c); });
      popup.appendChild(row);
    });
  }

  function applySlash(c) {
    const ta = $('input');
    ta.value = '/' + c.name + ' ';
    closeSlash();
    ta.focus();
    updateContextPreview();
  }

  function closeSlash() { slashItems = []; slashIndex = -1; renderSlashPopup(); }

  // ─── @file mention completion (host-served fileReferences/list) ─────────────
  // Mirror of the host grammar in src/context/collector.ts: an @path token at
  // the start of input or after whitespace, quoted as @"path with spaces", with
  // directories keeping a trailing slash so completion can descend a level.
  //
  // NOTE: this entire file is a template literal, so every backslash below is
  // doubled on purpose — \\s reaches the webview as \s, whereas a single \s
  // would collapse to plain "s" and silently break the pattern. Same trap as
  // AT_FILE_RE documented further down.
  function activeAtToken(text, cursor) {
    const before = text.slice(0, cursor);
    const quoted = /(?:^|\\s)(@"([^"]*))$/.exec(before);
    if (quoted) return { prefix: quoted[1], query: quoted[2], quoted: true };
    const plain = /(?:^|\\s)(@([^\\s"]*))$/.exec(before);
    if (!plain) return null;
    return { prefix: plain[1], query: plain[2], quoted: false };
  }

  // Byte-for-byte the host's formatFileMention: quote when the path needs it,
  // and leave a quoted directory's quote OPEN so the next query descends.
  function formatMention(candidate, preserveQuote) {
    const path = candidate.kind === 'directory' ? candidate.path + '/' : candidate.path;
    if (/[\\u0000-\\u001f\\u007f-\\u009f"]/.test(path)) return null;
    const quoted = preserveQuote === true || /\\s/.test(path);
    if (!quoted) return '@' + path;
    if (candidate.kind === 'directory') return '@"' + path;
    return '@"' + path + '"';
  }

  function renderAtPopup() {
    const popup = $('at-popup');
    if (atItems.length === 0) { popup.style.display = 'none'; popup.innerHTML = ''; return; }
    popup.style.display = '';
    popup.innerHTML = '';
    atItems.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'at-row' + (i === atIndex ? ' active' : '');
      const glyph = document.createElement('span');
      glyph.className = 'at-glyph';
      glyph.textContent = c.kind === 'directory' ? '📁' : '📄';
      const path = document.createElement('span');
      path.className = 'at-path';
      path.textContent = c.path;
      const kind = document.createElement('span');
      kind.className = 'at-kind';
      kind.textContent = c.kind === 'directory' ? 'folder' : '';
      row.appendChild(glyph); row.appendChild(path); row.appendChild(kind);
      // mousedown, not click: blur would close the popup first.
      row.addEventListener('mousedown', (e) => { e.preventDefault(); applyAt(c); });
      popup.appendChild(row);
    });
  }

  function closeAt() {
    atItems = []; atIndex = -1; atToken = null;
    if (atTimer) { clearTimeout(atTimer); atTimer = null; }
    renderAtPopup();
  }

  function applyAt(candidate) {
    const ta = $('input');
    if (!atToken) return;
    const insertion = formatMention(candidate, atToken.quoted);
    if (insertion === null) { closeAt(); return; }
    const cursor = ta.selectionStart;
    const start = cursor - atToken.prefix.length;
    ta.value = ta.value.slice(0, start) + insertion + ta.value.slice(cursor);
    const caret = start + insertion.length;
    ta.setSelectionRange(caret, caret);
    ta.focus();
    updateContextPreview();
    if (candidate.kind === 'directory') {
      // Completion stays open at the new trailing slash — the host lists the
      // directory's children for the re-queried token.
      refreshAtCompletion();
      return;
    }
    ta.value = ta.value.slice(0, caret) + ' ' + ta.value.slice(caret);
    ta.setSelectionRange(caret + 1, caret + 1);
    closeAt();
  }

  /** Recompute the active token and ask the host for its candidates. */
  function refreshAtCompletion() {
    const ta = $('input');
    const token = activeAtToken(ta.value, ta.selectionStart);
    if (token === null) { closeAt(); return; }
    atToken = token;
    if (atTimer) { clearTimeout(atTimer); atTimer = null; }
    if (token.query === '') {
      // An empty query (a bare @) asks immediately so the menu opens on the
      // keystroke rather than after a debounce.
      post({ type: 'refsQuery', query: '' });
      return;
    }
    atTimer = setTimeout(() => { atTimer = null; post({ type: 'refsQuery', query: token.query }); }, 90);
  }

  // ─── control surface ────────────────────────────────────────────────────────
  // The harness ships plan mode, permission presets, sandbox/approval knobs,
  // todos, goals, subagents and compaction as whole-value session events. Every
  // one is folded in the extension host; here we only draw what arrived — and
  // only offer a control whose write path this host actually serves.
  const PRESET_CANDIDATES = ['read-only', 'workspace-write', 'danger-full-access'];

  function supported(name) { return currentCapabilities[name] === true; }

  function ctlChip(text, extra) {
    const s = document.createElement('span');
    s.className = 'ctl-chip' + (extra ? ' ' + extra : '');
    s.textContent = text;
    return s;
  }

  function ctlSection(title, fill) {
    const box = document.createElement('div');
    box.className = 'ctl-section';
    const h = document.createElement('div');
    h.className = 'ctl-section-title';
    h.textContent = title;
    box.appendChild(h);
    fill(box);
    return box;
  }

  function ctlRow(box) {
    const row = document.createElement('div');
    row.className = 'ctl-row';
    box.appendChild(row);
    return row;
  }

  function ctlNote(box, text) {
    const n = document.createElement('div');
    n.className = 'ctl-note';
    n.textContent = text;
    box.appendChild(n);
    return n;
  }

  function ctlButton(box, label, opts, onClick) {
    const b = document.createElement('button');
    b.className = opts.secondary ? 'secondary' : '';
    b.textContent = label;
    if (opts.disabled) b.disabled = true;
    else b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    box.appendChild(b);
    return b;
  }

  function renderControl(state) {
    const panel = $('control');
    // No session means no control surface: every value here is per-session, and
    // a stale panel from the previous session would be actively misleading.
    const live = state.connection === 'connected' && !!state.activeSessionId;
    if (!live) { panel.style.display = 'none'; lastControlSig = ''; return; }
    panel.style.display = '';
    const c = state.control || null;
    // Rebuild gate. The fold's version covers "the state changed"; capabilities
    // cover "what we are allowed to offer changed" — which can flip without any
    // new event, e.g. after reconnecting to a different host build.
    const sig = String(c ? c.version : -1) + '|' + Object.keys(currentCapabilities).join(',');
    if (sig === lastControlSig) return;
    lastControlSig = sig;

    const summary = $('ctl-summary');
    summary.innerHTML = '';
    const body = $('ctl-body');
    body.innerHTML = '';

    if (c) {
      if (c.planActive === true) summary.appendChild(ctlChip('plan', 'plan'));
      if (c.preset) summary.appendChild(ctlChip(c.preset, c.preset === 'danger-full-access' ? 'risk' : ''));
      const open = (c.todos || []).filter((t) => t.status !== 'completed').length;
      if (open > 0) summary.appendChild(ctlChip(open + ' todo', ''));
      if (c.goal) summary.appendChild(ctlChip('goal:' + c.goal.phase, c.goal.phase === 'active' ? '' : 'running'));
      if ((c.subagents || []).some((s) => s.running)) summary.appendChild(ctlChip('subagent', 'running'));
      if (c.compaction && c.compaction.running) summary.appendChild(ctlChip('compacting', 'running'));
      if (c.model && c.model.model) summary.appendChild(ctlChip(c.model.model, ''));
      const u = state.sessionUsage;
      if (u && u.projected && u.projected.tokenUsage) {
        const t = u.projected.tokenUsage;
        const total = (t.uncachedInputTokens || 0) + (t.outputTokens || 0) + (t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0);
        if (total > 0) summary.appendChild(ctlChip(fmtCompact(total) + ' tok', ''));
      }
    }

    // ── execution knobs ──
    const canCommand = supported('commands/execute');
    body.appendChild(ctlSection('Execution', (box) => {
      const row = ctlRow(box);
      const planOn = !!(c && c.planActive === true);
      const planBtn = ctlButton(row, planOn ? 'Plan mode: on' : 'Plan mode: off',
        { secondary: true, disabled: !canCommand },
        () => post({ type: 'controlPlan', active: !planOn }));
      planBtn.title = canCommand
        ? 'Flip /plan on this session'
        : 'This host does not expose commands/execute';

      if (c && (c.sandbox || c.approvalPolicy)) {
        const chips = ctlRow(box);
        if (c.sandbox) chips.appendChild(ctlChip('sandbox: ' + c.sandbox, c.sandbox === 'danger-full-access' ? 'risk' : ''));
        if (c.approvalPolicy) chips.appendChild(ctlChip('approval: ' + c.approvalPolicy, c.approvalPolicy === 'never' ? 'risk' : ''));
      }

      const presets = PRESET_CANDIDATES.slice();
      if (c && c.preset && presets.indexOf(c.preset) < 0) presets.unshift(c.preset);
      const sel = document.createElement('select');
      for (const name of presets) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (c && c.preset === name) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.disabled = !canCommand;
      sel.title = 'Permission preset (sandbox mode + approval policy)';
      sel.addEventListener('change', (e) => {
        post({ type: 'controlPreset', preset: e.target.value });
      });
      const selRow = ctlRow(box);
      selRow.appendChild(sel);
      if (c && c.agentPreset) ctlNote(box, 'agent preset: ' + c.agentPreset);
    }));

    // ── model + reasoning effort (rc.2 session/modelCatalog + selectModel) ──
    if (currentCatalog && currentCatalog.groups && supported('session/selectModel')) {
      body.appendChild(ctlSection('Model', (box) => {
        const row = ctlRow(box);
        const current = (c && c.model) || {};
        const currentKey = (current.provider || currentCatalog.default.provider) + '|' + (current.model || currentCatalog.default.model);
        const modelSel = document.createElement('select');
        modelSel.title = 'Model for future turns';
        for (const group of currentCatalog.groups) {
          for (const m of (group.models || [])) {
            const key = group.id + '|' + m.id;
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = (m.name || m.id) + (group.name ? ' · ' + group.name : '');
            if (key === currentKey) opt.selected = true;
            modelSel.appendChild(opt);
          }
        }
        const effortSel = document.createElement('select');
        effortSel.title = 'Reasoning effort';
        const fillEfforts = () => {
          effortSel.innerHTML = '';
          const parts = modelSel.value.split('|');
          const gid = parts[0], mid = parts[1];
          let model = null;
          for (const g of currentCatalog.groups) {
            if (g.id !== gid) continue;
            for (const m of (g.models || [])) if (m.id === mid) model = m;
          }
          const efforts = (model && model.reasoning && model.reasoning.efforts) || [];
          const def = (model && model.reasoning && model.reasoning.defaultEffort) || 'high';
          for (const e of efforts) {
            const opt = document.createElement('option');
            opt.value = e.id;
            opt.textContent = 'effort: ' + (e.name || e.id);
            opt.title = e.description || '';
            if (e.id === def) opt.selected = true;
            effortSel.appendChild(opt);
          }
          effortSel.style.display = efforts.length > 0 ? '' : 'none';
        };
        fillEfforts();
        modelSel.addEventListener('change', fillEfforts);
        const applyBtn = ctlButton(row, 'Apply', { secondary: true }, () => {
          const parts = modelSel.value.split('|');
          post({ type: 'controlModel', provider: parts[0], model: parts[1],
            reasoningEffort: effortSel.value || undefined });
        });
        applyBtn.title = 'Select this model (and reasoning effort) for future turns';
        const selRow2 = ctlRow(box);
        selRow2.appendChild(modelSel);
        selRow2.appendChild(effortSel);
      }));
    }

    // ── token usage (event fold + host projections) ──
    const u = state.sessionUsage;
    const t = (u && u.projected && u.projected.tokenUsage) || null;
    const folded = u && u.folded;
    if (t || (folded && folded.steps > 0)) {
      body.appendChild(ctlSection('Token usage', (box) => {
        const src = t || {
          uncachedInputTokens: folded.uncachedInputTokens,
          outputTokens: folded.outputTokens,
          cacheReadTokens: folded.cacheReadTokens,
          cacheWriteTokens: folded.cacheWriteTokens,
        };
        const prompt = (src.uncachedInputTokens || 0) + (src.cacheReadTokens || 0) + (src.cacheWriteTokens || 0);
        const total = prompt + (src.outputTokens || 0);
        const grid = document.createElement('div');
        grid.className = 'usage-grid';
        const add = (label, value) => {
          const cell = document.createElement('div');
          cell.className = 'usage-cell';
          const v = document.createElement('b'); v.textContent = value;
          const l = document.createElement('span'); l.textContent = label;
          cell.appendChild(v); cell.appendChild(l);
          grid.appendChild(cell);
        };
        if (t && t.cacheReadTokens > 0 && prompt > 0) {
          add('cache hit', Math.round((t.cacheReadTokens / prompt) * 1000) / 10 + '%');
        }
        add('total', fmtCompact(total));
        add('input', fmtCompact(src.uncachedInputTokens || 0));
        if (src.cacheReadTokens > 0) add('cache read', fmtCompact(src.cacheReadTokens));
        if (src.cacheWriteTokens > 0) add('cache write', fmtCompact(src.cacheWriteTokens));
        add('output', fmtCompact(src.outputTokens || 0));
        box.appendChild(grid);
        const stats = t && u.projected.sessionStats;
        if (stats && (stats.turns > 0 || stats.llmMs > 0)) {
          const bits = [];
          if (stats.turns > 0) bits.push(stats.turns + ' turns');
          if (stats.llmMs > 0) bits.push((stats.llmMs / 1000).toFixed(1) + 's llm');
          if (stats.ttftMs > 0) bits.push('ttft ' + (stats.ttftMs / 1000).toFixed(2) + 's');
          if (stats.decodeTokens > 0) bits.push(fmtCompact(stats.decodeTokens) + ' decoded');
          if (bits.length > 0) ctlNote(box, bits.join(' · '));
        }
      }));
    }

    // ── todos ──
    const todos = (c && c.todos) || [];
    if (todos.length > 0) {
      body.appendChild(ctlSection('Todos', (box) => {
        const ul = document.createElement('ul');
        ul.className = 'ctl-todos';
        for (const t of todos) {
          const li = document.createElement('li');
          li.className = t.status === 'completed' ? 'done' : (t.status === 'in_progress' ? 'active' : '');
          li.textContent = (t.status === 'completed' ? '✓ ' : t.status === 'in_progress' ? '▸ ' : '· ') + escapeText(t.content);
          ul.appendChild(li);
        }
        box.appendChild(ul);
      }));
    }

    // ── goal ──
    if (c && c.goal) {
      body.appendChild(ctlSection('Goal', (box) => {
        const card = document.createElement('div');
        card.className = 'ctl-goal';
        const text = document.createElement('div');
        text.textContent = escapeText(c.goal.objective);
        const phase = document.createElement('div');
        phase.className = 'ctl-goal-phase';
        const rounds = (c.goal.roundsStarted !== undefined && c.goal.maxGoalRounds !== undefined)
          ? ' · round ' + c.goal.roundsStarted + '/' + c.goal.maxGoalRounds
          : '';
        phase.textContent = c.goal.phase + rounds;
        card.appendChild(text);
        card.appendChild(phase);
        box.appendChild(card);
      }));
    }

    // ── subagents ──
    const subs = (c && c.subagents) || [];
    if (subs.length > 0) {
      body.appendChild(ctlSection('Subagents', (box) => {
        for (const s of subs) {
          const row = ctlRow(box);
          row.appendChild(ctlChip(escapeText(s.name || s.key), s.running ? 'running' : ''));
        }
      }));
    }

    // ── compaction ──
    if (c && c.compaction && (c.compaction.running || c.compaction.summary)) {
      body.appendChild(ctlSection('Compaction', (box) => {
        if (c.compaction.running) ctlNote(box, 'Compacting the conversation…');
        else if (c.compaction.summary) {
          const note = ctlNote(box, escapeText(c.compaction.summary));
          note.title = c.compaction.summary || '';
          if (c.compaction.shadowedTokenCount !== undefined) {
            ctlNote(box, 'reclaimed ~' + c.compaction.shadowedTokenCount + ' tokens');
          }
        }
      }));
    }

    // ── session actions ──
    body.appendChild(ctlSection('Session', (box) => {
      const row = ctlRow(box);
      ctlButton(row, 'Fork', { secondary: true, disabled: !supported('session/fork') },
        () => post({ type: 'controlFork' }));
      ctlButton(row, 'Rename', { secondary: true, disabled: !supported('session/rename') },
        () => post({ type: 'controlRename' }));
      ctlButton(row, 'Compact', { secondary: true, disabled: !supported('commands/execute') },
        () => post({ type: 'controlCompact' }));
      ctlButton(row, 'Archive', { secondary: true, disabled: !supported('workspace/archiveSession') },
        () => post({ type: 'controlArchive' }));
      // Say which ones are absent rather than silently dimming them: "this host
      // is older" is actionable, an inexplicably dead button is not.
      const missing = [];
      if (!supported('session/fork')) missing.push('session/fork');
      if (!supported('session/rename')) missing.push('session/rename');
      if (!supported('workspace/archiveSession')) missing.push('workspace/archiveSession');
      if (!supported('commands/execute')) missing.push('commands/execute');
      if (missing.length > 0) {
        const n = ctlNote(box, 'Not served by this host: ' + missing.join(', '));
        n.className = 'ctl-unsupported';
      }
    }));
  }

  // ─── transcript reconciliation ──────────────────────────────────────────────
  // The transcript used to be torn down and rebuilt on every renderVersion
  // change — and renderVersion changes on every streamed chunk. With N turns on
  // screen that is N markdown re-parses and N rows of DOM per chunk, for the
  // whole life of the turn: measured at 40 turns, ~42 markdown re-parses and
  // ~290 fresh nodes for every 40 characters that arrived. That is the actual
  // mechanism behind "the longer I chat, the laggier it gets".
  //
  // Each item instead carries a stable key (uid) and its own change signature
  // (rev, stamped by ConversationModel on every mutation), so a chunk redraws
  // exactly one row and every other row keeps the node — and the already-parsed
  // markdown — it was given the first time.
  function itemKey(item) {
    return item.kind + ':' + (item.uid != null ? item.uid : item.seq);
  }

  /** Everything about one item that decides what it looks like. */
  function itemSig(item) {
    if (item.rev != null) {
      let s = 'r' + item.rev;
      if (item.kind === 'tool' && item.reviewId) s += '|' + reviewSigFor(item.reviewId);
      return s;
    }
    // No identity stamp (a hand-built snapshot, e.g. in a test): fall back to
    // reading the content itself.
    const f = [item.kind, item.seq, item.text || '', item.state || '',
      item.running ? '1' : '', item.streaming ? '1' : '',
      item.result ? (item.result.text + (item.result.isError ? '!' : '')) : ''];
    if (item.kind === 'tool' && item.reviewId) f.push(reviewSigFor(item.reviewId));
    // A changed-files card carries no text of its own, so its signature is the
    // shape of the summary it is showing.
    if (item.kind === 'changes') {
      f.push(item.error || '', item.loading ? 'asking' : 'settled');
      if (item.summary) f.push(String(item.summary.total), String(item.summary.added), String(item.summary.deleted));
    }
    return f.join('|');
  }

  /** The part of a review that decides how the tool row holding it looks. */
  function reviewSigFor(reviewId) {
    for (let i = 0; i < currentReviews.length; i++) {
      const rv = currentReviews[i];
      if (rv.id !== reviewId) continue;
      let s = rv.state;
      const files = rv.files || [];
      for (let j = 0; j < files.length; j++) {
        const f = files[j];
        s += ';' + f.path + ',' + f.state + ',' + f.addedLines + ',' + f.removedLines
          + ',' + ((f.hunks || []).length);
      }
      return s;
    }
    return '';
  }

  function renderTranscript(msgs, snap, activeSessionId) {
    const items = snap.items;
    if (items.length === 0) {
      itemNodes = new Map();
      if (!transcriptEmpty) {
        msgs.innerHTML = '<div class="empty">' + (activeSessionId
          ? 'No messages yet. Send a prompt below.'
          : 'Select a session to view its history.') + '</div>';
        transcriptEmpty = true;
      }
      return;
    }
    transcriptEmpty = false;
    const next = new Map();
    const order = [];
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const key = itemKey(item);
      const sig = itemSig(item);
      const known = itemNodes.get(key);
      let el;
      if (known && known.sig === sig) {
        el = known.el;
      } else {
        el = renderItem(item);
        changed = true;
      }
      next.set(key, { el: el, sig: sig });
      order.push(el);
    }
    // A shorter list with nothing new still has to be repainted (an item was
    // dropped), which is why both tests are needed.
    if (!changed && next.size === itemNodes.size) return;
    itemNodes = next;
    // Re-attach in order. A reused element was only ever detached, never
    // rebuilt, so its subtree — and the markdown inside it — is still there.
    msgs.innerHTML = '';
    for (let k = 0; k < order.length; k++) msgs.appendChild(order[k]);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ─── per-item render ────────────────────────────────────────────────────────
  function renderItem(item) {
    if (item.kind === 'status') {
      const d = document.createElement('div');
      d.className = 'status-line' + (item.running ? ' running' : '');
      d.textContent = item.text;
      return d;
    }
    if (item.kind === 'system') return renderSystem(item);
    if (item.kind === 'tool') return renderTool(item);
    if (item.kind === 'changes') return renderChangesCard(item);
    return renderMessage(item);
  }

  function renderSystem(item) {
    const d = document.createElement('div');
    d.className = 'system';
    const head = document.createElement('div');
    head.className = 'sys-head';
    head.innerHTML = '<span class="sys-arrow">▸</span><span class="sys-label">Runtime context</span>';
    if (item.source) {
      const s = document.createElement('span');
      s.className = 'sys-source'; s.textContent = ' · ' + escapeText(item.source);
      head.appendChild(s);
    }
    head.addEventListener('click', () => d.classList.toggle('open'));
    d.appendChild(head);
    const body = document.createElement('div');
    body.className = 'sys-body'; body.textContent = item.text;
    d.appendChild(body);
    return d;
  }

  // ─── end-of-turn changed files ─────────────────────────────────────────────
  //
  // A REPORT, not a gate. By the time this card exists the turn has already
  // written these files to disk; the card is how the human is told what changed,
  // and how they undo it. That is why there is no Accept anywhere in it and why
  // the action is called Revert rather than Reject — nothing was ever held back
  // waiting for a verdict, so the only thing a person can meaningfully do here
  // is disagree with what already happened.
  //
  // The list comes from the Host's own per-turn record, which covers every file
  // the turn touched — including ones a shell command edited, which no file
  // tool ever reported.

  var CHANGES_FOLD = 4;
  /** Turn key -> whether the file list is expanded. View state, not model state. */
  var changesExpanded = {};

  function renderChangesCard(item) {
    const d = document.createElement('div');
    d.className = 'changes';

    if (item.error) {
      d.className += ' error';
      const e = document.createElement('div');
      e.className = 'changes-error';
      e.textContent = 'Changed files unavailable — ' + escapeText(item.error);
      d.appendChild(e);
      return d;
    }

    const summary = item.summary;
    if (!summary) {
      if (item.loading) {
        d.className += ' loading';
        d.textContent = 'Reading this turn\u2019s changes\u2026';
      } else {
        // The Host has nothing for this turn (disposed Session, restarted Host).
        // The Web UI renders no card at all in that case, and neither do we —
        // but the row stays in the transcript so keys and indices keep matching.
        d.style.display = 'none';
      }
      return d;
    }

    const files = summary.files || [];
    const turnKey = 't' + item.turn;
    const expanded = changesExpanded[turnKey] === true;

    const head = document.createElement('div');
    head.className = 'changes-head';

    const title = document.createElement('span');
    title.className = 'changes-title';
    if (files.length === 1 && files[0]) {
      const only = files[0].display || files[0].path;
      title.textContent = 'Edited ' + shortPath(only);
      title.title = only;
    } else {
      title.textContent = 'Edited ' + String(summary.total) + ' file' + (summary.total === 1 ? '' : 's');
    }
    head.appendChild(title);

    const stats = document.createElement('span');
    stats.className = 'changes-stats';
    stats.innerHTML = '<span class="added">+' + String(summary.added) + '</span> '
      + '<span class="removed">-' + String(summary.deleted) + '</span>';
    head.appendChild(stats);

    const revertAll = document.createElement('button');
    revertAll.className = 'secondary';
    revertAll.textContent = 'Revert all';
    revertAll.title = 'Undo the file changes this turn made';
    revertAll.addEventListener('click', (ev) => {
      ev.stopPropagation();
      post({ type: 'changesRevertTurn', turn: item.turn });
    });
    head.appendChild(revertAll);
    d.appendChild(head);

    const list = document.createElement('div');
    list.className = 'changes-files';
    const shown = expanded ? files : files.slice(0, CHANGES_FOLD);
    for (let i = 0; i < shown.length; i++) {
      list.appendChild(renderChangesRow(item, shown[i], i));
    }
    d.appendChild(list);

    if (files.length > CHANGES_FOLD) {
      const fold = document.createElement('button');
      fold.className = 'changes-fold secondary';
      fold.textContent = expanded ? 'Collapse' : 'All ' + String(files.length) + ' files';
      fold.addEventListener('click', (ev) => {
        ev.stopPropagation();
        changesExpanded[turnKey] = !expanded;
        redrawChangesCard(item);
      });
      d.appendChild(fold);
    }
    return d;
  }

  function renderChangesRow(item, file, index) {
    const row = document.createElement('div');
    row.className = 'changes-file';

    // The path opens the real file. Paths from the Host's record are relative to
    // the turn's working directory when they are inside it; the host side
    // resolves that against the workspace root.
    const path = document.createElement('span');
    path.className = 'cf-path';
    path.textContent = shortPath(file.display || file.path);
    path.title = (file.display || file.path) + ' — click to open';
    path.addEventListener('click', (ev) => {
      ev.stopPropagation();
      post({ type: 'openFile', path: file.path });
    });

    const stats = document.createElement('span');
    stats.className = 'cf-stats';
    if (file.binary) stats.textContent = 'binary';
    else if (file.oversized) stats.textContent = 'too large';
    else {
      stats.innerHTML = '<span class="added">+' + String(file.added) + '</span> '
        + '<span class="removed">-' + String(file.deleted) + '</span>';
    }

    const diffBtn = document.createElement('button');
    diffBtn.className = 'secondary icon';
    diffBtn.textContent = 'Diff';
    diffBtn.title = 'Open the native diff for this file';
    diffBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      post({ type: 'changesOpenDiff', turn: item.turn, index: index });
    });

    const revertBtn = document.createElement('button');
    revertBtn.className = 'secondary icon';
    revertBtn.textContent = '\u21A9';
    revertBtn.title = 'Undo this file';
    revertBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      post({ type: 'changesRevertFile', turn: item.turn, path: file.path });
    });

    row.appendChild(path);
    row.appendChild(stats);
    row.appendChild(diffBtn);
    row.appendChild(revertBtn);
    return row;
  }

  /**
   * Re-draw one card in place after its fold was toggled.
   *
   * The fold is pure view state, so it must not go through the model — but the
   * reconciler only redraws an item when its rev moved. Swapping the node here
   * keeps the cached element (and therefore the reconciler's bookkeeping) valid.
   */
  function redrawChangesCard(item) {
    const key = itemKey(item);
    const known = itemNodes.get(key);
    if (!known || !known.el || !known.el.parentNode) return;
    const fresh = renderChangesCard(item);
    known.el.parentNode.replaceChild(fresh, known.el);
    known.el = fresh;
  }

  function renderTool(item) {
    const d = document.createElement('div');
    d.className = 'tool' + (item.state === 'error' ? ' error' : '');

    const head = document.createElement('div');
    head.className = 't-head';
    const arrow = document.createElement('span'); arrow.className = 't-arrow'; arrow.textContent = '▸';
    const name = document.createElement('span'); name.className = 't-name';
    name.textContent = '🔧 ' + escapeText(item.name);
    const title = document.createElement('span'); title.className = 't-title';
    title.textContent = presentToolTitle(item);
    const state = document.createElement('span'); state.className = 't-state';
    if (item.state === 'running') { state.classList.add('running'); state.textContent = '● running'; }
    else if (item.state === 'completed') { state.classList.add('done'); state.textContent = '✓ done'; }
    else if (item.state === 'error') { state.classList.add('error'); state.textContent = '⚠ error'; }

    head.appendChild(arrow);
    head.appendChild(name);
    if (title.textContent) head.appendChild(title);
    head.appendChild(state);
    head.addEventListener('click', () => d.classList.toggle('open'));
    d.appendChild(head);

    // Approvals are NOT drawn here any more. They live in the pending panel
    // above the composer, because the card that matters is the one for a
    // waterfall this sidebar has to answer, and that has to be somewhere the
    // user is already looking — not inside whichever transcript row happened to
    // carry the matching callId.

    // Review card (if review linked to this tool)
    if (item.reviewId) {
      const rv = currentReviews.find(r => r.id === item.reviewId);
      // Drawn for every state, not only pending: a card that disappears the
      // instant it is reverted hides the fact that a revert ever happened.
      if (rv) d.appendChild(renderReviewCard(rv));
    }

    const body = document.createElement('div');
    body.className = 't-body';

    const aTitle = document.createElement('div');
    aTitle.className = 't-section-title'; aTitle.textContent = 'Arguments';
    const aPre = document.createElement('pre');
    aPre.textContent = prettyArgs(item.arguments);
    body.appendChild(aTitle); body.appendChild(aPre);

    if (item.result) {
      const rTitle = document.createElement('div');
      rTitle.className = 't-section-title';
      rTitle.textContent = item.result.isError ? 'Error' : 'Result';
      const rPre = document.createElement('pre');
      rPre.className = 't-result';
      rPre.textContent = item.result.text;
      body.appendChild(rTitle); body.appendChild(rPre);
    }
    d.appendChild(body);
    return d;
  }

  // ─── review card ─────────────────────────────────────────────────────────
  function renderReviewCard(rv) {
    const card = document.createElement('div');
    card.className = 't-review ' + rv.state;
    const header = document.createElement('div');
    header.className = 'review-header';
    const title = document.createElement('span');
    title.className = 'review-title';
    title.textContent = 'Changed by this call';
    const stateBadge = document.createElement('span');
    stateBadge.className = 'review-state ' + rv.state;
    // "pending" is the store's word for "on disk, not yet dealt with". There is
    // no verdict to wait for, so the card states what actually happened.
    stateBadge.textContent = rv.state === 'pending' ? 'applied' : rv.state;
    header.appendChild(title);
    header.appendChild(stateBadge);
    card.appendChild(header);

    const filesDiv = document.createElement('div');
    filesDiv.className = 'review-files';
    for (const f of rv.files) {
      const fileRow = document.createElement('div');
      fileRow.className = 'review-file ' + f.state;

      const path = document.createElement('span');
      path.className = 'rf-path';
      path.textContent = shortPath(f.path);
      path.title = f.path;

      const stats = document.createElement('span');
      stats.className = 'rf-stats';
      stats.innerHTML = '<span class="added">+' + f.addedLines + '</span> <span class="removed">-' + f.removedLines + '</span>';

      const openBtn = document.createElement('button');
      openBtn.className = 'secondary icon';
      openBtn.textContent = 'Diff';
      openBtn.title = 'Open diff editor';
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        post({ type: 'reviewOpenDiff', reviewId: rv.id, filePath: f.path });
      });

      fileRow.appendChild(path);
      fileRow.appendChild(stats);
      fileRow.appendChild(openBtn);

      // Undo only. There is no "keep" button because keeping is what already
      // happened — the card cannot un-apply a change that is on disk.
      if (f.state === 'pending') {
        const revertBtn = document.createElement('button');
        revertBtn.className = 'secondary icon';
        revertBtn.textContent = '\u21A9';
        revertBtn.title = 'Revert this file';
        revertBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          post({ type: 'reviewRejectFile', reviewId: rv.id, filePath: f.path });
        });
        fileRow.appendChild(revertBtn);
      } else {
        const stateLabel = document.createElement('span');
        stateLabel.className = 'rf-state ' + f.state;
        stateLabel.textContent = f.state === 'accepted' ? '✓ kept' : f.state === 'rejected' ? '✕ reverted' : f.state;
        fileRow.appendChild(stateLabel);
      }

      filesDiv.appendChild(fileRow);
    }
    card.appendChild(filesDiv);

    // Accept all / Reject all buttons
    if (rv.state === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'review-actions';
      const revertAllBtn = document.createElement('button');
      revertAllBtn.className = 'secondary';
      revertAllBtn.textContent = 'Revert all';
      revertAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        post({ type: 'reviewRejectAll', reviewId: rv.id });
      });
      actions.appendChild(revertAllBtn);
      card.appendChild(actions);
    }
    return card;
  }

  // Mirror of presentTool from view/toolPresentation.ts — keeps the two
  // implementations intentionally simple; this is the rendering-only copy.
  function presentToolTitle(tool) {
    let args; try { if (tool.arguments) args = JSON.parse(tool.arguments); } catch {}
    const a = args || {};
    const n = tool.name;
    const str = (v) => typeof v === 'string' ? v : undefined;
    const tr = (s, n2) => s.length <= n2 ? s : s.slice(0, n2 - 1) + '…';

    switch (n) {
      case 'read': case 'read_file': return str(a.path) || str(a.file) || '';
      case 'write': case 'write_file': return str(a.path) || str(a.file) || '';
      case 'edit': case 'edit_file': return str(a.path) || str(a.file) || '';
      case 'grep': case 'search': case 'search_code':
        return str(a.pattern) ? ('"' + tr(str(a.pattern), 40) + '"') : '';
      case 'bash': case 'shell': case 'run_command':
        return str(a.command) ? tr(str(a.command), 50) : '';
      case 'ls': case 'list_dir': case 'list_directory': return str(a.path) || '';
      case 'cd': return str(a.path) || '';
      case 'pwd': case 'cwd': return '';
      case 'http_get': case 'fetch': case 'curl':
        return str(a.url) ? tr(str(a.url), 60) : '';
      case 'http_post': return str(a.url) ? tr(str(a.url), 60) : '';
      case 'git_status': return '';
      case 'git_log': return '';
      case 'git_diff': return str(a.path) || 'worktree';
      case 'git_commit': return str(a.message) ? ('"' + tr(str(a.message), 50) + '"') : '';
    }
    return '';
  }

  function renderMessage(item) {
    const d = document.createElement('div');
    d.className = 'msg ' + item.kind;
    if (item.kind === 'assistant' && item.streaming) d.dataset.streaming = 'true';
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = item.kind === 'user' ? 'You' : 'Assistant';
    d.appendChild(role);
    if (item.reasoning) {
      const r = document.createElement('div');
      r.className = 'reasoning'; r.textContent = item.reasoning;
      d.appendChild(r);
    }
    const body = document.createElement('div');
    if (item.kind === 'assistant') {
      body.className = 'md';
      body.innerHTML = renderMarkdown(item.text) || (item.streaming ? '' : '');
    } else {
      body.textContent = item.text || '';
    }
    d.appendChild(body);
    if (item.kind === 'assistant' && item.streaming) {
      const cur = document.createElement('span');
      cur.className = 'cursor';
      d.appendChild(cur);
    }
    if (item.kind === 'assistant' && item.usage) {
      const u = document.createElement('div');
      u.className = 'usage';
      const parts = [];
      const use = item.usage;
      const uncached = use.inputTokens != null ? use.inputTokens : undefined;
      const promptTotal = (uncached || 0) + (use.cacheReadTokens || 0) + (use.cacheWriteTokens || 0);
      if (use.cacheReadTokens > 0 && promptTotal > 0) {
        parts.push('cache ' + (Math.round((use.cacheReadTokens / promptTotal) * 1000) / 10) + '%');
      }
      if (uncached != null) parts.push('in ' + fmtCompact(uncached));
      if (use.cacheReadTokens > 0) parts.push('r ' + fmtCompact(use.cacheReadTokens));
      if (use.cacheWriteTokens > 0) parts.push('w ' + fmtCompact(use.cacheWriteTokens));
      if (use.outputTokens != null) parts.push('out ' + fmtCompact(use.outputTokens));
      if (use.reasoningTokens > 0) parts.push('think ' + fmtCompact(use.reasoningTokens));
      u.textContent = parts.join(' · ') + ' tokens';
      d.appendChild(u);
    }
    return d;
  }

  /** Compact token count: 1234 → 1.2k, 2300000 → 2.3M. */
  function fmtCompact(n) {
    if (n == null || isNaN(n)) return '0';
    if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M';
    if (n >= 1000) return (Math.round(n / 100) / 10) + 'k';
    return String(n);
  }

  // ─── @ mention preview ──────────────────────────────────────────────────────
  // Read-only echo of the mentions currently in the box. The extension host
  // sends the message text to the agent verbatim — nothing here is stripped,
  // resolved or inlined.
  // NOTE: doubled backslashes are load-bearing (template literal), see above.
  const MENTION_SOURCE = '@(?:"([^"\\n]*)"|([^\\s"]+))(?::L(\\d+)(?:-L(\\d+)))?';
  function findMentionPreview(text) {
    const found = [];
    const re = new RegExp(MENTION_SOURCE, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      // Only at the start of the text or after whitespace (an email address is
      // not a mention).
      if (m.index > 0 && !/\\s/.test(text.charAt(m.index - 1))) continue;
      const path = m[1] !== undefined ? m[1] : m[2];
      if (path === undefined || path === '') continue;
      found.push({ path: path, lineStart: m[3] ? parseInt(m[3], 10) : undefined, lineEnd: m[4] ? parseInt(m[4], 10) : undefined });
    }
    return found;
  }

  function shortPath(p) {
    const parts = p.split('/');
    if (parts.length <= 3) return p;
    return '…/' + parts.slice(-2).join('/');
  }

  function updateContextPreview() {
    const ta = $('input');
    const text = ta.value;
    const mentions = findMentionPreview(text);
    const bar = $('context-bar');
    const filesContainer = $('context-files');

    filesContainer.innerHTML = '';
    for (const f of mentions) {
      const chip = document.createElement('span');
      chip.className = 'ctx-chip';
      let label = shortPath(f.path);
      if (f.lineStart) label += ':L' + f.lineStart + (f.lineEnd ? '-L' + f.lineEnd : '');
      chip.textContent = label;
      chip.title = 'The agent reads this file itself — no content is pasted.';
      filesContainer.appendChild(chip);
    }

    bar.style.display = mentions.length > 0 ? '' : 'none';
  }

  // ─── event wiring ───────────────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.kind === 'state') render(msg.state);
    if (msg && msg.kind === 'appendInput') {
      const ta = $('input');
      const sep = ta.value.length > 0 && !ta.value.endsWith(' ') ? ' ' : '';
      ta.value += sep + msg.text;
      ta.focus();
      // The cursor moves to the end, so a half-typed token is no longer active.
      closeAt();
      updateContextPreview();
    }
  });

  $('session-select').addEventListener('change', (e) => {
    if (e.target.value) post({ type: 'selectSession', sessionId: e.target.value });
  });
  $('connect').addEventListener('click', () => post({ type: 'connect' }));
  $('new-session').addEventListener('click', () => post({ type: 'newSession' }));
  $('refresh').addEventListener('click', () => post({ type: 'refreshSessions' }));
  $('send').addEventListener('click', () => sendPrompt());
  $('stop').addEventListener('click', () => post({ type: 'stop' }));
  $('open-web-link').addEventListener('click', () => post({ type: 'openWebUI' }));
  $('toggle-sys').addEventListener('click', () => post({ type: 'toggleSystemMessages' }));
  $('move-right').addEventListener('click', () => post({ type: 'moveToSecondarySideBar' }));
  $('ctl-head').addEventListener('click', () => $('control').classList.toggle('open'));

  // ─── F6/F7/F8 toolbar ────────────────────────────────────────────────────────
  $('btn-search').addEventListener('click', () => {
    const p = $('search-panel');
    const open = p.style.display === 'none';
    p.style.display = open ? '' : 'none';
    if (open) { lastSearchSig = ''; renderSearch(currentState); $('search-input').focus(); }
  });
  $('search-close').addEventListener('click', () => { $('search-panel').style.display = 'none'; });
  $('search-go').addEventListener('click', () => { const q = $('search-input').value; if (q.trim()) post({ type: 'searchSessions', query: q }); });
  $('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const q = e.target.value; if (q.trim()) post({ type: 'searchSessions', query: q }); } });
  $('btn-inspector').addEventListener('click', () => {
    const p = $('inspector-panel');
    const open = p.style.display === 'none';
    p.style.display = open ? '' : 'none';
    // Tell the extension, because it is what decides whether the frame ring
    // buffer rides every state push. Nothing reads the buffer while the panel is
    // shut, and it is up to ~300 truncated frames per push.
    post({ type: 'inspectorToggle', open: open });
    // Either way the list is now stale: closed clears it, and reopening has to
    // repaint from whatever the buffer holds.
    $('inspector-list').innerHTML = '';
    lastInspectorSeq = -1;
    if (open) renderInspector(currentState);
  });
  $('inspector-close').addEventListener('click', () => {
    $('inspector-panel').style.display = 'none';
    $('inspector-list').innerHTML = '';
    lastInspectorSeq = -1;
    post({ type: 'inspectorToggle', open: false });
  });
  $('inspector-clear').addEventListener('click', () => { lastInspectorSeq = -1; post({ type: 'inspectorClear' }); $('inspector-list').innerHTML = ''; });
  $('btn-attach').addEventListener('click', () => post({ type: 'attachFile' }));
  $('input').addEventListener('keydown', (e) => {
    // @ mention completion keyboard navigation first.
    if (atItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        atIndex = (atIndex + 1) % atItems.length;
        renderAtPopup(); return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        atIndex = (atIndex - 1 + atItems.length) % atItems.length;
        renderAtPopup(); return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && atIndex >= 0)) {
        e.preventDefault();
        applyAt(atItems[atIndex >= 0 ? atIndex : 0]); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closeAt(); return; }
    }
    // Slash completion keyboard navigation.
    if (slashItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashIndex = (slashIndex + 1) % slashItems.length;
        renderSlashPopup(); return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length;
        renderSlashPopup(); return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && slashIndex >= 0)) {
        e.preventDefault();
        applySlash(slashItems[slashIndex >= 0 ? slashIndex : 0]); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); sendPrompt();
    }
  });
  // Update context preview as user types @ mentions (+ slash popup, @ popup)
  $('input').addEventListener('input', () => {
    updateContextPreview();
    refreshAtCompletion();
    const text = $('input').value;
    const matches = slashMatches(text.trimStart());
    // Only show while typing the command word itself (no space yet).
    const t = text.trimStart();
    // NOTE: this template literal eats single backslashes, so \\s is required
    // to hand the webview a real \s. (Same trap documented above for the
    // mention grammar regexes.)
    const typing = t.startsWith('/') && !/\\s/.test(t);
    slashItems = typing ? matches : [];
    slashIndex = slashItems.length > 0 ? 0 : -1;
    renderSlashPopup();
  });
  // Re-derive the token on caret moves too: arrowing back into a mention should
  // offer its completion again, and arrowing out should close the menu.
  $('input').addEventListener('click', () => { refreshAtCompletion(); });
  $('input').addEventListener('blur', () => setTimeout(() => { closeSlash(); closeAt(); }, 150));

  // ─── composer attachments: paste, drop, and the send gate ──────────────────
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  function fileToPayload(file, index) {
    return new Promise(function (resolve) {
      const reader = new FileReader();
      reader.onload = function () {
        const raw = String(reader.result || '');
        const comma = raw.indexOf(',');
        if (comma < 0) { resolve(null); return; }
        const declared = (file.type || '').toLowerCase();
        const isImage = IMAGE_TYPES.indexOf(declared) >= 0;
        const key = 'composer-' + String(Date.now()) + '-' + String(index);
        if (isImage) {
          try { attPreview[key] = URL.createObjectURL(file); } catch (e) { /* no thumbnail */ }
        }
        resolve({
          kind: isImage ? 'image' : 'file',
          name: file.name || ('pasted-image.' + declared.slice('image/'.length)),
          mediaType: declared,
          data: raw.slice(comma + 1),
          key: key,
        });
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(file);
    });
  }

  async function addLocalFiles(files) {
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const payload = await fileToPayload(files[i], i);
      if (payload) out.push(payload);
    }
    if (out.length > 0) post({ type: 'pendingAdd', items: out });
  }

  function clipboardFiles(clip) {
    const out = [];
    if (!clip) return out;
    if (clip.files && clip.files.length) {
      for (let i = 0; i < clip.files.length; i++) out.push(clip.files[i]);
      return out;
    }
    const items = clip.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') continue;
      const f = items[i].getAsFile();
      if (f) out.push(f);
    }
    return out;
  }

  // A pasted screenshot is an attachment, not text. Plain text paste is left to
  // the browser so the textarea keeps behaving normally.
  $('input').addEventListener('paste', (e) => {
    const files = clipboardFiles(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    void addLocalFiles(files);
  });

  // Drag a file onto the composer to attach it.
  const dropZone = $('input-area');
  dropZone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('drag-over'); });
  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    dropZone.classList.remove('drag-over');
    if (files.length === 0) return;
    e.preventDefault();
    void addLocalFiles(files);
  });

  // Send prompt: the text goes to the agent exactly as typed. @ mentions are
  // ordinary prompt text the host already knows how to hand to the model — the
  // extension host does not read the file or paste its contents.
  function sendPrompt() {
    const ta = $('input');
    const text = ta.value.trim();
    const held = currentState && currentState.pending ? currentState.pending.length : 0;
    // Pictures with no words are a legitimate prompt; the host only refuses a
    // prompt whose every part is blank.
    if (!text && held === 0) return;
    ta.value = '';
    post({ type: 'sendPrompt', text, steer: $('steer').checked === true });
    closeSlash();
    closeAt();
    updateContextPreview();
  }

  // Ask for a connection, but non-destructively: the extension host already
  // auto-connects on activation, and the panel merely opening must not tear that
  // session down and rebuild it. The Reconnect button is what forces.
  post({ type: 'ensureConnected' });
`
