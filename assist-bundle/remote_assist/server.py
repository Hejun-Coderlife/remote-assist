from __future__ import annotations

import asyncio
import json
import os
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"


def get_files_dir() -> Path:
    env = os.environ.get("REMOTE_ASSIST_FILES_DIR", "").strip()
    if env:
        return Path(env)
    return Path.home() / "RemoteAssistFiles"

app = FastAPI(title="Remote Assist Relay")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


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


def safe_file_path(name: str) -> Path:
    clean_name = Path(name).name.strip()
    if not clean_name or clean_name in {".", ".."}:
        raise HTTPException(status_code=400, detail="invalid file name")
    return get_files_dir() / clean_name


@app.get("/api/files")
async def list_files() -> dict[str, Any]:
    base = get_files_dir()
    base.mkdir(parents=True, exist_ok=True)
    files = []
    for path in sorted(base.iterdir(), key=lambda item: item.name.lower()):
        if not path.is_file() and not path.is_dir():
            continue
        stat = path.stat()
        files.append(
            {
                "name": path.name,
                "size": stat.st_size if path.is_file() else None,
                "modified": int(stat.st_mtime),
                "type": "folder" if path.is_dir() else "file",
            }
        )
    return {"directory": str(get_files_dir()), "files": files}


@app.post("/api/files")
async def upload_file(request: Request, name: str = Query(min_length=1)) -> dict[str, Any]:
    get_files_dir().mkdir(parents=True, exist_ok=True)
    target = safe_file_path(name)
    body = await request.body()
    if len(body) > 300 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="file is too large")
    target.write_bytes(body)
    return {"ok": True, "name": target.name, "size": len(body)}


@app.get("/api/files/{name}")
async def download_file(name: str, background_tasks: BackgroundTasks) -> FileResponse:
    target = safe_file_path(name)
    if not target.exists():
        raise HTTPException(status_code=404, detail="file not found")
    if target.is_dir():
        archive = Path(tempfile.gettempdir()) / f"{target.name}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zip_file:
            for child in target.rglob("*"):
                if child.is_file():
                    zip_file.write(child, child.relative_to(target.parent))
        background_tasks.add_task(archive.unlink, missing_ok=True)
        return FileResponse(archive, filename=f"{target.name}.zip")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(target, filename=target.name)


@app.delete("/api/files/{name}")
async def delete_file(name: str) -> dict[str, Any]:
    target = safe_file_path(name)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    target.unlink()
    return {"ok": True}


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
    controllers = list(room.controllers)
    if not controllers:
        return

    async def try_send(ws: WebSocket) -> WebSocket | None:
        try:
            await ws.send_bytes(payload)
            return None
        except Exception:
            return ws

    results = await asyncio.gather(*(try_send(ws) for ws in controllers), return_exceptions=False)
    for ws in results:
        if ws is not None:
            room.controllers.discard(ws)


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

    # 慢网络下 await broadcast 会阻塞 receive，导致被控端 TCP 积压、延迟数秒。
    # 用 depth=1 的队列只保留「最新一帧」，发送与接收并行，中间帧直接丢弃。
    frame_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=1)

    async def egress_frames() -> None:
        while True:
            frame = await frame_q.get()
            if room.controllers:
                await broadcast_bytes(room, frame)

    egress_task = asyncio.create_task(egress_frames(), name=f"host-egress-{room_id}")

    def enqueue_frame(frame: bytes) -> None:
        room.last_frame = frame
        try:
            frame_q.put_nowait(frame)
        except asyncio.QueueFull:
            try:
                frame_q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                frame_q.put_nowait(frame)
            except asyncio.QueueFull:
                pass

    try:
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                enqueue_frame(message["bytes"])
            elif message.get("text") is not None:
                payload = json.loads(message["text"])
                if payload.get("type") == "status":
                    await broadcast_json(room, payload)
    except (WebSocketDisconnect, json.JSONDecodeError, RuntimeError):
        pass
    finally:
        egress_task.cancel()
        try:
            await egress_task
        except asyncio.CancelledError:
            pass
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
