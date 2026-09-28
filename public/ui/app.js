/**
 * WebDAV Cloud Drive — Web UI 前端逻辑
 *
 * 功能：
 *   - 文件浏览（WebDAV PROPFIND）/ 上传（PUT）/ 下载 / 删除（DELETE）
 *   - 重命名（MOVE）/ 新建文件夹（MKCOL）
 *   - 驱动配置概览（/api/settings）
 *   - 请求日志查看（/api/logs，D1 持久化）
 *
 * 鉴权：HTTP Basic Auth，凭据保存在 sessionStorage，随每次请求携带。
 */
'use strict';

/* ============================ 全局状态 ============================ */
let currentPath = '/';
let creds = null; // { user, pass }
let entries = [];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ============================ 工具函数 ============================ */
function authHeader() {
  if (!creds) return {};
  return { Authorization: 'Basic ' + btoa(`${creds.user}:${creds.pass}`) };
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...authHeader(), ...(opts.headers || {}) },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (_) {}
    const err = new Error(`${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function fmtSize(n) {
  if (n === null || n === undefined) return '';
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
}

function joinPath(dir, name) {
  return dir === '/' ? '/' + name : dir + '/' + name;
}

function encodePath(path) {
  // 保留 / 与合法字符，仅编码文件名中的特殊字符
  return path.split('/').map(encodeURIComponent).join('/');
}

function showError(msg) {
  const box = $('#fileError');
  if (box) {
    box.textContent = msg;
    box.hidden = false;
  } else {
    console.error(msg);
  }
}

function clearError() {
  const box = $('#fileError');
  if (box) box.hidden = true;
}

/* ============================ 登录 ============================ */
function openLogin() {
  $('#loginOverlay').classList.remove('hidden');
  $('#loginUser').focus();
}

function closeLogin() {
  $('#loginOverlay').classList.add('hidden');
}

function updateUserbox() {
  if (creds) {
    $('#userName').textContent = creds.user;
    $('#btnLogout').style.display = '';
  } else {
    $('#userName').textContent = '未登录';
    $('#btnLogout').style.display = 'none';
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = $('#loginUser').value.trim();
  const pass = $('#loginPass').value;
  if (!user || !pass) return;
  creds = { user, pass };
  try {
    // 用 /api/settings 验证凭据
    await fetchJson('/api/settings');
    sessionStorage.setItem('wcd_user', user);
    sessionStorage.setItem('wcd_pass', pass);
    closeLogin();
    updateUserbox();
    clearError();
    loadDir(currentPath);
  } catch (err) {
    if (err.status === 401) {
      $('#loginError').textContent = '用户名或密码错误';
      creds = null;
    } else {
      $('#loginError').textContent = '无法连接服务：' + err.message;
      creds = null;
    }
  }
});

$('#btnLogout').addEventListener('click', () => {
  creds = null;
  sessionStorage.removeItem('wcd_user');
  sessionStorage.removeItem('wcd_pass');
  updateUserbox();
  $('#fileList').innerHTML = '';
  $('#fileEmpty').hidden = false;
  $('#fileEmpty').textContent = '请登录后浏览';
  openLogin();
});

/* ============================ Tab 切换 ============================ */
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $$('.view').forEach((v) => v.classList.remove('active'));
    $('#view-' + tab).classList.add('active');
    if (tab === 'files') loadDir(currentPath);
    if (tab === 'settings') loadSettings();
    if (tab === 'logs') loadLogs();
  });
});

/* ============================ 文件浏览 ============================ */
/** 多存储虚拟分区徽标（根目录展示各驱动分区） */
const DRIVER_BADGES = {
  s3: { label: 'S3', icon: '🗄️' },
  gdrive: { label: 'Google Drive', icon: '☁️' },
  dropbox: { label: 'Dropbox', icon: '📦' },
  telegram: { label: 'Telegram', icon: '✈️' },
  baidu: { label: '百度网盘', icon: '📀' },
  yun139: { label: '中国移动云盘', icon: '📶' },
  xunlei: { label: '迅雷云盘', icon: '⚡' },
};

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <d:getetag/>
    <d:getcontenttype/>
  </d:prop>
</d:propfind>`;

async function loadDir(path) {
  if (!creds) {
    $('#fileList').innerHTML = '';
    $('#fileEmpty').hidden = false;
    $('#fileEmpty').textContent = '请先登录';
    return;
  }
  clearError();
  // 进入/切换目录时立即刷新面包屑，保证任何状态下（加载中/空/失败）都常驻显示当前服务标识
  renderBreadcrumb();
  const tbody = $('#fileList');
  tbody.innerHTML = '<tr><td colspan="4" class="empty">加载中…</td></tr>';
  $('#fileEmpty').hidden = true;

  try {
    const url = encodePath(path);
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        ...authHeader(),
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
    });
    if (!res.ok) {
      if (res.status === 401) {
        creds = null;
        updateUserbox();
        openLogin();
        return;
      }
      throw new Error(`${res.status} ${res.statusText}`);
    }
    const xml = await res.text();
    const parsed = parseMultistatus(xml);
    renderDir(parsed);
  } catch (err) {
    tbody.innerHTML = '';
    $('#fileEmpty').hidden = false;
    $('#fileEmpty').textContent = '';
    showError('加载目录失败：' + err.message);
  }
}

