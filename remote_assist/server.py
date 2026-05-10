from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"

app = FastAPI(title="Remote Assist Relay")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@dataclass
class Room:
    secret: str
    host: WebSocket | None = None
    host_control: WebSocket | None = None
    controllers: set[WebSocket] = field(default_factory=set)
    last_frame: bytes | None = None


rooms: dict[str, Room] = {}
rooms_lock = asyncio.Lock()


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


async def send_json_safe(ws: WebSocket, payload: dict[str, Any]) -> None:
    try:
        await ws.send_text(json.dumps(payload))
    except Exception:
        pass


async def broadcast_json(room: Room, payload: dict[str, Any]) -> None:
    stale: list[WebSocket] = []
    data = json.dumps(payload)
    for controller in list(room.controllers):
        try:
            await controller.send_text(data)
        except Exception:
            stale.append(controller)
    for controller in stale:
        room.controllers.discard(controller)


async def broadcast_bytes(room: Room, payload: bytes) -> None:
    stale: list[WebSocket] = []
    for controller in list(room.controllers):
        try:
            await controller.send_bytes(payload)
        except Exception:
            stale.append(controller)
    for controller in stale:
        room.controllers.discard(controller)


@app.websocket("/ws/host/{room_id}")
async def host_socket(
    websocket: WebSocket,
    room_id: str,
    secret: str = Query(min_length=6),
) -> None:
    await websocket.accept()
    async with rooms_lock:
        room = rooms.get(room_id)
        if room and room.secret != secret:
            await send_json_safe(websocket, {"type": "error", "message": "room already exists with a different secret"})
            await websocket.close(code=1008)
            return
        if room is None:
            room = Room(secret=secret)
            rooms[room_id] = room
        if room.host is not None:
            await send_json_safe(websocket, {"type": "error", "message": "host already connected"})
            await websocket.close(code=1008)
            return
        room.host = websocket

    await broadcast_json(room, {"type": "host_status", "online": True})
    await send_json_safe(websocket, {"type": "ready", "room": room_id})

    try:
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                frame = message["bytes"]
                room.last_frame = frame
                await broadcast_bytes(room, frame)
            elif message.get("text") is not None:
                payload = json.loads(message["text"])
                if payload.get("type") == "status":
                    await broadcast_json(room, payload)
    except (WebSocketDisconnect, json.JSONDecodeError, RuntimeError):
        pass
    finally:
        async with rooms_lock:
            active = rooms.get(room_id)
            if active is room:
                room.host = None
                await broadcast_json(room, {"type": "host_status", "online": False})
                if not room.controllers:
                    rooms.pop(room_id, None)


@app.websocket("/ws/host_control/{room_id}")
async def host_control_socket(
    websocket: WebSocket,
    room_id: str,
    secret: str = Query(min_length=6),
) -> None:
    await websocket.accept()
    async with rooms_lock:
        room = rooms.get(room_id)
        if room is None or room.secret != secret:
            await send_json_safe(websocket, {"type": "error", "message": "invalid room or secret"})
            await websocket.close(code=1008)
            return
        if room.host_control is not None:
            await send_json_safe(websocket, {"type": "error", "message": "host control already connected"})
            await websocket.close(code=1008)
            return
        room.host_control = websocket

    await send_json_safe(websocket, {"type": "ready", "room": room_id, "channel": "control"})

    try:
        while True:
            message = await websocket.receive_text()
            payload = json.loads(message)
            if payload.get("type") == "clipboard":
                await broadcast_json(room, payload)
    except (WebSocketDisconnect, json.JSONDecodeError, RuntimeError):
        pass
    finally:
        async with rooms_lock:
            active = rooms.get(room_id)
            if active is room:
                room.host_control = None


@app.websocket("/ws/controller/{room_id}")
async def controller_socket(
    websocket: WebSocket,
    room_id: str,
    secret: str = Query(min_length=6),
) -> None:
    await websocket.accept()
    async with rooms_lock:
        room = rooms.get(room_id)
        if room is None or room.secret != secret:
            await send_json_safe(websocket, {"type": "error", "message": "invalid room or secret"})
            await websocket.close(code=1008)
            return
        room.controllers.add(websocket)
        host = room.host
        last_frame = room.last_frame

    await send_json_safe(websocket, {"type": "host_status", "online": host is not None})
    if last_frame:
        await websocket.send_bytes(last_frame)

    try:
        while True:
            message = await websocket.receive_text()
            payload = json.loads(message)
            if payload.get("type") == "control":
                target = room.host_control or room.host
                if target is not None:
                    await send_json_safe(target, payload)
    except (WebSocketDisconnect, json.JSONDecodeError):
        pass
    finally:
        async with rooms_lock:
            active = rooms.get(room_id)
            if active is room:
                room.controllers.discard(websocket)
                if room.host is None and not room.controllers:
                    rooms.pop(room_id, None)


@app.websocket("/ws/controller_control/{room_id}")
async def controller_control_socket(
    websocket: WebSocket,
    room_id: str,
    secret: str = Query(min_length=6),
) -> None:
    await websocket.accept()
    async with rooms_lock:
        room = rooms.get(room_id)
        if room is None or room.secret != secret:
            await send_json_safe(websocket, {"type": "error", "message": "invalid room or secret"})
            await websocket.close(code=1008)
            return

    await send_json_safe(websocket, {"type": "ready", "channel": "control"})

    try:
        while True:
            message = await websocket.receive_text()
            payload = json.loads(message)
            if payload.get("type") == "control":
                target = room.host_control or room.host
                if target is not None:
                    await send_json_safe(target, payload)
    except (WebSocketDisconnect, json.JSONDecodeError, RuntimeError):
        pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("remote_assist.server:app", host="0.0.0.0", port=8765, reload=False)
