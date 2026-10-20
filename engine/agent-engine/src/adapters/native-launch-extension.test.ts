import { expect, test } from "bun:test";
import activate from "../../../harness/pi/cyc-output.js";

test("the real pi extension accepts native-start argv context before opening its socket", () => {
  const argv = process.argv;
  const oldId = process.env.CYC_AGENT_ID, oldSock = process.env.CYC_PI_EVENT_SOCK;
  const registered: string[] = [];
  let opened = "";
  try {
    process.argv = ["node", "pi", "--cyc-agent-id", "ag-0123456789abcdef", "--cyc-event-sock", "/tmp/native-extension-test.sock"];
    activate({
      on() {},
      registerFlag(name: string) { registered.push(name); },
    } as any, { makeSink(path: string) { opened = path; return { send() {}, close() {} }; } });
    expect(registered).toEqual(["cyc-agent-id", "cyc-event-sock"]);
    expect(process.env.CYC_AGENT_ID).toBe("ag-0123456789abcdef");
    expect(opened).toBe("/tmp/native-extension-test.sock");
  } finally {
    process.argv = argv;
    if (oldId === undefined) delete process.env.CYC_AGENT_ID; else process.env.CYC_AGENT_ID = oldId;
    if (oldSock === undefined) delete process.env.CYC_PI_EVENT_SOCK; else process.env.CYC_PI_EVENT_SOCK = oldSock;
  }
});
