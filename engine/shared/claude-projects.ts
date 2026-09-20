/* Claude Code's transcript project-dir munge: the ONE way a cwd is turned
 * into the folder name under ~/.claude/projects/<munged>/<uuid>.jsonl.
 *
 * Claude Code (verified against the installed CLI, v2.1.271) replaces EVERY
 * character that is not [A-Za-z0-9] with "-": not just "/" and "." but also
 * "_", spaces and every other punctuation. The engine used to spell this as
 * `cwd.replace(/[/.]/g, "-")` in five places, which kept "_" and so resolved
 * a cwd like /home/user/acme_outreach to the wrong folder (the
 * real folder is ...-acme-outreach), which showed up as "Ctx n/a" and a
 * missing model chip. This is the single source; every reader (live path,
 * ambiguity key, e2e harness, test builders) mirrors Claude Code by importing
 * it, so none can drift again.
 *
 * NOTE: Claude Code also caps the munged name at 200 chars and appends a hash
 * for longer paths. The engine never mirrored that truncation and this dedup
 * does not add it (out of scope); paths under the cap -- effectively all real
 * cwds here -- are byte-for-byte identical. */
export function mungeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
