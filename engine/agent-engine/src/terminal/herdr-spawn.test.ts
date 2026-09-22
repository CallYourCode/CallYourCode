/* The herdr spawn hardening's pure decision (herdr.ts commandTypedIntact).
 *
 * The fixture is the LIVE failure capture (k8plus 2026-09-22 02:43, the
 * MusicBrowser reopen): an oh-my-zsh update prompt ate the first character of
 * the typed launch, `env` became `nv`, the command errored and claude never
 * started. The tail of the command was fully intact, which is exactly why the
 * tmux path's tail check (stillAwaitingSubmit) cannot catch this shape and
 * the typed line must be verified by CONTAINMENT of the whole command.
 *
 *   bun test agent-engine/src/terminal/herdr-spawn.test.ts
 */

import { test, expect } from "bun:test";
import { commandTypedIntact } from "./herdr.ts";

const CMD = "env CYC_AGENT_ID=ag-uyNmU1o7MHgRq_Sn claude --dangerously-skip-permissions --resume 8764ee81-2abc-4e09-b2aa-eddd59fbe499";

test("the live head-mangled capture is NOT intact (env -> nv, tail untouched)", () => {
  const capture =
    "[oh-my-zsh] Would you like to update? [Y/n] env CYC_AGENT_ID=ag-uyNmU1o7MHgRq_Sn claude --dangerously-skip-permissions -\n" +
    "-resume 8764ee81-2abc-4e09-b2aa-eddd59fbe499\n" +
    "[oh-my-zsh] You can update manually by running `omz update`\n" +
    "\n" +
    "  02:43:31  ~/pro/p/musicbrowserbuilder   master ❯ nv CYC_AGENT_ID=ag-uyNmU1o7MHgRq_Sn claude --dangerously-skip-per\n" +
    "missions --resume 8764ee81-2abc-4e09-b2aa-eddd59fbe499\n" +
    "zsh: command not found: nv\n" +
    "  02:43:31  ~/pro/p/musicbrowserbuilder   master ❯";
  /* The [Y/n] line happens to echo the full command too, but that echo went to
   * the updater, not the shell; strip it the way a real second attempt sees
   * the screen (the updater's echo scrolled off, only the shell line remains). */
  const afterScroll = capture.split("\n").slice(2).join("\n");
  expect(commandTypedIntact(afterScroll, CMD)).toBe(false);
});

test("a wrapped, prompt-prefixed, ANSI-coloured intact line IS intact", () => {
  const capture =
    "  02:45:10  ~/pro/p/musicbrowserbuilder   master ❯ \x1b[32menv\x1b[0m CYC_AGENT_ID=ag-uyNmU1o7MHgRq_Sn claude --dangerously-skip-per\n" +
    "missions --resume 8764ee81-2abc-4e09-b2aa-eddd59fbe499";
  expect(commandTypedIntact(capture, CMD)).toBe(true);
});

test("a wrap point falling on a command space still reads as intact", () => {
  // the terminal broke the line exactly at the space after `claude`; the
  // whitespace-insensitive containment must not care
  const capture =
    "❯ env CYC_AGENT_ID=ag-uyNmU1o7MHgRq_Sn claude\n" +
    "--dangerously-skip-permissions --resume 8764ee81-2abc-4e09-b2aa-eddd59fbe499";
  expect(commandTypedIntact(capture, CMD)).toBe(true);
});

test("an empty or unrelated screen is not intact", () => {
  expect(commandTypedIntact("", CMD)).toBe(false);
  expect(commandTypedIntact("$ ls\nsrc  README.md\n$", CMD)).toBe(false);
});
