#!/usr/bin/env python3
"""PreToolUse hook for CODEX (hooks.json): never go dark on a shell call.

The codex port of hooks/enforce-bash-async.py. Codex 0.148 runs Claude-shaped
command hooks from ~/.codex/hooks.json: stdin carries a JSON payload with
hook_event_name / tool_name / tool_input, exit 0 allows, exit 2 blocks with
stderr fed back to the model.

WHAT IS DIFFERENT FROM THE CLAUDE HOOK, AND WHY
-----------------------------------------------
- Codex shell payloads vary by harness: the command may be in `command` or
  `cmd`, and the bounded foreground window may be `timeout_ms`, `timeout`, or
  `yield_time_ms`. These shapes are handled explicitly.
- There is NO run_in_background parameter, so that arm of the contract does
  not exist. The advice degrades honestly: cap the timeout, and for long jobs
  redirect output to a file and poll it in short calls.
- hooks.json entries here carry no matcher (codex's shell tool name is not
  pinned across versions), so this script self-filters: it only judges
  payloads that look like a shell call, and allows everything else.
- codex's `apply_patch` tool ALSO carries its argument in a `command` field --
  but that field is the PATCH TEXT (`*** Begin Patch ...`), not a shell line.
  It is recognised and allowed up front, otherwise the detach/`&` scan reads
  the patch BODY and blocks any edit whose content mentions nohup/setsid or a
  `&` (confirmed over-block in codex 0.148: even a doc line or a script edit
  containing `&` was blocked). apply_patch is not a shell call.

THE RULE
--------
  setsid / nohup / shell `&`     -> BLOCK  (detached: nothing wakes the agent)
  timing field set > 60000       -> BLOCK  (explicitly too long a foreground)
  timing field set <= 60000      -> ALLOW  (short leash)
  no timing field                -> ALLOW  (see below)

WHY THE ABSENT CASE IS ALLOWED (NOT BLOCKED)
--------------------------------------------
Codex's shell/exec tools make the timing field OPTIONAL: the standard tool
(`shell` / `local_shell`) has an optional `timeout_ms`, and the unified-exec
tool has an optional `yield_time_ms` (CONFIRMED in codex-cli 0.148.0's tool
schema and in real rollouts on this machine). The model omits it freely --
notably for quick commands (`pwd`) -- so hard-blocking every field-less call
bricks codex on ordinary work (the reported bug: even `pwd` was blocked).
The engine launches codex with `--dangerously-bypass-approvals-and-sandbox`, so
there is no sandbox kill here; the reason the field-less case is still safe to
allow is that codex's exec streams output back and yields control to the model
rather than sitting silently, so it is not the dark unbounded foreground hang
the claude Bash hook guards against. We therefore ALLOW the absent case and
still BLOCK the two calls that genuinely go dark: a DETACHED job (nothing wakes
the agent) and an EXPLICIT over-long timeout.

FAILS OPEN
----------
Any error at all -> exit 0. A bug in this hook must never trap a session.

PROTOCOL
--------
stdin : the hook payload, JSON
exit 0: allow the tool call
exit 2: block it; stderr is fed back to the model as the reason
"""

import json
import re
import sys

MAX_TIMEOUT_MS = 60_000

DETACH_RE = re.compile(r"(?<![\w./-])(setsid|nohup)(?![\w-])", re.IGNORECASE)

# Names Codex has used for shell execution. A tool is judged as a shell call
# when its name is in this set OR its tool_input carries a command-shaped field
# (see main). Codex reports its live shell tool as `Bash` in the hook payload
# (CONFIRMED in codex 0.148 rollouts); the other names are historical/variant.
# apply_patch DOES carry a `command` field (the patch text), so it is excused
# explicitly in main -- the command-shaped fallback alone would misjudge it.
SHELL_TOOLS = {
    "shell",
    "local_shell",
    "exec_command",
    "unified_exec",
    "bash",
    "Bash",
    "container.exec",
    "functions.exec_command",
}

# apply_patch is NOT a shell call, but codex puts its patch text in a `command`
# field (CONFIRMED in codex 0.148 rollouts), so the command-shaped fallback
# below would otherwise judge it as shell and scan the patch BODY. Recognised
# by name AND by the patch envelope, so a renamed apply_patch is still excused.
APPLY_PATCH_TOOLS = {
    "apply_patch",
    "functions.apply_patch",
    "container.apply_patch",
}
PATCH_ENVELOPE = "*** Begin Patch"


def allow():
    sys.exit(0)


def block(reason):
    print(reason, file=sys.stderr)
    sys.exit(2)


