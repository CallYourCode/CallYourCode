import {dcPipe, type Pipe} from '@shared/dcpipe';
import {cyclog} from '@/shared/logging';

async function logSelectedPair(pc: RTCPeerConnection, id: string): Promise<void> {
  try {
    const stats = await pc.getStats();
    let sel: any = null;
    const c: Record<string, any> = {};
    stats.forEach((r: any) => {
      if (r.type === 'candidate-pair' && (r.nominated || r.selected || r.state === 'succeeded'))
        sel = r;
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') c[r.id] = r;
    });
    if (sel)
      cyclog('rtc.pair', {
        id,
        state: sel.state,
        local: c[sel.localCandidateId]?.candidateType,
        remote: c[sel.remoteCandidateId]?.candidateType,
        sent: sel.bytesSent,
        recv: sel.bytesReceived
      });
  } catch {}
}

function fingerprintOfSdp(sdp: string | null | undefined): string | null {
  if (!sdp) return null;
  const m = /a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/.exec(sdp);
  return m ? m[1].toUpperCase() : null;
}

export interface AudioChannel {
  readonly sender: RTCRtpSender | null;

  inboundTrack(): MediaStreamTrack | null;

  onInboundTrack(cb: (track: MediaStreamTrack) => void): void;

  localFp(): string | null;

  remoteFp(): string | null;
}

export interface Signal {
  send(frame: unknown): void;
  onframe: ((m: any) => void) | null;
  close(code?: number, reason?: string): void;
  onclose: ((code: number) => void) | null;
}

export interface RelayAuth {
  spki: string;
  sign(nonce: string): Promise<string>;
}

export function wsSignal(url: string, auth?: RelayAuth): Signal {
  const ws = new WebSocket(url);
  let authed = !auth;
  const outbuf: string[] = [];
  const rawSend = (s: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
    else
      ws.addEventListener(
        'open',
        () => {
          try {
            ws.send(s);
          } catch {}
        },
        {once: true}
      );
  };
  const sig: Signal = {
    onframe: null,
    onclose: null,
    send(frame) {
      const s = JSON.stringify(frame);
      if (authed) rawSend(s);
      else outbuf.push(s);
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {}
    }
  };
  ws.onmessage = (ev) => {
    let m: any;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (auth && !authed) {
      if (m?.t === 'r-challenge' && typeof m.nonce === 'string') {
        void auth
          .sign(m.nonce)
          .then((sg) => {
            rawSend(JSON.stringify({t: 'r-auth', spki: auth.spki, sig: sg}));
          })
          .catch(() => {
            try {
              ws.close(4401, 'auth-failed');
            } catch {}
          });
        return;
      }
      if (m?.t === 'r-ok') {
        authed = true;
        for (const s of outbuf.splice(0)) rawSend(s);
        return;
      }
      if (m?.t === 'r-reject') {
        try {
          ws.close(4401, 'rejected');
        } catch {}
        return;
      }
      return;
    }
    sig.onframe?.(m);
  };
  ws.onclose = (ev) => sig.onclose?.(ev.code);
  return sig;
}

function pick(c: RTCIceCandidate): {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
} {
  return {candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex};
}

const DIAL_MS = 10_000;

export class RtcDial {
  private pc: RTCPeerConnection | null = null;
  private id = crypto.randomUUID();
  private done = false;
  private opened = false;
  private pipe: Pipe | null = null;
  private candQ: Array<RTCIceCandidateInit | null> = [];
  private remoteSet = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private audioChannel: AudioChannel | null = null;
  private offerSdp: string | null = null;
  private answerSdp: string | null = null;

  constructor(
    private signal: Signal,
    private iceServers: RTCIceServer[] = [],
    private withAudio = true
  ) {}

  get audio(): AudioChannel | null {
    return this.audioChannel;
  }

