#!/usr/bin/env python3
"""Stop hook: a reply the user was promised has to actually reach them.

WHY THIS EXISTS
---------------
Without it, Claude writes a perfect answer as plain terminal text. That text lands in a
terminal nobody is looking at. The user is across the room with wet hands, or on a phone in
the CallYourCode app, and they get nothing. They are talking to a machine that has already
answered them, in silence.

So: a turn the engine delivered has to end with an OUTPUT tool call.

IT IS DUMB ON PURPOSE
---------------------
One question, no opinion about verbosity: did ANY reply reach the user after the engine
delivered a message this turn? `speak`, `chat`, `show`, whatever comes later, all count the
same -- an MCP reply is an MCP reply. Which channel the reply-dials slider asked for is a soft
nudge the engine appends to the message; it is NOT enforced here. This hook does not read the
dial, the level, or the channel, and the state file no longer carries them.

IT ASKS THE ENGINE, NOT THE TRANSCRIPT
--------------------------------------
This used to read the session transcript: find the message that opened the turn, find the
tool calls after it. That file is written ASYNCHRONOUSLY by the harness, so a `speak` that
had definitely happened could be missing from it. The engine knows both halves without any of
that. It delivered the message, and every reply comes back through its MCP socket. It writes
both, timestamped, to the data dir's `state/reply-state.json` (agent-engine/src/chat/reply-trace.ts,
noteDelivery / noteReply / writeHookState), and this hook reads them. Both writes happen
before the agent can act on them: a delivery is recorded before the message is typed into the
pane, and a reply when its frame arrives, which is before the tool call has returned to the
model. Nothing to wait for, and no transcript parsing at all.

Terminal text next to a real reply is NORMAL and is not policed. Sessions type into their own
terminal constantly, it costs nothing, and this hook never looks at what the turn said.

ONE NUDGE PER MESSAGE
---------------------
After judging, the hook records how far it has judged, per session, in
`state/reply-acks/<pane>.json`. A delivery is therefore judged exactly once, at the first Stop
after it arrives, and can never nag a later, unrelated turn. `stop_hook_active` allows as
well: belt and braces, since a second block in one continuation chain could loop forever.

FAILS OPEN
----------
Every error path allows the stop. No state file, unreadable state file, a session this hook
cannot identify, an engine that restarted and forgot, an unexpected payload shape, an
unwritable ack, a bug in here: exit 0. A hook that blocks a session it cannot classify is
worse than one that lets a reply through.

PROTOCOL
--------
stdin : the hook payload, JSON
exit 0: allow the stop
exit 2: block the stop; stderr is fed back to Claude as the reason
"""

import json
import os
import re
import sys
import time

MARKER = "[enforce-voice-reply]"

# The engine's files live in the per-user data dir now (~/.callyourcode, the design), under
# state/. CYC_DATA_DIR is the one override, shared with the engine; CYC_STATE_DIR pins the
# state dir directly for the tests, which must never write the running engine's state.
DATA_DIR = os.environ.get("CYC_DATA_DIR") or os.path.join(os.path.expanduser("~"), ".callyourcode")
STATE_DIR = os.environ.get("CYC_STATE_DIR") or os.path.join(DATA_DIR, "state")
STATE_FILE = os.path.join(STATE_DIR, "reply-state.json")
ACK_DIR = os.path.join(STATE_DIR, "reply-acks")

# A delivery older than this is not what the turn ending now was about. It only ever comes up
# after an install, a crash, or a session that sat unanswered for an hour, and in all three
# cases the honest answer is that this hook does not know.
STALE_AFTER_MS = 60 * 60 * 1000


def allow():
    sys.exit(0)


def block(reason):
    print(reason, file=sys.stderr)
    sys.exit(2)


def read_state():
    """The engine's state file, or None. Never raises."""
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError, TypeError):
        return None
    return state if isinstance(state, dict) else None


