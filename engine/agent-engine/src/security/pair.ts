/* `bun pair.ts` (lane #579).
 *
 * The v1 words-based pairing was deleted in this fold-in: the OSS local install
 * auto-enrols the device over the trusted loopback hop,
 * so there is nothing to type. The v2 box-side ops (--devices / --revoke /
 * --reset over the data dir keys.json) land later; until then this command has
 * no key file to act on.
 */

console.log(
  "Pairing is automatic on this machine (no words to type). " +
  "Device management (--devices / --revoke / --reset) arrives with the v2 key file.",
);
process.exit(0);
