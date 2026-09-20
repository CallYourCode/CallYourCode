/* MODEL ID -> THE NAME A PERSON READS, and its short badge spelling. One copy,
 * imported by session-events.ts (the claude reader, which feeds the sessions
 * frame and the top bar) and by plugins/model-indicator (the toolbar chip), so
 * the two can never name one model two ways.
 *
 * POLICY (2026-09-02, owner): fail OPEN. A hand list of families was the bug:
 * Claude Code started writing `claude-fable-5-1` (12,135 records on this box)
 * and `claude-opus-4-6` (1,996), neither matched the list, and the session lost
 * its name and its context bar together. So the name is DERIVED, not looked up:
 *
 *   claude-<family>-<v>[-<v>...]  ->  "<Family> <v.v>" / "<F><v.v>"
 *   claude-fable-5-1              ->  "Fable 5.1"      / "F5.1"
 *   claude-opus-4-6               ->  "Opus 4.6"       / "O4.6"
 *   claude-haiku-4-5-20251001     ->  "Haiku 4.5"      / "H4.5"   (date pin stripped)
 *   claude-opus-5[1m]             ->  "Opus 5"         / "O5"     (1M marker stripped)
 *
 * An id that is not a `claude-<family>-<version>` shape (codex gpt-5.5, opencode
 * kimi-k3, pi ids, a provider-prefixed id) takes the FRIENDLY table below when
 * it has a row, else the RAW id; its acronym is the raw id. A raw id under the
 * session name beats a blank: a wrong-but-present label is something a person
 * can read and report, a missing one is not. Only an empty string answers null.
 *
 *   bun test agent-engine/src/sessions/context.test.ts
 *   bun test agent-engine/src/plugins/model-indicator/model-indicator.test.ts
 */

/* THE BARE FAMILY of a model id: the two suffixes Claude Code really writes,
 * stripped. A `[1m]`-style context marker and a trailing -YYYYMMDD date pin both
 * leave the FAMILY alone, so every lookup keyed off the family strips them
 * first. Spelled once here because the lookups must never disagree about which
 * family an id is; that disagreement WAS an earlier bug (the name and the
 * acronym stripped, `contextWindowFor` did not, so a `claude-opus-5[1m]` session
 * showed its model name over no context bar at all). */
export const bareModelId = (id: string): string =>
  id.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");

/* A reasonable table for the ids that are NOT derivable, not every model that
 * exists. Non-claude ids the harnesses on this box have written, plus the short
 * status-line chips (f5, o4.8, ...) the model-indicator may be handed instead of
 * an id. Keyed on the normalised form `modelKey` produces (lowercase, bare,
 * provider prefix gone). A miss falls back to the raw id, never null. */
export const FRIENDLY_MODEL_NAMES: Record<string, string> = {
  // the Claude status-line chips (the id form is derived, not listed)
  f5: "Fable 5",
  "f5.1": "Fable 5.1",
  "o4.8": "Opus 4.8",
  o5: "Opus 5",
  "o4.7": "Opus 4.7",
  "o4.6": "Opus 4.6",
  "sonnet-5": "Sonnet 5",
  s5: "Sonnet 5",
  "sonnet-4-6": "Sonnet 4.6",
  "s4.6": "Sonnet 4.6",
  "haiku-4-5": "Haiku 4.5",
  "h4.5": "Haiku 4.5",
  // Codex
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  // Grok
  "grok-4.6": "Grok 4.6",
  // opencode go
  "kimi-k3": "Kimi K3",
  "qwen3.8-max": "Qwen3.8 Max",
  "glm-5.3": "GLM 5.3",
  glm53: "GLM 5.3",
  // DeepSeek
  "deepseek-v4": "DeepSeek V4",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  // local
  "qwen3-coder-30b-a3b": "Qwen3-Coder-30B-A3B",
  "qwen3-coder-next-80b-a3b": "Qwen3-Coder-Next-80B-A3B",
  "qwen3.8-27b": "Qwen3.8-27B",
};

/* The normalised lookup key: whitespace trimmed, a provider prefix dropped
 * (`anthropic/claude-fable-5`, `bedrock/us.anthropic/claude-sonnet-5`), the two
 * real suffixes stripped (bareModelId), lowercased. The transcript ids are
 * already bare and lowercase; the model-indicator's inputs are not always. */
export function modelKey(raw: string): string {
  let s = raw.trim();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  return bareModelId(s).trim().toLowerCase();
}

/* `claude-<family>-<v>[-<v>...]` on the normalised key: the family is one word,
 * the version is one or more dash-joined numbers. Anchored, so
 * `claude-opus-5-turbo` (a version this shape cannot spell) is NOT read as Opus
 * 5; it falls through to the raw-id path like any other unknown. */
const CLAUDE_ID = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/;

function claudeParts(key: string): { family: string; version: string } | null {
  const m = CLAUDE_ID.exec(key);
  if (!m) return null;
  return { family: m[1], version: m[2].replace(/-/g, ".") };
}

/** The long display name: "Fable 5.1", "GPT-5.5", or the raw id. Null only for
 *  an empty (or all-whitespace) id. */
export function modelDisplayName(id: string): string | null {
  if (!id || !id.trim()) return null;
  const key = modelKey(id);
  const c = claudeParts(key);
  if (c) return `${c.family[0].toUpperCase()}${c.family.slice(1)} ${c.version}`;
  return FRIENDLY_MODEL_NAMES[key] ?? id;
}

/** The short badge spelling, the SAME one the Claude status line prints: F5.1,
 *  O4.6, H4.5. A non-claude id is its own acronym (the raw id). Null only for an
 *  empty id, exactly where modelDisplayName is. */
export function modelAcronym(id: string): string | null {
  if (!id || !id.trim()) return null;
  const c = claudeParts(modelKey(id));
  if (c) return `${c.family[0].toUpperCase()}${c.version}`;
  return id;
}

/** The short badge spelling derived from a DISPLAY name rather than an id, the
 *  one seam a /model switch has to work from: its transcript stdout carries the
 *  resolved name ("Fable 5.1"), never the raw id. Spelled the SAME way
 *  modelAcronym spells a claude id -- the first letter of each word part, then
 *  the version digits -- so "Fable 5.1" -> "F5.1", "Opus 4.8" -> "O4.8",
 *  "Sonnet 5" -> "S5". A name with no word part (a bare id or alias handed in)
 *  answers itself, never null, the same fail-open rule the rest of this module
 *  keeps. Lives here so the derivation has exactly one home. */
export function acronymFromDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  const words: string[] = [];
  const versions: string[] = [];
  for (const part of trimmed.split(/\s+/)) {
    if (/^[\d.]+$/.test(part)) versions.push(part);
    else words.push(part);
  }
  const initials = words.map((w) => w[0]?.toUpperCase() ?? "").join("");
  const acronym = initials + versions.join(".");
  return acronym || trimmed;
}
