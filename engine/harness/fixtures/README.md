# Fixture copies of the real config formats

Never the machine's live configs; these are captures from isolated probe runs
on this box, with names and paths neutralized.

- `opencode.json`: exact shape `opencode mcp add` (opencode 1.18.19) wrote
  into a scratch `XDG_CONFIG_HOME`.
- `codex-config.toml`: exact shape `codex mcp add` (codex 0.148.0) wrote into
  a scratch `CODEX_HOME`, plus the `[hooks.state."..."]` entries codex keeps
  for hook trust (captured after trusting the probe hooks).
- `codex-hooks.json`: the Claude-settings-compatible hooks schema codex's
  `hooks/list` RPC parsed from a scratch `CODEX_HOME/hooks.json`, here holding
  a foreign PreToolUse/SessionStart pair the merge must not disturb.
