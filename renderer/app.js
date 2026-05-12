const logEl = document.getElementById('log');
const controlUrlEl = document.getElementById('control-url');
const urlHintEl = document.getElementById('url-hint');
const roomEl = document.getElementById('room-id');
const secretEl = document.getElementById('secret');
const modal = document.getElementById('modal-settings');
const winTunnelBlock = document.getElementById('win-tunnel-block');
const macNote = document.getElementById('mac-tunnel-note');
const setPythonHint = document.getElementById('set-python-hint');
const btnCfstOptimize = document.getElementById('btn-cfst-optimize');
const btnCfstRemove = document.getElementById('btn-cfst-remove');
const cfstHintEl = document.getElementById('cfst-hint');

function updateCfstButtons(s) {
  const url = (s.displayControlUrl || '').trim();
  const hostOk =
    url.startsWith('http') &&
    url.includes('trycloudflare.com') &&
    !url.includes('请稍候') &&
    !url.includes('点「开始协助」');
  btnCfstOptimize.disabled = !s.hasCfstBundle || !hostOk;
  btnCfstRemove.disabled = s.platform !== 'win32' && s.platform !== 'darwin';
  cfstHintEl.textContent = s.hasCfstBundle
    ? '国内网络打不开 trycloudflare 时可试用：测速后把当前临时域名指向较快节点（需管理员同意）。控制端电脑若也连不上，需同样写 hosts 或用本软件执行一次。'
    : '未打包 Cloudflare 测速工具：请在项目根目录执行 npm run prepare-bundle 后重装/重打包。';
}

