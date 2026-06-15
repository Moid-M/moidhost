const API = '/api';
let servers = [];
let selectedId = null;
let currentTab = 'dashboard';
let ws = null;
let consoleLines = [];
let filePath = '';
let editingFile = null;

const statsCpu = [], statsMem = [], statsDisk = [];
let statsInterval = null;

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

function statusClass(s) { return (s || 'stopped').toLowerCase(); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtBytes(b) { const u=['B','KB','MB','GB','TB']; let i=0,v=b; while(v>=1024&&i<u.length-1){v/=1024;i++} return v.toFixed(i>0?1:0)+' '+u[i]; }

function fmtTime(ticks) {
  if (!ticks) return '0m';
  const secs = Math.floor(ticks / 20);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? h+'h '+m+'m' : m+'m';
}

/* ── Custom Modal ── */
function showModal(title, msg, opts = {}) {
  return new Promise(resolve => {
    const existing = $('.custom-prompt-overlay');
    if (existing) existing.remove();
    const ov = document.createElement('div');
    ov.className = 'custom-prompt-overlay';
    ov.innerHTML = `<div class="custom-prompt">
      <h3>${esc(title)}</h3>
      <p>${msg}</p>
      <div class="custom-prompt-actions">
        ${opts.cancel ? '<button class="btn" data-value="cancel">' + esc(opts.cancel) + '</button>' : ''}
        <button class="btn btn-primary" data-value="ok">${esc(opts.ok || 'OK')}</button>
      </div>
    </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => {
      if (e.target === ov) { ov.remove(); resolve(false); }
    });
    ov.querySelectorAll('[data-value]').forEach(b => {
      b.addEventListener('click', () => {
        ov.remove();
        resolve(b.dataset.value === 'ok');
      });
    });
  });
}

/* ── Server List ── */
function renderSidebar() {
  const el = $('#server-list');
  el.innerHTML = servers.map(s => `
    <div class="server-item${s.id===selectedId?' active':''}" data-id="${s.id}">
      <span class="name">${esc(s.name)}</span>
      <span class="dot ${statusClass(s.status)}"></span>
    </div>
  `).join('');
  el.querySelectorAll('.server-item').forEach(e => e.addEventListener('click', () => selectServer(e.dataset.id)));
}

function selectServer(id) {
  selectedId = id; closeConsole();
  $('#welcome').style.display = 'none'; $('#server-view').style.display = 'flex';
  renderSidebar(); showTab(currentTab);
}

/* ── Tabs ── */
function showTab(name) {
  currentTab = name; editingFile = null;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  const s = servers.find(x => x.id === selectedId);
  if (!s) return;
  $('#server-name').textContent = s.name;
  $('#server-status').className = 'status-badge ' + statusClass(s.status);
  $('#server-status').textContent = s.status;
  const tabMap = { dashboard: renderDashboard, console: renderConsole, files: renderFiles, settings: renderSettings, players: renderPlayers };
  (tabMap[name] || (() => {}))(s);
}

/* ── Dashboard ── */
function renderDashboard(s) {
  const el = $('#tab-content');
  const running = s.status === 'running';
  el.innerHTML = `
    <div class="dashboard-actions">
      ${!running ? `<button class="btn btn-green btn-sm" onclick="startServer()">Start</button>` :
      `<button class="btn btn-red btn-sm" onclick="action('stop')">Shutdown</button>
       <button class="btn btn-sm" onclick="action('kill')">Kill</button>
       <button class="btn btn-sm" onclick="action('restart')">Restart</button>`}
    </div>
    <div class="dashboard-grid">
      <div class="dashboard-card"><div class="label">Status</div><div class="value">${esc(s.status)}</div></div>
      <div class="dashboard-card"><div class="label">Java Args</div><div class="value" style="font-size:13px;font-family:var(--font-mono)">${esc(s.java_args)}</div></div>
      <div class="dashboard-card"><div class="label">Server Jar</div><div class="value" style="font-size:13px;font-family:var(--font-mono)">${esc(s.jar_file)}</div></div>
    </div>
    <div class="system-stats">
      <h3 style="font-size:14px;margin-bottom:8px;color:var(--text-dim)">System Resources</h3>
      <canvas class="stats-canvas" id="stats-cpu" height="120"></canvas>
      <canvas class="stats-canvas" id="stats-mem" height="120"></canvas>
      <canvas class="stats-canvas" id="stats-disk" height="120"></canvas>
    </div>`;
  loadStats(); startStatsPolling();
}

window.startServer = async function() {
  const s = servers.find(x => x.id === selectedId);
  if (!s) return;
  if (!s.eula_accepted) {
    const ok = await showModal('Accept Minecraft EULA',
      'You need to accept the <a href="https://aka.ms/MinecraftEULA" target="_blank" style="color:var(--accent)">Minecraft EULA</a> before starting the server for the first time.<br><br>Do you agree to the Minecraft End User License Agreement?',
      { ok: 'I Agree', cancel: 'Cancel' });
    if (!ok) return;
    try {
      await api(`/servers/${selectedId}/eula`, { method: 'POST' });
    } catch(e) { return alert(e.message); }
  }
  action('start');
};

window.action = function(act) {
  api(`/servers/${selectedId}/${act}`, { method: 'POST' }).then(s => {
    const idx = servers.findIndex(x => x.id === s.id);
    if (idx !== -1) servers[idx] = s;
    renderSidebar(); showTab(currentTab);
    if (act === 'start') openConsole();
  }).catch(e => showModal('Error', esc(e.message)));
};

/* ── Stats + Canvas Graphs ── */
function drawGraph(canvas, label, color, data) {
  if (!canvas || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.offsetWidth * 2; canvas.width = w;
  const h = 120 * 2; canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  const pad = { t: 12, r: 8, b: 22, l: 36 };
  const gw = w - pad.l - pad.r, gh = h - pad.t - pad.b;
  const pts = data.slice(-120);
  const n = pts.length;

  // label
  ctx.fillStyle = '#8b949e'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(label, pad.l, pad.t - 2);

  ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1;
  for (let p = 0; p <= 100; p += 25) {
    const y = pad.t + gh - (p/100)*gh;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w-pad.r, y); ctx.stroke();
  }

  ctx.fillStyle = '#484f58'; ctx.font = '9px monospace'; ctx.textAlign = 'right';
  for (let p = 0; p <= 100; p += 25) {
    const y = pad.t + gh - (p/100)*gh;
    ctx.fillText(p + '%', pad.l - 4, y + 3);
  }

  ctx.textAlign = 'center';
  const xInterval = Math.max(1, Math.floor((n - 1) / 4));
  for (let i = 0; i < n; i += xInterval) {
    const x = pad.l + (i / (n - 1)) * gw;
    const secs = Math.round((Date.now() - pts[i].t) / 1000);
    ctx.fillText(secs + 's', x, h - 6);
  }

  // gradient fill under line
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + gh);
  grad.addColorStop(0, color + '30');
  grad.addColorStop(1, color + '05');
  ctx.beginPath();
  pts.forEach((d, i) => {
    const x = pad.l + (i / (n - 1 || 1)) * gw;
    const y = pad.t + gh - (Math.min(Math.max(d.v, 0), 100) / 100) * gh;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  const lastX = pad.l + ((n-1) / (n - 1 || 1)) * gw;
  ctx.lineTo(lastX, pad.t + gh);
  ctx.lineTo(pad.l, pad.t + gh);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // smooth rounded line
  ctx.beginPath();
  pts.forEach((d, i) => {
    const x = pad.l + (i / (n - 1 || 1)) * gw;
    const y = pad.t + gh - (Math.min(Math.max(d.v, 0), 100) / 100) * gh;
    if (i === 0) ctx.moveTo(x, y);
    else {
      const prev = pts[i-1];
      const pv = pad.t + gh - (Math.min(Math.max(prev.v, 0), 100) / 100) * gh;
      const px = pad.l + ((i-1) / (n - 1 || 1)) * gw;
      const cpx = (px + x) / 2;
      ctx.bezierCurveTo(cpx, pv, cpx, y, x, y);
    }
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // latest value badge
  const last = pts[pts.length-1];
  const lx = pad.l + ((n-1) / (n - 1 || 1)) * gw;
  const ly = pad.t + gh - (Math.min(Math.max(last.v, 0), 100) / 100) * gh;
  ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = color; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(Math.round(last.v) + '%', lx + 8, ly + 4);
}

async function loadStats() {
  try {
    const st = await api('/system/stats');
    const now = Date.now();
    statsCpu.push({ t: now, v: st.cpu.percent });
    statsMem.push({ t: now, v: st.memory.percent });
    statsDisk.push({ t: now, v: st.disk.percent });
    if (statsCpu.length > 120) statsCpu.shift();
    if (statsMem.length > 120) statsMem.shift();
    if (statsDisk.length > 120) statsDisk.shift();
    drawGraph($('#stats-cpu'), 'CPU', '#ff6b9d', statsCpu);
    drawGraph($('#stats-mem'), 'RAM', '#3fb950', statsMem);
    drawGraph($('#stats-disk'), 'Disk', '#58a6ff', statsDisk);
  } catch(_) {}
}

function startStatsPolling() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(loadStats, 2000);
}

/* ── Console ── */
function renderConsole(s) {
  const el = $('#tab-content');
  el.innerHTML = `
    <div class="console-container">
      <div class="console-output" id="console-output">${s.status!=='running'?'<div class="line" style="color:var(--text-dim)">Server is not running. Start it from the Dashboard tab.</div>':''}</div>
      <div class="console-input-row">
        <input type="text" id="console-input" placeholder="${s.status==='running'?'Type a command...':'Start the server first'}" autocomplete="off" ${s.status!=='running'?'disabled':''}>
        <button class="btn btn-primary btn-sm" id="console-send" ${s.status!=='running'?'disabled':''}>Send</button>
      </div>
    </div>`;
  if (s.status !== 'running') return;
  const out = $('#console-output');
  if (consoleLines.length) out.innerHTML = consoleLines.map(l => '<div class="line">'+esc(l)+'</div>').join('');
  out.scrollTop = out.scrollHeight;
  $('#console-input').addEventListener('keydown', e => { if(e.key==='Enter') sendCmd(); });
  $('#console-send').addEventListener('click', sendCmd);
  openConsole();
}

function sendCmd() {
  const input = $('#console-input'); const cmd = input.value.trim();
  if (!cmd) return; input.value = '';
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'cmd',data:cmd}));
  else api(`/servers/${selectedId}/command`, { method:'POST', body: JSON.stringify({command:cmd}) });
}

function openConsole() {
  closeConsole();
  const s = servers.find(x => x.id === selectedId);
  if (!s || s.status !== 'running') return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto+'//'+location.host+'/api/servers/'+selectedId+'/console');
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'log') {
      consoleLines.push(msg.data);
      if (consoleLines.length > 5000) consoleLines = consoleLines.slice(-5000);
      const out = $('#console-output');
      if (out) { out.insertAdjacentHTML('beforeend','<div class="line">'+esc(msg.data)+'</div>'); out.scrollTop = out.scrollHeight; }
    }
  };
  ws.onclose = () => { ws = null; };
}

function closeConsole() { if (ws) { ws.close(); ws = null; } }

/* ── Files ── */
function renderFiles(s) {
  filePath = ''; editingFile = null;
  const el = $('#tab-content');
  el.innerHTML = `
    <div class="files-toolbar">
      <div id="file-breadcrumb" style="flex:1;font-size:13px;color:var(--text-dim)"></div>
    </div>
    <div class="drop-zone" id="drop-zone">
      <p>Drop files here or click to browse</p>
      <span class="hint">Drag & drop files to upload</span>
      <div id="upload-progress" class="upload-progress" style="display:none">
        <div class="upload-info"><span id="upload-filename"></span><span id="upload-percent">0%</span></div>
        <div class="progress-track"><div id="progress-fill" class="progress-fill" style="width:0%"></div></div>
      </div>
    </div>
    <div id="file-view">
      <div class="file-list" id="file-list"><div style="padding:20px;text-align:center;color:var(--text-dim)">Loading...</div></div>
    </div>`;
  loadFiles(); setupDropZone();
}

function breadcrumb() {
  const parts = filePath.split('/').filter(Boolean);
  let html = '<a href="#" class="bc-link" data-dir="" style="color:var(--accent)">root</a>';
  let acc = '';
  for (const p of parts) { acc += '/' + p; html += ' / <a href="#" class="bc-link" data-dir="'+escAttr(acc)+'" style="color:var(--accent)">'+esc(p)+'</a>'; }
  return html;
}

function fileHTML(isDir) {
  return isDir
    ? '<span class="file-icon dir"><span class="icon-folder"></span></span>'
    : '<span class="file-icon file"><span class="icon-doc"></span></span>';
}

async function loadFiles() {
  const list = $('#file-list'); const bc = $('#file-breadcrumb');
  if (bc) bc.innerHTML = breadcrumb();
  try {
    const q = filePath ? '?dir='+encodeURIComponent(filePath) : '';
    const files = await api('/servers/'+selectedId+'/files'+q);
    const items = [];
    if (filePath) {
      const parent = filePath.split('/').slice(0,-1).join('/');
      items.push('<div class="file-item is-dir" data-dir="'+parent+'"><div class="file-info"><span class="file-icon dir"><span class="icon-folder"></span></span><span class="file-name dir-link">..</span></div></div>');
    }
    for (const f of files) {
      const name = esc(f.name); const fullPath = filePath ? filePath+'/'+f.name : f.name;
      const sizeStr = f.is_dir ? '' : fmtBytes(f.size);
      items.push(`<div class="file-item ${f.is_dir ? 'is-dir' : 'is-file'}" data-path="${escAttr(fullPath)}" data-dir="${f.is_dir ? escAttr(fullPath) : ''}">
        <div class="file-info">
          ${fileHTML(f.is_dir)}
          <span class="file-name ${f.is_dir ? 'dir-link' : ''}">${name}</span>
        </div>
        <div class="file-actions">
          ${sizeStr ? '<span class="file-size">'+sizeStr+'</span>' : ''}
          <button class="btn btn-sm delete-btn">Del</button>
        </div>
      </div>`);
    }
    list.innerHTML = items.length ? items.join('') : '<div style="padding:20px;text-align:center;color:var(--text-dim)">Empty directory</div>';
    list.querySelectorAll('.file-item.is-dir').forEach(el => el.addEventListener('click', e => {
      if(!e.target.closest('.file-actions')) goDir(el.dataset.dir);
    }));
    list.querySelectorAll('.delete-btn').forEach(btn => btn.addEventListener('click', async e => {
      const p = btn.closest('[data-path]').dataset.path;
      if (await showModal('Delete', 'Delete "'+p+'"?', {ok:'Delete',cancel:'Cancel'})) {
        try { await api('/servers/'+selectedId+'/files?path='+encodeURIComponent(p), {method:'DELETE'}); loadFiles(); } catch(e) { showModal('Error', esc(e.message)); }
      }
    }));
    list.querySelectorAll('.file-item.is-file .file-name').forEach(el => {
      el.style.cursor = 'pointer';
      el.title = 'Click to edit';
      el.addEventListener('click', e => {
        if (e.target.closest('.file-actions')) return;
        const path = el.closest('[data-path]').dataset.path;
        openEditor(path);
      });
    });
    list.querySelectorAll('.file-item.is-file').forEach(el => el.addEventListener('contextmenu', e => showCtx(e, el.dataset.path, false)));
    list.querySelectorAll('.file-item.is-dir[data-dir]').forEach(el => el.addEventListener('contextmenu', e => showCtx(e, el.dataset.path || el.dataset.dir, true)));
    if (bc) bc.querySelectorAll('.bc-link').forEach(el => el.addEventListener('click', e => { e.preventDefault(); goDir(el.dataset.dir); }));
  } catch(e) { list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red)">Error: '+esc(e.message)+'</div>'; }
}

window.goDir = function(dir) { filePath = dir; loadFiles(); };

function setupDropZone() {
  const dz = $('#drop-zone');
  dz.addEventListener('click', () => { const i = document.createElement('input'); i.type='file'; i.multiple=true; i.onchange=()=>uploadFiles(i.files); i.click(); });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); uploadFiles(e.dataTransfer.files); });
}

function showProgress(name, pct) { const b=$('#upload-progress'); if(!b) return; b.style.display='block'; $('#upload-filename').textContent=name; $('#upload-percent').textContent=pct+'%'; $('#progress-fill').style.width=pct+'%'; }
function hideProgress() { const b=$('#upload-progress'); if(!b) return; b.style.display='none'; $('#progress-fill').style.width='0%'; }

function uploadXHR(file, dir) {
  return new Promise((resolve,reject) => {
    const fd = new FormData(); fd.append('file', file); if(dir) fd.append('dir', dir);
    const x = new XMLHttpRequest();
    x.upload.onprogress = e => { if(e.lengthComputable) showProgress(file.name, Math.round(e.loaded/e.total*100)); };
    x.onload = () => x.status>=200&&x.status<300 ? resolve() : reject(new Error(x.responseText||'Upload failed'));
    x.onerror = () => reject(new Error('Network error'));
    x.open('POST', API+'/servers/'+selectedId+'/upload'); x.send(fd);
  });
}

async function uploadFiles(files) {
  for (const f of files) { try { await uploadXHR(f, filePath||''); } catch(e) { showModal('Upload Error', esc(e.message)); } }
  hideProgress(); loadFiles();
}

/* ── File Editor ── */
async function openEditor(path) {
  editingFile = path;
  const el = $('#file-view');
  if (!el) return;
  el.innerHTML = '<div class="file-editor"><div class="file-editor-header"><span class="file-path">'+esc(path)+'</span><button class="btn btn-sm" onclick="cancelEditor()">Cancel</button><button class="btn btn-primary btn-sm" onclick="saveEditor()">Save</button></div><textarea id="editor-textarea">Loading...</textarea></div>';
  try {
    const resp = await fetch(API+'/servers/'+selectedId+'/file?path='+encodeURIComponent(path));
    if (!resp.ok) throw new Error(await resp.text());
    const text = await resp.text();
    $('#editor-textarea').value = text;
  } catch(e) { $('#editor-textarea').value = 'Error: '+e.message; }
}

window.saveEditor = async function() {
  const textarea = $('#editor-textarea');
  if (!textarea || !editingFile) return;
  try {
    await api('/servers/'+selectedId+'/file?path='+encodeURIComponent(editingFile), { method:'PUT', body: JSON.stringify({content: textarea.value}) });
    showModal('Saved', 'File saved successfully.');
    cancelEditor();
  } catch(e) { showModal('Error', esc(e.message)); }
};

window.cancelEditor = function() { editingFile = null; renderFiles(servers.find(x=>x.id===selectedId)); };

/* ── Context Menu ── */
let ctxTarget = null, ctxDir = false;
function showCtx(e, path, isDir) {
  e.preventDefault(); e.stopPropagation();
  ctxTarget = path; ctxDir = isDir;
  const m = $('#ctx-menu'); m.style.display = 'block';
  m.style.left = Math.min(e.clientX, window.innerWidth-160)+'px';
  m.style.top = Math.min(e.clientY, window.innerHeight-120)+'px';
  $$('.ctx-item', m).forEach(el => el.style.display = el.dataset.action==='download'&&isDir ? 'none' : 'block');
}
function hideCtx() { $('#ctx-menu').style.display = 'none'; ctxTarget = null; }

$('#ctx-menu').addEventListener('click', async e => {
  const btn = e.target.closest('.ctx-item'); if(!btn) return;
  const action = btn.dataset.action; const path = ctxTarget; hideCtx(); if(!path) return;
  try {
    if (action === 'download') window.open('/api/servers/'+selectedId+'/download?path='+encodeURIComponent(path), '_blank');
    else if (action === 'rename') {
      const name = prompt('New name:', path.split('/').pop());
      if (!name || name === path.split('/').pop()) return;
      await api('/servers/'+selectedId+'/files?path='+encodeURIComponent(path), {method:'PUT', body:JSON.stringify({name})});
      loadFiles();
    } else if (action === 'delete') {
      if (await showModal('Delete', 'Delete "'+path+'"?', {ok:'Delete',cancel:'Cancel'})) {
        await api('/servers/'+selectedId+'/files?path='+encodeURIComponent(path), {method:'DELETE'}); loadFiles();
      }
    }
  } catch(e) { showModal('Error', esc(e.message)); }
});
document.addEventListener('click', hideCtx);

/* ── Settings ── */
function renderSettings(s) {
  const el = $('#tab-content');
  el.innerHTML = `
    <div class="settings-form">
      <div class="form-group"><label>Server Name</label><input type="text" id="set-name" value="${esc(s.name)}"></div>
      <div class="form-group"><label>Server Jar</label><input type="text" id="set-jar" value="${esc(s.jar_file)}"></div>
      <div class="form-group"><label>Java Path</label><input type="text" id="set-java-path" value="${esc(s.java_path||'')}" placeholder="/usr/lib/jvm/java-21/bin/java"></div>
      <div class="form-group"><label>Java Arguments</label><input type="text" id="set-java" value="${esc(s.java_args)}"></div>
      <div class="form-group"><label>Port</label><input type="number" id="set-port" value="${s.port}"></div>
      <div class="form-group"><label class="checkbox-label"><input type="checkbox" id="set-autostart" ${s.auto_start?'checked':''}> Auto-start on boot</label></div>
      <div class="form-group" style="display:flex;gap:8px">
        <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
        <button class="btn btn-red" onclick="deleteServer()">Delete Server</button>
      </div>
    </div>`;
}

window.saveSettings = async function() {
  const body = { name: $('#set-name').value, jar_file: $('#set-jar').value, java_path: $('#set-java-path').value, java_args: $('#set-java').value, port: parseInt($('#set-port').value)||25565, auto_start: $('#set-autostart').checked };
  try {
    const s = await api('/servers/'+selectedId, { method:'PUT', body:JSON.stringify(body) });
    const idx = servers.findIndex(x => x.id === s.id); if (idx !== -1) servers[idx] = s;
    renderSidebar(); showTab(currentTab); showModal('Saved', 'Settings saved.');
  } catch(e) { showModal('Error', esc(e.message)); }
};

window.deleteServer = async function() {
  const s = servers.find(x => x.id === selectedId); if (!s) return;
  if (!await showModal('Delete Server', 'Permanently delete server "'+s.name+'"? This will remove ALL files including worlds.', {ok:'Delete',cancel:'Cancel'})) return;
  if (!await showModal('Confirm', 'Are you sure? There is no undo.', {ok:'Yes, Delete',cancel:'Cancel'})) return;
  try { await api('/servers/'+selectedId, {method:'DELETE'}); selectedId = null; await loadServers(); $('#server-view').style.display='none'; $('#welcome').style.display='flex'; }
  catch(e) { showModal('Error', esc(e.message)); }
};

/* ── Players Tab ── */
async function renderPlayers(s) {
  const el = $('#tab-content');
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">Loading players...</div>';
  try {
    const players = await api('/servers/'+selectedId+'/players');
    if (!players || !players.length) {
      el.innerHTML = '<div class="players-empty">No players found.<br>'+(s.status==='running'?'Players will appear here when they join the server.':'Start the server to see online players.')+'</div>';
      return;
    }
    el.innerHTML = '<div style="margin-bottom:12px;font-size:13px;color:var(--text-dim)">'+players.length+' known player(s)</div>' +
      players.map(p => {
        const avatar = esc(p.name.charAt(0).toUpperCase());
        const badgeCls = p.online ? 'online' : 'offline';
        const badgeTxt = p.online ? 'Online' : 'Offline';
        const stats = p.stats;
        return `<div class="player-item">
          <div class="player-avatar">${avatar}</div>
          <div class="player-info">
            <div class="player-name-row">
              <div class="player-name">${esc(p.name)}</div>
              <span class="player-badge ${badgeCls}">${badgeTxt}</span>
            </div>
            ${p.uuid ? '<div class="player-uuid">'+esc(p.uuid)+'</div>' : ''}
            ${stats ? '<div class="player-stats">' +
              '<span title="Play Time"><svg class="stat-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>'+fmtTime(stats.play_time)+'</span>' +
              '<span title="Distance Walked"><svg class="stat-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>'+(stats.walk_dist/1000).toFixed(1)+'km</span>' +
              '<span title="Mob Kills"><svg class="stat-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>'+stats.kills+'</span>' +
              '<span title="Damage Dealt"><svg class="stat-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>'+stats.damage+'</span>' +
              '<span title="Deaths" class="stat-death"><svg class="stat-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'+stats.deaths+'</span>' +
            '</div>' : '<div class="player-stats"><span class="no-stats">No stats yet</span></div>'}
          </div>
        </div>`;
      }).join('');
  } catch(e) {
    el.innerHTML = '<div class="players-empty">Error loading players: '+esc(e.message)+'</div>';
  }
}

/* ── New Server Modal ── */
$('#new-server-btn').addEventListener('click', () => openModal());
function openModal(server) {
  const overlay = $('#modal-overlay'); const body = $('#modal-body'); const isEdit = !!server;
  $('#modal-title').textContent = isEdit ? 'Edit Server' : 'New Server';
  $('#modal-confirm').textContent = isEdit ? 'Save' : 'Create';
  body.innerHTML = `
    <div class="form-group"><label>Server Name</label><input type="text" id="f-name" value="${isEdit?esc(server.name):''}" placeholder="My Server"></div>
    <div class="form-group"><label>Server Jar (filename)</label><input type="text" id="f-jar" value="${isEdit?esc(server.jar_file):''}" placeholder="paper-1.21.1.jar"></div>
    <div class="form-group"><label>Java Arguments</label><input type="text" id="f-java" value="${isEdit?esc(server.java_args):'-Xmx1G -Xms1G'}" placeholder="-Xmx1G -Xms1G"></div>
    <div class="form-group"><label>Java Path</label><input type="text" id="f-java-path" value="${isEdit?esc(server.java_path||''):''}" placeholder="/usr/lib/jvm/java-21/bin/java"></div>
    <div class="form-group"><label>Port</label><input type="number" id="f-port" value="${isEdit?server.port:25565}" placeholder="25565"></div>
    <div class="form-group"><label class="checkbox-label"><input type="checkbox" id="f-autostart" ${isEdit&&server.auto_start?'checked':''}> Auto-start on boot</label></div>`;
  overlay.style.display = 'flex'; overlay.dataset.edit = isEdit ? server.id : '';
}
$('#modal-cancel').addEventListener('click', () => closeModal());
$('#modal-overlay').addEventListener('click', e => { if(e.target===e.currentTarget) closeModal(); });
$('#modal-form').addEventListener('submit', async e => {
  e.preventDefault();
  const editId = $('#modal-overlay').dataset.edit;
  const body = { name: $('#f-name').value, jar_file: $('#f-jar').value, java_args: $('#f-java').value||'-Xmx1G -Xms1G', java_path: $('#f-java-path').value, port: parseInt($('#f-port').value)||25565, auto_start: $('#f-autostart').checked };
  if (!body.name || !body.jar_file) { showModal('Error', 'Name and jar file are required.'); return; }
  try {
    const s = editId ? await api('/servers/'+editId, {method:'PUT',body:JSON.stringify(body)}) : await api('/servers', {method:'POST',body:JSON.stringify(body)});
    closeModal(); await loadServers(); selectServer(s.id);
  } catch(e) { showModal('Error', esc(e.message)); }
});
function closeModal() { $('#modal-overlay').style.display = 'none'; $('#modal-overlay').dataset.edit = ''; }

/* ── Polling ── */
async function loadServers() {
  try {
    servers = await api('/servers'); renderSidebar();
    if (selectedId && servers.find(s => s.id === selectedId)) {
      const s = servers.find(x => x.id === selectedId);
      $('#server-name').textContent = s.name;
      $('#server-status').className = 'status-badge ' + statusClass(s.status);
      $('#server-status').textContent = s.status;
    }
  } catch(_) {}
}
loadServers(); setInterval(loadServers, 5000);

$$('.tab').forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); hideCtx(); }
});

const origShowTab = showTab;
showTab = function(name) {
  if (name !== 'dashboard' && statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  origShowTab(name);
};
