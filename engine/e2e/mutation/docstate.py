"""The mutants for e2e/mutation/docstate-run.sh, one exact swap each.

Kept in python rather than in perl one-liners inside the shell script because
these anchors are TypeScript full of quotes, braces and template strings: an
escape one character out gives a mutation that silently does not apply, the
suite then runs against clean source, and the script reports the condition as
having no test behind it. That failure has already been shipped in this repo
twice. Every swap here is checked to occur EXACTLY once, so an anchor that has
moved is an error rather than a mutant that changed nothing.

Each one is a WRONG ANSWER SOMEBODY WOULD ACTUALLY WRITE for a store of "what a
shown page saved", not an invented breakage:

  NO_DOC_CHECK        a save is accepted for any docId at all. This is the
                      obvious implementation, and it makes the route a
                      key-value store that anything able to POST can fill with
                      whatever it likes, keyed by a UUID it made up.
  LOAD_NO_DOC_CHECK   the same on the read side: a docId this engine never
                      showed answers "nothing saved" instead of saying it does
                      not know the document.
  UNREADABLE_IS_EMPTY a state file that will not parse reads as an empty page.
                      The defect class this product keeps hitting -- the app
                      asserting what it does not know -- and the worst version
                      of it here, because the page then autosaves over the one
                      copy of his afternoon.
  NULL_IS_UNSAVED     saved data that happens to be falsy reads as never having
                      been saved. A truthiness check where an existence check
                      belongs.
  NO_CAP              the byte cap is not enforced, so one page can push
                      whatever it holds onto the engine on every keystroke.
  CAP_IN_CHARACTERS   the cap counts .length instead of bytes, so a state full
                      of emoji or CJK is measured at a quarter to a half of what
                      actually travels and lands on the disk.
  NO_JSON_CHECK       the body is stored without being parsed, so a client that
                      is not the shim can put a file on the engine that the read
                      side then has to refuse for ever.
  A_FILE_PER_SAVE     every save writes a new file instead of replacing the one
                      record. This is what turns a bounded store into an
                      unbounded one, and it is why there is no count cap: the
                      hundredth save has to cost what the first did.
  STATE_IN_DOC_DIR    the saved state is written in among the shown documents.
                      His whole distinction is "save data, not save cache", and
                      those documents are the disposable half; anything that
                      ever sweeps them would take his work with it.
"""
import sys

F = 'agent-engine/src/storage/docstate.ts'

M = {
    'NO_DOC_CHECK': [(F,
                      """  if (!(await exists(docPath(docDir, docId)))) {
    return { ok: false, status: 404, error: "no such document on this engine" };
  }
  /* Bytes, not characters,""",
                      """  // MUTANT: any docId at all may be saved to
  /* Bytes, not characters,""")],

    'LOAD_NO_DOC_CHECK': [(F,
                           """  if (!(await exists(docPath(docDir, docId)))) {
    return { ok: false, status: 404, error: "no such document on this engine" };
  }
  const p = statePath(stateDir, docId);""",
                           """  // MUTANT: a docId nobody ever showed answers "nothing saved"
  const p = statePath(stateDir, docId);""")],

    'UNREADABLE_IS_EMPTY': [(F,
                             """  if (!rec || typeof rec !== "object" || !("data" in rec)) {
    return { ok: false, status: 500,""",
                             """  if (false) {   // MUTANT: an unreadable state file reads as an empty page
    return { ok: false, status: 500,""")],

    'NULL_IS_UNSAVED': [(F,
                         """  if (!(await exists(p))) return { ok: true, saved: false, data: null };""",
                         """  if (!(await exists(p))) return { ok: true, saved: false, data: null };
  // MUTANT: falsy saved data reads as never having been saved
  { const peek = (await readJson(p)) as SavedDocState | null;
    if (peek && !peek.data) return { ok: true, saved: false, data: null }; }""")],

    'NO_CAP': [(F,
                """  if (bytes > DOC_STATE_MAX_BYTES) {
    return { ok: false, status: 413, error: stateTooLargeMessage(bytes) };
  }""",
                """  // MUTANT: no cap on what one page may push to the engine""")],

    'CAP_IN_CHARACTERS': [(F,
                           """  const bytes = new TextEncoder().encode(body).length;""",
                           """  const bytes = body.length;   // MUTANT: characters, not bytes""")],

    'NO_JSON_CHECK': [(F,
                       """  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, status: 400,
      error: "the saved state was not valid JSON, so nothing was saved" };
  }""",
                       """  let data: unknown = body;   // MUTANT: stored without ever being parsed""")],

    'A_FILE_PER_SAVE': [(F,
                         """export const statePath = (stateDir: string, docId: string): string =>
  `${stateDir}${docId}.json`;""",
                         """export const statePath = (stateDir: string, docId: string): string =>
  `${stateDir}${docId}-${Date.now()}.json`;   // MUTANT: a new file per save""")],

    'STATE_IN_DOC_DIR': [(F,
                          """export async function writeState(
  docDir: string, stateDir: string, docId: string, body: string,""",
                          """export async function writeState(
  docDir: string, stateDirIgnored: string, docId: string, body: string,
  // MUTANT: his data is written in among the disposable shown documents
  // eslint-disable-next-line
""")],
}

# STATE_IN_DOC_DIR needs a second edit: the body has to actually use docDir.
M['STATE_IN_DOC_DIR'].append((F,
                              """  await write(statePath(stateDir, docId), JSON.stringify(rec));""",
                              """  void stateDirIgnored;
  await write(statePath(docDir, docId), JSON.stringify(rec));"""))

name = sys.argv[1]
for path, frm, to in M[name]:
    s = open(path).read()
    n = s.count(frm)
    if n != 1:
        sys.exit(f'{name}: the anchor occurs {n} times in {path}, not once')
    open(path, 'w').write(s.replace(frm, to))
