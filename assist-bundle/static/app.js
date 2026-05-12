const form = document.querySelector("#connectForm");
const pageTitle = document.querySelector("#pageTitle");
const roomLabel = document.querySelector("#roomLabel");
const secretLabel = document.querySelector("#secretLabel");
const connectButton = document.querySelector("#connectButton");
const roomInput = document.querySelector("#room");
const secretInput = document.querySelector("#secret");
const statusText = document.querySelector("#statusText");
const dot = document.querySelector("#dot");
const screenImg = document.querySelector("#screen");
const empty = document.querySelector("#empty");
const enableInput = document.querySelector("#enableInput");
const enableInputLabel = document.querySelector("#enableInputLabel");
const textInput = document.querySelector("#textInput");
const clipboardBox = document.querySelector("#clipboardBox");
const disconnectButton = document.querySelector("#disconnect");
const sendCtrlAltDel = document.querySelector("#sendCtrlAltDel");
const fullscreenButton = document.querySelector("#fullscreen");
const screenWrap = document.querySelector("#screenWrap");
const imeInput = document.querySelector("#imeInput");
const smoothMode = document.querySelector("#smoothMode");
const clearMode = document.querySelector("#clearMode");
const inputModeToggle = document.querySelector("#inputModeToggle");
const saveScreenshot = document.querySelector("#saveScreenshot");
const fileInput = document.querySelector("#fileInput");
const uploadFile = document.querySelector("#uploadFile");
const refreshFiles = document.querySelector("#refreshFiles");
const fileStatus = document.querySelector("#fileStatus");
const fileList = document.querySelector("#fileList");
const filesTitle = document.querySelector("#filesTitle");
const filesDescription = document.querySelector("#filesDescription");

let socket = null;
let controlSocket = null;
let lastMouseMove = 0;
let lastMouseClientX = null;
let lastMouseClientY = null;
let mouseIsDown = false;
let pendingFrame = null;
let framePaintScheduled = false;
let currentObjectUrl = null;
let composing = false;
let lastCompositionAt = 0;
let currentStreamMode = {
  label: "Clear mode",
  fps: 20,
  quality: 95,
  maxWidth: 0,
  jpegSubsampling: 0,
};

let adaptiveSmoothEnabled = false;
let adaptiveProfileIndex = 1;
let lastAdaptiveAdjustAt = 0;
const frameIntervalsMs = [];
let lastFrameHostTimestamp = 0;
let lastVpnLagDowngradeAt = 0;
/** 控制器侧相邻两帧到达间隔（VPN 下用于发现「主机仍规律发包但链路积压」） */
const vpnReceiveGapsMs = [];
let lastClientFrameAtForVpn = 0;
/** 「控制端墙钟 − 主机帧时间戳」的最小值，等价于「单向延迟 + 时钟偏差」基线；当前值相对它的差即为「额外滞后」 */
let minHostLagSec = Infinity;
let lastHostLagExtraSec = 0;

/** 闲置自动升清：3 秒无远端操作即推顶档；任何操作立刻回到自适应 */
const IDLE_BOOST_DELAY_MS = 3000;
/**
 * idle 顶档：兼顾「字够清」与「单帧体积小，回切迅速」。
 * 帧大体积 ≈ 80-120KB，2Mbps VPN ~ 400ms 即可送完，回切自适应时不会感觉拖泥带水。
 */
const idleBoostProfile = {
  label: "Smooth mode (idle hi-q)",
  fps: 8,
  quality: 95,
  maxWidth: 0,
  jpegSubsampling: 0,
};
let lastUserActivityAt = 0;
let idleBoostActive = false;
let idleCheckTimer = null;
let preIdleAdaptiveIndex = -1;

function clearIdleTimer() {
  if (idleCheckTimer) {
    clearTimeout(idleCheckTimer);
    idleCheckTimer = null;
  }
}

function scheduleIdleCheck() {
  clearIdleTimer();
  if (!adaptiveSmoothEnabled || idleBoostActive) return;
  const since = performance.now() - lastUserActivityAt;
  const remaining = Math.max(0, IDLE_BOOST_DELAY_MS - since);
  idleCheckTimer = setTimeout(() => {
    idleCheckTimer = null;
    if (!adaptiveSmoothEnabled || idleBoostActive) return;
    if (performance.now() - lastUserActivityAt >= IDLE_BOOST_DELAY_MS) {
      applyIdleBoost();
    } else {
      scheduleIdleCheck();
    }
  }, remaining + 30);
}

function applyIdleBoost() {
  if (!adaptiveSmoothEnabled || idleBoostActive) return;
  preIdleAdaptiveIndex =
    adaptiveProfileIndex >= 0 ? adaptiveProfileIndex : getSmoothAdaptiveTune().startIndex;
  idleBoostActive = true;
  sendStreamMode(idleBoostProfile);
}

function restoreFromIdleBoost() {
  if (!idleBoostActive) return;
  idleBoostActive = false;
  if (!adaptiveSmoothEnabled) return;
  resetAdaptiveStats();
  const restoreIdx = Math.min(
    getSmoothProfiles().length - 1,
    preIdleAdaptiveIndex >= 0 ? preIdleAdaptiveIndex : getSmoothAdaptiveTune().startIndex,
  );
  adaptiveProfileIndex = -1;
  applySmoothAdaptiveProfile(restoreIdx);
}

