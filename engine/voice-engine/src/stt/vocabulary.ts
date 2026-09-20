/* Custom vocabulary correction.
 *
 * Whisper mangles domain terms in accented speech ("herdr" -> "header",
 * "callyourcode" -> "call your clod"). This post-corrects transcripts
 * against a user vocabulary, Handy's pattern: exact hint aliases + fuzzy
 * matching (Levenshtein ratio + Soundex phonetic gate) + n-gram merge for
 * multi-word mangles, with guards so a correction can never be reckless:
 *
 *   - fuzzy only against the TERM, hints are exact aliases (fuzzy-on-hints
 *     would eat real words: "heater" is 1 edit from the hint "header")
 *   - never correct when edit-distance ratio > 0.4
 *   - every fuzzy match must ALSO agree on Soundex with the term; words
 *     under 4 chars are therefore only corrected on exact phonetic match
 *   - never correct a suffix derivative of a hint/term ("cloudy" = cloud+y)
 *   - n-gram merges only fire when the entry declares multi-word hints,
 *     and only within a tight 0.1 ratio of a listed multi-word hint
 *   - `code spans` are never touched; case and punctuation are preserved
 *
 * Pure and synchronous: correct(text, vocab) -> {text, corrections}.
 */

export type VocabEntry = { term: string; hints?: string[] };
export type Correction = { from: string; to: string };

const MAX_RATIO = 0.4; // absolute fuzzy ceiling (edit distance / longer length)
const MAX_DIST = 2; // fuzzy ceiling in edits: 3 edits reached real words
// ("worked" -> worktree, live clip 2026-07-23). Farther-out mangles still
// correct when they land within 1 edit of a LISTED hint (hint-adjacency
// below), so "paracete" follows the "paracate" alias without a 3-edit gate
const MULTI_RATIO = 0.1; // n-gram fuzz: long strings, so keep this tight
const SUFFIXES = ["s", "es", "y", "ed", "ing", "ly", "er", "ers"];

// ---------------------------------------------------------------- distance

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function ratio(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  return len === 0 ? 0 : levenshtein(a, b) / len;
}

// ---------------------------------------------------------------- phonetic

const SOUNDEX_CODE: Record<string, string> = {
  B: "1", F: "1", P: "1", V: "1",
  C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2",
  D: "3", T: "3",
  L: "4",
  M: "5", N: "5",
  R: "6",
};

export function soundex(s: string): string {
  const letters = s.toUpperCase().replace(/[^A-Z]/g, "");
  if (!letters) return "";
  let out = letters[0];
  let prev = SOUNDEX_CODE[letters[0]] ?? "";
  for (let i = 1; i < letters.length && out.length < 4; i++) {
    const c = letters[i];
    if (c === "H" || c === "W") continue; // transparent, do not reset prev
    const code = SOUNDEX_CODE[c] ?? "";
    if (code) {
      if (code !== prev) out += code;
      prev = code;
    } else {
      prev = ""; // vowel: same code may repeat after it
    }
  }
  return out.padEnd(4, "0");
}

// ---------------------------------------------------------------- prepare

type PreparedEntry = {
  term: string;
  termLower: string;
  termSoundex: string;
  exact: Set<string>; // single-word aliases incl. the term itself, lowercased
  multi: Map<number, string[]>; // word count -> multi-word hints, lowercased
  bases: string[]; // suffix-guard bases: term + single-word hints
};

type Prepared = { entries: PreparedEntry[]; maxN: number };

const prepared = new WeakMap<VocabEntry[], Prepared>();

function prepare(vocab: VocabEntry[]): Prepared {
  const hit = prepared.get(vocab);
  if (hit) return hit;
  const entries: PreparedEntry[] = [];
  let maxN = 1;
  for (const v of vocab) {
    const term = String(v?.term ?? "").trim();
    if (!term) continue;
    const termLower = term.toLowerCase();
    const e: PreparedEntry = {
      term,
      termLower,
      termSoundex: soundex(termLower),
      exact: new Set([termLower]),
      multi: new Map(),
      bases: [termLower],
    };
    for (const raw of v.hints ?? []) {
      const h = String(raw).trim().toLowerCase().replace(/\s+/g, " ");
      if (!h) continue;
      const words = h.split(" ");
      if (words.length > 1) {
        const list = e.multi.get(words.length) ?? [];
        list.push(h);
        e.multi.set(words.length, list);
        if (words.length > maxN) maxN = words.length;
      } else {
        e.exact.add(h);
        e.bases.push(h);
      }
    }
    entries.push(e);
  }
  const out = { entries, maxN };
  prepared.set(vocab, out);
  return out;
}

// ---------------------------------------------------------------- matching

/** "cloudy" is cloud+y: a suffix derivative of a real word the user aliased.
 * Correcting derived forms is how a corrector makes transcripts worse. */
function suffixDerived(norm: string, e: PreparedEntry): boolean {
  for (const base of e.bases) {
    if (norm.length > base.length && norm.startsWith(base) && SUFFIXES.includes(norm.slice(base.length))) {
      return true;
    }
  }
  return false;
}