/** 解析 multistatus XML 为条目列表 */
function parseMultistatus(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('XML 解析失败');
  }
  const out = [];
  const responses = doc.getElementsByTagNameNS('DAV:', 'response');
  for (const resp of responses) {
    const hrefEl = resp.getElementsByTagNameNS('DAV:', 'href')[0];
    if (!hrefEl) continue;
    const href = hrefEl.textContent || '/';
    const prop = resp.getElementsByTagNameNS('DAV:', 'prop')[0];
    if (!prop) continue;
    const display = prop.getElementsByTagNameNS('DAV:', 'displayname')[0];
    const len = prop.getElementsByTagNameNS('DAV:', 'getcontentlength')[0];
    const mod = prop.getElementsByTagNameNS('DAV:', 'getlastmodified')[0];
    const rt = prop.getElementsByTagNameNS('DAV:', 'resourcetype')[0];
    const isDir = !!(rt && rt.getElementsByTagNameNS('DAV:', 'collection').length > 0);
    const name = display && display.textContent ? display.textContent : decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
    out.push({
      href,
      name,
      isDir,
      size: len ? parseInt(len.textContent, 10) : null,
      mtime: mod ? Date.parse(mod.textContent) : null,
    });
  }
  // 排除当前目录自身条目
  return out.filter((e) => e.href.replace(/\/$/, '') !== currentPath.replace(/\/$/, ''));
}

function renderDir(items) {
  const tbody = $('#fileList');
  tbody.innerHTML = '';
  if (!items.length) {
    $('#fileEmpty').hidden = false;
    $('#fileEmpty').textContent = '目录为空';
    return;
  }
  $('#fileEmpty').hidden = true;

  const sorted = items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  for (const it of sorted) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const nameDiv = document.createElement('div');
    const isRootPart = currentPath === '/' || currentPath === '';
    const isDriver = isRootPart && it.isDir && DRIVER_BADGES[it.name];
    nameDiv.className = 'fname ' + (it.isDir ? 'folder' : 'file') + (isDriver ? ' driver' : '');
    nameDiv.innerHTML =
      `<span class="icon">${isDriver ? DRIVER_BADGES[it.name].icon : it.isDir ? '📁' : '📄'}</span>` +
      (isDriver ? `<span class="driver-badge" style="margin-left:6px;">${DRIVER_BADGES[it.name].label}</span>` : '') +
      `<span></span>`;
    nameDiv.querySelector('span:last-child').textContent = it.name;
    if (it.isDir) {
      nameDiv.title = '打开文件夹';
      nameDiv.addEventListener('click', () => {
        currentPath = joinPath(currentPath, it.name);
        loadDir(currentPath);
      });
    }
    tdName.appendChild(nameDiv);

    const tdSize = document.createElement('td');
    tdSize.className = 'col-size';
    tdSize.textContent = it.isDir ? '' : fmtSize(it.size);

    const tdTime = document.createElement('td');
    tdTime.className = 'col-time';
    tdTime.textContent = fmtTime(it.mtime);

    const tdOps = document.createElement('td');
    tdOps.className = 'col-ops ops';
    if (!it.isDir) {
      const btnDl = mkBtn('下载', 'btn-sm', async () => downloadFile(joinPath(currentPath, it.name), it.size));
      tdOps.appendChild(btnDl);
      const btnPv = mkBtn('预览', 'btn-sm', async () => previewFile(joinPath(currentPath, it.name)));
      tdOps.appendChild(btnPv);
    }
    const btnRn = mkBtn('重命名', 'btn-sm', async () => renameEntry(it));
    const btnDel = mkBtn('删除', 'btn-sm btn-danger', async () => deleteEntry(it));
    tdOps.appendChild(btnRn);
    tdOps.appendChild(btnDel);

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdTime);
    tr.appendChild(tdOps);
    tbody.appendChild(tr);
  }
}

function mkBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderBreadcrumb() {
  const bc = $('#breadcrumb');
  bc.innerHTML = '';
  const parts = currentPath === '/' ? [] : currentPath.split('/').filter(Boolean);

  const root = document.createElement('a');
  root.textContent = '根目录';
  root.addEventListener('click', () => {
    currentPath = '/';
    loadDir(currentPath);
  });
  bc.appendChild(root);

  // 构造面包屑段：首段为服务分区，渲染「图标 + 可读服务名」徽标
  const makeSeg = (p, i, clickable) => {
    const isDriverSeg = i === 0; // 路径首段 = 服务分区
    const meta = DRIVER_BADGES[p];
    const label = meta ? meta.label : p;
    const icon = meta ? meta.icon : '🗂️';
    const el = document.createElement(clickable ? 'a' : 'span');
    el.title = p;
    if (isDriverSeg) {
      el.innerHTML = `<span class="driver-badge"><span class="icon">${icon}</span><span class="label">${escapeHtml(label)}</span></span>`;
    } else {
      el.textContent = label;
    }
    return el;
  };

  let acc = '';
  parts.forEach((p, i) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = ' / ';
    bc.appendChild(sep);
    acc = joinPath(acc, p);
    const isLast = i === parts.length - 1;
    const seg = makeSeg(p, i, !isLast);
    if (!isLast) {
      seg.addEventListener('click', () => {
        currentPath = acc + '/';
        loadDir(currentPath);
      });
    }
    bc.appendChild(seg);
  });

  // 面包屑变化时同步"上级目录"按钮显隐
  updateUpButton();
}

/* ============================ 上级目录导航 ============================ */
/** 计算上一级路径（多驱动虚拟分区边界安全：/gdrive/ → 根目录 /，不会跳其它驱动） */
function parentPath(path) {
  const parts = (path || '/').split('/').filter(Boolean);
  if (!parts.length) return '/';
  parts.pop();
  return parts.length ? '/' + parts.join('/') + '/' : '/';
}

/** 返回上级目录（已在根目录时不动作） */
function goUp() {
  if (currentPath === '/' || currentPath === '') return;
  currentPath = parentPath(currentPath);
  loadDir(currentPath);
}

/** 同步"上级目录"按钮显隐：不在根目录时显示，空目录/加载失败等状态同样可用 */
function updateUpButton() {
  const btn = $('#btnUp');
  if (!btn) return;
  btn.hidden = currentPath === '/' || currentPath === '';
}

$('#btnUp').addEventListener('click', goUp);
// 刷新按钮（index.html 已有，补上事件绑定）
$('#btnRefresh').addEventListener('click', () => loadDir(currentPath));

// 键盘快捷返回（可选）：Alt+↑ / Backspace，输入框内不拦截
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if ((e.altKey && e.key === 'ArrowUp') || e.key === 'Backspace') {
    e.preventDefault();
    goUp();
  }
});

