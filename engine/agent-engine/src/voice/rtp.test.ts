/* RTP header vectors: the byte math the media track's raw RTP rides on.
 *   bun test rtp.test.ts
 */
import { test, expect } from "bun:test";
import { rtpDepacketize, rtpPacketize, newRtpSender } from "./rtp.ts";

test("packetize then depacketize round-trips every field", () => {
  const s = newRtpSender(0xdeadbeef, 111, { seq: 1000, timestamp: 5000 });
  const payload = new Uint8Array([0xfc, 0x01, 0x02, 0x03, 0x04]);
  const pkt = rtpPacketize(s, payload, 960, true);
  const p = rtpDepacketize(pkt)!;
  expect(p).not.toBeNull();
  expect(p.payloadType).toBe(111);
  expect(p.marker).toBe(true);
  expect(p.seq).toBe(1000);
  expect(p.timestamp).toBe(5000);
  expect(p.ssrc).toBe(0xdeadbeef);
  expect([...p.payload]).toEqual([...payload]);
});

test("sender advances seq by one and timestamp by the frame's samples", () => {
  const s = newRtpSender(1, 111, { seq: 0xffff, timestamp: 0xfffffff0 });
  const a = rtpDepacketize(rtpPacketize(s, new Uint8Array([1]), 960))!;
  const b = rtpDepacketize(rtpPacketize(s, new Uint8Array([2]), 960))!;
  expect(a.seq).toBe(0xffff);
  expect(b.seq).toBe(0); // wrapped
  expect(b.timestamp).toBe(((0xfffffff0 + 960) >>> 0)); // wrapped 32-bit
});

test("a packet shorter than the 12-byte header is rejected", () => {
  expect(rtpDepacketize(new Uint8Array(11))).toBeNull();
});

test("a non-version-2 packet is rejected (a stray STUN/garbage message)", () => {
  const pkt = new Uint8Array(16);
  pkt[0] = 0x00; // version 0
  expect(rtpDepacketize(pkt)).toBeNull();
});

test("CSRC entries are skipped so the payload starts after them", () => {
  // v2, CC=2 -> 12 + 8 header bytes, then payload
  const pkt = new Uint8Array(12 + 8 + 3);
  pkt[0] = 0x82; // v2, CC=2
  pkt[1] = 111;
  pkt.set([0xaa, 0xbb, 0xcc], 20);
  const p = rtpDepacketize(pkt)!;
  expect([...p.payload]).toEqual([0xaa, 0xbb, 0xcc]);
});

test("a one-byte extension header block is skipped", () => {
  // v2, X=1, one 32-bit extension word: header 12 + 4(ext hdr) + 4(one word)
  const pkt = new Uint8Array(12 + 4 + 4 + 2);
  pkt[0] = 0x90; // v2, X=1
  pkt[1] = 111;
  const dv = new DataView(pkt.buffer);
  dv.setUint16(14, 1); // ext length = 1 word
  pkt.set([0x7, 0x8], 20);
  const p = rtpDepacketize(pkt)!;
  expect([...p.payload]).toEqual([0x7, 0x8]);
});

test("padding bytes are trimmed from the payload", () => {
  const pkt = new Uint8Array(12 + 2 + 3);
  pkt[0] = 0xa0; // v2, P=1
  pkt[1] = 111;
  pkt.set([0x1, 0x2], 12);
  pkt[pkt.length - 1] = 3; // 3 padding bytes at the tail
  const p = rtpDepacketize(pkt)!;
  expect([...p.payload]).toEqual([0x1, 0x2]);
});
