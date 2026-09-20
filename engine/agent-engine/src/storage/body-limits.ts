/* THE ENGINE'S BODY CAPS: the numbers, beside the routes they bound.
 *
 * The capped-read MECHANISM is shared with the app server and lives in
 * ../shared/bodyread.ts; these are the engine's policy about its own routes,
 * and the readers are re-exported so engine call sites keep one import.
 *
 *   bun test agent-engine/src/storage/body-limits.test.ts
 */

import { DOC_STATE_MAX_BYTES } from "./docstate.ts";

export {
  bodyTooLarge,
  declaredBodyTooLarge,
  readBodyCapped,
  readTextCapped,
  readJsonCapped,
  type CappedBody,
} from "../../../shared/bodyread.ts";

/* Settings, rename, order, schedules, mode, and the other control JSON.
 * 80 KB rather than a round 64: /agent-message may carry SEND_MSG_MAX
 * (64k characters) plus the JSON envelope, and a 64 KB byte cap would
 * refuse a send this engine already documents as legal. */
export const JSON_BODY_MAX_BYTES = 80 * 1024;

/* Plugin state and shown-page doc state. writeState already refuses at
 * DOC_STATE_MAX_BYTES (256 KB); the helper uses the same number so a
 * multi-GB POST dies here instead of in the parser. */
export const STATE_BODY_MAX_BYTES = DOC_STATE_MAX_BYTES;

/* Binary POSTs: voice notes, attachments, session photos. A voice note
 * is the largest legit body (USER_AUDIO_MAX is 300 MB, his call
 * 2026-08-09). Attachments and photos keep their tighter route caps
 * (UPLOAD_MAX 50 MB, PHOTO_MAX 8 MB) at the call site so those paths
 * never buffer up to the voice-note ceiling. */
export const UPLOAD_BODY_MAX_BYTES = 300 * 1024 * 1024;