def has_background_amp(cmd: str) -> bool:
    """Same parser as the claude hook: an unquoted `&` that is not `&&` and
    not part of a redirect (`&>`, `>&`, `2>&1`) backgrounds the job."""
    i, n = 0, len(cmd)
    quote = None
    while i < n:
        c = cmd[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if c in ("'", '"'):
            quote = c
            i += 1
            continue
        if c == "&":
            if i + 1 < n and cmd[i + 1] == "&":
                i += 2
                continue
            if i + 1 < n and cmd[i + 1] == ">":
                i += 2
                continue
            prev = cmd[i - 1] if i > 0 else ""
            if prev == ">":
                i += 1
                continue
            return True
        i += 1
    return False


def command_text(raw):
    """The shell text to scan, from either codex shape.

    Argv arrays: scan the script argument(s), not the interpreter. For
    ["bash", "-lc", "cmd"] that is "cmd"; joining everything after the first
    element also covers plain argv commands without misreading "/bin/bash"
    as content.
    """
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list) and raw and all(isinstance(x, str) for x in raw):
        if len(raw) == 1:
            return raw[0]
        return " ".join(raw[1:])
    return None


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        allow()

    payload = json.loads(raw)
    if not isinstance(payload, dict):
        allow()

    if payload.get("hook_event_name") not in (None, "PreToolUse"):
        allow()

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        allow()

    command = command_text(tool_input.get("command", tool_input.get("cmd")))
    has_command = isinstance(command, str) and bool(command.strip())

    # apply_patch carries the PATCH TEXT in `command`, not a shell line: it is
    # not a shell call, so scanning its body for detach/`&` would block any edit
    # whose CONTENT mentions nohup/setsid or a `&`. Allow it, by tool name or by
    # the patch envelope (a renamed apply_patch still starts with it).
    tool_name = payload.get("tool_name")
    if tool_name in APPLY_PATCH_TOOLS:
        allow()
    # The envelope allow is gated on the tool NOT being a known shell tool: a
    # renamed apply_patch stays excused, but a Bash/shell call whose command
    # merely STARTS with the envelope must not skip the detach scan (its later
    # lines could still detach). Such a call falls through to enforcement below.
    if (
        has_command
        and tool_name not in SHELL_TOOLS
        and command.lstrip().startswith(PATCH_ENVELOPE)
    ):
        allow()

    # Judge a tool as shell when its name is known OR its input is command
    # shaped: a renamed-but-command-carrying tool must not escape enforcement.
    if tool_name not in SHELL_TOOLS and not has_command:
        allow()

    if not has_command:
        allow()

    m = DETACH_RE.search(command)
    if m:
        block(
            f"BLOCKED: `{m.group(1)}` detaches the process, so nothing wakes you when it "
            "finishes and the user hears silence. Drop it and re-run with timeout_ms <= "
            f"{MAX_TIMEOUT_MS}; for a long job, redirect its output to a file and poll that "
            "file in short commands."
        )

    if has_background_amp(command):
        block(
            "BLOCKED: a shell `&` backgrounds the job behind the harness's back, so nothing "
            f"wakes you when it finishes. Remove the `&` and set timeout_ms <= {MAX_TIMEOUT_MS} "
            "(quote the argument if the `&` was meant literally, e.g. in a URL); for a long "
            "job, redirect output to a file and poll it in short commands."
        )

    timeout = tool_input.get("timeout_ms")
    if timeout is None:
        timeout = tool_input.get("timeout")
    if timeout is None:
        timeout = tool_input.get("yield_time_ms")
    if isinstance(timeout, bool):
        timeout = None
    if isinstance(timeout, str):
        try:
            timeout = float(timeout.strip())
        except ValueError:
            timeout = None
    if isinstance(timeout, (int, float)) and 0 < timeout <= MAX_TIMEOUT_MS:
        allow()

    if isinstance(timeout, (int, float)) and timeout > MAX_TIMEOUT_MS:
        block(
            f"BLOCKED: timeout {int(timeout)}ms is longer than {MAX_TIMEOUT_MS}ms. While a "
            "foreground shell call runs you cannot answer the user, and in a voice "
            "conversation going quiet is indistinguishable from having died. Lower "
            f"timeout_ms to <= {MAX_TIMEOUT_MS}; for anything slow (installs, builds, test "
            "suites) redirect output to a file and poll it in short commands."
        )

    # No timing field: ALLOW. Codex's shell/exec tools make the field optional
    # (timeout_ms / yield_time_ms), and codex's exec streams output back and
    # yields to the model rather than going silent, so a field-less call is not
    # the dark unbounded foreground hang the claude Bash hook guards against.
    # Blocking it here bricked codex on ordinary commands (e.g. pwd). The dark
    # cases -- detached jobs and explicit over-long timeouts -- are blocked above.
    allow()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - fail OPEN, always, whatever happened
        sys.exit(0)
