const { app, BrowserWindow, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

let mainWindow = null;
let serverProc = null;
let agentProc = null;
let tunnelProc = null;
let assistRunning = false;
let tunnelBuffer = '';
let sessionControlUrl = '';

const TRY_CLOUDFLARE_RE = /https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com\/?/i;

const defaultSettings = () => ({
  controlUrl: 'https://remote.hemei.asia/',
  roomId: '',
  secret: '',
  pythonPath: '',
  workDir: '',
  relayUrl: 'ws://127.0.0.1:8765',
  localCheckUrl: 'http://127.0.0.1:8765/',
  fps: 20,
  quality: 95,
  maxWidth: 0,
  jpegSubsampling: 0,
  useQuickTunnel: false,
  startWindowsTunnelService: true,
  windowsTunnelServiceName: 'cloudflared-hemei-tunnel'
});

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function resourcesRoot() {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, '..');
}

function devBundledPlatformDir() {
  const sub = process.platform === 'win32' ? 'win' : 'mac';
  return path.join(__dirname, '..', 'bundled-runtime', sub);
}

function walkFindExecutable(root, basenames) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (basenames.includes(e.name)) return full;
    }
  }
  return null;
}

function bundledAssistDir() {
  const fromRes = path.join(resourcesRoot(), 'assist-bundle');
  if (fs.existsSync(fromRes)) return fromRes;
  const dev = path.join(__dirname, '..', 'assist-bundle');
  if (fs.existsSync(dev)) return dev;
  return null;
}

function bundledPythonExe() {
  const roots = [];
  if (app.isPackaged) roots.push(path.join(process.resourcesPath, 'python-runtime'));
  roots.push(path.join(devBundledPlatformDir(), 'python-runtime'));
  const names =
    process.platform === 'win32'
      ? ['python.exe']
      : ['python3.12', 'python3.11', 'python3.10', 'python3'];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const hit = walkFindExecutable(r, names);
    if (hit) return hit;
  }
  return null;
}

function bundledCfstDir() {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'cfst');
    if (fs.existsSync(p)) return p;
    return null;
  }
  const dev = path.join(devBundledPlatformDir(), 'cfst');
  if (fs.existsSync(dev)) return dev;
  return null;
}

function trycloudflareHostFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    const h = u.hostname.toLowerCase();
    if (!h.endsWith('.trycloudflare.com')) return null;
    if (h === 'trycloudflare.com') return null;
    return h;
  } catch {
    return null;
  }
}

function parseCfstResultCsv(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const sep = lines[0].includes('\t') ? '\t' : ',';
  for (let i = 1; i < lines.length; i++) {
    let first = (lines[i].split(sep)[0] || '').replace(/^"|"$/g, '').trim();
    if (first.includes(' ')) first = first.split(/\s+/)[0];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(first)) return first;
  }
  return null;
}

function runCfstBestIp(cfstDir, outCsv) {
  const exe = process.platform === 'win32' ? 'cfst.exe' : 'cfst';
  const cfstPath = path.join(cfstDir, exe);
  if (!fs.existsSync(cfstPath)) {
    return Promise.reject(new Error('未找到 cfst 可执行文件'));
  }
  const args = ['-tl', '350', '-dd', '-n', '800', '-o', outCsv];
  return new Promise((resolve, reject) => {
    execFile(
      cfstPath,
      args,
      {
        cwd: cfstDir,
        windowsHide: true,
        timeout: 360000,
        maxBuffer: 20 * 1024 * 1024
      },
      (err) => {
        if (!fs.existsSync(outCsv)) {
          reject(err || new Error('测速未生成结果文件'));
          return;
        }
        resolve();
      }
    );
  });
}