function markUserActivity() {
  lastUserActivityAt = performance.now();
  if (idleBoostActive) restoreFromIdleBoost();
  scheduleIdleCheck();
}

const networkPathKey = "remoteAssistNetPath";

/** 直连：与 VPN 使用同一套清晰度/延迟平衡档位，避免两种路径体验不一致 */
const adaptiveSmoothProfilesDirect = [
  { fps: 4, quality: 68, maxWidth: 1280, jpegSubsampling: 2 },
  { fps: 5, quality: 72, maxWidth: 1366, jpegSubsampling: 2 },
  { fps: 6, quality: 76, maxWidth: 1440, jpegSubsampling: 2 },
  { fps: 7, quality: 80, maxWidth: 1440, jpegSubsampling: 2 },
  { fps: 8, quality: 84, maxWidth: 1600, jpegSubsampling: 2 },
  { fps: 10, quality: 88, maxWidth: 1600, jpegSubsampling: 2 },
  { fps: 12, quality: 90, maxWidth: 1920, jpegSubsampling: 2 },
  { fps: 14, quality: 92, maxWidth: 0, jpegSubsampling: 0 },
];

/**
 * VPN：兼顾文字可读 + 端到端 <1s。底档优先保字，顶档可看 1440 宽，全程 4:2:0 控带宽。
 * 升降档用「实际帧间隔/期望帧间隔」的比值（自校准 fps），并配合 adaptiveSmoothVpnLagGuard
 * 用相对基线的额外滞后（自动抵消两端时钟偏差）阻止/强制降档。
 */
const adaptiveSmoothProfilesVpn = [
  { fps: 4, quality: 68, maxWidth: 1280, jpegSubsampling: 2 },
  { fps: 5, quality: 72, maxWidth: 1366, jpegSubsampling: 2 },
  { fps: 6, quality: 76, maxWidth: 1440, jpegSubsampling: 2 },
  { fps: 7, quality: 80, maxWidth: 1440, jpegSubsampling: 2 },
  { fps: 8, quality: 84, maxWidth: 1600, jpegSubsampling: 2 },
  { fps: 10, quality: 88, maxWidth: 1600, jpegSubsampling: 2 },
  { fps: 12, quality: 90, maxWidth: 1920, jpegSubsampling: 2 },
  { fps: 14, quality: 92, maxWidth: 0, jpegSubsampling: 0 },
];

function getNetPath() {
  return localStorage.getItem(networkPathKey) === "vpn" ? "vpn" : "direct";
}

function getSmoothProfiles() {
  return getNetPath() === "vpn" ? adaptiveSmoothProfilesVpn : adaptiveSmoothProfilesDirect;
}

/**
 * downRatio/upRatio：实际帧间隔均值与「期望帧间隔（1/fps）」的比值，
 * >downRatio 视为链路堵塞，<upRatio 且未检测到额外滞后则升档。
 * cooldownMs：调档冷却。startIndex：进入流畅模式时的起始档。
 */
function getSmoothAdaptiveTune() {
  return getNetPath() === "vpn"
    ? { downRatio: 1.45, upRatio: 1.12, cooldownMs: 700, startIndex: 2 }
    : { downRatio: 1.45, upRatio: 1.12, cooldownMs: 700, startIndex: 2 };
}

function setNetPathRadioFromStorage() {
  const d = document.getElementById("netPathDirect");
  const v = document.getElementById("netPathVpn");
  if (!d || !v) return;
  if (getNetPath() === "vpn") {
    v.checked = true;
  } else {
    d.checked = true;
  }
}

function resetAdaptiveStats() {
  lastFrameHostTimestamp = 0;
  frameIntervalsMs.length = 0;
  lastAdaptiveAdjustAt = 0;
  lastClientFrameAtForVpn = 0;
  vpnReceiveGapsMs.length = 0;
  minHostLagSec = Infinity;
  lastHostLagExtraSec = 0;
}

function onNetPathChange() {
  const checked = document.querySelector("input[name='netPath']:checked");
  const val = checked?.value === "vpn" ? "vpn" : "direct";
  localStorage.setItem(networkPathKey, val);
  const hint = document.getElementById("netPathHint");
  if (hint) hint.textContent = tr("netPathHint");
  resetAdaptiveStats();
  idleBoostActive = false;
  clearIdleTimer();
  if (adaptiveSmoothEnabled) {
    adaptiveProfileIndex = -1;
    applySmoothAdaptiveProfile(getSmoothAdaptiveTune().startIndex);
    lastUserActivityAt = performance.now();
    scheduleIdleCheck();
  }
}

