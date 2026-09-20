/* datadir.ts: the one spelling of the ~/.callyourcode layout.
 *
 * NOTHING HERE MAY REACH A REAL ~/.callyourcode, and the default branch of
 * dataDir() is `join($HOME, ".callyourcode")`, so the two rules this file
 * runs by are worth writing down.
 *
 * 1. Every test that TOUCHES THE DISK runs under a throwaway CYC_DATA_DIR from
 *    tmpDir(). There is exactly one place a real home could be created, and it
 *    is proven below that these helpers create nothing at all: they are string
 *    joins, and "the default names his home" is therefore a fact about a string
 *    and not about the filesystem. And since 2026-09-02 the home itself is
 *    faked for every test process: bunfig.toml preloads
 *    test-utils/homeguard.ts, which points $HOME at a temp dir before any
 *    module reads it, and dataDir() reads $HOME before homedir() (bun
 *    freezes homedir() at process start), so even the default branch names
 *    a temp dir. homeguard.test.ts asserts that every run.
 *
 * 2. ENV IS TOUCHED IN ONE PLACE. CYC_DATA_DIR is deleted once at file scope and
 *    restored in afterAll. It is also the SUBJECT of half the tests: dataDir()
 *    reads it lazily on every call, by contract (datadir.ts header: "Every
 *    helper reads the env lazily so a test can set it before boot without
 *    fighting module-load order"), so both branches cannot be proven from one
 *    file-scope value. `withDataDir` below is the concession: it swaps the
 *    variable around a SYNCHRONOUS call and restores it in a finally, so no
 *    other test in this file or any other can observe the swap.
 *
 *   bun test agent-engine/src/storage/datadir.test.ts
 */

import { test, expect, afterAll } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
  dataDir, keysFile, settingsFile, stateDir, stateFile, logsDir, servicesLogDir,
  agentsDir, agentDir, agentMetaFile, agentChatsDir, agentChatFile, agentUploadsDir,
  agentAudioDir, agentDocsDir, agentDocStateDir, agentPhotosDir, agentThumbsDir,
  agentPluginDir, pluginDir, pluginDataDir, stagingUploadsDir, stagingAudioDir,
  safeAgentId, ensureBaseTree, ensureAgentTree, ensureDirSync,
  AGENT_ID_RE, PLUGIN_NAME_RE,
} from "./datadir.ts";
import { tmpDir } from "../test-utils/tmp.ts";

/* FILE-SCOPE ENV, restored in afterAll: the file's baseline is "unset", and
 * every test that wants a value asks for one around its own call. */
const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
delete process.env.CYC_DATA_DIR;

afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
});

/** Run `fn` with CYC_DATA_DIR set to `v` (or unset for null), and put the
 *  variable back whatever happens. Synchronous on purpose: nothing else can
 *  run in between, so the swap is invisible outside the call. */
function withDataDir<T>(v: string | null, fn: () => T): T {
  const before = process.env.CYC_DATA_DIR;
  if (v === null) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = v;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.CYC_DATA_DIR;
    else process.env.CYC_DATA_DIR = before;
  }
}

const AG = "ag-abcDEF123_-45678";

// ------------------------------------------------------------------ the base

test("EVERY helper is a pure path join: nothing here creates a directory", () => {
  /* THE GUARD THAT MAKES THE NEXT TEST SAFE. dataDir()'s default names his own
   * home, and the only reason that is harmless is that none of these functions
   * ever touches the disk -- ensureBaseTree / ensureAgentTree / ensureDirSync
   * are the three that do, and they are the three run under a tmp dir below.
   *
   * Proven against a base that does not exist: call the whole layout through it
   * and it must STILL not exist. A helper that quietly mkdir'd its own parent
   * would fail here, and would otherwise have been discovered by a test run
   * creating half a data directory in his home. */
  const base = join(tmpdir(), `cyc-never-made-${crypto.randomUUID()}`);
  withDataDir(base, () => {
    keysFile(); settingsFile(); stateDir(); stateFile("x.json"); logsDir();
    servicesLogDir(); stagingUploadsDir(); stagingAudioDir(); agentsDir();
    agentDir(AG); agentMetaFile(AG); agentChatsDir(AG); agentChatFile(AG, "c1");
    agentUploadsDir(AG); agentAudioDir(AG); agentDocsDir(AG); agentDocStateDir(AG);
    agentPhotosDir(AG); agentThumbsDir(AG); agentPluginDir(AG, "schedules");
    pluginDir("crons"); pluginDataDir("crons", AG); pluginDataDir("crons");
  });
  expect(existsSync(base), "a path helper created a directory").toBe(false);
});

test("CYC_DATA_DIR wins; the default is <home>/.callyourcode", () => {
  withDataDir("/tmp/x", () => expect(dataDir()).toBe("/tmp/x"));
  /* The default branch, as a STRING. Read the guard above for why naming his
   * home here costs nothing: no helper in this module opens, stats or creates
   * anything, and every test that does runs under a tmp dir. */
  withDataDir(null, () => {
    expect(dataDir()).toBe(join(process.env.HOME!, ".callyourcode"));
    expect(dataDir(), "the test home is the fake one (homeguard.ts)").not.toBe(join(homedir(), ".callyourcode"));
    expect(dataDir(), "absolute, always: every other path in the layout joins onto it")
      .toStartWith("/");
  });
});

