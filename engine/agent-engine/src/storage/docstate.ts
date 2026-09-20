/* WHAT A SHOWN PAGE SAVED, AND WHERE IT LIVES.
 *
 * His ask, 2026-08-06, after a reload threw away an afternoon of reordering and
 * annotating a page `show` had pushed:
 *
 *   "the show HTML tool, it should note that whatever data it writes, it writes
 *    to whatever session. Heck, you gave it functions to submit and close. You
 *    should give it a function to save data, not save cache."
 *
 * So a shown page gets `cyc.save(x)` and `cyc.load()` next to `cyc.submit()` and
 * `cyc.close()`, and this file is the engine end of them.
 *
 * ========================= WHY IT IS ON THE ENGINE ==========================
 *
 * THE DEVICE IS THE WRONG PLACE, and that is the whole point rather than a
 * detail. His pages are opened on a phone, a tablet and a laptop, one after
 * another, on whichever is in his hand; an ordering he made on the tablet has to
 * be there when he opens the same card on the phone. Anything kept in the
 * browser -- localStorage, IndexedDB, the show cache next door -- is per device
 * by construction, so three devices would hold three different documents that
 * each believed they were his. (The sandbox forbids the page its own storage
 * anyway, deliberately: app/src/features/media/htmlViewer.ts, mechanism 1.)
 *
 * THE APP SERVER IS THE WRONG PLACE TOO, and this is the choice worth writing
 * down. A shown document does not live there: `show` writes it into .run/docs on
 * THE AGENT ENGINE OF THE SESSION THAT SHOWED IT, the chat message carries only
 * its docId, and the app fetches GET /doc/<docId> from that engine, over the
 * tailnet, wherever it is. There can be several engines and a card knows which
 * one is its own. Putting the page's saved data on the app server would split
 * one thing across two hosts with two lifetimes: an engine could be rebuilt,
 * moved or retired with its documents and leave his annotations orphaned on
 * another machine, keyed to a docId nothing could resolve any more. The standing
 * architecture rule says the same thing more briefly -- everything on the laptop
 * is in the agent engine.
 *
 * So the data is a file beside the document it belongs to, on the one host that
 * already owns that document, reached by the same URL with `/state` on the end.
 *
 * ======================== IT IS DATA, NOT A CACHE ===========================
 *
 * That sentence decides the eviction question. The show cache
 * (app/src/engine/showVault.ts) has three caps and throws cards away under all
 * of them; nothing here is on that queue, or on any queue. A saved state is not
 * a copy of something that can be fetched again -- there is nowhere to fetch it
 * from, it is the only copy of what he did -- so a cap that evicted it would be
 * deleting his work to save 8KB. It outliving the rendered card is the point.
 *
 * What bounds it instead is ONE RECORD PER DOCUMENT, overwritten in place, with
 * a byte cap on that record. A page cannot accumulate: the hundredth save costs
 * exactly what the first did. That is why there is no count cap here and no
 * runaway guard, unlike the submissions next door -- those STAGE, one chip each,
 * and a hundred of them is a hundred files to upload.
 *
 * SAID PLAINLY, SO NOBODY HAS TO DISCOVER IT: the DIRECTORY has no sweep. One
 * file per shown page he has saved to, for as long as the engine lives. Against
 * his real rate that is small -- 91 documents in the 17 days to 2026-08-06, most
 * of which nobody would ever save to, at a few KB each -- and the alternative is
 * a rule that deletes his work on a schedule, which is the one thing this file
 * exists not to do. If it ever needs bounding, the bound has to be something he
 * chose, not a cap that quietly reclaims a megabyte.
 *
 * =========================== KEYED BY THE DOCUMENT ==========================
 *
 * The key is the docId and nothing else. It is already what names one immutable
 * document everywhere in this system -- the chat bubble carries it, the app
 * caches by it, `?doc=` in the address bar restores by it -- so a page does not
 * have to invent a name, cannot collide with another page, and cannot read
 * another page's data by guessing one. A save for a docId this engine has never
 * heard of is REFUSED rather than written, which is what keeps this from being a
 * general key-value store that anything able to POST could fill up.
 *
 * A re-`show` of the same file mints a new docId and is therefore a new page
 * with nothing saved. That is correct and not a limitation: it is a new card in
 * his chat, and the old one still has his work on it.
 *
 *   bun test agent-engine/src/storage/docstate.test.ts
 */

/* THE CAP ON ONE PAGE'S SAVED STATE.
 *
 * Bigger than a submission's 64KB (htmlViewer.ts SUBMIT_MAX_BODY) because the
 * two are different things. A submission is an ANSWER -- a choice, a filled
 * checklist, a form -- and 64KB is already generous for one. This is a page's
 * whole working state: the order he dragged forty rows into, a note on each of
 * them, which sections he collapsed. That is a document's worth of his typing
 * and it should not hit a wall.
 *
 * Smaller than the 1MB page cap, because the page itself travels once and this
 * travels on every save, from a phone, sometimes on cell data. 256KB is about
 * eight thousand short annotations, which is more than anyone will type into one
 * card, and it is a quarter of a megabyte on the engine's disk per shown page in
 * the worst case.
 *
 * Over it is a REFUSAL WITH THE NUMBER IN IT, never a truncation: half a saved
 * state reloads as a page whose data is subtly wrong, which is worse than a page
 * that says out loud it could not save. */
