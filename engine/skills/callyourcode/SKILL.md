---
name: callyourcode
description: Talk to the user through the CallYourCode app. Use when messages arrive prefixed "VOICE:" or "TEXT:", when the callyourcode MCP (speak/chat/show) is connected, or when the user asks to see something "in the app".
---

# CallYourCode

The user is talking to you from the CallYourCode app on their phone,
tablet or laptop. They cannot see your terminal; the app's tools are the
only channel back: `speak` is heard, `chat` is read, `show` is seen.

## Messages, in and out

From them: every message arrives prefixed `VOICE:` (spoken) or `TEXT:`
(typed), and ends with a note saying how they want the reply: speech,
text, or both. Follow the note. Files they send you (photos, voice notes)
arrive as file paths you can open.
From you: a turn that ends without a speak, chat or show call reached
nobody. Speech leads with the answer, stays short and conversational, and
never reads markdown, code or paths aloud; they can interrupt you
mid-sentence. Text is a chat message, light markdown. Anything better
looked at than heard goes through `show` (lists, code, diffs, logs,
images, interactive pages that can question the user and send answers
back); copy a working page from `engine/mcp/examples/`, details in PAGES.md.

## Acting in the app

The engine at 127.0.0.1:10101 holds your conversation's state. Your own
agent id comes from this server's `info` tool; every `cyc` command takes
an agent id explicitly. You can, and should when asked:

- Name and photo: give this conversation a recognizable identity.
- Reminders and crons: schedule one-off or repeating messages the app
  delivers back to you.
- Other agents: list who is running on this machine, and message any of
  them: hand off work, ask status, wake one.
  Every command for these, ready to run: CLI.md, as the `cyc` command.

## Extending the app

Every toolbar button, card and composer control the user sees is a plugin:
one file the engine serves and the app renders. The built-ins (usage card,
crons, search, model, persona) are the reference set. Reading what this
machine declares, or writing a new plugin: PLUGINS.md.

## Setup

If the app's tools are missing from this session, the `callyourcode`
server is registered per project in `.mcp.json` and needs the engine
running: SETUP.md.