function applySmoothAdaptiveProfile(index) {
  const profiles = getSmoothProfiles();
  const i = Math.max(0, Math.min(profiles.length - 1, index));
  const cur = profiles[i];
  if (
    adaptiveProfileIndex === i &&
    adaptiveSmoothEnabled &&
    currentStreamMode.label?.startsWith("Smooth") &&
    currentStreamMode.fps === cur.fps &&
    currentStreamMode.quality === cur.quality &&
    currentStreamMode.maxWidth === cur.maxWidth &&
    currentStreamMode.jpegSubsampling === cur.jpegSubsampling
  ) {
    return;
  }
  adaptiveProfileIndex = i;
  sendStreamMode({
    label: "Smooth mode (adaptive)",
    fps: cur.fps,
    quality: cur.quality,
    maxWidth: cur.maxWidth,
    jpegSubsampling: cur.jpegSubsampling,
  });
}

function adaptiveSmoothTick(hostTimestampSec) {
  if (!adaptiveSmoothEnabled || idleBoostActive || typeof hostTimestampSec !== "number") return;
  const profiles = getSmoothProfiles();
  const tune = getSmoothAdaptiveTune();
  const now = performance.now();
  if (lastFrameHostTimestamp > 0) {
    const dtMs = (hostTimestampSec - lastFrameHostTimestamp) * 1000;
    if (dtMs > 5 && dtMs < 4000) {
      frameIntervalsMs.push(dtMs);
      if (frameIntervalsMs.length > 20) frameIntervalsMs.shift();
    }
  }
  lastFrameHostTimestamp = hostTimestampSec;
  if (frameIntervalsMs.length < 6) return;
  if (now - lastAdaptiveAdjustAt < tune.cooldownMs) return;

  const avgHost = frameIntervalsMs.reduce((a, b) => a + b, 0) / frameIntervalsMs.length;
  const targetFps = Math.max(1, currentStreamMode.fps || 1);
  const expectedMs = 1000 / targetFps;
  const hostRatio = avgHost / expectedMs;

  const recvAvg =
    vpnReceiveGapsMs.length >= 5
      ? vpnReceiveGapsMs.reduce((a, b) => a + b, 0) / vpnReceiveGapsMs.length
      : 0;
  const recvRatio = recvAvg > 0 ? recvAvg / expectedMs : hostRatio;
  const lagOk = lastHostLagExtraSec < 0.14;

  lastAdaptiveAdjustAt = now;
  if (
    (hostRatio > tune.downRatio || recvRatio > tune.downRatio + 0.1) &&
    adaptiveProfileIndex > 0
  ) {
    applySmoothAdaptiveProfile(adaptiveProfileIndex - 1);
  } else if (
    hostRatio < tune.upRatio &&
    recvRatio < tune.upRatio + 0.08 &&
    lagOk &&
    adaptiveProfileIndex < profiles.length - 1
  ) {
    applySmoothAdaptiveProfile(adaptiveProfileIndex + 1);
  }
}

/**
 * 帧头 timestamp 为被控端本帧开始采集前的 time.time()。
 * lagSec = 控制端墙钟 − 主机时间戳 = 单向延迟 + 时钟偏差。
 * 取最近见过的最小值 minHostLagSec 作为「基线（含偏差）」，extra = lagSec − 基线
 * 才是真正的「额外排队延迟」，对两端时钟不同步免疫。
 */
function adaptiveSmoothVpnLagGuard(hostTimestampSec) {
  if (typeof hostTimestampSec !== "number") return;
  const lagSec = Date.now() / 1000 - hostTimestampSec;
  if (!Number.isFinite(lagSec)) return;
  if (lagSec < minHostLagSec) minHostLagSec = lagSec;
  const extra = lagSec - minHostLagSec;
  lastHostLagExtraSec = extra;
  if (!adaptiveSmoothEnabled || idleBoostActive) return;
  const now = performance.now();
  if (now - lastVpnLagDowngradeAt < 260) return;
  if (extra < 0.24) return;
  let target = adaptiveProfileIndex;
  if (extra >= 0.6) target = 0;
  else if (extra >= 0.42) target = Math.max(0, adaptiveProfileIndex - 2);
  else if (extra >= 0.24) target = Math.max(0, adaptiveProfileIndex - 1);
  if (target < adaptiveProfileIndex) {
    lastVpnLagDowngradeAt = now;
    lastAdaptiveAdjustAt = now;
    frameIntervalsMs.length = 0;
    vpnReceiveGapsMs.length = 0;
    applySmoothAdaptiveProfile(target);
  }
}

const textDecoder = new TextDecoder();
const keyAliases = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "esc",
  " ": "space",
  PageUp: "pageup",
  PageDown: "pagedown",
  Insert: "insert",
  Delete: "delete",
  Home: "home",
  End: "end",
  Backspace: "backspace",
  Enter: "enter",
  Tab: "tab",
};
const savedCredentialsKey = "remoteAssistCredentials";
const uiLanguageKey = "remoteAssistUiLanguage";
let uiLanguage = localStorage.getItem(uiLanguageKey) || "zh";
let inputMode = "zh";

