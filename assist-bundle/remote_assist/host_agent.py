from __future__ import annotations

import argparse
import asyncio
import io
import json
import secrets
import string
import struct
import sys
import time

_IS_MAC = sys.platform == "darwin"
from dataclasses import dataclass
from urllib.parse import quote

import mss
import pyautogui
import pyperclip
import websockets
from PIL import Image, ImageChops


pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0


ALPHABET = string.ascii_uppercase + string.digits
KEY_ALIASES = {
    "arrowup": "up",
    "arrowdown": "down",
    "arrowleft": "left",
    "arrowright": "right",
    "escape": "esc",
    "esc": "esc",
    "enter": "enter",
    "return": "enter",
    "backspace": "backspace",
    "delete": "delete",
    "del": "delete",
    "tab": "tab",
    " ": "space",
    "spacebar": "space",
    "pageup": "pageup",
    "pagedown": "pagedown",
    "home": "home",
    "end": "end",
    "insert": "insert",
    "control": "ctrl",
    "meta": "win",
}


def make_code(length: int = 8) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


@dataclass
class ScreenState:
    left: int
    top: int
    width: int
    height: int


@dataclass
class StreamSettings:
    fps: int
    quality: int
    max_width: int
    jpeg_subsampling: int = 2  # 0 = 4:4:4 最高色度清晰度；2 = 4:2:0 体积更小（流畅/弱网）


@dataclass
class SharedState:
    settings: StreamSettings
    screen: ScreenState | None = None


@dataclass
class EncodedFrame:
    jpeg: bytes
    state: ScreenState
    stream_size: tuple[int, int]
    region: tuple[int, int, int, int]
    full: bool
    changed: bool = True


def encode_frame(
    sct: mss.mss,
    monitor: dict[str, int],
    quality: int,
    max_width: int,
    jpeg_subsampling: int = 2,
    *,
    previous_image: Image.Image | None = None,
    force_full: bool = False,
) -> tuple[EncodedFrame | None, Image.Image]:
    shot = sct.grab(monitor)
    image = Image.frombytes("RGB", shot.size, shot.rgb)
    if max_width > 0 and image.width > max_width:
        height = round(image.height * (max_width / image.width))
        image = image.resize((max_width, height), Image.Resampling.BILINEAR)
    state = ScreenState(
        left=monitor["left"],
        top=monitor["top"],
        width=monitor["width"],
        height=monitor["height"],
    )

    full = force_full or previous_image is None or previous_image.size != image.size
    bbox = (0, 0, image.width, image.height)
    if not full:
        diff_bbox = ImageChops.difference(previous_image, image).getbbox()
        if diff_bbox is None:
            return None, image
        changed_area = (diff_bbox[2] - diff_bbox[0]) * (diff_bbox[3] - diff_bbox[1])
        full = changed_area / max(1, image.width * image.height) > 0.55
        if not full:
            pad = 16
            bbox = (
                max(0, diff_bbox[0] - pad),
                max(0, diff_bbox[1] - pad),
                min(image.width, diff_bbox[2] + pad),
                min(image.height, diff_bbox[3] + pad),
            )

    region_image = image if full else image.crop(bbox)
    buffer = io.BytesIO()
    sub = 0 if jpeg_subsampling == 0 else 2
    region_quality = quality if full else min(95, quality + 6)
    region_image.save(buffer, format="JPEG", quality=region_quality, optimize=False, subsampling=sub)
    return (
        EncodedFrame(
            jpeg=buffer.getvalue(),
            state=state,
            stream_size=image.size,
            region=bbox,
            full=full,
        ),
        image,
    )


