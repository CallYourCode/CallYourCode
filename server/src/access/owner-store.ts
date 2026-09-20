/* ONE OWNER'S WORLD, in one object.
 *
 * Everything device-shaped that used to be a module global -- the push store,
 * the app settings, the badge bookkeeping (`pending`) and the merged outgoing
 * window (`outNew`/`outDismiss`) -- is per owner.
 * In LOCAL mode there is exactly one of these, backed by the same files at the
 * same paths as before, so nothing on disk or in behaviour moves. In HOSTED
 * mode there is one per Clerk `sub`, under `<OWNERS_DIR>/<sub>/`, and no route
 * can reach across from one to another because a route only ever holds the
 * store the request's own token resolved to.
 *
 * The outgoing window's timer lives on the store too, so two owners batch on
 * their own clocks and one owner's flush never carries another's chats. */

import { Push, carrySealed } from "../delivery/push";
import { writePrivate } from "../../../engine/shared/runfiles.ts";
import { BATCH_MS, BATCH_LAG_MS, TRACKED_CHATS_MAX } from "../platform/caps";
import type { LogFn } from "../platform/httpx";

export { carrySealed };

/* The GLOBAL defaults: how the app behaves unless a session says otherwise.
 *
 * These are facts about the person using the app, not about a machine or a
 * browser, so they live here (like the default voice used to) and every device
 * reads the same answer. The per-session overrides live on the engine that owns
 * the session; a session with no override follows these, so changing one here
 * moves every chat that has not chosen for itself and none that have.
 *
 *   speed       TTS playback rate. THE ONLY LEVEL: no session overrides it, and
 *               the chat top bar's Speed chip sets this value (2026-08-04, "the
 *               playback speed should just be global").
 *   notify      push for a reply nobody is watching (the bell overrides it)
 *   sound       replies play out loud (the mute button overrides it)
 *   activity    session activity marks and pills. THE ONLY LEVEL now (task 350,
 *               2026-08-08): the top bar's activity button sets THIS global, and
 *               the per-session override the engine used to keep is deleted.
 *   replyLevel  how MUCH of an answer you get: text through to voice
 *   complexity  how HARD the answer is allowed to be to follow
 *   verbosityOn whether the verbosity dial is OFFERED (not what it is set to)
 *   complexityOn  the same, for complexity
 *   geom        the geometry readout: the box of layout numbers over the chat.
 *               A diagnostic, and a global like the rest on purpose -- it was
 *               `?geom=1` in the app, which an installed app has no address bar
 *               for (app task #265). Off by default.
 *   keymap      the keyboard shortcuts (2026-08-04, "they should be synced at
 *               the app level like other app settings")
 *
 * THE KEYMAP IS A PARTIAL MAP and only ever holds the actions whose chord
 * DIFFERS from the one the app ships, which is the property that lets a shipped
 * default change later and move everyone who never touched it. This file cannot
 * check that -- the action names and their defaults live in the app's
 * src/cyc/lib/keymap.ts -- so it stores what it is given and validates the
 * SHAPE: an object whose values are all strings. '' is a real value there and
 * means deliberately unbound.
 *
 * It is also the only setting POSTed as a WHOLE OBJECT rather than a field,
 * because unbinding an action is expressed by the key being gone, and a
 * key-by-key merge could not say that.
 *
 * `keymap` is OPTIONAL for the same reason the two dials are: absent means this
 * account has never had one, which is the one moment a device may hand over the
 * per-device map it kept before the move. `{}` is a real and different answer
 * (he cleared his last binding), and if the two were the same the old laptop
 * store would come back on the next boot and undo it.
 *
 * THE LAST TWO HAVE NO PER-SESSION OVERRIDE, and that is the point of them
 * being here. His call, 2026-08-01, typed: "this verbosity and complexity
 * sliders. they should not be per session. but rather just global at user
 * level. ... this is because i don't need to tune it per session ever. it
 * mostly depends on what mood I'm in and energy level and device."
 *
 * They are also the only two globals an ENGINE reads, because the engine is
 * what writes the instruction onto the message. The app pushes them to every
 * engine it is connected to; this file stays the home, so a fresh engine and a
 * second device both end up at the same answer.
 *
 * THE TWO DIALS ARE OPTIONAL HERE, AND "ABSENT" IS A DIFFERENT ANSWER FROM 3.
 * Absent means nobody has ever stated a reply level on this account, which is
 * the one moment the app is allowed to adopt what an engine migrated out of the
 * old per-session file. Defaulting them to 3 in this type made that moment
 * indistinguishable from "he set it to 3", so his migrated 5 was overwritten by
 * a 3 the first time a page connected. The page still SHOWS 3 when they are
 * absent; it just does not write it.
 *
 * `seq` bumps on every change so a page can cheaply ask "anything new" and
 * two devices converge without anybody reloading.
 *
 * THE TWO ON/OFF SWITCHES ARE ABOUT THE CONTROL, NOT ABOUT THE VALUE (his
 * words, 2026-08-05: "reply verbosity ... should be changeable in settings and
 * toggle on/off"). OFF means the dial stops being OFFERED -- it leaves the
 * composer panel, the strip and the placeholder -- and KEEPS ITS VALUE, which
 * is still what the engines are told to answer at. So they are booleans beside
 * the two levels rather than a way of clearing them.
 *
 * VERBOSITY DEFAULTS ON, COMPLEXITY DEFAULTS OFF (#462, his call): the answer
 * length is the dial worth offering out of the box, and complexity is one he
 * turns on when he wants it. A fresh app server (no settings file yet)
 * therefore answers complexityOn:false, so a brand-new device hides the
 * complexity control until an explicit ON is stored here; the app default
 * matches (settings.ts). An explicit ON round-trips like any other boolean and
 * is honoured across a restart. */
