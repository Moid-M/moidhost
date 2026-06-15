const API = '/api';
let servers = [];
let selectedId = null;
let currentTab = 'dashboard';
let ws = null;
let consoleLines = [];
let consoleSub = null;

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];

function api(path, opts = {}) {
  return fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  }).then(r => {
    if (r.status === 204) return null;
    if (!r.ok) return r.text().then(t => { throw new Error(t) });
    return r.json();
  });
}

function statusClass(s) {
  return (s || 'stopped').toLowerCase();
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── Server List ── */
function renderSidebar() {
  const el = $('#server-list');
  el.innerHTML = servers.map(s => `
    <div class="server-item${s.id === selectedId ? ' active' : ''}" data-id="${s.id}">
      <span class="name">${esc(s.name)}</span>
      <span class="dot ${statusClass(s.status)}"></span>
    </div>
  `).join('');
  el.querySelectorAll('.server-item').forEach(el => {
    el.addEventListener('click', () => selectServer(el.dataset.id));
  });
}

function selectServer(id) {
  selectedId = id;
  closeConsole();
  $('#welcome').style.display = 'none';
  $('#server-view').style.display = 'flex';
  renderSidebar();
  showTab(currentTab);
}

/* ── Tabs ── */
function showTab(name) {
  currentTab = name;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  const s = servers.find(x => x.id === selectedId);
  if (!s) return;
  $('#server-name').textContent = s.name;
  $('#server-status').className = 'status-badge ' + statusClass(s.status);
  $('#server-status').textContent = s.status;

  const tabMap = { dashboard: renderDashboard, console: renderConsole, files: renderFiles, settings: renderSettings };
  (tabMap[name] || (() => {}))(s);
}

/* ── Dashboard ── */
function renderDashboard(s) {
  const el = $('#tab-content');
  el.innerHTML = `
    <div class="dashboard-actions">
      ${s.status === 'running' ? `
        <button class="btn btn-red btn-sm" onclick="action('stop')">Stop</button>
        <button class="btn btn-sm" onclick="action('restart')">Restart</button>
      ` : `
        <button class="btn btn-green btn-sm" onclick="action('start')">Start</button>
      `}
    </div>
    <div class="dashboard-grid">
      <div class="dashboard-card">
        <div class="label">Status</div>
        <div class="value">${esc(s.status)}</div>
      </div>
      <div class="dashboard-card">
        <div class="label">Java Args</div>
        <div class="value" style="font-size:13px;font-family:var(--font-mono)">${esc(s.java_args)}</div>
      </div>
      <div class="dashboard-card">
        <div class="label">Server Jar</div>
        <div class="value" style="font-size:13px;font-family:var(--font-mono)">${esc(s.jar_file)}</div>
      </div>
    </div>
  `;
}

window.action = function(act) {
  api(`/servers/${selectedId}/${act}`, { method: 'POST' }).then(s => {
    const idx = servers.findIndex(x => x.id === s.id);
    if (idx !== -1) servers[idx] = s;
    renderSidebar();
    showTab(currentTab);
    if (act === 'start') openConsole();
  }).catch(e => alert(e.message));
};

/* ── Console ── */
function renderConsole(s) {
  const el = $('#tab-content');
  el.innerHTML = `
    <div class="console-container">
      <div class="console-output" id="console-output">${s.status !== 'running' ? '<div class="line" style="color:var(--text-dim)">Server is not running. Start it from the Dashboard tab.</div>' : ''}</div>
      <div class="console-input-row">
        <input type="text" id="console-input" placeholder="${s.status === 'running' ? 'Type a command...' : 'Start the server first'}" autocomplete="off" ${s.status !== 'running' ? 'disabled' : ''}>
        <button class="btn btn-primary btn-sm" id="console-send" ${s.status !== 'running' ? 'disabled' : ''}>Send</button>
      </div>
    </div>
  `;
  if (s.status !== 'running') return;
  const out = $('#console-output');
  if (consoleLines.length) out.innerHTML = consoleLines.map(l => `<div class="line">${esc(l)}</div>`).join('');
  out.scrollTop = out.scrollHeight;
  $('#console-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendCmd();
  });
  $('#console-send').addEventListener('click', sendCmd);
  openConsole();
}

function sendCmd() {
  const input = $('#console-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cmd', data: cmd }));
  } else {
    api(`/servers/${selectedId}/command`, { method: 'POST', body: JSON.stringify({ command: cmd }) });
  }
}

