export function getWebChatHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenAgent</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-hover: #1a1a26;
    --border: #2a2a3a;
    --text: #e4e4ed;
    --text-muted: #8888a0;
    --accent: #6c63ff;
    --accent-glow: rgba(108, 99, 255, 0.15);
    --user-bg: #1e1e32;
    --assistant-bg: #161622;
    --error-bg: #2d1b1b;
    --tool-bg: #1a1a28;
    --radius: 12px;
    --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  header .logo {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  header .logo .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #4ade80;
    box-shadow: 0 0 8px rgba(74, 222, 128, 0.5);
  }

  header .logo .dot.offline { background: #f87171; box-shadow: 0 0 8px rgba(248, 113, 113, 0.5); }

  header .actions { display: flex; gap: 8px; }

  header button {
    background: var(--surface-hover);
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 6px 14px;
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  header button:hover {
    background: var(--border);
    color: var(--text);
  }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    scroll-behavior: smooth;
  }

  #messages::-webkit-scrollbar { width: 6px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .msg {
    max-width: 80%;
    padding: 14px 18px;
    border-radius: var(--radius);
    font-size: 14px;
    line-height: 1.65;
    white-space: pre-wrap;
    word-wrap: break-word;
    animation: fadeIn 0.2s ease;
  }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

  .msg.user {
    align-self: flex-end;
    background: var(--user-bg);
    border: 1px solid var(--border);
  }

  .msg.assistant {
    align-self: flex-start;
    background: var(--assistant-bg);
    border: 1px solid var(--border);
  }

  .msg.tool {
    align-self: flex-start;
    background: var(--tool-bg);
    border: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-muted);
    padding: 10px 14px;
    max-width: 70%;
  }

  .msg.error {
    align-self: flex-start;
    background: var(--error-bg);
    border: 1px solid #4a2020;
    color: #f87171;
  }

  .msg.system {
    align-self: center;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    padding: 4px;
  }

  .msg .label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }

  .msg code {
    background: rgba(255,255,255,0.06);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 13px;
  }

  .msg pre {
    background: rgba(0,0,0,0.3);
    padding: 12px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 8px 0;
    font-family: var(--mono);
    font-size: 13px;
  }

  .typing-indicator {
    display: flex;
    gap: 4px;
    padding: 14px 18px;
    align-self: flex-start;
  }

  .typing-indicator span {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
    animation: blink 1.4s infinite both;
  }

  .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
  .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes blink {
    0%, 80%, 100% { opacity: 0.3; }
    40% { opacity: 1; }
  }

  #input-area {
    padding: 16px 24px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    display: flex;
    gap: 12px;
    flex-shrink: 0;
  }

  #input-area textarea {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 16px;
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    resize: none;
    min-height: 44px;
    max-height: 160px;
    outline: none;
    transition: border-color 0.15s ease;
  }

  #input-area textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  #input-area textarea::placeholder { color: var(--text-muted); }

  #send-btn {
    background: var(--accent);
    border: none;
    color: #fff;
    width: 44px;
    height: 44px;
    border-radius: 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
    flex-shrink: 0;
    align-self: flex-end;
  }

  #send-btn:hover { filter: brightness(1.15); transform: scale(1.04); }
  #send-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

  #send-btn svg { width: 20px; height: 20px; }
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="dot" id="status-dot"></div>
    <span>OpenAgent</span>
  </div>
  <div class="actions">
    <button onclick="resetSession()">New Chat</button>
  </div>
</header>

<div id="messages">
  <div class="msg system">Connected. Send a message to start.</div>
</div>

<div id="input-area">
  <textarea id="input" placeholder="Type a message... (Shift+Enter for newline)" rows="1"></textarea>
  <button id="send-btn" onclick="sendMessage()">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  </button>
</div>

<script>
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const statusDot = document.getElementById('status-dot');

let ws = null;
let msgIdCounter = 0;
let currentAssistantEl = null;
let currentAssistantText = '';
let isStreaming = false;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + location.host + '/ws');

  ws.onopen = () => {
    statusDot.className = 'dot';
  };

  ws.onclose = () => {
    statusDot.className = 'dot offline';
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    statusDot.className = 'dot offline';
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleServerMessage(msg);
    } catch {}
  };
}

function handleServerMessage(msg) {
  if (msg.type === 'event') {
    const p = msg.payload || {};
    switch (msg.event) {
      case 'agent_text':
        if (!currentAssistantEl) {
          currentAssistantEl = addMessage('assistant', '');
          currentAssistantText = '';
        }
        currentAssistantText += (p.content || '');
        currentAssistantEl.innerHTML = '<div class="label">Assistant</div>' + formatMarkdown(currentAssistantText);
        scrollToBottom();
        break;

      case 'agent_tool_start':
        addMessage('tool', '> Tool: ' + (p.toolName || 'unknown') + '\\n  Args: ' + JSON.stringify(p.toolArgs || {}, null, 2));
        break;

      case 'agent_tool_result':
        addMessage('tool', '< Result: ' + truncate(p.toolResult || '', 500));
        break;

      case 'agent_done':
        currentAssistantEl = null;
        currentAssistantText = '';
        setStreaming(false);
        break;

      case 'agent_error':
        addMessage('error', 'Error: ' + (p.error || 'Unknown error'));
        currentAssistantEl = null;
        setStreaming(false);
        break;
    }
  }
}

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  addMessage('user', text);
  inputEl.value = '';
  inputEl.style.height = 'auto';

  const id = String(++msgIdCounter);
  ws.send(JSON.stringify({ type: 'req', id, method: 'chat', params: { message: text } }));
  setStreaming(true);
}

function resetSession() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'req', id: String(++msgIdCounter), method: 'reset', params: {} }));
  messagesEl.innerHTML = '<div class="msg system">Session reset. Start a new conversation.</div>';
  currentAssistantEl = null;
  currentAssistantText = '';
}

function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  if (role === 'user') {
    el.innerHTML = '<div class="label">You</div>' + escapeHtml(text);
  } else if (role === 'assistant') {
    el.innerHTML = '<div class="label">Assistant</div>' + formatMarkdown(text);
  } else if (role === 'tool') {
    el.textContent = text;
  } else if (role === 'error') {
    el.textContent = text;
  } else {
    el.textContent = text;
  }
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function setStreaming(v) {
  isStreaming = v;
  sendBtn.disabled = v;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  return html;
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
});

connect();
</script>
</body>
</html>`;
}