def find_session(state, payload):
    """(pane id, entry) for the session that is stopping, or None.

    Three identifications, strongest first. Claude's own session id is exact and needs no
    environment. HERDR_PANE_ID is this session's identity everywhere else in the system and
    the hook inherits it from the pane. cwd is the last resort, and only when it picks out one
    session: two panes in the same directory tell us nothing.
    """
    sessions = state.get("sessions")
    if not isinstance(sessions, dict):
        return None
    live = {k: v for k, v in sessions.items() if isinstance(k, str) and isinstance(v, dict)}

    claude_id = payload.get("session_id")
    if isinstance(claude_id, str) and claude_id:
        hits = [k for k, v in live.items() if v.get("claudeSessionId") == claude_id]
        if len(hits) == 1:
            return hits[0], live[hits[0]]

    pane = os.environ.get("HERDR_PANE_ID") or os.environ.get("VOICE_SESSION_ID")
    if pane and pane in live:
        return pane, live[pane]

    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd:
        hits = [k for k, v in live.items() if v.get("cwd") == cwd]
        if len(hits) == 1:
            return hits[0], live[hits[0]]
    return None


def ack_path(pane):
    return os.path.join(ACK_DIR, (re.sub(r"[^A-Za-z0-9_.-]", "_", pane) or "unknown") + ".json")


def read_ack(pane):
    """How far this session has already been judged, as an epoch-ms delivery stamp.

    Stamps rather than a counter, because a counter restarts when the engine does and a
    watermark left above it would switch this hook off in silence.
    """
    try:
        with open(ack_path(pane), "r", encoding="utf-8") as fh:
            ack = json.load(fh)
        ts = ack.get("deliveredThrough")
        return float(ts) if isinstance(ts, (int, float)) else 0.0
    except (OSError, ValueError, TypeError, AttributeError):
        return 0.0


def write_ack(pane, ts):
    """Judged up to here. Atomic, and a failure changes no verdict: at worst one message is
    judged twice, which the replies it already has on record then allow."""
    try:
        os.makedirs(ACK_DIR, exist_ok=True)
        final = ack_path(pane)
        tmp = f"{final}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"deliveredThrough": ts, "at": int(time.time() * 1000)}, fh)
        os.replace(tmp, final)
    except (OSError, ValueError, TypeError):
        pass


def outstanding(entry, ack_ts, now_ms):
    """The delivery timestamps this Stop is answerable for: recorded, not yet judged, not
    ancient. A dumb list of stamps -- no level, no channel demand, nothing to interpret."""
    out = []
    for d in entry.get("deliveries") or []:
        if not isinstance(d, dict):
            continue
        ts = d.get("ts")
        if not isinstance(ts, (int, float)) or isinstance(ts, bool):
            continue
        if ts <= ack_ts or now_ms - ts > STALE_AFTER_MS:
            continue
        out.append(float(ts))
    return out


def replied_since(entry, since_ms):
    """Did any reply reach the user at or after `since_ms`? A reply that went out BEFORE the
    message arrived answered something else."""
    for r in entry.get("replies") or []:
        if not isinstance(r, dict):
            continue
        ts = r.get("ts")
        if not isinstance(ts, (int, float)) or isinstance(ts, bool):
            continue
        if ts >= since_ms:
            return True
    return False


def block_reason():
    """The one message, whatever the missing channel: something has to have reached them."""
    return (
        f"{MARKER} BLOCKED: you answered into this terminal, and nobody is reading it. "
        "The user is in the CallYourCode app on a phone or a tablet; text printed here "
        "never reaches them, so as far as they can tell you did not answer. Anything that "
        "reaches them counts: `speak` for something to hear, `chat` for something to read, "
        "`show` for a file or a diff. Call one now with your answer, then stop."
    )


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        allow()

    payload = json.loads(raw)
    if not isinstance(payload, dict):
        allow()

    # Already nudged once in this continuation chain. Never loop.
    if payload.get("stop_hook_active"):
        allow()

    state = read_state()
    if state is None:
        allow()  # no engine, or a file we cannot read: nothing to enforce

    found = find_session(state, payload)
    if found is None:
        allow()  # not a session the engine knows: normal coding, or unidentifiable
    pane, entry = found

    pending = outstanding(entry, read_ack(pane), time.time() * 1000)
    if not pending:
        allow()  # nothing was delivered here: this hook is inert during ordinary coding

    # Judged now, once, whatever the verdict: an unanswered message must not nag the next
    # turn, which has its own conversation to be about.
    write_ack(pane, max(pending))

    # Any reply at or after the earliest outstanding delivery answered this turn.
    if replied_since(entry, min(pending)):
        allow()

    block(block_reason())


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - fail OPEN, always, whatever happened
        sys.exit(0)