const i18n = {
  en: {
    title: "Remote Console",
    room: "Room",
    secret: "Secret",
    connect: "Connect",
    disconnected: "Disconnected",
    enableInput: "Send mouse and keyboard",
    textPlaceholder: "Type text, press Enter to send",
    clipboardPlaceholder: "Remote copied text appears here. Paste text here for remote paste.",
    ctrlAltDel: "Ctrl+Alt+Del",
    disconnect: "Disconnect",
    smooth: "Smooth mode",
    clear: "Clear mode",
    modeShortcutHint: "Toggle smooth/clear: Cmd/Ctrl + ;",
    language: "中文",
    saveScreenshot: "Save screenshot",
    fullscreen: "Fullscreen",
    netPath: "Network path",
    netPathDirect: "Direct",
    netPathVpn: "VPN on",
    netPathHint: "Used for smooth mode adaptive steps. Switch when your route changes.",
    files: "Files",
    filesDescription: "Remote Desktop Files",
    folderPrefix: "Folder",
    refresh: "Refresh",
    upload: "Upload to remote",
    fileHint: "Drop files on the remote screen to upload to Desktop.",
    empty: "Waiting for the host screen",
  },
  zh: {
    title: "远程控制台",
    room: "房间号",
    secret: "口令",
    connect: "连接",
    disconnected: "未连接",
    enableInput: "发送鼠标和键盘",
    textPlaceholder: "输入文字，按回车发送",
    clipboardPlaceholder: "远程复制的内容会显示在这里，也可以在这里粘贴后发送到远程。",
    ctrlAltDel: "Ctrl+Alt+Del",
    disconnect: "断开",
    smooth: "流畅模式",
    clear: "清晰模式",
    modeShortcutHint: "切换流畅/清晰：Cmd/Ctrl + ;（分号）",
    language: "English",
    saveScreenshot: "保存截图",
    fullscreen: "全屏",
    netPath: "当前网络",
    netPathDirect: "直连",
    netPathVpn: "已开 VPN",
    netPathHint: "用于流畅模式的自适应档位。换路线（如开关 VPN）时请改选。",
    files: "文件",
    filesDescription: "被控电脑桌面文件",
    folderPrefix: "目录",
    refresh: "刷新",
    upload: "上传到远程",
    fileHint: "把文件拖到远程屏幕上，会上传到被控电脑桌面。",
    empty: "等待被控端共享屏幕",
  },
};

function tr(key) {
  return i18n[uiLanguage][key] || i18n.en[key] || key;
}

function isMacPlatform() {
  const p = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  return p.includes("mac");
}

function getModeShortcutLabel() {
  return isMacPlatform() ? "⌘;" : "Ctrl+;";
}

function applyLanguage() {
  document.documentElement.lang = uiLanguage === "zh" ? "zh-CN" : "en";
  pageTitle.textContent = tr("title");
  roomLabel.textContent = tr("room");
  secretLabel.textContent = tr("secret");
  connectButton.textContent = tr("connect");
  enableInputLabel.textContent = tr("enableInput");
  textInput.placeholder = tr("textPlaceholder");
  clipboardBox.placeholder = tr("clipboardPlaceholder");
  sendCtrlAltDel.textContent = tr("ctrlAltDel");
  disconnectButton.textContent = tr("disconnect");
  const shortcutLabel = getModeShortcutLabel();
  smoothMode.textContent = `${tr("smooth")}  ${shortcutLabel}`;
  clearMode.textContent = `${tr("clear")}  ${shortcutLabel}`;
  smoothMode.title = tr("modeShortcutHint");
  clearMode.title = tr("modeShortcutHint");
  inputModeToggle.textContent = tr("language");
  saveScreenshot.textContent = tr("saveScreenshot");
  fullscreenButton.textContent = tr("fullscreen");
  filesTitle.textContent = tr("files");
  filesDescription.textContent = tr("filesDescription");
  refreshFiles.textContent = tr("refresh");
  uploadFile.textContent = tr("upload");
  fileStatus.textContent = tr("fileHint");
  empty.textContent = tr("empty");
  const netPathLabel = document.getElementById("netPathLabel");
  if (netPathLabel) netPathLabel.textContent = tr("netPath");
  const netPathDirectLabel = document.getElementById("netPathDirectLabel");
  if (netPathDirectLabel) netPathDirectLabel.textContent = tr("netPathDirect");
  const netPathVpnLabel = document.getElementById("netPathVpnLabel");
  if (netPathVpnLabel) netPathVpnLabel.textContent = tr("netPathVpn");
  const netPathHint = document.getElementById("netPathHint");
  if (netPathHint) netPathHint.textContent = tr("netPathHint");
  if (!socket || socket.readyState === WebSocket.CLOSED) setStatus(tr("disconnected"), false);
}

function toggleLanguage() {
  uiLanguage = uiLanguage === "zh" ? "en" : "zh";
  localStorage.setItem(uiLanguageKey, uiLanguage);
  applyLanguage();
}

function setStatus(text, online = false) {
  statusText.textContent = text;
  dot.classList.toggle("online", online);
}

function loadSavedCredentials() {
  try {
    const saved = JSON.parse(localStorage.getItem(savedCredentialsKey) || "{}");
    if (saved.room) roomInput.value = saved.room;
    if (saved.secret) secretInput.value = saved.secret;
  } catch {
    localStorage.removeItem(savedCredentialsKey);
  }
}

function saveCredentials(room, secret) {
  localStorage.setItem(savedCredentialsKey, JSON.stringify({ room, secret }));
}

