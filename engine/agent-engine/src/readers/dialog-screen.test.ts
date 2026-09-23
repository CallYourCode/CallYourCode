/* The dialogScreen detectors (readers/*.ts): known modal-dialog text, captured
 * from live panes on this box, must match; normal working/idle screens must
 * not. A false "blocked" is worse than a missed dialog, so every fixture here
 * is a real capture, never an invented shape.
 *
 *   bun test agent-engine/src/readers/dialog-screen.test.ts
 */

import { describe, expect, test } from "bun:test";
import { piReader } from "./pi.ts";
import { codexReader } from "./codex.ts";
import { opencodeReader } from "./opencode.ts";
import { claudeReader } from "./claude.ts";

const PI_SELECTOR = `  (1/58)

  Model Name: Claude Haiku 4.5 (latest)

  Model catalogs refreshed.

  Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel
────────────────────────────
~/pitest2
0.0%/200k (auto)     (claude-bridge) claude-haiku-4-5 • medium`;

const PI_DEFENDER = ` BLOCKED by patterns.yaml (1/2)

Command:
 cat ~/.ssh/id_ed25519.pub 2>/dev/null

 Reason: Blocked: zero-access path

 [1] Allow anyway (dangerous)
 [2] Deny & Abort (stop entire prompt)

 Will auto-deny in 83s...`;

const PI_IDLE = `~/shaluai (master)
0.0%/1.0M (auto)     (claude-bridge) claude-opus-5-5 • medium`;

const PI_WORKING = ` Steering: TEXT: what is the plan...
 ⠹ Working...
~/shaluai (master)`;

const CODEX_UPDATE = `  ✨ Update available! 0.153.1 -> 0.153.3

  Release notes: https://github.com/openai/codex/rele

› 1. Update now (runs \`bun install -g @openai/codex\`)
  2. Skip
  3. Skip until next version

  Press enter to continue`;

const CODEX_HOOKS = `  Interrupt hooks
  Turn hooks on or off. Your changes are saved auto

  No hooks installed for this event.

  Press esc to go back`;

const CODEX_IDLE = `› Ask Codex to do anything

  gpt-6-astra default · ~/qtest`;

const OC_MODELS = `                       ┃  Buil    Nemotron 3.5 Lightning Free       Free
                                  Big Pickle                          Free

                                  DeepSeek

                                  Connect provider ctrl+a  Favorite ctrl+f

  ~/octest  ⊙ 0 MCP /status                                        1.18.19`;

const OC_IDLE = `  ~/octest  ⊙ 1 MCP /status                1.18.32`;

describe("dialogScreen: real dialogs match, normal screens do not", () => {
  test("pi", () => {
    expect(piReader.dialogScreen!(PI_SELECTOR)).toBe(true);
    expect(piReader.dialogScreen!(PI_DEFENDER)).toBe(true);
    expect(piReader.dialogScreen!(PI_IDLE)).toBe(false);
    expect(piReader.dialogScreen!(PI_WORKING)).toBe(false);
  });
  test("codex", () => {
    expect(codexReader.dialogScreen!(CODEX_UPDATE)).toBe(true);
    expect(codexReader.dialogScreen!(CODEX_HOOKS)).toBe(true);
    expect(codexReader.dialogScreen!(CODEX_IDLE)).toBe(false);
  });
  test("opencode", () => {
    expect(opencodeReader.dialogScreen!(OC_MODELS)).toBe(true);
    expect(opencodeReader.dialogScreen!(OC_IDLE)).toBe(false);
  });
  test("claude keeps parseScreen, not dialogScreen", () => {
    expect(claudeReader.dialogScreen).toBeUndefined();
    expect(claudeReader.parseScreen).toBeDefined();
  });
  test("no detector fires on another harness's dialog (kind dispatch stays honest)", () => {
    expect(piReader.dialogScreen!(CODEX_IDLE)).toBe(false);
    expect(codexReader.dialogScreen!(PI_IDLE)).toBe(false);
    expect(opencodeReader.dialogScreen!(PI_SELECTOR)).toBe(false);
  });
});
