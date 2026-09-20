/* RTP packetize / depacketize for the Opus media track.
 *
 * node-datachannel's Track carries RAW RTP: a received message is a whole RTP
 * packet (header + payload), and sendMessageBinary takes a whole RTP packet.
 * libdatachannel does not strip or add the RTP header for us on this path, so
 * this module is the header, and only the header. The Opus codec (opus.ts) owns
 * the payload; the two never mix.
 *
 * RFC 3550 header, big-endian:
 *   byte 0   V(2) P(1) X(1) CC(4)
 *   byte 1   M(1) PT(7)
 *   2..3     sequence number
 *   4..7     timestamp
 *   8..11    SSRC
 *   then     CC * 4 bytes of CSRC
 *   if X     4-byte extension header + (len) 32-bit words of extension
 *   payload  the rest (minus P padding, if P)
 *
 * Pure, no I/O, no native handles: the drift-prone byte math lives here where a
 * vector test pins every field, rather than inline in the media glue.
 */

export type RtpParsed = {
  payloadType: number;
  marker: boolean;
  seq: number;
  timestamp: number;
  ssrc: number;
  /** the payload alone: for Opus, one encoded frame. A view, not a copy. */
  payload: Uint8Array;
};

/** Parse one RTP packet. Returns null for anything too short or not version 2,
 *  so a stray STUN/RTCP/garbage message on the track is dropped, never decoded
 *  as if it were Opus. */
export function rtpDepacketize(pkt: Uint8Array): RtpParsed | null {
  if (pkt.length < 12) return null;
  if ((pkt[0] >> 6) !== 2) return null; // version must be 2
  const padding = (pkt[0] & 0x20) !== 0;
  const extension = (pkt[0] & 0x10) !== 0;
  const csrcCount = pkt[0] & 0x0f;
  const marker = (pkt[1] & 0x80) !== 0;
  const payloadType = pkt[1] & 0x7f;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const seq = dv.getUint16(2);
  const timestamp = dv.getUint32(4);
  const ssrc = dv.getUint32(8);

  let headerLen = 12 + csrcCount * 4;
  if (extension) {
    if (pkt.length < headerLen + 4) return null;
    const extWords = dv.getUint16(headerLen + 2);
    headerLen += 4 + extWords * 4;
  }
  if (pkt.length < headerLen) return null;

  let end = pkt.length;
  if (padding) {
    const padLen = pkt[pkt.length - 1];
    if (padLen < 1 || headerLen + padLen > pkt.length) return null;
    end -= padLen;
  }
  return {
    payloadType,
    marker,
    seq,
    timestamp,
    ssrc,
    payload: pkt.subarray(headerLen, end),
  };
}

/** Rolling state for one outgoing RTP stream: sequence + timestamp advance per
 *  packet, the SSRC and payload type are fixed for the stream's life. */
export type RtpSender = {
  ssrc: number;
  payloadType: number;
  seq: number;
  timestamp: number;
};

export function newRtpSender(ssrc: number, payloadType: number, opts?: { seq?: number; timestamp?: number }): RtpSender {
  return {
    ssrc: ssrc >>> 0,
    payloadType: payloadType & 0x7f,
    // A random-ish start so two streams do not collide on seq 0; the exact value
    // is immaterial, only that it advances by one per packet.
    seq: (opts?.seq ?? ((Math.random() * 0xffff) | 0)) & 0xffff,
    timestamp: (opts?.timestamp ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0,
  };
}

/** Build one RTP packet around an Opus frame and advance the sender.
 *  `samples` is the number of 48kHz samples this frame represents (960 for a
 *  20ms frame), which is how much the RTP timestamp moves. */
export function rtpPacketize(s: RtpSender, payload: Uint8Array, samples: number, marker = false): Uint8Array {
  const pkt = new Uint8Array(12 + payload.length);
  const dv = new DataView(pkt.buffer);
  pkt[0] = 0x80; // v2, no padding, no extension, no CSRC
  pkt[1] = (marker ? 0x80 : 0) | s.payloadType;
  dv.setUint16(2, s.seq & 0xffff);
  dv.setUint32(4, s.timestamp >>> 0);
  dv.setUint32(8, s.ssrc >>> 0);
  pkt.set(payload, 12);
  s.seq = (s.seq + 1) & 0xffff;
  s.timestamp = (s.timestamp + samples) >>> 0;
  return pkt;
}
