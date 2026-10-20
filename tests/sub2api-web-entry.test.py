import json
import runpy
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class ChatGPTWebRouteTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        calls = self.calls

        class Session:
            def request(self, method, url, *args, **kwargs):
                calls.append((method, url, args, kwargs))
                return types.SimpleNamespace(status_code=200)

        curl = types.ModuleType("curl_cffi")
        curl.requests = types.SimpleNamespace(Session=Session)
        main = types.ModuleType("main")
        main.app = types.SimpleNamespace(post=lambda path: lambda function: function)
        fastapi = types.ModuleType("fastapi")
        fastapi.Request = object
        fastapi.HTTPException = RuntimeError
        source = Path(__file__).resolve().parents[1] / "scripts/sub2api-web-entry.py"
        with patch.dict(sys.modules, {"curl_cffi": curl, "main": main, "fastapi": fastapi}):
            scope = runpy.run_path(str(source))
        self.scope = scope
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.audit = Path(self.folder.name) / "route.jsonl"
        scope["web_only_request"].__globals__["_audit"] = self.audit
        self.session = Session()

    def test_codex_is_blocked_before_any_upstream_request(self):
        for path in ["/backend-api/codex/responses", "/backend-api/codex/images/generations"]:
            with self.assertRaisesRegex(RuntimeError, "Codex routes are disabled"):
                self.session.request("POST", "https://chatgpt.com" + path)
        self.assertEqual(self.calls, [])

    def test_web_request_is_preserved_and_audit_contains_no_secrets(self):
        headers = {"Authorization": "Bearer private-token"}
        body = {"prompt": "private-prompt"}
        self.session.request("POST", "https://chatgpt.com/backend-api/f/conversation?secret=private-query", headers=headers, json=body)
        self.session.request("GET", "https://chatgpt.com/backend-api/conversation/private-conversation-id")
        self.assertEqual(self.calls[0][3], {"headers": headers, "json": body})
        rows = [json.loads(line) for line in self.audit.read_text().splitlines()]
        self.assertEqual([row["path"] for row in rows], ["/backend-api/f/conversation", "/backend-api/other"])
        self.assertTrue(all(row["status"] == 200 for row in rows))
        self.assertNotIn("private-", self.audit.read_text())

    def test_authorization_rotation_requires_admin_and_preserves_other_accounts(self):
        import asyncio

        approved = {"ispine_sub2api_account_id": 1, "access_token": "old-token"}
        unrelated = {"ispine_sub2api_account_id": 2, "access_token": "other-token"}
        rotations = []
        service = types.SimpleNamespace(list_accounts=lambda: [approved, unrelated], _apply_refreshed_tokens=lambda *args: rotations.append(args))
        support = types.ModuleType("api.support")
        account_module = types.ModuleType("services.account_service")
        account_module.account_service = service
        token = "new-token-" * 20

        async def body():
            return {"account_id": 1, "access_token": token}

        request = types.SimpleNamespace(headers={"authorization": "Bearer admin"}, json=body)

        def deny(value):
            raise PermissionError("Admin authentication required")

        support.require_admin = deny
        with patch.dict(sys.modules, {"api.support": support, "services.account_service": account_module}):
            with self.assertRaises(PermissionError):
                asyncio.run(self.scope["sync_authorization"](request))
            self.assertEqual(rotations, [])
            support.require_admin = lambda value: self.assertEqual(value, "Bearer admin")
            result = asyncio.run(self.scope["sync_authorization"](request))
        self.assertEqual(result, {"account_id": 1, "updated": True})
        self.assertEqual(rotations, [("old-token", {"access_token": token}, "ispine_sub2api_sync")])
        self.assertEqual(unrelated["access_token"], "other-token")


if __name__ == "__main__":
    unittest.main()
