// Navigation
let currentPage = 'chat';
const pageLoaded = { settings: false, memory: false, skills: false, status: false };

function navigate(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.getElementById('nav-' + page).classList.add('active');
  window.location.hash = page;

  if (page === 'settings' && !pageLoaded.settings) loadSettings();
  if (page === 'memory' && !pageLoaded.memory) { loadMemory('SOUL'); pageLoaded.memory = true; }
  if (page === 'skills' && !pageLoaded.skills) loadSkills();
  if (page === 'status' && !pageLoaded.status) loadStatus();
}

// WebSocket (Chat)
let ws = null;
let msgId = 0;
let currentMsgEl = null;
let currentMsgText = '';
let isStreaming = false;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onopen = () => { document.getElementById('ws-dot').className = 'dot'; };
  ws.onclose = () => { document.getElementById('ws-dot').className = 'dot offline'; setTimeout(connectWs, 3000); };
  ws.onerror = () => { document.getElementById('ws-dot').className = 'dot offline'; };
  ws.onmessage = (e) => { try { handleWsMsg(JSON.parse(e.data)); } catch {} };
}

function handleWsMsg(msg) {
  if (msg.type !== 'event') return;
  const p = msg.payload || {};
  switch (msg.event) {
    case 'agent_text':
      if (!currentMsgEl) { currentMsgEl = addChatMsg('assistant', ''); currentMsgText = ''; }
      currentMsgText += (p.content || '');
      currentMsgEl.innerHTML = '<div class="label">Assistant</div>' + fmtMd(currentMsgText);
      scrollChat();
      break;
    case 'agent_tool_start':
      addChatMsg('tool', '> ' + (p.toolName || '?') + ' ' + JSON.stringify(p.toolArgs || {}).slice(0, 120));
      break;
    case 'agent_tool_result':
      addChatMsg('tool', '< ' + (p.toolResult || '').slice(0, 400));
      break;
    case 'agent_done':
      currentMsgEl = null; currentMsgText = ''; setStreaming(false);
      break;
    case 'agent_error':
      addChatMsg('error', p.error || 'Unknown error');
      currentMsgEl = null; setStreaming(false);
      break;
  }
}

function sendChat() {
  const el = document.getElementById('chat-input');
  const text = el.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  addChatMsg('user', text);
  el.value = ''; el.style.height = 'auto';
  ws.send(JSON.stringify({ type: 'req', id: String(++msgId), method: 'chat', params: { message: text } }));
  setStreaming(true);
}

function resetChat() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'req', id: String(++msgId), method: 'reset', params: {} }));
  }
  document.getElementById('chat-messages').innerHTML = '<div class="msg system">Session reset.</div>';
  currentMsgEl = null; currentMsgText = '';
}

function addChatMsg(role, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  if (role === 'user') el.innerHTML = '<div class="label">You</div>' + escHtml(text);
  else if (role === 'assistant') el.innerHTML = '<div class="label">Assistant</div>' + fmtMd(text);
  else el.textContent = text;
  document.getElementById('chat-messages').appendChild(el);
  scrollChat();
  return el;
}

function setStreaming(v) {
  isStreaming = v;
  document.getElementById('chat-send').disabled = v;
  const indicator = document.getElementById('typing-indicator');
  if (v) {
    if (!indicator) {
      const el = document.createElement('div');
      el.id = 'typing-indicator';
      el.className = 'msg system';
      el.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span> Thinking...';
      el.style.cssText = 'display:flex;align-items:center;gap:8px;color:var(--text-dim);font-size:12px';
      document.getElementById('chat-messages').appendChild(el);
      scrollChat();
    }
  } else if (indicator) {
    indicator.remove();
  }
}
function scrollChat() { const c = document.getElementById('chat-messages'); c.scrollTop = c.scrollHeight; }

// Settings (schema-driven)
let schema = null, uiHints = {}, currentConfig = {};

async function loadSettings() {
  try {
    const [sRes, cRes] = await Promise.all([fetch('/api/config/schema'), fetch('/api/config')]);
    const bundle = await sRes.json();
    schema = bundle.schema; uiHints = bundle.uiHints || {};
    currentConfig = await cRes.json();
    renderSettings();
    pageLoaded.settings = true;
  } catch (err) {
    document.getElementById('settings-body').innerHTML =
      '<div class="loading-state" style="color:var(--red)">Failed: ' + err.message + '</div>';
  }
}

