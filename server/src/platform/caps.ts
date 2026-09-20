/* Every ceiling this server holds against a broken or hostile client, in one
 * place, so a test can import a cap without importing the server.
 *
 * The philosophy (unchanged from where these lived in server.ts): the page and
 * a real engine bound themselves, so every number here sits far above working
 * traffic and only bites a client that is broken or hostile. Where the honest
 * answer is "kept what fits", input past a cap is truncated and SAYS so in the
 * stored file or the log, never silently refused with a 200.
 *
 * The env-tunable ones exist so a test can prove a bound without sending five
 * thousand requests (the CYC_LOG_* pattern from logbook.test.ts). They are read
 * at module load, which is what lets a test set them before spawning a server. */

/* -------------------------------------------------------------- /clientlog */
/** Lines of one POST that may reach disk; past it the batch is truncated. */
export const CLIENTLOG_MAX_LINES = 400;
/** Chars of one line kept; the page formats its own lines. */
export const CLIENTLOG_MAX_CHARS = 4000;
/** The whole POST: 400 lines x 4000 chars + slack. */
export const CLIENTLOG_MAX_BYTES = 2 * 1024 * 1024;
/** Lines per client per rolling minute. The page batches at 40 and rate-caps
 *  itself, so a real device sits far under this. */
export const CLIENTLOG_RATE_MAX = 3000;

/* ------------------------------------------------------------ bug reports */
export const REPORT_MAX_LINES = 500;
export const REPORT_MAX_CHARS = 4000;
export const REPORT_TEXT_MAX = 2000;
/** The whole POST, before anything is parsed. 500 lines of 4000 with slack. */
export const REPORT_MAX_BYTES = 4 * 1024 * 1024;
/** Reports kept on disk. Past this the OLDEST file goes. */
export const REPORT_KEEP = 200;

/* -------------------------------------- what an ENGINE may put here (#325) */
/* A MEMORY BACKSTOP, NOT A CONTENT LIMIT: matches /report's 4 MB because a
 * batch is many previews, and the cost of being too tight is a real
 * notification lost. */
export const PUSH_BODY_MAX_BYTES = 4 * 1024 * 1024;
/** An announce is four small strings. */
export const ANNOUNCE_BODY_MAX_BYTES = 4 * 1024;
/** An enrollment is an id, a P-256 spki, a timestamp and one signature. */
export const ENROLL_BODY_MAX_BYTES = 8 * 1024;
export const SESSION_ID_MAX = 200;
/** Items processed from one /push/batch. Env-tunable so a test can prove the
 *  bound cheaply; the default sits far above any working fleet. */
export const BATCH_ITEMS_MAX = Number(process.env.CYC_BATCH_ITEMS_MAX ?? 200);
/** Distinct chats the badge bookkeeping will hold (pending/outNew/outDismiss
 *  are keyed by an engine-supplied session id; this stops the leak cold). */
export const TRACKED_CHATS_MAX = Number(process.env.CYC_TRACKED_CHATS_MAX ?? 5000);

/* ------------------------------------------- flood protection (2026-08-08) */
/** Messages a single engine may push per rolling window. A constant on
 *  purpose: minimal by design, flood protection rather than armor. */
export const PUSH_RATE_MAX = 100;
/** The rolling minute the cap is measured over. */
export const PUSH_RATE_WINDOW_MS = 60_000;

/* ------------------------- the unauthenticated device flow (cloud onboard) */
/** Device-session CREATES per source per rolling window. A real pairing is
 *  ONE create (a stuck human retries a handful of times); a loop churning the
 *  500-session store meets this wall inside its first second. */
export const ENROLL_DEVICE_RATE_MAX = 10;
/** Polls per source per rolling window. A real engine polls every 2s, which
 *  is 30 a minute; double that so jitter never grazes the cap, while a
 *  hammer is held to one poll a second. */
export const ENROLL_POLL_RATE_MAX = 60;

/* -------------------------------------------------- the outgoing batch window */
/* BATCH_MS is the engines' window too, and BATCH_LAG_MS is the whole trick: an
 * engine firing exactly on :10 posts here at about :10.00x, and this server
 * fires at :12, so that post is inside this window rather than a hair outside
 * it. Without the lag the two would be a race, and losing the race costs the
 * full ten seconds. */
export const BATCH_MS = 10_000;
export const BATCH_LAG_MS = 2_000;
