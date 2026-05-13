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
const webrtcVideo = document.querySelector("#webrtcVideo");
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
const uploadOverlay = document.querySelector("#uploadOverlay");
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
const screenCtx = screenImg.getContext("2d", { alpha: false });

let socket = null;
let controlSocket = null;
let webrtcSocket = null;
let peerConnection = null;
let webrtcActive = false;
let webrtcReconnectTimer = null;
let webrtcRoom = "";
let webrtcSecret = "";
let pendingMoveEvent = null;
let moveFlushScheduled = false;
let lastMouseMove = 0;
let lastMouseClientX = null;
let lastMouseClientY = null;
let mouseIsDown = false;
let pendingFrame = null;
let framePaintScheduled = false;
let latestFrameBlob = null;
let pendingFrameDrops = 0;
let lastStreamFeedbackAt = 0;
let lastReceiveGapMs = 0;
let pasteFallbackTimer = null;
let clipboardProbeTimer = null;
let lastRemoteClipboardText = "";
let hasBaseFrame = false;
let lastFullFrameRequestAt = 0;
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
const uploadTimeoutMs = 60 * 1000;
const recentUploadedFiles = new Set();
let uploadOverlayTimer = null;
let remoteTextBuffer = "";
let remoteTextFlushTimer = null;
/** 控制器侧相邻两帧到达间隔（VPN 下用于发现「主机仍规律发包但链路积压」） */
const vpnReceiveGapsMs = [];
let lastClientFrameAtForVpn = 0;
/** 「控制端墙钟 − 主机帧时间戳」的最小值，等价于「单向延迟 + 时钟偏差」基线；当前值相对它的差即为「额外滞后」 */
let minHostLagSec = Infinity;
let lastHostLagExtraSec = 0;

/** 闲置自动升清：1 秒先提到中清，3 秒推满清；任何操作立刻回到低延迟 */
const IDLE_MID_BOOST_DELAY_MS = 1000;
const IDLE_FULL_BOOST_DELAY_MS = 3000;
/**
 * idle 顶档：兼顾「字够清」与「单帧体积小，回切迅速」。
 * 帧大体积 ≈ 80-120KB，2Mbps VPN ~ 400ms 即可送完，回切自适应时不会感觉拖泥带水。
 */
const interactiveProfile = {
  label: "Smooth mode (interactive)",
  fps: 12,
  quality: 62,
  maxWidth: 1280,
  jpegSubsampling: 2,
};
const idleMidBoostProfile = {
  label: "Smooth mode (idle mid-q)",
  fps: 10,
  quality: 86,
  maxWidth: 1600,
  jpegSubsampling: 2,
};
const idleBoostProfile = {
  label: "Smooth mode (idle hi-q)",
  fps: 8,
  quality: 95,
  maxWidth: 0,
  jpegSubsampling: 0,
};
let lastUserActivityAt = 0;
let idleBoostActive = false;
let idleBoostStage = "none";
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
  if (!adaptiveSmoothEnabled || idleBoostStage === "full") return;
  const since = performance.now() - lastUserActivityAt;
  const targetDelay =
    idleBoostStage === "mid" ? IDLE_FULL_BOOST_DELAY_MS : IDLE_MID_BOOST_DELAY_MS;
  const remaining = Math.max(0, targetDelay - since);
  idleCheckTimer = setTimeout(() => {
    idleCheckTimer = null;
    if (!adaptiveSmoothEnabled || idleBoostStage === "full") return;
    const idleMs = performance.now() - lastUserActivityAt;
    if (idleMs >= IDLE_FULL_BOOST_DELAY_MS) {
      applyIdleBoost("full");
    } else if (idleMs >= IDLE_MID_BOOST_DELAY_MS) {
      applyIdleBoost("mid");
      scheduleIdleCheck();
    } else {
      scheduleIdleCheck();
    }
  }, remaining + 30);
}

function applyIdleBoost(stage = "full") {
  if (!adaptiveSmoothEnabled) return;
  if (idleBoostStage === stage || idleBoostStage === "full") return;
  if (idleBoostStage === "none") {
    preIdleAdaptiveIndex =
      adaptiveProfileIndex >= 0 ? adaptiveProfileIndex : getSmoothAdaptiveTune().startIndex;
  }
  idleBoostActive = true;
  idleBoostStage = stage;
  sendStreamMode(stage === "mid" ? idleMidBoostProfile : idleBoostProfile);
}

function restoreFromIdleBoost() {
  if (idleBoostStage === "none") return;
  idleBoostActive = false;
  idleBoostStage = "none";
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

function streamModeMatches(profile) {
  const subs = profile.jpegSubsampling === 0 ? 0 : 2;
  return (
    currentStreamMode.label === profile.label &&
    currentStreamMode.fps === profile.fps &&
    currentStreamMode.quality === profile.quality &&
    currentStreamMode.maxWidth === profile.maxWidth &&
    currentStreamMode.jpegSubsampling === subs
  );
}

function applyInteractiveProfileForControl() {
  if (!adaptiveSmoothEnabled || streamModeMatches(interactiveProfile)) return;
  resetAdaptiveStats();
  adaptiveProfileIndex = getSmoothAdaptiveTune().startIndex;
  sendStreamMode(interactiveProfile);
}

const networkPathKey = "remoteAssistNetPath";
const experimentalWebRtcKey = "remoteAssistExperimentalWebRtc";

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
  pendingFrameDrops = 0;
  lastStreamFeedbackAt = 0;
  lastReceiveGapMs = 0;
}