test("the env value is trimmed and its trailing slashes stripped", () => {
  /* Everything below joins onto this, so a stray slash would spell every path
   * in the layout with a double separator: `/d//agents/ag-x`. It compares equal
   * to nothing the engine wrote the other way round. */
  withDataDir("/tmp/x/", () => expect(dataDir()).toBe("/tmp/x"));
  withDataDir("/tmp/x///", () => expect(dataDir()).toBe("/tmp/x"));
  withDataDir("  /tmp/x  ", () => expect(dataDir()).toBe("/tmp/x"));
});

test("a blank CYC_DATA_DIR is 'not set', not 'the root directory'", () => {
  /* An empty or whitespace value comes from a shell that exported the variable
   * without a value. Taking it literally would put the whole layout at `/`. */
  const dflt = join(process.env.HOME!, ".callyourcode");
  withDataDir("", () => expect(dataDir()).toBe(dflt));
  withDataDir("   ", () => expect(dataDir()).toBe(dflt));
});

// ---------------------------------------------------------------- the layout

test("the layout hangs off the base dir", () => {
  withDataDir("/d", () => {
    expect(keysFile()).toBe("/d/keys.json");
    expect(settingsFile()).toBe("/d/settings.json");
    expect(stateDir()).toBe("/d/state");
    expect(stateFile("pane-bindings.json")).toBe("/d/state/pane-bindings.json");
    expect(logsDir()).toBe("/d/logs");
    expect(servicesLogDir()).toBe("/d/logs/services");
    expect(stagingUploadsDir()).toBe("/d/staging/uploads");
    expect(stagingAudioDir()).toBe("/d/staging/audio");
    expect(agentsDir()).toBe("/d/agents");
    expect(agentDir(AG)).toBe(`/d/agents/${AG}`);
    expect(agentChatFile(AG, "c1")).toBe(`/d/agents/${AG}/chats/c1.jsonl`);
    expect(agentUploadsDir(AG)).toBe(`/d/agents/${AG}/uploads`);
  });
});

test("every per-agent blob dir is under that agent and nowhere else", () => {
  /* An agent's directory is the unit a rekey merge retires and a purge deletes.
   * A blob dir that resolved outside it would survive both, and the bytes would
   * outlive the record that explains what they are. */
  withDataDir("/d", () => {
    const mine = `/d/agents/${AG}`;
    expect(agentMetaFile(AG)).toBe(`${mine}/meta.json`);
    expect(agentChatsDir(AG)).toBe(`${mine}/chats`);
    expect(agentAudioDir(AG)).toBe(`${mine}/audio`);
    expect(agentDocsDir(AG)).toBe(`${mine}/docs`);
    expect(agentDocStateDir(AG)).toBe(`${mine}/docstate`);
    expect(agentPhotosDir(AG)).toBe(`${mine}/photos`);
    expect(agentThumbsDir(AG), "thumbs live BESIDE the photos, inside them")
      .toBe(`${mine}/photos/thumbs`);
    for (const p of [agentMetaFile(AG), agentChatsDir(AG), agentAudioDir(AG),
      agentDocsDir(AG), agentDocStateDir(AG), agentPhotosDir(AG), agentThumbsDir(AG),
      agentUploadsDir(AG), agentPluginDir(AG, "schedules")]) {
      expect(p, `${p} escaped the agent's own directory`).toStartWith(mine + "/");
    }
  });
});

test("the two-axis plugin rule: agent dir when an agent is named, engine dir otherwise", () => {
  withDataDir("/d", () => {
    expect(pluginDataDir("schedules", AG)).toBe(agentPluginDir(AG, "schedules"));
    expect(pluginDataDir("schedules", AG)).toBe(`/d/agents/${AG}/plugins/schedules`);
    expect(pluginDataDir("reply-dials")).toBe(pluginDir("reply-dials"));
    expect(pluginDataDir("reply-dials", null)).toBe("/d/plugins/reply-dials");
    /* An EMPTY agent id is "no agent", not "an agent called nothing": the
     * resolution is `agentId ? ... : ...`, and an empty string falling into the
     * agent branch would throw on a path that is supposed to be the engine's. */
    expect(pluginDataDir("reply-dials", "")).toBe("/d/plugins/reply-dials");
    expect(pluginDataDir("reply-dials", undefined)).toBe("/d/plugins/reply-dials");
  });
});

// ------------------------------------------------------------ path-safe ids

test("an id with path characters in it never becomes a path", () => {
  expect(safeAgentId("ag-ok_123")).toBe(true);
  expect(safeAgentId("../etc")).toBe(false);
  expect(safeAgentId("ag-../x")).toBe(false);
  expect(() => agentDir("../etc")).toThrow();
  expect(() => pluginDir("../x")).toThrow();
  expect(() => agentChatFile("ag-ok_123", "../c")).toThrow();
});