function renderSettings() {
  const body = document.getElementById('settings-body');
  const props = schema.properties || {};

  const groups = {};
  for (const key of Object.keys(props)) {
    const h = uiHints[key] || {};
    const g = h.group || 'other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(key);
  }
  for (const g of Object.values(groups)) {
    g.sort((a, b) => ((uiHints[a] || {}).order || 99) - ((uiHints[b] || {}).order || 99));
  }

  const order = ['core', 'channels', 'evolution', 'system', 'other'];
  let html = '';
  for (const grp of order) {
    if (!groups[grp] || !groups[grp].length) continue;
    for (const key of groups[grp]) {
      html += renderSettingsSection(key, props[key], [key]);
    }
  }
  body.innerHTML = html;
}

function renderSettingsSection(key, propSchema, path) {
  const hint = uiHints[path.join('.')] || {};
  const label = hint.label || humanize(key);
  if (propSchema.type !== 'object' || !propSchema.properties) return renderSettingsField(key, propSchema, path);

  const subKeys = Object.keys(propSchema.properties);
  subKeys.sort((a, b) => ((uiHints[path.concat(a).join('.')] || {}).order || 99) - ((uiHints[path.concat(b).join('.')] || {}).order || 99));

  let inner = '';
  for (const sk of subKeys) {
    const sp = [...path, sk];
    const ss = propSchema.properties[sk];
    inner += (ss.type === 'object' && ss.properties) ? renderSettingsSection(sk, ss, sp) : renderSettingsField(sk, ss, sp);
  }

  return '<div class="settings-section open"><div class="settings-section-head" onclick="this.parentElement.classList.toggle(\'open\')">' +
    '<span class="settings-section-title">' + label + '</span>' +
    '<span class="settings-section-chevron">&#9654;</span></div>' +
    '<div class="settings-section-body">' + inner + '</div></div>';
}

function renderSettingsField(key, propSchema, path) {
  const hint = uiHints[path.join('.')] || {};
  const label = hint.label || humanize(key);
  const help = hint.help || '';
  const ph = hint.placeholder || (propSchema.default != null ? String(propSchema.default) : '');
  const val = getNestedVal(currentConfig, path);
  const id = 'f-' + path.join('-');

  if (propSchema.type === 'boolean') {
    const checked = val === true || (val == null && propSchema.default === true);
    return '<div class="field"><div class="checkbox-row">' +
      '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') +
      ' onchange="setConfigVal(\'' + path.join('.') + '\',this.checked)">' +
      '<label for="' + id + '">' + label + '</label></div>' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }
  if (propSchema.enum) {
    const v = val ?? propSchema.default ?? '';
    let opts = '';
    for (const e of propSchema.enum) opts += '<option value="' + e + '"' + (e === v ? ' selected' : '') + '>' + e + '</option>';
    return '<div class="field"><label for="' + id + '">' + label + '</label>' +
      '<select id="' + id + '" onchange="setConfigVal(\'' + path.join('.') + '\',this.value)">' + opts + '</select>' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }
  if (propSchema.type === 'number' || propSchema.type === 'integer') {
    const v = val ?? propSchema.default ?? '';
    return '<div class="field"><label for="' + id + '">' + label + '</label>' +
      '<input type="number" id="' + id + '" value="' + v + '" placeholder="' + ph + '"' +
      ' onchange="setConfigVal(\'' + path.join('.') + '\',Number(this.value))">' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }
  if (hint.multiline) {
    const v = val ?? propSchema.default ?? '';
    return '<div class="field"><label for="' + id + '">' + label + '</label>' +
      '<textarea class="field-input" id="' + id + '" rows="4" placeholder="' + ph + '"' +
      ' onchange="setConfigVal(\'' + path.join('.') + '\',this.value)">' + escHtml(v) + '</textarea>' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }
  const inputType = hint.sensitive ? 'password' : 'text';
  const v = val ?? (hint.sensitive ? '' : (propSchema.default ?? ''));
  return '<div class="field"><label for="' + id + '">' + label + '</label>' +
    '<input type="' + inputType + '" id="' + id + '" value="' + escHtml(String(v)) + '" placeholder="' + ph + '"' +
    ' onchange="setConfigVal(\'' + path.join('.') + '\',this.value)">' +
    (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
}

function setConfigVal(dotPath, value) {
  const parts = dotPath.split('.');
  let cur = currentConfig;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

async function saveAllSettings() {
  try {
    const res = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentConfig) });
    const data = await res.json();
    showToast(data.ok ? 'Saved. Restart gateway to apply.' : ('Error: ' + (data.error || '?')), data.ok ? 'success' : 'error');
  } catch (err) { showToast('Save failed: ' + err.message, 'error'); }
}

