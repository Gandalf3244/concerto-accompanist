// Orchestra sound: plays notes from the sample files made by tools/build_web.py.
// Each instrument file holds one note every few semitones in fixed slots;
// other pitches are the nearest sample sped up or slowed down, and held notes
// loop over a crossfaded stretch of their sustain.

const SHORT = 0.35; // s; notes shorter than this get the fast attack
const RELEASE = { violins1: 0.18, violins2: 0.18, violas: 0.18, celli: 0.2, basses: 0.22, tremolo: 0.18, timpani: 0.8, piano: 0.5, drums: 0.6 }; // s; others 0.1

export class Sampler {
  // normalize: bring every sample to one perceived level (index.json "level"),
  // so the balance between instruments is set by the score's balance gains
  constructor(ctx, { reverb = true, normalize = true } = {}) {
    this.ctx = ctx;
    this.normalize = normalize;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    // a little hall: a synthetic impulse response (decaying noise); without
    // it if the browser will not make one
    const sr = ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
    try {
      const len = Math.floor(sr * 2.2);
      const ir = ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.45));
      }
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = ir;
    } catch (e) {
      reverb = false;
    }
    const wet = ctx.createGain();
    wet.gain.value = 0.12;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -10;
    this.comp.knee.value = 10;
    this.comp.ratio.value = 4;
    this.out.connect(this.comp);
    if (reverb) this.out.connect(this.reverb).connect(wet).connect(this.comp);
    this.comp.connect(ctx.destination);
    this.output = this.comp; // the final mix, as sent to the speaker
    this.sets = {};
    this.voices = new Set();
  }

  setVolume(v) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }

  async load(base, onProgress = () => {}) {
    return this.decode(await prefetchSamples(base), onProgress);
  }

  // decode samples fetched by prefetchSamples (each only once: decoding uses up the bytes)
  async decode({ index, bytes: all }, onProgress = () => {}) {
    this.refLevel = index.ref_level ?? 0; // dB (A-weighted) every sample is brought to, when normalizing
    const names = Object.keys(index.sets);
    let done = 0;
    await Promise.all(names.map(async name => {
      const s = index.sets[name];
      const bytes = all[name];
      const buffer = await new Promise((ok, fail) => this.ctx.decodeAudioData(bytes, ok, fail));
      const data = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      // where each note really starts (decoders may shift the audio a little)
      const onsets = s.pitches.map((_, k) => {
        const a = Math.floor(k * index.slot * sr), b = Math.min(data.length, Math.floor((k * index.slot + index.pad + 0.2) * sr));
        for (let i = a; i < b; i++) if (Math.abs(data[i]) > 1e-3) return Math.max(a, i - 16) / sr;
        return k * index.slot + index.pad;
      });
      const attack = s.attack && Object.fromEntries(["short", "long"].map(k => [k, s.attack[k].map(c => Float32Array.from(c))]));
      this.sets[name] = { buffer, pitches: s.pitches, onsets, loop: s.loop, slot: index.slot, pad: index.pad,
                          loopPts: index.loop, attack, step: s.attack?.step, level: s.level };
      onProgress(++done / names.length);
    }));
  }

  get loaded() { return Object.keys(this.sets).length > 0; }

  // play `pitch` from sample set `name` at context time `when` for `dur` seconds
  // artic: "legato" (continuing a slur: no new attack, runs into the next
  // note), "stacc" (short), else détaché (a clean start, a breath before the next)
  play(name, pitch, velocity, when, dur, gain = 1, artic = null) {
    if (this.legacy) { artic = "legacy"; dur *= 0.95; } // the earlier shaping (for comparisons)
    else if (artic === "legato") dur = dur + 0.06;
    else if (artic === "stacc") dur = Math.min(Math.max(dur * 0.7, Math.min(dur, 0.12)), 0.4); // shorter, still sung
    else dur = dur * 0.97; // separate bows, hardly a gap
    const s = this.sets[name];
    if (!s) return;
    let k = 0;
    for (let i = 1; i < s.pitches.length; i++) if (Math.abs(s.pitches[i] - pitch) < Math.abs(s.pitches[k] - pitch)) k = i;
    const rate = 2 ** ((pitch - s.pitches[k]) / 12);
    const on = s.onsets[k];
    const src = new AudioBufferSourceNode(this.ctx, { buffer: s.buffer, playbackRate: rate });
    const held = s.slot - s.pad - 0.12; // seconds of sound in the slot after its onset
    if (s.loop) {
      src.loop = true;
      src.loopStart = on + s.loopPts[0];
      src.loopEnd = on + s.loopPts[1];
    }
    const g = new GainNode(this.ctx, { gain: 0 });
    // the sample's own loudness taken out (to REF_LEVEL), if measured
    const norm = this.normalize && s.level ? 10 ** ((this.refLevel - s.level[k]) / 20) : 1;
    const amp = Math.min(1.6, (velocity / 100) ** 2) * gain * Math.min(4, norm);
    const start = Math.max(when, this.ctx.currentTime);
    if (s.attack) {
      // bring a slowly swelling sample (bowed strings) to its level quickly:
      // within 15 ms for short notes, 60 ms for long ones
      // how quickly the note speaks: fast notes crisply, medium ones gently,
      // long and legato ones with the instrument's own swell (a sung line)
      const kind = artic === "legacy" ? (dur < 0.35 ? "short" : "long")
        : artic === "legato" ? (dur < 0.25 ? "long" : null)
        : dur < 0.2 || artic === "stacc" ? "short" : dur < 0.6 ? "long" : null;
      if (kind) {
        const curve = s.attack[kind][k];
        const a = new GainNode(this.ctx, { gain: curve[0] });
        a.gain.setValueCurveAtTime(curve, start, curve.length * s.step / rate);
        src.connect(a).connect(g).connect(this.out);
      } else {
        src.connect(g).connect(this.out);
      }
    } else {
      src.connect(g).connect(this.out);
    }
    g.gain.setValueAtTime(amp, start);
    const rel = (RELEASE[name] ?? 0.1) * (artic === "legato" ? 1.6 : 1);
    const natural = s.loop ? Infinity : held / rate;
    const end = start + Math.min(Math.max(dur, 0.03), natural);
    g.gain.setTargetAtTime(0, end, rel / 4);
    src.start(start, on);
    src.stop(Math.min(end + rel * 1.5, start + natural + 0.01));
    const v = { src, g };
    this.voices.add(v);
    src.onended = () => { this.voices.delete(v); g.disconnect(); };
    return v;
  }

  // end a note early (e.g. a key released)
  release(v, rel = 0.3) {
    if (!v || !this.voices.has(v)) return;
    const t = this.ctx.currentTime;
    v.g.gain.cancelScheduledValues(t);
    v.g.gain.setTargetAtTime(0, t, rel / 4);
    try { v.src.stop(t + rel * 1.5); } catch (e) { /* already stopped */ }
  }

  stopAll() {
    const t = this.ctx.currentTime;
    for (const { src, g } of this.voices) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, 0.03);
      try { src.stop(t + 0.15); } catch (e) { /* already stopped */ }
    }
  }
}

// Download the sample files (no audio context needed yet: iOS wants that made
// when the player taps Play).
export async function prefetchSamples(base, onProgress = () => {}) {
  const index = await (await fetch(base + "samples/index.json")).json();
  const names = Object.keys(index.sets);
  const bytes = {};
  let done = 0;
  await Promise.all(names.map(async name => {
    const r = await fetch(base + index.sets[name].file);
    if (!r.ok) throw new Error(`could not download ${index.sets[name].file} (${r.status})`);
    bytes[name] = await r.arrayBuffer();
    onProgress(++done / names.length);
  }));
  return { index, bytes };
}
