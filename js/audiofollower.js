// Score follower for microphone input.
//
// A MIDI note says exactly which key was played; a microphone onset only
// gives a spectrum of what just started sounding, some onsets are missed and
// some are spurious, and repetitive figuration makes many chords look alike.
// Deciding greedily onset by onset is fragile there: one match a little ahead
// moves the expectation ahead, and the follower walks away from the player.
//
// So we keep several hypotheses at once (a Viterbi search over the piano
// part's chords, each hypothesis with its own timing and tempo): each onset
// either extends a hypothesis to a later chord (scored by how well the new
// sound fits that chord, how well its time fits the hypothesis's tempo, and
// how many chords it passes over) or is taken as spurious. The best
// hypothesis gives the position; a wrong one loses out as soon as the
// evidence disagrees with it, and a jump anywhere nearby is always possible
// at a price, so the follower finds a player who skipped or restarted.
import { bisectLeft, bisectRight } from "./score.js";

// salience score of the right chord vs other chords -> log-likelihood ratio
// (measured on rendered performances, tests/web/evidence.mjs)
const LLR_PTS = [[0, -5], [0.15, -3], [0.3, -2.2], [0.45, -0.5], [0.6, 1.2], [0.8, 2.2], [1.0, 2.6]];

export const PARAMS = {
  skip: 1.0,       // per chord passed over (an onset the microphone missed)
  maxSkip: 6,      // chords an onset may pass over
  spurious: 2.0,   // an onset that is no chord (noise, the orchestra, a double trigger)
  jump: 12.0,      // starting over somewhere else nearby (the player skipped or restarted)
  jumpReach: 32,   // beats
  sigma0: 0.04,    // s of timing noise
  kTempo: 0.15,    // timing uncertainty per second since the hypothesis's last chord...
  kNoTempo: 0.3,   // ...while its tempo is still unknown
  tempoGain: 0.3,  // how fast a hypothesis's tempo follows what it sees
  prune: 15.0,     // hypotheses this much worse than the best are dropped
  maxStates: 64,
  firstAhead: 8,   // beats searched for the very first chord
};

export function llr(s) {
  if (s <= LLR_PTS[0][0]) return LLR_PTS[0][1];
  for (let i = 1; i < LLR_PTS.length; i++) {
    const [x1, y1] = LLR_PTS[i];
    if (s <= x1) {
      const [x0, y0] = LLR_PTS[i - 1];
      return y0 + (y1 - y0) * (s - x0) / (x1 - x0);
    }
  }
  return LLR_PTS[LLR_PTS.length - 1][1];
}

export class AudioFollower {
  constructor(score, startBeat = 0.0, bpm = null) {
    this.score = score;
    this.chords = score.chords;
    this.beats = this.chords.map(c => c.beat);
    score.reset();
    this.lastIdx = bisectLeft(this.beats, startBeat) - 1;
    this.lastBeat = startBeat;
    this.lastTime = null;
    this.spb = 60.0 / (bpm || score.nominalBpm(startBeat));
    this.anchor = [startBeat, null];
    this.own = this.anchor; // the anchor as we last set it (the engine replaces it while the orchestra plays alone)
    this.states = [];       // {idx, beat, t, spb, n, score}
    this.missStreak = 0;
  }

  position(t) {
    const [b0, t0] = this.anchor;
    if (t0 === null) return b0;
    return b0 + (t - t0) / this.spb;
  }

  tempoBpm() { return 60.0 / this.spb; }

  // How well chord c explains an onset: sal(p) is the share of the new sound
  // at the harmonics of pitch p.
  static evidence(c, sal) {
    let s = 0;
    for (const p of c.pitches) s += sal(p);
    return llr(s / Math.sqrt(c.pitches.size));
  }

  // The orchestra played alone and the engine has been moving our anchor:
  // start again from there, at the orchestra's tempo.
  reseed() {
    const [b, t] = this.anchor;
    this.states = [{ idx: bisectLeft(this.beats, b - 1) - 1, beat: b, t, spb: this.spb, n: 4, score: 0 }];
    this.own = this.anchor;
  }

