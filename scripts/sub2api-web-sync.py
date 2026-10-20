"""Run on the gateway host as a restricted root systemd oneshot.

Uses the normal Sub2API export/refresh APIs for one approved account. Only its
access token crosses loopback; refresh tokens remain managed by Sub2API.
"""

import base64
import json
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


def call(base, path, key=None, data=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    request = Request(base + path, headers=headers, data=None if data is None else json.dumps(data).encode())
    for attempt in range(4):
        try:
            with urlopen(request, timeout=60) as response:
                return json.load(response)
        except URLError as error:
            if attempt == 3 or not isinstance(error.reason, ConnectionRefusedError):
                raise
            time.sleep(2)


def main(account_id):
    gateway, web = "http://127.0.0.1:18080", "http://127.0.0.1:18081"
    admin = json.loads(Path("/root/ispine-sub2api-install/admin.json").read_text())
    session = call(gateway, "/api/v1/auth/login", data={"email": admin["email"], "password": admin["password"]})["data"]["access_token"]

    def exported_token():
        accounts = call(gateway, f"/api/v1/admin/accounts/data?ids={account_id}", session)["data"]["accounts"]
        if len(accounts) != 1 or accounts[0].get("type") != "oauth":
            raise RuntimeError("Expected one approved OAuth account")
        return accounts[0]["credentials"]["access_token"]

    token = exported_token()
    try:
        encoded = token.split(".")[1]
        expiry = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))).get("exp", 0)
    except (ValueError, IndexError, KeyError):
        expiry = 0
    if expiry and expiry < time.time() + 600:
        call(gateway, f"/api/v1/admin/accounts/{account_id}/refresh", session, {})
        token = exported_token()
    root_key = next(line.split("=", 1)[1] for line in Path("/etc/ispine-chatgpt-web.env").read_text().splitlines() if line.startswith("CHATGPT2API_AUTH_KEY="))
    result = call(web, "/internal/ispine/sub2api-authorization", root_key, {"account_id": account_id, "access_token": token})
    print(json.dumps(result))


if __name__ == "__main__":
    main(int(sys.argv[1]))