function onNetPathChange() {
  const checked = document.querySelector("input[name='netPath']:checked");
  const val = checked?.value === "vpn" ? "vpn" : "direct";
  localStorage.setItem(networkPathKey, val);
  const hint = document.getElementById("netPathHint");
  if (hint) hint.textContent = tr("netPathHint");
  resetAdaptiveStats();
  idleBoostActive = false;
  idleBoostStage = "none";
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

function sendStreamFeedback({ header, decodeMs, paintMs, droppedFrames, receiveGapMs }) {
  if (!adaptiveSmoothEnabled || typeof header.timestamp !== "number") return;
  if (idleBoostStage === "full") return;
  const now = performance.now();
  const severe = lastHostLagExtraSec * 1000 > 220 || decodeMs > 80 || droppedFrames > 0;
  if (!severe && now - lastStreamFeedbackAt < 650) return;
  if (severe && now - lastStreamFeedbackAt < 220) return;
  lastStreamFeedbackAt = now;
  const target = controlSocket?.readyState === WebSocket.OPEN ? controlSocket : socket;
  if (target?.readyState !== WebSocket.OPEN) return;
  target.send(
    JSON.stringify({
      type: "control",
      event: {
        kind: "stream_feedback",
        extraLagMs: Math.max(0, Math.round(lastHostLagExtraSec * 1000)),
        decodeMs: Math.round(decodeMs),
        paintMs: Math.round(paintMs),
        droppedFrames,
        receiveGapMs: Math.round(receiveGapMs || 0),
      },
    }),
  );
}

function sendControlRaw(event) {
  const target = controlSocket?.readyState === WebSocket.OPEN ? controlSocket : socket;
  if (target?.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify({ type: "control", event }));
  }
}

function requestFullFrame(force = false) {
  const now = performance.now();
  if (!force && now - lastFullFrameRequestAt < 500) return;
  lastFullFrameRequestAt = now;
  sendControlRaw({ kind: "request_full_frame" });
}

function setJpegFallbackEnabled(enabled) {
  sendControlRaw({ kind: "jpeg_stream", enabled });
}

function clearWebRtcReconnect() {
  if (webrtcReconnectTimer) {
    clearTimeout(webrtcReconnectTimer);
    webrtcReconnectTimer = null;
  }
}

function scheduleWebRtcReconnect() {
  if (!webrtcRoom || !webrtcSecret || webrtcReconnectTimer) return;
  if (controlSocket?.readyState !== WebSocket.OPEN) return;
  webrtcReconnectTimer = setTimeout(() => {
    webrtcReconnectTimer = null;
    startWebRtc(webrtcRoom, webrtcSecret);
  }, 1800);
}

function closeWebRtc({ reconnect = false } = {}) {
  webrtcActive = false;
  if (!reconnect) clearWebRtcReconnect();
  if (webrtcSocket) {
    webrtcSocket.close();
    webrtcSocket = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (webrtcVideo.srcObject) {
    for (const track of webrtcVideo.srcObject.getTracks()) track.stop();
    webrtcVideo.srcObject = null;
  }
  webrtcVideo.style.display = "none";
  if (screenImg.width && screenImg.height) screenImg.style.display = "block";
  setJpegFallbackEnabled(true);
  if (reconnect) scheduleWebRtcReconnect();
}

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== "complete") return;
      pc.removeEventListener("icegatheringstatechange", done);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, 1200);
  });
}

