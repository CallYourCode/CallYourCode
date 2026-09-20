
var wsolaStretch = (function wsolaStretch(channels, sampleRate, tempo) {
  var C = channels.length;
  var N = C ? channels[0].length : 0;
  if (tempo === 1 || N === 0) {
    var same = [];
    for (var c = 0; c < C; c++) same.push(channels[c].slice());
    return same;
  }
  var win = Math.round(sampleRate * 0.03);
  if (win < 128) win = 128;
  if (win % 2) win++;
  var Hs = win >> 1;
  var tol = Math.round(sampleRate * 0.01);
  var Ha = Hs * tempo;
  var hann = new Float32Array(win);
  for (var i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1));
  var mono = channels[0];
  if (C > 1) {
    mono = new Float32Array(N);
    for (var c = 0; c < C; c++) {
      var ch = channels[c];
      for (var i = 0; i < N; i++) mono[i] += ch[i];
    }
  }
  var outLen = Math.round(N / tempo) + win;
  if (outLen < win) outLen = win;
  var out = [];
  for (var c = 0; c < C; c++) out.push(new Float32Array(outLen));
  var idealPos = 0;
  var grainStart = 0;
  var outPos = 0;
  while (grainStart + win <= N && outPos + win <= outLen) {
    for (var c = 0; c < C; c++) {
      var src = channels[c], dst = out[c];
      for (var i = 0; i < win; i++) dst[outPos + i] += src[grainStart + i] * hann[i];
    }
    outPos += Hs;
    idealPos += Ha;
    var base = Math.round(idealPos);
    if (base + win > N) break;
    var natStart = grainStart + Hs;
    var L = Hs;
    var dLo = -tol, dHi = tol;
    if (base + dLo < 0) dLo = -base;
    if (base + dHi + L > N) dHi = N - L - base;
    var best = -Infinity, bestDelta = 0;
    for (var d = dLo; d <= dHi; d++) {
      var cand = base + d;
      var cc = 0;
      for (var i = 0; i < L; i++) cc += mono[natStart + i] * mono[cand + i];
      if (cc > best) {
        best = cc;
        bestDelta = d;
      }
    }
    grainStart = base + bestDelta;
    if (grainStart < 0) grainStart = 0;
  }
  var finalLen = outPos + win;
  if (finalLen > outLen) finalLen = outLen;
  for (var c = 0; c < C; c++) out[c] = out[c].subarray(0, finalLen);
  return out;
});
class CycWsola extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = null;
    this.sr = sampleRate;
    this.stretched = null;
    this.stTempo = 0;
    this.pos = 0;
    this.playing = false;
    this.gen = 0;
    this.announced = true;
    this.port.onmessage = (e) => {
      var m = e.data;
      if(!m) return;
      if(m.type === 'load') {
        this.channels = m.channels;
        this.sr = m.sampleRate;
        this.stretched = null;
        this.stTempo = 0;
      } else if(m.type === 'prewarm') {
        this.prewarm(m.tempo);
      } else if(m.type === 'start') {
        this.start(m.offset, m.tempo, m.gen);
      } else if(m.type === 'stop') {
        this.playing = false;
      }
    };
  }
  prewarm(tempo) {
    if(!this.channels) return;
    if(this.stretched && this.stTempo === tempo) return;
    this.stretched = wsolaStretch(this.channels, this.sr, tempo);
    this.stTempo = tempo;
  }
  start(offsetSec, tempo, gen) {
    if(!this.channels) return;
    if(!this.stretched || this.stTempo !== tempo) {
      this.stretched = wsolaStretch(this.channels, this.sr, tempo);
      this.stTempo = tempo;
    }
    var len = this.stretched[0] ? this.stretched[0].length : 0;
    var idx = Math.round((Math.max(0, offsetSec) * this.sr) / tempo);
    if(idx < 0) idx = 0;
    if(idx > len) idx = len;
    this.pos = idx;
    this.gen = gen;
    this.playing = true;
    this.announced = false;
  }
  process(inputs, outputs) {
    var out = outputs[0];
    if(!this.playing || !this.stretched) return true;
    var frames = out[0].length;
    var len = this.stretched[0].length;
    var C = this.stretched.length;
    if(!this.announced && this.pos < len) {
      this.announced = true;
      this.port.postMessage({type: 'started', gen: this.gen});
    }
    for(var c = 0; c < out.length; c++) {
      var dst = out[c];
      var src = this.stretched[c < C ? c : C - 1];
      for(var i = 0; i < frames; i++) {
        var p = this.pos + i;
        dst[i] = p < len ? src[p] : 0;
      }
    }
    this.pos += frames;
    if(this.pos >= len) {
      this.playing = false;
      this.port.postMessage({type: 'ended', gen: this.gen});
    }
    return true;
  }
}
registerProcessor('cyc-wsola', CycWsola);
