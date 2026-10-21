import {test, expect} from 'bun:test';
import {readFileSync} from 'node:fs';
test('sealed client dependencies are wired before the outbound relay starts', () => {
  const boot = readFileSync(new URL('../runtime/server.ts', import.meta.url), 'utf8');
  expect(boot.indexOf('initClientGlue({')).toBeGreaterThan(0);
  expect(boot.indexOf('relayLink.start()')).toBeGreaterThan(boot.indexOf('initClientGlue({'));
  const glue = readFileSync(new URL('./client-glue.ts', import.meta.url), 'utf8');
  expect(glue).toContain('new EngineSecConn(');
  expect(glue).toContain('pipe.onclose = cleanup');
  expect(glue).toContain('sec.markClosed()');
  expect(glue).toContain('closeClient(sock)');
});
