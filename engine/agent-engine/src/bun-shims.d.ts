/* TYPES FOR RUNTIME BEHAVIOUR THE PINNED bun-types PREDATES.
 *
 * The engine runs on bun 1.4.0; package.json pins bun-types 1.2.0, and nothing
 * here may run an install to close that gap. Where the two disagree, the RUNTIME
 * is the fact and the .d.ts is the stale one. This file states those facts, and
 * only those: each entry is something bun does today that its 1.2.0 types do not
 * describe. It is not a place to silence a real type error.
 *
 * Delete an entry the moment bun-types is bumped past it; if this file ever
 * empties, delete the file and its entry in tsconfig.check.json's `files`.
 *
 *   bun run typecheck
 */

declare global {
  /* `for await (const chunk of stream)` over a ReadableStream. Bun has
   * implemented async iteration on ReadableStream since well before 1.4, and
   * three call sites read subprocess stdout that way (terminal.ts:392 and :415
   * for the bridge, voicemodels.ts:211). bun-types 1.2.0 simply never declared
   * the method, so each `for await` was "must have a [Symbol.asyncIterator]()".
   * WHATWG added it to the standard; lib.dom has not shipped it either. */
  interface ReadableStream<R = any> {
    [Symbol.asyncIterator](): AsyncIterableIterator<R>;
  }
}

export {};
