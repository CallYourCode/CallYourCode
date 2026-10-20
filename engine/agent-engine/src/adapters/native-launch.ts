/* herdr agent.start accepts argv, not shell text or env. Parse only the
 * reader-owned launch grammar, refusing shell operators rather than evaluating
 * anything. Pi's explicit extension flags carry its launch context across this
 * argv-only boundary. Other harnesses keep identity via bindSpawnedPane. */
export function nativeLaunch(command: string): { kind: string; args: string[] } {
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"') word += command[++i] ?? "";
      else word += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s/.test(c)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else if (c === "\\") { word += command[++i] ?? ""; started = true; }
    else {
      if (/[;$`|&<>\n\r]/.test(c)) throw new Error("unsupported native launch syntax");
      word += c; started = true;
    }
  }
  if (quote) throw new Error("unterminated native launch quote");
  if (started) words.push(word);
  const env: Record<string, string> = {};
  while (words[0] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
    const item = words.shift()!;
    if (item === "env") continue;
    const at = item.indexOf("=");
    env[item.slice(0, at)] = item.slice(at + 1);
  }
  for (const name of Object.keys(env)) {
    if (!["CYC_AGENT_ID", "CYC_PI_EVENT_SOCK"].includes(name)) throw new Error(`unsupported native launch environment: ${name}`);
  }
  const kind = words.shift() ?? "";
  if (!["pi", "claude", "codex", "opencode"].includes(kind)) throw new Error(`unsupported native launch: ${kind}`);
  if (kind === "pi") {
    if (env.CYC_AGENT_ID) words.push("--cyc-agent-id", env.CYC_AGENT_ID);
    if (env.CYC_PI_EVENT_SOCK) words.push("--cyc-event-sock", env.CYC_PI_EVENT_SOCK);
  }
  return { kind, args: words };
}
