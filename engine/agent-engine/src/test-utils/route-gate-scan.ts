/* A TINY JS/TS LEXER THAT PROVES EVERY ROUTE ANSWER IS GATED (test-only).
 *
 * control-localhost.test.ts drives a HAND-CURATED table of routes over the real
 * Bun.serve; a route added WITHOUT a gate and WITHOUT being added to that table
 * sails through CI unnoticed. This scanner closes that gap MECHANICALLY: it
 * reads a route handler's SOURCE and reports every content-answering `return`
 * (return json(...) / return jsonAnswer(...) / return new Response(...)) that is
 * NOT dominated by an auth gate on its control-flow path. A new ungated route
 * therefore shows up as an un-allowlisted finding, and the tripwire test fails.
 *
 * WHY A LEXER AND NOT A GREP. The route files mix idioms a line regex cannot
 * follow: match-var dispatch (`const m = path.match(/.../); if (m) {...}`),
 * per-method sub-branches that each carry their own gate (`if (idm) { if
 * (req.method==="GET") { gate } if (req.method==="DELETE") { gate } }`), a
 * single parent gate that covers several nested method branches (plugin state),
 * and route blocks nested inside a bare `{ }` scope (chat page). The one
 * property that holds across all of them is CONTROL-FLOW DOMINANCE: on the path
 * that reaches a content answer, a gate call executed first. That is a
 * scope-stack fact, so this walks braces (skipping strings, template literals,
 * regex and comments) and asks, at each content return, whether a gate was seen
 * earlier in this scope or any still-open ancestor scope.
 *
 * A GATE that returns only on refusal (`const denied = await requireOwner(...);
 * if (denied) return denied;`) means any LATER return on the same/inner path
 * ran only because the gate ALLOWED, so "a gate token appeared earlier in an
 * open scope" is exactly "this answer is gated". isTrustedLocal counts too: the
 * pre-table /agent/reply and /agent/info gate inline with
 * `if (!isTrustedLocal(...)) return ...`. isLoopbackTrusted is the SAME predicate
 * minus the CYC_ALLOW_LOOPBACK_LOCAL transition flag and the socket mark, kept
 * for /ws (whose mux readers dial loopback TCP and must pass regardless of the
 * flag), so it gates the /ws upgrade inline the same way.
 */

const GATE_TOKENS = ["requireOwner", "requireLocal", "isTrustedLocal", "isLoopbackTrusted"] as const;

export type ContentReturn = {
  /** char offset of the `return` within the scanned body */
  offset: number;
  /** the answer form: json(/jsonAnswer(/new Response( */
  snippet: string;
  /** a short code excerpt starting at the return, for allowlisting by content */
  context: string;
};

export type ScanResult = {
  /** number of gate-call tokens seen in the body */
  gates: number;
  /** number of content-answering returns seen */
  contentReturns: number;
  /** content returns with NO gate dominating them (the ones an allowlist must explain) */
  ungated: ContentReturn[];
};

type Frame = { gated: boolean };

/** True when `/` at position i begins a regex literal rather than division.
 *  Standard heuristic: a regex cannot follow a value (identifier, number, `)`,
 *  `]`, or a string/template just closed), so if the previous significant char
 *  is one of those it is division; otherwise it is a regex. */
function regexAllowedAfter(prevSignificant: string): boolean {
  if (prevSignificant === "") return true; // start of body
  if (/[)\]}]/.test(prevSignificant)) return false;
  if (/[A-Za-z0-9_$]/.test(prevSignificant)) return false; // ident / number end
  return true;
}

/** Extract the `{ ... }` body of the first function whose header contains
 *  `headerNeedle`, brace-matched with the same string/comment/regex awareness
 *  the scan uses, so a `{` inside a string in the signature cannot fool it. */
export function extractFunctionBody(source: string, headerNeedle: string): string {
  const at = source.indexOf(headerNeedle);
  if (at < 0) throw new Error(`extractFunctionBody: header not found: ${headerNeedle}`);
  // find the first `{` at or after the header that is real code (skip a `{` that
  // lands inside a string/comment by reusing the scanner's skip logic)
  const open = findBodyOpenBrace(source, at + headerNeedle.length);
  if (open < 0) throw new Error(`extractFunctionBody: no opening brace after ${headerNeedle}`);
  const close = matchBrace(source, open);
  if (close < 0) throw new Error(`extractFunctionBody: unbalanced braces after ${headerNeedle}`);
  return source.slice(open + 1, close);
}

/* The lexer state machine, shared by findBodyOpenBrace / matchBrace / scanBody:
 * a single left-to-right pass that classifies each char as code, string,
 * template, regex or comment, so brace/return/gate reads only ever see code. */
type Walk = {
  onCodeChar?: (ch: string, i: number, prevSig: string) => void;
  onBraceOpen?: (i: number) => void;
  onBraceClose?: (i: number) => void;
};

