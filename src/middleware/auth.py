"""Auth middleware — Bearer token and Feishu signature verification."""

from __future__ import annotations

import hashlib
import hmac

from fastapi import HTTPException, Request

from src.utils.logger import create_logger

log = create_logger("middleware:auth")


async def verify_bearer_token(request: Request) -> None:
    """FastAPI dependency for Bearer token auth on /api/* routes."""
    from src.config import get_config

    config = get_config()
    token = config.gateway.auth_token

    if not token:
        return

    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")

    provided = auth_header[7:]
    if provided != token:
        raise HTTPException(status_code=401, detail="Unauthorized")


def verify_lark_signature(
    encrypt_key: str | None,
    timestamp: str,
    nonce: str,
    body: str,
    signature: str,
) -> bool:
    """Verify Feishu/Lark webhook signature."""
    if not encrypt_key:
        return True

    if not signature:
        log.warn("Missing Lark signature")
        return False

    content = timestamp + nonce + encrypt_key + body
    computed = hashlib.sha256(content.encode("utf-8")).hexdigest()

    if not hmac.compare_digest(computed, signature):
        log.warn("Invalid Lark signature", {"provided": signature[:8]})
        return False

    return True
