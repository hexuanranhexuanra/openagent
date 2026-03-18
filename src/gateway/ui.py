"""UI HTML — backward compat wrapper. Frontend is now in web/ directory."""

from pathlib import Path

_WEB_DIR = Path(__file__).resolve().parent.parent.parent / "web"


def get_app_html() -> str:
    """Read index.html from the web/ directory."""
    return (_WEB_DIR / "index.html").read_text(encoding="utf-8")
