/* A stand-in for kokoro: a process that binds a port and stays up.
 *
 * services.test.ts needs a service it can start, kill by pid and watch come
 * back, and it may not use a real one -- his kokoro is what speaks to him, and
 * a test run has no business restarting it. This binds whatever port the spec
 * picked (a free one, never a port in the fleet's map) and appends its pid to a
 * file, so a spec can count STARTS from outside the engine rather than from the
 * engine's own report of itself.
 *
 *   bun run toy-service.ts <port> <starts-file> [ms-before-binding]
 *
 * The delay is kokoro: it loads its models for about ten seconds before it
 * binds. That window is where a second supervisor does its damage -- the port
 * is free, so anything else watching decides the service is down and starts one
 * of its own -- so a spec proving one-supervisor-per-host needs a service that
 * takes a moment, not one that is instant. The pid is recorded BEFORE the bind
 * on purpose: a second copy that loses the port and exits still has to leave a
 * trace, or two supervisors would look exactly like one.
 */

export {}; // a file with no import or export is a script, and a script has no top-level await

const port = Number(process.argv[2]);
const startsFile = process.argv[3];
const delayMs = Number(process.argv[4]) || 0;

if (startsFile) {
  const before = await Bun.file(startsFile).text().catch(() => "");
  await Bun.write(startsFile, `${before}${process.pid}\n`);
}

if (delayMs > 0) await Bun.sleep(delayMs);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: () => new Response(String(process.pid)),
});

console.log(`toy-service ${process.pid} on :${port}`);