/* ============================ 上传 ============================ */
$('#fileInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const box = $('#uploadProgress');
  box.hidden = false;
  box.innerHTML = '';

  for (const file of files) {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<span class="name">${escapeHtml(file.name)}</span><progress max="100" value="0"></progress><span class="state">上传中…</span>`;
    box.appendChild(item);

    const prog = item.querySelector('progress');
    const state = item.querySelector('.state');

    try {
      const target = encodePath(joinPath(currentPath, file.name));
      // 使用 XMLHttpRequest 以获得上传进度
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', target);
        for (const [k, v] of Object.entries(authHeader())) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) prog.value = Math.round((ev.loaded / ev.total) * 100);
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('HTTP ' + xhr.status)));
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.send(file);
      });
      prog.value = 100;
      state.textContent = '完成';
      state.classList.add('ok');
    } catch (err) {
      state.textContent = '失败：' + err.message;
      state.classList.add('fail');
    }
  }

  e.target.value = '';
  setTimeout(() => {
    box.hidden = true;
    box.innerHTML = '';
    loadDir(currentPath);
  }, 1500);
});

/* ============================ 新建文件夹 ============================ */
$('#btnNewFolder').addEventListener('click', async () => {
  const name = prompt('请输入新文件夹名称：');
  if (!name) return;
  const target = encodePath(joinPath(currentPath, name));
  try {
    const res = await fetch(target, {
      method: 'MKCOL',
      headers: { ...authHeader() },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    loadDir(currentPath);
  } catch (err) {
    showError('新建文件夹失败：' + err.message);
  }
});

/* ============================ 重命名 ============================ */
async function renameEntry(entry) {
  const oldPath = joinPath(currentPath, entry.name);
  const newName = prompt('重命名为：', entry.name);
  if (!newName || newName === entry.name) return;
  const newPath = joinPath(currentPath, newName);
  const destUrl = new URL(encodePath(newPath), location.origin).href;
  try {
    const res = await fetch(encodePath(oldPath), {
      method: 'MOVE',
      headers: { ...authHeader(), Destination: destUrl, Overwrite: 'F' },
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    loadDir(currentPath);
  } catch (err) {
    showError('重命名失败：' + err.message);
  }
}

/* ============================ 删除 ============================ */
async function deleteEntry(entry) {
  const full = joinPath(currentPath, entry.name);
  const msg = entry.isDir ? `确定删除文件夹「${entry.name}」及其全部内容？` : `确定删除文件「${entry.name}」？`;
  if (!confirm(msg)) return;
  try {
    const res = await fetch(encodePath(full), {
      method: 'DELETE',
      headers: { ...authHeader() },
    });
    if (!res.ok && res.status !== 204 && res.status !== 200) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    loadDir(currentPath);
  } catch (err) {
    showError('删除失败：' + err.message);
  }
}

/* ============================ 下载 ============================ */
const CHUNK_THRESHOLD = 50 * 1024 * 1024; // >50MB 启用分片
const CHUNK_CONCURRENCY = 4; // 并发 4-6
const CHUNK_MAX = 80 * 1024 * 1024; // 单片 clamp 80MB（Workers 100MB 响应体上限留余量）

async function downloadFile(path, size) {
  if (size && size > CHUNK_THRESHOLD) {
    await downloadChunked(path, size);
    return;
  }
  await downloadDirect(path);
}

/** 小文件直接下载（单请求） */
async function downloadDirect(path) {
  try {
    const res = await fetch(`/api/download?path=${encodeURIComponent(path)}`, {
      headers: { ...authHeader() },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const blob = await res.blob();
    saveBlob(blob, path.split('/').filter(Boolean).pop() || 'download');
  } catch (err) {
    showError('下载失败：' + err.message);
  }
}

/** 大文件分片并发下载（Range 请求，拼接 Blob 保存） */
async function downloadChunked(path, size) {
  let chunk = Math.ceil(size / CHUNK_CONCURRENCY);
  if (chunk > CHUNK_MAX) {
    const n = Math.ceil(size / CHUNK_MAX);
    chunk = Math.ceil(size / n);
  }
  const ranges = [];
  for (let start = 0; start < size; start += chunk) {
    const end = Math.min(size - 1, start + chunk - 1);
    ranges.push([start, end]);
  }

  const prog = showDownloadProgress();
  try {
    const parts = new Array(ranges.length);
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= ranges.length) return;
        const [s, e] = ranges[i];
        const res = await fetch(`/api/download?path=${encodeURIComponent(path)}`, {
          headers: { ...authHeader(), Range: `bytes=${s}-${e}` },
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        parts[i] = await res.blob();
        done += e - s + 1;
        prog.update(done, size);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, ranges.length) }, worker));
    saveBlob(new Blob(parts), path.split('/').filter(Boolean).pop() || 'download');
  } catch (err) {
    showError('分片下载失败：' + err.message);
  } finally {
    prog.remove();
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 分片下载整体进度条 */
function showDownloadProgress() {
  const box = document.createElement('div');
  box.className = 'download-progress';
  box.style.cssText =
    'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10000;background:#fff;color:#222;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.25);padding:10px 16px;display:flex;align-items:center;gap:10px;font-size:13px;';
  const label = document.createElement('span');
  label.textContent = '分片下载';
  const bar = document.createElement('progress');
  bar.max = 100;
  bar.value = 0;
  const pct = document.createElement('span');
  pct.textContent = '0%';
  box.append(label, bar, pct);
  document.body.appendChild(box);
  return {
    update(done, total) {
      const v = Math.round((done / total) * 100);
      bar.value = v;
      pct.textContent = v + '%';
    },
    remove() {
      box.remove();
    },
  };
}

/* ============================ 在线预览 ============================ */
const PREVIEW_TEXT_EXTS = new Set(['md', 'txt', 'json', 'js', 'py', 'html', 'htm', 'xml', 'csv', 'log', 'ini', 'yaml', 'yml', 'ts', 'java', 'c', 'cpp', 'go', 'rs']);
const PREVIEW_IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
const PREVIEW_PDF_EXTS = new Set(['pdf']);
const PREVIEW_VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']);
const PREVIEW_AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac']);
const PREVIEW_TEXT_MAX = 500 * 1024; // 文本预览截断阈值（与后端 /api/preview 一致）

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** 预览 URL（/api/preview 走 auth query 以兼容 video/audio/iframe/img 标签） */
function previewUrl(path) {
  const auth = creds ? btoa(`${creds.user}:${creds.pass}`) : '';
  return `/api/preview?path=${encodeURIComponent(path)}&auth=${encodeURIComponent(auth)}`;
}

/** 在线预览：文本/图片/PDF/视频/音频在模态框展示，其余提示下载 */
async function previewFile(path) {
  const name = path.split('/').filter(Boolean).pop() || 'download';
  const ext = extOf(name);

  let kind;
  if (PREVIEW_TEXT_EXTS.has(ext)) kind = 'text';
  else if (PREVIEW_IMG_EXTS.has(ext)) kind = 'image';
  else if (PREVIEW_PDF_EXTS.has(ext)) kind = 'pdf';
  else if (PREVIEW_VIDEO_EXTS.has(ext)) kind = 'video';
  else if (PREVIEW_AUDIO_EXTS.has(ext)) kind = 'audio';
  else kind = 'unknown';

  // 非文本类直接以原生标签加载 /api/preview（后端支持 Range，浏览器自动分片流式加载）
  const url = previewUrl(path);

  const overlay = document.createElement('div');
  overlay.className = 'preview-overlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div class="preview-box" style="background:#fff;color:#222;border-radius:8px;max-width:92vw;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.3);">
      <div class="preview-head" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-bottom:1px solid #eee;">
        <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</strong>
        <button class="btn btn-sm preview-close">关闭</button>
      </div>
      <div class="preview-body" style="padding:12px 16px;overflow:auto;min-width:340px;min-height:120px;"></div>
    </div>`;
  document.body.appendChild(overlay);

  const closePreview = () => overlay.remove();
  overlay.querySelector('.preview-close').addEventListener('click', closePreview);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePreview();
  });

  const bodyEl = overlay.querySelector('.preview-body');
  if (kind === 'text') {
    bodyEl.innerHTML = '<p style="margin:0;color:#666;">加载中…</p>';
    try {
      const res = await fetch(`/api/preview?path=${encodeURIComponent(path)}`, {
        headers: { ...authHeader() },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      let txt = await res.text();
      let truncated = false;
      if (txt.length > PREVIEW_TEXT_MAX) {
        txt = txt.slice(0, PREVIEW_TEXT_MAX);
        truncated = true;
      }
      bodyEl.innerHTML = '';
      if (truncated) {
        const tip = document.createElement('p');
        tip.style.cssText = 'margin:0 0 8px;color:#b8860b;font-size:12px;';
        tip.textContent = '文件过大，仅显示前 500KB 内容。';
        bodyEl.appendChild(tip);
      }
      const pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-all;font-family:Consolas,Menlo,monospace;font-size:13px;line-height:1.5;max-width:84vw;max-height:76vh;';
      pre.textContent = txt;
      bodyEl.appendChild(pre);
    } catch (err) {
      bodyEl.innerHTML = `<p style="margin:0;color:#c00;">预览失败：${escapeHtml(err.message)}</p>`;
    }
  } else if (kind === 'image') {
    const img = document.createElement('img');
    img.style.cssText = 'max-width:84vw;max-height:76vh;object-fit:contain;';
    img.src = url;
    img.alt = name;
    bodyEl.appendChild(img);
  } else if (kind === 'pdf') {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:84vw;height:76vh;border:none;';
    iframe.src = url;
    bodyEl.appendChild(iframe);
  } else if (kind === 'video') {
    const video = document.createElement('video');
    video.controls = true;
    video.style.cssText = 'max-width:84vw;max-height:76vh;background:#000;';
    video.src = url;
    bodyEl.appendChild(video);
  } else if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.style.cssText = 'width:72vw;max-width:720px;';
    audio.src = url;
    bodyEl.appendChild(audio);
  } else {
    bodyEl.innerHTML = '<p style="margin:0;color:#666;">该类型不支持在线预览，请下载查看。</p>';
  }
}

