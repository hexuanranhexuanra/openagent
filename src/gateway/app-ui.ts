/**
 * Unified SPA shell with sidebar navigation.
 * Pages: Chat, Settings, Memory, Skills, Status.
 *
 * Design follows OpenClaw's Control UI: dark theme, left sidebar,
 * schema-driven settings form, responsive layout.
 */
export function getAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenAgent</title>
<style>
:root {
  --bg: #09090b;
  --sidebar-bg: #0f0f12;
  --surface: #131318;
  --surface2: #1a1a21;
  --surface3: #222230;
  --border: #26262f;
  --border-hover: #38384a;
  --border-focus: #6366f1;
  --text: #e4e4ed;
  --text-dim: #71717a;
  --text-label: #a1a1aa;
  --accent: #6366f1;
  --accent-hover: #818cf8;
  --accent-soft: rgba(99,102,241,0.12);
  --green: #4ade80;
  --green-soft: rgba(74,222,128,0.12);
  --red: #f87171;
  --red-soft: rgba(248,113,113,0.12);
  --yellow: #fbbf24;
  --yellow-soft: rgba(251,191,36,0.12);
  --radius: 10px;
  --radius-sm: 6px;
  --font: 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  --mono: 'SF Mono','JetBrains Mono','Fira Code',monospace;
  --sidebar-w: 220px;
  --transition: 0.15s ease;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font);background:var(--bg);color:var(--text);height:100vh;display:flex;overflow:hidden;font-size:14px;line-height:1.6}

/* ═══ Sidebar ═══ */
.sidebar{
  width:var(--sidebar-w);flex-shrink:0;background:var(--sidebar-bg);
  border-right:1px solid var(--border);display:flex;flex-direction:column;
}
.sidebar-brand{
  padding:20px 18px 16px;display:flex;align-items:center;gap:10px;
  font-size:16px;font-weight:700;letter-spacing:-0.03em;
  border-bottom:1px solid var(--border);
}
.sidebar-brand .dot{
  width:8px;height:8px;border-radius:50%;background:var(--green);
  box-shadow:0 0 8px rgba(74,222,128,0.4);flex-shrink:0;
}
.sidebar-brand .dot.offline{background:var(--red);box-shadow:0 0 8px rgba(248,113,113,0.4)}
.sidebar-nav{flex:1;padding:12px 10px;display:flex;flex-direction:column;gap:2px}
.sidebar-section{
  font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;
  color:var(--text-dim);padding:16px 10px 6px;
}
.nav-item{
  display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:var(--radius-sm);
  cursor:pointer;color:var(--text-dim);font-size:13px;font-weight:500;
  transition:all var(--transition);border:1px solid transparent;
}
.nav-item:hover{background:var(--surface);color:var(--text)}
.nav-item.active{
  background:var(--accent-soft);color:var(--accent);border-color:rgba(99,102,241,0.15);
}
.nav-item svg{width:18px;height:18px;flex-shrink:0;opacity:0.7}
.nav-item.active svg{opacity:1}
.sidebar-footer{
  padding:14px 18px;border-top:1px solid var(--border);
  font-size:11px;color:var(--text-dim);
}

/* ═══ Main ═══ */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.page{display:none;flex:1;flex-direction:column;overflow:hidden}
.page.active{display:flex}
.page-header{
  padding:18px 28px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
}
.page-header h1{font-size:18px;font-weight:600;letter-spacing:-0.02em}
.page-header .subtitle{font-size:12px;color:var(--text-dim);margin-top:2px}
.page-body{flex:1;overflow-y:auto;padding:24px 28px}
.page-body::-webkit-scrollbar{width:6px}
.page-body::-webkit-scrollbar-track{background:transparent}
.page-body::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}

