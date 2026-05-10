const form = document.querySelector("#connectForm");
const roomInput = document.querySelector("#room");
const secretInput = document.querySelector("#secret");
const statusText = document.querySelector("#statusText");
const dot = document.querySelector("#dot");
const screenImg = document.querySelector("#screen");
const empty = document.querySelector("#empty");
const enableInput = document.querySelector("#enableInput");
const textInput = document.querySelector("#textInput");
const clipboardBox = document.querySelector("#clipboardBox");
const disconnectButton = document.querySelector("#disconnect");
const sendCtrlAltDel = document.querySelector("#sendCtrlAltDel");
const fullscreenButton = document.querySelector("#fullscreen");
const screenWrap = document.querySelector("#screenWrap");
const imeInput = document.querySelector("#imeInput");
const smoothMode = document.querySelector("#smoothMode");
const clearMode = document.querySelector("#clearMode");
const remoteCopy = document.querySelector("#remoteCopy");
const remotePaste = document.querySelector("#remotePaste");

let socket = null;
let controlSocket = null;
let lastMouseMove = 0;
let mouseIsDown = false;
let pendingFrame = null;
let framePaintScheduled = false;
let currentObjectUrl = null;
let composing = false;
let currentStreamMode = { label: "Smooth", fps: 8, quality: 45, maxWidth: 0 };
const textDecoder = new TextDecoder();

function setStatus(text, online = false) {
  statusText.textContent = text;
  dot.classList.toggle("online", online);
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
    document.activeElement === secretInput
  );
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

document.addEventListener("keydown", handleRemoteShortcut, true);

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
  socket.addEventListener("close", () => setStatus("Disconnected", false));
  socket.addEventListener("error", () => setStatus("Connection error", false));
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      const payload = JSON.parse(event.data);
      if (payload.type === "host_status") {
        setStatus(payload.online ? "Host online" : "Host offline", payload.online);
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

  const { header, url } = decodeFrame(pendingFrame);
  pendingFrame = null;
  const previousUrl = currentObjectUrl;
  currentObjectUrl = url;

  screenImg.onload = () => {
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  };
  screenImg.src = url;
  screenImg.style.display = "block";
  empty.style.display = "none";
  setStatus(`Viewing ${header.width}x${header.height} / source ${header.sourceWidth}x${header.sourceHeight}`, true);
}

async function receiveRemoteClipboard(text) {
  clipboardBox.value = text;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Remote copied ${text.length} chars`, true);
  } catch {
    setStatus("Remote copy placed in clipboard box", true);
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
}

function sendStreamMode(mode) {
  currentStreamMode = mode;
  const payload = {
    type: "control",
    event: {
      kind: "stream_mode",
      fps: mode.fps,
      quality: mode.quality,
      maxWidth: mode.maxWidth,
    },
  };
  const target = controlSocket?.readyState === WebSocket.OPEN ? controlSocket : socket;
  if (target?.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify(payload));
  }
  smoothMode.classList.toggle("active", mode.label.startsWith("Smooth"));
  clearMode.classList.toggle("active", mode.label.startsWith("Clear"));
  setStatus(`${mode.label}: 1920x1080 / q${mode.quality} / ${mode.fps}fps`, true);
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
  connect(roomInput.value.trim(), secretInput.value.trim());
});

screenImg.addEventListener("mousemove", (event) => {
  const now = performance.now();
  if (now - lastMouseMove < 10) return;
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

  const shortcut = event.ctrlKey || event.metaKey;

  if (document.activeElement === imeInput && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return;
  }

  if (shortcut && event.key.toLowerCase() === "c") {
    event.preventDefault();
    sendControl({ kind: "copy" });
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
  if (!["Control", "Alt", "Shift", "Meta"].includes(event.key)) keys.push(event.key.toLowerCase());

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
});

imeInput.addEventListener("compositionend", (event) => {
  composing = false;
  const text = event.data || imeInput.value;
  if (text) sendControl({ kind: "text", text });
  imeInput.value = "";
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

document.addEventListener("paste", (event) => {
  if (isLocalEditingTarget() || !enableInput.checked) return;
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") || clipboardBox.value || textInput.value;
  if (text) sendControl({ kind: "text", text });
});

sendCtrlAltDel.addEventListener("click", () => {
  sendControl({ kind: "hotkey", keys: ["ctrl", "alt", "delete"] });
});

smoothMode.addEventListener("click", () => {
  sendStreamMode({ label: "Smooth mode", fps: 8, quality: 45, maxWidth: 0 });
});

clearMode.addEventListener("click", () => {
  sendStreamMode({ label: "Clear mode", fps: 6, quality: 80, maxWidth: 0 });
});

remoteCopy.addEventListener("click", () => {
  sendControl({ kind: "copy" });
});

remotePaste.addEventListener("click", () => {
  pasteLocalClipboard();
});

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
  fullscreenButton.textContent = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
  setTimeout(focusRemoteInput, 0);
});

window.addEventListener("mouseup", (event) => {
  if (!mouseIsDown) return;
  mouseIsDown = false;
  if (event.target === screenImg) return;
  sendControl({ kind: "mouse_up", button: "left", ...normalizedPoint(event) });
});