function startWebRtc(room, secret) {
  webrtcRoom = room;
  webrtcSecret = secret;
  clearWebRtcReconnect();
  closeWebRtc();
  if (localStorage.getItem(experimentalWebRtcKey) !== "1") return;
  if (!("RTCPeerConnection" in window)) return;
  setStatus("WebRTC signaling...", true);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws/webrtc_controller/${encodeURIComponent(room)}?secret=${encodeURIComponent(secret)}`;
  webrtcSocket = new WebSocket(url);
  webrtcSocket.addEventListener("message", async (event) => {
    if (typeof event.data !== "string") return;
    const payload = JSON.parse(event.data);
    if (payload.type === "offer") {
      if (peerConnection) peerConnection.close();
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
        ],
      });
      peerConnection = pc;
      pc.addEventListener("track", (trackEvent) => {
        webrtcVideo.srcObject = trackEvent.streams[0] || new MediaStream([trackEvent.track]);
      });
      pc.addEventListener("connectionstatechange", () => {
        if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
          closeWebRtc({ reconnect: true });
        }
      });
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc);
      if (webrtcSocket?.readyState === WebSocket.OPEN) {
        webrtcSocket.send(
          JSON.stringify({
            type: pc.localDescription.type,
            sdp: pc.localDescription.sdp,
          }),
        );
      }
      setStatus(`WebRTC answer sent (${payload.codec || "auto codec"})`, true);
    }
  });
  webrtcSocket.addEventListener("close", () => {
    if (webrtcActive || peerConnection) closeWebRtc({ reconnect: true });
  });
  webrtcSocket.addEventListener("error", () => {
    setStatus("WebRTC signaling failed; using JPEG fallback", false);
    closeWebRtc({ reconnect: true });
  });
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

function positionImeInputFromPointer(event) {
  const rect = screenWrap.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width - 2, event.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height - 24, event.clientY - rect.top));
  imeInput.style.setProperty("--ime-left", `${x}px`);
  imeInput.style.setProperty("--ime-top", `${y}px`);
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

function isPlainPrintableKey(event) {
  return (
    event.key?.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !isImeComposing(event)
  );
}

function flushRemoteTextBuffer() {
  if (remoteTextFlushTimer) {
    clearTimeout(remoteTextFlushTimer);
    remoteTextFlushTimer = null;
  }
  const text = remoteTextBuffer;
  remoteTextBuffer = "";
  if (text) sendControl({ kind: "text", text });
}

function queueRemoteText(text) {
  remoteTextBuffer += text;
  if (remoteTextBuffer.length >= 24 || /[\s.,;:!?，。；：！？]$/.test(remoteTextBuffer)) {
    flushRemoteTextBuffer();
    return;
  }
  if (remoteTextFlushTimer) clearTimeout(remoteTextFlushTimer);
  remoteTextFlushTimer = setTimeout(flushRemoteTextBuffer, 60);
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

function uploadedFileMessage(names) {
  if (!names.length) return "Uploaded to Desktop";
  if (names.length === 1) return `Uploaded ${names[0]} to Desktop`;
  return `Uploaded ${names.length} files to Desktop`;
}

function setUploadStatus(message, state = "active") {
  fileStatus.textContent = message;
  if (!uploadOverlay) return;
  uploadOverlay.textContent = message;
  uploadOverlay.hidden = false;
  uploadOverlay.classList.toggle("upload-overlay-success", state === "success");
  uploadOverlay.classList.toggle("upload-overlay-error", state === "error");
  if (uploadOverlayTimer) {
    clearTimeout(uploadOverlayTimer);
    uploadOverlayTimer = null;
  }
  if (state !== "active") {
    uploadOverlayTimer = setTimeout(() => {
      uploadOverlay.hidden = true;
      uploadOverlayTimer = null;
    }, state === "success" ? 4500 : 9000);
  }
}

function xhrUpload(url, body, label, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = uploadTimeoutMs;
    xhr.setRequestHeader("content-type", "application/octet-stream");

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || typeof onProgress !== "function") return;
      onProgress(event.loaded, event.total);
    });

    xhr.addEventListener("load", () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: async () => xhr.responseText || "",
        json: async () => (xhr.responseText ? JSON.parse(xhr.responseText) : null),
      });
    });
    xhr.addEventListener("timeout", () => {
      reject(new Error(`${label}: upload timed out. Refresh or drop the file again.`));
    });
    xhr.addEventListener("error", () => {
      reject(new Error(`${label}: network error during upload.`));
    });
    xhr.addEventListener("abort", () => {
      reject(new Error(`${label}: upload was aborted.`));
    });

    xhr.send(body);
  });
}

async function refreshFileList(options = {}) {
  const highlightNames = new Set(options.highlightNames || []);
  const pinNames = new Set(options.pinNames || []);
  if (!options.keepStatus) fileStatus.textContent = "Loading files...";
  try {
    const response = await fetch("/api/files", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    fileStatus.textContent = options.successMessage
      ? `${options.successMessage}. ${tr("folderPrefix")}: ${payload.directory}`
      : `${tr("folderPrefix")}: ${payload.directory}`;
    fileList.replaceChildren();

    const files = Array.isArray(payload.files) ? [...payload.files] : [];
    files.sort((a, b) => {
      const aPinned = pinNames.has(a.name) ? 1 : 0;
      const bPinned = pinNames.has(b.name) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return (b.modified || 0) - (a.modified || 0);
    });

    if (!files.length) {
      const emptyItem = document.createElement("p");
      emptyItem.className = "hint";
      emptyItem.textContent = "No files yet.";
      fileList.append(emptyItem);
      return;
    }

    for (const item of files) {
      const row = document.createElement("div");
      row.className = "file-item";
      if (highlightNames.has(item.name) || recentUploadedFiles.has(item.name)) {
        row.classList.add("file-item-new");
      }

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
        recentUploadedFiles.delete(item.name);
        refreshFileList();
      });
      actions.append(download, remove);
      row.append(meta, actions);
      fileList.append(row);
    }

    const firstPinned = fileList.querySelector(".file-item-new");
    if (firstPinned) firstPinned.scrollIntoView({ block: "nearest" });
  } catch (error) {
    fileStatus.textContent = `File list failed: ${error.message}`;
  }
}

async function uploadFiles(files) {
  const queue = normalizeUploadQueue(files);
  if (!queue.length) {
    setUploadStatus("Choose or drop a file first.", "error");
    return;
  }

  let uploaded = 0;
  const uploadedNames = [];
  for (const file of queue) {
    const uploadName = uploadFileName(file, uploaded);
    const result = await uploadSingleFile(file, uploadName, uploaded + 1, queue.length);
    const finalName = result?.name || uploadName;
    uploadedNames.push(finalName);
    recentUploadedFiles.add(finalName);
    setTimeout(() => recentUploadedFiles.delete(finalName), 30000);
    uploaded += 1;
  }

  fileInput.value = "";
  const doneMessage = uploadedFileMessage(uploadedNames);
  setUploadStatus(`${doneMessage}. Refreshing list...`, "success");
  await refreshFileList({
    highlightNames: uploadedNames,
    pinNames: uploadedNames,
    successMessage: doneMessage,
  });
  setUploadStatus(doneMessage, "success");
}

async function uploadSingleFile(file, uploadName, itemIndex, itemTotal) {
  const directLimit = 8 * 1024 * 1024;
  const statusForPercent = (percent) =>
    `Uploading ${uploadName} ${Math.max(0, Math.min(100, Math.round(percent)))}%... (${itemIndex}/${itemTotal})`;
  if (file.size <= directLimit) {
    setUploadStatus(statusForPercent(0));
    const response = await xhrUpload(
      `/api/files?name=${encodeURIComponent(uploadName)}`,
      file,
      uploadName,
      (loaded, total) => {
        const percent = total > 0 ? (loaded / total) * 100 : 0;
        setUploadStatus(statusForPercent(percent));
      },
    );
    setUploadStatus(statusForPercent(100));
    if (!response.ok) throw new Error(await uploadErrorMessage(response, uploadName));
    return response.json();
  }

  const chunkSize = 8 * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / chunkSize);
  const uploadId =
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${uploadName}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  let finalPayload = null;

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    setUploadStatus(statusForPercent((start / file.size) * 100));
    const response = await xhrUpload(
      `/api/files/chunk?name=${encodeURIComponent(uploadName)}&upload_id=${encodeURIComponent(uploadId)}&index=${index}&total=${totalChunks}`,
      file.slice(start, end),
      uploadName,
      (loaded) => {
        const percent = file.size > 0 ? ((start + loaded) / file.size) * 100 : 100;
        setUploadStatus(statusForPercent(percent));
      },
    );
    if (!response.ok) throw new Error(await uploadErrorMessage(response, uploadName));
    finalPayload = await response.json();
  }

  if (!finalPayload?.complete) {
    throw new Error(`${uploadName}: upload did not finish`);
  }
  return finalPayload;
}

async function uploadErrorMessage(response, uploadName) {
  let detail = "";
  try {
    const payload = await response.json();
    detail = payload.detail ? ` - ${payload.detail}` : "";
  } catch {
    try {
      detail = ` - ${await response.text()}`;
    } catch {
      detail = "";
    }
  }
  return `${uploadName}: HTTP ${response.status}${detail}`;
}

function showUploadError(error) {
  const message = error?.message || String(error);
  const timedOut = /timed out|abort/i.test(message);
  setUploadStatus(
    timedOut
      ? `Upload timed out. Refresh or drop the file again. (${message})`
      : `Upload failed: ${message}`,
    "error",
  );
}

function fileExtension(file) {
  const fromName = (file.name || "").split(".").pop();
  if (fromName && fromName !== file.name && fromName.length <= 8) return fromName.toLowerCase();
  if (file.type === "image/jpeg") return "jpg";
  if (file.type === "image/webp") return "webp";
  if (file.type === "image/gif") return "gif";
  if (file.type === "image/png") return "png";
  return "bin";
}

function uploadFallbackName(file, index = 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = fileExtension(file);
  return `${(file.type || "").startsWith("image/") ? "screenshot" : "file"}-${stamp}${index ? `-${index + 1}` : ""}.${ext}`;
}

function isGeneratedImageName(name) {
  return /(_cgi-bin|webwxgetmsgimg|msgid=|skey=|wx_webfilehelper|clipboard)/i.test(name || "");
}

function uploadFileName(file, index = 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = fileExtension(file);
  if (!file.name) {
    return uploadFallbackName(file, index);
  }
  if ((file.type || "").startsWith("image/") && isGeneratedImageName(file.name)) {
    return `image-${stamp}${index ? `-${index + 1}` : ""}.${ext}`;
  }
  return file.name || `file-${stamp}${index ? `-${index + 1}` : ""}.${ext}`;
}

function normalizeUploadQueue(files) {
  const normalized = [];
  const seen = new Set();
  for (const [index, file] of Array.from(files || []).entries()) {
    if (!file || typeof file.size !== "number") continue;
    const fallbackName = uploadFileName(file, index);
    const name = file.name && !isGeneratedImageName(file.name) ? file.name : fallbackName;
    const key = `${name}|${file.size}|${file.type || ""}|${file.lastModified || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (file.name === name) {
      normalized.push(file);
    } else {
      normalized.push(new File([file], name, { type: file.type || "application/octet-stream" }));
    }
  }
  return normalized;
}