function openConsole() {
  closeConsole();
  const s = servers.find(x => x.id === selectedId);
  if (!s || s.status !== 'running') return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/servers/${selectedId}/console`);
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'log') {
      consoleLines.push(msg.data);
      if (consoleLines.length > 5000) consoleLines = consoleLines.slice(-5000);
      const out = $('#console-output');
      if (out) {
        out.insertAdjacentHTML('beforeend', `<div class="line">${esc(msg.data)}</div>`);
        out.scrollTop = out.scrollHeight;
      }
    }
  };
  ws.onclose = () => { ws = null; };
}

function closeConsole() {
  if (ws) { ws.close(); ws = null; }
}

/* ── Files ── */
let filePath = '';

function renderFiles(s) {
  filePath = '';
  const el = $('#tab-content');
  el.innerHTML = `
    <div class="files-toolbar">
      <div id="file-breadcrumb" style="flex:1;font-size:13px;color:var(--text-dim)"></div>
      <button class="btn btn-sm" onclick="uploadPlugin()">Upload Plugin</button>
    </div>
    <div class="drop-zone" id="drop-zone">
      <p>Drop files here or click to browse</p>
      <span class="hint">Files are uploaded to the current directory</span>
    </div>
    <div class="file-list" id="file-list">
      <div style="padding:20px;text-align:center;color:var(--text-dim)">Loading...</div>
    </div>
  `;
  loadFiles();
  setupDropZone(s);
}

function breadcrumb() {
  const parts = filePath.split('/').filter(Boolean);
  let html = '<a href="#" class="bc-link" data-dir="" style="color:var(--accent)">root</a>';
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    html += ' / <a href="#" class="bc-link" data-dir="' + escAttr(acc) + '" style="color:var(--accent)">' + esc(p) + '</a>';
  }
  return html;
}

async function loadFiles() {
  const list = $('#file-list');
  const bc = $('#file-breadcrumb');
  if (bc) bc.innerHTML = breadcrumb();
  try {
    const q = filePath ? `?dir=${encodeURIComponent(filePath)}` : '';
    const files = await api(`/servers/${selectedId}/files${q}`);
    const items = [];
    if (filePath) {
      const parent = filePath.split('/').slice(0, -1).join('/');
      items.push(`<div class="file-item" data-dir="${parent}" style="cursor:pointer">
        <div class="file-info"><span class="file-name">..</span></div>
      </div>`);
    }
    for (const f of files) {
      const name = esc(f.name);
      const fullPath = filePath ? filePath + '/' + f.name : f.name;
      items.push(`<div class="file-item" data-path="${escAttr(fullPath)}" data-dir="${f.is_dir ? escAttr(fullPath) : ''}">
        <div class="file-info">
          <span class="file-name ${f.is_dir ? 'dir-link' : ''}">${name}${f.is_dir ? '/' : ''}</span>
          <span class="file-meta">${f.is_dir ? 'dir' : (f.size / 1024).toFixed(1) + ' KB'}</span>
        </div>
        <div class="file-actions">
          <button class="btn btn-sm delete-btn">Delete</button>
        </div>
      </div>`);
    }
    list.innerHTML = items.length ? items.join('') : '<div style="padding:20px;text-align:center;color:var(--text-dim)">Empty directory</div>';

    list.querySelectorAll('[data-dir]').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.file-actions')) return;
        goDir(el.dataset.dir);
      });
    });
    list.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const path = btn.closest('[data-path]').dataset.path;
        deleteFile(path);
      });
    });
    list.querySelectorAll('[data-path]').forEach(el => {
      el.addEventListener('contextmenu', e => {
        showCtx(e, el.dataset.path, !!el.dataset.dir);
      });
    });
    if (bc) bc.querySelectorAll('.bc-link').forEach(el => {
      el.addEventListener('click', e => { e.preventDefault(); goDir(el.dataset.dir); });
    });
  } catch (e) {
    list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--red)">Error: ${e.message}</div>`;
  }
}

window.goDir = function(dir) {
  filePath = dir;
  loadFiles();
};

function setupDropZone(s) {
  const dz = $('#drop-zone');
  dz.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => uploadFiles(input.files);
    input.click();
  });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    uploadFiles(e.dataTransfer.files);
  });
}

window.uploadPlugin = function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.jar';
  input.multiple = true;
  input.onchange = async () => {
    for (const file of input.files) {
      const form = new FormData();
      form.append('file', file);
      form.append('dir', 'plugins');
      try {
        await fetch(API + `/servers/${selectedId}/upload`, { method: 'POST', body: form });
      } catch (e) { alert('Upload failed: ' + e.message); }
    }
    loadFiles();
  };
  input.click();
};

async function uploadFiles(files) {
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    if (filePath) form.append('dir', filePath);
    try {
      await fetch(API + `/servers/${selectedId}/upload`, { method: 'POST', body: form });
    } catch (e) { alert('Upload failed: ' + e.message); }
  }
  loadFiles();
}