function psLiteralSingleQuoted(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function applyHostsEntryWin(hostname, ip) {
  const marker = '# RemoteAssist-CFST';
  const resultFile = path.join(app.getPath('userData'), 'cfst-hosts-result.txt');
  const ps1 = path.join(app.getPath('userData'), 'cfst-hosts-elevate.ps1');
  const escHost = hostname.replace(/'/g, "''");
  const escIp = ip.replace(/'/g, "''");
  const escMarker = marker.replace(/'/g, "''");
  const escOut = resultFile.replace(/'/g, "''");
  const body = `$ErrorActionPreference = 'Stop'
$out = '${escOut}'
try {
  $hostsPath = Join-Path $env:WinDir 'System32\\drivers\\etc\\hosts'
  $hostname = '${escHost}'
  $ip = '${escIp}'
  $marker = '${escMarker}'
  if (-not ($ip -match '^\\d{1,3}(\\.\\d{1,3}){3}$')) { throw '无效 IP' }
  if ($hostname -notmatch '\\.trycloudflare\\.com$') { throw '无效域名' }
  $lines = @()
  if (Test-Path -LiteralPath $hostsPath) { $lines = Get-Content -LiteralPath $hostsPath }
  $filtered = New-Object System.Collections.Generic.List[string]
  foreach ($l in $lines) {
    if (($l -like "*$hostname*") -and ($l -like "*$marker*")) { continue }
    $filtered.Add($l)
  }
  $newLine = ($ip + [char]9 + $hostname + '    ' + $marker)
  $filtered.Add($newLine)
  $text = ($filtered -join [Environment]::NewLine) + [Environment]::NewLine
  Set-Content -LiteralPath $hostsPath -Value $text -Encoding ascii
  'OK' | Out-File -LiteralPath $out -Encoding utf8
} catch {
  ('ERR: ' + $_.Exception.Message) | Out-File -LiteralPath $out -Encoding utf8
  exit 1
}
`;
  return new Promise((resolve) => {
    try {
      fs.writeFileSync(ps1, body, 'utf8');
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      return;
    }
    try {
      fs.unlinkSync(resultFile);
    } catch {
      // ignore
    }
    const proc = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psLiteralSingleQuoted(
          ps1
        )})`
      ],
      { windowsHide: true }
    );
    proc.on('close', () => {
      try {
        const r = fs.readFileSync(resultFile, 'utf8').trim();
        if (r === 'OK') resolve({ ok: true });
        else
          resolve({
            ok: false,
            error: r.replace(/^ERR:\s*/i, '') || '可能取消了管理员授权'
          });
      } catch {
        resolve({ ok: false, error: '可能取消了管理员授权，或无法写入 hosts' });
      }
    });
    proc.on('error', () => resolve({ ok: false, error: '无法启动提权进程' }));
  });
}

function shellSingleQuoteBash(s) {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

function applyHostsEntryMac(hostname, ip) {
  const marker = '# RemoteAssist-CFST';
  const resultFile = path.join(app.getPath('userData'), 'cfst-hosts-result.txt');
  const shPath = path.join(app.getPath('temp'), 'remote-assist-cfst-hosts.sh');
  const bash = [
    '#!/bin/bash',
    'set -e',
    `RESULT_FILE=${shellSingleQuoteBash(resultFile)}`,
    `HOST=${shellSingleQuoteBash(hostname)}`,
    `IP=${shellSingleQuoteBash(ip)}`,
    `MARKER=${shellSingleQuoteBash(marker)}`,
    'if ! echo "$IP" | grep -Eq \'^[0-9]{1,3}(\\.[0-9]{1,3}){3}$\'; then echo "ERR: bad ip" > "$RESULT_FILE"; exit 1; fi',
    'TMP=$(mktemp)',
    'awk -v h="$HOST" -v m="$MARKER" \'index($0,h)>0 && index($0,m)>0 {next} 1\' /etc/hosts > "$TMP"',
    'printf \'%s\\t%s    %s\\n\' "$IP" "$HOST" "$MARKER" >> "$TMP"',
    'install -m 644 "$TMP" /etc/hosts',
    'rm -f "$TMP"',
    'echo OK > "$RESULT_FILE"'
  ].join('\n');
  return new Promise((resolve) => {
    try {
      fs.writeFileSync(shPath, bash, 'utf8');
      try {
        fs.chmodSync(shPath, 0o755);
      } catch {
        // ignore
      }
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      return;
    }
    try {
      fs.unlinkSync(resultFile);
    } catch {
      // ignore
    }
    const inner = `/bin/bash ${shPath}`;
    const appleCmd = `do shell script ${JSON.stringify(inner)} with administrator privileges`;
    const proc = spawn('osascript', ['-e', appleCmd]);
    proc.on('close', () => {
      try {
        const r = fs.readFileSync(resultFile, 'utf8').trim();
        if (r === 'OK') resolve({ ok: true });
        else resolve({ ok: false, error: r.replace(/^ERR:\s*/i, '') || '可能取消了密码授权' });
      } catch {
        resolve({ ok: false, error: '可能取消了密码授权，或无法写入 /etc/hosts' });
      }
    });
    proc.on('error', () => resolve({ ok: false, error: '无法启动 osascript' }));
  });
}

function removeHostsMarkerWin() {
  const marker = '# RemoteAssist-CFST';
  const resultFile = path.join(app.getPath('userData'), 'cfst-hosts-result.txt');
  const ps1 = path.join(app.getPath('userData'), 'cfst-hosts-remove.ps1');
  const escMarker = marker.replace(/'/g, "''");
  const escOut = resultFile.replace(/'/g, "''");
  const body = `$ErrorActionPreference = 'Stop'
$out = '${escOut}'
try {
  $hostsPath = Join-Path $env:WinDir 'System32\\drivers\\etc\\hosts'
  $marker = '${escMarker}'
  $lines = @()
  if (Test-Path -LiteralPath $hostsPath) { $lines = @((Get-Content -LiteralPath $hostsPath)) }
  $filtered = @($lines | Where-Object { $_ -notlike "*$marker*" })
  if ($lines.Count -gt 0 -and $filtered.Count -eq 0) { throw 'hosts 过滤后为空，已中止（避免清空系统 hosts）' }
  $text = ($filtered -join [Environment]::NewLine)
  if ($text) { $text = $text + [Environment]::NewLine }
  Set-Content -LiteralPath $hostsPath -Value $text -Encoding ascii
  'OK' | Out-File -LiteralPath $out -Encoding utf8
} catch {
  ('ERR: ' + $_.Exception.Message) | Out-File -LiteralPath $out -Encoding utf8
  exit 1
}
`;
  return new Promise((resolve) => {
    try {
      fs.writeFileSync(ps1, body, 'utf8');
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      return;
    }
    try {
      fs.unlinkSync(resultFile);
    } catch {
      // ignore
    }
    const proc = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psLiteralSingleQuoted(
          ps1
        )})`
      ],
      { windowsHide: true }
    );
    proc.on('close', () => {
      try {
        const r = fs.readFileSync(resultFile, 'utf8').trim();
        if (r === 'OK') resolve({ ok: true });
        else resolve({ ok: false, error: r.replace(/^ERR:\s*/i, '') || '可能取消了管理员授权' });
      } catch {
        resolve({ ok: false, error: '可能取消了管理员授权' });
      }
    });
    proc.on('error', () => resolve({ ok: false, error: '无法启动提权进程' }));
  });
}

function removeHostsMarkerMac() {
  const marker = '# RemoteAssist-CFST';
  const resultFile = path.join(app.getPath('userData'), 'cfst-hosts-result.txt');
  const shPath = path.join(app.getPath('temp'), 'remote-assist-cfst-hosts-remove.sh');
  const bash = [
    '#!/bin/bash',
    'set -e',
    `RESULT_FILE=${shellSingleQuoteBash(resultFile)}`,
    `MARKER=${shellSingleQuoteBash(marker)}`,
    'TMP=$(mktemp)',
    'awk -v m="$MARKER" \'index($0,m)==0\' /etc/hosts > "$TMP"',
    'if [ ! -s "$TMP" ]; then echo "ERR: 过滤后 hosts 为空，已中止" > "$RESULT_FILE"; exit 1; fi',
    'install -m 644 "$TMP" /etc/hosts',
    'rm -f "$TMP"',
    'echo OK > "$RESULT_FILE"'
  ].join('\n');
  return new Promise((resolve) => {
    try {
      fs.writeFileSync(shPath, bash, 'utf8');
      try {
        fs.chmodSync(shPath, 0o755);
      } catch {
        // ignore
      }
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      return;
    }
    try {
      fs.unlinkSync(resultFile);
    } catch {
      // ignore
    }
    const inner = `/bin/bash ${shPath}`;
    const appleCmd = `do shell script ${JSON.stringify(inner)} with administrator privileges`;
    const proc = spawn('osascript', ['-e', appleCmd]);
    proc.on('close', () => {
      try {
        const r = fs.readFileSync(resultFile, 'utf8').trim();
        if (r === 'OK') resolve({ ok: true });
        else resolve({ ok: false, error: r.replace(/^ERR:\s*/i, '') || '可能取消了密码授权' });
      } catch {
        resolve({ ok: false, error: '可能取消了密码授权' });
      }
    });
    proc.on('error', () => resolve({ ok: false, error: '无法启动 osascript' }));
  });
}

function bundledCloudflaredPath() {
  if (process.platform === 'win32') {
    const cands = [
      path.join(process.resourcesPath, 'cloudflared.exe'),
      path.join(devBundledPlatformDir(), 'cloudflared.exe')
    ];
    for (const p of cands) {
      if (p && fs.existsSync(p)) return p;
    }
    return null;
  }
  const cands = [
    path.join(process.resourcesPath, 'cloudflared'),
    path.join(devBundledPlatformDir(), 'cloudflared')
  ];
  for (const p of cands) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function resolvePythonPath(settings) {
  if (settings.pythonPath && fs.existsSync(settings.pythonPath)) return settings.pythonPath;
  const b = bundledPythonExe();
  return b || '';
}

function resolveWorkDir(settings) {
  if (settings.workDir && fs.existsSync(settings.workDir)) return settings.workDir;
  const b = bundledAssistDir();
  return b || '';
}

function sanitizeSettings(s) {
  if (s.pythonPath && !fs.existsSync(s.pythonPath)) s.pythonPath = '';
  if (s.workDir && !fs.existsSync(s.workDir)) s.workDir = '';
  const fps = Number(s.fps);
  if (Number.isFinite(fps)) s.fps = Math.min(20, Math.max(1, Math.floor(fps)));
  else s.fps = 20;
  const q = Number(s.quality);
  if (Number.isFinite(q)) s.quality = Math.min(95, Math.max(1, Math.floor(q)));
  else s.quality = 95;
  const mw = Number(s.maxWidth);
  if (Number.isFinite(mw)) s.maxWidth = Math.max(0, Math.floor(mw));
  else s.maxWidth = 0;
  const jss = Number(s.jpegSubsampling);
  s.jpegSubsampling = jss === 2 ? 2 : 0;
  return s;
}

function loadSettings() {
  const base = defaultSettings();
  let merged = { ...base };
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    merged = { ...base, ...JSON.parse(raw) };
  } catch {
    // first run
  }
  return sanitizeSettings(merged);
}

function saveSettingsFile(data) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8');
}

