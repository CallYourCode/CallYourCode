# Fixtures

## Transcripts (#612)

Captured session files the multi-harness readers are proven against. None of
these is a Claude jsonl; pointing the Claude parser at them is the guess this
lane forbids.

- `pi-session.jsonl` -- first turns of a live pi/grok session on this box
  (`~/.pi/agent/sessions/--home-user-projects-wt-612-engine-multiharness--/`).
  User text trimmed; tool args stubbed. Shape is otherwise as pi wrote it.
- `codex-rollout.jsonl` -- disposable `codex exec` under an isolated
  `CODEX_HOME` (`sessions/YYYY/MM/DD/rollout-...-<id>.jsonl`). Developer dumps
  dropped; user/assistant/task/token records kept.
- `opencode-session.json` -- disposable `opencode run` under an isolated
  `XDG_DATA_HOME`. Dump of that session's `session` / `message` / `part` rows
  from `opencode.db` (the live store is SQLite, not jsonl).

## Pane screens for the delivery guard

Every version of that guard which shipped a defect was agreed with by a harness
that drew its own screens. So these are the real ones, and the naming says
which is which:

- **`pane-*.txt` are CAPTURES.** Bytes exactly as `herdr pane.read --format
  ansi` returned them from a live claude pane. Regenerate the same way. Do not
  hand-edit: the SGR codes are the evidence.
  The `pane-fresh-claude-*` three came off `tmux capture-pane -p -e` on a
  throwaway tmux server (`tmux -L lane7probe`, its own directory, none of the
  user's panes) 30s after starting a real `claude`, one per width; the same
  screen was captured at 3, 5, 8, 12, 15, 20, 30, 45, 60 and 90 seconds at each
  width and the tip is present at every one of the thirty.
  The `pane-model-picker-2.1.222-*` three came off the same kind of server
  (`tmux -L cyc254probe`, its own directory under the scratchpad, none of his
  panes): start `claude`, type `/model`, press enter, capture. The screen is
  identical at 60, 100 and 200 columns apart from where the model blurbs wrap,
  and identical on a fresh pane and one that has finished a turn.
  `pane-ghost-suggestion-2.1.228.txt` came off the same kind of server
  (`tmux -L cyc495probe`, its own scratchpad directory, none of his panes):
  start a real `claude` 2.1.228, trust the folder, capture the empty composer.
  The session was NOT logged in, so this is the PLACEHOLDER ghost (`Try "fix
  lint errors"`), not the history-completion ghost from the #495 incident (`yes
  commit the card routine`); the completion ghost could not be drawn without
  auth. Both are the composer's grey suggestion; that the completion variant
  dims the same way is inferred, not measured.
- **`assembled-*.txt` are NOT captures.** Each is built from a capture to reach
  a shape that could not be produced on a live pane, and says below what it was
  built from and what could not be reproduced. A fixture that claims to be
  evidence and is not is worse than no fixture.

## Captures

| file | what it is | classifies as |
|---|---|---|
| `pane-ordinary-turn.txt` | a FINISHED turn ending in a numbered list and a question, healthy empty box below. The shape a chooser-first classifier read as a prompt, refusing delivery to a good session and deadlocking it (0.07% of his real turns) | `input`, no content |
| `pane-turn-running.txt` | a turn STREAMING. The prompt marker is painted grey (`38;2;153;153;153`); a parser that reads the `2` of a truecolor introducer as SGR 2 (dim) discards the row and refuses delivery for most of every turn | `input`, no content |
| `pane-tool-use.txt` | mid tool-use, same grey marker | `input`, no content |
| `pane-permission-prompt.txt` | a real permission prompt (`Read(/etc/hosts)`, a read outside the pane's cwd). No box at all; `❯ 1. Yes` is highlighted, and enter selects it | `chooser` |
| `pane-permission-after-turn.txt` | the same prompt reached after an earlier completed turn, so the echoed user message and previous output sit above it | `chooser` |
| `pane-prompt-after-rule-in-prose.txt` | **the one that nearly shipped an approval.** A reply containing a literal U+2500 line, then a real `Write` permission prompt. The prose rule and the panel's rule pair into a box whose interior opens `> quoted`, so every structural test for "input" passes on a screen that is a prompt. Only what sits BELOW the last rule tells them apart | `chooser` |
| `pane-body-with-rule.txt` | an idle pane at a healthy input box holding a typed message that itself contains a full-width rule -- relaying another agent's reply, which is the everyday shape that produces one. Counting the opening rule backwards lands on THAT rule instead of the box's own top | `input`, with content |
| `pane-body-ending-in-rule.txt` | the same shape, but the body's LAST row is the rule. **This is the one that discriminates.** With a positional opening rule the neighbour above still leaves a non-empty interior and the verdict does not change; here the interior collapses to nothing, the box vanishes, and the pane is refused for ever | `input`, with content |
| `pane-model-picker.txt` | the `/model` picker on 2.1.221, with **one model more than fits**: the last visible choice carries the `↓` scroll mark in the caret column, so it is not a choice line and the run of numbers is one short. Four buttons for five models would be the app claiming a list it does not have | `unknown` |
| `pane-model-picker-2.1.222-100col.txt`, `pane-model-picker-2.1.222-60col.txt` | the same picker on 2.1.222, six models and all of them on screen. It draws no horizontal rule anywhere, so neither the below-the-rule check nor the box search can see it and the whole screen goes to `parseAsk`. Two rows made that answer null: the effort control (`● High effort (default) ←/→ to adjust`) between the last choice and the footer, and (at 60 columns only) the last model's blurb wrapping onto a row of its own BELOW that choice. `unknown` is delivered to, so a message sent to a session sitting here was typed at the picker and the enter behind it set the highlighted model | `chooser` |
| `pane-model-picker-2.1.222-after-turn.txt` | the same picker opened over a finished turn, so what is above it is transcript rather than the welcome box. It is what proves the context walk stops at the viewport rule in both directions: nothing of the banner on a fresh pane, nothing of the conversation on a used one, and the same fingerprint either way | `chooser` |
| `pane-fresh-claude-100col.txt`, `pane-fresh-claude-200col.txt` | **a freshly started `claude` 2.1.222, which no longer draws a plain rule above its box.** A highlighted tip is printed INSIDE the top edge (`──────── Set up local voice conversations… ──`), so the pair of rules the old classifier looked for is not on the screen and a freshly started pane read `unknown` at every width and moment captured. A pane MID-CONVERSATION was not captured, so how far past a fresh start this holds is inferred from where the tip is drawn, not measured | `input`, no content |
| `pane-fresh-claude-60col.txt` | the same thing narrow, and it is a different failure rather than a smaller one: the tip displaces the entire leading run and then WRAPS onto two rows, so there is no top edge on the screen in any form, and the closing edge wraps too. Nothing can pair here; the box has to be found from its bottom | `input`, no content |
| `pane-ghost-suggestion-2.1.228.txt` | **the #495 hazard: claude 2.1.228's GHOST TEXT in an empty composer.** The box holds `❯ \x1b[2mTry "fix lint errors"\x1b[0m`, a grey suggestion the user never typed. It is drawn under SGR 2 (dim), the same treatment the older suggestion measured in `herdr.ts` gets, so `nonDimText` discards it and the box reads empty. The one signal that separates it from a real draft is that dim byte, which is why the box is read as ansi and never stripped; a plain-text read calls this box occupied and presses enter at the ghost. Placeholder ghost, not the logged-in history-completion variant (see the capture note above) | `input`, no content |

## Assembled

- **`assembled-prompt-scrolled.txt`**: `pane-permission-prompt.txt` with the
  question, the options and the footer cut, and three plain rows prepended
  carrying one full-width rule. It stands for a prompt whose tail has scrolled
  out of the viewport while an unrelated rule remains above it, which is the
  only thing the prompt-marker condition in `classifyPaneBox` guards.

  **Correction.** This file used to carry a note saying a second rule was hard
  to come by, because a markdown `---` renders as literal dashes. That was
  wrong and it cost a real defect: a literal U+2500 in prose renders as a bare
  full-width rule in one turn, which is exactly what
  `pane-prompt-after-rule-in-prose.txt` captures. "I could not reproduce it" is
  not "it does not happen", and a guard was deleted on the strength of that
  confusion. The shape this assembled file describes is still unobserved, but
  its neighbour is not.

`PROMPT_PLUS_RULE` and `PROMPT_REWORDED` in `multipart.test.ts` are derived in
the test from the permission capture, for the same reason and with the same
caveat. They are built in code where the derivation is visible, not saved here
as though they had been read off a terminal.