/** Terms with intrinsic casing (CallYourCode, MCP) render verbatim;
 * lowercase terms pick up sentence-initial capitalization from the source. */
function renderCase(term: string, orig: string): string {
  if (/[A-Z]/.test(term)) return term;
  if (/^[A-Z][a-z]+$/.test(orig)) return term[0].toUpperCase() + term.slice(1);
  return term;
}

type Word = {
  ti: number; // index into the token array
  lead: string;
  core: string;
  poss: string; // trailing 's kept aside so "clod's" -> "claude's"
  trail: string;
  done: boolean;
};

function fixSegment(seg: string, prep: Prepared, corrections: Correction[]): string {
  const toks = seg.split(/(\s+)/);
  const words: Word[] = [];
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti];
    if (!t || /^\s+$/.test(t)) continue;
    const lead = (t.match(/^[^A-Za-z0-9]+/) ?? [""])[0];
    const rest = t.slice(lead.length);
    const trail = (rest.match(/[^A-Za-z0-9]+$/) ?? [""])[0];
    let core = rest.slice(0, rest.length - trail.length);
    let poss = "";
    if (/['’][sS]$/.test(core)) {
      poss = core.slice(-2);
      core = core.slice(0, -2);
    }
    words.push({ ti, lead, core, poss, trail, done: core.length === 0 });
  }

  // n-gram pass first, longest windows first, so "call your clod" becomes
  // CallYourCode before the single-word pass can turn clod into claude.
  for (let n = prep.maxN; n >= 2; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const win = words.slice(i, i + n);
      if (win.some((w) => w.done)) continue;
      // punctuation between the words means they are not one phrase
      if (win.slice(0, -1).some((w) => w.trail || w.poss)) continue;
      if (win.slice(1).some((w) => w.lead)) continue;
      const cores = win.map((w) => w.core);
      const joined = cores.join(" ").toLowerCase();
      const squashed = cores.join("").toLowerCase();
      let best: { e: PreparedEntry; r: number } | null = null;
      for (const e of prep.entries) {
        const hints = e.multi.get(n);
        if (!hints) continue; // merges only when the vocab term says so
        let r = Infinity;
        for (const h of hints) {
          if (h === joined) {
            r = 0;
            break;
          }
          const rr = ratio(joined, h);
          if (rr <= MULTI_RATIO && rr < r) r = rr;
        }
        if (r > 0) {
          const rs = ratio(squashed, e.termLower); // "call yourclaude" family
          if (rs <= MULTI_RATIO && rs < r) r = rs;
        }
        if (r !== Infinity && (!best || r < best.r)) best = { e, r };
      }
      if (!best) continue;
      const first = win[0];
      const last = win[n - 1];
      const rendered = renderCase(best.e.term, first.core);
      const from = cores.join(" ");
      toks[first.ti] = first.lead + rendered + last.poss + last.trail;
      for (let k = 1; k < n; k++) toks[win[k].ti] = "";
      for (let ti = first.ti + 1; ti < last.ti; ti++) {
        if (/^\s+$/.test(toks[ti] ?? "")) toks[ti] = "";
      }
      for (const w of win) w.done = true;
      if (rendered !== from) corrections.push({ from, to: rendered });
    }
  }

  // single-word pass
  for (const w of words) {
    if (w.done) continue;
    const norm = w.core.toLowerCase();
    let best: { e: PreparedEntry; r: number } | null = null;
    for (const e of prep.entries) {
      let r: number | null = null;
      if (e.exact.has(norm)) {
        r = 0;
      } else if (!suffixDerived(norm, e) && soundex(norm) === e.termSoundex) {
        const d = levenshtein(norm, e.termLower);
        const rr = d / Math.max(norm.length, e.termLower.length);
        if (rr <= MAX_RATIO) {
          if (d <= MAX_DIST) r = rr;
          else {
            // hint-adjacency: within 1 edit of a listed alias
            for (const h of e.exact) {
              if (levenshtein(norm, h) <= 1) {
                r = rr;
                break;
              }
            }
          }
        }
      }
      if (r !== null && (!best || r < best.r)) best = { e, r };
    }
    if (!best) continue;
    w.done = true;
    const rendered = renderCase(best.e.term, w.core);
    if (rendered !== w.core) {
      toks[w.ti] = w.lead + rendered + w.poss + w.trail;
      corrections.push({ from: w.core, to: rendered });
    }
  }

  return toks.join("");
}

// ---------------------------------------------------------------- entry

export function correct(text: string, vocab: VocabEntry[]): { text: string; corrections: Correction[] } {
  const corrections: Correction[] = [];
  if (!text) return { text, corrections };
  const prep = prepare(vocab);
  if (prep.entries.length === 0) return { text, corrections };
  // `code spans` pass through untouched
  const parts = text.split(/(`[^`]*`)/);
  const out = parts
    .map((p) => (p.length >= 2 && p.startsWith("`") && p.endsWith("`") ? p : fixSegment(p, prep, corrections)))
    .join("");
  return { text: out, corrections };
}