function randomReadable(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function ensureCredentials(settings) {
  let changed = false;
  if (!settings.roomId || settings.roomId.length < 4) {
    settings.roomId = randomReadable(12);
    changed = true;
  }
  if (!settings.secret || settings.secret.length < 4) {
    settings.secret = randomReadable(16);
    changed = true;
  }
  return changed;
}

function sendStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', payload);
  }
}

function sendControlUrl(url, temporary) {
  sessionControlUrl = url || '';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('control-url', { url: url || '', temporary: !!temporary });
  }
}

function checkHttpOk(urlString) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlString);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        urlString,
        { method: 'GET', timeout: 8000 },
        (res) => {
          resolve(res.statusCode === 200);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

function startWindowsTunnelService(serviceName) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !serviceName) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const safe = serviceName.replace(/'/g, "''");
    const ps = `try { $s = Get-Service -Name '${safe}' -ErrorAction Stop; if ($s.Status -ne 'Running') { Start-Service -Name '${safe}' }; exit 0 } catch { exit 1 }`;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true }
    );
    child.on('close', (code) => {
      if (code !== 0) {
        sendStatus({ level: 'warn', text: '隧道服务未能自动启动（若你用自己的固定网址，可忽略）。' });
      }
      finish(code === 0);
    });
    setTimeout(() => finish(true), 15000);
  });
}