/* ═══ Chat Page ═══ */
#chat-messages{
  flex:1;overflow-y:auto;padding:24px 28px;display:flex;flex-direction:column;gap:14px;
}
#chat-messages::-webkit-scrollbar{width:6px}
#chat-messages::-webkit-scrollbar-track{background:transparent}
#chat-messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.msg{
  max-width:78%;padding:14px 18px;border-radius:var(--radius);font-size:14px;
  line-height:1.65;white-space:pre-wrap;word-wrap:break-word;
  animation:fadeIn 0.2s ease;
}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.msg.user{align-self:flex-end;background:var(--accent-soft);border:1px solid rgba(99,102,241,0.15)}
.msg.assistant{align-self:flex-start;background:var(--surface);border:1px solid var(--border)}
.msg.tool{
  align-self:flex-start;background:var(--surface2);border:1px solid var(--border);
  font-family:var(--mono);font-size:12px;color:var(--text-dim);padding:10px 14px;max-width:70%;
}
.msg.error{align-self:flex-start;background:var(--red-soft);border:1px solid rgba(248,113,113,0.2);color:var(--red)}
.msg.system{align-self:center;background:transparent;color:var(--text-dim);font-size:12px;padding:4px}
.msg .label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-dim);margin-bottom:5px}
.msg code{background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:4px;font-family:var(--mono);font-size:13px}
.msg pre{background:rgba(0,0,0,0.35);padding:12px;border-radius:8px;overflow-x:auto;margin:8px 0;font-family:var(--mono);font-size:13px}
#chat-input-area{
  padding:16px 28px;border-top:1px solid var(--border);display:flex;gap:12px;flex-shrink:0;
  background:var(--sidebar-bg);
}
#chat-input-area textarea{
  flex:1;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);
  padding:12px 16px;color:var(--text);font-family:var(--font);font-size:14px;
  resize:none;min-height:44px;max-height:160px;outline:none;transition:border-color var(--transition);
}
#chat-input-area textarea:focus{border-color:var(--border-focus);box-shadow:0 0 0 3px var(--accent-soft)}
#chat-input-area textarea::placeholder{color:var(--text-dim)}
.chat-send-btn{
  background:var(--accent);border:none;color:#fff;width:44px;height:44px;
  border-radius:var(--radius);cursor:pointer;display:flex;align-items:center;
  justify-content:center;transition:all var(--transition);flex-shrink:0;align-self:flex-end;
}
.chat-send-btn:hover{filter:brightness(1.15);transform:scale(1.03)}
.chat-send-btn:disabled{opacity:0.35;cursor:not-allowed;transform:none}
.chat-send-btn svg{width:18px;height:18px}

/* ═══ Settings Page ═══ */
.settings-section{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  margin-bottom:14px;overflow:hidden;
}
.settings-section-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:13px 18px;cursor:pointer;user-select:none;transition:background var(--transition);
}
.settings-section-head:hover{background:var(--surface2)}
.settings-section.open .settings-section-head{border-bottom:1px solid var(--border)}
.settings-section-title{font-weight:600;font-size:13px}
.settings-section-chevron{color:var(--text-dim);font-size:11px;transition:transform 0.2s}
.settings-section.open .settings-section-chevron{transform:rotate(90deg)}
.settings-section-body{padding:16px 18px;display:none}
.settings-section.open .settings-section-body{display:block}
.field{margin-bottom:14px}
.field:last-child{margin-bottom:0}
.field label{display:block;font-size:11px;font-weight:600;color:var(--text-label);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em}
.field .help{font-size:11px;color:var(--text-dim);margin-top:3px}
input[type="text"],input[type="number"],input[type="password"],select,textarea.field-input{
  width:100%;padding:9px 12px;background:var(--bg);border:1px solid var(--border);
  border-radius:var(--radius-sm);color:var(--text);font-size:13px;font-family:var(--font);
  transition:border-color var(--transition);
}
input:focus,select:focus,textarea.field-input:focus{outline:none;border-color:var(--border-focus)}
textarea.field-input{font-family:var(--mono);font-size:12px;resize:vertical;min-height:80px}
input[type="checkbox"]{width:16px;height:16px;accent-color:var(--accent);cursor:pointer}
.checkbox-row{display:flex;align-items:center;gap:8px}
.checkbox-row label{margin-bottom:0;text-transform:none;font-size:13px;cursor:pointer}
.nested{margin-left:16px;padding-left:16px;border-left:2px solid var(--border)}

/* ═══ Cards ═══ */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:12px}
.card-title{font-weight:600;font-size:13px;margin-bottom:8px}
.card-row{display:flex;justify-content:space-between;padding:6px 0;font-size:13px}
.card-row .dim{color:var(--text-dim)}
.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center}
.stat-card .value{font-size:24px;font-weight:700;letter-spacing:-0.03em}
.stat-card .label{font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;margin-top:4px}

/* ═══ Memory Page ═══ */
.memory-tabs{display:flex;gap:4px;margin-bottom:16px}
.memory-tab{
  padding:8px 16px;cursor:pointer;border:1px solid var(--border);border-radius:var(--radius-sm);
  background:transparent;color:var(--text-dim);font-size:12px;font-weight:500;
  font-family:var(--font);transition:all var(--transition);
}
.memory-tab:hover{border-color:var(--border-hover);color:var(--text)}
.memory-tab.active{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
.memory-content{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:20px;font-family:var(--mono);font-size:13px;line-height:1.7;
  white-space:pre-wrap;min-height:300px;max-height:60vh;overflow-y:auto;
}

/* ═══ Skills Page ═══ */
.skill-item{
  display:flex;align-items:center;justify-content:space-between;
  padding:12px 16px;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius-sm);margin-bottom:8px;
}
.skill-name{font-weight:600;font-size:13px}
.skill-file{font-size:11px;color:var(--text-dim);font-family:var(--mono)}

