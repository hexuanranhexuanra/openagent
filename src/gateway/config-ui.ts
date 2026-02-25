/**
 * Schema-driven Config UI.
 *
 * Follows the OpenClaw pattern: fetches JSON Schema + uiHints from
 * /api/config/schema, then dynamically renders form fields.
 * No hardcoded field knowledge — adding a new config section or
 * channel only requires updating the Zod schema + uiHints.
 */
export function getConfigUiHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenAgent - Settings</title>
<style>
:root {
  --bg: #0a0a0a;
  --surface: #141414;
  --surface2: #1a1a1a;
  --border: #2a2a2a;
  --border-focus: #4f9cf7;
  --text: #e8e8e8;
  --text-dim: #888;
  --text-label: #b0b0b0;
  --accent: #4f9cf7;
  --accent-hover: #6bb0ff;
  --danger: #e55;
  --success: #4c6;
  --warning: #fa3;
  --radius: 8px;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.6; }
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); }

header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 24px; border-bottom: 1px solid var(--border);
  background: var(--surface);
}
header .logo { font-size: 18px; font-weight: 600; letter-spacing: -0.5px; }
header .logo span { color: var(--accent); }
header nav a {
  margin-left: 20px; font-size: 13px; color: var(--text-dim);
  padding: 4px 12px; border-radius: 6px; transition: all 0.2s;
}
header nav a:hover, header nav a.active {
  color: var(--text); background: var(--surface2);
}

.container { max-width: 900px; margin: 0 auto; padding: 24px; }
.loading { text-align: center; padding: 80px; color: var(--text-dim); }
.loading .spinner {
  width: 24px; height: 24px; border: 2px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%;
  animation: spin 0.8s linear infinite; margin: 0 auto 16px;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Tabs */
.tabs {
  display: flex; gap: 4px; margin-bottom: 24px;
  border-bottom: 1px solid var(--border); padding-bottom: 0;
}
.tab {
  padding: 10px 18px; cursor: pointer; color: var(--text-dim);
  border: none; background: none; font-size: 13px; font-weight: 500;
  border-bottom: 2px solid transparent; transition: all 0.2s;
  font-family: var(--font);
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-content { display: none; }
.tab-content.active { display: block; }

/* Section cards */
.section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); margin-bottom: 16px; overflow: hidden;
}
.section-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; cursor: pointer; user-select: none;
  border-bottom: 1px solid transparent; transition: border-color 0.2s;
}
.section-header:hover { background: var(--surface2); }
.section.open .section-header { border-bottom-color: var(--border); }
.section-title { font-weight: 600; font-size: 14px; }
.section-toggle {
  color: var(--text-dim); font-size: 12px; transition: transform 0.2s;
}
.section.open .section-toggle { transform: rotate(90deg); }
.section-body { padding: 18px; display: none; }
.section.open .section-body { display: block; }

/* Form fields */
.field { margin-bottom: 16px; }
.field:last-child { margin-bottom: 0; }
.field-row { display: flex; align-items: center; gap: 12px; }
.field label {
  display: block; font-size: 12px; font-weight: 500;
  color: var(--text-label); margin-bottom: 4px; text-transform: uppercase;
  letter-spacing: 0.5px;
}
.field .help {
  font-size: 11px; color: var(--text-dim); margin-top: 2px;
}
input[type="text"], input[type="number"], input[type="password"], select, textarea {
  width: 100%; padding: 9px 12px; background: var(--bg);
  border: 1px solid var(--border); border-radius: 6px;
  color: var(--text); font-size: 13px; font-family: var(--font);
  transition: border-color 0.2s;
}
input:focus, select:focus, textarea:focus {
  outline: none; border-color: var(--border-focus);
}
textarea { font-family: var(--mono); font-size: 12px; resize: vertical; min-height: 80px; }
input[type="checkbox"] {
  width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer;
}
.checkbox-row {
  display: flex; align-items: center; gap: 8px;
}
.checkbox-row label {
  margin-bottom: 0; text-transform: none; font-size: 13px; cursor: pointer;
}

