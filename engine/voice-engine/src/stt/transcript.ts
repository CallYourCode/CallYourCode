/* Flattening a batch transcript into one line.
 *
 * whisper-server's `/v1/audio/transcriptions` json body has exactly one key,
 * `text`, and its value is whisper's SEGMENTS already joined with "\n" on the
 * server side. Measured on the user's own 17 s capture
 * (.run/audio/2052d3e4-ff31-4b1d-b81b-285d93a2236d.webm), the raw body is:
 *
 *   {"text":" messages, which are the session messages, should just take\n
 *    the full width on all the devices.\n I mean, the full width of the
 *    messaging bubble with\n appropriate margins, but the width should not
 *    be\n constrained.\n"}
 *
 * Those breaks are decoder window boundaries. They fall at roughly regular
 * intervals, so they read like someone chose a column width, and they land
 * mid-sentence ("should just take\n the full width"). They carry no meaning.
 *
 * Two things were wrong with passing them through. The bubble in the app was
 * hard-wrapped at a width the app never picked, and -- the one that matters
 * more -- the transcript IS the wire text, so every voice message reached the
 * session pre-broken into lines: noise in its context, and a shape that can
 * change how a sentence or a list reads.
 *
 * The streaming path never had this: it joins its own segments with " " and
 * collapses whitespace (server.ts, `textOf`). This is that same normalisation,
 * for the batch path, in one place both can point at.
 *
 * Seams matter here. Each whisper segment carries a LEADING space, so the
 * boundary is " take" + "\n" + " the", i.e. newline-between-spaces; a naive
 * "\n" -> " " leaves a double space. The head has the same leading space and
 * the tail a trailing "\n". Collapsing every whitespace run and trimming
 * handles all three, and it is exactly what the streaming path already does.
 */

/** whisper's segment-joined `text` -> one line, no double spaces, trimmed. */
export function flattenTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