/* ============================ 存储配置（自助配置存储服务） ============================ */
const DRIVER_NAMES = {
  s3: 'S3 / R2',
  telegram: 'Telegram',
  baidu: '百度网盘',
  gdrive: 'Google Drive',
  dropbox: 'Dropbox',
  yun139: '中国移动云盘',
  xunlei: '迅雷云盘',
};

const DRIVER_DESCS = {
  s3: 'R2 或任意 S3 兼容存储；填写 accessKeyId / secretAccessKey 等字段即可启用。',
  telegram: 'Telegram Bot 存储；需要 botToken 与 chatId。',
  baidu: '百度网盘；需要 accessToken 与 appId。',
  gdrive: 'Google Drive；需要 clientId / clientSecret / refreshToken。',
  dropbox: 'Dropbox；accessToken 与 refreshToken + appKey + appSecret 二选一。',
  yun139: '中国移动云盘（139 / 和彩云）；authorization = base64("pc:<账号>:<token|...|exp>")。',
  xunlei: '迅雷云盘；必填仅 refreshToken，可用「自动登录获取凭据」一键获取并回填。',
};

async function loadSettings() {
  const box = $('#settingsContent');
  box.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const [cfg, s] = await Promise.all([fetchJson('/api/config'), fetchJson('/api/settings')]);
    renderSettings(box, s, cfg);
  } catch (err) {
    box.innerHTML = `<p class="empty">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

/** 单驱动表单卡片：按 /api/config 返回的字段元数据动态渲染（不回显明文） */
function renderDriverFormCard(key, meta) {
  const card = document.createElement('div');
  card.className = 'card config-card';

  const head = document.createElement('div');
  head.className = 'config-head';
  head.innerHTML = `
    <h3>${escapeHtml(DRIVER_NAMES[key] || key.toUpperCase())}</h3>
    <div class="state">
      <span class="badge ${meta.configured ? 'ok' : 'no'}">${meta.configured ? '已配置' : '未配置'}</span>
      <span class="badge src-${meta.source}">${meta.source === 'kv' ? '来源：页面保存(KV)' : meta.source === 'env' ? '来源：环境变量(Secret)' : '来源：无'}</span>
    </div>`;
  card.appendChild(head);

  const desc = document.createElement('p');
  desc.className = 'config-desc';
  desc.textContent = DRIVER_DESCS[key] || '';
  card.appendChild(desc);

  const form = document.createElement('form');
  form.className = 'config-form';

  for (const f of meta.fields || []) {
    const row = document.createElement('div');
    row.className = 'field-row';

    const label = document.createElement('label');
    label.textContent = f.name;
    if (f.required) label.classList.add('required');
    if (f.secret) label.classList.add('secret');
    row.appendChild(label);

    const setBadge = document.createElement('span');
    setBadge.className = 'badge set-badge ' + (f.set ? 'ok' : 'no');
    setBadge.textContent = f.set
      ? f.source === 'kv'
        ? '已配置（页面）'
        : '已配置（环境变量）'
      : '未配置';
    row.appendChild(setBadge);

    let input;
    if (f.type === 'boolean') {
      input = document.createElement('select');
      const o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = '（保持不变）';
      const o1 = document.createElement('option');
      o1.value = 'true';
      o1.textContent = 'true';
      const o2 = document.createElement('option');
      o2.value = 'false';
      o2.textContent = 'false';
      input.append(o0, o1, o2);
      if (f.default === true) o1.selected = true;
      else if (f.default === false) o2.selected = true;
    } else {
      input = document.createElement('input');
      input.type = f.secret ? 'password' : 'text';
      input.autocomplete = f.secret ? 'new-password' : 'off';
      input.placeholder = f.set ? '已配置，留空保持不变' : f.hint || '';
    }
    input.dataset.field = f.name;
    row.appendChild(input);

    if (f.hint) {
      const hint = document.createElement('span');
      hint.className = 'field-hint';
      hint.textContent = f.hint;
      row.appendChild(hint);
    }

    form.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'config-actions';

  const btnSave = document.createElement('button');
  btnSave.type = 'submit';
  btnSave.className = 'btn btn-primary';
  btnSave.textContent = '保存配置';
  actions.appendChild(btnSave);

  // 自动登录获取凭据：xunlei 支持（弹窗表单 → /api/auth/<driver>/login → 回填 refreshToken）
  let btnAuth = null;
  if (key === 'xunlei') {
    btnAuth = document.createElement('button');
    btnAuth.type = 'button';
    btnAuth.className = 'btn';
    btnAuth.textContent = '自动登录获取凭据';
    btnAuth.title = '使用迅雷账号密码自动登录，获取 refreshToken 并回填表单；回填后请点击「保存配置」生效';
    actions.appendChild(btnAuth);
  }

  const btnClear = document.createElement('button');
  btnClear.type = 'button';
  btnClear.className = 'btn btn-danger';
  btnClear.textContent = '清除页面配置（回退环境变量）';
  btnClear.disabled = meta.source !== 'kv';
  btnClear.title =
    meta.source === 'kv'
      ? '删除该驱动的页面(KV)配置，回退到环境变量'
      : '当前无页面配置可清除';
  actions.appendChild(btnClear);

  const msg = document.createElement('span');
  msg.className = 'config-msg';
  actions.appendChild(msg);

  form.appendChild(actions);
  card.appendChild(form);

  const flashDirty = () => {
    window.__configDirty = true;
  };

  // 自动登录弹窗
  if (btnAuth) {
    btnAuth.addEventListener('click', () => openAuthModal(key, form, msg, flashDirty));
  }

  // 保存：收集非空字段，PUT /api/config?type=<key>
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const f of meta.fields || []) {
      const el = form.querySelector(`[data-field="${f.name}"]`);
      if (!el) continue;
      const v = el.value;
      if (v === '') continue;
      body[f.name] = f.type === 'boolean' ? v === 'true' : String(v);
    }
    if (!Object.keys(body).length) {
      msg.textContent = '请至少填写一个字段';
      msg.className = 'config-msg err';
      return;
    }
    btnSave.disabled = true;
    msg.textContent = '保存中…';
    msg.className = 'config-msg';
    try {
      await fetchJson(`/api/config?type=${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      flashDirty();
      msg.textContent = '已保存，正在刷新…';
      await loadSettings();
    } catch (err) {
      msg.textContent = '保存失败：' + err.message;
      msg.className = 'config-msg err';
      btnSave.disabled = false;
    }
  });

  // 清除：DELETE /api/config?type=<key>
  btnClear.addEventListener('click', async () => {
    if (!confirm(`确定清除 ${DRIVER_NAMES[key] || key} 的页面配置？将回退到环境变量配置。`)) return;
    btnClear.disabled = true;
    msg.textContent = '清除中…';
    msg.className = 'config-msg';
    try {
      await fetchJson(`/api/config?type=${encodeURIComponent(key)}`, { method: 'DELETE' });
      flashDirty();
      msg.textContent = '已清除，正在刷新…';
      await loadSettings();
    } catch (err) {
      msg.textContent = '清除失败：' + err.message;
      msg.className = 'config-msg err';
      btnClear.disabled = false;
    }
  });

  return card;
}