function focusRemoteInput() {
  if (
    document.activeElement !== textInput &&
    document.activeElement !== clipboardBox &&
    document.activeElement !== roomInput &&
    document.activeElement !== secretInput
  ) {
    imeInput.focus({ preventScroll: true });
  }
}

function isLocalEditingTarget() {
  return (
    document.activeElement === textInput ||
    document.activeElement === clipboardBox ||
    document.activeElement === roomInput ||
    document.activeElement === secretInput ||
    document.activeElement === fileInput
  );
}

function isImeComposing(event) {
  return composing || event.isComposing || event.key === "Process" || event.keyCode === 229;
}

function markImeActivity() {
  lastCompositionAt = performance.now();
}

function shouldKeepKeyLocal(event) {
  if (document.activeElement !== imeInput) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;

  const imeKeys = new Set([
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Enter",
    " ",
    "Escape",
  ]);
  const recentIme = performance.now() - lastCompositionAt < 800;
  return imeKeys.has(event.key) && (isImeComposing(event) || recentIme || imeInput.value.length > 0);
}

function isLocalInputSwitchShortcut(event) {
  const key = event.key || "";
  const code = event.code || "";

  if (code === "Space" && (event.ctrlKey || event.metaKey)) return true;
  if ((key === "Shift" || key === "Alt") && event.altKey && event.shiftKey) return true;
  if ((key === "Shift" || key === "Control") && event.ctrlKey && event.shiftKey) return true;
  if (key === "CapsLock" || code === "CapsLock") return true;

  return false;
}

function normalizeRemoteKey(event) {
  if (keyAliases[event.key]) return keyAliases[event.key];
  if (/^F\d{1,2}$/.test(event.key)) return event.key.toLowerCase();
  if (event.code === "NumpadEnter") return "enter";
  if (event.code === "NumpadAdd") return "+";
  if (event.code === "NumpadSubtract") return "-";
  if (event.code === "NumpadMultiply") return "*";
  if (event.code === "NumpadDivide") return "/";
  if (event.code === "NumpadDecimal") return ".";
  if (/^Numpad\d$/.test(event.code)) return event.code.slice(-1);
  return (event.key || "").toLowerCase();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function refreshFileList() {
  fileStatus.textContent = "Loading files...";
  try {
    const response = await fetch("/api/files", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    fileStatus.textContent = `${tr("folderPrefix")}: ${payload.directory}`;
    fileList.replaceChildren();

    if (!payload.files.length) {
      const emptyItem = document.createElement("p");
      emptyItem.className = "hint";
      emptyItem.textContent = "No files yet.";
      fileList.append(emptyItem);
      return;
    }

    for (const item of payload.files) {
      const row = document.createElement("div");
      row.className = "file-item";

      const meta = document.createElement("div");
      meta.className = "file-meta";
      const name = document.createElement("strong");
      name.textContent = item.type === "folder" ? `[Folder] ${item.name}` : item.name;
      const details = document.createElement("span");
      details.textContent = `${item.type === "folder" ? "Folder" : formatSize(item.size)} - ${new Date(item.modified * 1000).toLocaleString()}`;
      meta.append(name, details);

      const actions = document.createElement("div");
      actions.className = "file-actions";
      const download = document.createElement("a");
      download.href = `/api/files/${encodeURIComponent(item.name)}`;
      download.textContent = item.type === "folder" ? "Download ZIP" : "Download";
      download.className = "file-link";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tiny secondary";
      remove.textContent = "Delete";
      remove.disabled = item.type === "folder";
      remove.addEventListener("click", async () => {
        await fetch(`/api/files/${encodeURIComponent(item.name)}`, { method: "DELETE" });
        refreshFileList();
      });
      actions.append(download, remove);
      row.append(meta, actions);
      fileList.append(row);
    }
  } catch (error) {
    fileStatus.textContent = `File list failed: ${error.message}`;
  }
}

async function uploadFiles(files) {
  const queue = Array.from(files || []).filter((file) => file && file.name);
  if (!queue.length) {
    fileStatus.textContent = "Choose or drop a file first.";
    return;
  }

  let uploaded = 0;
  for (const file of queue) {
    fileStatus.textContent = `Uploading ${file.name} (${uploaded + 1}/${queue.length})...`;
    const response = await fetch(`/api/files?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: await file.arrayBuffer(),
    });
    if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
    uploaded += 1;
  }

  fileInput.value = "";
  fileStatus.textContent = `Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"} to Desktop.`;
  refreshFileList();
}

function handleRemoteShortcut(event) {
  if (isLocalEditingTarget() || !enableInput.checked) return false;

  const shortcut = event.ctrlKey || event.metaKey;
  if (!shortcut || event.altKey) return false;

  const key = (event.key || "").toLowerCase();
  const code = event.code || "";

  if (key === "c" || code === "KeyC") {
    event.preventDefault();
    event.stopImmediatePropagation();
    sendControl({ kind: "copy" });
    return true;
  }

  if (key === "x" || code === "KeyX") {
    event.preventDefault();
    event.stopImmediatePropagation();
    sendControl({ kind: "cut" });
    return true;
  }

  if (key === "v" || code === "KeyV") {
    event.preventDefault();
    event.stopImmediatePropagation();
    pasteLocalClipboard();
    return true;
  }

  if (key === "a" || code === "KeyA") {
    event.preventDefault();
    event.stopImmediatePropagation();
    sendControl({ kind: "hotkey", keys: ["ctrl", "a"] });
    return true;
  }

  return false;
}

function handleLocalShortcut(event) {
  if (isLocalEditingTarget()) return false;
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return false;
  const key = event.key || "";
  const code = event.code || "";
  if (key === ";" || code === "Semicolon") {
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleStreamMode();
    return true;
  }
  return false;
}

document.addEventListener(
  "keydown",
  (event) => {
    if (handleLocalShortcut(event)) return;
    handleRemoteShortcut(event);
  },
  true,
);

function connect(room, secret) {
  if (socket) socket.close();
  if (controlSocket) controlSocket.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws/controller/${encodeURIComponent(room)}?secret=${encodeURIComponent(secret)}`;
  const controlUrl = `${protocol}//${location.host}/ws/controller_control/${encodeURIComponent(room)}?secret=${encodeURIComponent(secret)}`;
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  controlSocket = new WebSocket(controlUrl);
  controlSocket.addEventListener("open", () => {
    sendStreamMode(currentStreamMode);
  });
  controlSocket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const payload = JSON.parse(event.data);
    if (payload.type === "clipboard") receiveRemoteClipboard(payload.text || "");
  });

  socket.addEventListener("open", () => setStatus("Connected to relay, waiting for host", true));
  socket.addEventListener("close", () => {
    setStatus("Disconnected", false);
    idleBoostActive = false;
    clearIdleTimer();
  });
  socket.addEventListener("error", () => setStatus("Connection error", false));
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      const payload = JSON.parse(event.data);
      if (payload.type === "host_status") {
        setStatus(payload.online ? "Host online" : "Host offline", payload.online);
        if (payload.online && controlSocket?.readyState === WebSocket.OPEN) {
          sendStreamMode(currentStreamMode);
        }
      } else if (payload.type === "error") {
        setStatus(payload.message, false);
      } else if (payload.type === "clipboard") {
        receiveRemoteClipboard(payload.text || "");
      }
      return;
    }

    pendingFrame = event.data;
    if (!framePaintScheduled) {
      framePaintScheduled = true;
      requestAnimationFrame(paintLatestFrame);
    }
  });
}

