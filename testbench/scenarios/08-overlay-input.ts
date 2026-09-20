/* 8. overlay input (design 9, scenario 8; TUI overlay bug)
 *
 * given  a bound row whose TUI has an overlay open (the slash-command
 *        palette: a "/" typed at the prompt, no Enter)
 * when   the person sends a message from the app
 * then   the engine never claims `landed` unless the transcript grew; it
 *        sends the dismiss keys (Escape) before typing; the message lands, or
 *        the row says `undelivered` with a reason. Never a silent loss. */

import type { Cell } from "../cell/driver.ts";
import { bringUp, sendFromApp, SPEC } from "./_lib.ts";

/* Overlay evidence on the screen, by what distinguishes an open palette from
 * the harness's permanent chrome:
 *  - a list of commands: two or more rows shaped `/name  description`
 *    (claude's palette; a box border may lead the row)
 *  - the composer holding a lone "/" (pi opens no list for a bare "/"; the
 *    pending slash sitting in its editor box is the overlay state)
 * pi's help banner ("escape interrupt · / commands · ! bash"), codex's header
 * ("/model to change") and opencode's footer ("ctrl+p commands") match
 * neither. */
const COMMAND_ROW = /^\s*[│┃|]?\s*\/[a-z][\w:-]*\s{2,}\S/;
const LONE_SLASH = /^\s*(?:[│┃|]\s*)?(?:[❯›>]\s*)?\/\s*(?:[│┃|]\s*)?$/;
export function overlayEvidence(screen: string): string | null {
  const lines = screen.split("\n");
  const rows = lines.filter((l) => COMMAND_ROW.test(l));
  if (rows.length >= 2) return `${rows.length} command rows: ${rows.slice(0, 2).map((l) => l.trim().slice(0, 40)).join(" / ")}`;
  const lone = lines.find((l) => LONE_SLASH.test(l));
  if (lone) return `the composer holds a lone "/": ${JSON.stringify(lone.trim())}`;
  return null;
}
/** the harness took the message as a slash command: the engine's `TEXT:`
 *  prefix landed behind the pending "/" */
const AS_COMMAND = /\/(?:TEXT|VOICE):/;

export default async function (c: Cell) {
  const { pane, row } = await bringUp(c);
  c.need("a bound row", !!row);
  const w = await c.wire();
  const mux = c.muxOf(pane);

  /* given: the slash palette is open */
  await mux.sendText(pane.id, "/");
  const overlay = (await c.waitFor(async () => { const t = await mux.capture(pane.id).catch(() => ""); return overlayEvidence(t) ? t : null; }, { ms: 6000, every: 400, label: "overlay evidence" }))
    ?? await c.snap("overlay-open", pane.id);
  await c.snap("overlay-open", pane.id);
  const evidence = overlayEvidence(overlay);
  c.expect("the TUI shows an overlay (slash palette) before the send", !!evidence, evidence ?? `no command rows and no lone "/" in the composer; screen tail: ${overlay.slice(-400)}`);

  /* when */
  const text = `through the overlay 08 ${Date.now() % 100000}`;
  const s = await sendFromApp(c, row!, text);
  const outcome = await c.waitFor(async () => {
    const t = await s.landedInTranscript();
    if (t) return { kind: "landed" as const, t };
    const u = s.chatRows().find((f) => f.state === "undelivered" || f.undelivered) ?? w.chatRows(row!.id, s.seq).find((f) => /not delivered|undelivered/i.test(String(f.text ?? "")));
    if (u) return { kind: "undelivered" as const, u };
    return null;
  }, { ms: SPEC.landedMs + 12_000, label: "landed or undelivered" });
  await Bun.sleep(1000);

  /* then */
  const landedRow = s.chatRows().find((f) => f.state === "landed");
  const t = await s.landedInTranscript();
  c.expect("no false `landed`: a landed row only ever exists once the transcript holds the message", !landedRow || !!t,
    landedRow ? `landed row at ${landedRow._ts}, transcript holds it: ${!!t}` : "no landed row on the wire");
  const after = await c.snap("after-send", pane.id);
  const claimed = c.engine().since(s.at).filter((l) => /utterance\.delivered/.test(l) && l.includes(s.cid));
  c.expect("the engine's own `delivered` claim is true only when the transcript holds the message (no silent loss behind a delivered line)",
    claimed.length === 0 || !!t, claimed.length ? `engine claimed: ${claimed[0].slice(0, 200)} | transcript holds it: ${!!t}` : "no delivered claim in the engine log");
  const stillOpen = overlayEvidence(after);
  /* the prompt as the harness recorded it: "TEXT: ..." when the "/" was
   * dismissed, "/TEXT: ..." when the pending slash was prepended instead */
  const asRecorded = t?.userTexts.find((u) => u.includes(text)) ?? "";
  const prepended = /^\s*\//.test(asRecorded);
  const asCommand = AS_COMMAND.test(after) || AS_COMMAND.test(asRecorded);
  c.expect("the overlay was dismissed before typing: the screen after the send shows no palette and the text was not swallowed or merged into the pending \"/\"",
    !stillOpen && !prepended && !asCommand && (!!t || after.includes(text)),
    `palette still open after the send: ${stillOpen ?? "no"}; prompt as the harness recorded it: ${asRecorded ? JSON.stringify(asRecorded.slice(0, 50)) : "(not in the transcript)"}`
    + `${prepended ? ' (the pending "/" was prepended to the message, not dismissed)' : ""}${asCommand ? "; the harness parsed the message as a slash command (/TEXT:)" : ""}`
    + `; text on screen: ${after.includes(text)}; in transcript: ${!!t}`);
  c.expect("the message lands, or the row says `undelivered` with a reason (never silent)", !!outcome,
    outcome ? (outcome.kind === "landed" ? `landed in ${outcome.t.id}` : `undelivered: ${JSON.stringify(outcome.u.reason ?? outcome.u.text ?? "")}`) : `neither in ${SPEC.landedMs + 12_000} ms; screen tail: ${(await c.snap("silent", pane.id)).slice(-400)}`);
  if (outcome?.kind === "undelivered") c.expect("the undelivered row names a reason", !!(outcome.u.reason || outcome.u.text), JSON.stringify(outcome.u));
  c.expect("the fake model never received the message unless it landed", !!t || s.served().length === 0, `served=${s.served().length} landed=${!!t}`);
}