  // Feed one onset. Returns the beat of the chord it was matched to, or null.
  onOnset(sal, t) {
    const P = PARAMS;
    const evc = new Map();
    const ev = j => {
      if (!evc.has(j)) evc.set(j, AudioFollower.evidence(this.chords[j], sal));
      return evc.get(j);
    };
    if (this.lastTime === null && !this.states.length) return this.first(ev, t);
    if (this.anchor !== this.own && this.anchor[1] !== null) this.reseed();
    const next = new Map(); // idx -> best new state there
    const offer = s => {
      const cur = next.get(s.idx);
      if (!cur || s.score > cur.score) next.set(s.idx, s);
    };
    let best = null;
    for (const s of this.states) {
      if (!best || s.score > best.score) best = s;
      // the onset is no chord of ours
      offer({ ...s, score: s.score - P.spurious, stay: true });
      // or the next chord, or one a little later (onsets in between missed)
      const dt = Math.max(0, t - s.t);
      const pred = s.beat + dt / s.spb;
      const sigma = (P.sigma0 + (s.n >= 4 ? P.kTempo : P.kNoTempo) * dt) / s.spb; // in beats
      const hi = Math.min(this.chords.length, s.idx + 2 + P.maxSkip);
      for (let j = s.idx + 1; j < hi; j++) {
        const b = this.beats[j];
        if (b <= s.beat - 1e-9) continue;
        const z = (b - pred) / sigma;
        if (z > 4) break;
        if (z < -4) continue;
        const score = s.score - 0.5 * z * z - P.skip * (j - s.idx - 1) + ev(j);
        let spb = s.spb;
        const db = b - s.beat;
        if (db >= 0.2 && dt > 0) {
          const nominal = 60.0 / this.score.nominalBpm(b);
          const seen = Math.min(Math.max(dt / db, 0.5 * nominal), 2.0 * nominal);
          spb += (s.n < 4 ? 1 / (s.n + 1) : P.tempoGain) * (seen - spb);
        }
        offer({ idx: j, beat: b, t, spb, n: s.n + 1, score });
      }
    }
    // or the player is somewhere else nearby
    if (best) {
      const here = best.beat + Math.max(0, t - best.t) / best.spb;
      const lo = bisectLeft(this.beats, here - P.jumpReach), hi = bisectRight(this.beats, here + P.jumpReach);
      for (let j = lo; j < hi; j++) {
        const e = ev(j);
        if (e > 0) offer({ idx: j, beat: this.beats[j], t, spb: best.spb, n: 0, score: best.score - P.jump + e });
      }
    }
    this.keep([...next.values()]);
    return this.publish(t);
  }

  // The very first onset: any chord from the start point to firstAhead beats on.
  first(ev, t) {
    const lo = bisectLeft(this.beats, this.lastBeat - 0.01);
    const hi = bisectRight(this.beats, this.lastBeat + PARAMS.firstAhead);
    const states = [];
    for (let j = lo; j < hi; j++) {
      const e = ev(j);
      if (e > 0) states.push({ idx: j, beat: this.beats[j], t, spb: this.spb, n: 0, score: e - 0.15 * (this.beats[j] - this.lastBeat) });
    }
    if (!states.length) return null;
    this.keep(states);
    return this.publish(t);
  }

  keep(states) {
    states.sort((a, b) => b.score - a.score);
    const top = states[0].score;
    this.states = states.filter(s => s.score >= top - PARAMS.prune).slice(0, PARAMS.maxStates)
      .map(s => ({ ...s, score: s.score - top, stay: false }));
    this.bestStayed = states[0].stay;
  }

  // Report the best hypothesis as the follower's position and tempo.
  publish(t) {
    const s = this.states[0];
    if (this.bestStayed) this.missStreak++; else this.missStreak = 0;
    if (s.idx < 0) return null;
    const moved = s.idx !== this.lastIdx || s.t !== this.lastTime;
    this.lastIdx = s.idx;
    this.lastBeat = s.beat;
    this.lastTime = s.t;
    this.spb = s.spb;
    this.anchor = [s.beat, s.t];
    this.own = this.anchor;
    if (!moved || this.bestStayed) return null;
    this.chords[s.idx].matched = new Set(this.chords[s.idx].pitches);
    return s.beat;
  }
}
