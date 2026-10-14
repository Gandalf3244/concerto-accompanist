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

// The conductor (with a tempo plan). As a conductor accompanies a concerto:
// at the start of each section it listens to the soloist and takes their
// tempo; then it beats time. In a fast section the tempo is held, the same
// all through each bar (the accompaniment is not "beguiled" by the soloist's
// rubato), corrected only at bar lines and only a little; in a slow section
// it is set beat by beat, leaning toward the soloist; at a rit., rubato or a
// change of section it follows the soloist more. The tempo only changes on a
// beat (or a bar line), never in between, so the rhythm stays even.
const ENTRY_BEATS = 4;       // the soloist's first beats in a section: the conductor listens
const ENTRY_PACE = [0.6, 1.3]; // the section's tempo is taken from the player within this of the plan's (practising slowly is fine)
const FAST = { correct: 0.02, deadband: 0.15, adapt: 0.01, adaptAbove: 0.03 }; // per bar
const SLOW = { lean: 0.5, settle: 2.0, max: 0.08 };   // per beat; settle: beats to close a gap
const FLEX = { weight: 0.7, settle: 1.5, max: 0.12 }; // per beat
const PLAN_JUMP = 4.0;       // beats apart before the jump rule applies

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

  // a key spot: where the orchestra gives way to the soloist (rit., rubato, a
  // new section; in a slow section also where the recording stretches), or no plan
  keySpot() {
    if (!this.plan) return true;
    const h = this.planAt(this.clock.beat);
    return h.flex >= 2 || (h.flex === 1 && !h.fast);
  }

  // The follower is far from the orchestra: move there only once it has
  // stayed there (true if the clock jumped); until then keep the course.
  farOff(t, target, rate) {
    const f = this.follower, key = this.keySpot(), err = target - this.clock.beat;
    if (!this.away || Math.abs(err - this.away.err) > 1.0) this.away = { err, n: 0, seen: f.lastTime, t0: t };
    else if (f.lastTime !== this.away.seen) { this.away.n++; this.away.seen = f.lastTime; this.away.err = err; }
    if (this.away.n >= (key ? KEY_CONFIRM : CONFIRM) && t - this.away.t0 >= (key ? KEY_CONFIRM_S : CONFIRM_S)) {
      this.clock.beat = target;
      this.clock.rate = rate;
      this.away = null;
      this.nextOrch = bisectLeft(this.orchBeats, target - 1e-6); // play on from there (also after a jump back)
      return true;
    }
    this.clock.freeRun(t);
    return false;
  }

  // Without a plan: steer the clock toward the follower (AccompClock.steer),
  // moving far only by the jump rule.
  follow(t, target, rate) {
    this.clock.advance(t);
    if (Math.abs(target - this.clock.beat) <= this.clock.jumpBeats) {
      this.away = null;
      this.clock.steer(t, target, rate);
    } else {
      this.farOff(t, target, rate);
    }
  }

  // A tempo plan (tools/tempo_plan.py): per bar [bar, bpm, flex, section],
  // flex 0 steady, 1 the recording strays, 2 a change of section, 3 a tempo
  // word; sections [first bar, end bar, bpm, fast].
  setPlan(bars, sections = null) {
    this.plan = { bars, sections };
    // section: the plan section we are in; rate: its tempo (beats/s) as taken
    // from the player; entry: beats left of listening; next: the beat at which
    // the tempo is next decided
    this.cond = { section: null, rate: null, pace: 1.0, entry: 0, pts: [], seen: null, next: null, waited: 0 };
    // plan time at each bar line (planTime)
    this.plan.cum = [0];
    for (const b of bars) this.plan.cum.push(this.plan.cum[this.plan.cum.length - 1] + 4 * 60 / b[1]);
  }

  planAt(beat) {
    const bars = this.plan.bars;
    const i = Math.max(0, Math.min(bars.length - 1, Math.floor(beat / 4)));
    const b = bars[i], sec = this.plan.sections && b[3] !== undefined ? this.plan.sections[b[3]] : null;
    return { bpm: b[1], flex: +b[2] || 0, bar: i, sec: sec ? b[3] : -1,
             secBpm: sec ? sec[2] : b[1], fast: sec ? !!sec[3] : b[1] >= 100 };
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

  // seconds from the start to beat b at the plan's tempos
  planTime(b) {
    const bars = this.plan.bars, i = Math.max(0, Math.min(bars.length - 1, Math.floor(b / 4)));
    return this.plan.cum[i] + (b - 4 * i) * 60 / bars[i][1];
  }

  // the player's pace (their tempo / the plan's) over the notes heard since
  // the section began: how fast their time runs against the plan's time for
  // the same notes (so a bar the music stretches doesn't read as slow), the
  // median slope over pairs of notes at least half a beat apart
  entryPace() {
    const p = this.cond.pts;
    if (p.length < 3 || p[p.length - 1][0] - p[0][0] < 2) return null;
    const slopes = [];
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      if (p[j][0] - p[i][0] >= 0.5 && p[j][1] > p[i][1]) slopes.push((this.planTime(p[j][0]) - this.planTime(p[i][0])) / (p[j][1] - p[i][1]));
    }
    if (slopes.length < 3) return null;
    slopes.sort((a, b) => a - b);
    return slopes[slopes.length >> 1];
  }

  // The conductor (see the top of this file); called while the soloist plays.
  conduct(t) {
    const f = this.follower, C = this.cond, c = this.clock;
    c.advance(t);
    const pos = f.position(t), err = pos - c.beat, solo = 1.0 / f.spb;
    if (Math.abs(err) > PLAN_JUMP) {
      if (this.farOff(t, pos, solo)) C.next = null;
      return;
    }
    this.away = null;
    if (C.entry > 0 && f.lastTime !== null && f.lastTime !== C.seen) { C.seen = f.lastTime; C.pts.push([f.lastBeat, f.lastTime]); }
    if (C.next !== null && c.beat < C.next - 1e-9) return; // the beat goes on at the tempo set
    const h = this.planAt(c.beat);
    const secRate = h.secBpm / 60.0;
    if (h.sec !== C.section) {
      // a new section: listen to the soloist's tempo first (from the notes
      // they play in it, not the follower's running tempo, which still
      // remembers the last section)
      C.section = h.sec; C.entry = ENTRY_BEATS; C.pts = [];
      if (C.rate !== null) C.rate = secRate * C.pace; // the player's pace so far, until we know
    }
    if (C.rate === null) { C.pace = 1.0; C.rate = secRate; }
    const nextBeat = Math.floor(c.beat + 1e-9) + 1;
    const clamp = (x, m) => Math.max(-m, Math.min(m, x));
    if (C.entry > 0) {
      // listening: follow the player's position closely at the pace they are taking
      const heard = this.entryPace();
      const pace = heard === null ? C.pace : Math.max(ENTRY_PACE[0], Math.min(ENTRY_PACE[1], heard));
      c.rate = h.bpm / 60 * pace * (1 + clamp(err / FLEX.settle, FLEX.max));
      C.entry -= 1;
      C.waited = (C.waited || 0) + 1;
      if (C.entry <= 0 && heard === null && C.waited < 2 * ENTRY_BEATS) C.entry = 1; // wait a little for notes
      if (C.entry <= 0) {
        C.waited = 0;
        C.pace = pace;
        C.rate = secRate * C.pace;
        this.onDecide?.({ t, beat: c.beat, section: h.sec, pace: C.pace, bpm: C.rate * 60, n: C.pts.length });
      }
      C.next = nextBeat;
      return;
    }
    // the plan's tempo here, at the player's pace: a fast section keeps one
    // tempo (only a marked change bends it), a slow one has the recording's shape
    const base = () => (h.fast && h.flex < 3 ? secRate : h.bpm / 60.0) * (C.rate / secRate);
    if (this.keySpot()) {
      const r = FLEX.weight * solo + (1 - FLEX.weight) * base();
      c.rate = r * (1 + clamp(err / FLEX.settle, FLEX.max));
      C.next = nextBeat;
    } else if (h.fast) {
      // at a bar line: the section's tempo, taken a little toward a player who
      // keeps a different one, and a small correction if they are apart
      const d = solo / C.rate - 1;
      if (Math.abs(d) > FAST.adaptAbove) {
        C.rate *= 1 + clamp(0.15 * d, FAST.adapt);
        C.pace = C.rate / secRate;
      }
      const corr = Math.abs(err) > FAST.deadband ? clamp(err / 4, FAST.correct) : 0;
      c.rate = base() * (1 + corr);
      C.next = Math.floor(c.beat / 4 + 1e-9) * 4 + 4;
    } else {
      const b = base(), lean = SLOW.lean * (solo / b - 1), corr = err / SLOW.settle;
      c.rate = b * (1 + clamp(lean + corr, SLOW.max));
      C.next = nextBeat;
    }
  }

  // Advance to time t; return orchestra notes due, each with the time it is
  // due at. ahead > 0 also returns the notes due within the next `ahead`
  // seconds at the current tempo (so they can be scheduled precisely).
  tick(t, ahead = 0.0) {
    if (!this.started) return [];
    const f = this.follower;
    if (this.soloistActive(this.clock.beat) && f.lastTime !== null) {
      if (!this.plan) this.follow(t, f.position(t), 1.0 / f.spb);
      else this.conduct(t);
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