export type AppSettings = {
  speed: number; notify: boolean; sound: boolean; activity: boolean;
  replyLevel?: number; complexity?: number;
  verbosityOn: boolean; complexityOn: boolean;
  /* WHETHER THE COMPOSER OFFERS THE PROMPT-BITS MENU (#465). A synced global like
   * the two dial switches; a prompt bit is plain text the app inserts and never
   * reaches an engine, so this gates only the composer menu. On by default (the
   * menu has always been offered). */
  promptBitsOn: boolean;
  geom: boolean;
  keymap?: Record<string, string>;
  /* THE EDITED WORDING (#362/#463/#464): the strings he changed for the verbosity
   * rungs (name + appended text) and the complexity rungs (name + text now too,
   * #464). A GLOBAL like the dials, replaced WHOLE like the keymap. Stored as an
   * opaque bag with a light shape/size guard: the app is the owner and
   * re-sanitises it on read (config/replyStrings.ts parseReplyStrings), so this
   * file's job is durable, order-preserving storage, not a second validator.
   * Absent = no edits (the defaults in the app's code stand). */
  strings?: Record<string, unknown>;
  /* The merged list's own drag order (#444): full session ids, replaced whole
   * like the keymap. His first live drag toasted "Could not save the new
   * order" because this key was missing here and the whitelist silently
   * dropped it while the lane's rig mock accepted it. */
  mergedOrder?: string[];
  /* The dormant chats the user has hidden (task 501): namespaced session ids,
   * replaced whole like mergedOrder. Absent means nothing was ever dismissed;
   * `[]` is a real answer (everything restored). A dismissal only hides a row
   * while its engine is dormant, so the app un-hides automatically on wake. */
  dismissed?: string[];
};

/* The two dials are absent rather than 3: see the type above. The page falls
 * back to the middle rung of each scale on its own, which is the same number
 * the engine defaults to, so nothing looks different until somebody sets one. */
export const SETTINGS_DEFAULTS: AppSettings = {
  speed: 1, notify: true, sound: true, activity: true,
  // #462: complexity is the dial he turns on when he wants it, not one offered
  // out of the box; verbosity stays on. An explicit ON is stored and honoured.
  verbosityOn: true, complexityOn: false,
  // #465: the prompt-bits menu has always been offered
  promptBitsOn: true,
  // a diagnostic box over the chat: nobody has it on until they ask for it
  geom: false
};

/* The wording bag, or null if that is not one (#362). A plain, bounded object;
 * stored WHOLE and echoed as received so the page's holds() check (which compares
 * the POST body against the GET answer, byte for byte) passes. The app is the
 * owner and re-sanitises every field on read, so the guard here is deliberately
 * light: refuse only what is not a plain object or is absurdly large, and store
 * the rest verbatim rather than rebuilding it (a rebuild would reorder keys and
 * break holds()). */
export function cleanStrings(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (JSON.stringify(v).length > 40_000) return null;
  return v as Record<string, unknown>;
}

/* A merged-list order, or null if that is not one. All-strings, bounded, and
 * refused whole rather than half-taken, the same contract as chordMap: a
 * half-taken order is a row that silently is not where the user put it. An
 * empty array is a real answer (the order was reset). */
export function sidList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 500) return null;
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string" || s.length === 0 || s.length > 300) return null;
    out.push(s);
  }
  return out;
}

/* A keymap, or null if that is not one. Null and `{}` are different answers
 * everywhere this is used, so it never turns one into the other. Values must
 * all be strings; anything else and the whole map is refused rather than
 * half-taken, because a half-taken keymap is a shortcut that silently is not
 * where the user put it. */
export function chordMap(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") return null;
    out[k] = val;
  }
  return out;
}

