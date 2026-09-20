#!/usr/bin/env python3
"""SessionStart/UserPromptSubmit hook: claude announces its own session identity.

WHY THIS EXISTS
---------------
Pane-to-session identity used to be GUESSED by the engine (newest jsonl in the
pane's cwd), patched with carry rules, birth floors and sticky links; that
guessing was the root of the whole wrong-adoption bug family. The session FILE is authoritative and
only claude knows for certain which one it is writing, so claude says so:
"session Y, pid N", POSTed to the engine on loopback. The engine maps the pid
to a pane and binds it. Guessing shrinks to a rare fallback for panes that
never announced.

WHICH EVENTS, AND WHY BOTH
--------------------------
SessionStart fires on startup, --resume/--continue (source "resume"), /clear
and compaction, so it covers every way a session id is minted or reclaimed.
UserPromptSubmit is belt and braces: it re-announces the same id on every
prompt, which is idempotent engine-side (a bind to the id already held is a
no-op) and heals an engine that was down or restarted when SessionStart fired.

DEPENDENCY-FREE, FAST, FAIL-SILENT
----------------------------------
stdlib urllib only, a 2 second timeout, and EVERY failure exits 0: a dead
engine must never slow down or break claude. The engine, not this hook, knows
which mux it runs; the hook forwards BOTH pane ids from its environment as
SEPARATE witnesses (herdrPane / tmuxPane) beside the pid. They are never
merged: a tmux pane routinely inherits a stale HERDR_PANE_ID from the herdr
session that started the tmux server, and a combined field let that stale id
shadow the real TMUX_PANE. Each engine lane reads only its own witness.

CODEX MODE (--codex-notify)
---------------------------
codex has no SessionStart hook, but its config.toml `notify` setting runs a
program at turn boundaries with ONE JSON argument (verified against the codex
0.148.0 binary): {"type":"agent-turn-complete","thread-id":...,"turn-id":...,
"cwd":...,"input-messages":[...],"last-assistant-message":...}. The thread id
IS the rollout uuid, the id in $CODEX_HOME/sessions/.../rollout-...-{id}.jsonl,
which is exactly the identity space the engine's codex reader locates by. So
the same announce works: `notify = ["python3", <this script>, "--codex-notify"]`
makes codex spawn this script (as codex's own child, so the engine's ancestry
walk from our pid reaches the codex process) and we POST the same body with
sessionId = thread-id. Fires per turn rather than at start: later than claude's
SessionStart, but idempotent engine-side, same as UserPromptSubmit re-announces.
"""
import http.client
import json
import os
import socket
import sys
import urllib.request


# Non-claude harnesses that ship a CLAUDE-COMPAT layer and so execute claude's
# hooks. When one sits ABOVE this hook the SessionStart it fired belongs to a
# FOREIGN session, not to a claude pane owner (grok 1.0.34's compat layer, and
# codex/cursor the same way). Detected by ancestry, the same walk
# claudes_in_ancestry uses.
FOREIGN_HARNESSES = ("grok", "codex", "cursor")


def _ancestor_comms():
    """The comm (process name) of every process ABOVE this hook, nearest
    ancestor first. Linux reads /proc per hop (no subprocess); macOS takes ONE
    ps snapshot and walks it. A read that fails mid-walk stops the walk and
    returns what was gathered, so a process exiting under us never raises. The
    walk itself may raise on a first-hop failure; callers pick their fail-open
    answer. CYC_ANNOUNCE_ANCESTRY_OVERRIDE (test only) supplies the chain
    directly, comma-separated, so the ancestry cases are exercisable without a
    real grok/claude process tree.
    """
    override = os.environ.get("CYC_ANNOUNCE_ANCESTRY_OVERRIDE")
    if override is not None:
        return [c for c in override.split(",") if c]
    table = None  # Linux: read /proc per hop, no subprocess
    if not os.path.isdir("/proc/%d" % os.getpid()):
        # macOS (no /proc): ONE ps snapshot, then walk the map
        import subprocess
        out = subprocess.run(["ps", "-axo", "pid=,ppid=,comm="],
                             capture_output=True, text=True, timeout=2).stdout
        table = {}
        for ln in out.splitlines():
            parts = ln.split(None, 2)
            if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
                table[int(parts[0])] = (int(parts[1]), parts[2])
    comms = []
    pid = os.getppid()
    for _ in range(40):
        if pid <= 1:
            break
        if table is None:
            try:
                with open("/proc/%d/comm" % pid) as fh:
                    comm = fh.read().strip()
                with open("/proc/%d/stat" % pid) as fh:
                    ppid = int(fh.read().rsplit(")", 1)[1].split()[1])
            except Exception:
                break
        else:
            if pid not in table:
                break
            ppid, comm = table[pid]
            comm = comm.rsplit("/", 1)[-1]
        comms.append(comm)
        pid = ppid
    return comms


def claudes_in_ancestry() -> int:
    """How many claude processes sit ABOVE this hook in the process tree.
    The pane-owning claude has exactly 1 (itself). A claude spawned by another
    claude's tool call (pi-run bridge, nested `claude -p`, etc.) has 2+ and
    must NOT announce: it inherits HERDR_PANE_ID from the pane owner, and its
    announce would stomp the pane's binding with the child's session id (the
    flicker bug of 2026-08-29). Fail-open: any error counts as 1.
    """
    try:
        count = 0
        for comm in _ancestor_comms():
            if comm == "claude" or comm.startswith("claude"):
                count += 1
    except Exception:
        return 1
    return count or 1