function clipboardFiles(event) {
  const files = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const seen = new Set();
  const addFile = (file) => {
    if (!file) return;
    const key = `${file.size}|${file.type || ""}|${file.lastModified || 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };
  for (const file of Array.from(event.clipboardData?.files || [])) addFile(file);
  for (const item of Array.from(event.clipboardData?.items || [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (file.name && !isGeneratedImageName(file.name)) {
      addFile(file);
      continue;
    }
    const ext = file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png";
    addFile(new File([file], `clipboard-${stamp}.${ext}`, { type: file.type || "image/png" }));
  }
  return files;
}

async function uploadClipboardFiles(event) {
  const files = clipboardFiles(event);
  if (!files.length) return false;
  clearPasteFallback();
  event.preventDefault();
  event.stopPropagation();
  try {
    await uploadFiles(files);
  } catch (error) {
    showUploadError(error);
  }
  return true;
}

function clearPasteFallback() {
  if (pasteFallbackTimer) {
    clearTimeout(pasteFallbackTimer);
    pasteFallbackTimer = null;
  }
}

function schedulePasteFallback() {
  clearPasteFallback();
  pasteFallbackTimer = setTimeout(() => {
    pasteFallbackTimer = null;
    if (imeInput.value) {
      const text = imeInput.value;
      imeInput.value = "";
      sendControl({ kind: "text", text });
      setStatus(`Pasted ${text.length} chars to remote`, true);
      return;
    }
    pasteLocalClipboard();
  }, 180);
}

function scheduleRemoteClipboardProbe(delay = 350) {
  if (clipboardProbeTimer) clearTimeout(clipboardProbeTimer);
  clipboardProbeTimer = setTimeout(() => {
    clipboardProbeTimer = null;
    sendControlRaw({ kind: "read_clipboard" });
  }, delay);
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
    if (event.metaKey && !event.ctrlKey) {
      sendControl({ kind: "hotkey", keys: ["command", "v"] });
      setStatus("Remote Command+V sent", true);
    } else {
      focusRemoteInput();
      schedulePasteFallback();
    }
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
  closeWebRtc();
  hasBaseFrame = false;
  pendingFrame = null;
  pendingFrameDrops = 0;
  lastFullFrameRequestAt = 0;
  if (screenImg.width || screenImg.height) {
    screenCtx.clearRect(0, 0, screenImg.width, screenImg.height);
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws/controller/${encodeURIComponent(room)}?secret=${encodeURIComponent(secret)}`;
  const controlUrl = `${protocol}//${location.host}/ws/controller_control/${encodeURIComponent(room)}?secret=${encodeURIComponent(secret)}`;
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  controlSocket = new WebSocket(controlUrl);
  controlSocket.addEventListener("open", () => {
    sendStreamMode(currentStreamMode);
    requestFullFrame(true);
    startWebRtc(room, secret);
  });
  controlSocket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const payload = JSON.parse(event.data);
  if (payload.type === "clipboard") receiveRemoteClipboard(payload.text || "");
    if (payload.type === "clipboard_status") receiveRemoteClipboardStatus(payload.text || "");
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
          requestFullFrame(true);
        }
      } else if (payload.type === "error") {
        setStatus(payload.message, false);
      } else if (payload.type === "clipboard") {
        receiveRemoteClipboard(payload.text || "");
      } else if (payload.type === "clipboard_status") {
        receiveRemoteClipboardStatus(payload.text || "");
      }
      return;
    }

    const header = peekFrameHeader(event.data);
    if (partialFrameNeedsBase(header)) {
      pendingFrameDrops += 1;
      requestFullFrame();
      return;
    }
    if (pendingFrame) pendingFrameDrops += 1;
    pendingFrame = event.data;
    if (!framePaintScheduled) {
      framePaintScheduled = true;
      requestAnimationFrame(paintLatestFrame);
    }
  });
}

