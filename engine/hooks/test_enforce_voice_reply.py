#!/usr/bin/env python3
"""What the Stop hook must and must not block.

Run: python3 hooks/test_enforce_voice_reply.py

The hook is a DUMB guard now: did ANY reply reach the user after the engine delivered a
message this turn? No level, no channel demand. `speak`, `chat` and `show` all count the same.
So the surface here is small: identify the session, judge once, fail open everywhere, and
block only when a delivered turn ended with nothing sent back.

The hook is run as a SUBPROCESS, the way the harness runs it: a JSON payload on stdin, an exit
code out. That is the whole contract, so it is the whole test surface -- no internals are
imported and the tests stay true through a rewrite of the inside.

`CYC_STATE_DIR` points the hook at a temporary directory, so a test never reads or writes the
state file the running engine owns. HERDR_PANE_ID is cleared from the environment for the same
reason: these tests run inside a real session that has one.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "enforce-voice-reply.py")
PANE = "w9:p9"
CWD = "/tmp/enforce-voice-reply-test"
CLAUDE_ID = "11111111-2222-3333-4444-555555555555"

ALLOW, BLOCK = 0, 2


def now_ms():
    return time.time() * 1000


class HookCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="reply-state-")
        self.state_file = os.path.join(self.dir, "reply-state.json")

    # ----------------------------------------------------------------- helpers

    def write_state(self, sessions):
        with open(self.state_file, "w", encoding="utf-8") as fh:
            json.dump({"writtenAt": now_ms(), "host": "test", "sessions": sessions}, fh)

    def session(self, deliveries=(), replies=(), has_channel=True):
        # has_channel mirrors the engine's hasReplyChannel: the default fixtures
        # model a session whose MCP works (the hook may block); a channel-less
        # session (agent started before cyc) must never be blocked.
        return {
            PANE: {
                "cwd": CWD,
                "claudeSessionId": CLAUDE_ID,
                "hasReplyChannel": bool(has_channel),
                "deliveries": list(deliveries),
                "replies": list(replies),
            }
        }

    def delivery(self, ago_ms=5000, how="VOICE"):
        return {"ts": now_ms() - ago_ms, "how": how}

    def reply(self, ago_ms=1000):
        return {"ts": now_ms() - ago_ms}

    def clear_acks(self):
        """Forget that this session has been judged, so a second run_hook in one test is
        decided by the state under test rather than by the one-nudge-per-message rule."""
        acks = os.path.join(self.dir, "reply-acks")
        if os.path.isdir(acks):
            for name in os.listdir(acks):
                os.remove(os.path.join(acks, name))

    def run_hook(self, payload=None, env=None, raw=None):
        body = raw if raw is not None else json.dumps(
            payload if payload is not None else {"session_id": CLAUDE_ID, "cwd": CWD}
        )
        e = {k: v for k, v in os.environ.items() if k not in ("HERDR_PANE_ID", "VOICE_SESSION_ID")}
        e["CYC_STATE_DIR"] = self.dir
        e.update(env or {})
        p = subprocess.run(
            [sys.executable, HOOK], input=body, capture_output=True, text=True, env=e, timeout=30,
        )
        return p.returncode, p.stderr

    def assertAllows(self, code, err, why=""):
        self.assertEqual(code, ALLOW, f"expected the stop to be allowed {why}: {err}")

    def assertBlocks(self, code, err, why=""):
        self.assertEqual(code, BLOCK, f"expected the stop to be blocked {why}")
        self.assertIn("[enforce-voice-reply]", err)

    # ------------------------------------------------------------- fails open

    def test_no_state_file_allows(self):
        code, err = self.run_hook()
        self.assertAllows(code, err, "with no state file at all")

    def test_unreadable_state_allows(self):
        with open(self.state_file, "w", encoding="utf-8") as fh:
            fh.write("{ not json at all")
        code, err = self.run_hook()
        self.assertAllows(code, err, "with a torn state file")

    def test_state_of_the_wrong_shape_allows(self):
        with open(self.state_file, "w", encoding="utf-8") as fh:
            json.dump([1, 2, 3], fh)
        code, err = self.run_hook()
        self.assertAllows(code, err, "with a state file that is not an object")

    def test_empty_stdin_allows(self):
        self.write_state(self.session([self.delivery()]))
        code, err = self.run_hook(raw="")
        self.assertAllows(code, err, "with no payload on stdin")

    def test_garbage_stdin_allows(self):
        self.write_state(self.session([self.delivery()]))
        code, err = self.run_hook(raw="not json")
        self.assertAllows(code, err, "with a payload that is not JSON")

    def test_unidentifiable_session_allows(self):
        """A pending delivery for a session this Stop is not from must not block it."""
        self.write_state(self.session([self.delivery()]))
        code, err = self.run_hook({"session_id": "someone-else", "cwd": "/somewhere/else"})
        self.assertAllows(code, err, "for a session the state file does not know")

    def test_stop_hook_active_allows(self):
        self.write_state(self.session([self.delivery()]))
        code, err = self.run_hook({"session_id": CLAUDE_ID, "cwd": CWD, "stop_hook_active": True})
        self.assertAllows(code, err, "when we have already blocked once in this chain")

    def test_stale_delivery_allows(self):
        self.write_state(self.session([self.delivery(ago_ms=3 * 60 * 60 * 1000)]))
        code, err = self.run_hook()
        self.assertAllows(code, err, "for a delivery hours old")

    def test_no_reply_channel_never_blocks(self):
        # An agent started before cyc (its harness never loaded the MCP) has no
        # speak/chat tools; its terminal answer reaches the app via ingest, so
        # the hook must let it stand (live 2026-09-22: the five-minute "hi").
        self.write_state(self.session(deliveries=[self.delivery()], has_channel=False))
        code, err = self.run_hook()
        self.assertAllows(code, err, "for a session with no reply channel")

    def test_no_deliveries_allows(self):
        """The ordinary coding case: nothing was delivered, so there is nothing to enforce."""
        self.write_state(self.session([], [self.reply()]))
        code, err = self.run_hook()
        self.assertAllows(code, err, "when the engine delivered nothing")

    def test_malformed_delivery_is_ignored(self):
        """A delivery with no usable ts is not something to enforce."""
        self.write_state(self.session([{"how": "VOICE"}, "junk", {"ts": "nope"}]))
        code, err = self.run_hook()
        self.assertAllows(code, err, "when no delivery carries a real timestamp")

    # --------------------------------------------------------- does not fire

    def test_spoke_allows(self):
        self.write_state(self.session([self.delivery()], [self.reply()]))
        code, err = self.run_hook()
        self.assertAllows(code, err, "when a reply came back after the delivery")

    def test_show_counts_as_a_reply(self):
        """An MCP reply is an MCP reply: show satisfies the dumb guard like speak or chat."""
        self.write_state(self.session([self.delivery()], [self.reply()]))
        code, err = self.run_hook()
        self.assertAllows(code, err, "when the turn answered with show")

    def test_identifies_by_pane_env(self):
        """No claude session id on record: HERDR_PANE_ID still finds the session."""
        s = self.session([self.delivery()], [self.reply()])
        s[PANE]["claudeSessionId"] = None
        self.write_state(s)
        code, err = self.run_hook({"cwd": "/somewhere/else"}, env={"HERDR_PANE_ID": PANE})
        self.assertAllows(code, err, "when the pane env var identifies the session")

    # ----------------------------------------------------------------- fires

    def test_nothing_sent_blocks(self):
        self.write_state(self.session([self.delivery()]))
        code, err = self.run_hook()
        self.assertBlocks(code, err, "when nothing at all was sent")
        # the nudge names every channel that would reach the user
        self.assertIn("`speak`", err)
        self.assertIn("`chat`", err)
        self.assertIn("`show`", err)

    def test_reply_before_the_delivery_does_not_count(self):
        """It answered the previous message. This one is still owed an answer."""
        self.write_state(self.session(
            [self.delivery(ago_ms=5000)],
            [self.reply(ago_ms=9000)],
        ))
        code, err = self.run_hook()
        self.assertBlocks(code, err, "when the only reply predates the message")

    def test_identifies_by_cwd_when_unique(self):
        self.write_state(self.session([self.delivery()]))
        code, err = self.run_hook({"cwd": CWD})
        self.assertBlocks(code, err, "when cwd alone identifies the session")

    def test_ambiguous_cwd_allows(self):
        s = self.session([self.delivery()])
        s[PANE]["claudeSessionId"] = None
        s["w9:p10"] = dict(s[PANE])
        self.write_state(s)
        code, err = self.run_hook({"cwd": CWD})
        self.assertAllows(code, err, "when two sessions share the cwd and nothing else picks one")

    # ------------------------------------------- several messages outstanding

    def test_queued_deliveries_one_reply_is_enough(self):
        """Queued messages are one turn: a single reply after the earliest answers them all."""
        self.write_state(self.session([
            self.delivery(ago_ms=8000),
            self.delivery(ago_ms=5000),
        ], [self.reply(ago_ms=1000)]))
        code, err = self.run_hook()
        self.assertAllows(code, err, "when one reply answers two queued messages")

    def test_queued_deliveries_nothing_sent_blocks(self):
        self.write_state(self.session([
            self.delivery(ago_ms=8000),
            self.delivery(ago_ms=5000),
        ]))
        code, err = self.run_hook()
        self.assertBlocks(code, err, "when two queued messages got nothing")

    # --------------------------------------------------------- one nudge only

    def test_a_message_is_judged_once(self):
        """Blocked once, then out of the way: the next turn is about something else."""
        self.write_state(self.session([self.delivery()]))
        code, err = self.run_hook()
        self.assertBlocks(code, err, "on the first stop after an unanswered message")
        code, err = self.run_hook()
        self.assertAllows(code, err, "on a later stop for the same unanswered message")

    def test_a_new_message_is_judged_again(self):
        self.write_state(self.session([self.delivery(ago_ms=9000)]))
        code, err = self.run_hook()
        self.assertBlocks(code, err, "on the first message")
        self.write_state(self.session([
            self.delivery(ago_ms=9000),
            self.delivery(ago_ms=1000),
        ]))
        code, err = self.run_hook()
        self.assertBlocks(code, err, "on the next unanswered message")

    def test_ack_dir_unwritable_still_decides(self):
        """A verdict never depends on being able to record it."""
        self.write_state(self.session([self.delivery()]))
        ack_dir = os.path.join(self.dir, "reply-acks")
        with open(ack_dir, "w", encoding="utf-8") as fh:  # a FILE where the directory goes
            fh.write("in the way")
        code, err = self.run_hook()
        self.assertBlocks(code, err, "when the ack cannot be written")

    def test_does_not_read_the_transcript(self):
        """The whole point of the redesign: no transcript, no waiting for one.

        A payload pointing at a transcript that does not exist must still be judged, and fast:
        the old hook re-read the file for three seconds before believing a block.
        """
        self.write_state(self.session([self.delivery()]))
        start = time.time()
        code, err = self.run_hook({
            "session_id": CLAUDE_ID, "cwd": CWD, "transcript_path": "/nope/does/not/exist.jsonl",
        })
        self.assertBlocks(code, err, "with no transcript to read")
        self.assertLess(time.time() - start, 2.0, "the hook waited for something")


if __name__ == "__main__":
    unittest.main(verbosity=2)