function decodeFrame(buffer) {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0);
  const headerBytes = new Uint8Array(buffer, 4, headerLength);
  const header = JSON.parse(textDecoder.decode(headerBytes));
  const jpeg = buffer.slice(4 + headerLength);
  return {
    header,
    url: URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" })),
  };
}

function paintLatestFrame() {
  framePaintScheduled = false;
  if (!pendingFrame) return;

  const receiveAt = performance.now();
  if (adaptiveSmoothEnabled) {
    if (lastClientFrameAtForVpn > 0) {
      const g = receiveAt - lastClientFrameAtForVpn;
      if (g > 2 && g < 8000) {
        vpnReceiveGapsMs.push(g);
        if (vpnReceiveGapsMs.length > 15) vpnReceiveGapsMs.shift();
      }
    }
    lastClientFrameAtForVpn = receiveAt;
  }

  const buf = pendingFrame;
  pendingFrame = null;
  const { header, url } = decodeFrame(buf);
  if (adaptiveSmoothEnabled && typeof header.timestamp === "number") {
    adaptiveSmoothVpnLagGuard(header.timestamp);
    adaptiveSmoothTick(header.timestamp);
  }
  const previousUrl = currentObjectUrl;
  currentObjectUrl = url;
  screenWrap.style.setProperty("--screen-ratio", `${header.width} / ${header.height}`);

  screenImg.onload = () => {
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  };
  screenImg.src = url;
  screenImg.style.display = "block";
  empty.style.display = "none";
  const profilesNow = getSmoothProfiles();
  const tierInfo = adaptiveSmoothEnabled
    ? idleBoostActive
      ? ` | idle hi-q ${currentStreamMode.fps}fps q${currentStreamMode.quality} ${currentStreamMode.maxWidth || "full"}w`
      : ` | tier ${adaptiveProfileIndex + 1}/${profilesNow.length} ${currentStreamMode.fps}fps q${currentStreamMode.quality} ${currentStreamMode.maxWidth || "full"}w lag+${lastHostLagExtraSec.toFixed(2)}s`
    : "";
  setStatus(
    `${header.width}x${header.height} / src ${header.sourceWidth}x${header.sourceHeight}${tierInfo}`,
    true,
  );

  if (pendingFrame) {
    framePaintScheduled = true;
    requestAnimationFrame(paintLatestFrame);
  }
}

