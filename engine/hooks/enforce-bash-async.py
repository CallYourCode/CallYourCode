#!/usr/bin/env python3
"""PreToolUse hook (matcher: Bash): never go dark on a Bash call.

WHY THIS EXISTS
---------------
Claude is single-threaded. While a foreground Bash call runs, it *physically cannot answer
you*. In a terminal you can at least see the command running. In a voice conversation, going
dark is indistinguishable from the assistant having died.

The hook does not try to predict how long a command takes. It asks one question:
*did you promise this is fast, or did you background it properly?* Both answers leave the
assistant able to talk.

THE RULE (Bash only)
--------------------
  run_in_background: true          -> ALLOW  (the harness tracks it and wakes Claude on exit)
  timeout set and <= 60000 ms      -> ALLOW  (short leash; killed if the guess was wrong)
  otherwise                        -> BLOCK

Also BLOCK manual detaching -- `setsid`, `nohup`, or a trailing `&`. Those escape the harness:
the job finishes and *nothing wakes the agent*. Backgrounding must go through
`run_in_background`, which the harness owns.

60 s, not 30 s: raising the short leash is recommended, because most legitimate
foreground commands (a test run, a build check) land under a minute, and it cuts the
blocked-and-retry churn.

FAILS OPEN
----------
Any error at all -> exit 0, tool call allowed. A bug in this hook must never trap a session.

PROTOCOL
--------
stdin : the hook payload, JSON
exit 0: allow the tool call
exit 2: block it; stderr is fed back to Claude as the reason
"""

import json
import re
import sys

MAX_TIMEOUT_MS = 60_000

DETACH_RE = re.compile(r"(?<![\w./-])(setsid|nohup)(?![\w-])", re.IGNORECASE)


def allow():
    sys.exit(0)


def block(reason):
    print(reason, file=sys.stderr)
    sys.exit(2)


def has_background_amp(cmd: str) -> bool:
    """True if the command contains a shell `&` background operator.

    In bash, an unquoted `&` that is not `&&` and not part of a redirect (`&>`, `>&`, `2>&1`)
    is always the background control operator -- whether trailing (`cmd &`) or mid-line
    (`cmd & other`). Quoting and escaping are respected, so `curl 'a?x=1&y=2'` is fine.
    """
    i, n = 0, len(cmd)
    quote = None  # "'" or '"' when inside a quoted string
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
            i += 2  # escaped char, `\&` included
            continue
        if c in ("'", '"'):
            quote = c
            i += 1
            continue

        if c == "&":
            if i + 1 < n and cmd[i + 1] == "&":  # && logical and
                i += 2
                continue
            if i + 1 < n and cmd[i + 1] == ">":  # &> redirect
                i += 2
                continue
            prev = cmd[i - 1] if i > 0 else ""
            if prev == ">":  # 2>&1, >&2 redirect
                i += 1
                continue
            return True

        i += 1
    return False


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        allow()

    payload = json.loads(raw)
    if not isinstance(payload, dict):
        allow()

    if payload.get("tool_name") != "Bash":
        allow()

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        allow()  # shape we don't understand: not our business

    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        allow()

    # 1. manual detaching escapes the harness -- nothing would wake the agent.
    m = DETACH_RE.search(command)
    if m:
        block(
            f"BLOCKED: `{m.group(1)}` detaches the process from the harness, so nothing wakes "
            "you when it finishes and the user hears silence. Drop it and re-run the command "
            "with run_in_background: true -- the harness tracks the job and re-invokes you on "
            "exit."
        )

    if has_background_amp(command):
        block(
            "BLOCKED: a shell `&` backgrounds the job behind the harness's back, so nothing "
            "wakes you when it finishes. Remove the `&` and pass run_in_background: true "
            "instead (quote the argument if the `&` was meant literally, e.g. in a URL)."
        )

    # 2. properly backgrounded: the harness owns it and will wake Claude on exit.
    if tool_input.get("run_in_background") is True:
        allow()

    # 3. short leash: it promised this is fast, and it gets killed if the promise was wrong.
    timeout = tool_input.get("timeout")
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
            "foreground Bash call runs you cannot answer the user, and in a voice conversation "
            "going quiet is indistinguishable from having died. Either set run_in_background: "
            f"true (preferred for anything slow: installs, builds, downloads, test suites, "
            f"benchmarks), or lower the timeout to <= {MAX_TIMEOUT_MS}ms if it really is fast."
        )

    block(
        "BLOCKED: this Bash call has no timeout and is not backgrounded, so it could hang the "
        "conversation for an unbounded time -- and while it runs you cannot answer the user. "
        "Re-run it EITHER with run_in_background: true (preferred for anything slow: installs, "
        f"builds, downloads, test suites, benchmarks) OR with timeout <= {MAX_TIMEOUT_MS} (ms) "
        "if it is genuinely fast."
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - fail OPEN, always, whatever happened
        sys.exit(0)
