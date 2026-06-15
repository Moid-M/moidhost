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

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
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
  const tabMap = { dashboard: renderDashboard, console: renderConsole, files: renderFiles, world: renderWorld, backups: renderBackups, players: renderPlayers, settings: renderSettings };
  (tabMap[name] || (() => {}))(s);
}

/* ── Dashboard ── */
let lastStats = null;

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
      <div class="stat-graph"><div class="graph-label">CPU</div><canvas class="stats-canvas" id="stats-cpu" height="140"></canvas></div>
      <div class="stat-graph"><div class="graph-label">RAM</div><canvas class="stats-canvas" id="stats-mem" height="140"></canvas></div>
      <div class="stat-graph"><div class="graph-label">DISK</div><canvas class="stats-canvas" id="stats-disk" height="140"></canvas></div>
    </div>
    <div class="online-section">
      <div class="online-header">Online Players <span class="online-count" id="online-count">0</span></div>
      <div class="online-list" id="online-list"><span class="online-empty">No players online</span></div>
    </div>`;
  loadStats(); startStatsPolling();
  pollOnline();
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
function drawGraph(canvas, label, color, data, totalBytes) {
  if (!canvas || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = 2;
  const w = rect.width * dpr; canvas.width = w;
  const h = 140 * dpr; canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  const pad = { t: 8, r: 10, b: 24, l: 48 };
  const gw = w - pad.l - pad.r, gh = h - pad.t - pad.b;
  const pts = data.slice(-120);
  const n = pts.length;

  // Grid lines at 25% intervals
  ctx.strokeStyle = '#1c2128'; ctx.lineWidth = 1 * dpr;
  for (let p = 0; p <= 100; p += 25) {
    const y = pad.t + gh - (p/100)*gh;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w-pad.r, y); ctx.stroke();
  }

  // Y-axis labels with real values for RAM/Disk
  ctx.fillStyle = '#484f58'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let p = 0; p <= 100; p += 25) {
    const y = pad.t + gh - (p/100)*gh;
    let label = p + '%';
    if (totalBytes && p === 100) label = fmtBytes(totalBytes);
    else if (totalBytes) label = fmtBytes(Math.round(totalBytes * p / 100));
    ctx.fillText(label, pad.l - 6, y + 3);
  }

  // X-axis time labels
  ctx.fillStyle = '#484f58'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  const xInterval = Math.max(1, Math.floor((n - 1) / 4));
  for (let i = 0; i < n; i += xInterval) {
    const x = pad.l + (i / (n - 1)) * gw;
    const secs = Math.round((Date.now() - pts[i].t) / 1000);
    ctx.fillText(secs + 's', x, h - 6);
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + gh);
  grad.addColorStop(0, color + '25');
  grad.addColorStop(1, color + '03');
  ctx.beginPath();
  pts.forEach((d, i) => {
    const x = pad.l + (i / (n - 1 || 1)) * gw;
    const y = pad.t + gh - (Math.min(Math.max(d.v, 0), 100) / 100) * gh;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  const lx = pad.l + ((n-1) / (n - 1 || 1)) * gw;
  ctx.lineTo(lx, pad.t + gh); ctx.lineTo(pad.l, pad.t + gh); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Smooth line
  const lineW = 2 * dpr;
  ctx.beginPath();
  pts.forEach((d, i) => {
    const x = pad.l + (i / (n - 1 || 1)) * gw;
    const y = pad.t + gh - (Math.min(Math.max(d.v, 0), 100) / 100) * gh;
    if (i === 0) ctx.moveTo(x, y);
    else {
      const pv = pad.t + gh - (Math.min(Math.max(pts[i-1].v, 0), 100) / 100) * gh;
      const px = pad.l + ((i-1) / (n - 1 || 1)) * gw;
      ctx.bezierCurveTo((px+x)/2, pv, (px+x)/2, y, x, y);
    }
  });
  ctx.strokeStyle = color; ctx.lineWidth = lineW;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();

  // End dot + value
  const last = pts[n-1];
  const ex = pad.l + ((n-1) / (n - 1 || 1)) * gw;
  const ey = pad.t + gh - (Math.min(Math.max(last.v, 0), 100) / 100) * gh;
  ctx.beginPath(); ctx.arc(ex, ey, 4 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5 * dpr; ctx.stroke();

  ctx.fillStyle = color; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(Math.round(last.v) + '%', ex + 10 * dpr, ey + 4 * dpr);

  // Store for hover tooltip
  canvas._statsData = data;
  canvas._statsTotal = totalBytes || 0;
  canvas._statsPad = pad;
  canvas._statsGW = gw;
  canvas._statsGH = gh;
  canvas._statsN = n;
  canvas._statsColor = color;
}

async function loadStats() {
  try {
    const st = await api('/system/stats');
    lastStats = st;
    const now = Date.now();
    statsCpu.push({ t: now, v: st.cpu.percent });
    statsMem.push({ t: now, v: st.memory.percent });
    statsDisk.push({ t: now, v: st.disk.percent });
    if (statsCpu.length > 120) statsCpu.shift();
    if (statsMem.length > 120) statsMem.shift();
    if (statsDisk.length > 120) statsDisk.shift();
    drawGraph($('#stats-cpu'), 'CPU', '#ff6b9d', statsCpu);
    drawGraph($('#stats-mem'), 'RAM', '#3fb950', statsMem, st.memory.total_bytes);
    drawGraph($('#stats-disk'), 'Disk', '#58a6ff', statsDisk, st.disk.total_bytes);
  } catch(_) {}
}

function startStatsPolling() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(loadStats, 2000);
}

/* ── Graph Hover Tooltip ── */
document.addEventListener('mouseover', e => {
  const c = e.target.closest('.stats-canvas');
  if (!c) { const t = $('.graph-tooltip'); if (t) t.remove(); return; }
});
document.addEventListener('mousemove', e => {
  const c = e.target.closest('.stats-canvas');
  if (!c) return;
  const d = c._statsData; if (!d || d.length < 2) return;
  const rect = c.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * 2;
  const pad = c._statsPad; const gw = c._statsGW; const n = c._statsN;
  const idx = Math.round(((mx - pad.l) / gw) * (n - 1));
  const clamped = Math.max(0, Math.min(n - 1, idx));
  const pt = d[clamped];
  let tip = $('.graph-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'graph-tooltip';
    document.body.appendChild(tip);
  }
  const age = Math.round((Date.now() - pt.t) / 1000);
  let text = pt.v.toFixed(1) + '%';
  if (c._statsTotal) {
    const used = Math.round(c._statsTotal * pt.v / 100);
    text = fmtBytes(used) + ' / ' + fmtBytes(c._statsTotal) + ' (' + pt.v.toFixed(1) + '%)';
  }
  tip.innerHTML = text + '<br><span style="font-size:10px;opacity:0.6">' + age + 's ago</span>';
  tip.style.display = 'block';
  tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 10) + 'px';
  tip.style.top = (e.clientY - 40) + 'px';
});

/* ── Online Players on Dashboard ── */
let onlinePoll = null;

async function pollOnline() {
  if (onlinePoll) clearInterval(onlinePoll);
  await updateOnline();
  onlinePoll = setInterval(updateOnline, 5000);
}

async function updateOnline() {
  try {
    const players = await api('/servers/'+selectedId+'/players');
    const online = players ? players.filter(p => p.online) : [];
    const el = $('#online-list'); const cnt = $('#online-count');
    if (cnt) cnt.textContent = online.length;
    if (!el) return;
    if (!online.length) {
      el.innerHTML = '<span class="online-empty">No players online</span>';
      return;
    }
    el.innerHTML = online.map(p =>
      '<span class="online-player" data-player="'+escAttr(p.name)+'"><span class="online-dot"></span>'+esc(p.name)+'</span>'
    ).join('');
    el.querySelectorAll('.online-player').forEach(el2 => {
      el2.addEventListener('click', () => { showTab('players'); });
    });
  } catch(_) {}
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
const EXT_MAP = {
  '.json': 'json', '.js': 'js', '.ts': 'ts', '.html': 'html', '.htm': 'html',
  '.css': 'css', '.yml': 'yaml', '.yaml': 'yaml', '.xml': 'xml', '.md': 'md',
  '.py': 'py', '.sh': 'sh', '.txt': 'text', '.properties': 'props',
  '.toml': 'toml', '.ini': 'ini', '.cfg': 'cfg', '.log': 'log',
};

function editorLang(path) {
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
  return EXT_MAP[ext] || 'text';
}

async function openEditor(path) {
  editingFile = path;
  const el = $('#file-view');
  if (!el) return;
  el.innerHTML = `
    <div class="file-editor">
      <div class="file-editor-header">
        <span class="file-path">${esc(path)}</span>
        <span class="file-lang">${editorLang(path)}</span>
        <button class="btn btn-sm" onclick="cancelEditor()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="saveEditor()">Save</button>
      </div>
      <div class="editor-wrap">
        <div class="editor-gutter" id="editor-gutter"></div>
        <textarea id="editor-textarea" spellcheck="false">Loading...</textarea>
      </div>
    </div>`;
  try {
    const resp = await fetch(API+'/servers/'+selectedId+'/file?path='+encodeURIComponent(path));
    if (!resp.ok) throw new Error(await resp.text());
    const text = await resp.text();
    const ta = $('#editor-textarea');
    ta.value = text;
    updateGutter();
    ta.addEventListener('scroll', updateGutter);
    ta.addEventListener('input', updateGutter);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = ta.selectionStart;
        ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = start + 2;
        updateGutter();
      }
    });
  } catch(e) { $('#editor-textarea').value = 'Error: '+e.message; }
}

function updateGutter() {
  const ta = $('#editor-textarea');
  const gutter = $('#editor-gutter');
  if (!ta || !gutter) return;
  const lines = ta.value.split('\n').length;
  gutter.innerHTML = Array.from({length: lines}, (_, i) =>
    '<div class="gutter-line">' + (i + 1) + '</div>'
  ).join('');
  gutter.scrollTop = ta.scrollTop;
}

window.saveEditor = async function() {
  const ta = $('#editor-textarea');
  if (!ta || !editingFile) return;
  try {
    await api('/servers/'+selectedId+'/file?path='+encodeURIComponent(editingFile), { method:'PUT', body: JSON.stringify({content: ta.value}) });
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

/* ── World Tab ── */
async function renderWorld(s) {
  const el = $('#tab-content');
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">Loading world data...</div>';
  try {
    const worlds = await api('/servers/'+selectedId+'/world');
    const running = s.status === 'running';
    const warnMsg = running ? '<div class="world-notice">Server is running. Stop it to upload, delete, or replace worlds.</div>' : '';

    let html = warnMsg;
    html += '<div class="section-title">Worlds</div>';

    if (!worlds || !worlds.length) {
      html += '<div class="empty-state">No worlds found. Start the server to generate one.</div>';
    } else {
      for (const w of worlds) {
        html += `<div class="world-card" data-world="${escAttr(w.name)}">
          <div class="world-info">
            <div class="world-name"><span class="icon-folder-sm"></span>${esc(w.name)}</div>
            <div class="world-meta">${fmtBytes(w.size)} &middot; ${fmtDate(w.mod_time)}</div>
          </div>
          <div class="world-actions">
            <button class="btn btn-sm" onclick="downloadWorld('${escAttr(w.name)}')">Download</button>
            <button class="btn btn-sm" onclick="replaceWorld('${escAttr(w.name)}')" ${running?'disabled style="opacity:0.4"':''}>Replace</button>
            <button class="btn btn-sm btn-red" onclick="deleteWorld('${escAttr(w.name)}')" ${running?'disabled style="opacity:0.4"':''}>Delete</button>
          </div>
        </div>`;
      }
    }

    // World context menu (right-click)
    html += `<div class="section-title" style="margin-top:20px">Upload World</div>
      <div class="world-upload" id="world-upload-zone">
        <p>Upload a <code>.zip</code> world file</p>
        <span class="hint">${running ? 'Server must be stopped' : 'Extracts into the server directory'}</span>
      </div>
      <div id="world-upload-progress" class="upload-progress" style="display:none">
        <div class="upload-info"><span id="wu-filename"></span><span id="wu-percent">0%</span></div>
        <div class="progress-track"><div id="wu-fill" class="progress-fill" style="width:0%"></div></div>
      </div>`;

    el.innerHTML = html;

    // Right-click context on world cards
    el.querySelectorAll('.world-card').forEach(card => {
      card.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        const name = card.dataset.world;
        const m = $('#ctx-menu'); m.style.display = 'block';
        m.style.left = Math.min(e.clientX, window.innerWidth-160)+'px';
        m.style.top = Math.min(e.clientY, window.innerHeight-120)+'px';
        $$('.ctx-item', m).forEach(el2 => {
          el2.style.display = 'block';
          if (el2.dataset.action === 'download') el2.onclick = () => { hideCtx(); downloadWorld(name); };
          else if (el2.dataset.action === 'rename') el2.style.display = 'none';
          else if (el2.dataset.action === 'delete') el2.onclick = () => { hideCtx(); deleteWorld(name); };
        });
        // Add "Open in Files" action
        let openItem = m.querySelector('.ctx-item[data-action="open-files"]');
        if (!openItem) {
          openItem = document.createElement('button');
          openItem.className = 'ctx-item';
          openItem.dataset.action = 'open-files';
          openItem.textContent = 'Open in Files';
          m.insertBefore(openItem, m.firstChild);
        }
        openItem.style.display = 'block';
        openItem.onclick = () => { hideCtx(); filePath = name; showTab('files'); };
      });
    });

    // Upload zone
    if (!running) {
      const wz = $('#world-upload-zone');
      if (wz) {
        wz.addEventListener('click', () => uploadWorld());
        wz.addEventListener('dragover', e => { e.preventDefault(); wz.classList.add('drag-over'); });
        wz.addEventListener('dragleave', () => wz.classList.remove('drag-over'));
        wz.addEventListener('drop', e => { e.preventDefault(); wz.classList.remove('drag-over'); doWorldUpload(e.dataTransfer.files[0]); });
      }
    }
  } catch(e) {
    el.innerHTML = '<div class="empty-state">Error: '+esc(e.message)+'</div>';
  }
}

window.downloadWorld = function(name) {
  window.open('/api/servers/'+selectedId+'/world/download?world='+encodeURIComponent(name), '_blank');
};

window.replaceWorld = async function(name) {
  const i = document.createElement('input');
  i.type = 'file'; i.accept = '.zip';
  i.onchange = async () => {
    if (!i.files[0]) return;
    const ok = await showModal('Replace World', 'Replace "'+name+'" with the uploaded zip? The current world will be deleted.', {ok:'Replace',cancel:'Cancel'});
    if (!ok) return;
    try {
      await api('/servers/'+selectedId+'/world?name='+encodeURIComponent(name), {method:'DELETE'});
    } catch(_) {}
    doWorldUpload(i.files[0]);
  };
  i.click();
};

window.deleteWorld = async function(name) {
  if (!await showModal('Delete World', 'Delete "'+name+'"? This cannot be undone.', {ok:'Delete',cancel:'Cancel'})) return;
  try {
    await api('/servers/'+selectedId+'/world?name='+encodeURIComponent(name), {method:'DELETE'});
    renderWorld(servers.find(s => s.id === selectedId));
  } catch(e) { showModal('Error', esc(e.message)); }
};

window.uploadWorld = function() {
  const i = document.createElement('input');
  i.type = 'file'; i.accept = '.zip';
  i.onchange = () => { if (i.files[0]) doWorldUpload(i.files[0]); };
  i.click();
};

async function doWorldUpload(file) {
  const pb = $('#world-upload-progress'); if (!pb) return;
  pb.style.display = 'block';
  $('#wu-filename').textContent = file.name;
  const fd = new FormData(); fd.append('file', file);
  const x = new XMLHttpRequest();
  x.upload.onprogress = e => {
    if (e.lengthComputable) {
      $('#wu-percent').textContent = Math.round(e.loaded/e.total*100)+'%';
      $('#wu-fill').style.width = Math.round(e.loaded/e.total*100)+'%';
    }
  };
  x.onload = () => {
    pb.style.display = 'none';
    if (x.status >= 200 && x.status < 300) { showModal('Success', 'World uploaded.'); renderWorld(servers.find(s => s.id === selectedId)); }
    else showModal('Error', x.responseText || 'Upload failed');
  };
  x.onerror = () => { pb.style.display = 'none'; showModal('Error', 'Network error'); };
  x.open('POST', API+'/servers/'+selectedId+'/world/upload'); x.send(fd);
}

/* ── Backups Tab ── */
async function renderBackups(s) {
  const el = $('#tab-content');
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">Loading backups...</div>';
  try {
    const [backups, folders] = await Promise.all([
      api('/servers/'+selectedId+'/backups'),
      api('/servers/'+selectedId+'/world/folders'),
    ]);
    const running = s.status === 'running';

    let html = '';

    // Create backup section
    html += '<div class="section-title">Create Backup</div>';
    html += '<div class="backup-form">';
    html += '<p style="font-size:13px;color:var(--text-dim);margin-bottom:10px">Select folders to include:</p>';
    html += '<div class="folder-list" id="backup-folders">';
    const autoChecked = ['world', 'world_nether', 'world_the_end'];
    if (folders && folders.length) {
      for (const f of folders) {
        const checked = autoChecked.includes(f.name) ? 'checked' : '';
        html += `<label class="folder-item">
          <input type="checkbox" class="folder-cb" value="${escAttr(f.name)}" ${checked}>
          <span class="folder-icon ${f.is_mod ? 'mod' : 'world'}"></span>
          <span class="folder-name">${esc(f.name)}</span>
          <span class="folder-size">${fmtBytes(f.size)}</span>
        </label>`;
      }
    }
    html += '</div>';
    html += '<div style="margin-top:10px;display:flex;gap:8px;align-items:center">';
    html += '<button class="btn btn-sm" onclick="document.querySelectorAll(\'.folder-cb\').forEach(c=>c.checked=true)">Select All</button>';
    html += '<button class="btn btn-sm" onclick="document.querySelectorAll(\'.folder-cb\').forEach(c=>c.checked=false)">Deselect All</button>';
    html += '<button class="btn btn-primary" onclick="createBackup()">Create Backup</button>';
    html += '<span id="backup-total-size" style="font-size:12px;color:var(--text-dim);margin-left:8px"></span>';
    html += '</div></div>';

    // Update total size when checkboxes change
    html += '<script>document.addEventListener("change", function(e){if(e.target.classList.contains("folder-cb"))updateBackupSize()});</script>';

    // Backups list
    html += '<div class="section-title" style="margin-top:24px">Saved Backups</div>';
    if (!backups || !backups.length) {
      html += '<div class="empty-state">No backups yet.</div>';
    } else {
      for (const b of backups) {
        html += `<div class="backup-item">
          <div class="backup-info">
            <div class="backup-name">${esc(b.name)}</div>
            <div class="backup-meta">${fmtBytes(b.size)} &middot; ${fmtDate(b.created)}</div>
          </div>
          <div class="backup-actions">
            <button class="btn btn-sm" onclick="downloadBackup('${escAttr(b.name)}')">Download</button>
            <button class="btn btn-sm ${running ? '' : ''}" onclick="restoreBackup('${escAttr(b.name)}')" ${running?'disabled style="opacity:0.4"':''}>Restore</button>
            <button class="btn btn-sm btn-red" onclick="deleteBackup('${escAttr(b.name)}')">Delete</button>
          </div>
        </div>`;
      }
    }

    el.innerHTML = html;
    updateBackupSize();

    // Setup folder checkbox change handler
    el.querySelectorAll('.folder-cb').forEach(cb => cb.addEventListener('change', updateBackupSize));
  } catch(e) {
    el.innerHTML = '<div class="empty-state">Error: '+esc(e.message)+'</div>';
  }
}

function updateBackupSize() {
  const el = $('#backup-total-size');
  if (!el) return;
  // Get sizes from the displayed folders
  let total = 0;
  $$('.folder-cb:checked').forEach(cb => {
    const sizeText = cb.closest('.folder-item')?.querySelector('.folder-size')?.textContent;
    if (sizeText) {
      const match = sizeText.match(/^[\d.]+/);
      const unit = sizeText.match(/[A-Z]+/);
      if (match && unit) {
        const v = parseFloat(match[0]);
        const u = unit[0];
        if (u === 'B') total += v;
        else if (u === 'KB') total += v * 1024;
        else if (u === 'MB') total += v * 1048576;
        else if (u === 'GB') total += v * 1073741824;
        else if (u === 'TB') total += v * 1099511627776;
      }
    }
  });
  el.textContent = '~' + fmtBytes(total);
}

window.createBackup = async function() {
  const cbs = $$('.folder-cb:checked');
  if (!cbs.length) { showModal('Error', 'Select at least one folder to back up.'); return; }
  const folders = [...cbs].map(cb => cb.value);
  try {
    const b = await api('/servers/'+selectedId+'/backups', { method:'POST', body:JSON.stringify({folders}) });
    showModal('Backup Created', 'Backup "'+b.name+'" created.');
    renderBackups(servers.find(s => s.id === selectedId));
  } catch(e) { showModal('Error', esc(e.message)); }
};

window.restoreBackup = async function(name) {
  if (!await showModal('Restore Backup', 'Restore "'+name+'"? This will overwrite current files.', {ok:'Restore',cancel:'Cancel'})) return;
  const s = servers.find(x => x.id === selectedId);
  if (s && s.status === 'running') { showModal('Error', 'Server must be stopped to restore.'); return; }
  try {
    await api('/servers/'+selectedId+'/backups/restore?name='+encodeURIComponent(name), { method: 'POST' });
    showModal('Restored', 'Backup "'+name+'" restored.');
  } catch(e) { showModal('Error', esc(e.message)); }
};

window.deleteBackup = async function(name) {
  if (!await showModal('Delete Backup', 'Delete "'+name+'"?', {ok:'Delete',cancel:'Cancel'})) return;
  try {
    await api('/servers/'+selectedId+'/backups?name='+encodeURIComponent(name), { method: 'DELETE' });
    renderBackups(servers.find(s => s.id === selectedId));
  } catch(e) { showModal('Error', esc(e.message)); }
};

window.downloadBackup = function(name) {
  window.open('/api/servers/'+selectedId+'/backups/download?name='+encodeURIComponent(name), '_blank');
};

/* ── Players Tab ── */
let expandedPlayer = null;

async function renderPlayers(s) {
  const el = $('#tab-content');
  expandedPlayer = null;
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">Loading players...</div>';
  try {
    const players = await api('/servers/'+selectedId+'/players');
    if (!players || !players.length) {
      el.innerHTML = '<div class="empty-state">No players found.<br>'+(s.status==='running'?'Players will appear here when they join.':'Start the server to see online players.')+'</div>';
      return;
    }
    el.innerHTML = '<div style="margin-bottom:12px;font-size:13px;color:var(--text-dim)">'+players.length+' known player(s)</div>' +
      '<div class="players-list">' +
      players.map(p => {
        const avatar = esc(p.name.charAt(0).toUpperCase());
        const badgeCls = p.online ? 'online' : 'offline';
        const badgeTxt = p.online ? 'Online' : 'Offline';
        const stats = p.stats;
        const isExpanded = expandedPlayer === p.name;
        return `<div class="player-card${isExpanded?' expanded':''}" data-player="${escAttr(p.name)}">
          <div class="player-main" onclick="togglePlayer('${escAttr(p.name)}')">
            <div class="player-avatar">${avatar}</div>
            <div class="player-info">
              <div class="player-name-row">
                <div class="player-name">${esc(p.name)}</div>
                <span class="player-badge ${badgeCls}">${badgeTxt}</span>
              </div>
              ${p.uuid ? '<div class="player-uuid">'+esc(p.uuid)+'</div>' : ''}
              <div class="player-stats-summary">
                ${stats ? '<span>Played '+fmtTime(stats.play_time)+'</span><span>Walked '+(stats.walk_dist/1000).toFixed(1)+'km</span>' : '<span class="no-stats">No stats yet</span>'}
              </div>
            </div>
            <span class="player-expand-icon">${isExpanded ? '▾' : '▸'}</span>
          </div>
          ${isExpanded && stats ? '<div class="player-detail">' +
            '<div class="detail-grid">' +
            '<div class="detail-item"><span class="detail-label">Play Time</span><span class="detail-value">'+fmtTime(stats.play_time)+'</span></div>' +
            '<div class="detail-item"><span class="detail-label">Distance Walked</span><span class="detail-value">'+(stats.walk_dist/1000).toFixed(2)+' km</span></div>' +
            '<div class="detail-item"><span class="detail-label">Mob Kills</span><span class="detail-value">'+stats.kills+'</span></div>' +
            '<div class="detail-item"><span class="detail-label">Damage Dealt</span><span class="detail-value">'+stats.damage+'</span></div>' +
            '<div class="detail-item"><span class="detail-label">Deaths</span><span class="detail-value stat-death">'+stats.deaths+'</span></div>' +
            (stats.play_time ? '<div class="detail-item"><span class="detail-label">K/D Ratio</span><span class="detail-value">'+(stats.deaths ? (stats.kills/stats.deaths).toFixed(2) : stats.kills)+'</span></div>' : '') +
            '</div></div>' : ''}
          ${isExpanded && !stats ? '<div class="player-detail"><div class="empty-state" style="padding:16px">No statistics available yet. They will appear after playing on the server.</div></div>' : ''}
        </div>`;
      }).join('') + '</div>';
  } catch(e) {
    el.innerHTML = '<div class="empty-state">Error: '+esc(e.message)+'</div>';
  }
}

window.togglePlayer = function(name) {
  expandedPlayer = expandedPlayer === name ? null : name;
  renderPlayers(servers.find(s => s.id === selectedId));
};

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
  if (onlinePoll) { clearInterval(onlinePoll); onlinePoll = null; }
  if (name !== 'dashboard' && statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  origShowTab(name);
};