function walk(source: string, start: number, end: number, cb: Walk): void {
  let i = start;
  let prevSig = "";
  // depth of `${ }` interpolations we are currently inside, so a `}` closing one
  // returns us to template mode rather than popping a code brace
  const templateStack: number[] = []; // brace depth captured when entering `${`
  let braceDepth = 0;
  while (i < end) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    // comments
    if (two === "//") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? end : nl;
      continue;
    }
    if (two === "/*") {
      const close = source.indexOf("*/", i + 2);
      i = close < 0 ? end : close + 2;
      continue;
    }
    // strings
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch, end);
      prevSig = ch;
      continue;
    }
    // template literal
    if (ch === "`") {
      i = skipTemplate(source, i, end, cb, () => braceDepth, (d) => { braceDepth = d; }, templateStack);
      prevSig = "`";
      continue;
    }
    // regex vs division
    if (ch === "/") {
      if (regexAllowedAfter(prevSig)) {
        i = skipRegex(source, i, end);
        prevSig = "/";
        continue;
      }
      // division: fall through as code
    }
    // a `}` that closes a `${` interpolation returns to template mode
    if (ch === "}" && templateStack.length && braceDepth === templateStack[templateStack.length - 1]) {
      templateStack.pop();
      i = skipTemplate(source, i + 1, end, cb, () => braceDepth, (d) => { braceDepth = d; }, templateStack, true);
      prevSig = "`";
      continue;
    }
    if (ch === "{") { braceDepth++; cb.onBraceOpen?.(i); }
    else if (ch === "}") { braceDepth--; cb.onBraceClose?.(i); }
    cb.onCodeChar?.(ch, i, prevSig);
    if (!/\s/.test(ch)) prevSig = ch;
    i++;
  }
}

function skipQuoted(source: string, i: number, quote: string, end: number): number {
  i++; // past opening quote
  while (i < end) {
    const c = source[i];
    if (c === "\\") { i += 2; continue; }
    if (c === quote) return i + 1;
    i++;
  }
  return end;
}

function skipRegex(source: string, i: number, end: number): number {
  i++; // past opening /
  let inClass = false;
  while (i < end) {
    const c = source[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) { i++; break; }
    else if (c === "\n") break; // an unterminated regex would be a syntax error anyway
    i++;
  }
  // skip flags
  while (i < end && /[a-z]/i.test(source[i])) i++;
  return i;
}

/** Skip a template literal starting at a backtick (fresh=false) or resuming
 *  after a `${...}` interpolation closed (fresh=true, i is just past the `}`).
 *  A `${` hands control back to the caller by recording the interpolation and
 *  returning to normal code walking. */
function skipTemplate(source: string, i: number, end: number, _cb: Walk,
  getDepth: () => number, _setDepth: (d: number) => void, templateStack: number[], fresh = false): number {
  if (!fresh) i++; // past opening backtick
  while (i < end) {
    const c = source[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && source[i + 1] === "{") {
      // enter interpolation: remember the brace depth so its closing `}` is
      // recognised, then return to normal walking (the caller re-enters template
      // mode when that `}` is hit).
      templateStack.push(getDepth());
      return i + 2; // caller resumes as code; getDepth() unchanged, `{` not counted
    }
    i++;
  }
  return end;
}

function findBodyOpenBrace(source: string, from: number): number {
  let found = -1;
  walk(source, from, source.length, {
    onBraceOpen: (i) => { if (found < 0) found = i; },
  });
  return found;
}

function matchBrace(source: string, open: number): number {
  let depth = 0;
  let close = -1;
  walk(source, open, source.length, {
    onBraceOpen: () => { depth++; },
    onBraceClose: (i) => { depth--; if (depth === 0 && close < 0) close = i; },
  });
  return close;
}

/** Scan a function body (as returned by extractFunctionBody) for content
 *  returns that no gate dominates. */
export function scanBody(body: string): ScanResult {
  const stack: Frame[] = [{ gated: false }]; // the function body scope itself
  const ungated: ContentReturn[] = [];
  let gates = 0;
  let contentReturns = 0;

  const covered = (): boolean => stack.some((f) => f.gated);

  walk(body, 0, body.length, {
    onBraceOpen: () => { stack.push({ gated: false }); },
    onBraceClose: () => { if (stack.length > 1) stack.pop(); },
    onCodeChar: (ch, i) => {
      // token starts only at an identifier boundary: the RAW previous char (not
      // prevSig, which skips whitespace) decides -- `await requireOwner` must
      // read `requireOwner` as a fresh token, not the tail of `await`.
      if (!/[A-Za-z]/.test(ch)) return;
      const before = i === 0 ? " " : body[i - 1];
      if (/[A-Za-z0-9_$]/.test(before)) return; // mid-identifier
      // gate token?
      for (const g of GATE_TOKENS) {
        if (matchWord(body, i, g) && nextNonSpace(body, i + g.length) === "(") {
          gates++;
          if (stack.length) stack[stack.length - 1].gated = true;
          return;
        }
      }
      // content return?
      if (matchWord(body, i, "return")) {
        const rest = ltrim(body, i + "return".length);
        const snippet = answerForm(body, rest);
        if (snippet) {
          contentReturns++;
          if (!covered()) ungated.push({ offset: i, snippet, context: excerpt(body, i) });
        }
      }
    },
  });

  return { gates, contentReturns, ungated };
}

/** A whitespace-collapsed excerpt starting at the return, for allowlist matching. */
function excerpt(s: string, i: number, n = 90): string {
  return s.slice(i, i + n).replace(/\s+/g, " ").trim();
}

function matchWord(s: string, i: number, word: string): boolean {
  if (s.slice(i, i + word.length) !== word) return false;
  const after = s[i + word.length] ?? " ";
  return /[^A-Za-z0-9_$]/.test(after);
}

function nextNonSpace(s: string, i: number): string {
  while (i < s.length && /\s/.test(s[i])) i++;
  return s[i] ?? "";
}

function ltrim(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** If a return's operand is a content answer, name its form; else "". */
function answerForm(s: string, at: number): string {
  if (matchWord(s, at, "json") && nextNonSpace(s, at + 4) === "(") return "json(";
  if (matchWord(s, at, "jsonAnswer") && nextNonSpace(s, at + 10) === "(") return "jsonAnswer(";
  if (matchWord(s, at, "new")) {
    const afterNew = ltrim(s, at + 3);
    if (matchWord(s, afterNew, "Response") && nextNonSpace(s, afterNew + 8) === "(") return "new Response(";
  }
  return "";
}