/* ═══ Buttons ═══ */
.btn{
  padding:8px 18px;border-radius:var(--radius-sm);border:none;font-size:13px;
  font-weight:500;cursor:pointer;font-family:var(--font);transition:all var(--transition);
}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.btn-ghost{background:transparent;color:var(--text-dim);border:1px solid var(--border)}
.btn-ghost:hover{border-color:var(--border-hover);color:var(--text)}
.btn:disabled{opacity:0.4;cursor:not-allowed}
.actions-bar{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}

/* ═══ Badge ═══ */
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
.badge-green{background:var(--green-soft);color:var(--green)}
.badge-red{background:var(--red-soft);color:var(--red)}
.badge-yellow{background:var(--yellow-soft);color:var(--yellow)}
.badge-dim{background:var(--surface2);color:var(--text-dim)}

/* ═══ Toast ═══ */
.toast{
  position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:var(--radius);
  font-size:13px;font-weight:500;transform:translateY(80px);opacity:0;
  transition:all 0.3s;z-index:1000;max-width:400px;
}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{background:#132713;color:var(--green);border:1px solid #1a3a1a}
.toast.error{background:#271313;color:var(--red);border:1px solid #3a1a1a}

/* ═══ Loading ═══ */
.spinner{
  width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--accent);
  border-radius:50%;animation:spin 0.7s linear infinite;margin:0 auto;
}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-state{text-align:center;padding:60px;color:var(--text-dim)}
.typing-dots{display:inline-flex;gap:3px}
.typing-dots span{width:5px;height:5px;border-radius:50%;background:var(--text-dim);animation:blink 1.2s infinite both}
.typing-dots span:nth-child(2){animation-delay:0.2s}
.typing-dots span:nth-child(3){animation-delay:0.4s}
@keyframes blink{0%,80%,100%{opacity:0.3}40%{opacity:1}}
</style>
</head>
<body>

<!-- ═══ Sidebar ═══ -->
<div class="sidebar">
  <div class="sidebar-brand">
    <div class="dot" id="ws-dot"></div>
    <span>OpenAgent</span>
  </div>
  <div class="sidebar-nav">
    <div class="sidebar-section">Main</div>
    <div class="nav-item active" onclick="navigate('chat')" id="nav-chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Chat
    </div>
    <div class="nav-item" onclick="navigate('settings')" id="nav-settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </div>

    <div class="sidebar-section">Agent</div>
    <div class="nav-item" onclick="navigate('memory')" id="nav-memory">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
      Memory
    </div>
    <div class="nav-item" onclick="navigate('skills')" id="nav-skills">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
      Skills
    </div>
    <div class="nav-item" onclick="navigate('status')" id="nav-status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Status
    </div>
  </div>
  <div class="sidebar-footer">
    v0.2.0 &middot; Bun runtime
  </div>
</div>

<!-- ═══ Main Content ═══ -->
<div class="main">

  <!-- ─── Chat Page ─── -->
  <div class="page active" id="page-chat">
    <div class="page-header">
      <div><h1>Chat</h1><div class="subtitle">Talk to your agent</div></div>
      <button class="btn btn-ghost" onclick="resetChat()">New Chat</button>
    </div>
    <div id="chat-messages">
      <div class="msg system">Connected. Send a message to start.</div>
    </div>
    <div id="chat-input-area">
      <textarea id="chat-input" placeholder="Type a message... (Shift+Enter for newline)" rows="1"></textarea>
      <button class="chat-send-btn" id="chat-send" onclick="sendChat()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
  </div>

  <!-- ─── Settings Page ─── -->
  <div class="page" id="page-settings">
    <div class="page-header">
      <div><h1>Settings</h1><div class="subtitle">Configuration auto-generated from schema</div></div>
      <button class="btn btn-primary" onclick="saveAllSettings()">Save Changes</button>
    </div>
    <div class="page-body" id="settings-body">
      <div class="loading-state"><div class="spinner"></div><div style="margin-top:12px">Loading schema...</div></div>
    </div>
  </div>

  <!-- ─── Memory Page ─── -->
  <div class="page" id="page-memory">
    <div class="page-header">
      <div><h1>Memory</h1><div class="subtitle">Agent's persistent knowledge files</div></div>
    </div>
    <div class="page-body">
      <div class="memory-tabs">
        <button class="memory-tab active" onclick="loadMemory('SOUL',this)">SOUL.md</button>
        <button class="memory-tab" onclick="loadMemory('USER',this)">USER.md</button>
        <button class="memory-tab" onclick="loadMemory('WORLD',this)">WORLD.md</button>
      </div>
      <div class="memory-content" id="memory-content">Loading...</div>
    </div>
  </div>

  <!-- ─── Skills Page ─── -->
  <div class="page" id="page-skills">
    <div class="page-header">
      <div><h1>Skills</h1><div class="subtitle">Dynamic .skill.ts modules</div></div>
      <button class="btn btn-ghost" onclick="loadSkills()">Refresh</button>
    </div>
    <div class="page-body" id="skills-body">
      <div class="loading-state"><div class="spinner"></div></div>
    </div>
  </div>

  <!-- ─── Status Page ─── -->
  <div class="page" id="page-status">
    <div class="page-header">
      <div><h1>Status</h1><div class="subtitle">System health & diagnostics</div></div>
      <button class="btn btn-ghost" onclick="loadStatus()">Refresh</button>
    </div>
    <div class="page-body" id="status-body">
      <div class="loading-state"><div class="spinner"></div></div>
    </div>
  </div>

</div>

<div class="toast" id="toast"></div>

<script>
// ═══════════════════════════════════════
// Navigation
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// WebSocket (Chat)
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// Settings (schema-driven)
// ═══════════════════════════════════════
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

  return '<div class="settings-section open"><div class="settings-section-head" onclick="this.parentElement.classList.toggle(\\'open\\')">' +
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
      ' onchange="setConfigVal(\\'' + path.join('.') + '\\',this.checked)">' +
      '<label for="' + id + '">' + label + '</label></div>' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }
  if (propSchema.enum) {
    const v = val ?? propSchema.default ?? '';
    let opts = '';
    for (const e of propSchema.enum) opts += '<option value="' + e + '"' + (e === v ? ' selected' : '') + '>' + e + '</option>';
    return '<div class="field"><label for="' + id + '">' + label + '</label>' +
      '<select id="' + id + '" onchange="setConfigVal(\\'' + path.join('.') + '\\',this.value)">' + opts + '</select>' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }
  if (propSchema.type === 'number' || propSchema.type === 'integer') {
    const v = val ?? propSchema.default ?? '';
    return '<div class="field"><label for="' + id + '">' + label + '</label>' +
      '<input type="number" id="' + id + '" value="' + v + '" placeholder="' + ph + '"' +
      ' onchange="setConfigVal(\\'' + path.join('.') + '\\',Number(this.value))">' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }
  if (hint.multiline) {
    const v = val ?? propSchema.default ?? '';
    return '<div class="field"><label for="' + id + '">' + label + '</label>' +
      '<textarea class="field-input" id="' + id + '" rows="4" placeholder="' + ph + '"' +
      ' onchange="setConfigVal(\\'' + path.join('.') + '\\',this.value)">' + escHtml(v) + '</textarea>' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }
  const inputType = hint.sensitive ? 'password' : 'text';
  const v = val ?? (hint.sensitive ? '' : (propSchema.default ?? ''));
  return '<div class="field"><label for="' + id + '">' + label + '</label>' +
    '<input type="' + inputType + '" id="' + id + '" value="' + escHtml(String(v)) + '" placeholder="' + ph + '"' +
    ' onchange="setConfigVal(\\'' + path.join('.') + '\\',this.value)">' +
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

