"""Real-time event broadcasting (WebSockets) for lio-server."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any
from fastapi import WebSocket

logger = logging.getLogger("lio_server.events")

_loop: asyncio.AbstractEventLoop | None = None


def set_event_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    global _loop
    _loop = loop


def get_event_loop() -> asyncio.AbstractEventLoop | None:
    global _loop
    return _loop


class ConnectionManager:
    def __init__(self) -> None:
        # cid -> set of (WebSocket, device_id)
        self._connections: dict[str, set[tuple[WebSocket, str | None]]] = {}
        self._lock = asyncio.Lock()

    async def connect(
        self, websocket: WebSocket, cid: str, device_id: str | None = None
    ) -> None:
        async with self._lock:
            if cid not in self._connections:
                self._connections[cid] = set()
            self._connections[cid].add((websocket, device_id))

    async def disconnect(self, websocket: WebSocket, cid: str) -> None:
        async with self._lock:
            if cid in self._connections:
                self._connections[cid] = {
                    (ws, did) for ws, did in self._connections[cid] if ws != websocket
                }
                if not self._connections[cid]:
                    del self._connections[cid]

    async def broadcast(
        self,
        cid: str,
        event_type: str,
        data: dict[str, Any],
        exclude_device_id: str | None = None,
    ) -> None:
        async with self._lock:
            targets = list(self._connections.get(cid, set()))

        payload = {
            "event": event_type,
            "cid": cid,
            "server_timestamp": int(time.time() * 1000),
            **data,
        }
        dead_sockets: list[WebSocket] = []

        for ws, did in targets:
            if exclude_device_id is not None and did == exclude_device_id:
                continue
            try:
                await ws.send_json(payload)
            except Exception as e:
                logger.debug(f"Failed to send to websocket: {e}")
                dead_sockets.append(ws)

        if dead_sockets:
            async with self._lock:
                if cid in self._connections:
                    self._connections[cid] = {
                        (ws, did)
                        for ws, did in self._connections[cid]
                        if ws not in dead_sockets
                    }
                    if not self._connections[cid]:
                        del self._connections[cid]


manager = ConnectionManager()


def broadcast_event(
    cid: str,
    event_type: str,
    data: dict[str, Any] | None = None,
    exclude_device_id: str | None = None,
) -> None:
    """Thread-safe event broadcast helper called from synchronous route handlers."""
    event_data = data or {}
    loop = get_event_loop()
    if loop and loop.is_running():
        asyncio.run_coroutine_threadsafe(
            manager.broadcast(cid, event_type, event_data, exclude_device_id),
            loop,
        )
    else:
        try:
            cur_loop = asyncio.get_running_loop()
            cur_loop.create_task(
                manager.broadcast(cid, event_type, event_data, exclude_device_id)
            )
        except RuntimeError:
            pass
