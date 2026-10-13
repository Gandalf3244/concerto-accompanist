// Microphone front end: finds note onsets in the piano's sound and, for each,
// how much of the newly sounding energy lies at the harmonics of any pitch.
// We do not try to transcribe the music: AudioFollower weighs that evidence
// for the chords of the score near where the player may be.
// (Grown from accomp/audio.py; this is now the reference version.)

const HOP = 256;   // 5.3 ms at 48 kHz
const WIN = 4096;  // 85 ms analysis window (needed to resolve low notes)
const SWIN = 1024; // 21 ms window for onset timing
const N_HARM = 8;
const FLOOR_RISE = 2 ** (HOP / 48000 / 2); // the noise floor may rise ~3 dB a second
const RANGE = 1e-3;                     // onsets are judged within 60 dB of the loudest sound

const midiHz = p => 440.0 * 2 ** ((p - 69) / 12.0);

function hanning(n) { // numpy.hanning
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

function median(a) { // numpy.median
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

// |rfft(x)| for power-of-two n (iterative radix-2)
class RealFFT {
  constructor(n) {
    this.n = n;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = -Math.sin(2 * Math.PI * i / n); }
  }

  magnitude(x, out) {
    const { n, re, im, rev } = this;
    for (let i = 0; i < n; i++) { re[rev[i]] = x[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], si = this.sin[k * step];
          const a = s + k, b = a + half;
          const tr = re[b] * c - im[b] * si, ti = re[b] * si + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
    return out;
  }
}

// Tells the orchestra, as the app plays it through the phone's speaker, from
// the player in what the microphone hears. We know the exact signal sent to
// the speaker (the reference); the microphone gets it some milliseconds later
// (estimated by cross-correlating the energy rises of both) and coloured by
// the speaker and room (a gain per frequency band, tracked as the low
// envelope of microphone/reference: the player only ever adds to it). That
// gives, for every moment, the spectrum the orchestra alone would make at the
// microphone (spread a little in time and frequency, to be safe). Rather than
// subtracting it (which leaves flickering residue that looks like onsets), the
// onset function only counts rises above it, and an onset's new sound only
// counts what exceeds it.
const NBANDS = 24, MAX_LAG = 96, LAG_EVERY = 94, ENV_LEN = 1200;
class EchoSuppressor {
  constructor(sr, fft, sfft, window, swindow) {
    Object.assign(this, { sr, fft, sfft, window, swindow });
    this.ring = new Float64Array(1 << 16); // reference samples (aligned with the microphone's)
    this.mask = this.ring.length - 1;
    this.n = 0;
    this.delay = 8;      // hops from reference to microphone (until estimated)
    this.estimates = [];
    this.micEnv = []; this.refEnv = [];
    this.prevMic = 0; this.prevRef = 0;
    this.hops = 0;
    this.gain = new Float64Array(NBANDS).fill(NaN);
    this.peak = new Float64Array(NBANDS);
    this.band = f => Math.max(0, Math.min(NBANDS - 1, Math.floor(NBANDS * Math.log(Math.max(f, 60) / 60) / Math.log(sr / 2 / 60))));
    this.sband = Uint8Array.from({ length: SWIN / 2 + 1 }, (_, k) => this.band(k * sr / SWIN));
    this.lband = Uint8Array.from({ length: WIN / 2 + 1 }, (_, k) => this.band(k * sr / WIN));
    this.short = []; this.long = []; // the last 3 delayed reference spectra
    this.tmp = new Float64Array(WIN);
    this.stmp = new Float64Array(SWIN);
  }

  // one hop of microphone and reference samples, already in step
  hop(mic, ref) {
    for (let i = 0; i < ref.length; i++) this.ring[(this.n + i) & this.mask] = ref[i];
    this.n += ref.length;
    let em = 1e-12, er = 1e-12;
    for (let i = 0; i < mic.length; i++) { em += mic[i] * mic[i]; er += ref[i] * ref[i]; }
    const lm = Math.log(em), lr = Math.log(er);
    this.micEnv.push(Math.max(0, lm - this.prevMic)); this.refEnv.push(Math.max(0, lr - this.prevRef));
    this.prevMic = lm; this.prevRef = lr;
    if (this.micEnv.length > ENV_LEN) { this.micEnv.shift(); this.refEnv.shift(); }
    if (++this.hops % LAG_EVERY === 0 && this.micEnv.length === ENV_LEN) this.estimateDelay();
    // the reference as the microphone hears it now
    const end = this.n - this.delay * HOP;
    for (let i = 0; i < WIN; i++) this.tmp[i] = this.ring[(end - WIN + i) & this.mask] * this.window[i];
    for (let i = 0; i < SWIN; i++) this.stmp[i] = this.ring[(end - SWIN + i) & this.mask] * this.swindow[i];
    this.long.push(this.fft.magnitude(this.tmp, new Float64Array(WIN / 2 + 1)));
    this.short.push(this.sfft.magnitude(this.stmp, new Float64Array(SWIN / 2 + 1)));
    if (this.long.length > 3) { this.long.shift(); this.short.shift(); }
  }

  estimateDelay() {
    const m = this.micEnv, r = this.refEnv, n = m.length;
    let rr = 0, mm = 0;
    for (let i = 0; i < n; i++) { rr += r[i] * r[i]; mm += m[i] * m[i]; }
    if (rr < 1e-6 || mm < 1e-6) return; // the orchestra (or the microphone) is silent
    const corr = [];
    for (let lag = 0; lag <= MAX_LAG; lag++) {
      let c = 0;
      for (let i = lag; i < n; i++) c += m[i] * r[i - lag];
      corr.push(c / Math.sqrt(rr * mm));
    }
    let best = 0;
    for (let lag = 1; lag <= MAX_LAG; lag++) if (corr[lag] > corr[best]) best = lag;
    if (corr[best] < 0.1 || corr[best] < 2 * median(corr)) return;
    this.estimates.push(best);
    if (this.estimates.length > 5) this.estimates.shift();
    this.delay = Math.round(median(this.estimates));
  }

  // learn the speaker+room gain per band from the microphone's short spectrum
  learn(smag) {
    const ref = this.short[this.short.length - 1];
    const R = new Float64Array(NBANDS), M = new Float64Array(NBANDS);
    for (let k = 0; k < smag.length; k++) { R[this.sband[k]] += ref[k] * ref[k]; M[this.sband[k]] += smag[k] * smag[k]; }
    for (let b = 0; b < NBANDS; b++) {
      this.peak[b] = Math.max(R[b], this.peak[b] * 0.9999);
      if (R[b] < 1e-12 || R[b] < 1e-4 * this.peak[b]) continue;
      const g = Math.sqrt(M[b] / R[b]);
      if (Number.isNaN(this.gain[b])) this.gain[b] = g;
      else this.gain[b] += (g < this.gain[b] ? 0.2 : 0.005) * (g - this.gain[b]);
    }
  }

  // what the orchestra alone would make at the microphone (short or long spectrum)
  predict(long) {
    const refs = long ? this.long : this.short, band = long ? this.lband : this.sband;
    const n = refs[0].length;
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const g = this.gain[band[k]];
      if (Number.isNaN(g)) continue;
      let r = 0;
      for (const s of refs) for (let j = Math.max(0, k - 1); j <= Math.min(n - 1, k + 1); j++) r = Math.max(r, s[j]);
      out[k] = 1.5 * g * r;
    }
    return out;
  }
}

export class AudioFrontEnd {
  constructor(sr = 48000, { delayFrames = 6, alpha = 0.4 } = {}) {
    this.sr = sr;
    this.buf = new Float64Array(WIN);
    this.window = hanning(WIN);
    this.fft = new RealFFT(WIN);
    this.sfft = new RealFFT(SWIN);
    this.flux = [];        // recent onset-function values
    this.magHist = [];     // recent magnitude spectra (for "before" energy)
    this.pending = [];     // onsets waiting for their spectrum to settle
    this.delayFrames = delayFrames; // frames after an onset at which its spectrum is taken
    this.alpha = alpha;    // onset threshold above the recent average, relative to the onset function's median
    this.minFlux = 0.5;
    this.lastOnsetFrame = -1e9;
    this.frame = 0;
    this.prevSlog = null;
    this.swindow = hanning(SWIN);
    this.sfluxWeight = new Float64Array(SWIN / 2 + 1);
    for (let i = 0; i <= SWIN / 2; i++) this.sfluxWeight[i] = Math.min(1.0, Math.max(0.2, (i * sr / SWIN) / 2000.0));
    this.energyHist = [];
    this.peakEnergy = 1e-9;
    this.queue = new Float64Array(0); // samples not yet making up a full hop
    this.refQueue = new Float64Array(0);
    this.echo = null;     // EchoSuppressor, once a reference is given
    this.tmp = new Float64Array(WIN);
    this.stmp = new Float64Array(SWIN);
    this.smooth = null;   // short spectrum, smoothed over ~50 ms
    this.floor = null;    // its per-bin noise floor
    this.peakMag = 1e-9;  // running peak of the mean short-spectrum magnitude
  }

  // Onset-function spectrum, independent of the input level and of steady
  // background noise: the noise floor is subtracted per bin (a slowly rising
  // minimum of the smoothed spectrum), and the rest is log-compressed relative
  // to that floor (or to 60 dB below the loudest sound, if quieter).
  compress(smag) {
    const n = smag.length;
    if (!this.smooth) { this.smooth = Float64Array.from(smag); this.floor = Float64Array.from(smag); }
    let mean = 0, floorMean = 0;
    for (let i = 0; i < n; i++) {
      this.smooth[i] += 0.1 * (smag[i] - this.smooth[i]);
      this.floor[i] = this.smooth[i] < this.floor[i] ? this.smooth[i] : this.floor[i] * FLOOR_RISE;
      mean += smag[i]; floorMean += this.floor[i];
    }
    mean /= n; floorMean /= n;
    this.peakMag = Math.max(mean, this.peakMag * 0.99995);
    const gamma = 1 / Math.max(4 * floorMean, RANGE * this.peakMag, 1e-12);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.log1p(gamma * Math.max(0, smag[i] - 2 * this.floor[i]));
    return out;
  }

  // a magnitude spectrum on the onset function's scale (as compress, without
  // updating the floor)
  compressLike(mag) {
    let floorMean = 0;
    for (let i = 0; i < mag.length; i++) floorMean += this.floor[i];
    floorMean /= mag.length;
    const gamma = 1 / Math.max(4 * floorMean, RANGE * this.peakMag, 1e-12);
    const out = new Float64Array(mag.length);
    for (let i = 0; i < mag.length; i++) out[i] = Math.log1p(gamma * Math.max(0, mag[i] - 2 * this.floor[i]));
    return out;
  }

  harmonicEnergy(mag, pitch) {
    const f0 = midiHz(pitch);
    let e = 0.0;
    for (let h = 1; h <= N_HARM; h++) {
      const f = f0 * h;
      if (f > this.sr / 2 - 200) break;
      const k = Math.round(f * WIN / this.sr);
      let m = 0;
      for (let i = Math.max(0, k - 1); i < k + 2 && i < mag.length; i++) m = Math.max(m, mag[i]);
      e += m / Math.sqrt(h);
    }
    return e;
  }

  // Feed audio (mono floats) ending at time tBlockEnd, and optionally what
  // the app sent to the speaker over the same time (ref, same length).
  // Returns the onsets found, as {t, sal}: sal(p) is the share of the new
  // sound at pitch p.
  process(block, tBlockEnd, ref = null) {
    const out = [];
    const all = new Float64Array(this.queue.length + block.length);
    all.set(this.queue); all.set(block, this.queue.length);
    let allRef = null;
    if (ref) {
      this.echo ??= new EchoSuppressor(this.sr, this.fft, this.sfft, this.window, this.swindow);
      allRef = new Float64Array(this.refQueue.length + ref.length);
      allRef.set(this.refQueue); allRef.set(ref, this.refQueue.length);
    }
    const n = all.length;
    let pos = 0;
    while (n - pos >= HOP) {
      this.buf.copyWithin(0, HOP);
      this.buf.set(all.subarray(pos, pos + HOP), WIN - HOP);
      if (allRef) this.echo.hop(all.subarray(pos, pos + HOP), allRef.subarray(pos, pos + HOP));
      pos += HOP;
      this.frame += 1;
      const t = tBlockEnd - (n - pos) / this.sr;
      for (let i = 0; i < WIN; i++) this.tmp[i] = this.buf[i] * this.window[i];
      const mag = this.fft.magnitude(this.tmp, new Float64Array(WIN / 2 + 1));
      // onsets from a short window (sharp in time)
      for (let i = 0; i < SWIN; i++) this.stmp[i] = this.buf[WIN - SWIN + i] * this.swindow[i];
      const smag = this.sfft.magnitude(this.stmp, new Float64Array(SWIN / 2 + 1));
      const slog = this.compress(smag);
      // the orchestra's own sound at the microphone, if we know it
      let spred = null, lpred = null;
      if (allRef) {
        this.echo.learn(smag);
        spred = this.compressLike(this.echo.predict(false));
        lpred = this.echo.predict(true);
      }
      if (this.prevSlog !== null) {
        let flux = 0, energy = 0;
        for (let i = 0; i < slog.length; i++) {
          const base = spred ? Math.max(this.prevSlog[i], spred[i]) : this.prevSlog[i];
          flux += Math.max(0.0, slog[i] - base) * this.sfluxWeight[i];
          energy += smag[i] * smag[i];
        }
        this.peakEnergy = Math.max(energy, this.peakEnergy * 0.9995);
        this.pick(flux, energy, t);
      }
      this.prevSlog = slog;
      this.magHist.push(mag); if (this.magHist.length > 12) this.magHist.shift();
      while (this.pending.length && this.pending[0][0] <= this.frame) {
        const [, tOn, before] = this.pending.shift();
        out.push(this.onsetEvidence(mag, before, tOn, lpred));
      }
    }
    this.queue = all.slice(pos);
    if (allRef) this.refQueue = allRef.slice(pos);
    return out;
  }

  // Onsets are peaks of the onset function: the highest value within the
  // last PRE_MAX frames and the next POST frames (so a decision waits POST
  // frames), clearly above the average of the preceding PRE_AVG frames, and
  // at least COMBINE frames after the previous onset.
  pick(flux, energy, t) {
    const PRE_MAX = 6, POST = 2, PRE_AVG = 19, COMBINE = 6;
    const h = this.flux, eh = this.energyHist;
    h.push(flux); eh.push(energy);
    if (h.length > 200) { h.shift(); eh.shift(); }
    const c = h.length - 1 - POST; // the frame being decided
    if (c < PRE_AVG) return;
    const v = h[c];
    for (let j = c - PRE_MAX; j <= c + POST; j++) if (h[j] > v || (j < c && h[j] === v)) return;
    let mean = 0;
    for (let j = c - PRE_AVG; j < c; j++) mean += h[j];
    mean /= PRE_AVG;
    const delta = Math.max(this.minFlux, this.alpha * median(h));
    const frame = this.frame - POST;
    if (v < mean + delta || frame - this.lastOnsetFrame < COMBINE || eh[c] < 0.01 * this.peakEnergy) return;
    this.lastOnsetFrame = frame;
    const tc = t - POST * HOP / this.sr;
    const before = this.magHist.length >= 6 + POST ? this.magHist[this.magHist.length - 6 - POST] : new Float64Array(this.magHist[0].length);
    // the flux peak is about one hop after the attack entered the short window
    this.pending.push([frame + this.delayFrames, tc - 1.5 * HOP / this.sr, before]);
  }

  // The new sound at an onset: what the spectrum gained since just before
  // (and beyond what the orchestra alone would make, if we know that).
  onsetEvidence(after, before, tOn, orch = null) {
    const fresh = new Float64Array(after.length);
    let tot = 0;
    for (let i = 0; i < after.length; i++) {
      const base = orch ? Math.max(1.2 * before[i], orch[i]) : 1.2 * before[i];
      fresh[i] = Math.max(0.0, after[i] - base);
      tot += fresh[i] * fresh[i];
    }
    const total = Math.sqrt(tot) + 1e-9;
    if (this.onOnset) this.onOnset(fresh, total, tOn); // for analysis (tests/web/evidence.mjs)
    const cache = new Map();
    const sal = p => {
      if (!cache.has(p)) cache.set(p, this.harmonicEnergy(fresh, p) / total);
      return cache.get(p);
    };
    return { t: tOn, sal };
  }
}
