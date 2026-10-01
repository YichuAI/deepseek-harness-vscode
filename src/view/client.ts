/**
 * Webview-side client script (renderer-side logic — runs inside the <script>
 * block wrapped with the CSP nonce).
 *
 * Responsibilities:
 *   • Render UiState snapshots (full re-render on renderVersion change only).
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
  let lastRenderVersion = -1;
  let currentReviews = [];
  let currentApprovals = [];
  let currentCapabilities = {};
  let currentCommands = [];
  let currentQueue = [];
  let currentCatalog = null;
  let lastControlSig = '';
  // Slash completion state
  let slashItems = [];
  let slashIndex = -1;

  // ─── markdown renderer (webview-only, html disabled!) ──────────────────────
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  // Override the default link renderer to add target=_blank + rel=noopener
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
    // Store reviews/approvals for lookup in renderTool
    currentReviews = state.reviews || [];
    currentApprovals = state.approvals || [];
    currentCapabilities = state.capabilities || {};
    currentCommands = state.commands || [];
    currentQueue = state.queue || [];
    currentCatalog = state.modelCatalog || null;

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
    const hi = state.hostInfo;
    const bits: string[] = [];
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

    // Sessions
    const sel = $('session-select');
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

    // Messages — rebuild on renderVersion change (streaming fix) OR when
    // there's no snapshot yet (connection state may have changed).
    const msgs = $('messages');
    const snap = state.snapshot;
    if (snap && snap.renderVersion !== lastRenderVersion) {
      lastRenderVersion = snap.renderVersion;
      if (snap.items.length === 0) {
        msgs.innerHTML = '<div class="empty">' + (state.activeSessionId ? 'No messages yet. Send a prompt below.' : 'Select a session to view its history.') + '</div>';
      } else {
        msgs.innerHTML = '';
        for (const item of snap.items) msgs.appendChild(renderItem(item));
      }
      msgs.scrollTop = msgs.scrollHeight;
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
        emptyMsg = 'Disconnected. Click Connect or restart the extension.';
      }
      var expected = '<div class="empty">' + escapeText(emptyMsg) + '</div>';
      if (msgs.innerHTML !== expected) msgs.innerHTML = expected;
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

    // Approval card (if pending approval linked to this tool)
    if (item.approvalRpcId) {
      const ap = currentApprovals.find(a => a.rpcId === item.approvalRpcId);
      if (ap && ap.state !== 'resolved') {
        d.appendChild(renderApprovalCard(ap));
      }
    }

    // Review card (if review linked to this tool)
    if (item.reviewId) {
      const rv = currentReviews.find(r => r.id === item.reviewId);
      if (rv && rv.state === 'pending') {
        d.appendChild(renderReviewCard(rv));
      }
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

  // ─── approval card ──────────────────────────────────────────────────────
  function renderApprovalCard(ap) {
    const card = document.createElement('div');
    card.className = 't-approval ' + ap.state;
    const label = document.createElement('div');
    label.className = 'approval-label';
    label.textContent = '⚠ Approval required';
    card.appendChild(label);
    if (ap.toolName) {
      const tool = document.createElement('div');
      tool.className = 'approval-tool';
      tool.textContent = 'Tool: ' + escapeText(ap.toolName);
      card.appendChild(tool);
    }
    if (ap.reason) {
      const reason = document.createElement('div');
      reason.className = 'approval-reason';
      reason.textContent = 'Reason: ' + escapeText(ap.reason);
      card.appendChild(reason);
    }
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const denyBtn = document.createElement('button');
    denyBtn.className = 'secondary';
    denyBtn.textContent = 'Deny';
    denyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'approvalRespond', rpcId: ap.rpcId, outcome: 'rejected' });
    });
    actions.appendChild(denyBtn);
    if (ap.canAllow) {
      const allowBtn = document.createElement('button');
      allowBtn.textContent = 'Allow once';
      allowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        post({ type: 'approvalRespond', rpcId: ap.rpcId, outcome: 'allowed-once' });
      });
      actions.appendChild(allowBtn);
    } else {
      const note = document.createElement('span');
      note.className = 'approval-webonly';
      note.textContent = 'Review in Web UI';
      actions.appendChild(note);
    }
    if (ap.state === 'responding') {
      const note = document.createElement('span');
      note.className = 'approval-responding';
      note.textContent = 'Sending…';
      actions.appendChild(note);
    }
    card.appendChild(actions);
    return card;
  }

  // ─── review card ─────────────────────────────────────────────────────────
  function renderReviewCard(rv) {
    const card = document.createElement('div');
    card.className = 't-review ' + rv.state;
    const header = document.createElement('div');
    header.className = 'review-header';
    const title = document.createElement('span');
    title.className = 'review-title';
    title.textContent = 'Changed Files';
    const stateBadge = document.createElement('span');
    stateBadge.className = 'review-state ' + rv.state;
    stateBadge.textContent = rv.state;
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

      // Per-file accept/reject buttons
      if (f.state === 'pending') {
        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'secondary icon';
        rejectBtn.textContent = '✕';
        rejectBtn.title = 'Reject (revert changes)';
        rejectBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          post({ type: 'reviewRejectFile', reviewId: rv.id, filePath: f.path });
        });
        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'icon';
        acceptBtn.textContent = '✓';
        acceptBtn.title = 'Accept (keep changes)';
        acceptBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          post({ type: 'reviewAcceptFile', reviewId: rv.id, filePath: f.path });
        });
        fileRow.appendChild(rejectBtn);
        fileRow.appendChild(acceptBtn);
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
      const rejectAllBtn = document.createElement('button');
      rejectAllBtn.className = 'secondary';
      rejectAllBtn.textContent = 'Reject All';
      rejectAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        post({ type: 'reviewRejectAll', reviewId: rv.id });
      });
      const acceptAllBtn = document.createElement('button');
      acceptAllBtn.textContent = 'Accept All';
      acceptAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        post({ type: 'reviewAcceptAll', reviewId: rv.id });
      });
      actions.appendChild(rejectAllBtn);
      actions.appendChild(acceptAllBtn);
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

  // ─── @file parsing (webview-side preview only; authoritative parse is in extension host) ──
  // NOTE: This code lives inside a template literal. Backslash sequences like \\s must be
  // doubled (\\\\s) so the output JS receives \s, not s. Without doubling, \s→s and \d→d,
  // breaking the regex entirely ([^\s:] becomes [^s:] which does NOT exclude whitespace).
  const AT_FILE_RE = /@file:([^\\s:]+(?::(?!L\\d)\\\\?[^\\s:]*)*)(?::L(\\d+)(?:-L(\\d+))?)?/g;
  function parseAtFilePreview(text) {
    const files = [];
    let m;
    const re = new RegExp(AT_FILE_RE.source, 'g');
    while ((m = re.exec(text)) !== null) {
      const entry = { path: m[1].replace(/\\\\/g, '/'), lineStart: m[2] ? parseInt(m[2], 10) : undefined, lineEnd: m[3] ? parseInt(m[3], 10) : undefined };
      files.push(entry);
    }
    return files;
  }

  function shortPath(p) {
    const parts = p.split('/');
    if (parts.length <= 3) return p;
    return '…/' + parts.slice(-2).join('/');
  }

  function updateContextPreview() {
    const ta = $('input');
    const text = ta.value;
    const atFiles = parseAtFilePreview(text);
    const bar = $('context-bar');
    const fileChip = $('context-active-file');
    const selChip = $('context-selection');
    const filesContainer = $('context-files');

    // @file chips
    filesContainer.innerHTML = '';
    for (const f of atFiles) {
      const chip = document.createElement('span');
      chip.className = 'ctx-chip';
      let label = shortPath(f.path);
      if (f.lineStart) label += ':L' + f.lineStart + (f.lineEnd ? '-L' + f.lineEnd : '');
      chip.textContent = label;
      filesContainer.appendChild(chip);
    }

    // Show/hide bar
    const hasAny = atFiles.length > 0;
    bar.style.display = hasAny ? '' : 'none';
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
      updateContextPreview();
    }
  });

  $('session-select').addEventListener('change', (e) => {
    if (e.target.value) post({ type: 'selectSession', sessionId: e.target.value });
  });
  $('new-session').addEventListener('click', () => post({ type: 'newSession' }));
  $('refresh').addEventListener('click', () => post({ type: 'refreshSessions' }));
  $('send').addEventListener('click', () => sendPrompt());
  $('stop').addEventListener('click', () => post({ type: 'stop' }));
  $('open-web-link').addEventListener('click', () => post({ type: 'openWebUI' }));
  $('toggle-sys').addEventListener('click', () => post({ type: 'toggleSystemMessages' }));
  $('move-right').addEventListener('click', () => post({ type: 'moveToSecondarySideBar' }));
  $('ctl-head').addEventListener('click', () => $('control').classList.toggle('open'));
  $('input').addEventListener('keydown', (e) => {
    // Slash completion keyboard navigation first.
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
  // Update context preview as user types @file references (+ slash popup)
  $('input').addEventListener('input', () => {
    updateContextPreview();
    const text = $('input').value;
    const matches = slashMatches(text.trimStart());
    // Only show while typing the command word itself (no space yet).
    const typing = /^\/\S*$/.test(text.trimStart()) && text.trimStart().startsWith('/');
    slashItems = typing ? matches : [];
    slashIndex = slashItems.length > 0 ? 0 : -1;
    renderSlashPopup();
  });
  $('input').addEventListener('blur', () => setTimeout(closeSlash, 150));

  // Send prompt: the extension host does authoritative @file parsing and
  // inlines file content into the user message. Steer is read from the
  // checkbox (only shown while the agent is running).
  function sendPrompt() {
    const ta = $('input');
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    post({ type: 'sendPrompt', text, steer: $('steer').checked === true });
    closeSlash();
    updateContextPreview();
  }

  post({ type: 'connect' });
`