// Memory
async function loadMemory(file, tabEl) {
  if (tabEl) { document.querySelectorAll('.memory-tab').forEach(t => t.classList.remove('active')); tabEl.classList.add('active'); }
  const el = document.getElementById('memory-content');
  el.textContent = 'Loading...';
  try {
    const res = await fetch('/api/memory/' + file);
    const data = await res.json();
    el.textContent = data.content || '(empty)';
  } catch (err) { el.textContent = 'Error: ' + err.message; }
}

// Skills
async function loadSkills() {
  const body = document.getElementById('skills-body');
  body.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const res = await fetch('/api/skills');
    const data = await res.json();
    if (!data.loaded || data.loaded.length === 0) {
      body.innerHTML = '<div class="loading-state" style="padding:40px">No dynamic skills loaded.<br><span style="color:var(--text-dim);font-size:12px">Create a .skill.py file in user-space/skills/</span></div>';
      return;
    }
    let html = '';
    for (const s of data.loaded) {
      html += '<div class="skill-item"><div><div class="skill-name">' + escHtml(s.name) + '</div>' +
        '<div class="skill-file">' + escHtml(s.description || '') + '</div></div>' +
        '<span class="badge badge-green">Loaded</span></div>';
    }
    if (data.files && data.files.length > 0) {
      html += '<div style="margin-top:16px"><div class="card-title">Files on disk</div>';
      for (const f of data.files) html += '<div style="font-family:var(--mono);font-size:12px;color:var(--text-dim);padding:4px 0">' + escHtml(f) + '</div>';
      html += '</div>';
    }
    body.innerHTML = html;
    pageLoaded.skills = true;
  } catch (err) { body.innerHTML = '<div class="loading-state" style="color:var(--red)">Error: ' + err.message + '</div>'; }
}

// Status
async function loadStatus() {
  const body = document.getElementById('status-body');
  body.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const [healthRes, statusRes, sessionsRes, toolsRes] = await Promise.all([
      fetch('/api/health'), fetch('/api/status'), fetch('/api/sessions'), fetch('/api/tools'),
    ]);
    const health = await healthRes.json();
    const status = await statusRes.json();
    const sessions = await sessionsRes.json();
    const tools = await toolsRes.json();

    const uptimeMin = Math.floor(health.uptime / 60);
    const uptimeSec = Math.floor(health.uptime % 60);

    body.innerHTML =
      '<div class="card-grid">' +
        '<div class="stat-card"><div class="value">' + status.runtime + '</div><div class="label">Runtime</div></div>' +
        '<div class="stat-card"><div class="value">' + status.pid + '</div><div class="label">PID</div></div>' +
        '<div class="stat-card"><div class="value">' + status.memoryMB + ' MB</div><div class="label">Memory</div></div>' +
        '<div class="stat-card"><div class="value">' + uptimeMin + 'm ' + uptimeSec + 's</div><div class="label">Uptime</div></div>' +
        '<div class="stat-card"><div class="value">' + (sessions.sessions ? sessions.sessions.length : 0) + '</div><div class="label">Sessions</div></div>' +
        '<div class="stat-card"><div class="value">' + (tools.tools ? tools.tools.length : 0) + '</div><div class="label">Tools</div></div>' +
      '</div>' +
      '<div class="card"><div class="card-title">Tools</div>' +
      (tools.tools || []).map(function(t) {
        return '<div class="card-row"><span>' + escHtml(t.name) + '</span><span class="dim">' + escHtml((t.description || '').slice(0, 60)) + '</span></div>';
      }).join('') +
      '</div>' +
      '<div class="card"><div class="card-title">Sessions</div>' +
      (sessions.sessions && sessions.sessions.length > 0 ?
        sessions.sessions.map(function(s) {
          return '<div class="card-row"><span>' + escHtml(s.channel + ':' + s.peerId) + '</span><span class="dim">' + s.messageCount + ' msgs</span></div>';
        }).join('') :
        '<div style="color:var(--text-dim);font-size:13px;padding:8px 0">No active sessions</div>'
      ) +
      '</div>';
    pageLoaded.status = true;
  } catch (err) { body.innerHTML = '<div class="loading-state" style="color:var(--red)">Error: ' + err.message + '</div>'; }
}

// Utilities
function getNestedVal(obj, path) { let c = obj; for (const k of path) { if (c == null) return undefined; c = c[k]; } return c; }
function humanize(k) { return k.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^./, s => s.toUpperCase()).trim(); }
function escHtml(s) { if (typeof s !== 'string') return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtMd(text) {
  let h = escHtml(text);
  h = h.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return h;
}
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 3500);
}

// Init
const chatInput = document.getElementById('chat-input');
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px'; });

connectWs();

// Hash routing
const initPage = window.location.hash.replace('#', '') || 'chat';
if (['chat','settings','memory','skills','status'].includes(initPage)) navigate(initPage);