  start(): Promise<Pipe> {
    return new Promise<Pipe>((resolve, reject) => {
      const fail = (reason: string) => {
        if (this.done) return;
        this.done = true;
        if (this.timer) clearTimeout(this.timer);
        cyclog('rtc.dial.fail', {
          id: this.id,
          reason,
          pc: this.pc?.connectionState,
          ice: this.pc?.iceConnectionState,
          opened: this.opened
        });
        try {
          this.pc?.close();
        } catch {}
        reject(new Error(reason));
      };
      const succeed = (pipe: Pipe) => {
        if (this.done) return;
        this.done = true;
        this.opened = true;
        this.pipe = pipe;
        if (this.timer) clearTimeout(this.timer);
        resolve(pipe);
      };

      this.timer = setTimeout(() => fail('timeout'), DIAL_MS);

      let pc: RTCPeerConnection;
      try {
        pc = new RTCPeerConnection({iceServers: this.iceServers});
      } catch (err) {
        fail('no-webrtc');
        return;
      }
      this.pc = pc;

      const dc = pc.createDataChannel('cyc', {ordered: true, negotiated: true, id: 0});
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => {
        cyclog('rtc.dc.open', {id: this.id, pc: pc.connectionState, ice: pc.iceConnectionState});
        void logSelectedPair(pc, this.id);
        succeed(dcPipe(dc as unknown as any, pc as unknown as any));
      };
      dc.onerror = (e: any) =>
        cyclog('rtc.dc.error', {id: this.id, err: String(e?.error?.message ?? e?.message ?? e)});
      dc.onclose = () => cyclog('rtc.dc.close', {id: this.id, opened: this.opened});

      let inbound: MediaStreamTrack | null = null;
      const inboundCbs: Array<(t: MediaStreamTrack) => void> = [];
      if (
        this.withAudio &&
        typeof (pc as {addTransceiver?: unknown}).addTransceiver === 'function'
      ) {
        let sender: RTCRtpSender | null = null;
        try {
          const tx = pc.addTransceiver('audio', {direction: 'sendrecv'});
          sender = tx.sender;
        } catch {}
        try {
          pc.ontrack = (e: RTCTrackEvent) => {
            const t = e.track;
            if (!t || t.kind !== 'audio') return;
            inbound = t;
            for (const cb of inboundCbs.splice(0)) cb(t);
          };
        } catch {}
        this.audioChannel = {
          sender,
          inboundTrack: () => inbound,
          onInboundTrack: (cb) => {
            if (inbound) cb(inbound);
            else inboundCbs.push(cb);
          },
          localFp: () => fingerprintOfSdp(this.offerSdp),
          remoteFp: () => fingerprintOfSdp(this.answerSdp)
        };
      }

      pc.onicecandidate = (e) => {
        this.signal.send({
          t: 'rtc-cand',
          id: this.id,
          cand: e.candidate ? pick(e.candidate) : null
        });
      };

      pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        cyclog('rtc.ice', {id: this.id, state: st, opened: this.opened});
        if (!this.opened && (st === 'failed' || st === 'closed')) fail('ice-failed');
      };
      pc.onconnectionstatechange = () =>
        cyclog('rtc.pc', {id: this.id, state: pc.connectionState, opened: this.opened});

      this.signal.onframe = (m) => {
        if (m.t === 'rtc-answer') {
          this.answerSdp = typeof m.sdp === 'string' ? m.sdp : null;
          pc.setRemoteDescription({type: 'answer', sdp: m.sdp}).then(
            () => {
              this.remoteSet = true;
              for (const c of this.candQ) {
                try {
                  void pc.addIceCandidate(c ?? undefined);
                } catch {}
              }
              this.candQ = [];
            },
            () => fail('bad-answer')
          );
        } else if (m.t === 'rtc-cand') {
          const cand = m.cand ? (m.cand as RTCIceCandidateInit) : null;

          if (this.remoteSet) {
            try {
              void pc.addIceCandidate(cand ?? undefined);
            } catch {}
          } else this.candQ.push(cand);
        } else if (m.t === 'rtc-fail') {
          fail(typeof m.reason === 'string' ? m.reason : 'rtc-fail');
        }
      };

      this.signal.onclose = (code) => {
        if (!this.opened) fail('signal-closed');
      };

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          this.offerSdp = pc.localDescription!.sdp;
          this.signal.send({t: 'rtc-offer', id: this.id, sdp: pc.localDescription!.sdp});
        })
        .catch(() => fail('offer-failed'));
    });
  }

  close(reason: string): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      this.pipe?.close(4000, reason);
    } catch {}
    try {
      this.pc?.close();
    } catch {}
    try {
      this.signal.close(1000, reason);
    } catch {}
  }
}
