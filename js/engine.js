// Follower + orchestra clock (port of accomp/clock.py and accomp/engine.py).
//
// The soloist leads while they are playing; during orchestra-only passages the
// orchestra leads, and the follower is slaved to the orchestra so it expects
// the soloist's next entrance at the orchestra's tempo.
import { bisectLeft } from "./score.js";
import { Follower } from "./follower.js";
import { AudioFollower } from "./audiofollower.js";

const SOLO_ACTIVE_BEATS = 1.5; // soloist counts as playing within this many beats of a piano note

// The orchestra's own clock: follows the soloist smoothly instead of jumping.
export class AccompClock {
  constructor(beat, bpm, tau = 0.6, maxAdjust = 0.35, jumpBeats = 1.5) {
    this.beat = beat;
    this.rate = bpm / 60.0; // beats per second
    this.t = null;
    this.tau = tau;
    this.maxAdjust = maxAdjust;
    this.jumpBeats = jumpBeats;
  }

  advance(t) {
    if (this.t !== null) this.beat += this.rate * (t - this.t);
    this.t = t;
    return this.beat;
  }

  // Move toward the follower's position/tempo; call often (e.g. every 5 ms).
  steer(t, targetBeat, targetRate) {
    this.advance(t);
    const err = targetBeat - this.beat;
    if (Math.abs(err) > this.jumpBeats) {
      this.beat = targetBeat;
      this.rate = targetRate;
      return;
    }
    let adj = err / this.tau / Math.max(targetRate, 1e-6); // fraction of tempo
    adj = Math.max(-this.maxAdjust, Math.min(this.maxAdjust, adj));
    this.rate = targetRate * (1.0 + adj);
  }

  // No soloist to follow: keep going at the current (or given) tempo.
  freeRun(t, rate = null) {
    this.advance(t);
    if (rate !== null) this.rate += 0.1 * (rate - this.rate);
  }
}

export class Engine {
  // audio: follow microphone onsets (onAudio) instead of MIDI notes (onNote)
  constructor(score, startBeat = 0.0, tempoScale = 1.0, audio = false) {
    this.score = score;
    this.tempoScale = tempoScale;
    const bpm = score.nominalBpm(startBeat) * tempoScale;
    this.follower = new (audio ? AudioFollower : Follower)(score, startBeat, bpm);
    this.clock = new AccompClock(startBeat, bpm);
    this.pianoBeats = score.chords.map(c => c.beat);
    this.orch = score.orchestra;
    this.orchBeats = this.orch.map(n => n.beat);
    this.nextOrch = bisectLeft(this.orchBeats, startBeat);
    this.started = false;
    this.sections = score.orchestraSections();
    // sections where the orchestra keeps the soloist's last tempo instead of its own
    this.keepTempo = new Set();
  }

  // index of the orchestra-only section containing beat, or -1
  sectionAt(beat) {
    return this.sections.findIndex(([a, b]) => a <= beat && beat < b);
  }

  soloistActive(beat) {
    const i = bisectLeft(this.pianoBeats, beat - SOLO_ACTIVE_BEATS);
    return i < this.pianoBeats.length && this.pianoBeats[i] <= beat + SOLO_ACTIVE_BEATS;
  }

  start(t) {
    this.started = true;
    this.clock.t = t;
    this.follower.anchor = [this.clock.beat, t];
  }

  onNote(pitch, t) { return this.onInput(t, () => this.follower.onNote(pitch, t)); }

  // a microphone onset: sal(p) = share of the new sound at pitch p (AudioFrontEnd)
  onAudio(sal, t) { return this.onInput(t, () => this.follower.onOnset(sal, t)); }

  onInput(t, feed) {
    const first = !this.started;
    if (first) this.start(t);
    const b = feed();
    if (first && b !== null) {
      // the soloist starts the piece: the orchestra starts where they are
      this.clock.beat = b;
      this.clock.t = t;
      this.nextOrch = bisectLeft(this.orchBeats, b - 1e-6);
    }
    return b;
  }

  // Advance to time t; return orchestra notes due, each with the time it is
  // due at. ahead > 0 also returns the notes due within the next `ahead`
  // seconds at the current tempo (so they can be scheduled precisely).
  tick(t, ahead = 0.0) {
    if (!this.started) return [];
    const f = this.follower;
    if (this.soloistActive(this.clock.beat) && f.lastTime !== null) {
      this.clock.steer(t, f.position(t), 1.0 / f.spb);
    } else {
      // the orchestra plays alone: its own tempo in an orchestra-only
      // passage, the soloist's last tempo in a short rest
      const s = this.sectionAt(this.clock.beat);
      const own = (s >= 0 && !this.keepTempo.has(s)) || f.lastTime === null;
      this.clock.freeRun(t, own ? this.score.nominalBpm(this.clock.beat) * this.tempoScale / 60.0 : null);
      // the soloist will come back in with the orchestra
      f.anchor = [this.clock.beat, t];
      f.timed = true;
      f.spb = 1.0 / this.clock.rate;
      if (f.lastBeat < this.clock.beat - 2) {
        f.lastBeat = this.clock.beat - 0.5;
        f.lastIdx = bisectLeft(this.pianoBeats, f.lastBeat) - 1;
      }
    }
    const due = [];
    const horizon = this.clock.beat + ahead * this.clock.rate;
    while (this.nextOrch < this.orch.length && this.orchBeats[this.nextOrch] <= horizon) {
      const n = this.orch[this.nextOrch];
      // after a jump, skip the backlog instead of firing it all at once
      if (n.beat >= this.clock.beat - 0.3) {
        due.push({ note: n, time: t + Math.max(0, n.beat - this.clock.beat) / Math.max(this.clock.rate, 1e-3) });
      }
      this.nextOrch += 1;
    }
    return due;
  }
}
