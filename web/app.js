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

let authToken = null;
let authUser = null;

let serversCollapsed = false;
let loadInterval = null;

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];

function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  return fetch(API + path, { headers, ...opts }).then(r => {
    if (r.status === 401) {
      if (authToken) logout();
      throw new Error('unauthorized');
    }
    if (r.status === 204) return null;
    if (!r.ok) return r.text().then(t => { throw new Error(t) });
    return r.json();
  });
}

/* ── Auth ── */
function loginPage() {
  $('#login-page').style.display = 'flex';
  $('#app').style.display = 'none';
  $('#login-error').textContent = '';
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = $('#login-btn'); btn.disabled = true; btn.textContent = 'Signing in...';
  $('#login-error').textContent = '';
  try {
    const res = await fetch(API + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#login-user').value, password: $('#login-pass').value }),
    });
    if (!res.ok) { const t = await res.text(); throw new Error(t); }
    const data = await res.json();
    authToken = data.token;
    sessionStorage.setItem('moidhost_token', authToken);
    authUser = { username: data.username, role: data.role };
    try {
      const info = await fetch(API + '/auth/validate', { headers: { 'Authorization': 'Bearer ' + authToken } });
      if (info.ok) {
        const infoData = await info.json();
        authUser.permissions = infoData.permissions || {};
      }
    } catch(_) {}
    initApp();
  } catch(e) {
    $('#login-error').textContent = e.message || 'Login failed';
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

function logout() {
  authToken = null; authUser = null;
  sessionStorage.removeItem('moidhost_token');
  if (ws) { ws.close(); ws = null; }
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  if (loadInterval) { clearInterval(loadInterval); loadInterval = null; }
  loginPage();
}

async function initApp() {
  if (!authToken) {
    const stored = sessionStorage.getItem('moidhost_token');
    if (stored) {
      authToken = stored;
      loginPage();
      try {
        const info = await fetch(API + '/auth/validate', { headers: { 'Authorization': 'Bearer ' + authToken } });
        if (!info.ok) throw new Error('invalid');
        const data = await info.json();
        authUser = { username: data.username, role: data.role, permissions: data.permissions || {} };
      } catch(_) { authToken = null; sessionStorage.removeItem('moidhost_token'); loginPage(); return; }
    } else { loginPage(); return; }
  }

  $('#login-page').style.display = 'none';
  $('#app').style.display = 'flex';
  if (authUser) {
    $('#sidebar-user').textContent = authUser.username + (authUser.role === 'admin' ? ' (admin)' : '');
    $('#manage-users-btn').style.display = authUser.role === 'admin' ? '' : 'none';
  }
  loadServers();
  if (loadInterval) clearInterval(loadInterval);
  loadInterval = setInterval(loadServers, 5000);
  $$('.tab').forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
}

/* ── Permission helpers ── */
function hasPerm(perm) {
  if (!authUser) return false;
  if (authUser.role === 'admin') return true;
  if (!selectedId) return false;
  const perms = authUser.permissions && authUser.permissions[selectedId];
  if (!perms) return false;
  return perms.includes(perm);
}

function hasAnyPerm(perms) {
  return perms.some(p => hasPerm(p));
}

function filterTabs() {
  if (!authUser) return;
  if (authUser.role === 'admin') {
    $$('.tab').forEach(t => t.style.display = '');
    return;
  }
  const tabPerms = {
    dashboard: ['dashboard'],
    console: ['console'],
    files: ['files_read', 'files_write'],
    world: ['world'],
    backups: ['backups_create', 'backups_delete', 'backups_restore'],
    players: ['players'],
    settings: ['settings'],
  };
  for (const [tab, perms] of Object.entries(tabPerms)) {
    const el = $(`.tab[data-tab="${tab}"]`);
    if (el) el.style.display = hasAnyPerm(perms) ? '' : 'none';
  }
}

/* ── Mobile Sidebar ── */
function toggleSidebar() {
  const s = $('#sidebar'); const o = $('#sidebar-overlay');
  s.classList.toggle('open'); o.classList.toggle('open');
  if (s.classList.contains('open')) o.onclick = () => closeSidebar();
}
function closeSidebar() {
  $('#sidebar').classList.remove('open'); $('#sidebar-overlay').classList.remove('open');
}
function isMobile() { return window.innerWidth <= 768; }

/* ── Server List ── */
function toggleServerList() {
  serversCollapsed = !serversCollapsed;
  const el = $('#server-list');
  const arrow = $('#server-list-arrow');
  if (serversCollapsed) {
    el.style.display = 'none';
    if (arrow) arrow.style.transform = 'rotate(-90deg)';
  } else {
    el.style.display = '';
    if (arrow) arrow.style.transform = '';
  }
}

function renderSidebar() {
  const el = $('#server-list');
  el.innerHTML = servers.map(s => `
    <div class="server-item${s.id===selectedId?' active':''}" data-id="${s.id}">
      <span class="name">${esc(s.name)}</span>
      <span class="dot ${statusClass(s.status)}"></span>
    </div>
  `).join('');
  el.querySelectorAll('.server-item').forEach(e => e.addEventListener('click', () => selectServer(e.dataset.id)));
  if (serversCollapsed) el.style.display = 'none';
  else el.style.display = '';
}

function selectServer(id) {
  selectedId = id; closeConsole(); closeSidebar();
  $('#welcome').style.display = 'none';
  $('#user-management').style.display = 'none';
  $('#server-view').style.display = 'flex';
  renderSidebar(); showTab(currentTab);
}

function showUserManagement() {
  selectedId = null; closeSidebar();
  $('#welcome').style.display = 'none';
  $('#server-view').style.display = 'none';
  $('#user-management').style.display = 'flex';
  renderUsers();
}

/* ── Tabs ── */
function showTab(name) {
  currentTab = name; editingFile = null;
  filterTabs();
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  const s = servers.find(x => x.id === selectedId);
  if (!s) return;
  $('#server-name').textContent = s.name;
  $('#server-status').className = 'status-badge ' + statusClass(s.status);
  $('#server-status').textContent = s.status;
  const tabMap = {
    dashboard: renderDashboard, console: renderConsole, files: renderFiles,
    world: renderWorld, backups: renderBackups, players: renderPlayers,
    settings: renderSettings,
  };
  (tabMap[name] || (() => {}))(s);
}

/* ── Dashboard ── */
let lastStats = null;

function renderDashboard(s) {
  if (!hasPerm('dashboard')) { $('#tab-content').innerHTML = '<div class="empty-state">No access to this section.</div>'; return; }
  const el = $('#tab-content');
  const running = s.status === 'running';
  let actions = '';
  if (!running && hasPerm('start')) actions += `<button class="btn btn-green btn-sm" onclick="startServer()">Start</button>`;
  if (running) {
    if (hasPerm('stop')) actions += `<button class="btn btn-red btn-sm" onclick="action('stop')">Shutdown</button><button class="btn btn-sm" onclick="action('kill')">Kill</button>`;
    if (hasPerm('restart')) actions += `<button class="btn btn-sm" onclick="action('restart')">Restart</button>`;
  }
  el.innerHTML = `
    <div class="dashboard-actions">${actions}</div>
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
  if (hasPerm('players')) pollOnline(); else { if (onlinePoll) { clearInterval(onlinePoll); onlinePoll = null; } }
}

window.startServer = async function() {
  if (!hasPerm('start')) return;
  const s = servers.find(x => x.id === selectedId);
  if (!s) return;
  if (!s.eula_accepted) {
    const ok = await showModal('Accept Minecraft EULA',
      'You need to accept the <a href="https://aka.ms/MinecraftEULA" target="_blank" style="color:var(--accent)">Minecraft EULA</a> before starting the server for the first time.<br><br>Do you agree to the Minecraft End User License Agreement?',
      { ok: 'I Agree', cancel: 'Cancel' });
    if (!ok) return;
    try { await api(`/servers/${selectedId}/eula`, { method: 'POST' }); } catch(e) { return showModal('Error', esc(e.message)); }
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

/* ── Stats + Canvas ── */
function drawGraph(canvas, label, color, data, totalBytes) {
  /* ... same as before ... */
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
  ctx.strokeStyle = '#1c2128'; ctx.lineWidth = 1 * dpr;
  for (let p = 0; p <= 100; p += 25) { const y = pad.t + gh - (p/100)*gh; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w-pad.r, y); ctx.stroke(); }
  ctx.fillStyle = '#484f58'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let p = 0; p <= 100; p += 25) {
    const y = pad.t + gh - (p/100)*gh;
    let label = p + '%';
    if (totalBytes && p === 100) label = fmtBytes(totalBytes);
    else if (totalBytes) label = fmtBytes(Math.round(totalBytes * p / 100));
    ctx.fillText(label, pad.l - 6, y + 3);
  }
  ctx.fillStyle = '#484f58'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  const xInterval = Math.max(1, Math.floor((n - 1) / 4));
  for (let i = 0; i < n; i += xInterval) { const x = pad.l + (i / (n - 1)) * gw; const secs = Math.round((Date.now() - pts[i].t) / 1000); ctx.fillText(secs + 's', x, h - 6); }
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + gh);
  grad.addColorStop(0, color + '25'); grad.addColorStop(1, color + '03');
  ctx.beginPath(); pts.forEach((d, i) => { const x = pad.l + (i / (n - 1 || 1)) * gw; const y = pad.t + gh - (Math.min(Math.max(d.v, 0), 100) / 100) * gh; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  const lx = pad.l + ((n-1) / (n - 1 || 1)) * gw; ctx.lineTo(lx, pad.t + gh); ctx.lineTo(pad.l, pad.t + gh); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  const lineW = 2 * dpr;
  ctx.beginPath(); pts.forEach((d, i) => {
    const x = pad.l + (i / (n - 1 || 1)) * gw; const y = pad.t + gh - (Math.min(Math.max(d.v, 0), 100) / 100) * gh;
    if (i === 0) ctx.moveTo(x, y); else { const pv = pad.t + gh - (Math.min(Math.max(pts[i-1].v, 0), 100) / 100) * gh; const px = pad.l + ((i-1) / (n - 1 || 1)) * gw; ctx.bezierCurveTo((px+x)/2, pv, (px+x)/2, y, x, y); }
  });
  ctx.strokeStyle = color; ctx.lineWidth = lineW; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
  const last = pts[n-1]; const ex = pad.l + ((n-1) / (n - 1 || 1)) * gw; const ey = pad.t + gh - (Math.min(Math.max(last.v, 0), 100) / 100) * gh;
  ctx.beginPath(); ctx.arc(ex, ey, 4 * dpr, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
  ctx.fillStyle = color; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(Math.round(last.v) + '%', ex + 10 * dpr, ey + 4 * dpr);
  canvas._statsData = data; canvas._statsTotal = totalBytes || 0; canvas._statsPad = pad; canvas._statsGW = gw; canvas._statsGH = gh; canvas._statsN = n;
}

async function loadStats() { try { const st = await api('/system/stats'); lastStats = st; const now = Date.now(); statsCpu.push({t:now,v:st.cpu.percent}); statsMem.push({t:now,v:st.memory.percent}); statsDisk.push({t:now,v:st.disk.percent}); if(statsCpu.length>120) statsCpu.shift(); if(statsMem.length>120) statsMem.shift(); if(statsDisk.length>120) statsDisk.shift(); drawGraph($('#stats-cpu'),'CPU','#ff6b9d',statsCpu); drawGraph($('#stats-mem'),'RAM','#3fb950',statsMem,st.memory.total_bytes); drawGraph($('#stats-disk'),'Disk','#58a6ff',statsDisk,st.disk.total_bytes); } catch(_) {} }
function startStatsPolling() { if(statsInterval) clearInterval(statsInterval); statsInterval = setInterval(loadStats, 2000); }

document.addEventListener('mousemove', e => {
  const c = e.target.closest('.stats-canvas'); if (!c) { const t = $('.graph-tooltip'); if (t) t.remove(); return; }
  const d = c._statsData; if (!d || d.length < 2) return;
  const rect = c.getBoundingClientRect(); const mx = (e.clientX - rect.left) * 2; const pad = c._statsPad; const gw = c._statsGW; const n = c._statsN;
  const idx = Math.max(0, Math.min(n - 1, Math.round(((mx - pad.l) / gw) * (n - 1)))); const pt = d[idx];
  let tip = $('.graph-tooltip'); if (!tip) { tip = document.createElement('div'); tip.className = 'graph-tooltip'; document.body.appendChild(tip); }
  const age = Math.round((Date.now() - pt.t) / 1000);
  let text = pt.v.toFixed(1) + '%'; if (c._statsTotal) { const used = Math.round(c._statsTotal * pt.v / 100); text = fmtBytes(used) + ' / ' + fmtBytes(c._statsTotal) + ' (' + pt.v.toFixed(1) + '%)'; }
  tip.innerHTML = text + '<br><span style="font-size:10px;opacity:0.6">' + age + 's ago</span>';
  tip.style.display = 'block'; tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 10) + 'px'; tip.style.top = (e.clientY - 40) + 'px';
});

/* ── Online Players ── */
let onlinePoll = null;
async function pollOnline() { if (onlinePoll) clearInterval(onlinePoll); await updateOnline(); onlinePoll = setInterval(updateOnline, 5000); }
async function updateOnline() {
  try {
    const players = await api('/servers/'+selectedId+'/players'); const online = players ? players.filter(p => p.online) : [];
    const el = $('#online-list'); const cnt = $('#online-count'); if (cnt) cnt.textContent = online.length;
    if (!el) return; if (!online.length) { el.innerHTML = '<span class="online-empty">No players online</span>'; return; }
    el.innerHTML = online.map(p => '<span class="online-player" data-player="'+escAttr(p.name)+'"><span class="online-dot"></span>'+esc(p.name)+'</span>').join('');
    el.querySelectorAll('.online-player').forEach(el2 => { el2.addEventListener('click', () => { showTab('players'); }); });
  } catch(_) {}
}

/* ── Console ── */
function renderConsole(s) { if(!hasPerm('console')){$('#tab-content').innerHTML='<div class="empty-state">No access.</div>';return;}
  const el = $('#tab-content');
  const canSend = s.status==='running' && hasPerm('console_send');
  el.innerHTML = `<div class="console-container"><div class="console-output" id="console-output">${s.status!=='running'?'<div class="line" style="color:var(--text-dim)">Server is not running.</div>':''}</div><div class="console-input-row"><input type="text" id="console-input" placeholder="${canSend?'Type a command...':'Start the server first'}" autocomplete="off" ${!canSend?'disabled':''}><button class="btn btn-primary btn-sm" id="console-send" ${!canSend?'disabled':''}>Send</button></div></div>`;
  if(s.status!=='running')return;const out=$('#console-output');if(consoleLines.length)out.innerHTML=consoleLines.map(l=>'<div class="line">'+esc(l)+'</div>').join('');out.scrollTop=out.scrollHeight;
  $('#console-input').addEventListener('keydown',e=>{if(e.key==='Enter')sendCmd();});$('#console-send').addEventListener('click',sendCmd);openConsole();
}
function sendCmd() { if (!hasPerm('console_send')) return; const input = $('#console-input'); const cmd = input.value.trim(); if (!cmd) return; input.value = ''; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'cmd',data:cmd})); else api('/servers/'+selectedId+'/command', { method:'POST', body: JSON.stringify({command:cmd}) }); }
function openConsole() { closeConsole(); const s = servers.find(x => x.id === selectedId); if (!s || s.status !== 'running') return; const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; ws = new WebSocket(proto+'//'+location.host+'/api/servers/'+selectedId+'/console?token='+authToken); ws.onmessage = e => { const msg = JSON.parse(e.data); if (msg.type === 'log') { consoleLines.push(msg.data); if (consoleLines.length > 5000) consoleLines = consoleLines.slice(-5000); const out = $('#console-output'); if (out) { out.insertAdjacentHTML('beforeend','<div class="line">'+esc(msg.data)+'</div>'); out.scrollTop = out.scrollHeight; } } }; ws.onclose = () => { ws = null; }; }
function closeConsole() { if (ws) { ws.close(); ws = null; } }

/* ── Files ── */
function renderFiles(s) {if(!hasAnyPerm(['files_read','files_write'])){$('#tab-content').innerHTML='<div class="empty-state">No access.</div>';return;}
  filePath='';editingFile=null;$('#tab-content').innerHTML=`<div class="files-toolbar"><div id="file-breadcrumb" style="flex:1;font-size:13px;color:var(--text-dim)"></div></div><div class="drop-zone" id="drop-zone"><p>Drop files here or click to browse</p><span class="hint">Drag & drop files to upload</span><div id="upload-progress" class="upload-progress" style="display:none"><div class="upload-info"><span id="upload-filename"></span><span id="upload-percent">0%</span></div><div class="progress-track"><div id="progress-fill" class="progress-fill" style="width:0%"></div></div></div></div><div id="file-view"><div class="file-list" id="file-list"><div style="padding:20px;text-align:center;color:var(--text-dim)">Loading...</div></div></div>`;loadFiles();setupDropZone();
}
function breadcrumb() { const p=filePath.split('/').filter(Boolean); let h='<a href="#" class="bc-link" data-dir="" style="color:var(--accent)">root</a>'; let a=''; for(const x of p){a+='/'+x;h+=' / <a href="#" class="bc-link" data-dir="'+escAttr(a)+'" style="color:var(--accent)">'+esc(x)+'</a>';} return h; }
function fileHTML(d){return d?'<span class="file-icon dir"><span class="icon-folder"></span></span>':'<span class="file-icon file"><span class="icon-doc"></span></span>';}
async function loadFiles(){const list=$('#file-list');const bc=$('#file-breadcrumb');if(bc)bc.innerHTML=breadcrumb();try{const q=filePath?'?dir='+encodeURIComponent(filePath):'';const files=await api('/servers/'+selectedId+'/files'+q);const items=[];if(filePath){const p=filePath.split('/').slice(0,-1).join('/');items.push('<div class="file-item is-dir" data-dir="'+p+'"><div class="file-info"><span class="file-icon dir"><span class="icon-folder"></span></span><span class="file-name dir-link">..</span></div></div>');}
for(const f of files){const n=esc(f.name);const fp=filePath?filePath+'/'+f.name:f.name;const ss=f.is_dir?'':fmtBytes(f.size);items.push('<div class="file-item '+(f.is_dir?'is-dir':'is-file')+'" data-path="'+escAttr(fp)+'" data-dir="'+(f.is_dir?escAttr(fp):'')+'"><div class="file-info">'+fileHTML(f.is_dir)+'<span class="file-name '+(f.is_dir?'dir-link':'')+'">'+n+'</span></div><div class="file-actions">'+(ss?'<span class="file-size">'+ss+'</span>':'')+'<button class="file-ctx-btn" onclick="event.stopPropagation();showCtx(event,\''+escAttr(fp)+'\','+f.is_dir+')">⋮</button><button class="btn btn-sm delete-btn">Del</button></div></div>');}
list.innerHTML=items.length?items.join(''):'<div style="padding:20px;text-align:center;color:var(--text-dim)">Empty directory</div>';
list.querySelectorAll('.file-item.is-dir').forEach(el=>el.addEventListener('click',e=>{if(!e.target.closest('.file-actions'))goDir(el.dataset.dir);}));
list.querySelectorAll('.delete-btn').forEach(btn=>btn.addEventListener('click',async e=>{const p=btn.closest('[data-path]').dataset.path;if(await showModal('Delete','Delete "'+p+'"?',{ok:'Delete',cancel:'Cancel'})){try{await api('/servers/'+selectedId+'/files?path='+encodeURIComponent(p),{method:'DELETE'});loadFiles();}catch(e){showModal('Error',esc(e.message));}}}));
list.querySelectorAll('.file-item.is-file .file-name').forEach(el=>{el.style.cursor='pointer';el.title='Click to edit';el.addEventListener('click',e=>{if(e.target.closest('.file-actions'))return;const path=el.closest('[data-path]').dataset.path;openEditor(path);});});
list.querySelectorAll('.file-item.is-file').forEach(el=>el.addEventListener('contextmenu',e=>showCtx(e,el.dataset.path,false)));
list.querySelectorAll('.file-item.is-dir[data-dir]').forEach(el=>el.addEventListener('contextmenu',e=>showCtx(e,el.dataset.path||el.dataset.dir,true)));
if(bc)bc.querySelectorAll('.bc-link').forEach(el=>el.addEventListener('click',e=>{e.preventDefault();goDir(el.dataset.dir);}));
}catch(e){list.innerHTML='<div style="padding:20px;text-align:center;color:var(--red)">Error: '+esc(e.message)+'</div>';}}
window.goDir=function(dir){filePath=dir;loadFiles();};
function setupDropZone(){const dz=$('#drop-zone');dz.addEventListener('click',()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.onchange=()=>uploadFiles(i.files);i.click();});dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('drag-over');});dz.addEventListener('dragleave',()=>dz.classList.remove('drag-over'));dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('drag-over');uploadFiles(e.dataTransfer.files);});}
function showProgress(n,p){const b=$('#upload-progress');if(!b)return;b.style.display='block';$('#upload-filename').textContent=n;$('#upload-percent').textContent=p+'%';$('#progress-fill').style.width=p+'%';}
function hideProgress(){const b=$('#upload-progress');if(!b)return;b.style.display='none';$('#progress-fill').style.width='0%';}
function uploadXHR(f,d){return new Promise((res,rej)=>{const fd=new FormData();fd.append('file',f);if(d)fd.append('dir',d);const x=new XMLHttpRequest();x.upload.onprogress=e=>{if(e.lengthComputable)showProgress(f.name,Math.round(e.loaded/e.total*100));};x.onload=()=>x.status>=200&&x.status<300?res():rej(new Error(x.responseText||'Upload failed'));x.onerror=()=>rej(new Error('Network error'));x.open('POST',API+'/servers/'+selectedId+'/upload?token='+authToken);x.send(fd);});}
async function uploadFiles(files){for(const f of files){try{await uploadXHR(f,filePath||'');}catch(e){showModal('Upload Error',esc(e.message));}}hideProgress();loadFiles();}

/* ── File Editor ── */
const EXT_MAP={'.json':'json','.js':'js','.ts':'ts','.html':'html','.htm':'html','.css':'css','.yml':'yaml','.yaml':'yaml','.xml':'xml','.md':'md','.py':'py','.sh':'sh','.txt':'text','.properties':'props','.toml':'toml','.ini':'ini','.cfg':'cfg','.log':'log'};
function editorLang(p){const e=p.substring(p.lastIndexOf('.')).toLowerCase();return EXT_MAP[e]||'text';}
async function openEditor(path){editingFile=path;const el=$('#file-view');if(!el)return;
el.innerHTML='<div class="file-editor"><div class="file-editor-header"><span class="file-path">'+esc(path)+'</span><span class="file-lang">'+editorLang(path)+'</span><button class="btn btn-sm" onclick="cancelEditor()">Cancel</button><button class="btn btn-primary btn-sm" onclick="saveEditor()">Save</button></div><div class="editor-wrap"><div class="editor-gutter" id="editor-gutter"></div><textarea id="editor-textarea" spellcheck="false">Loading...</textarea></div></div>';
try{const resp=await fetch(API+'/servers/'+selectedId+'/file?path='+encodeURIComponent(path),{headers:{Authorization:'Bearer '+authToken}});if(!resp.ok)throw new Error(await resp.text());const ta=$('#editor-textarea');ta.value=await resp.text();updateGutter();ta.addEventListener('scroll',updateGutter);ta.addEventListener('input',updateGutter);ta.addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const s=ta.selectionStart;ta.value=ta.value.substring(0,s)+'  '+ta.value.substring(ta.selectionEnd);ta.selectionStart=ta.selectionEnd=s+2;updateGutter();}});}catch(e){$('#editor-textarea').value='Error: '+e.message;}}
function updateGutter(){const ta=$('#editor-textarea');const g=$('#editor-gutter');if(!ta||!g)return;g.innerHTML=Array.from({length:ta.value.split('\n').length},(_,i)=>'<div class="gutter-line">'+(i+1)+'</div>').join('');g.scrollTop=ta.scrollTop;}
window.saveEditor=async function(){const ta=$('#editor-textarea');if(!ta||!editingFile)return;try{await api('/servers/'+selectedId+'/file?path='+encodeURIComponent(editingFile),{method:'PUT',body:JSON.stringify({content:ta.value})});showModal('Saved','File saved.');cancelEditor();}catch(e){showModal('Error',esc(e.message));}};
window.cancelEditor=function(){editingFile=null;renderFiles(servers.find(x=>x.id===selectedId));};

/* ── Context Menu ── */
let ctxTarget=null,ctxDir=false;
function showCtx(e,p,d){e.preventDefault();e.stopPropagation();ctxTarget=p;ctxDir=d;const m=$('#ctx-menu');$$('.ctx-item',m).forEach(el=>{const a=el.dataset.action;if(a==='download')el.style.display=d||!hasPerm('files_read')?'none':'block';else if(a==='rename'||a==='delete')el.style.display=hasPerm('files_write')?'block':'none';});const c=$('#ctx-cancel');if(c)c.style.display=isMobile()?'block':'none';if(isMobile()){m.style.left='0';m.style.top='auto';}else{m.style.left=Math.min(e.clientX,window.innerWidth-160)+'px';m.style.top=Math.min(e.clientY,window.innerHeight-120)+'px';}m.style.display='block';}
function hideCtx(){$('#ctx-menu').style.display='none';ctxTarget=null;}
$('#ctx-menu').addEventListener('click',async e=>{const btn=e.target.closest('.ctx-item');if(!btn||btn.id==='ctx-cancel')return;const a=btn.dataset.action;const p=ctxTarget;hideCtx();if(!p)return;try{if(a==='download')window.open('/api/servers/'+selectedId+'/download?path='+encodeURIComponent(p)+'&token='+authToken,'_blank');else if(a==='rename'){const n=prompt('New name:',p.split('/').pop());if(!n||n===p.split('/').pop())return;await api('/servers/'+selectedId+'/files?path='+encodeURIComponent(p),{method:'PUT',body:JSON.stringify({name:n})});loadFiles();}else if(a==='delete'){if(await showModal('Delete','Delete "'+p+'"?',{ok:'Delete',cancel:'Cancel'})){await api('/servers/'+selectedId+'/files?path='+encodeURIComponent(p),{method:'DELETE'});loadFiles();}}}catch(e){showModal('Error',esc(e.message));}});
document.addEventListener('click',hideCtx);window.addEventListener('resize',()=>{if(!isMobile())hideCtx();});

/* ── Settings ── */
function renderSettings(s){if(!hasPerm('settings')){$('#tab-content').innerHTML='<div class="empty-state">No access.</div>';return;}
  let html='<div class="settings-form"><div class="form-group"><label>Server Name</label><input type="text" id="set-name" value="${esc(s.name)}"></div><div class="form-group"><label>Server Jar</label><input type="text" id="set-jar" value="${esc(s.jar_file)}"></div><div class="form-group"><label>Java Path</label><input type="text" id="set-java-path" value="${esc(s.java_path||'')}" placeholder="/usr/lib/jvm/java-21/bin/java"></div><div class="form-group"><label>Java Arguments</label><input type="text" id="set-java" value="${esc(s.java_args)}"></div><div class="form-group"><label>Port</label><input type="number" id="set-port" value="${s.port}"></div><div class="form-group"><label class="checkbox-label"><input type="checkbox" id="set-autostart" ${s.auto_start?'checked':''}> Auto-start on boot</label></div><div class="form-group" style="display:flex;gap:8px"><button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>${hasPerm('server_delete')?'<button class="btn btn-red" onclick="deleteServer()">Delete Server</button>':''}</div></div>';
  $('#tab-content').innerHTML=html;
}
window.saveSettings=async function(){const body={name:$('#set-name').value,jar_file:$('#set-jar').value,java_path:$('#set-java-path').value,java_args:$('#set-java').value,port:parseInt($('#set-port').value)||25565,auto_start:$('#set-autostart').checked};try{const s=await api('/servers/'+selectedId,{method:'PUT',body:JSON.stringify(body)});const idx=servers.findIndex(x=>x.id===s.id);if(idx!==-1)servers[idx]=s;renderSidebar();showTab(currentTab);showModal('Saved','Settings saved.');}catch(e){showModal('Error',esc(e.message));}};
window.deleteServer=async function(){if(!hasPerm('server_delete'))return;const s=servers.find(x=>x.id===selectedId);if(!s)return;if(!await showModal('Delete Server','Permanently delete server "'+s.name+'"?',{ok:'Delete',cancel:'Cancel'}))return;if(!await showModal('Confirm','Are you sure?',{ok:'Yes, Delete',cancel:'Cancel'}))return;try{await api('/servers/'+selectedId,{method:'DELETE'});selectedId=null;await loadServers();$('#server-view').style.display='none';$('#welcome').style.display='flex';}catch(e){showModal('Error',esc(e.message));}};

/* ── World ── */
async function renderWorld(s){if(!hasPerm('world')){$('#tab-content').innerHTML='<div class="empty-state">No access.</div>';return;}
  const el=$('#tab-content');el.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-dim)">Loading...</div>';
  try{const worlds=await api('/servers/'+selectedId+'/world');const running=s.status==='running';const warn=running?'<div class="world-notice">Server running. Stop to upload/delete/replace worlds.</div>':'';let html=warn+'<div class="section-title">Worlds</div>';
  if(!worlds||!worlds.length)html+='<div class="empty-state">No worlds found.</div>';else{for(const w of worlds){html+='<div class="world-card" data-world="'+escAttr(w.name)+'"><div class="world-info"><div class="world-name"><span class="icon-folder-sm"></span>'+esc(w.name)+'</div><div class="world-meta">'+fmtBytes(w.size)+' &middot; '+fmtDate(w.mod_time)+'</div></div><div class="world-actions"><button class="btn btn-sm" onclick="downloadWorld(\''+escAttr(w.name)+'\')">Download</button><button class="btn btn-sm" onclick="replaceWorld(\''+escAttr(w.name)+'\')" '+(running?'disabled style="opacity:0.4"':'')+'>Replace</button><button class="btn btn-sm btn-red" onclick="deleteWorld(\''+escAttr(w.name)+'\')" '+(running?'disabled style="opacity:0.4"':'')+'>Delete</button></div></div>';}}
  html+='<div class="section-title" style="margin-top:20px">Upload World</div><div class="world-upload" id="world-upload-zone"><p>Upload a <code>.zip</code> world file</p><span class="hint">'+(running?'Server must be stopped':'Extracts into server dir')+'</span></div><div id="world-upload-progress" class="upload-progress" style="display:none"><div class="upload-info"><span id="wu-filename"></span><span id="wu-percent">0%</span></div><div class="progress-track"><div id="wu-fill" class="progress-fill" style="width:0%"></div></div></div>';
  el.innerHTML=html;
  el.querySelectorAll('.world-card').forEach(card=>{card.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();const n=card.dataset.world;const m=$('#ctx-menu');$$('.ctx-item',m).forEach(el2=>{el2.style.display='block';if(el2.dataset.action==='download')el2.onclick=()=>{hideCtx();downloadWorld(n);};else if(el2.dataset.action==='rename')el2.style.display='none';else if(el2.dataset.action==='delete')el2.onclick=()=>{hideCtx();deleteWorld(n);};});let oi=m.querySelector('.ctx-item[data-action="open-files"]');if(!oi){oi=document.createElement('button');oi.className='ctx-item';oi.dataset.action='open-files';oi.textContent='Open in Files';m.insertBefore(oi,m.firstChild);}oi.style.display='block';oi.onclick=()=>{hideCtx();filePath=n;showTab('files');};const c2=$('#ctx-cancel');if(c2)c2.style.display=isMobile()?'block':'none';if(isMobile()){m.style.left='0';m.style.top='auto';}else{m.style.left=Math.min(e.clientX,window.innerWidth-160)+'px';m.style.top=Math.min(e.clientY,window.innerHeight-120)+'px';}m.style.display='block';});});
  if(!running){const wz=$('#world-upload-zone');if(wz){wz.addEventListener('click',()=>uploadWorld());wz.addEventListener('dragover',e=>{e.preventDefault();wz.classList.add('drag-over');});wz.addEventListener('dragleave',()=>wz.classList.remove('drag-over'));wz.addEventListener('drop',e=>{e.preventDefault();wz.classList.remove('drag-over');doWorldUpload(e.dataTransfer.files[0]);});}}
  }catch(e){el.innerHTML='<div class="empty-state">Error: '+esc(e.message)+'</div>';}
}
window.downloadWorld=function(n){window.open('/api/servers/'+selectedId+'/world/download?world='+encodeURIComponent(n)+'&token='+authToken,'_blank');};
window.replaceWorld=async function(n){const i=document.createElement('input');i.type='file';i.accept='.zip';i.onchange=async()=>{if(!i.files[0])return;if(!await showModal('Replace World','Replace "'+n+'"?',{ok:'Replace',cancel:'Cancel'}))return;try{await api('/servers/'+selectedId+'/world?name='+encodeURIComponent(n),{method:'DELETE'});}catch(_){}doWorldUpload(i.files[0]);};i.click();};
window.deleteWorld=async function(n){if(!await showModal('Delete World','Delete "'+n+'"?',{ok:'Delete',cancel:'Cancel'}))return;try{await api('/servers/'+selectedId+'/world?name='+encodeURIComponent(n),{method:'DELETE'});renderWorld(servers.find(s=>s.id===selectedId));}catch(e){showModal('Error',esc(e.message));}};
window.uploadWorld=function(){const i=document.createElement('input');i.type='file';i.accept='.zip';i.onchange=()=>{if(i.files[0])doWorldUpload(i.files[0]);};i.click();};
async function doWorldUpload(file){const pb=$('#world-upload-progress');if(!pb)return;pb.style.display='block';$('#wu-filename').textContent=file.name;const fd=new FormData();fd.append('file',file);const x=new XMLHttpRequest();x.upload.onprogress=e=>{if(e.lengthComputable){$('#wu-percent').textContent=Math.round(e.loaded/e.total*100)+'%';$('#wu-fill').style.width=Math.round(e.loaded/e.total*100)+'%';}};x.onload=()=>{pb.style.display='none';if(x.status>=200&&x.status<300){showModal('Success','World uploaded.');renderWorld(servers.find(s=>s.id===selectedId));}else showModal('Error',x.responseText||'Upload failed');};x.onerror=()=>{pb.style.display='none';showModal('Error','Network error');};x.open('POST',API+'/servers/'+selectedId+'/world/upload?token='+authToken);x.send(fd);}

/* ── Backups ── */
async function renderBackups(s){if(!hasAnyPerm(['backups_create','backups_delete','backups_restore'])){$('#tab-content').innerHTML='<div class="empty-state">No access.</div>';return;}
  const el=$('#tab-content');el.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-dim)">Loading...</div>';
  try{const[backups,folders]=await Promise.all([api('/servers/'+selectedId+'/backups'),api('/servers/'+selectedId+'/world/folders')]);const running=s.status==='running';let html='<div class="section-title">Create Backup</div><div class="backup-form"><p style="font-size:13px;color:var(--text-dim);margin-bottom:10px">Select folders:</p><div class="folder-list" id="backup-folders">';
  const autoChecked=['world','world_nether','world_the_end'];
  if(folders&&folders.length){for(const f of folders){const ch=autoChecked.includes(f.name)?'checked':'';html+='<label class="folder-item"><input type="checkbox" class="folder-cb" value="'+escAttr(f.name)+'" '+ch+'><span class="folder-icon '+(f.is_mod?'mod':'world')+'"></span><span class="folder-name">'+esc(f.name)+'</span><span class="folder-size">'+fmtBytes(f.size)+'</span></label>';}}
  html+='</div><div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">'+(hasPerm('backups_create')?'<button class="btn btn-sm" onclick="document.querySelectorAll(\'.folder-cb\').forEach(c=>c.checked=true)">All</button><button class="btn btn-sm" onclick="document.querySelectorAll(\'.folder-cb\').forEach(c=>c.checked=false)">None</button><button class="btn btn-primary" onclick="createBackup()">Create Backup</button>':'')+'<span id="backup-total-size" style="font-size:12px;color:var(--text-dim)"></span></div></div>';
  html+='<div class="section-title" style="margin-top:24px">Saved Backups</div>';
  if(!backups||!backups.length)html+='<div class="empty-state">No backups.</div>';else{for(const b of backups){html+='<div class="backup-item"><div class="backup-info"><div class="backup-name">'+esc(b.name)+'</div><div class="backup-meta">'+fmtBytes(b.size)+' &middot; '+fmtDate(b.created)+'</div></div><div class="backup-actions"><button class="btn btn-sm" onclick="downloadBackup(\''+escAttr(b.name)+'\')">Download</button>'+(hasPerm('backups_restore')?'<button class="btn btn-sm" onclick="restoreBackup(\''+escAttr(b.name)+'\')" '+(running?'disabled style="opacity:0.4"':'')+'>Restore</button>':'')+(hasPerm('backups_delete')?'<button class="btn btn-sm btn-red" onclick="deleteBackup(\''+escAttr(b.name)+'\')">Delete</button>':'')+'</div></div>';}}
  el.innerHTML=html;updateBackupSize();el.querySelectorAll('.folder-cb').forEach(cb=>cb.addEventListener('change',updateBackupSize));}catch(e){el.innerHTML='<div class="empty-state">Error: '+esc(e.message)+'</div>';}
}
function updateBackupSize(){const el=$('#backup-total-size');if(!el)return;let total=0;$$('.folder-cb:checked').forEach(cb=>{const st=cb.closest('.folder-item')?.querySelector('.folder-size')?.textContent;if(!st)return;const m=st.match(/^([\d.]+)\s*(\w+)/);if(!m)return;const v=parseFloat(m[1]),u=m[2];if(u==='B')total+=v;else if(u==='KB')total+=v*1024;else if(u==='MB')total+=v*1048576;else if(u==='GB')total+=v*1073741824;else if(u==='TB')total+=v*1099511627776;});el.textContent='~'+fmtBytes(total);}
window.createBackup=async function(){if(!hasPerm('backups_create'))return;const cbs=$$('.folder-cb:checked');if(!cbs.length){showModal('Error','Select folders.');return;}try{const b=await api('/servers/'+selectedId+'/backups',{method:'POST',body:JSON.stringify({folders:[...cbs].map(c=>c.value)})});showModal('Backup Created','Backup "'+b.name+'" created.');renderBackups(servers.find(s=>s.id===selectedId));}catch(e){showModal('Error',esc(e.message));}};
window.restoreBackup=async function(n){if(!hasPerm('backups_restore'))return;if(!await showModal('Restore Backup','Restore "'+n+'"?',{ok:'Restore',cancel:'Cancel'}))return;const s=servers.find(x=>x.id===selectedId);if(s&&s.status==='running'){showModal('Error','Server must be stopped.');return;}try{await api('/servers/'+selectedId+'/backups/restore?name='+encodeURIComponent(n),{method:'POST'});showModal('Restored','Done.');}catch(e){showModal('Error',esc(e.message));}};
window.deleteBackup=async function(n){if(!hasPerm('backups_delete'))return;if(!await showModal('Delete Backup','Delete "'+n+'"?',{ok:'Delete',cancel:'Cancel'}))return;try{await api('/servers/'+selectedId+'/backups?name='+encodeURIComponent(n),{method:'DELETE'});renderBackups(servers.find(s=>s.id===selectedId));}catch(e){showModal('Error',esc(e.message));}};
window.downloadBackup=function(n){window.open('/api/servers/'+selectedId+'/backups/download?name='+encodeURIComponent(n)+'&token='+authToken,'_blank');};

/* ── Players ── */
let expandedPlayer=null;
async function renderPlayers(s){if(!hasPerm('players')){$('#tab-content').innerHTML='<div class="empty-state">No access.</div>';return;}
  const el=$('#tab-content');expandedPlayer=null;el.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-dim)">Loading...</div>';
  try{const players=await api('/servers/'+selectedId+'/players');if(!players||!players.length){el.innerHTML='<div class="empty-state">No players found.<br>'+(s.status==='running'?'They will appear when they join.':'Start the server.')+'</div>';return;}
  el.innerHTML='<div style="margin-bottom:12px;font-size:13px;color:var(--text-dim)">'+players.length+' known player(s)</div><div class="players-list">'+
  players.map(p=>{const av=esc(p.name.charAt(0).toUpperCase());const bc=p.online?'online':'offline';const bt=p.online?'Online':'Offline';const st=p.stats;const exp=expandedPlayer===p.name;
  return '<div class="player-card'+(exp?' expanded':'')+'" data-player="'+escAttr(p.name)+'"><div class="player-main" onclick="togglePlayer(\''+escAttr(p.name)+'\')"><div class="player-avatar">'+av+'</div><div class="player-info"><div class="player-name-row"><div class="player-name">'+esc(p.name)+'</div><span class="player-badge '+bc+'">'+bt+'</span></div>'+(p.uuid?'<div class="player-uuid">'+esc(p.uuid)+'</div>':'')+
  '<div class="player-stats-summary">'+(st?'<span>Played '+fmtTime(st.play_time)+'</span><span>Walked '+(st.walk_dist/1000).toFixed(1)+'km</span>':'<span class="no-stats">No stats yet</span>')+'</div></div><span class="player-expand-icon">'+(exp?'▾':'▸')+'</span></div>'+
  (exp&&st?'<div class="player-detail"><div class="detail-grid">'+
  '<div class="detail-item"><span class="detail-label">Play Time</span><span class="detail-value">'+fmtTime(st.play_time)+'</span></div>'+
  '<div class="detail-item"><span class="detail-label">Distance</span><span class="detail-value">'+(st.walk_dist/1000).toFixed(2)+' km</span></div>'+
  '<div class="detail-item"><span class="detail-label">Mob Kills</span><span class="detail-value">'+st.kills+'</span></div>'+
  '<div class="detail-item"><span class="detail-label">Damage Dealt</span><span class="detail-value">'+st.damage+'</span></div>'+
  '<div class="detail-item"><span class="detail-label">Deaths</span><span class="detail-value stat-death">'+st.deaths+'</span></div>'+
  (st.play_time?'<div class="detail-item"><span class="detail-label">K/D Ratio</span><span class="detail-value">'+(st.deaths?(st.kills/st.deaths).toFixed(2):st.kills)+'</span></div>':'')+
  '</div></div>':'')+
  (exp&&!st?'<div class="player-detail"><div class="empty-state" style="padding:16px">No stats yet.</div></div>':'')+
  '</div>';}).join('')+'</div>';}catch(e){el.innerHTML='<div class="empty-state">Error: '+esc(e.message)+'</div>';}
}
window.togglePlayer=function(n){expandedPlayer=expandedPlayer===n?null:n;renderPlayers(servers.find(s=>s.id===selectedId));};

/* ── Users (admin only) ── */
async function renderUsers() {
  if (authUser && authUser.role !== 'admin') { $('#user-list').innerHTML = '<div class="empty-state">No access.</div>'; return; }
  const el = $('#user-list');
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">Loading...</div>';
  try {
    const users = await api('/users');
    if (!users || !users.length) { el.innerHTML = '<div class="empty-state">No users.</div>'; return; }
    let html = '';
    for (const u of users) {
      const serverCount = u.permissions ? Object.keys(u.permissions).length : 0;
      html += `<div class="user-card">
        <div class="user-info">
          <div class="user-name-row">
            <span class="user-avatar">${esc(u.username.charAt(0).toUpperCase())}</span>
            <span class="user-name">${esc(u.username)}</span>
            <span class="user-role-badge ${u.role}">${u.role}</span>
          </div>
          ${u.role === 'user' ? '<div class="user-perms">' + serverCount + ' server(s) configured</div>' : '<div class="user-perms">Full access to all servers</div>'}
        </div>
        <div class="user-actions">
          <button class="btn btn-sm" onclick="showUserModal('${escAttr(u.username)}')">Edit</button>
          <button class="btn btn-sm btn-red" onclick="deleteUser('${escAttr(u.username)}')">Del</button>
        </div>
      </div>`;
    }
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div class="empty-state">Error: '+esc(e.message)+'</div>'; }
}

const PERM_GROUPS = [
  { title: 'General', perms: ['dashboard', 'players', 'settings'] },
  { title: 'Control', perms: ['start', 'stop', 'restart'] },
  { title: 'Console', perms: ['console', 'console_send'] },
  { title: 'Files', perms: ['files_read', 'files_write'] },
  { title: 'World', perms: ['world'] },
  { title: 'Backups', perms: ['backups_create', 'backups_delete', 'backups_restore'] },
  { title: 'Admin', perms: ['server_delete', 'grant'] },
];

window.showUserModal = async function(editUsername) {
  const isEdit = !!editUsername;
  const serversList = await api('/servers');
  const existingServers = serversList || servers;

  let userData = { username: '', password: '', role: 'user', permissions: {} };
  if (isEdit) {
    const allUsers = await api('/users');
    const found = allUsers.find(u => u.username === editUsername);
    if (found) {
      userData = {
        username: found.username,
        password: '',
        role: found.role,
        permissions: found.permissions || {},
      };
    }
  }

  const overlay = $('#modal-overlay');
  const modal = overlay.querySelector('.modal');
  modal.classList.add('wide');
  $('#modal-title').textContent = isEdit ? 'Edit User: ' + editUsername : 'Add User';
  $('#modal-confirm').textContent = isEdit ? 'Save' : 'Create';

  let permHTML = '';
  for (const s of existingServers) {
    const perms = (userData.permissions[s.id] || []);
    permHTML += '<div class="perm-server" data-server-id="' + escAttr(s.id) + '">';
    permHTML += '<div class="perm-server-header"><strong>' + esc(s.name) + '</strong><div class="perm-server-actions"><button class="btn btn-sm" data-selall="' + escAttr(s.id) + '">All</button><button class="btn btn-sm" data-selnone="' + escAttr(s.id) + '">None</button></div></div>';
    for (const g of PERM_GROUPS) {
      permHTML += '<div class="perm-group"><div class="perm-group-title">' + esc(g.title) + '</div><div class="perm-grid">';
      for (const p of g.perms) {
        const checked = perms.includes(p) ? 'checked' : '';
        permHTML += `<label class="perm-label"><input type="checkbox" class="perm-cb" data-server="${escAttr(s.id)}" data-perm="${p}" ${checked}> ${p.replace('_', ' ')}</label>`;
      }
      permHTML += '</div></div>';
    }
    permHTML += '</div>';
  }

  $('#modal-body').innerHTML = `
    <div class="form-group"><label>Username</label><input type="text" id="mu-name" value="${esc(userData.username)}" ${isEdit?'disabled':''} placeholder="username"></div>
    <div class="form-group"><label>Password ${isEdit?'(leave empty to keep)':''}</label><input type="password" id="mu-pass" placeholder="${isEdit?'unchanged if empty':'password'}" ${isEdit?'':'required'}></div>
    <div class="form-group"><label>Role</label><select id="mu-role"><option value="user" ${userData.role==='user'?'selected':''}>User</option><option value="admin" ${userData.role==='admin'?'selected':''}>Admin</option></select></div>
    <div id="mu-perms-section">
      <label style="font-size:12px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;display:block">Server Permissions</label>
      ${permHTML || '<div class="empty-state" style="padding:12px">No servers yet.</div>'}
    </div>`;

  $('#modal-body').classList.add('modal-body-scroll');

  // Select All / None per server
  $$('[data-selall]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.selall;
      const server = overlay.querySelector('.perm-server[data-server-id="' + sid + '"]');
      if (server) server.querySelectorAll('.perm-cb').forEach(cb => cb.checked = true);
    });
  });
  $$('[data-selnone]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.selnone;
      const server = overlay.querySelector('.perm-server[data-server-id="' + sid + '"]');
      if (server) server.querySelectorAll('.perm-cb').forEach(cb => cb.checked = false);
    });
  });

  // Toggle perms section visibility based on role
  $('#mu-role').addEventListener('change', () => {
    $('#mu-perms-section').style.display = $('#mu-role').value === 'admin' ? 'none' : '';
  });
  if (userData.role === 'admin') $('#mu-perms-section').style.display = 'none';

  overlay.style.display = 'flex';
  overlay.dataset.edit = isEdit ? editUsername : '';

  // Override form submit
  $('#modal-form').onsubmit = async (e) => {
    e.preventDefault();
    const username = $('#mu-name').value.trim();
    const password = $('#mu-pass').value;
    const role = $('#mu-role').value;
    const permissions = {};
    if (role === 'user') {
      $$('.perm-cb:checked').forEach(cb => {
        const sid = cb.dataset.server;
        const perm = cb.dataset.perm;
        if (!permissions[sid]) permissions[sid] = [];
        permissions[sid].push(perm);
      });
    }
    try {
      if (isEdit) {
        const body = { role, permissions };
        if (password) body.password = password;
        await api('/users/' + encodeURIComponent(editUsername), { method: 'PUT', body: JSON.stringify(body) });
      } else {
        if (!username || !password) { showModal('Error', 'Username and password required.'); return; }
        await api('/users', { method: 'POST', body: JSON.stringify({ username, password, role, permissions }) });
      }
      closeModal();
      renderUsers();
    } catch(e) { showModal('Error', esc(e.message)); }
  };
};

window.deleteUser = async function(username) {
  if (!await showModal('Delete User', 'Delete user "'+username+'"?', {ok:'Delete',cancel:'Cancel'})) return;
  try {
    await api('/users/' + encodeURIComponent(username), { method: 'DELETE' });
    renderUsers();
  } catch(e) { showModal('Error', esc(e.message)); }
};

/* ── New Server Modal ── */
$('#new-server-btn').addEventListener('click', () => openModal());
function openModal(server) {
  const overlay=$('#modal-overlay');const body=$('#modal-body');const isEdit=!!server;
  $('#modal-title').textContent=isEdit?'Edit Server':'New Server';$('#modal-confirm').textContent=isEdit?'Save':'Create';
  body.innerHTML=`<div class="form-group"><label>Server Name</label><input type="text" id="f-name" value="${isEdit?esc(server.name):''}" placeholder="My Server"></div><div class="form-group"><label>Server Jar</label><input type="text" id="f-jar" value="${isEdit?esc(server.jar_file):''}" placeholder="paper-1.21.1.jar"></div><div class="form-group"><label>Java Args</label><input type="text" id="f-java" value="${isEdit?esc(server.java_args):'-Xmx1G -Xms1G'}" placeholder="-Xmx1G -Xms1G"></div><div class="form-group"><label>Java Path</label><input type="text" id="f-java-path" value="${isEdit?esc(server.java_path||''):''}" placeholder="/usr/lib/jvm/java-21/bin/java"></div><div class="form-group"><label>Port</label><input type="number" id="f-port" value="${isEdit?server.port:25565}" placeholder="25565"></div><div class="form-group"><label class="checkbox-label"><input type="checkbox" id="f-autostart" ${isEdit&&server.auto_start?'checked':''}> Auto-start on boot</label></div>`;
  overlay.style.display='flex';overlay.dataset.edit=isEdit?server.id:'';
  $('#modal-form').onsubmit=async e=>{e.preventDefault();const eid=$('#modal-overlay').dataset.edit;const body2={name:$('#f-name').value,jar_file:$('#f-jar').value,java_args:$('#f-java').value||'-Xmx1G -Xms1G',java_path:$('#f-java-path').value,port:parseInt($('#f-port').value)||25565,auto_start:$('#f-autostart').checked};if(!body2.name||!body2.jar_file){showModal('Error','Name and jar required.');return;}try{const s=eid?await api('/servers/'+eid,{method:'PUT',body:JSON.stringify(body2)}):await api('/servers',{method:'POST',body:JSON.stringify(body2)});closeModal();await loadServers();selectServer(s.id);}catch(e){showModal('Error',esc(e.message));}};
}
$('#modal-cancel').addEventListener('click',closeModal);
$('#modal-overlay').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal();});
$('#manage-users-btn').addEventListener('click',showUserManagement);
function closeModal(){
  $('#modal-overlay').style.display='none';
  $('#modal-overlay').dataset.edit='';
  $('#modal-overlay').querySelector('.modal').classList.remove('wide');
  $('#modal-body').classList.remove('modal-body-scroll');
}

/* ── Init ── */
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

document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); hideCtx(); } });

const origShowTab = showTab;
showTab = function(name) {
  if (onlinePoll) { clearInterval(onlinePoll); onlinePoll = null; }
  if (name !== 'dashboard' && statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  origShowTab(name);
};

// Helper functions
function statusClass(s){return(s||'stopped').toLowerCase();}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function escAttr(s){return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtBytes(b){const u=['B','KB','MB','GB','TB'];let i=0,v=b;while(v>=1024&&i<u.length-1){v/=1024;i++}return v.toFixed(i>0?1:0)+' '+u[i];}
function fmtTime(t){if(!t)return'0m';const s=Math.floor(t/20);const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);return h>0?h+'h '+m+'m':m+'m';}
function fmtDate(s){if(!s)return'';const d=new Date(s);return d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
function showModal(title,msg,opts={}){return new Promise(resolve=>{const ex=$('.custom-prompt-overlay');if(ex)ex.remove();const ov=document.createElement('div');ov.className='custom-prompt-overlay';ov.innerHTML='<div class="custom-prompt"><h3>'+esc(title)+'</h3><p>'+msg+'</p><div class="custom-prompt-actions">'+(opts.cancel?'<button class="btn" data-value="cancel">'+esc(opts.cancel)+'</button>':'')+'<button class="btn btn-primary" data-value="ok">'+esc(opts.ok||'OK')+'</button></div></div>';document.body.appendChild(ov);ov.addEventListener('click',e=>{if(e.target===ov){ov.remove();resolve(false);}});ov.querySelectorAll('[data-value]').forEach(b=>{b.addEventListener('click',()=>{ov.remove();resolve(b.dataset.value==='ok');});});});}

/* ── Boot ── */
document.getElementById('login-form').addEventListener('submit', handleLogin);
initApp();
