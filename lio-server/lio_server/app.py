"""FastAPI application factory for lio-server."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db, events
from .config import Settings
from .routes import admin, bookmarks, collection, reports, tabs
from . import __version__, get_version, get_version_info


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        db.init_db(settings.db_path)
        events.set_event_loop(asyncio.get_running_loop())
        yield
        events.set_event_loop(None)
        db.close_db()

    app = FastAPI(
        title="lio-server",
        version=__version__,
        summary="Self-hostable bookmark and tab synchronization server.",
        lifespan=lifespan,
    )
    # Make the resolved settings the single source of truth for request-time
    # dependencies (auth, admin), so tests that inject a Settings are honoured
    # instead of every route re-reading the process environment.
    app.state.settings = settings
    from .config import set_active_settings

    set_active_settings(settings)

    # Browser extensions issue cross-origin requests from the extension origin.
    # Bearer-token auth (not cookies) means wildcard CORS is safe on API routes,
    # while /admin uses session cookies and remains strictly same-origin.
    class ScopedCORSMiddleware:
        def __init__(self, app_inner):
            self.app_inner = app_inner
            self.cors = CORSMiddleware(
                app_inner,
                allow_origins=["*"],
                allow_credentials=False,
                allow_methods=["*"],
                allow_headers=["*"],
            )

        async def __call__(self, scope, receive, send):
            if scope["type"] == "http" and scope.get("path", "").startswith("/api/"):
                await self.cors(scope, receive, send)
            else:
                await self.app_inner(scope, receive, send)

    app.add_middleware(ScopedCORSMiddleware)

    @app.get("/healthz", tags=["meta"])
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/version", tags=["meta"])
    def version() -> dict[str, str]:
        return get_version_info()
    app.include_router(bookmarks.router)
    app.include_router(tabs.router)
    app.include_router(reports.router)
    app.include_router(collection.router)
    app.include_router(admin.router)

    _mount_web_ui(app)
    return app


def _mount_web_ui(app: FastAPI) -> None:
    """Serve the built React UI (web_dist/) at / with SPA fallback, if present.

    The build is optional: when web_dist/ is absent (e.g. before `npm run
    build`), the API still runs and / returns the usual 404.
    """
    from pathlib import Path

    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    dist = Path(__file__).with_name("web_dist")
    index = dist / "index.html"
    if not index.exists():
        return

    assets = dist / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/", include_in_schema=False)
    def _spa_root() -> FileResponse:
        return FileResponse(str(index))

    # SPA fallback: any non-API GET that isn't a real file serves index.html so
    # client-side URL state (query strings) survives a refresh.
    @app.get("/{full_path:path}", include_in_schema=False)
    def _spa_fallback(full_path: str) -> FileResponse:
        candidate = dist / full_path
        if candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(index))


app = create_app()
