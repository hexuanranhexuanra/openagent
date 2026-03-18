"""FastAPI app factory — wires routes, WebSocket, UI, and lifecycle hooks."""

from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from src.utils.logger import create_logger

log = create_logger("main")

WEB_DIR = Path(__file__).resolve().parent.parent.parent / "web"


def create_app() -> FastAPI:
    app = FastAPI(title="OpenAgent", version="0.1.0")

    @app.on_event("startup")
    async def startup() -> None:
        from src.config import load_config
        config = load_config()
        log.info("Config loaded", {"provider": config.agent.default_provider})

        from src.sessions.manager import init_db
        await init_db()

        from src.agents.init import init_agent
        await init_agent()

        from src.queue.worker import init_queue, init_worker
        await init_queue()
        await init_worker(concurrency=2)

        from src.background.init import init_background_services
        init_background_services()

        from src.background.cron import get_cron_service
        get_cron_service().start()

        from src.background.heartbeat import get_heartbeat_service
        get_heartbeat_service().start()

        log.info("OpenAgent started", {
            "host": config.gateway.host,
            "port": config.gateway.port,
        })

    @app.on_event("shutdown")
    async def shutdown() -> None:
        from src.queue.worker import shutdown_queue
        await shutdown_queue()

        from src.agents.engine import get_agent_engine
        get_agent_engine().cancel_all()

        from src.background.cron import get_cron_service
        get_cron_service().stop()

        from src.background.heartbeat import get_heartbeat_service
        get_heartbeat_service().stop()

        log.info("OpenAgent stopped")

    # Mount API routes
    from src.gateway.routers.api import router
    app.include_router(router, prefix="/api")

    # WebSocket endpoint
    from src.gateway.websocket import websocket_handler

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await websocket_handler(ws)

    # Serve static files (CSS, JS) from web/
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

    # SPA entry point
    @app.get("/")
    async def index():
        return FileResponse(str(WEB_DIR / "index.html"))

    return app
