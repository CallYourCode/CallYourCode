import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {startEngine, type TestEngine, type SeenFrame} from './engine';
test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');
const SESSION = 'fixture-seal-window';
const USER = 'fixture';
const HOST = 'fixturebox';
type PipeSent = {kind: 'plain' | 'sealed' | 'ctrl' | 'bad'; t?: string};
function makeEngine(): Promise<TestEngine> {
  return startEngine({
    user: USER,
    host: HOST,
    onConnect: (ws) => {
      ws.send(JSON.stringify({t: 'host', user: USER, host: HOST}));
      ws.send(JSON.stringify({t: 'can', list: []}));
      ws.send(JSON.stringify({t: 'voice', url: 'http://127.0.0.1:1'}));
      ws.send(
        JSON.stringify({
          t: 'sessions',
          list: [
            {
              id: SESSION,
              name: SESSION,
              cwd: '/tmp/' + SESSION,
              unread: 0,
              muted: false,
              alive: true,
              status: 'idle',
              title: {text: SESSION, detail: null}
            }
          ]
        })
      );
    },
    onMessage: (ws, inner) => {
      if (inner?.t === 'attach') {
        ws.send(
          JSON.stringify({
            t: 'attach-ok',
            id: SESSION,
            known: true,
            pointer: 0,
            pointerPage: 0,
            tailPage: 0,
            pageSize: 100,
            total: 0,
            pages: [{page: 0, version: 0, sealed: false, messages: []}]
          })
        );
      }
    }
  });
}
let rig: TestEngine | null = null;
test.afterEach(async () => {
  await rig?.close();
  rig = null;
});
async function pipeSent(page: Page): Promise<PipeSent[]> {
  return page.evaluate(() => ((window as any).__cycPipeSent as PipeSent[]) ?? []);
}
function unsealedApp(sent: PipeSent[]): PipeSent[] {
  return sent.filter((s) => s.kind === 'plain' && s.t !== 'hello');
}
function unsealedAppOnRig(seen: SeenFrame[]): SeenFrame[] {
  return seen.filter((s) => !s.sealed && s.t !== 'hello');
}
async function driveWindowActions(page: Page) {
  await page.waitForFunction(() => !!(window as any).__cycWire, {timeout: 10_000});
  await page.evaluate((session) => {
    const w = (window as any).__cycWire;
    w.attach(session);
    w.heard(session, 'm-heard');
    w.sendText(session, 'one');
    w.sendText(session, 'two');
  }, SESSION);
}
test('no app frame hits the pipe unsealed, including mid-handshake and reconnect', async ({
  page
}) => {
  rig = await makeEngine();
  rig.holdHandshake();
  await bootPinned(page, rig.port, {logSends: true, wait: 'none'});
  await page.waitForFunction(() => !!(window as any).__cycE2e && !!(window as any).__cycWire, {
    timeout: 15_000
  });
  await expect
    .poll(async () => (await pipeSent(page)).some((s) => s.kind === 'plain' && s.t === 'hello'), {
      timeout: 10_000,
      message: 'hello never hit the instrumented pipe'
    })
    .toBe(true);
  await driveWindowActions(page);
  await page.waitForTimeout(200);
  const mid = await pipeSent(page);
  expect(unsealedApp(mid), 'unsealed app frame on the pipe during handshake').toEqual([]);
  expect(
    mid.some((s) => s.kind === 'sealed'),
    'a sealed app frame left before the seal was ready'
  ).toBe(false);
  expect(
    rig.seen.some((s) => s.t === 'attach' || s.t === 'heard' || s.t === 'utterance'),
    'app frame reached the rig before sec'
  ).toBe(false);
  rig.releaseHandshake();
  await expect.poll(() => rig!.secOkCount, {timeout: 10_000}).toBe(1);
  await expect
    .poll(() => rig!.seen.filter((s) => s.sealed && s.t === 'attach').length, {
      timeout: 10_000,
      message: 'attach did not flush sealed'
    })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => rig!.seen.filter((s) => s.sealed && s.t === 'heard').length, {
      timeout: 10_000,
      message: 'heard did not flush sealed'
    })
    .toBe(1);
  await expect
    .poll(() => rig!.seen.filter((s) => s.sealed && s.t === 'utterance').length, {
      timeout: 10_000,
      message: 'utterances did not flush sealed'
    })
    .toBe(2);
  const after = rig.seen;
  const firstHello = after.findIndex((s) => s.t === 'hello');
  const firstSecOk = after.findIndex((s) => s.t === 'sec-ok');
  const firstAttach = after.findIndex((s) => s.t === 'attach');
  const firstHeard = after.findIndex((s) => s.t === 'heard');
  const utts = after.map((s, i) => ({s, i})).filter((x) => x.s.t === 'utterance');
  expect(firstHello).toBeGreaterThanOrEqual(0);
  expect(firstSecOk).toBeGreaterThan(firstHello);
  expect(after[firstSecOk].sealed).toBe(true);
  expect(firstAttach).toBeGreaterThan(firstSecOk);
  expect(after[firstAttach].sealed).toBe(true);
  expect(firstHeard).toBeGreaterThan(firstAttach);
  expect(after[firstHeard].sealed).toBe(true);
  expect(utts.length).toBe(2);
  expect(utts[0].i).toBeGreaterThan(firstHeard);
  expect(utts[1].i).toBeGreaterThan(utts[0].i);
  expect(utts[0].s.sealed && utts[1].s.sealed).toBe(true);
  expect(unsealedApp(await pipeSent(page))).toEqual([]);
  expect(unsealedAppOnRig(rig.seen)).toEqual([]);
  rig.holdHandshake();
  const hellosBefore = rig.seen.filter((s) => s.t === 'hello').length;
  const heardBefore = rig.seen.filter((s) => s.t === 'heard').length;
  const uttBefore = rig.seen.filter((s) => s.t === 'utterance').length;
  rig.dropChannel();
  await expect
    .poll(() => rig!.seen.filter((s) => s.t === 'hello').length, {
      timeout: 20_000,
      message: 'reconnect never sent hello'
    })
    .toBe(hellosBefore + 1);
  await driveWindowActions(page);
  await page.waitForTimeout(200);
  expect(
    rig.seen.filter((s) => s.t === 'heard').length,
    'heard hit the rig during reconnect handshake'
  ).toBe(heardBefore);
  expect(
    rig.seen.filter((s) => s.t === 'utterance').length,
    'utterance hit the rig during reconnect handshake'
  ).toBe(uttBefore);
  expect(unsealedApp(await pipeSent(page))).toEqual([]);
  expect(unsealedAppOnRig(rig.seen)).toEqual([]);
  rig.releaseHandshake();
  await expect.poll(() => rig!.secOkCount, {timeout: 15_000}).toBe(2);
  await expect
    .poll(() => rig!.seen.filter((s) => s.sealed && s.t === 'heard').length, {
      timeout: 10_000,
      message: 'heard did not flush sealed after reconnect'
    })
    .toBe(heardBefore + 1);
  await expect
    .poll(() => rig!.seen.filter((s) => s.sealed && s.t === 'utterance').length, {
      timeout: 10_000,
      message: 'utterances did not flush sealed after reconnect'
    })
    .toBeGreaterThanOrEqual(uttBefore + 2);
  await expect
    .poll(() => rig!.attachCount, {timeout: 10_000, message: 'reconnect did not re-attach'})
    .toBeGreaterThanOrEqual(2);
  expect(
    unsealedApp(await pipeSent(page)),
    'instrumented pipe send saw an unsealed app frame'
  ).toEqual([]);
  expect(unsealedAppOnRig(rig.seen), 'rig saw an unsealed app frame').toEqual([]);
});
