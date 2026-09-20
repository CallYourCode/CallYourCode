import { describe, expect, test } from "bun:test";
import { correct, type VocabEntry } from "./vocabulary";
import vocabJson from "./vocabulary.json";

const vocab = vocabJson as VocabEntry[];

const fix = (s: string) => correct(s, vocab).text;

describe("observed mangle pairs (live transcripts 2026-07-22)", () => {
  test("herdr family", () => {
    expect(fix("open the header pane")).toBe("open the herdr pane");
    expect(fix("check the hurdle workspace")).toBe("check the herdr workspace");
    expect(fix("use harder for this")).toBe("use herdr for this");
    expect(fix("HIDR runs the panes")).toBe("herdr runs the panes");
    expect(fix("the herder tool")).toBe("the herdr tool");
  });

  test("callyourcode family (n-gram merge)", () => {
    expect(fix("open call your clod on my phone")).toBe("open CallYourCode on my phone");
    expect(fix("the call your cloud app")).toBe("the CallYourCode app");
    expect(fix("call your claude is running")).toBe("CallYourCode is running");
    expect(fix("callyourcode needs a restart")).toBe("CallYourCode needs a restart");
  });

  test("claude family", () => {
    expect(fix("ask clod about it")).toBe("ask claude about it");
    expect(fix("send it to cloud")).toBe("send it to claude");
    expect(fix("tell clot to stop")).toBe("tell claude to stop");
  });

  test("linux family", () => {
    expect(fix("deploy K8 plus tonight")).toBe("deploy linux tonight");
    expect(fix("the cake plus cluster")).toBe("the linux cluster");
  });

  test("tailscale family", () => {
    expect(fix("over tailscape on the tailnet")).toBe("over tailscale on the tailnet");
  });

  test("regtech family", () => {
    expect(fix("the rectech project")).toBe("the regtech project");
  });

  test("whisper family", () => {
    expect(fix("wisper transcribes it")).toBe("whisper transcribes it");
  });

  test("parakeet family", () => {
    expect(fix("paracate is streaming")).toBe("parakeet is streaming");
    expect(fix("switch to palicate")).toBe("switch to parakeet");
  });

  test("kokoro family", () => {
    expect(fix("cocoro speaks the reply")).toBe("kokoro speaks the reply");
  });
});

describe("fuzzy catches unlisted near-misses", () => {
  test("single word, phonetic + distance", () => {
    expect(fix("ask clode about it")).toBe("ask claude about it"); // not a listed hint
    expect(fix("paracete is streaming")).toBe("parakeet is streaming"); // not a listed hint
    expect(fix("whisperr is slow")).toBe("whisper is slow"); // not a listed hint
  });

  test("multi word, near a listed hint", () => {
    expect(fix("open call your clode now")).toBe("open CallYourCode now"); // clod hint + 1 edit
  });
});

describe("guards", () => {
  test("header corrects but heater stays", () => {
    expect(fix("the header row")).toBe("the herdr row");
    expect(fix("the heater is on")).toBe("the heater is on");
  });

  test("cloud corrects only as a standalone word", () => {
    expect(fix("push it to the cloud")).toBe("push it to the claude");
    expect(fix("it is cloudy today")).toBe("it is cloudy today");
    expect(fix("the clouds rolled in")).toBe("the clouds rolled in");
  });

  test("worked never becomes worktree (live false positive 2026-07-23)", () => {
    expect(fix("session IDs that I had worked on previously")).toBe(
      "session IDs that I had worked on previously",
    );
    expect(fix("it worked fine")).toBe("it worked fine");
  });

  test("edit distance ratio > 0.4 never corrects", () => {
    expect(fix("translate the file")).toBe("translate the file");
    expect(fix("the murder mystery")).toBe("the murder mystery");
    expect(fix("json is fine")).toBe("json is fine"); // 1 edit from jsonl but phonetics differ
  });

  test("short words only on exact phonetic match", () => {
    expect(fix("the cat sat")).toBe("the cat sat");
    expect(fix("a map of it")).toBe("a map of it");
    expect(fix("use mcp for tools")).toBe("use MCP for tools"); // exact alias
  });

  test("code spans are untouched", () => {
    expect(fix("run `cloud sync` then ask cloud")).toBe("run `cloud sync` then ask claude");
    expect(fix("`wisper.cfg` uses wisper")).toBe("`wisper.cfg` uses whisper");
  });

  test("case and punctuation preserved", () => {
    expect(fix("Cloud, are you there?")).toBe("Claude, are you there?");
    expect(fix("ask clod.")).toBe("ask claude.");
    expect(fix("clod's turn")).toBe("claude's turn");
    expect(fix("Header first")).toBe("Herdr first");
  });

  test("n-gram merges only when the vocab term says so", () => {
    // "your clod" is not a listed bigram: no merge, single-word pass fixes clod
    expect(fix("your clod is busy")).toBe("your claude is busy");
    // punctuation inside the window blocks the merge
    expect(fix("call, your clod")).toBe("call, your claude");
    // an unrelated phrase near the squash threshold stays put
    expect(fix("call your code")).toBe("call your code");
  });

  test("already-correct terms are left alone", () => {
    const s = "CallYourCode talks to claude over tailscale with whisper and parakeet";
    expect(fix(s)).toBe(s);
  });
});

describe("idempotence", () => {
  const samples = [
    "open call your clod, the header pane shows wisper and paracate on tailscape",
    "cake plus and rectech live in the work tree with jason l logs",
    "HIDR drives the panes; cloud replies over t web",
    "callyourcode is claude in your pocket",
  ];
  for (const s of samples) {
    test(JSON.stringify(s), () => {
      const once = correct(s, vocab).text;
      const twice = correct(once, vocab).text;
      expect(twice).toBe(once);
    });
  }
});

describe("corrections report", () => {
  test("lists every change with from/to", () => {
    const { corrections } = correct("call your clod uses wisper on tailscape", vocab);
    expect(corrections).toEqual([
      { from: "call your clod", to: "CallYourCode" },
      { from: "wisper", to: "whisper" },
      { from: "tailscape", to: "tailscale" },
    ]);
  });

  test("no changes, no corrections", () => {
    expect(correct("nothing to see here", vocab).corrections).toEqual([]);
  });
});

describe("performance", () => {
  test("under 5ms for a 200-word transcript", () => {
    const words = [
      "so", "the", "header", "pane", "shows", "wisper", "output", "and", "then",
      "call", "your", "clod", "streams", "it", "over", "tailscape", "to", "the",
      "cake", "plus", "cluster", "while", "paracate", "keeps", "up",
    ];
    const transcript = Array.from({ length: 200 }, (_, i) => words[i % words.length]).join(" ");
    correct(transcript, vocab); // warm up (JIT + prepare cache)
    const runs = 50;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) correct(transcript, vocab);
    const avg = (performance.now() - t0) / runs;
    console.log(`correct() avg ${avg.toFixed(3)}ms on 200 words`);
    expect(avg).toBeLessThan(5);
  });
});