// kid/enc (task 527): the sealed payload this server relays but cannot read.
export type OutItem = { sessionId: string; title: string; body: string; count: number;
  icon?: string; kid?: string; enc?: string };

export function msToBoundary(period: number, offset = 0, now = Date.now()): number {
  return Math.floor((now - offset) / period) * period + period + offset - now;
}

export class OwnerStore {
  settingsSeq = 0;
  readonly pending = new Map<string, number>();
  readonly outNew = new Map<string, OutItem>();
  readonly outDismiss = new Set<string>();
  private outTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    readonly push: Push,
    readonly settingsFile: string,
    readonly reportsDir: string,
    readonly settings: AppSettings,
    private readonly log: LogFn,
  ) {}

  static async open(pushFile: string, settingsFile: string, reportsDir: string,
                    log: LogFn): Promise<OwnerStore> {
    const push = await Push.open(pushFile, (event, fields) => log(event, fields));
    const settings: AppSettings = { ...SETTINGS_DEFAULTS };
    try {
      const j = await Bun.file(settingsFile).json();
      if (typeof j?.speed === "number" && j.speed >= 0.5 && j.speed <= 4) settings.speed = j.speed;
      if (typeof j?.notify === "boolean") settings.notify = j.notify;
      if (typeof j?.sound === "boolean") settings.sound = j.sound;
      if (typeof j?.activity === "boolean") settings.activity = j.activity;
      for (const k of ["verbosityOn", "complexityOn", "promptBitsOn", "geom"] as const) {
        if (typeof j?.[k] === "boolean") settings[k] = j[k];
      }
      for (const k of ["replyLevel", "complexity"] as const) {
        if (Number.isInteger(j?.[k]) && j[k] >= 1 && j[k] <= 5) settings[k] = j[k];
      }
      const km = chordMap(j?.keymap);
      if (km) settings.keymap = km;
      const st = cleanStrings(j?.strings);
      if (st) settings.strings = st;
      const mo = sidList(j?.mergedOrder);
      if (mo) settings.mergedOrder = mo;
      const dm = sidList(j?.dismissed);
      if (dm) settings.dismissed = dm;
    } catch { /* first run: the defaults stand */ }
    return new OwnerStore(push, settingsFile, reportsDir, settings, log);
  }

  async saveSettings() {
    await writePrivate(this.settingsFile, JSON.stringify(this.settings));
  }

  /* THE HOME SCREEN BADGE: the sum of the counts across every session on every
   * host, i.e. the number you get by adding up the rows. Recomputed on every
   * push, so there is nothing to get stuck. It used to be `pending.size` -- how
   * many chats had ever pushed -- which is the badge-stuck-on-3 report. */
  badge(): number {
    let n = 0;
    for (const v of this.pending.values()) n += v;
    return n;
  }

  /* May a new chat be tracked, or is the badge bookkeeping already full? A
   * working account never reaches the cap; a modified engine naming endless
   * fresh chats does, and the honest answer then is to keep what we have rather
   * than grow for ever. Updating a chat already tracked is always allowed --
   * the cap is on how MANY distinct chats are held, not on traffic to them.
   * Says so in the log the moment it bites, so a badge that stops climbing has
   * a reason on disk. */
  room(map: { size: number; has: (k: string) => boolean }, key: string, which: string): boolean {
    if (map.has(key) || map.size < TRACKED_CHATS_MAX) return true;
    this.log("push.tracking.full", { map: which, cap: TRACKED_CHATS_MAX,
      dropped: key.slice(0, 60),
      why: "more distinct chats than an account has; a new one is not tracked" });
    return false;
  }

  scheduleOut() {
    if (this.outTimer) return;
    this.outTimer = setTimeout(() => {
      this.outTimer = null;
      void this.flushOut();
    }, msToBoundary(BATCH_MS, BATCH_LAG_MS));
  }

  /** One push, every engine, every session, to every subscribed device. */
  async flushOut() {
    if (!this.outNew.size && !this.outDismiss.size) return;
    const sessions = [...this.outNew.values()];
    const dismissed = [...this.outDismiss];
    this.outNew.clear();
    this.outDismiss.clear();
    await this.push.send({
      t: "batch",
      // A worker too old to know about `t: batch` still has a banner to show and
      // a chat to open when it is tapped, rather than an unreadable payload.
      title: sessions[0]?.title ?? "CallYourCode",
      body: sessions[0]?.body ?? "Messages read on another device",
      sessionId: sessions[0]?.sessionId ?? dismissed[0] ?? "",
      tag: sessions[0]?.sessionId ?? dismissed[0] ?? "cyc",
      count: sessions[0]?.count,
      sessions,
      dismissed,
      badge: this.badge(),
    });
    this.log("push.out", { sessions: sessions.length, dismissed: dismissed.length,
      devices: this.push.count, badge: this.badge() });
  }
}
