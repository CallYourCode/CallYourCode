/* THE ENGINE-HOST PATH PROBE, one line behind a named export.
 *
 * It exists as its own module so the probe itself is unit-testable
 * (runtime/which.test.ts) and so the composition root (runtime/server.ts)
 * wires it into the RoutesCtx in one place. Route code never calls Bun.which
 * directly: it reads ctx.binaryOnPath, which the tests replace with a stub, so
 * the routes stay hermetic.
 *
 * Bun.which(program) is a synchronous stat-walk over PATH; it returns the
 * resolved path or null. So binaryOnPath is null-vs-not and, notably,
 * Bun.which("") is null, so binaryOnPath("") is false (the places computation
 * leans on that for a launch command with no program token). */
export const binaryOnPath = (program: string): boolean =>
  Bun.which(program) !== null;