/** 结束僵死的 cloudflared 并重启命名服务（缓解 Cloudflare Error 1033）。可能需要管理员权限才完全生效。 */
function recoverWindowsCloudflaredService(serviceName) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !serviceName) {
      resolve(false);
      return;
    }
    const safe = serviceName.replace(/'/g, "''");
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$s = '${safe}'
try { Stop-Service -Name $s -Force } catch {}
Start-Sleep -Seconds 2
Get-Process -Name cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
try {
  Start-Service -Name $s
  exit 0
} catch {
  exit 1
}
`;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      windowsHide: true
    });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on('close', (code) => done(code === 0));
    child.on('error', () => done(false));
    setTimeout(() => done(false), 60000);
  });
}

function killProc(proc, label) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    // ignore
  }
  if (label) sendStatus({ level: 'info', text: `已结束：${label}` });
}

function tryExtractTrycloudflareUrl(text) {
  const m = text.match(TRY_CLOUDFLARE_RE);
  if (!m) return null;
  const raw = m[0];
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function feedTunnelLog(chunk) {
  tunnelBuffer += chunk.toString();
  const lines = tunnelBuffer.split(/\r?\n/);
  tunnelBuffer = lines.pop() || '';
  for (const line of lines) {
    const u = tryExtractTrycloudflareUrl(line);
    if (u) {
      sessionControlUrl = u;
      sendControlUrl(u, true);
      sendStatus({ level: 'info', text: '已取得临时公网网址（对方用浏览器打开即可）。' });
    }
  }
  const fromBuf = tryExtractTrycloudflareUrl(tunnelBuffer);
  if (fromBuf && fromBuf !== sessionControlUrl) {
    sessionControlUrl = fromBuf;
    sendControlUrl(fromBuf, true);
    sendStatus({ level: 'info', text: '已取得临时公网网址（对方用浏览器打开即可）。' });
  }
}

function notifyAssistReset() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('assist-reset');
  }
}

function teardownAfterServiceFailure(reason) {
  if (!assistRunning) return;
  killProc(agentProc, '本机画面程序');
  agentProc = null;
  killProc(tunnelProc, '临时公网隧道');
  tunnelProc = null;
  killProc(serverProc, '本机服务程序');
  serverProc = null;
  assistRunning = false;
  sessionControlUrl = '';
  sendControlUrl('', false);
  sendStatus({ level: 'error', text: reason });
  notifyAssistReset();
}

function spawnPython(pythonPath, args, cwd, extraEnv) {
  const opts = {
    cwd: cwd || undefined,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv }
  };
  return spawn(pythonPath, args, opts);
}

async function stopAssistInternal() {
  assistRunning = false;
  sessionControlUrl = '';
  sendControlUrl('', false);
  killProc(agentProc, '本机画面程序');
  agentProc = null;
  killProc(tunnelProc, '临时公网隧道');
  tunnelProc = null;
  killProc(serverProc, '本机服务程序');
  serverProc = null;
  notifyAssistReset();
}

async function startAssistInternal() {
  const s = loadSettings();
  ensureCredentials(s);
  saveSettingsFile(s);

  const pythonPath = resolvePythonPath(s);
  const workDir = resolveWorkDir(s);

  if (!pythonPath) {
    sendStatus({
      level: 'error',
      text: '找不到可用的 Python。请先运行「npm run prepare-bundle」再打安装包，或在设置里手动指定。'
    });
    return false;
  }
  if (!workDir) {
    sendStatus({ level: 'error', text: '找不到协助端程序文件（assist-bundle）。请重新安装或联系提供方。' });
    return false;
  }

  if (assistRunning && !serverProc && !agentProc && !tunnelProc) {
    assistRunning = false;
    sendStatus({ level: 'warn', text: '上次状态异常，已自动重置；请再点一次「开始协助」。' });
  }

  if (assistRunning) {
    sendStatus({ level: 'warn', text: '已经在运行中。若界面卡住，请先点「停止协助」再重新开始。' });
    return true;
  }

  const portInUse = await checkHttpOk(s.localCheckUrl);
  if (portInUse) {
    sendStatus({
      level: 'error',
      text: '本机 8765 端口已被占用（常见：上次协助未正常退出、或其它程序占用）。请先点「停止协助」，或在任务管理器里结束残留的 python.exe 后再试。'
    });
    return false;
  }

  const filesDir = path.join(app.getPath('userData'), 'RemoteAssistFiles');
  fs.mkdirSync(filesDir, { recursive: true });
  const childEnv = { REMOTE_ASSIST_FILES_DIR: filesDir };

  const useQuick = !!s.useQuickTunnel;
  const cfPath = bundledCloudflaredPath();

  if (!useQuick) {
    sendControlUrl(s.controlUrl || '', false);
  } else {
    sessionControlUrl = '';
    sendControlUrl('', false);
  }

  if (!useQuick && s.startWindowsTunnelService && s.windowsTunnelServiceName) {
    sendStatus({ level: 'info', text: '正在尝试启动 Windows 隧道服务…' });
    await startWindowsTunnelService(s.windowsTunnelServiceName);
    await new Promise((r) => setTimeout(r, 2000));
  }

  sendStatus({ level: 'info', text: '正在启动本机服务…' });
  assistRunning = true;
  serverProc = spawnPython(pythonPath, ['-m', 'remote_assist.server'], workDir, childEnv);
  serverProc.stdout.on('data', (d) =>
    sendStatus({ level: 'log', text: `[服务] ${d.toString().trim()}` })
  );
  serverProc.stderr.on('data', (d) =>
    sendStatus({ level: 'log', text: `[服务错误] ${d.toString().trim()}` })
  );
  serverProc.on('exit', (code) => {
    sendStatus({ level: 'warn', text: `本机服务已退出（代码 ${code ?? '?'}）` });
    serverProc = null;
    if (!assistRunning) return;
    teardownAfterServiceFailure(
      `本机协助服务异常停止（退出码 ${code ?? '?'}）。常见原因：端口被占用、杀毒软件拦截、或程序文件损坏。请先点「停止协助」，检查任务管理器里是否还有其它 python 占用 8765 端口，再重新开始。若仍失败，可在设置里关闭「临时公网」并改用你自己的固定网址。`
    );
  });

  await new Promise((r) => setTimeout(r, 2200));

  if (!assistRunning) {
    killProc(tunnelProc, '临时公网隧道');
    tunnelProc = null;
    notifyAssistReset();
    return false;
  }

  if (!serverProc || serverProc.exitCode !== null) {
    sendStatus({
      level: 'error',
      text: '本机服务未能保持运行（可能启动即崩溃）。请查看上方日志里以 [服务错误] 开头的报错；常见为端口占用或权限问题。'
    });
    killProc(tunnelProc, '临时公网隧道');
    tunnelProc = null;
    assistRunning = false;
    sessionControlUrl = '';
    sendControlUrl('', false);
    notifyAssistReset();
    return false;
  }

  if (useQuick) {
    if (!cfPath) {
      sendStatus({
        level: 'error',
        text: '未找到 cloudflared，无法使用临时公网。请重新运行 prepare-bundle 打包，或关掉「临时公网」改用你自己的网址。'
      });
      sessionControlUrl = '';
      sendControlUrl(s.controlUrl || '', false);
      killProc(serverProc, '本机服务程序');
      serverProc = null;
      assistRunning = false;
      notifyAssistReset();
      return false;
    }
    tunnelBuffer = '';
    tunnelProc = spawn(cfPath, ['tunnel', '--url', 'http://127.0.0.1:8765/'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    tunnelProc.stdout.on('data', feedTunnelLog);
    tunnelProc.stderr.on('data', feedTunnelLog);
    tunnelProc.on('exit', (code) => {
      sendStatus({ level: 'warn', text: `临时公网隧道已退出（代码 ${code ?? '?'}）` });
      tunnelProc = null;
      if (assistRunning && loadSettings().useQuickTunnel && !sessionControlUrl) {
        teardownAfterServiceFailure(
          '临时公网隧道已断开且未取得网址。若网络限制 Cloudflare（例如部分公司网），请换网络或在设置里关闭「临时公网」改用固定隧道。'
        );
      } else if (assistRunning && loadSettings().useQuickTunnel && sessionControlUrl) {
        sendStatus({
          level: 'warn',
          text: '临时公网隧道已断开，对方可能无法再打开原链接。请点「停止协助」后重新开始以获取新网址。'
        });
      }
    });
    for (let i = 0; i < 20 && !sessionControlUrl && tunnelProc && assistRunning; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const parsed = tryExtractTrycloudflareUrl(tunnelBuffer);
      if (parsed) {
        sessionControlUrl = parsed;
        sendControlUrl(parsed, true);
        sendStatus({ level: 'info', text: '已取得临时公网网址（对方用浏览器打开即可）。' });
        break;
      }
      if (tunnelBuffer.length > 8000) tunnelBuffer = tunnelBuffer.slice(-4000);
    }
    if (!sessionControlUrl) {
      sendStatus({
        level: 'warn',
        text: '约 20 秒内仍未解析到临时网址。请查看日志里 cloudflared 是否报错；若网络无法使用 trycloudflare，请在设置中关闭「临时公网」并配置你自己的访问地址。'
      });
    }
  }

  if (!assistRunning || !serverProc || serverProc.exitCode !== null) {
    killProc(tunnelProc, '临时公网隧道');
    tunnelProc = null;
    notifyAssistReset();
    return false;
  }

  const agentArgs = [
    '-m',
    'remote_assist.host_agent',
    '--relay',
    s.relayUrl,
    '--room',
    s.roomId,
    '--secret',
    s.secret,
    '--fps',
    String(s.fps),
    '--quality',
    String(s.quality),
    '--max-width',
    String(s.maxWidth),
    '--jpeg-subsampling',
    String(s.jpegSubsampling ?? 0)
  ];

  sendStatus({ level: 'info', text: '正在启动本机画面传输…' });
  agentProc = spawnPython(pythonPath, agentArgs, workDir, childEnv);
  agentProc.stdout.on('data', (d) =>
    sendStatus({ level: 'log', text: `[画面] ${d.toString().trim()}` })
  );
  agentProc.stderr.on('data', (d) =>
    sendStatus({ level: 'log', text: `[画面错误] ${d.toString().trim()}` })
  );
  agentProc.on('exit', (code) => {
    sendStatus({ level: 'warn', text: `画面程序已退出（代码 ${code}）` });
    agentProc = null;
  });

  const localOk = await checkHttpOk(s.localCheckUrl);
  const checkRemote =
    sessionControlUrl && sessionControlUrl.startsWith('http') ? sessionControlUrl : s.controlUrl;
  let remoteOk = await checkHttpOk(checkRemote);
  let attemptedTunnelRecover = false;

  if (localOk) sendStatus({ level: 'info', text: '本机网页检测：正常。' });
  else sendStatus({ level: 'warn', text: '本机网页暂时访问不到，可稍等或检查端口占用。' });

  if (
    !useQuick &&
    !remoteOk &&
    process.platform === 'win32' &&
    s.startWindowsTunnelService &&
    s.windowsTunnelServiceName &&
    checkRemote &&
    checkRemote.startsWith('https://')
  ) {
    attemptedTunnelRecover = true;
    sendStatus({
      level: 'warn',
      text: '固定域名检测失败（常见：cloudflared 假死 → 浏览器 Cloudflare 1033）。正在尝试重启隧道服务…'
    });
    const recovered = await recoverWindowsCloudflaredService(s.windowsTunnelServiceName);
    if (recovered) await new Promise((r) => setTimeout(r, 8000));
    remoteOk = await checkHttpOk(checkRemote);
    if (remoteOk) {
      sendStatus({ level: 'info', text: '隧道服务已自动重启，固定域名已恢复。' });
    }
  }

  if (useQuick && !sessionControlUrl) {
    sendStatus({ level: 'warn', text: '临时公网网址仍未检测到，对方可稍后再试打开，或改用固定隧道网址。' });
  } else if (remoteOk) {
    sendStatus({ level: 'info', text: '控制端网址检测：可以打开。' });
  } else if (attemptedTunnelRecover) {
    sendStatus({
      level: 'warn',
      text: '自动重启后固定网址仍异常。请以管理员运行：scripts\\restart-hemei-tunnel.ps1；或登录 Cloudflare Zero Trust 检查隧道。国内无 VPN 可在设置里临时勾选「临时公网」。'
    });
  } else {
    sendStatus({
      level: 'warn',
      text: '控制端网址暂时打不开（检查网络或在设置里启用「临时公网」作备用）。'
    });
  }

  if (!useQuick) sendControlUrl(s.controlUrl || '', false);

  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 540,
    height: 780,
    minWidth: 440,
    minHeight: 620,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const s = loadSettings();
  if (ensureCredentials(s)) saveSettingsFile(s);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopAssistInternal();
});

ipcMain.handle('get-settings', () => {
  const s = loadSettings();
  const hasSession = !!sessionControlUrl && sessionControlUrl.startsWith('http');
  let displayUrl = s.controlUrl;
  let temporary = false;
  if (s.useQuickTunnel) {
    if (hasSession) {
      displayUrl = sessionControlUrl;
      temporary = true;
    } else if (assistRunning) {
      displayUrl = '正在申请临时公网网址，请稍候…';
    } else {
      displayUrl = '（点「开始协助」后，这里会出现对方要打开的链接）';
    }
  }
  return {
    ...s,
    platform: process.platform,
    resolvedPythonPath: resolvePythonPath(s),
    resolvedWorkDir: resolveWorkDir(s),
    displayControlUrl: displayUrl,
    displayControlUrlTemporary: temporary,
    assistRunning,
    hasBundledRuntime: !!(bundledPythonExe() && bundledAssistDir()),
    hasCfstBundle: !!bundledCfstDir()
  };
});

ipcMain.handle('save-settings', (_e, patch) => {
  const cur = loadSettings();
  const {
    platform: _p,
    resolvedPythonPath: _a,
    resolvedWorkDir: _b,
    displayControlUrl: _c,
    displayControlUrlTemporary: _t,
    assistRunning: _ar,
    hasBundledRuntime: _d,
    hasCfstBundle: _cf,
    ...rest
  } = patch || {};
  const next = sanitizeSettings({ ...cur, ...rest });
  ensureCredentials(next);
  saveSettingsFile(next);
  const s = loadSettings();
  const hasSession = !!sessionControlUrl && sessionControlUrl.startsWith('http');
  let displayUrl = s.controlUrl;
  let temporary = false;
  if (s.useQuickTunnel) {
    if (hasSession) {
      displayUrl = sessionControlUrl;
      temporary = true;
    } else if (assistRunning) {
      displayUrl = '正在申请临时公网网址，请稍候…';
    } else {
      displayUrl = '（点「开始协助」后，这里会出现对方要打开的链接）';
    }
  }
  return {
    ...s,
    platform: process.platform,
    resolvedPythonPath: resolvePythonPath(s),
    resolvedWorkDir: resolveWorkDir(s),
    displayControlUrl: displayUrl,
    displayControlUrlTemporary: temporary,
    assistRunning,
    hasBundledRuntime: !!(bundledPythonExe() && bundledAssistDir()),
    hasCfstBundle: !!bundledCfstDir()
  };
});

ipcMain.handle('start-assist', async () => {
  try {
    return await startAssistInternal();
  } catch (e) {
    sendStatus({ level: 'error', text: String(e && e.message ? e.message : e) });
    return false;
  }
});

ipcMain.handle('stop-assist', async () => {
  await stopAssistInternal();
  return true;
});

ipcMain.handle('refresh-credentials', async () => {
  const cur = loadSettings();
  const wasRunning = assistRunning;
  if (wasRunning) await stopAssistInternal();
  await new Promise((r) => setTimeout(r, 600));
  cur.roomId = randomReadable(12);
  cur.secret = randomReadable(16);
  saveSettingsFile(cur);
  if (wasRunning) await startAssistInternal();
  return cur;
});

ipcMain.handle('copy-text', (_e, text) => {
  clipboard.writeText(text || '');
  return true;
});

ipcMain.handle('open-external', (_e, url) => {
  if (url) shell.openExternal(url);
  return true;
});

ipcMain.handle('cfst-optimize-tunnel', async () => {
  const cfstDir = bundledCfstDir();
  if (!cfstDir) {
    return {
      ok: false,
      error: '未找到测速工具。请在项目根目录执行 npm run prepare-bundle 后重新打包安装。'
    };
  }
  const url =
    sessionControlUrl && sessionControlUrl.startsWith('http') ? sessionControlUrl.trim() : '';
  const host = trycloudflareHostFromUrl(url);
  if (!host) {
    return {
      ok: false,
      error: '请先用「临时公网」开始协助，并等 trycloudflare 临时网址出现后再点优选。'
    };
  }
  const outCsv = path.join(app.getPath('userData'), 'cfst-result.csv');
  try {
    fs.unlinkSync(outCsv);
  } catch {
    // ignore
  }
  sendStatus({
    level: 'info',
    text: '正在运行 Cloudflare 延迟测速（已关闭下载测速，约 1～5 分钟），请稍候…'
  });
  try {
    await runCfstBestIp(cfstDir, outCsv);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    sendStatus({ level: 'error', text: `测速失败：${msg}` });
    return { ok: false, error: msg };
  }
  let ip;
  try {
    ip = parseCfstResultCsv(outCsv);
  } catch {
    sendStatus({ level: 'error', text: '无法解析测速结果文件。' });
    return { ok: false, error: '无法解析测速结果' };
  }
  if (!ip) {
    sendStatus({ level: 'warn', text: '测速未得到有效 IP，可换网络或稍后再试。' });
    return { ok: false, error: '测速未得到有效 IP' };
  }
  sendStatus({
    level: 'info',
    text: `测速完成，候选 IP：${ip}。即将请求管理员权限写入本机 hosts…`
  });
  let applied;
  if (process.platform === 'win32') applied = await applyHostsEntryWin(host, ip);
  else if (process.platform === 'darwin') applied = await applyHostsEntryMac(host, ip);
  else applied = { ok: false, error: '当前系统暂不支持自动写入 hosts' };
  if (!applied.ok) {
    sendStatus({ level: 'error', text: `写入 hosts 失败：${applied.error}` });
    return { ok: false, error: applied.error, ip, host };
  }
  const hostsLine = `${ip}\t${host}    # RemoteAssist-CFST`;
  const clip = `${ip} ${host}  # RemoteAssist-CFST`;
  clipboard.writeText(clip);
  sendStatus({
    level: 'info',
    text: '已写入本机 hosts，并已将一行内容复制到剪贴板；若对方电脑在国内，也可让对方用管理员权限把同样一行加入 hosts。'
  });
  return { ok: true, ip, host, hostsLine };
});

ipcMain.handle('cfst-remove-hosts', async () => {
  let r;
  if (process.platform === 'win32') r = await removeHostsMarkerWin();
  else if (process.platform === 'darwin') r = await removeHostsMarkerMac();
  else r = { ok: false, error: '当前系统不支持' };
  if (r.ok) sendStatus({ level: 'info', text: '已清除本机 hosts 中带 # RemoteAssist-CFST 的优选记录。' });
  else sendStatus({ level: 'warn', text: `清除失败：${r.error}` });
  return r;
});