// ═══════════════════════════════════════
// Memory
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// Skills
// ═══════════════════════════════════════
async function loadSkills() {
  const body = document.getElementById('skills-body');
  body.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const res = await fetch('/api/skills');
    const data = await res.json();
    if (!data.loaded || data.loaded.length === 0) {
      body.innerHTML = '<div class="loading-state" style="padding:40px">No dynamic skills loaded.<br><span style="color:var(--text-dim);font-size:12px">Create a .skill.ts file in user-space/skills/</span></div>';
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

// ═══════════════════════════════════════
// Status
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// Utilities
// ═══════════════════════════════════════
function getNestedVal(obj, path) { let c = obj; for (const k of path) { if (c == null) return undefined; c = c[k]; } return c; }
function humanize(k) { return k.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^./, s => s.toUpperCase()).trim(); }
function escHtml(s) { if (typeof s !== 'string') return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtMd(text) {
  let h = escHtml(text);
  h = h.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
  h = h.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  h = h.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  return h;
}
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 3500);
}

// ═══════════════════════════════════════
// Init
// ═══════════════════════════════════════
const chatInput = document.getElementById('chat-input');
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px'; });

connectWs();

// Hash routing
const initPage = window.location.hash.replace('#', '') || 'chat';
if (['chat','settings','memory','skills','status'].includes(initPage)) navigate(initPage);
</script>
</body>
</html>`;
}