export const DOC_STATE_MAX_BYTES = 256 * 1024;

/** What is written to disk. `data` is whatever the page saved, already parsed,
 *  so the file on disk is a real JSON document somebody can read with jq. */
export type SavedDocState = {
  docId: string;
  /** epoch ms of the last successful save. Answered on load so a page can say
   *  "your notes, saved at 14:12" rather than silently restoring something. */
  savedAt: number;
  data: unknown;
};

export type StateWrite =
  | { ok: true; savedAt: number; bytes: number }
  | { ok: false; status: number; error: string };

export type StateRead =
  | { ok: true; saved: false; data: null }
  | { ok: true; saved: true; savedAt: number; data: unknown }
  | { ok: false; status: number; error: string };

/* The refusal a too-large save gets, in the same voice show.ts's does: it names
 * the size, the cap, and that nothing was written. The agent reading it is the
 * one who can shrink what the page saves, and "too large" on its own gets the
 * same blob posted again a second later. */
export function stateTooLargeMessage(size: number): string {
  const kb = (n: number) => `${Math.round(n / 1024)}KB`;
  return `saved state too large (${kb(size)}, cap ${kb(DOC_STATE_MAX_BYTES)}). This is one ` +
    `record per shown page, overwritten in place, and it travels from his phone on every ` +
    `save. Save the state, not the source data it was derived from. NOTHING WAS SAVED: ` +
    `this is a refusal, not a truncation, so whatever was saved before is still there.`;
}

/* Where a document's saved state lives, given the directory it lives in. A
 * separate directory from .run/docs and not a second extension inside it: the
 * documents there are the immutable bytes an agent pushed and they are
 * disposable, this is the only copy of something he typed, and anything that
 * ever sweeps shown documents must be unable to take this with it by accident. */
export const statePath = (stateDir: string, docId: string): string =>
  `${stateDir}${docId}.json`;

/** ...and where the DOCUMENT is, which is what a state is only allowed to exist
 *  beside. */
export const docPath = (docDir: string, docId: string): string =>
  `${docDir}${docId}.json`;

/* Read what a page saved. Three answers, and they are three because collapsing
 * any two of them would have the page assert something it does not know:
 *
 *   {ok, saved: false}   this document exists and has never been saved to. Start
 *                        the page empty.
 *   {ok, saved: true}    here is what he had.
 *   {ok: false}          the question could not be answered. NOT the same as
 *                        "nothing saved" -- a page that treats it as one, and
 *                        then autosaves, overwrites his work with a blank slate.
 *
 * `exists` and `readJson` are passed in rather than reached for so this is
 * testable against a temp directory with no server anywhere near it, which is
 * the same reason show.ts is a separate file. */
export async function readState(
  docDir: string, stateDir: string, docId: string,
  exists: (p: string) => Promise<boolean>,
  readJson: (p: string) => Promise<unknown>,
): Promise<StateRead> {
  if (!(await exists(docPath(docDir, docId)))) {
    return { ok: false, status: 404, error: "no such document on this engine" };
  }
  const p = statePath(stateDir, docId);
  if (!(await exists(p))) return { ok: true, saved: false, data: null };
  const rec = (await readJson(p)) as SavedDocState | null;
  /* A state file that will not parse is a FAILURE, not an empty page. It is the
   * one shape in which his data is on the disk and unreadable, and the honest
   * answer is to say so and let the page decline to overwrite it. */
  if (!rec || typeof rec !== "object" || !("data" in rec)) {
    return { ok: false, status: 500,
      error: "this page has saved state on the engine but the file could not be read, so " +
        "nothing was loaded. Do not save over it: " + p };
  }
  return { ok: true, saved: true, savedAt: Number(rec.savedAt) || 0, data: rec.data };
}

/* Write what a page saved, replacing whatever was there.
 *
 * THE BODY MUST BE JSON, and it is checked here rather than trusted. The shim on
 * the app side always sends JSON.stringify of what the page handed it, so a body
 * that does not parse is a bug or something that is not the shim, and either way
 * storing it would put a file on disk that the read above then has to refuse.
 * Checking on the way in means the file is always a document somebody can open. */
export async function writeState(
  docDir: string, stateDir: string, docId: string, body: string,
  exists: (p: string) => Promise<boolean>,
  write: (p: string, text: string) => Promise<void>,
  now = Date.now(),
): Promise<StateWrite> {
  if (!(await exists(docPath(docDir, docId)))) {
    return { ok: false, status: 404, error: "no such document on this engine" };
  }
  /* Bytes, not characters, because that is what crosses the wire and what sits
   * on the disk; an emoji is four of them and a page that measured its own
   * payload in .length would otherwise be refused at a number it cannot see. */
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > DOC_STATE_MAX_BYTES) {
    return { ok: false, status: 413, error: stateTooLargeMessage(bytes) };
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, status: 400,
      error: "the saved state was not valid JSON, so nothing was saved" };
  }
  const rec: SavedDocState = { docId, savedAt: now, data };
  await write(statePath(stateDir, docId), JSON.stringify(rec));
  return { ok: true, savedAt: now, bytes };
}