async function decodeFrame(buffer) {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0);
  const headerBytes = new Uint8Array(buffer, 4, headerLength);
  const header = JSON.parse(textDecoder.decode(headerBytes));
  const jpeg = buffer.slice(4 + headerLength);
  const blob = new Blob([jpeg], { type: "image/jpeg" });
  return {
    header,
    blob,
    bitmap: await createImageBitmap(blob),
  };
}

function peekFrameHeader(buffer) {
  try {
    const view = new DataView(buffer);
    const headerLength = view.getUint32(0);
    const headerBytes = new Uint8Array(buffer, 4, headerLength);
    return JSON.parse(textDecoder.decode(headerBytes));
  } catch {
    return null;
  }
}

function partialFrameNeedsBase(header) {
  return (
    header?.full === false &&
    (!hasBaseFrame || screenImg.width !== header.width || screenImg.height !== header.height)
  );
}

async function paintLatestFrame() {
  framePaintScheduled = false;
  if (!pendingFrame) return;

  const receiveAt = performance.now();
  if (adaptiveSmoothEnabled) {
    if (lastClientFrameAtForVpn > 0) {
      const g = receiveAt - lastClientFrameAtForVpn;
      if (g > 2 && g < 8000) {
        vpnReceiveGapsMs.push(g);
        if (vpnReceiveGapsMs.length > 15) vpnReceiveGapsMs.shift();
        lastReceiveGapMs = g;
      }
    }
    lastClientFrameAtForVpn = receiveAt;
  }

  const buf = pendingFrame;
  pendingFrame = null;
  const droppedFrames = pendingFrameDrops;
  pendingFrameDrops = 0;
  let decoded;
  const decodeStart = performance.now();
  try {
    decoded = await decodeFrame(buf);
  } catch {
    if (pendingFrame) {
      framePaintScheduled = true;
      requestAnimationFrame(paintLatestFrame);
    }
    return;
  }
  const decodeMs = performance.now() - decodeStart;
  const { header, blob, bitmap } = decoded;
  if (adaptiveSmoothEnabled && typeof header.timestamp === "number") {
    adaptiveSmoothVpnLagGuard(header.timestamp);
    adaptiveSmoothTick(header.timestamp);
  }
  const paintStart = performance.now();
  screenWrap.style.setProperty("--screen-ratio", `${header.width} / ${header.height}`);

  const fullFrame = header.full !== false;
  const canvasNeedsResize = screenImg.width !== header.width || screenImg.height !== header.height;
  if (!fullFrame && (!hasBaseFrame || canvasNeedsResize)) {
    bitmap.close();
    requestFullFrame();
    if (pendingFrame) {
      framePaintScheduled = true;
      requestAnimationFrame(paintLatestFrame);
    }
    return;
  }
  const regionX = Math.max(0, Math.floor(header.regionX || 0));
  const regionY = Math.max(0, Math.floor(header.regionY || 0));
  const regionWidth = Math.max(1, Math.floor(header.regionWidth || header.width));
  const regionHeight = Math.max(1, Math.floor(header.regionHeight || header.height));
  if (canvasNeedsResize || fullFrame) {
    if (screenImg.width !== header.width) screenImg.width = header.width;
    if (screenImg.height !== header.height) screenImg.height = header.height;
    if (fullFrame) screenCtx.clearRect(0, 0, header.width, header.height);
  }
  screenCtx.drawImage(bitmap, regionX, regionY, regionWidth, regionHeight);
  if (fullFrame) hasBaseFrame = true;
  bitmap.close();
  const paintMs = performance.now() - paintStart;
  sendStreamFeedback({
    header,
    decodeMs,
    paintMs,
    droppedFrames,
    receiveGapMs: lastReceiveGapMs,
  });
  latestFrameBlob = null;
  if (!webrtcActive) {
    screenImg.style.display = "block";
    empty.style.display = "none";
  }
  const profilesNow = getSmoothProfiles();
  const tierInfo = adaptiveSmoothEnabled
    ? idleBoostActive
      ? ` | ${idleBoostStage} idle ${currentStreamMode.fps}fps q${currentStreamMode.quality} ${currentStreamMode.maxWidth || "full"}w`
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
  lastRemoteClipboardText = text;
  clipboardBox.value = text;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Remote clipboard received ${text.length} chars`, true);
  } catch {
    setStatus("Remote clipboard placed in clipboard box", true);
  }
}

async function receiveRemoteClipboardStatus(text) {
  const value = text || "";
  const preview = value.replace(/\s+/g, " ").slice(0, 64);
  if (!value) {
    setStatus("Remote clipboard is empty", false);
    return;
  }
  clipboardBox.value = value;
  if (value !== lastRemoteClipboardText) {
    lastRemoteClipboardText = value;
    try {
      await navigator.clipboard.writeText(value);
      setStatus(`Remote clipboard synced: ${preview}${value.length > 64 ? "..." : ""}`, true);
      return;
    } catch {
      setStatus(`Remote clipboard changed: ${preview}${value.length > 64 ? "..." : ""}`, true);
      return;
    }
  }
  setStatus(`Remote clipboard now: ${preview}${value.length > 64 ? "..." : ""}`, true);
}

async function pasteLocalClipboard() {
  const fallback = clipboardBox.value || textInput.value;
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      sendControl({ kind: "text", text });
      setStatus(`Pasted ${text.length} chars to remote`, true);
    } else if (fallback) {
      sendControl({ kind: "text", text: fallback });
      setStatus(`Pasted ${fallback.length} chars to remote`, true);
    }
  } catch {
    if (fallback) {
      sendControl({ kind: "text", text: fallback });
      setStatus(`Pasted ${fallback.length} chars to remote`, true);
    } else {
      setStatus("Clipboard permission blocked. Press paste again with the remote screen focused.", false);
    }
  }
}

function shouldTreatAsUserActivity(event) {
  if (!event || !event.kind) return false;
  if (event.kind === "move") return mouseIsDown;
  return ![
    "stream_feedback",
    "request_full_frame",
    "jpeg_stream",
    "read_clipboard",
  ].includes(event.kind);
}

function sendControl(event, immediate = false) {
  if (!enableInput.checked) return;
  if (event.kind === "move" && !immediate) {
    pendingMoveEvent = event;
    if (!moveFlushScheduled) {
      moveFlushScheduled = true;
      requestAnimationFrame(() => {
        moveFlushScheduled = false;
        const move = pendingMoveEvent;
        pendingMoveEvent = null;
        if (move) sendControl(move, true);
      });
    }
    return;
  }
  if (pendingMoveEvent) {
    const move = pendingMoveEvent;
    pendingMoveEvent = null;
    sendControl(move, true);
  }
  const target = controlSocket?.readyState === WebSocket.OPEN ? controlSocket : socket;
  if (!target || target.readyState !== WebSocket.OPEN) return;
  if (adaptiveSmoothEnabled && shouldTreatAsUserActivity(event)) {
    markUserActivity();
    applyInteractiveProfileForControl();
  }
  target.send(JSON.stringify({ type: "control", event }));
}

function sendStreamMode(mode) {
  const subs = mode.jpegSubsampling === 0 ? 0 : 2;
  const previousMode = currentStreamMode;
  const modeChanged =
    previousMode.fps !== mode.fps ||
    previousMode.quality !== mode.quality ||
    previousMode.maxWidth !== mode.maxWidth ||
    previousMode.jpegSubsampling !== subs;
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
    if (modeChanged) {
      hasBaseFrame = false;
      pendingFrame = null;
      pendingFrameDrops = 0;
      requestFullFrame(true);
    }
  }
  smoothMode.classList.toggle("active", mode.label.startsWith("Smooth"));
  clearMode.classList.toggle("active", mode.label.startsWith("Clear"));
  const mw = mode.maxWidth ? `maxW ${mode.maxWidth}` : "full res";
  const chroma = subs === 0 ? "4:4:4" : "4:2:0";
  setStatus(`${mode.label}: ${mw} / q${mode.quality} / ${mode.fps}fps / ${chroma}`, true);
}

function normalizedPoint(pointerEvent) {
  const rect = (webrtcActive ? webrtcVideo : screenImg).getBoundingClientRect();
  return {
    x: (pointerEvent.clientX - rect.left) / rect.width,
    y: (pointerEvent.clientY - rect.top) / rect.height,
  };
}

webrtcVideo.addEventListener("playing", () => {
  webrtcActive = true;
  if (webrtcVideo.videoWidth && webrtcVideo.videoHeight) {
    screenWrap.style.setProperty("--screen-ratio", `${webrtcVideo.videoWidth} / ${webrtcVideo.videoHeight}`);
  }
  screenImg.style.display = "none";
  webrtcVideo.style.display = "block";
  empty.style.display = "none";
  setJpegFallbackEnabled(false);
  setStatus(`WebRTC video active ${webrtcVideo.videoWidth || ""}x${webrtcVideo.videoHeight || ""}`, true);
});

webrtcVideo.addEventListener("resize", () => {
  if (webrtcVideo.videoWidth && webrtcVideo.videoHeight) {
    screenWrap.style.setProperty("--screen-ratio", `${webrtcVideo.videoWidth} / ${webrtcVideo.videoHeight}`);
  }
});

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
  positionImeInputFromPointer(event);
  focusRemoteInput();
  mouseIsDown = true;
  sendControl({ kind: "mouse_down", button: event.button === 2 ? "right" : "left", ...normalizedPoint(event) });
});

screenImg.addEventListener("mouseup", (event) => {
  event.preventDefault();
  mouseIsDown = false;
  sendControl({ kind: "mouse_up", button: event.button === 2 ? "right" : "left", ...normalizedPoint(event) });
  scheduleRemoteClipboardProbe();
});

screenImg.addEventListener("click", (event) => {
  event.preventDefault();
  positionImeInputFromPointer(event);
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

webrtcVideo.addEventListener("mousemove", (event) => {
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

webrtcVideo.addEventListener("mousedown", (event) => {
  event.preventDefault();
  positionImeInputFromPointer(event);
  focusRemoteInput();
  mouseIsDown = true;
  sendControl({ kind: "mouse_down", button: event.button === 2 ? "right" : "left", ...normalizedPoint(event) });
});

webrtcVideo.addEventListener("mouseup", (event) => {
  event.preventDefault();
  mouseIsDown = false;
  sendControl({ kind: "mouse_up", button: event.button === 2 ? "right" : "left", ...normalizedPoint(event) });
  scheduleRemoteClipboardProbe();
});

webrtcVideo.addEventListener("click", (event) => {
  event.preventDefault();
  positionImeInputFromPointer(event);
  focusRemoteInput();
});

webrtcVideo.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

webrtcVideo.addEventListener(
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

  if (document.activeElement === imeInput && isPlainPrintableKey(event)) {
    event.preventDefault();
    queueRemoteText(event.key);
    return;
  }

  if (shortcut && event.key.toLowerCase() === "c") {
    event.preventDefault();
    flushRemoteTextBuffer();
    sendControl({ kind: "copy" });
    return;
  }

  if (shortcut && event.key.toLowerCase() === "x") {
    event.preventDefault();
    flushRemoteTextBuffer();
    sendControl({ kind: "cut" });
    return;
  }

  if (shortcut && event.key.toLowerCase() === "v") {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.metaKey && !event.ctrlKey) {
      sendControl({ kind: "hotkey", keys: ["command", "v"] });
      setStatus("Remote Command+V sent", true);
    } else {
      focusRemoteInput();
      schedulePasteFallback();
    }
    return;
  }

  if (shortcut && event.key.toLowerCase() === "a") {
    event.preventDefault();
    flushRemoteTextBuffer();
    sendControl({ kind: "hotkey", keys: ["ctrl", "a"] });
    return;
  }

  event.preventDefault();
  flushRemoteTextBuffer();

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
  const inputType = (event.inputType || "").toLowerCase();
  if (inputType === "insertfrompaste") {
    const text = event.dataTransfer?.getData("text/plain") || event.data || "";
    if (text) {
      clearPasteFallback();
      event.preventDefault();
      sendControl({ kind: "text", text });
      setStatus(`Pasted ${text.length} chars to remote`, true);
      imeInput.value = "";
    }
    return;
  }
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

imeInput.addEventListener("paste", async (event) => {
  if (await uploadClipboardFiles(event)) {
    imeInput.value = "";
    return;
  }
  clearPasteFallback();
  event.preventDefault();
  event.stopPropagation();
  const text = event.clipboardData?.getData("text/plain") || "";
  if (text) {
    sendControl({ kind: "text", text });
    setStatus(`Pasted ${text.length} chars to remote`, true);
  }
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

document.addEventListener("paste", async (event) => {
  if (isLocalEditingTarget() || !enableInput.checked) return;
  if (await uploadClipboardFiles(event)) return;
  clearPasteFallback();
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") || clipboardBox.value || textInput.value;
  if (text) {
    sendControl({ kind: "text", text });
    setStatus(`Pasted ${text.length} chars to remote`, true);
  }
});

sendCtrlAltDel.addEventListener("click", () => {
  sendControl({ kind: "hotkey", keys: ["ctrl", "alt", "delete"] });
});

function activateSmoothMode() {
  adaptiveSmoothEnabled = true;
  idleBoostActive = false;
  idleBoostStage = "none";
  adaptiveProfileIndex = -1;
  resetAdaptiveStats();
  applySmoothAdaptiveProfile(getSmoothAdaptiveTune().startIndex);
  lastUserActivityAt = performance.now();
  scheduleIdleCheck();
}

function activateClearMode() {
  adaptiveSmoothEnabled = false;
  idleBoostActive = false;
  idleBoostStage = "none";
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
  if (!screenImg.width || !screenImg.height) {
    setStatus("No screen frame to save yet", false);
    return;
  }
  screenImg.toBlob(
    (blob) => {
      if (!blob) {
        setStatus("Screenshot failed", false);
        return;
      }
      latestFrameBlob = blob;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = `remote-screenshot-${stamp}.jpg`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Screenshot saved to Downloads", true);
      saveScreenshot.textContent = "Saved";
      setTimeout(() => {
        saveScreenshot.textContent = tr("saveScreenshot");
      }, 1500);
    },
    "image/jpeg",
    0.95,
  );
});

uploadFile.addEventListener("click", async () => {
  try {
    await uploadFiles(fileInput.files);
  } catch (error) {
    showUploadError(error);
  }
});

refreshFiles.addEventListener("click", refreshFileList);

for (const dropTarget of [document.body, screenWrap, screenImg, webrtcVideo]) {
  dropTarget.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
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
    event.stopPropagation();
    screenWrap.classList.remove("drag-over");
    try {
      await uploadFiles(event.dataTransfer.files);
    } catch (error) {
      showUploadError(error);
    }
  });
}

disconnectButton.addEventListener("click", () => {
  if (socket) socket.close();
  if (controlSocket) controlSocket.close();
  closeWebRtc();
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
  if (event.target === screenImg || event.target === webrtcVideo) return;
  sendControl({ kind: "mouse_up", button: "left", ...normalizedPoint(event) });
  scheduleRemoteClipboardProbe();
});

document.querySelectorAll("input[name='netPath']").forEach((el) => {
  el.addEventListener("change", onNetPathChange);
});
setNetPathRadioFromStorage();

refreshFileList();
loadSavedCredentials();
applyLanguage();
