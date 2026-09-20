/* THE ONE DEPENDENCY THAT SHIPS NO TYPES.
 *
 * `qrcode-terminal` is plain JavaScript with no bundled .d.ts and no
 * @types package installed here, so pairkey.ts's import of it is an implicit
 * `any` and TS7016 under `strict`. Nothing in this repo may run an install to
 * fix that, and the module has exactly one call site and one function.
 *
 * So the surface is DECLARED rather than silenced: `generate(text, opts, cb)`,
 * which is what pairkey.ts calls and what the library exports. A wrong argument
 * is a type error again, which `any` was not.
 *
 * This file is not in tsconfig.check.json's `files`: pairkey.ts is a CLI
 * (`bun run pair-key`), not part of server.ts's graph, and only the tests
 * config reaches it -- through pairkey.test.ts.
 */
declare module "qrcode-terminal" {
  export function generate(
    text: string,
    opts?: { small?: boolean },
    cb?: (qr: string) => void,
  ): void;
  const _default: { generate: typeof generate };
  export default _default;
}