function appendLog(text, level) {
  const line = document.createElement('div');
  line.className = `line ${level || ''}`;
  line.textContent = text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function applyUrlDisplay(s) {
  const url = s.displayControlUrl || s.controlUrl || '—';
  controlUrlEl.textContent = url;
  if (s.displayControlUrlTemporary) {
    urlHintEl.textContent = '当前为临时网址，每次开始协助可能会变；发对方最新一次显示的链接即可。';
  } else if (s.useQuickTunnel) {
    urlHintEl.textContent = '已开启临时公网：开始协助后，这里会自动出现可分享的网址。';
  } else {
    urlHintEl.textContent =
      '固定网址模式：把上面链接发给对方。若出现 Cloudflare 1033，请在跑隧道的机器上启动 cloudflared（Windows 可勾选设置里的「启动隧道服务」）。';
  }
}

async function refreshUiFromSettings() {
  const s = await window.remoteAssist.getSettings();
  applyUrlDisplay(s);
  roomEl.value = s.roomId || '';
  secretEl.value = s.secret || '';

  document.getElementById('set-quick-tunnel').checked = !!s.useQuickTunnel;
  document.getElementById('set-control-url').value = s.controlUrl || '';
  document.getElementById('set-python').value = s.pythonPath || '';
  document.getElementById('set-workdir').value = s.workDir || '';
  document.getElementById('set-relay').value = s.relayUrl || '';
  document.getElementById('set-fps').value = s.fps ?? 20;
  document.getElementById('set-quality').value = s.quality ?? 95;
  document.getElementById('set-max-width').value = s.maxWidth ?? 0;
  document.getElementById('set-win-tunnel').checked = !!s.startWindowsTunnelService;
  document.getElementById('set-service-name').value = s.windowsTunnelServiceName || '';

  const isWin = s.platform === 'win32';
  winTunnelBlock.hidden = !isWin || !!s.useQuickTunnel;
  macNote.hidden = isWin;

  if (s.hasBundledRuntime) {
    setPythonHint.textContent = `已检测到安装包自带运行库。当前将使用：Python「${s.resolvedPythonPath || '（自动）'}」· 代码目录「${s.resolvedWorkDir || '（自动）'}」`;
  } else {
    setPythonHint.textContent =
      '开发模式下若未执行 npm run prepare-bundle，需手动填写 Python 与代码目录；正式安装包一般不用填。';
  }
  updateCfstButtons(s);
}

function openModal() {
  modal.hidden = false;
}

function closeModal() {
  modal.hidden = true;
}

document.getElementById('btn-settings').addEventListener('click', async () => {
  await refreshUiFromSettings();
  openModal();
});

document.getElementById('btn-close-settings').addEventListener('click', closeModal);
modal.querySelector('[data-close]').addEventListener('click', closeModal);

document.getElementById('set-quick-tunnel').addEventListener('change', (e) => {
  const quick = e.target.checked;
  const isWin = window._lastPlatform === 'win32';
  winTunnelBlock.hidden = !isWin || quick;
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const patch = {
    useQuickTunnel: document.getElementById('set-quick-tunnel').checked,
    controlUrl: document.getElementById('set-control-url').value.trim(),
    pythonPath: document.getElementById('set-python').value.trim(),
    workDir: document.getElementById('set-workdir').value.trim(),
    relayUrl: document.getElementById('set-relay').value.trim(),
    fps: Number(document.getElementById('set-fps').value) || 20,
    quality: Number(document.getElementById('set-quality').value) || 95,
    maxWidth: Math.max(0, Math.floor(Number(document.getElementById('set-max-width').value) || 0)),
    startWindowsTunnelService: document.getElementById('set-win-tunnel').checked,
    windowsTunnelServiceName: document.getElementById('set-service-name').value.trim()
  };
  await window.remoteAssist.saveSettings(patch);
  await refreshUiFromSettings();
  appendLog('设置已保存。', 'info');
  closeModal();
});

document.getElementById('btn-copy-url').addEventListener('click', async () => {
  const t = controlUrlEl.textContent.trim();
  if (!t || t === '—' || !t.startsWith('http')) {
    appendLog('当前没有可复制的有效网址；请在设置里填写 https 开头的控制端网址（固定域名模式）。', 'warn');
    return;
  }
  await window.remoteAssist.copyText(t);
  appendLog('已复制网址。', 'info');
});

document.getElementById('btn-open-url').addEventListener('click', async () => {
  const t = controlUrlEl.textContent.trim();
  if (t && t.startsWith('http')) await window.remoteAssist.openExternal(t);
});

document.getElementById('btn-copy-room').addEventListener('click', async () => {
  await window.remoteAssist.copyText(roomEl.value);
  appendLog('已复制本机 ID。', 'info');
});

document.getElementById('btn-copy-secret').addEventListener('click', async () => {
  await window.remoteAssist.copyText(secretEl.value);
  appendLog('已复制密钥。', 'info');
});

document.getElementById('btn-refresh').addEventListener('click', async () => {
  await window.remoteAssist.refreshCredentials();
  await refreshUiFromSettings();
  appendLog('已换一组 ID 和密钥。', 'info');
});

document.getElementById('btn-start').addEventListener('click', async () => {
  appendLog('正在开始协助…', 'info');
  await window.remoteAssist.startAssist();
  await refreshUiFromSettings();
});

document.getElementById('btn-stop').addEventListener('click', async () => {
  await window.remoteAssist.stopAssist();
  appendLog('已停止协助。', 'info');
  await refreshUiFromSettings();
});

document.getElementById('btn-cfst-optimize').addEventListener('click', async () => {
  btnCfstOptimize.disabled = true;
  appendLog('开始 Cloudflare 优选测速（请耐心等待，完成后会弹出管理员授权）…', 'info');
  try {
    const r = await window.remoteAssist.cfstOptimizeTunnel();
    if (r && r.ok) {
      appendLog(`优选完成：${r.ip} → ${r.host}（本机 hosts 已更新）`, 'info');
      if (r.hostsLine) appendLog(`已复制到剪贴板，对方可添加：${r.hostsLine}`, 'info');
    } else {
      appendLog(`优选失败：${(r && r.error) || '未知错误'}`, 'error');
    }
  } catch (e) {
    appendLog(`优选异常：${e && e.message ? e.message : e}`, 'error');
  }
  await refreshUiFromSettings();
});

document.getElementById('btn-cfst-remove').addEventListener('click', async () => {
  btnCfstRemove.disabled = true;
  appendLog('正在请求管理员权限清除优选 hosts 记录…', 'info');
  try {
    const r = await window.remoteAssist.cfstRemoveHosts();
    if (r && r.ok) appendLog('已清除本机优选 hosts 记录。', 'info');
    else appendLog(`清除失败：${(r && r.error) || '未知'}`, 'warn');
  } catch (e) {
    appendLog(`清除异常：${e && e.message ? e.message : e}`, 'error');
  }
  await refreshUiFromSettings();
});

window.remoteAssist.onStatus((payload) => {
  const level = payload.level === 'error' ? 'error' : payload.level === 'warn' ? 'warn' : 'info';
  appendLog(payload.text, level);
});

window.remoteAssist.onControlUrl((payload) => {
  if (!payload || !payload.url) {
    refreshUiFromSettings();
    return;
  }
  controlUrlEl.textContent = payload.url;
  if (payload.temporary) {
    urlHintEl.textContent = '当前为临时网址，每次开始协助可能会变；请把这一行链接发给对方。';
  }
  window.remoteAssist.getSettings().then((s) => updateCfstButtons(s));
});

window.remoteAssist.onAssistReset(() => {
  refreshUiFromSettings();
});

(async () => {
  const x = await window.remoteAssist.getSettings();
  window._lastPlatform = x.platform;
  await refreshUiFromSettings();
})();