test("the agent-id charset is exactly ag- plus base64url, 1..64 long", () => {
  /* The agents/ scan at boot reads DIRECTORY NAMES off disk and hands them
   * straight to these helpers, so this regex is the only thing between a
   * directory somebody dropped in there and a path outside the data dir. */
  expect(AGENT_ID_RE.test("ag-" + "a".repeat(64))).toBe(true);
  expect(AGENT_ID_RE.test("ag-" + "a".repeat(65)), "64 is the cap").toBe(false);
  expect(safeAgentId("ag-"), "the prefix alone is not an id").toBe(false);
  expect(safeAgentId("AG-abc"), "the prefix is lower case").toBe(false);
  expect(safeAgentId("abc"), "no prefix at all").toBe(false);
  expect(safeAgentId("ag-a.b"), "a dot is how you climb out of a directory").toBe(false);
  expect(safeAgentId("ag-a/b")).toBe(false);
  expect(safeAgentId("ag-a b")).toBe(false);
  expect(safeAgentId("ag-a\nb"), "a newline must not slip past a $ anchor").toBe(false);
  // the real mint's own alphabet (base64url of 12 random bytes) passes
  expect(safeAgentId("ag-Ab_9-cD3ef_ghIJ")).toBe(true);
});

test("a plugin name is lowercase, digits and hyphens, and nothing else", () => {
  /* A plugin name arrives from a SPEC, which is the least trusted of the two
   * ids that become path segments. */
  expect(PLUGIN_NAME_RE.test("reply-dials")).toBe(true);
  expect(PLUGIN_NAME_RE.test("crons2")).toBe(true);
  expect(PLUGIN_NAME_RE.test("Reply-Dials"), "no upper case").toBe(false);
  expect(PLUGIN_NAME_RE.test("reply_dials"), "no underscore").toBe(false);
  expect(PLUGIN_NAME_RE.test(""), "a plugin has a name").toBe(false);
  expect(PLUGIN_NAME_RE.test("a".repeat(65))).toBe(false);
  expect(() => pluginDir("Reply-Dials")).toThrow();
  expect(() => pluginDir("../../etc")).toThrow();
  expect(() => agentPluginDir(AG, "..")).toThrow();
  expect(() => pluginDataDir("..", AG)).toThrow();
  expect(() => pluginDataDir("..")).toThrow();
});

test("a chat id is checked separately, because it names a FILE", () => {
  /* agentChatFile appends ".jsonl", so an id with a slash in it would write the
   * log outside the agent's chats/ directory while still looking like a chat
   * file to everything downstream. */
  expect(agentChatFile(AG, "c-1")).toEndWith("/chats/c-1.jsonl");
  expect(() => agentChatFile(AG, ""), "an empty chat id is not a file name").toThrow();
  expect(() => agentChatFile(AG, "a/b")).toThrow();
  expect(() => agentChatFile(AG, "a.b"), "a dot would double the extension too").toThrow();
  expect(() => agentChatFile(AG, "a_b"), "the chat charset is narrower than the agent one").toThrow();
  expect(() => agentChatFile(AG, "a".repeat(65))).toThrow();
  // and a bad AGENT id is refused before the chat id is even looked at
  expect(() => agentChatFile("../etc", "c1")).toThrow();
});

// -------------------------------------------------------- making the tree

test("ensureBaseTree makes the whole layout, private, under the dir it is told", async () => {
  /* The layout is not just a naming convention: boot depends on these existing,
   * and 0700 is what keeps another account on the host out of his chat logs.
   * Made under a throwaway dir, never the default branch. */
  const base = await tmpDir("cyc-datadir-");
  await withDataDir(base, () => ensureBaseTree());
  for (const d of [base, join(base, "agents"), join(base, "plugins"),
    join(base, "staging", "uploads"), join(base, "staging", "audio"),
    join(base, "state"), join(base, "logs")]) {
    const st = await stat(d);
    expect(st.isDirectory(), `${d} was not made`).toBe(true);
    expect(st.mode & 0o777, `${d} is not 0700`).toBe(0o700);
  }
});

test("ensureAgentTree makes one agent's chats dir, and only under that agent", async () => {
  const base = await tmpDir("cyc-datadir-");
  await withDataDir(base, () => ensureAgentTree(AG));
  const chats = join(base, "agents", AG, "chats");
  expect((await stat(chats)).isDirectory()).toBe(true);
  expect((await stat(chats)).mode & 0o777).toBe(0o700);
  // a refused id makes no directory at all rather than a strangely-named one
  await expect(withDataDir(base, () => ensureAgentTree("../escape"))).rejects.toThrow();
});

test("ensureDirSync is the same 0700 promise, synchronously", async () => {
  // used on the write paths that cannot await; the mode has to match or a
  // photo directory would end up world-readable while its meta.json is not
  const d = join(await tmpDir("cyc-datadir-"), "a", "b", "sync-made");
  ensureDirSync(d);
  const st = await stat(d);
  expect(st.isDirectory(), "nested parents are made too").toBe(true);
  expect(st.mode & 0o777).toBe(0o700);
  ensureDirSync(d); // idempotent: a second call on an existing dir must not throw
});