/**
 * 自动登录获取凭据弹窗：账号/密码（+ 可选安全密码）→ POST /api/auth/<driver>/login
 * 成功后回填表单对应字段（refreshToken 等）并高亮提示「已获取，请保存」。
 * 密码仅经请求体传递，不落库、不回显。
 */
function openAuthModal(driver, form, msg, flashDirty) {
  const existing = document.getElementById('authModalOverlay');
  if (existing) existing.remove();

  const names = { xunlei: '迅雷云盘' };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'authModalOverlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>${escapeHtml(names[driver] || driver)} 自动登录</h2>
      <p class="hint">使用账号密码自动登录并获取凭据；密码仅本次请求使用，不保存、不回显。</p>
      <form id="authModalForm">
        <label>账号<input type="text" id="authUser" autocomplete="username" required /></label>
        <label>密码<input type="password" id="authPass" autocomplete="current-password" required /></label>
        <label>安全密码（可选）<input type="password" id="authSafePass" autocomplete="off" placeholder="超级保险箱密码，可留空" /></label>
        <p class="config-msg" id="authModalMsg"></p>
        <div class="config-actions">
          <button type="submit" class="btn btn-primary" id="authModalOk">登录并获取</button>
          <button type="button" class="btn" id="authModalCancel">取消</button>
        </div>
      </form>
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);

  const f = overlay.querySelector('#authModalForm');
  const m = overlay.querySelector('#authModalMsg');
  const ok = overlay.querySelector('#authModalOk');

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = overlay.querySelector('#authUser').value.trim();
    const password = overlay.querySelector('#authPass').value;
    const safePassword = overlay.querySelector('#authSafePass').value;
    if (!username || !password) {
      m.textContent = '请输入账号与密码';
      m.className = 'config-msg err';
      return;
    }
    ok.disabled = true;
    m.textContent = '登录中…';
    m.className = 'config-msg';
    try {
      const data = await fetchJson(`/api/auth/${encodeURIComponent(driver)}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, safePassword }),
      });
      if (!data.ok) throw new Error(data.error || '登录失败');
      // 回填可回填字段（refreshToken 等）
      let filled = 0;
      for (const [name, value] of Object.entries(data.fields || {})) {
        const el = form.querySelector(`[data-field="${name}"]`);
        if (el) {
          el.value = String(value);
          filled++;
        }
      }
      overlay.remove();
      const rt = form.querySelector('[data-field="refreshToken"]');
      if (filled > 0) {
        if (rt) {
          rt.classList.add('auth-filled');
          setTimeout(() => rt.classList.remove('auth-filled'), 4000);
        }
        msg.textContent = data.message || '已获取，请保存';
        msg.className = 'config-msg ok-flash';
        setTimeout(() => { msg.className = 'config-msg'; }, 5000);
        flashDirty();
      } else {
        msg.textContent = '登录成功，但表单中没有可回填字段，请手动填写';
        msg.className = 'config-msg err';
      }
    } catch (err) {
      let text = err.message || '登录失败';
      // fetchJson 失败信息形如 "409 {...json...}"，尝试提取服务端 error/kind
      const m2 = /(\{.*\})/.exec(text);
      if (m2) {
        try {
          const j = JSON.parse(m2[1]);
          text = j.error || text;
          if (j.kind === 'verify') text = '需要人工处理验证：' + text;
        } catch (_) {}
      }
      m.textContent = text;
      m.className = 'config-msg err';
      ok.disabled = false;
    }
  });

  overlay.querySelector('#authModalCancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#authUser').focus();
}

function renderSettings(box, s, cfg) {
  box.innerHTML = '';

  // ---- 概览卡（来自 /api/settings，仅摘要，不含明文） ----
  const cards = [];
  cards.push({
    title: '当前存储后端',
    state: s.storageType,
    ok: true,
    desc: '由环境变量 STORAGE_TYPE 决定；已装配驱动可在根目录虚拟分区中访问。',
  });
  const mounted = s.mountedDrivers || { list: [], count: 0, singleDriverCompat: null, note: '' };
  cards.push({
    title: '已挂载驱动分区',
    state: mounted.count > 0 ? `${mounted.count} 个：${(mounted.list || []).join(' / ')}` : '无',
    ok: mounted.count > 0,
    desc:
      (mounted.singleDriverCompat ? `单驱动兼容：根路径可直接访问 ${mounted.singleDriverCompat}。` : '多驱动模式：根路径经虚拟分区进入。') +
      (mounted.note || ''),
  });
  cards.push({
    title: '登录认证',
    state: s.auth.configured ? '已配置' : '未配置',
    ok: s.auth.configured,
    desc: 'HTTP Basic Auth，凭据为 DAV_USER / DAV_PASS（Secret）。',
  });
  cards.push({
    title: '请求日志（D1）',
    state: s.logging.enabled ? '已启用' : '未启用',
    ok: s.logging.enabled,
    desc: `表 ${s.logging.table}，记录方法 / 路径 / 状态码 / 耗时 / 存储后端。`,
  });

  for (const c of cards) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <h3><span class="logo">▍</span>${escapeHtml(c.title)}</h3>
      <div class="state"><span class="badge ${c.ok ? 'ok' : 'no'}">${c.ok ? '已配置 / 启用' : '未配置 / 未启用'}</span></div>
      <div class="desc">${escapeHtml(c.desc)}</div>
    `;
    box.appendChild(div);
  }

  // ---- 自助配置表单（来自 /api/config 脱敏元数据，动态渲染） ----
  const tip = document.createElement('p');
  tip.className = 'config-tip';
  tip.textContent =
    '在此填写存储服务配置并保存，立即生效，无需改代码或重新部署。敏感字段以密文存储，页面永不回显明文；已配置字段留空则保持不变。';
  box.appendChild(tip);

  const drivers = (cfg && cfg.drivers) || {};
  for (const key of Object.keys(drivers)) {
    box.appendChild(renderDriverFormCard(key, drivers[key]));
  }

  // 保存/清除后刷新文件视图（在根目录时立即重新加载分区）
  if (window.__configDirty) {
    window.__configDirty = false;
    if (currentPath === '/') loadDir('/');
  }
}