async function receiveRemoteClipboard(text) {
  if (!text) {
    setStatus("Remote copy returned no text", false);
    return;
  }
  clipboardBox.value = text;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Remote clipboard received ${text.length} chars`, true);
  } catch {
    setStatus("Remote clipboard placed in clipboard box", true);
  }
}

async function pasteLocalClipboard() {
  const fallback = clipboardBox.value || textInput.value;
  try {
    const text = await navigator.clipboard.readText();
    if (text) sendControl({ kind: "text", text });
    else if (fallback) sendControl({ kind: "text", text: fallback });
  } catch {
    if (fallback) sendControl({ kind: "text", text: fallback });
  }
}

function sendControl(event) {
  if (!enableInput.checked) return;
  const target = controlSocket?.readyState === WebSocket.OPEN ? controlSocket : socket;
  if (!target || target.readyState !== WebSocket.OPEN) return;
  target.send(JSON.stringify({ type: "control", event }));
  if (adaptiveSmoothEnabled) markUserActivity();
}

function sendStreamMode(mode) {
  const subs = mode.jpegSubsampling === 0 ? 0 : 2;
  currentStreamMode = { ...mode, jpegSubsampling: subs };
  const payload = {
    type: "control",
    event: {
      kind: "stream_mode",
      fps: mode.fps,
      quality: mode.quality,
      maxWidth: mode.maxWidth,
      jpegSubsampling: subs,
    },
  };
  const target = controlSocket?.readyState === WebSocket.OPEN ? controlSocket : socket;
  if (target?.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify(payload));
  }
  smoothMode.classList.toggle("active", mode.label.startsWith("Smooth"));
  clearMode.classList.toggle("active", mode.label.startsWith("Clear"));
  const mw = mode.maxWidth ? `maxW ${mode.maxWidth}` : "full res";
  const chroma = subs === 0 ? "4:4:4" : "4:2:0";
  setStatus(`${mode.label}: ${mw} / q${mode.quality} / ${mode.fps}fps / ${chroma}`, true);
}

function normalizedPoint(pointerEvent) {
  const rect = screenImg.getBoundingClientRect();
  return {
    x: (pointerEvent.clientX - rect.left) / rect.width,
    y: (pointerEvent.clientY - rect.top) / rect.height,
  };
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const room = roomInput.value.trim();
  const secret = secretInput.value.trim();
  saveCredentials(room, secret);
  connect(room, secret);
});

screenImg.addEventListener("mousemove", (event) => {
  const now = performance.now();
  if (now - lastMouseMove < 10) return;
  if (
    !mouseIsDown &&
    lastMouseClientX !== null &&
    lastMouseClientY !== null &&
    Math.abs(event.clientX - lastMouseClientX) < 2 &&
    Math.abs(event.clientY - lastMouseClientY) < 2
  ) {
    return;
  }
  lastMouseClientX = event.clientX;
  lastMouseClientY = event.clientY;
  lastMouseMove = now;
  sendControl({ kind: "move", ...normalizedPoint(event) });
});

screenImg.addEventListener("mousedown", (event) => {
  event.preventDefault();
  focusRemoteInput();
  mouseIsDown = true;
  sendControl({ kind: "mouse_down", button: event.button === 2 ? "right" : "left", ...normalizedPoint(event) });
});

screenImg.addEventListener("mouseup", (event) => {
  event.preventDefault();
  mouseIsDown = false;
  sendControl({ kind: "mouse_up", button: event.button === 2 ? "right" : "left", ...normalizedPoint(event) });
});

screenImg.addEventListener("click", (event) => {
  event.preventDefault();
  focusRemoteInput();
});

screenImg.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

screenImg.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    sendControl({ kind: "scroll", dy: event.deltaY < 0 ? 4 : -4 });
  },
  { passive: false },
);

window.addEventListener("keydown", (event) => {
  if (isLocalEditingTarget()) return;
  if (!enableInput.checked) return;

  if (handleRemoteShortcut(event)) return;

  if (document.activeElement === imeInput && (isImeComposing(event) || shouldKeepKeyLocal(event))) {
    return;
  }

  const shortcut = event.ctrlKey || event.metaKey;

  if (
    inputMode === "zh" &&
    document.activeElement === imeInput &&
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    return;
  }

  if (shortcut && event.key.toLowerCase() === "c") {
    event.preventDefault();
    sendControl({ kind: "copy" });
    return;
  }

  if (shortcut && event.key.toLowerCase() === "x") {
    event.preventDefault();
    sendControl({ kind: "cut" });
    return;
  }

  if (shortcut && event.key.toLowerCase() === "v") {
    event.preventDefault();
    pasteLocalClipboard();
    return;
  }

  if (shortcut && event.key.toLowerCase() === "a") {
    event.preventDefault();
    sendControl({ kind: "hotkey", keys: ["ctrl", "a"] });
    return;
  }

  event.preventDefault();

  const keys = [];
  if (event.ctrlKey || event.metaKey) keys.push("ctrl");
  if (event.altKey) keys.push("alt");
  if (event.shiftKey) keys.push("shift");
  if (!["Control", "Alt", "Shift", "Meta"].includes(event.key)) keys.push(normalizeRemoteKey(event));

  if (keys.length > 1) sendControl({ kind: "hotkey", keys });
  else if (keys.length === 1) sendControl({ kind: "key", key: keys[0] });
});

textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendControl({ kind: "text", text: textInput.value });
    textInput.value = "";
  }
});

screenWrap.addEventListener("mousedown", () => {
  focusRemoteInput();
});

imeInput.addEventListener("compositionstart", () => {
  composing = true;
  markImeActivity();
});

imeInput.addEventListener("compositionupdate", () => {
  markImeActivity();
});

imeInput.addEventListener("compositionend", (event) => {
  composing = false;
  markImeActivity();
  const text = event.data || imeInput.value;
  if (text) sendControl({ kind: "text", text });
  imeInput.value = "";
});

imeInput.addEventListener("beforeinput", (event) => {
  if (event.inputType && event.inputType.toLowerCase().includes("composition")) {
    markImeActivity();
  }
});

imeInput.addEventListener("input", () => {
  if (composing) return;
  const text = imeInput.value;
  if (text) sendControl({ kind: "text", text });
  imeInput.value = "";
});

imeInput.addEventListener("paste", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const text = event.clipboardData?.getData("text/plain") || "";
  if (text) sendControl({ kind: "text", text });
  imeInput.value = "";
});

document.addEventListener("copy", (event) => {
  if (isLocalEditingTarget() || !enableInput.checked) return;
  event.preventDefault();
  sendControl({ kind: "copy" });
});

document.addEventListener("cut", (event) => {
  if (isLocalEditingTarget() || !enableInput.checked) return;
  event.preventDefault();
  sendControl({ kind: "cut" });
});

document.addEventListener("paste", (event) => {
  if (isLocalEditingTarget() || !enableInput.checked) return;
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") || clipboardBox.value || textInput.value;
  if (text) sendControl({ kind: "text", text });
});

sendCtrlAltDel.addEventListener("click", () => {
  sendControl({ kind: "hotkey", keys: ["ctrl", "alt", "delete"] });
});

function activateSmoothMode() {
  adaptiveSmoothEnabled = true;
  idleBoostActive = false;
  adaptiveProfileIndex = -1;
  resetAdaptiveStats();
  applySmoothAdaptiveProfile(getSmoothAdaptiveTune().startIndex);
  lastUserActivityAt = performance.now();
  scheduleIdleCheck();
}

function activateClearMode() {
  adaptiveSmoothEnabled = false;
  idleBoostActive = false;
  clearIdleTimer();
  resetAdaptiveStats();
  sendStreamMode({
    label: "Clear mode",
    fps: 20,
    quality: 95,
    maxWidth: 0,
    jpegSubsampling: 0,
  });
}

function toggleStreamMode() {
  if (currentStreamMode.label?.startsWith("Smooth")) {
    activateClearMode();
  } else {
    activateSmoothMode();
  }
}

smoothMode.addEventListener("click", activateSmoothMode);
clearMode.addEventListener("click", activateClearMode);

inputModeToggle.addEventListener("click", toggleLanguage);

saveScreenshot.addEventListener("click", async () => {
  if (!currentObjectUrl) {
    setStatus("No screen frame to save yet", false);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const link = document.createElement("a");
  link.href = currentObjectUrl;
  link.download = `remote-screenshot-${stamp}.jpg`;
  document.body.append(link);
  link.click();
  link.remove();
  setStatus("Screenshot saved to Downloads", true);
  saveScreenshot.textContent = "Saved";
  setTimeout(() => {
    saveScreenshot.textContent = tr("saveScreenshot");
  }, 1500);
});

uploadFile.addEventListener("click", async () => {
  try {
    await uploadFiles(fileInput.files);
  } catch (error) {
    fileStatus.textContent = `Upload failed: ${error.message}`;
  }
});

refreshFiles.addEventListener("click", refreshFileList);

for (const dropTarget of [document.body, screenWrap]) {
  dropTarget.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    screenWrap.classList.add("drag-over");
    fileStatus.textContent = "Release to upload to the remote Desktop.";
  });

  dropTarget.addEventListener("dragleave", (event) => {
    if (event.target !== dropTarget) return;
    screenWrap.classList.remove("drag-over");
  });

  dropTarget.addEventListener("drop", async (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    screenWrap.classList.remove("drag-over");
    try {
      await uploadFiles(event.dataTransfer.files);
    } catch (error) {
      fileStatus.textContent = `Upload failed: ${error.message}`;
    }
  });
}

disconnectButton.addEventListener("click", () => {
  if (socket) socket.close();
  if (controlSocket) controlSocket.close();
});

fullscreenButton.addEventListener("click", async () => {
  if (!document.fullscreenElement) {
    await screenWrap.requestFullscreen();
  } else {
    await document.exitFullscreen();
  }
  setTimeout(focusRemoteInput, 0);
});

document.addEventListener("fullscreenchange", () => {
  fullscreenButton.textContent = document.fullscreenElement ? (uiLanguage === "zh" ? "退出全屏" : "Exit fullscreen") : tr("fullscreen");
  setTimeout(focusRemoteInput, 0);
});

window.addEventListener("mouseup", (event) => {
  if (!mouseIsDown) return;
  mouseIsDown = false;
  if (event.target === screenImg) return;
  sendControl({ kind: "mouse_up", button: "left", ...normalizedPoint(event) });
});

document.querySelectorAll("input[name='netPath']").forEach((el) => {
  el.addEventListener("change", onNetPathChange);
});
setNetPathRadioFromStorage();

refreshFileList();
loadSavedCredentials();
applyLanguage();