def foreign_harness_in_ancestry() -> bool:
    """True when a NON-claude compat harness (grok, codex, cursor) sits above
    this hook: its claude-compat layer ran claude's SessionStart hook inside a
    FOREIGN session. Announcing then would POST that foreign session id with
    whatever HERDR_PANE_ID the harness inherited, re-keying the witnessed pane
    to the foreign session (the 2026-09-18 aiusage-grok cron steal). A real
    claude pane owner has no such ancestor, and codex's own --codex-notify path
    never runs this claude-stdin branch. Fail-open: any error returns False so
    a real claude still announces.
    """
    try:
        for comm in _ancestor_comms():
            base = comm.rsplit("/", 1)[-1]
            for h in FOREIGN_HARNESSES:
                if base == h or base.startswith(h):
                    return True
    except Exception:
        return False
    return False


def body_from_claude_stdin():
    """Claude hook mode: the event JSON arrives on stdin."""
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    sid = payload.get("session_id") or ""
    if not sid:
        return None
    if claudes_in_ancestry() >= 2:
        # nested claude (child of the pane owner's tool call): stay silent so
        # the inherited HERDR_PANE_ID cannot re-key the pane to the child.
        return None
    if foreign_harness_in_ancestry():
        # a claude-compat harness (grok, codex, cursor) ran this hook inside its
        # OWN session: announcing would bind that foreign id to the pane whose
        # HERDR_PANE_ID we inherited (the aiusage-grok steal). Stay silent; the
        # harness's own announce path (e.g. --codex-notify) carries its identity.
        return None
    return {
        "sessionId": sid,
        # this hook's own pid: the engine walks the process tree UP from it to
        # the claude that fired the hook, while this process still exists
        # (urlopen below blocks until the engine has answered)
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "cwd": payload.get("cwd") or os.getcwd(),
        "transcriptPath": payload.get("transcript_path") or None,
        "herdrPane": os.environ.get("HERDR_PANE_ID") or None,
        "tmuxPane": os.environ.get("TMUX_PANE") or None,
        "event": payload.get("hook_event_name") or "",
        "source": payload.get("source") or "",
    }


def body_from_codex_argv():
    """Codex notify mode: the event JSON is the LAST argv (codex appends it)."""
    if len(sys.argv) < 3:
        return None
    try:
        payload = json.loads(sys.argv[-1])
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    # kebab-case per the binary's serde rename; snake_case tolerated in case a
    # codex version changes the spelling
    sid = (payload.get("thread-id") or payload.get("thread_id")
           or payload.get("session-id") or payload.get("session_id") or "")
    if not sid:
        return None
    return {
        "sessionId": sid,
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "cwd": payload.get("cwd") or os.getcwd(),
        "transcriptPath": None,  # notify carries no rollout path; locate-by-id suffices
        "herdrPane": os.environ.get("HERDR_PANE_ID") or None,
        "tmuxPane": os.environ.get("TMUX_PANE") or None,
        "event": payload.get("type") or "",
        "source": "codex-notify",
    }


class UnixHTTPConnection(http.client.HTTPConnection):
    """http.client over an AF_UNIX socket: the CYC_ENGINE_URL unix: form. Only
    connect() differs from the stdlib class -- it opens the socket path instead
    of a TCP host:port -- so request()/getresponse() work unchanged. Stdlib
    only, no dependency, in keeping with this hook's dependency-free contract."""

    def __init__(self, path, timeout=2):
        super().__init__("localhost", timeout=timeout)
        self._unix_path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._unix_path)
        self.sock = s


def _expand_tilde(p: str) -> str:
    if p == "~":
        return os.path.expanduser("~")
    if p.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), p[2:])
    return p


def post_announce(body) -> None:
    """POST the announce to the engine named by CYC_ENGINE_URL (unix: or
    http://), else the deprecated AGENT_PORT fallback. Raises on failure; the
    caller swallows it (the hook stays exit-0-on-failure)."""
    data = json.dumps(body).encode("utf-8")
    headers = {"content-type": "application/json"}
    engine = (os.environ.get("CYC_ENGINE_URL") or "").strip()
    if engine.startswith("unix:"):
        conn = UnixHTTPConnection(_expand_tilde(engine[len("unix:"):]), timeout=2)
        try:
            conn.request("POST", "/harness/announce", body=data, headers=headers)
            conn.getresponse().read()
        finally:
            conn.close()
        return
    if engine:
        url = engine.rstrip("/") + "/harness/announce"
    else:
        # DEPRECATED fallback: the pre-CYC_ENGINE_URL port var. One stderr line
        # per invocation so a stale unit is visible without breaking the hook.
        port = os.environ.get("AGENT_PORT") or "10101"
        sys.stderr.write("[cyc] AGENT_PORT fallback is deprecated; set CYC_ENGINE_URL\n")
        url = "http://127.0.0.1:%s/harness/announce" % port
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    urllib.request.urlopen(req, timeout=2)


def main() -> int:
    if "--codex-notify" in sys.argv[1:]:
        body = body_from_codex_argv()
    else:
        body = body_from_claude_stdin()
    if body is None:
        return 0
    try:
        post_announce(body)
    except Exception:
        pass  # dead or absent engine: claude must not notice
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
