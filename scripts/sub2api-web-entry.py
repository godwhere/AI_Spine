"""Deployment entry for the dedicated ChatGPT web image backend.

Loaded by ispine-chatgpt-web.service alongside the pinned chatgpt2api source.
Never log credentials, request bodies, query strings, or conversation IDs.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit

from curl_cffi import requests
from fastapi import HTTPException, Request

_request = requests.Session.request
_lock = Lock()
_audit = Path("/var/lib/ispine-chatgpt-web/web-route.jsonl")
_visible_paths = {
    "/backend-api/me",
    "/backend-api/accounts/check/v4-2023-04-27",
    "/backend-api/conversation/init",
    "/backend-api/f/conversation/prepare",
    "/backend-api/f/conversation",
    "/backend-api/conversation",
    "/backend-api/sentinel/chat-requirements",
}


def web_only_request(self, method, url, *args, **kwargs):
    parsed = urlsplit(url)
    if parsed.path.startswith("/backend-api/codex"):
        raise RuntimeError("Codex routes are disabled for the iSpine ChatGPT web backend")
    response = _request(self, method, url, *args, **kwargs)
    if parsed.hostname == "chatgpt.com" and parsed.path.startswith("/backend-api/"):
        record = {
            "time": datetime.now(timezone.utc).isoformat(),
            "method": str(method),
            "path": parsed.path if parsed.path in _visible_paths else "/backend-api/other",
            "status": response.status_code,
        }
        with _lock:
            with _audit.open("a", encoding="utf-8") as output:
                output.write(json.dumps(record) + "\n")
    return response


requests.Session.request = web_only_request

from main import app  # noqa: E402,F401 -- install the guard before application startup


@app.post("/internal/ispine/sub2api-authorization")
async def sync_authorization(request: Request):
    from api.support import require_admin
    from services.account_service import account_service

    require_admin(request.headers.get("authorization"))
    body = await request.json()
    source_id, token = body.get("account_id"), body.get("access_token")
    if type(source_id) is not int or source_id < 1 or not isinstance(token, str) or not 100 < len(token) < 20000 or any(c.isspace() for c in token):
        raise HTTPException(status_code=400, detail="Invalid authorization update")
    matches = [item for item in account_service.list_accounts() if item.get("ispine_sub2api_account_id") == source_id]
    if len(matches) != 1:
        raise HTTPException(status_code=409, detail="Expected exactly one bound Sub2API account")
    old = matches[0]["access_token"]
    if old != token:
        account_service._apply_refreshed_tokens(old, {"access_token": token}, "ispine_sub2api_sync")
    return {"account_id": source_id, "updated": old != token}