def pack_frame(
    frame: EncodedFrame,
    *,
    frame_timestamp: float | None = None,
) -> bytes:
    ts = time.time() if frame_timestamp is None else frame_timestamp
    x1, y1, x2, y2 = frame.region
    header = json.dumps(
        {
            "type": "frame",
            "width": frame.stream_size[0],
            "height": frame.stream_size[1],
            "sourceWidth": frame.state.width,
            "sourceHeight": frame.state.height,
            "regionX": x1,
            "regionY": y1,
            "regionWidth": x2 - x1,
            "regionHeight": y2 - y1,
            "full": frame.full,
            "timestamp": ts,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    return struct.pack(">I", len(header)) + header + frame.jpeg


def scale_point(state: ScreenState, x: float, y: float) -> tuple[int, int]:
    screen_x = round(state.left + max(0.0, min(1.0, x)) * state.width)
    screen_y = round(state.top + max(0.0, min(1.0, y)) * state.height)
    right = state.left + state.width - 1
    bottom = state.top + state.height - 1
    if state.width > 4:
        screen_x = max(state.left + 2, min(right - 2, screen_x))
    else:
        screen_x = max(state.left, min(right, screen_x))
    if state.height > 4:
        screen_y = max(state.top + 2, min(bottom - 2, screen_y))
    else:
        screen_y = max(state.top, min(bottom, screen_y))
    return screen_x, screen_y


def normalize_key(key: object) -> str:
    value = str(key or "").lower()
    return KEY_ALIASES.get(value, value)


def handle_control(payload: dict, state: ScreenState | None, allow_keyboard: bool) -> None:
    event = payload.get("event", {})
    kind = event.get("kind")

    if kind == "stream_mode":
        return

    if state is None:
        return

    if kind == "move":
        x, y = scale_point(state, float(event["x"]), float(event["y"]))
        pyautogui.moveTo(x, y, _pause=False)
    elif kind == "mouse_down":
        x, y = scale_point(state, float(event["x"]), float(event["y"]))
        button = event.get("button", "left")
        pyautogui.moveTo(x, y, _pause=False)
        pyautogui.mouseDown(button=button, _pause=False)
    elif kind == "mouse_up":
        x, y = scale_point(state, float(event["x"]), float(event["y"]))
        button = event.get("button", "left")
        pyautogui.moveTo(x, y, _pause=False)
        pyautogui.mouseUp(button=button, _pause=False)
    elif kind == "click":
        x, y = scale_point(state, float(event["x"]), float(event["y"]))
        button = event.get("button", "left")
        pyautogui.click(x=x, y=y, button=button, _pause=False)
    elif kind == "scroll":
        pyautogui.scroll(int(event.get("dy", 0)), _pause=False)
    elif kind == "key" and allow_keyboard:
        key = normalize_key(event.get("key", ""))
        if key:
            pyautogui.press(key, _pause=False)
    elif kind == "hotkey" and allow_keyboard:
        keys = [normalize_key(key) for key in event.get("keys", []) if key]
        if keys:
            pyautogui.hotkey(*keys, _pause=False)
    elif kind == "text" and allow_keyboard:
        text = str(event.get("text", ""))
        if text:
            pyperclip.copy(text)
            if _IS_MAC:
                pyautogui.hotkey("command", "v", _pause=False)
            else:
                pyautogui.hotkey("ctrl", "v", _pause=False)


async def sender(ws, monitor_index: int, shared: SharedState) -> None:
    last_status = 0.0
    previous_image: Image.Image | None = None
    last_full_frame_at = 0.0
    last_mode_signature: tuple[int, int, int] | None = None
    with mss.mss() as sct:
        monitor = sct.monitors[monitor_index]
        while True:
            started = time.monotonic()
            frame_t0 = time.time()
            settings = shared.settings
            mode_signature = (settings.quality, settings.max_width, settings.jpeg_subsampling)
            force_full = (
                previous_image is None
                or mode_signature != last_mode_signature
                or started - last_full_frame_at > 2.5
            )
            encoded, previous_image = encode_frame(
                sct,
                monitor,
                settings.quality,
                settings.max_width,
                settings.jpeg_subsampling,
                previous_image=previous_image,
                force_full=force_full,
            )
            last_mode_signature = mode_signature
            if encoded is not None:
                await ws.send(pack_frame(encoded, frame_timestamp=frame_t0))
                shared.screen = encoded.state
                if encoded.full:
                    last_full_frame_at = started

            if started - last_status > 3:
                await ws.send(json.dumps({"type": "status", "message": "host sharing screen"}))
                last_status = started

            elapsed = time.monotonic() - started
            delay = 1 / max(1, settings.fps)
            await asyncio.sleep(max(0.0, delay - elapsed))


async def receiver(ws, allow_keyboard: bool, shared: SharedState) -> None:
    async for message in ws:
        payload = json.loads(message)
        if payload.get("type") == "control":
            event = payload.get("event", {})
            if event.get("kind") == "stream_mode":
                shared.settings.fps = max(1, min(20, int(event.get("fps", shared.settings.fps))))
                shared.settings.quality = max(20, min(95, int(event.get("quality", shared.settings.quality))))
                shared.settings.max_width = max(0, int(event.get("maxWidth", shared.settings.max_width)))
                js = event.get("jpegSubsampling", event.get("jpeg_subsampling"))
                if js is not None:
                    shared.settings.jpeg_subsampling = 0 if int(js) == 0 else 2
            elif event.get("kind") in {"copy", "cut"} and allow_keyboard:
                before = ""
                try:
                    before = pyperclip.paste()
                except Exception:
                    pass
                mod = "command" if _IS_MAC else "ctrl"
                pyautogui.hotkey(mod, "x" if event.get("kind") == "cut" else "c", _pause=False)
                text = before
                for _ in range(20):
                    await asyncio.sleep(0.1)
                    try:
                        current = pyperclip.paste()
                    except Exception:
                        current = ""
                    if current:
                        text = current
                        break
                await ws.send(json.dumps({"type": "clipboard", "text": text}))
            else:
                try:
                    handle_control(payload, shared.screen, allow_keyboard)
                except pyautogui.FailSafeException:
                    print("Ignored PyAutoGUI fail-safe control event.", file=sys.stderr)


async def run(args: argparse.Namespace) -> None:
    room = args.room or make_code()
    secret = args.secret or make_code(10)
    url = f"{args.relay.rstrip('/')}/ws/host/{quote(room)}?secret={quote(secret)}"
    control_url = f"{args.relay.rstrip('/')}/ws/host_control/{quote(room)}?secret={quote(secret)}"
    controller_url = args.relay.rstrip("/").replace("wss://", "https://").replace("ws://", "http://")

    print("Remote Assist Host")
    print("==================")
    print(f"Room:   {room}")
    print(f"Secret: {secret}")
    print(f"Open controller: {controller_url}/")
    print("Keep this window open while sharing. Move mouse to a screen corner to trigger pyautogui fail-safe.")
    print()

    while True:
        try:
            async with (
                websockets.connect(
                    url,
                    max_size=8 * 1024 * 1024,
                    max_queue=1,
                    compression=None,
                    ping_interval=20,
                    ping_timeout=60,
                ) as ws,
                websockets.connect(
                    control_url,
                    max_size=1024 * 1024,
                    max_queue=1,
                    compression=None,
                    ping_interval=20,
                    ping_timeout=60,
                ) as control_ws,
            ):
                shared = SharedState(
                    settings=StreamSettings(
                        fps=args.fps,
                        quality=args.quality,
                        max_width=args.max_width,
                        jpeg_subsampling=args.jpeg_subsampling,
                    )
                )
                await asyncio.gather(
                    sender(
                        ws,
                        monitor_index=args.monitor,
                        shared=shared,
                    ),
                    receiver(control_ws, allow_keyboard=not args.no_keyboard, shared=shared),
                )
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print(f"Disconnected: {exc}. Reconnecting in 2s...", file=sys.stderr)
            await asyncio.sleep(2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Consent-based remote assistance host agent.")
    parser.add_argument("--relay", default="ws://127.0.0.1:8765", help="relay base websocket URL, e.g. ws://host:8765")
    parser.add_argument("--room", help="room code; generated when omitted")
    parser.add_argument("--secret", help="shared secret; generated when omitted")
    parser.add_argument("--fps", type=int, default=20, help="screen frames per second")
    parser.add_argument("--quality", type=int, default=95, help="JPEG quality 1-95")
    parser.add_argument("--max-width", type=int, default=0, help="resize stream width; use 0 for original size")
    parser.add_argument(
        "--jpeg-subsampling",
        type=int,
        choices=(0, 2),
        default=0,
        help="JPEG chroma: 0=4:4:4 clearest, 2=4:2:0 smaller (smooth/adaptive)",
    )
    parser.add_argument("--monitor", type=int, default=1, help="mss monitor index")
    parser.add_argument("--no-keyboard", action="store_true", help="disable remote keyboard input")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        asyncio.run(run(parse_args()))
    except KeyboardInterrupt:
        print("\nStopped sharing.")