window.deleteFile = async function(path) {
  if (!confirm(`Delete ${path}?`)) return;
  try {
    await api(`/servers/${selectedId}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    loadFiles();
  } catch (e) { alert(e.message); }
};

/* ── Settings ── */
function renderSettings(s) {
  const el = $('#tab-content');
  el.innerHTML = `
    <div class="settings-form">
      <div class="form-group">
        <label>Server Name</label>
        <input type="text" id="set-name" value="${esc(s.name)}">
      </div>
      <div class="form-group">
        <label>Java Arguments</label>
        <input type="text" id="set-java" value="${esc(s.java_args)}">
      </div>
      <div class="form-group">
        <label>Server Jar (filename inside server directory)</label>
        <input type="text" id="set-jar" value="${esc(s.jar_file)}">
      </div>
      <div class="form-group">
        <label>Port</label>
        <input type="number" id="set-port" value="${s.port}">
      </div>
      <div class="form-group">
        <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
      </div>
    </div>
  `;
}

window.saveSettings = async function() {
  const body = {
    name: $('#set-name').value,
    java_args: $('#set-java').value,
    jar_file: $('#set-jar').value,
    port: parseInt($('#set-port').value) || 25565,
  };
  try {
    const s = await api(`/servers/${selectedId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    const idx = servers.findIndex(x => x.id === s.id);
    if (idx !== -1) servers[idx] = s;
    renderSidebar();
    showTab(currentTab);
    alert('Settings saved');
  } catch (e) { alert(e.message); }
};

/* ── New Server Modal ── */
$('#new-server-btn').addEventListener('click', () => openModal());

function openModal(server) {
  const overlay = $('#modal-overlay');
  const body = $('#modal-body');
  const isEdit = !!server;
  $('#modal-title').textContent = isEdit ? 'Edit Server' : 'New Server';
  $('#modal-confirm').textContent = isEdit ? 'Save' : 'Create';
  body.innerHTML = `
    <div class="form-group">
      <label>Server Name</label>
      <input type="text" id="f-name" value="${isEdit ? esc(server.name) : ''}" placeholder="My Server">
    </div>
    <div class="form-group">
      <label>Server Jar (filename)</label>
      <input type="text" id="f-jar" value="${isEdit ? esc(server.jar_file) : ''}" placeholder="paper-1.21.1.jar">
    </div>
    <div class="form-group">
      <label>Java Arguments</label>
      <input type="text" id="f-java" value="${isEdit ? esc(server.java_args) : '-Xmx1G -Xms1G'}" placeholder="-Xmx1G -Xms1G">
    </div>
    <div class="form-group">
      <label>Port</label>
      <input type="number" id="f-port" value="${isEdit ? server.port : 25565}" placeholder="25565">
    </div>
  `;
  overlay.style.display = 'flex';
  overlay.dataset.edit = isEdit ? server.id : '';
}

$('#modal-cancel').addEventListener('click', () => closeModal());
$('#modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

$('#modal-form').addEventListener('submit', async e => {
  e.preventDefault();
  const editId = $('#modal-overlay').dataset.edit;
  const body = {
    name: $('#f-name').value,
    jar_file: $('#f-jar').value,
    java_args: $('#f-java').value || '-Xmx1G -Xms1G',
    port: parseInt($('#f-port').value) || 25565,
  };
  if (!body.name || !body.jar_file) { alert('Name and jar file are required'); return; }
  try {
    let s;
    if (editId) {
      s = await api(`/servers/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      s = await api('/servers', { method: 'POST', body: JSON.stringify(body) });
    }
    closeModal();
    await loadServers();
    selectServer(s.id);
  } catch (e) { alert(e.message); }
});

function closeModal() {
  $('#modal-overlay').style.display = 'none';
  $('#modal-overlay').dataset.edit = '';
}

/* ── Polling ── */
async function loadServers() {
  try {
    servers = await api('/servers');
    renderSidebar();
    if (selectedId && servers.find(s => s.id === selectedId)) {
      const s = servers.find(x => x.id === selectedId);
      $('#server-name').textContent = s.name;
      $('#server-status').className = 'status-badge ' + statusClass(s.status);
      $('#server-status').textContent = s.status;
    }
  } catch (_) {}
}

loadServers();
setInterval(loadServers, 5000);

/* ── Context menu ── */
let ctxTarget = null;
let ctxDir = false;

function showCtx(e, path, isDir) {
  e.preventDefault();
  ctxTarget = path;
  ctxDir = isDir;
  const menu = $('#ctx-menu');
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 120) + 'px';
  $$('.ctx-item', menu).forEach(el => {
    el.style.display = el.dataset.action === 'download' && isDir ? 'none' : 'block';
  });
}

function hideCtx() {
  $('#ctx-menu').style.display = 'none';
  ctxTarget = null;
}

$('#ctx-menu').addEventListener('click', async e => {
  const btn = e.target.closest('.ctx-item');
  if (!btn) return;
  const action = btn.dataset.action;
  hideCtx();
  const path = ctxTarget;
  if (!path) return;

  try {
    if (action === 'download') {
      window.open(`/api/servers/${selectedId}/download?path=${encodeURIComponent(path)}`, '_blank');
    } else if (action === 'rename') {
      const name = prompt('New name:', path.split('/').pop());
      if (!name || name === path.split('/').pop()) return;
      await api(`/servers/${selectedId}/files?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });
      loadFiles();
    } else if (action === 'delete') {
      if (!confirm(`Delete "${path}"?`)) return;
      await api(`/servers/${selectedId}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      loadFiles();
    }
  } catch (err) { alert(err.message); }
});

document.addEventListener('click', hideCtx);
document.addEventListener('contextmenu', hideCtx);

/* ── Tab click handlers ── */
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
});

/* ── Keyboard shortcuts ── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});