/* ============================ 请求日志 ============================ */
$('#btnLogsRefresh').addEventListener('click', loadLogs);
$('#logMethod').addEventListener('change', loadLogs);
$('#logStatus').addEventListener('change', loadLogs);

async function loadLogs() {
  const box = $('#logsContent');
  box.innerHTML = '<p class="empty">加载中…</p>';
  const method = $('#logMethod').value;
  const status = $('#logStatus').value;
  const params = new URLSearchParams({ limit: '200' });
  if (method) params.set('method', method);
  if (status) params.set('status', status);

  try {
    const data = await fetchJson(`/api/logs?${params.toString()}`);
    if (!data.enabled) {
      box.innerHTML = '<p class="empty">日志未启用：未绑定 D1 或 LOG_ENABLED=false。</p>';
      return;
    }
    renderLogs(box, data);
  } catch (err) {
    box.innerHTML = `<p class="empty">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

function renderLogs(box, data) {
  const entries = data.entries || [];
  const summary = document.createElement('p');
  summary.className = 'logs-summary';
  summary.textContent = `共 ${data.total} 条记录，显示最近 ${entries.length} 条。`;

  const table = document.createElement('table');
  table.className = 'logs-table';
  const head = document.createElement('thead');
  head.innerHTML = '<tr><th>#</th><th>时间</th><th>方法</th><th>路径</th><th>状态</th><th>耗时(ms)</th><th>存储</th></tr>';
  table.appendChild(head);

  const body = document.createElement('tbody');
  for (const e of entries) {
    const tr = document.createElement('tr');
    const cls = e.status >= 500 ? 'status-5xx' : e.status >= 400 ? 'status-4xx' : 'status-2xx';
    tr.innerHTML = `
      <td>${e.id}</td>
      <td>${escapeHtml(fmtTime(e.ts))}</td>
      <td><code>${escapeHtml(e.method)}</code></td>
      <td>${escapeHtml(e.path)}</td>
      <td class="${cls}">${e.status}</td>
      <td>${e.duration_ms}</td>
      <td>${escapeHtml(e.storage || '')}</td>
    `;
    body.appendChild(tr);
  }
  table.appendChild(body);
  box.innerHTML = '';
  box.appendChild(summary);
  box.appendChild(table);
}

/* ============================ 工具 ============================ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

/* ============================ 初始化 ============================ */
(function init() {
  const u = sessionStorage.getItem('wcd_user');
  const p = sessionStorage.getItem('wcd_pass');
  if (u && p) {
    creds = { user: u, pass: p };
    updateUserbox();
    closeLogin();
    loadDir('/');
  } else {
    updateUserbox();
    openLogin();
  }
})();
