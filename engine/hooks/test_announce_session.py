#!/usr/bin/env python3
"""When the SessionStart/UserPromptSubmit hook must announce, and when it must stay silent.

Run: python3 hooks/test_announce_session.py

The hook is run as a SUBPROCESS, the way the harness runs it: a JSON payload on stdin (claude
mode) or as the last argv (codex --codex-notify mode), and it POSTs to the engine named by
CYC_ENGINE_URL. That POST is the whole observable contract, so the test stands up a throwaway
HTTP listener as the engine and asks one question of each run: did an announce arrive?

ANCESTRY is the crux of the silence rules, and a unit test cannot arrange a real grok-over-claude
process tree. CYC_ANNOUNCE_ANCESTRY_OVERRIDE (a documented test-only seam in the hook, in the
spirit of the engine's CYC_ANNOUNCE_GRACE_MS) supplies the ancestor chain directly, nearest
ancestor first, so every case -- claude pane owner, nested claude, grok/codex/cursor compat
ancestor, codex-notify -- is exercised deterministically.
"""

import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "announce-session.py")
CLAUDE_ID = "0a0a0a0a-1111-4222-8333-000000000001"
CODEX_ID = "0c0c0c0c-2222-4333-8444-000000000002"
CWD = "/tmp/announce-session-test"


class Sink(BaseHTTPRequestHandler):
    """The engine the hook POSTs to: it records every announce body it receives."""

    def do_POST(self):  # noqa: N802 (the stdlib name)
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            self.server.received.append(json.loads(raw))
        except Exception:
            self.server.received.append({"_raw": raw.decode("utf-8", "replace")})
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *_):
        pass  # keep the test output clean


class HookCase(unittest.TestCase):
    def setUp(self):
        self.server = HTTPServer(("127.0.0.1", 0), Sink)
        self.server.received = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    # ----------------------------------------------------------------- helpers

    def run_hook(self, argv=(), stdin=None, ancestry=None, env=None):
        e = dict(os.environ)
        e["CYC_ENGINE_URL"] = self.url
        e["HERDR_PANE_ID"] = "w3:p1"  # the inherited witness the steal rides on
        if ancestry is not None:
            e["CYC_ANNOUNCE_ANCESTRY_OVERRIDE"] = ancestry
        e.update(env or {})
        p = subprocess.run(
            [sys.executable, HOOK, *argv],
            input=(stdin if stdin is not None else ""),
            capture_output=True, text=True, env=e, timeout=30,
        )
        return p

    def claude(self, ancestry, source="startup"):
        payload = {"session_id": CLAUDE_ID, "cwd": CWD, "hook_event_name": "SessionStart", "source": source}
        return self.run_hook(stdin=json.dumps(payload), ancestry=ancestry)

    def codex_notify(self, ancestry):
        payload = {"type": "agent-turn-complete", "thread-id": CODEX_ID, "cwd": CWD}
        return self.run_hook(argv=["--codex-notify", json.dumps(payload)], ancestry=ancestry)

    def assertAnnounced(self, sid, why=""):
        got = [b.get("sessionId") for b in self.server.received]
        self.assertIn(sid, got, f"expected an announce of {sid} {why}: received {got}")

    def assertSilent(self, why=""):
        self.assertEqual(self.server.received, [], f"expected NO announce {why}")

    # ------------------------------------------------------------------- fires

    def test_claude_pane_owner_announces(self):
        """The ordinary case: exactly one claude above the hook, nothing else. It announces."""
        self.claude(ancestry="claude")
        self.assertAnnounced(CLAUDE_ID, "for a plain claude pane owner")

    def test_codex_notify_unaffected(self):
        """codex's own notify path carries codex's identity and must never be gated: it does not
        run the claude-stdin branch at all, so even a codex ancestor is fine."""
        self.codex_notify(ancestry="codex")
        self.assertAnnounced(CODEX_ID, "for the codex notify path")

    def test_codex_notify_with_claude_ancestry_still_announces(self):
        self.codex_notify(ancestry="claude")
        self.assertAnnounced(CODEX_ID, "codex notify is never gated by the claude-stdin guards")

    # ----------------------------------------------------------------- silent

    def test_nested_claude_is_silent(self):
        """A claude spawned inside the pane owner's tool call (two claudes in the chain) inherits
        HERDR_PANE_ID and must not announce (the 2026-08-29 flicker guard)."""
        self.claude(ancestry="claude,claude")
        self.assertSilent("for a nested claude")

    def test_grok_ancestor_is_silent(self):
        """grok's claude-compat layer ran claude's hook inside a grok session: announcing would
        bind grok's id to the pane whose HERDR_PANE_ID grok inherited (the aiusage-grok steal)."""
        self.claude(ancestry="grok,claude")
        self.assertSilent("for a grok compat ancestor")

    def test_grok_ancestor_without_a_claude_in_chain_is_silent(self):
        """The proven chain: grok's ancestry carries NO claude-named process, so the nested-claude
        count never trips. The foreign-harness guard is what keeps it silent."""
        self.claude(ancestry="grok")
        self.assertSilent("for a bare grok ancestor")

    def test_codex_compat_ancestor_is_silent(self):
        self.claude(ancestry="codex,claude")
        self.assertSilent("for a codex compat ancestor of a claude hook")

    def test_cursor_compat_ancestor_is_silent(self):
        self.claude(ancestry="cursor,claude")
        self.assertSilent("for a cursor compat ancestor of a claude hook")

    def test_grok_deeper_in_the_chain_is_silent(self):
        """The foreign harness need not be the immediate parent: anywhere above the hook counts."""
        self.claude(ancestry="python3,sh,grok,tmux")
        self.assertSilent("for a grok higher up the chain")


if __name__ == "__main__":
    unittest.main(verbosity=2)
