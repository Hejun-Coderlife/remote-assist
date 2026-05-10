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
from dataclasses import dataclass
from urllib.parse import quote

import mss
import pyautogui
import pyperclip
import websockets
from PIL import Image


pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0


ALPHABET = string.ascii_uppercase + string.digits


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


@dataclass
class SharedState:
    settings: StreamSettings
    screen: ScreenState | None = None


def encode_frame(sct: mss.mss, monitor: dict[str, int], quality: int, max_width: int) -> tuple[bytes, ScreenState, tuple[int, int]]:
    shot = sct.grab(monitor)
    image = Image.frombytes("RGB", shot.size, shot.rgb)
    if max_width > 0 and image.width > max_width:
        height = round(image.height * (max_width / image.width))
        image = image.resize((max_width, height), Image.Resampling.BILINEAR)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=False, subsampling=0)
    state = ScreenState(
        left=monitor["left"],
        top=monitor["top"],
        width=monitor["width"],
        height=monitor["height"],
    )
    return buffer.getvalue(), state, image.size


def pack_frame(jpeg: bytes, state: ScreenState, stream_size: tuple[int, int]) -> bytes:
    header = json.dumps(
        {
            "type": "frame",
            "width": stream_size[0],
            "height": stream_size[1],
            "sourceWidth": state.width,
            "sourceHeight": state.height,
            "timestamp": time.time(),
        },
        separators=(",", ":"),
    ).encode("utf-8")
    return struct.pack(">I", len(header)) + header + jpeg


def scale_point(state: ScreenState, x: float, y: float) -> tuple[int, int]:
    screen_x = round(state.left + max(0.0, min(1.0, x)) * state.width)
    screen_y = round(state.top + max(0.0, min(1.0, y)) * state.height)
    return screen_x, screen_y


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
        key = str(event.get("key", "")).lower()
        if key:
            pyautogui.press(key, _pause=False)
    elif kind == "hotkey" and allow_keyboard:
        keys = [str(key).lower() for key in event.get("keys", []) if key]
        if keys:
            pyautogui.hotkey(*keys, _pause=False)
    elif kind == "text" and allow_keyboard:
        text = str(event.get("text", ""))
        if text:
            pyperclip.copy(text)
            pyautogui.hotkey("ctrl", "v", _pause=False)


async def sender(ws, monitor_index: int, shared: SharedState) -> None:
    last_status = 0.0
    with mss.mss() as sct:
        monitor = sct.monitors[monitor_index]
        while True:
            started = time.monotonic()
            settings = shared.settings
            frame, state, stream_size = encode_frame(sct, monitor, settings.quality, settings.max_width)
            await ws.send(pack_frame(frame, state, stream_size))
            shared.screen = state

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
            elif event.get("kind") == "copy" and allow_keyboard:
                pyperclip.copy("")
                pyautogui.hotkey("ctrl", "c", _pause=False)
                text = ""
                for _ in range(10):
                    await asyncio.sleep(0.08)
                    text = pyperclip.paste()
                    if text:
                        break
                await ws.send(json.dumps({"type": "clipboard", "text": text}))
            else:
                handle_control(payload, shared.screen, allow_keyboard)


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
                websockets.connect(url, max_size=8 * 1024 * 1024, max_queue=1) as ws,
                websockets.connect(control_url, max_size=1024 * 1024, max_queue=1) as control_ws,
            ):
                shared = SharedState(settings=StreamSettings(fps=args.fps, quality=args.quality, max_width=args.max_width))
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
    parser.add_argument("--fps", type=int, default=8, help="screen frames per second")
    parser.add_argument("--quality", type=int, default=92, help="JPEG quality 1-95")
    parser.add_argument("--max-width", type=int, default=0, help="resize stream width; use 0 for original size")
    parser.add_argument("--monitor", type=int, default=1, help="mss monitor index")
    parser.add_argument("--no-keyboard", action="store_true", help="disable remote keyboard input")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        asyncio.run(run(parse_args()))
    except KeyboardInterrupt:
        print("\nStopped sharing.")