/* Buttons */
.actions { margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end; }
.btn {
  padding: 8px 20px; border-radius: 6px; border: none;
  font-size: 13px; font-weight: 500; cursor: pointer;
  font-family: var(--font); transition: all 0.2s;
}
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
.btn-secondary:hover { border-color: var(--text-dim); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Toast */
.toast {
  position: fixed; bottom: 24px; right: 24px;
  padding: 12px 20px; border-radius: 8px;
  font-size: 13px; font-weight: 500;
  transform: translateY(100px); opacity: 0;
  transition: all 0.3s; z-index: 1000; max-width: 400px;
}
.toast.show { transform: translateY(0); opacity: 1; }
.toast.success { background: #1a3a1a; color: var(--success); border: 1px solid #2a5a2a; }
.toast.error { background: #3a1a1a; color: var(--danger); border: 1px solid #5a2a2a; }

/* Status / Meta */
.meta { font-size: 11px; color: var(--text-dim); margin-top: 24px; text-align: center; }
.badge {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 11px; font-weight: 500;
}
.badge-ok { background: #1a3a1a; color: var(--success); }
.badge-warn { background: #3a2a1a; color: var(--warning); }
.badge-off { background: var(--surface2); color: var(--text-dim); }

/* Nested objects */
.nested {
  margin-left: 16px; padding-left: 16px;
  border-left: 2px solid var(--border);
}
</style>
</head>
<body>
<header>
  <div class="logo"><span>Open</span>Agent</div>
  <nav>
    <a href="/">Chat</a>
    <a href="/config" class="active">Settings</a>
  </nav>
</header>

<div class="container">
  <div class="loading" id="loader">
    <div class="spinner"></div>
    <div>Loading configuration schema...</div>
  </div>
  <div id="app" style="display:none"></div>
</div>
<div class="toast" id="toast"></div>

<script>
let schema = null;
let uiHints = {};
let currentConfig = {};
let activeTab = null;

// ─── Bootstrap ───
async function init() {
  try {
    const [schemaRes, configRes] = await Promise.all([
      fetch('/api/config/schema'),
      fetch('/api/config'),
    ]);
    const schemaBundle = await schemaRes.json();
    schema = schemaBundle.schema;
    uiHints = schemaBundle.uiHints || {};
    currentConfig = await configRes.json();
    render();
  } catch (err) {
    document.getElementById('loader').innerHTML =
      '<div style="color:var(--danger)">Failed to load config: ' + err.message + '</div>';
  }
}

function render() {
  document.getElementById('loader').style.display = 'none';
  const app = document.getElementById('app');
  app.style.display = 'block';

  // Group top-level keys into tabs based on uiHints.group
  const groups = {};
  const props = schema.properties || {};
  for (const key of Object.keys(props)) {
    const hint = uiHints[key] || {};
    const group = hint.group || 'other';
    if (!groups[group]) groups[group] = [];
    groups[group].push(key);
  }

  // Sort within each group by order
  for (const g of Object.values(groups)) {
    g.sort((a, b) => ((uiHints[a] || {}).order || 99) - ((uiHints[b] || {}).order || 99));
  }

  // Fixed tab order
  const tabOrder = ['core', 'channels', 'evolution', 'system', 'other'];
  const tabLabels = { core: 'Core', channels: 'Channels', evolution: 'Evolution', system: 'System', other: 'Other' };
  const tabs = tabOrder.filter(t => groups[t] && groups[t].length > 0);

  let tabsHtml = '<div class="tabs">';
  for (const t of tabs) {
    tabsHtml += '<button class="tab" onclick="switchTab(\\''+t+'\\')\" id="tab-'+t+'">' + tabLabels[t] + '</button>';
  }
  tabsHtml += '</div>';

  let contentHtml = '';
  for (const t of tabs) {
    contentHtml += '<div class="tab-content" id="content-'+t+'">';
    for (const key of groups[t]) {
      contentHtml += renderSection(key, props[key], [key]);
    }
    contentHtml += '<div class="actions"><button class="btn btn-primary" onclick="saveAll()">Save Changes</button></div>';
    contentHtml += '</div>';
  }

  app.innerHTML = tabsHtml + contentHtml +
    '<div class="meta">Schema v' + (schema.version || '0.2.0') + ' &middot; Config UI auto-generated from JSON Schema + uiHints</div>';

  switchTab(tabs[0]);
}

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById('tab-' + name);
  const content = document.getElementById('content-' + name);
  if (tab) tab.classList.add('active');
  if (content) content.classList.add('active');
}

// ─── Recursive Renderer ───
function renderSection(key, propSchema, path) {
  const hint = hintFor(path);
  const label = hint.label || humanize(key);
  const isObj = propSchema.type === 'object' && propSchema.properties;

  if (!isObj) return renderField(key, propSchema, path);

  let inner = '';
  const subKeys = Object.keys(propSchema.properties);
  // Sort sub-keys by their hint order
  subKeys.sort((a, b) => {
    const ha = hintFor([...path, a]);
    const hb = hintFor([...path, b]);
    return (ha.order || 99) - (hb.order || 99);
  });

  for (const sk of subKeys) {
    const subPath = [...path, sk];
    const subSchema = propSchema.properties[sk];
    if (subSchema.type === 'object' && subSchema.properties) {
      inner += renderSection(sk, subSchema, subPath);
    } else {
      inner += renderField(sk, subSchema, subPath);
    }
  }

  return '<div class="section open"><div class="section-header" onclick="toggleSection(this)">' +
    '<span class="section-title">' + label + '</span>' +
    '<span class="section-toggle">&#9654;</span></div>' +
    '<div class="section-body">' + inner + '</div></div>';
}

function renderField(key, propSchema, path) {
  const hint = hintFor(path);
  const label = hint.label || humanize(key);
  const help = hint.help || '';
  const placeholder = hint.placeholder || propSchema.default?.toString() || '';
  const currentVal = getNestedValue(currentConfig, path);
  const id = 'field-' + path.join('-');

  // Boolean
  if (propSchema.type === 'boolean') {
    const checked = currentVal === true || (currentVal === undefined && propSchema.default === true);
    return '<div class="field"><div class="checkbox-row">' +
      '<input type="checkbox" id="' + id + '" ' + (checked ? 'checked' : '') +
      ' onchange="setVal(\\'' + path.join('.') + '\\', this.checked)">' +
      '<label for="' + id + '">' + label + '</label></div>' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }

  // Enum
  if (propSchema.enum) {
    const val = currentVal ?? propSchema.default ?? '';
    let options = '';
    for (const v of propSchema.enum) {
      options += '<option value="' + v + '"' + (v === val ? ' selected' : '') + '>' + v + '</option>';
    }
    return '<div class="field"><label for="' + id + '">' + label + '</label>' +
      '<select id="' + id + '" onchange="setVal(\\'' + path.join('.') + '\\', this.value)">' +
      options + '</select>' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }

  // Number
  if (propSchema.type === 'number' || propSchema.type === 'integer') {
    const val = currentVal ?? propSchema.default ?? '';
    return '<div class="field"><label for="' + id + '">' + label + '</label>' +
      '<input type="number" id="' + id + '" value="' + val + '" placeholder="' + placeholder + '"' +
      ' onchange="setVal(\\'' + path.join('.') + '\\', Number(this.value))">' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }

  // Multiline string
  if (hint.multiline) {
    const val = currentVal ?? propSchema.default ?? '';
    return '<div class="field"><label for="' + id + '">' + label + '</label>' +
      '<textarea id="' + id + '" rows="4" placeholder="' + placeholder + '"' +
      ' onchange="setVal(\\'' + path.join('.') + '\\', this.value)">' + escapeHtml(val) + '</textarea>' +
      (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }

  // Sensitive string
  const inputType = hint.sensitive ? 'password' : 'text';
  const val = currentVal ?? (hint.sensitive ? '' : (propSchema.default ?? ''));
  return '<div class="field"><label for="' + id + '">' + label + '</label>' +
    '<input type="' + inputType + '" id="' + id + '" value="' + escapeHtml(String(val)) + '"' +
    ' placeholder="' + placeholder + '"' +
    ' onchange="setVal(\\'' + path.join('.') + '\\', this.value)">' +
    (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
}

// ─── Helpers ───
function hintFor(path) {
  return uiHints[path.join('.')] || {};
}

function humanize(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ')
    .replace(/^./, s => s.toUpperCase()).trim();
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getNestedValue(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function setVal(dotPath, value) {
  const parts = dotPath.split('.');
  let cur = currentConfig;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function toggleSection(el) {
  el.parentElement.classList.toggle('open');
}

async function saveAll() {
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentConfig),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Configuration saved. Restart gateway to apply.', 'success');
    } else {
      showToast('Save failed: ' + (data.error || 'unknown'), 'error');
    }
  } catch (err) {
    showToast('Save error: ' + err.message, 'error');
  }
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  setTimeout(() => { t.classList.remove('show'); }, 3500);
}

init();
</script>
</body>
</html>`;
}
