// Follower + orchestra clock (port of accomp/clock.py and accomp/engine.py).
//
// The soloist leads while they are playing; during orchestra-only passages the
// orchestra leads, and the follower is slaved to the orchestra so it expects
// the soloist's next entrance at the orchestra's tempo.
import { bisectLeft } from "./score.js";
import { Follower } from "./follower.js";
import { AudioFollower } from "./audiofollower.js";

const SOLO_ACTIVE_BEATS = 1.5; // soloist counts as playing within this many beats of a piano note
// Many passages sound alike, so the follower can briefly believe the player is
// somewhere else. The orchestra moves far (more than jumpBeats) only once the
// follower has stayed there: CONFIRM new matches over CONFIRM_S seconds, at a
// key spot (flexible bar, or no tempo plan) the KEY_ values.
const CONFIRM = 6, CONFIRM_S = 3.0, KEY_CONFIRM = 3, KEY_CONFIRM_S = 1.0;
// how far from the orchestra (beats) the follower expects the player, in a steady bar / at a key spot
const GUIDE_SIGMA = 1.5, KEY_GUIDE_SIGMA = 3.0;

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
  // tau / maxAdjust / jumpBeats may be given per call (a steadier orchestra).
  steer(t, targetBeat, targetRate, tau = this.tau, maxAdjust = this.maxAdjust, jumpBeats = this.jumpBeats) {
    this.advance(t);
    const err = targetBeat - this.beat;
    if (Math.abs(err) > jumpBeats) {
      this.beat = targetBeat;
      this.rate = targetRate;
      return;
    }
    let adj = err / tau / Math.max(targetRate, 1e-6); // fraction of tempo
    adj = Math.max(-maxAdjust, Math.min(maxAdjust, adj));
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
    this.plan = null; // tempo plan (setPlan): the orchestra keeps steady between its key spots
    this.skipped = 0; // orchestra notes passed over after a jump (for tests)
    this.away = null;  // the follower far from the orchestra: {err, n, seen, t0}
    // the follower is told where the orchestra is
    this.follower.guide = t => this.started && this.clock.t !== null
      ? { beat: this.clock.beat + this.clock.rate * (t - this.clock.t), sigma: this.keySpot() ? KEY_GUIDE_SIGMA : GUIDE_SIGMA }
      : null;
  }

  // a key spot: where the orchestra gives way to the soloist (rit., rubato, a new section), or no plan
  keySpot() { return !this.plan || this.planAt(this.clock.beat).flex; }

  // Steer the clock toward the follower (AccompClock.steer), but move far only
  // once the follower has stayed far: until then the orchestra keeps its course.
  follow(t, target, rate, tau, maxAdjust, jumpBeats) {
    this.clock.advance(t);
    const err = target - this.clock.beat;
    if (Math.abs(err) <= jumpBeats) {
      this.away = null;
      this.clock.steer(t, target, rate, tau, maxAdjust, Infinity);
      return;
    }
    const f = this.follower, key = this.keySpot();
    if (!this.away || Math.abs(err - this.away.err) > 1.0) this.away = { err, n: 0, seen: f.lastTime, t0: t };
    else if (f.lastTime !== this.away.seen) { this.away.n++; this.away.seen = f.lastTime; this.away.err = err; }
    if (this.away.n >= (key ? KEY_CONFIRM : CONFIRM) && t - this.away.t0 >= (key ? KEY_CONFIRM_S : CONFIRM_S)) {
      this.clock.beat = target;
      this.clock.rate = rate;
      this.away = null;
      this.nextOrch = bisectLeft(this.orchBeats, target - 1e-6); // play on from there (also after a jump back)
    } else {
      this.clock.freeRun(t);
    }
  }

  // A tempo plan: per bar [bar, bpm, flex] (tools/tempo_plan.py). In a steady
  // bar the orchestra keeps the section's tempo (scaled to the player's pace,
  // which is re-judged only where a new section starts), leans only a little
  // toward the soloist's momentary tempo and closes a gap only gently; in a
  // flexible bar (rit., rubato, a change of section) it follows closely.
  setPlan(bars, { lean = 0.04, tau = 4.0, maxAdjust = 0.05, jumpBeats = 4.0, settle = 8 } = {}) {
    this.plan = { bars, lean, tau, maxAdjust, jumpBeats, settle };
    this.pace = null;       // player's tempo / the plan's, set once the player has settled
    this.paceSum = 0; this.paceN = 0;
    this.section = null;    // which steady section we are in (index of its first bar)
    this.matches = 0;
  }

  planAt(beat) {
    const bars = this.plan.bars;
    const i = Math.max(0, Math.min(bars.length - 1, Math.floor(beat / 4)));
    return { bpm: bars[i][1], flex: !!bars[i][2], bar: i };
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

  steerPlanned(t) {
    const f = this.follower, P = this.plan;
    const here = this.planAt(this.clock.beat);
    const solo = 1.0 / f.spb;
    const ref = here.bpm / 60.0;
    // the start of a steady section (after a flexible stretch): take the
    // player's pace over the last one, as a conductor would
    const sectionStart = here.flex ? null : this.sectionStartOf(here.bar);
    if (sectionStart !== this.section) {
      if (this.paceN >= P.settle) this.pace = Math.max(0.7, Math.min(1.3, this.paceSum / this.paceN));
      this.paceSum = 0; this.paceN = 0;
      this.section = sectionStart;
    }
    if (f.lastTime !== null && f.lastTime !== this.lastSeen) {
      this.lastSeen = f.lastTime;
      this.paceSum += solo / ref; this.paceN++;
      if (this.pace === null && this.paceN >= P.settle) this.pace = this.paceSum / this.paceN;
    }
    if (here.flex || this.pace === null) {
      // a key spot (or the player has not settled yet): follow closely
      const c = this.clock;
      this.follow(t, f.position(t), solo, c.tau, c.maxAdjust, c.jumpBeats);
      return;
    }
    const base = ref * this.pace;
    const lean = Math.max(-P.lean, Math.min(P.lean, 0.5 * (solo / base - 1)));
    this.follow(t, f.position(t), base * (1 + lean), P.tau, P.maxAdjust, P.jumpBeats);
  }

  // first bar of the steady stretch containing bar i (bars between flexible ones)
  sectionStartOf(i) {
    const bars = this.plan.bars;
    while (i > 0 && !bars[i - 1][2] && Math.abs(bars[i - 1][1] - bars[i][1]) < 1e-6) i--;
    return i;
  }

  // Advance to time t; return orchestra notes due, each with the time it is
  // due at. ahead > 0 also returns the notes due within the next `ahead`
  // seconds at the current tempo (so they can be scheduled precisely).
  tick(t, ahead = 0.0) {
    if (!this.started) return [];
    const f = this.follower;
    if (this.soloistActive(this.clock.beat) && f.lastTime !== null) {
      const c = this.clock;
      if (!this.plan) this.follow(t, f.position(t), 1.0 / f.spb, c.tau, c.maxAdjust, c.jumpBeats);
      else this.steerPlanned(t);
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
      } else this.skipped++;
      this.nextOrch += 1;
    }
    return due;
  }
}
