/* THE STABLE AGENT ID, INJECTED AT LAUNCH (cyc-cli plan section 3).
 *
 * Both muxes start an agent by TYPING a command into a fresh shell (herdr
 * newTab, tmux send-keys), so there is exactly ONE mechanism to hand the child
 * its own stable id: a command prefix. This is that prefix, and it is the whole
 * of it -- the two engine spawn paths (/new-session pre-mint, /restart existing
 * id) wrap their launch command in this before it reaches the adapter.
 *
 * `env NAME=VALUE cmd` rather than the bare `NAME=VALUE cmd` form, because the
 * pane shell is not guaranteed POSIX: bash/zsh parse a leading assignment, fish
 * does not, and `env` is the one spelling every shell runs the same (owner flag
 * 2). The value goes on a command line built from another process's mint, so it
 * is held to the exact agent-id charset before it can -- a malformed id is a
 * programming error here, never a thing to paste into a shell.
 *
 *   bun test agent-engine/src/runtime/agent-env.test.ts
 */

/* `ag-` plus 16 base64url chars: exactly what agentmeta.ts mintAgentId emits.
 * base64url is [A-Za-z0-9_-], so the class admits `-` and `_` and nothing that
 * a shell would read as an operator. */
const AGENT_ID_RE = /^ag-[A-Za-z0-9_-]{16}$/;

/** Prefix a launch command with the child's stable agent id. Throws on an id
 *  that does not match the mint's shape, BEFORE the id touches a command line. */
export function withAgentEnv(command: string, agentId: string): string {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(`refusing to inject a malformed agent id onto a command line: ${JSON.stringify(agentId)}`);
  }
  return `env CYC_AGENT_ID=${agentId} ${command}`;
}
